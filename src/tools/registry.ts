import {jsonSchema} from 'ai'
import {MCPClient, MockMCPClient} from "./mcp-client";
import { canUseTool, Role } from "../security/roles";
import { HookPipeline } from "../security/hooks";
import {classifyBashCommand} from "../security/bash-classifier";

export interface ToolDefinition{
    name: string,
    description: string,
    // Record<string, unknown> 就是一个键值对的类型标注，键名是字符串，值可以是任意类型。
    parameters: Record<string, unknown>,
    // ? 在这就是“可选”的意思，就像在说“这东西可以有，也可以没有”。
    isConcurrencySafe?: boolean,
    isReadOnly?: boolean,
    maxResultChars?: number,
    shouldDefer?: boolean, // 是否延迟加载
    searchHint?: string, //搜索提示词，帮助 ToolSearch 匹配
    // 每个工具的执行函数接收任意类型的输入（input: any），返回一个承诺，承诺未来会给你结果，但结果类型看具体工具而定。比如 readFileTool 兑现时会给你文件内容的字符串，writeFileTool 兑现时给你个成功消息——所以用 unknown 最灵活，各个工具自己定返回格式。
    execute: (input: any) => Promise<unknown>,
}

const DEFAULT_MAX_RESULT_CHARS = 3000;

export class ToolRegistry {
    // Map 是 JavaScript 里的一种数据结构，像一本字典：你用 key（键）去查 value（值）。这里 key 是工具的名字（比如 "read_file"），value 是整个工具的定义对象（ToolDefinition，包含描述、参数、执行函数等）。
    private tools = new Map<string, ToolDefinition>();

    // 创建一个去重集合，同一种工具只能放一个
    private discoveredTools: Set<string> = new Set();

    private mcpClients: Array<MCPClient | MockMCPClient> = []

    // 三个状态变量构成一把读写锁
    private exclusiveLock = false;          // 当前是否有独占锁持有者
    private concurrentCount = 0;            // 当前共享锁持有数
    private waitQueue: Array<() => void> = [];  // 阻塞等待中的 resolve 函数

    private currentRole: Role = 'owner';
    private hookPipeline?: HookPipeline;


    // ...tools 这个语法，是 TypeScript 的剩余参数，意思就是"你传多少个工具进来都行，我全接着"。所以你可以一次注册一个,Map是一种数据结构里面包含set，get等方法，map是数组方法
    register(...tools: ToolDefinition[]):void{
        for (const tool of tools){
            this.tools.set(tool.name,tool)
        }
    }


    unregister(name: string): boolean {
        this.discoveredTools.delete(name);
        return this.tools.delete(name);
    }


    // ()保存调用者从外部传进来的数据（即参数）。相当于函数启动前需要的外部原料。
    // {}保存具体的执行步骤和逻辑代码（即函数体）。这里写“到底怎么干活的”全部流程。其return值为，Promise<string[]>里面的string[]
    // registerMCPServer 方法收一个 MCP 客户端和服务器名，然后把服务器上的所有工具"翻译"成 Agent 能理解的格式：
    async registerMCPServer(
        serverName: string,
        client: MCPClient | MockMCPClient,
    ): Promise<string[]>{
        await client.connect();
        this.mcpClients.push(client);

        const tools = await client.listTools();
        const registered: string[] = [];

        for (const tool of tools) {
            const prefixedName = `mcp__${serverName}__${tool.name}`;
            if (this.tools.has(prefixedName)) continue;

            const toolClient = client;
            const originalName = tool.name;

            this.register({
                name: prefixedName,
                description: '[MCP:${serverName}] ${tool.description}',
                parameters: tool.inputSchema as Record<string, unknown>,
                isConcurrencySafe: true,
                isReadOnly: true,
                shouldDefer: true,
                searchHint: `${serverName} ${tool.name} ${tool.description}`,
                maxResultChars: 3000,
                execute: async (input: any) => {
                    return toolClient.callTool(originalName, input);
                }
            });
            registered.push(prefixedName);
        }
        return registered;
    }

    async closeALLMCP(): Promise<void>{
        for (const client of this.mcpClients){
            await client.close();
        }
        this.mcpClients = [];
    }

    get(name: string): ToolDefinition | undefined {
        return this.tools.get(name);
    }

    getAll(): ToolDefinition[] {
        return Array.from(this.tools.values());
    }

    setRole(role: Role): void {
        this.currentRole = role;
    }

    getRole(): Role {
        return this.currentRole;
    }

    setHookPipeline(pipeline: HookPipeline): void {
        this.hookPipeline = pipeline;
    }

    // 搜索  searchTools方法按精确的工具名匹配
    searchTools(query: string): ToolDefinition[] {
        const q = query.trim();
        const results: ToolDefinition[] = [];
        const names = q.includes(',') ? q.split(',').map(n=> n.trim()).filter(Boolean) : [q];
        for (const name of names) {
            const tool = this.tools.get(name);
            // 将延迟工具加入getActiveTools列表中
            if (tool && tool.name !== 'tool_search') {
                results.push(tool);
                this.discoveredTools.add(tool.name);
            }
        }
        return results;
    }

    // 过滤  getActiveTools方法控制那些工具进入prompt，延迟工具默认不输出
    getActiveTools(): ToolDefinition[] {
        return this.getAll().filter(tool => {
            if (tool.shouldDefer && !this.discoveredTools.has(tool.name)){
                return false;
            }
            if (!canUseTool(this.currentRole, tool.name)) {
                return false;
            }
            return true;
        })
    }

    // 提示——getDeferredToolSummary 方法生成延迟工具的名字列表
    getDeferredToolSummary(): string {
        const deferred = this.getAll().filter(tool=>{
            return tool.shouldDefer && !this.discoveredTools.has(tool.name)
        });

        if (deferred.length === 0) return '';

        const lines = deferred.map(t=>{
            const hint = t.searchHint ? `--${t.searchHint}` : '';
            return `-${t.name}${hint}`;
        })
        return `\n以下工具可用，但需要先通过 tool_search 搜索获取完整定义： \n${lines.join('\n')}`;
    }

    countTokenEstimate():{active: number; deferred: number; total: number}{
        let active = 0;
        let deferred = 0;
        for (const tool of this.tools.values()) {
            const schemaSize = JSON.stringify({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            }).length
            const tokens = Math.ceil(schemaSize / 4);
            if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
                deferred += tokens;
            }else {
                active += tokens;
            }
        }

        return {active,deferred,total: active + deferred};
    }


    // 获取共享锁：只要没人独占就能拿，多个只读工具可以同时持有
    private async acquireConcurrent(): Promise<void> {
        while (this.exclusiveLock) {
          await new Promise<void>(r => this.waitQueue.push(r));
        }
        this.concurrentCount++;
    }

    private releaseConcurrent(): void {
        this.concurrentCount--;
        if (this.concurrentCount === 0) this.drainQueue();
    }
    // 获取独占锁：必须等所有共享锁释放、且没人持独占
    private async acquireExclusive(): Promise<void> {
        while (this.exclusiveLock || this.concurrentCount > 0) {
            await new Promise<void>(r => this.waitQueue.push(r));
        }
        this.exclusiveLock = true;
    }

    private releaseExclusive(): void {
        this.exclusiveLock = false;
        this.drainQueue();
    }




    // 锁释放时把等待队列全唤醒，让它们重新去抢锁
    private drainQueue(): void {
        const waiting = this.waitQueue.splice(0);
        for (const resolve of waiting) resolve();
      }

    // 一个完整的执行流程示例
    // 任务 A（只读） 获取共享锁 → concurrentCount = 1，执行。
    //
    // 任务 B（只读） 获取共享锁 → concurrentCount = 2，执行。
    //
    // 任务 C（写入） 尝试获取独占锁 → 发现 concurrentCount > 0，进入等待队列挂起。
    //
    // 任务 A 完成 → 释放共享锁，concurrentCount = 1，尚未触发 drainQueue。
    //
    // 任务 B 完成 → 释放共享锁，concurrentCount = 0，触发 drainQueue。
    //
    // 等待队列中的 任务 C 被唤醒，重新检查条件（exclusiveLock = false, concurrentCount = 0），成功获取独占锁并执行。

    toAISDKFormat(): Record<string, any>{
        const result: Record<string, any> = {}
        const activeTools = this.getActiveTools();
        for (const tool of activeTools) {
            const maxChars = tool.maxResultChars;
            const executeFn = tool.execute;
            const isSafe = tool.isConcurrencySafe === true;
            const registry = this;

            const hookPipeline = registry.hookPipeline;
            const toolName = tool.name;

            result[toolName] = {
                description: tool.description,
                inputSchema: jsonSchema(tool.parameters as any),
                execute: async (input: any)=> {
                    // Bash 风险检测
                    if (toolName === 'bash' && input?.command) {
                        const risk = classifyBashCommand(input.command);
                        if (risk.level === 'dangerous') {
                            return `[拒绝执行] 检测到危险操作: ${risk.reason}\n命令: ${input.command}`;
                        }
                        if (risk.level === 'moderate') {
                            console.log(`  [安全] ⚠ ${risk.reason}: ${input.command}`);
                        }
                    }

                    // Pre Hook
                    if (hookPipeline) {
                        const preResult = await hookPipeline.runPre(toolName, input);
                        if (preResult.action === 'block') {
                            return `[Hook 拦截] ${preResult.reason || '操作被阻止'}`;
                        }
                        if (preResult.action === 'modify' && preResult.modifiedInput !== undefined) {
                            input = preResult.modifiedInput;
                        }
                    }

                    // 在真正执行前先按 isConcurrencySafe 获取锁
                    if (isSafe) {
                        await registry.acquireConcurrent();
                        console.log(`  [并发] ${toolName} 获取共享锁`);
                    } else {
                        await registry.acquireExclusive();
                        console.log(`  [串行] ${toolName} 获取独占锁，等待其他工具完成`);
                    }
                    try {
                        const raw = await executeFn(input);
                        const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
                        let output =  truncateResult(text, maxChars);
                        // Post Hook
                        if (hookPipeline) {
                            const postResult = await hookPipeline.runPost(toolName, input, output);
                            if (postResult.modifiedOutput !== undefined) {
                                output = String(postResult.modifiedOutput);
                            }
                        }
                        return output;
                    } finally {
                        if (isSafe) {
                            registry.releaseConcurrent();
                        } else {
                            registry.releaseExclusive();
                        }
                    }
                }
            }
        }
        return result;
    }

    toAISDKFormatUnlocked(excludeTools: Set<string>): Record<string, any> {
        const result: Record<string, any> = {};
        for (const [name, tool] of this.tools) {
            if (excludeTools.has(name)) continue;
            result[name] = {
                description: tool.description,
                inputSchema: jsonSchema(tool.parameters as any),
                execute: tool.execute,
            };
        }
        return result;
    }
}

// 截断函数，返回头部 maxChars60%的字符数 和 尾部的maxChars40%
export function truncateResult(text: string, maxChars: number = DEFAULT_MAX_RESULT_CHARS): string{
    if (text.length <= maxChars) return text;
    // Math.floor() 就是"往小了取整"
    const headSize = Math.floor(maxChars * 0.6)
    const tailSize = maxChars - headSize
    const head = text.slice(0, headSize)
    const tail = text.slice(-tailSize)
    const dropped = text.length - headSize - tailSize;

    return `${head}\n\n..[省略${dropped}字符]...\n\n ${tail}`
}


