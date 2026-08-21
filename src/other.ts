import 'dotenv/config'
import {type ModelMessage} from 'ai'
import {createOpenAI} from "@ai-sdk/openai";
import {createMockModel} from "./mock-model";
import {createInterface} from 'node:readline'
import * as process from "node:process";
import {allTools} from "./tools/index";
import {agentloop, type BudgetState} from "./agent/loop";
import {ToolRegistry,} from "./tools/registry";
import {MCPClient, MockMCPClient} from "./tools/mcp-client";
import {SessionStore} from "./session/session-store";
import {
    coreRules,
    deferredTools,
    PromptBuilder,
    PromptContext,
    sessionContext,
    toolGuide
} from "./context/prompt-builder";
import {estimateTokens, microcompact, summarize} from "./context/compressor";
import {UsageTracker} from "./usage/tracker";
import {createToolSearchTool} from "./tools/tool-search";
import {contextCommands} from "./commands/context";
import {CommandContext, createDispatcher} from "./commands";
import {debugCommands} from "./commands/debug";
import {memoryCommands} from "./commands/memory";
import {MemoryStore} from "./memory/store";
import {createMemoryTool} from "./tools/memory-tool";
import {memoryContext, ragContext} from "./context/prompt-pipes";
// import {VectorStore} from "./rag/store";
import {SqliteVectorStore} from './rag/sqlite-store.js';
import {createRagTools} from "./tools/rag-tools";
import {createDashScopeEmbedder, createMockEmbedder} from "./rag/embedder";
import {ragCommands} from "./commands/rag";
import {dreamCommands} from "./commands/dream";
import {createSkillCommands} from "./commands/skill";
import {SkillLoader} from "./skills/loader";
import {PluginManager} from "./plugins/manager";
import {PluginDefinition} from "./plugins/types";
import {supabasePlugin} from "./plugins/supabase-plugin";
import {createPluginCommands} from "./commands/plugin";
import {ChannelGateway} from "./channels/gateways";
import {FeishuChannel} from "./channels/feishu";
import {createChannelCommands} from "./commands/channels";
import {createSecurityCommands} from "./commands/security";
import {HookPipeline} from "./security/hooks";
import {CronService} from "./cron/service";
import {createCronTool} from "./tools/cron-tools";
import {createCronCommands} from "./commands/cron";
import {SubAgentRegistry} from "./agents/registry";
import {SpawnContext} from "./agents/spawn";
import {createSpawnTool} from "./tools/spawn-tools";
import {createAgentCommands} from "./commands/agents";


const qwen = createOpenAI({
    baseURL: process.env.DASHSCOPE_BASE_URL,
    apiKey: process.env.DASHSCOPE_API_KEY
})

const model = process.env.DASHSCOPE_API_KEY
    ? qwen.chat('qwen-plus-latest')
    : createMockModel() as any;

// ── Registry ────────────────────────────────
const registry = new ToolRegistry();
registry.register(...allTools);
// /* 为什么不写入tool.ts里面呢？tool.ts 里放的都是"干活的工具"——读写文件、执行命令、搜索内容，每个工具都是在操作具体的系
//    统资源。而 tool_search 不干这些事，它操作的是工具注册表本身，是用来"发现其他工具的元工具"。它和业务逻辑完全不搭边，
//    塞在一起反而让 tool.ts 职责不清晰。*/
// const toolSearchTool: ToolDefinition = {
//     name: 'tool_search',
//     description:'获取延迟工具的完整定义。传入工具名（从系统提示的延迟工具列表中选取），返回该工具的完整参数 Schema',
//     parameters:{
//         type:'object',
//         properties:{
//             query: {type: 'string', description: '工具名，如 "mcp__github__list_issues"。支持逗号分隔多个工具名'}
//         },
//         required:'[query]',
//         additionalProperties: false,
//     },
//     isConcurrencySafe: true,
//     isReadOnly: true,
//     execute: async({query}:{query: string})=>{
//         const results = registry.searchTools(query);
//         if (results.length === 0) return `没有找到匹配 "${query}" 的工具`;
//         return results.map(t=>({
//             name: t.name,
//             description: t.description,
//             parameters: t.parameters,
//         }))
//     }
// };
// registry.register(toolSearchTool)
registry.register(createToolSearchTool(registry));

// ── Memory ────────────────────────────────
const memoryStore = new MemoryStore('.');
memoryStore.init();
registry.register(createMemoryTool(memoryStore));

// ── 连接MCP服务器 ────────────────────────────────
async function connectMCP() {
    const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;

    let canSpawn = true;
    try {
        const  { execSync } = await import('node:child_process');
        execSync('echo test', {stdio: 'ignore'});
    }catch {
        canSpawn = false;
    }

    if (githubToken && canSpawn) {
        console.log('\n 连接 GitHub MCP Server...');
        try {
            const client = new MCPClient(
                'npx', ['-y', '@modelcontextprotocol/server-github'],
                { GITHUB_PERSONAL_ACCESS_TOKEN: githubToken }
            );
            const tools = await registry.registerMCPServer('github', client);
            console.log(`已注册 ${tools.length} 个 MCP 工具`);
            return;
        } catch (err) {
            console.log(`  MCP 连接失败: ${err instanceof Error ? err.message : err}`);
            console.log('  降级为 Mock MCP...');
        }
    }

    if (!githubToken){
        console.log('\n未配置 GITHUB_PERSONAL_ACCESS_TOKEN，使用 Mock MCP');
    }

    const mockClient = new MockMCPClient();
    const tools = await registry.registerMCPServer('github', mockClient);
    console.log(`  已注册 ${tools.length} 个 Mock MCP 工具`);
}

// ── Skills ────────────────────────────────
const skillLoader = new SkillLoader('.');
const loadedSkills = skillLoader.load();
const activeSkills = new Set<string>();

// ── RAG ──��─────────────────────────────
// const vectorStore = new VectorStore();
const vectorStore = new SqliteVectorStore('knowledge.db');
const embedFn = process.env.DASHSCOPE_API_KEY
  ? createDashScopeEmbedder(process.env.DASHSCOPE_API_KEY)
  : createMockEmbedder();
registry.register(...createRagTools(vectorStore, embedFn));

// ── Plugins ────────────────────────────────
// const pluginManager = new PluginManager(registry);
// const availablePlugins = new Map<string, PluginDefinition>([
//     ['supabase', supabasePlugin],
// ]);x

// ── Cron Service ────────────────────────────────
const cronService = new CronService('.');
registry.register(createCronTool(cronService));

// ── Sub-Agent ────────────────────────────────
const agentRegistry = new SubAgentRegistry({ maxSpawnDepth: 1, maxConcurrent: 3 });

function getSpawnCtx(): SpawnContext {
    return {
        model,
        registry,
        agentRegistry,
        buildSystem: () => builder.build(makePromptCtx()),
        currentDepth: 0,
    };
}
registry.register(createSpawnTool(agentRegistry, getSpawnCtx));


// ── Security: Hook Pipeline ────────────────────────────────
const hookPipeline = new HookPipeline();

// 示例 Pre Hook: 写文件前记录日志
hookPipeline.registerPre('audit-log', (toolName, input) => {
    if (toolName === 'write_file' || toolName === 'edit_file') {
        const path = (input as any)?.path || 'unknown';
        console.log(`  [audit] 文件写入操作: ${toolName} → ${path}`);
    }
    return { action: 'allow' };
});

// 示例 Post Hook: 给 bash 输出加时间戳
hookPipeline.registerPost('bash-timestamp', (toolName, _input, output) => {
    if (toolName === 'bash') {
        const timestamp = new Date().toISOString();
        return {
            action: 'modify',
            modifiedOutput: `[${timestamp}]\n${output}`,
        };
    }
    return { action: 'allow' };
});

registry.setHookPipeline(hookPipeline);

// ── Prompt Builder ────────────────────────────────
const builder = new PromptBuilder()
    .pipe('coreRules', coreRules())
    .pipe('toolGuide', toolGuide())
    .pipe('deferredTools', deferredTools())
    // .pipe('memoryContext', () => memoryStore.buildPromptSection())   // 记忆注入
    .pipe('memoryContext', memoryContext(memoryStore))
    .pipe('ragContext', ragContext(vectorStore))
    .pipe('skillContext', () => skillLoader.buildPromptSection(activeSkills))
    .pipe('sessionContext', sessionContext());


// ── Channel Gateway ────────────────────────────────
const gateway = new ChannelGateway({
    model,
    registry,
    buildSystem: () => builder.build(makePromptCtx()),
});

const FEISHU_PORT = Number(process.env.FEISHU_PORT || '3000');
const feishuChannel = new FeishuChannel({
    appId: process.env.FEISHU_APP_ID || '',
    appSecret: process.env.FEISHU_APP_SECRET || '',
    port: FEISHU_PORT,
});
gateway.register(feishuChannel);


// ── Commands ──────────────────────────────── 把不同来源的命令处理函数串成一个链条，哪个能处理就归哪个管。
const dispatch = createDispatcher([
    ...debugCommands,
    ...contextCommands,
    ...memoryCommands,
    ...ragCommands,
    ...dreamCommands,
    ...createSkillCommands(skillLoader, activeSkills),
    // ...createPluginCommands(pluginManager,availablePlugins),
    ...createChannelCommands(gateway),
    ...createSecurityCommands(registry,hookPipeline),
    ...createCronCommands(cronService),
    ...createAgentCommands(agentRegistry),
]);

// 每次构建系统提示词时，实时收集 Agent 当前的状态。
function makePromptCtx(): PromptContext {
    return {
        toolCount: registry.getActiveTools().length,
        deferredToolSummary: registry.getDeferredToolSummary(),
        sessionMessageCount: 0,
        sessionId: 'default',
    };
}


async function main() {
    await connectMCP();
    // load插件
    // console.log('  加载插件...');
    // for (const [name, def] of availablePlugins) {
    //     try {
    //         const tools = await pluginManager.load(def);
    //         console.log(`  ✓ ${name} — ${tools.length} 个工具`);
    //     } catch {
    //         console.log(`  ✗ ${name} — 加载失败`);
    //     }
    // }

    // 启动Channel
    console.log('  启动 Channel...');
    await gateway.startAll();
    //-------------------------------------------------------------------
    cronService.load();
    cronService.setExecutor({
        runAgentPrompt: async (prompt, timeout) => {
            const cronMessages: ModelMessage[] = [{ role: 'user', content: prompt }];
            const system = builder.build(makePromptCtx());
            await agentloop(model, registry, cronMessages, system);
            const lastMsg = cronMessages[cronMessages.length - 1];
            if (!lastMsg) return '(无输出)';
            if (typeof lastMsg.content === 'string') return lastMsg.content;
            if (Array.isArray(lastMsg.content)) {
                return lastMsg.content
                    .filter((p: any) => p.type === 'text')
                    .map((p: any) => p.text)
                    .join('') || '(无输出)';
            }
            return String(lastMsg.content);
        },
        notify: (message) => { console.log(`\n${message}`); },
    });
    cronService.start();
    const cronJobs = cronService.list();
    console.log(`  Cron: ${cronJobs.length} 个任务已加载`);
    //----------------------------------------------------------------------------------------

    // const tracker = new TokenTracker();
    const tracker = new UsageTracker('.usage/today.jsonl');
    const timestamps = new Map<number, number>()
    console.log(`已注册${registry.getAll().length}个工具:`);
    for (const tool of registry.getAll()){
        const flags = [
            tool.isConcurrencySafe ? '可并发' : '串行',
            tool.isReadOnly ? '只读' : '读写',
        ].join(',')
        console.log(`-${tool.name}(${flags})`);
    }

    const sessionId = 'default'
    const isContinue = process.argv.includes('--continue');
    const store = new SessionStore(sessionId);

    // const 管的是"这个变量不能指向别的东西"，但我们现在就是要让它指向别的东西（从空数组换成加载出来的历史数组），所以必须用 let。
    // .push() 改的是内容，const 管的只是绑定关系，两者不冲突。但如果你后面需要对变量本身重新赋值（比如从文件恢复整个数组），就得用 let。
    let messages: ModelMessage[] = [];
    // 信息体，实现记忆的能力
    // const messages: ModelMessage[] = []

    if (isContinue && store.exists()) {
        messages = store.load();
        console.log(`[Session] 恢复会话，${messages.length} 条历史消息`);
    }else {
        console.log(`[Session] 新会话`);
    }


    const promptCtx: PromptContext = {
        toolCount: registry.getActiveTools().length,
        deferredToolSummary: registry.getDeferredToolSummary(),
        sessionMessageCount: messages.length,
        sessionId,
    };

    const SYSTEM = builder.build(promptCtx);

    // Debug: 显示 Prompt Pipe 各模块状态
    builder.debug(promptCtx);

    // 压缩
    let summary = '';
    const beforeTokens = estimateTokens(messages);
    console.log(`\n[压缩前] ${messages.length} 条消息, ~${beforeTokens} tokens`);

    // Layer 1: Microcompact
    const mc = microcompact(messages);
    messages = mc.messages;
    console.log(`[Layer 1: Microcompact] 清理了 ${mc.cleared} 个工具结果`);

    // Layer 2: LLM Summarization
    const compResult = await summarize(model, messages, summary);
    messages = compResult.messages;
    summary = compResult.summary;
    const afterSumTokens = estimateTokens(messages);
    if (compResult.compressedCount > 0) {
        console.log(`[Layer 2: Summarization] 压缩了 ${compResult.compressedCount} 条消息`)
        console.log(`[摘要预览] ${summary.slice(0, 150)}...`);
    } else {
        console.log(`[Layer 2: Summarization] 未触发（消息量不够）`);
    }
    console.log(`[压缩后] ${messages.length} 条消息, ~${afterSumTokens} tokens (节省 ${beforeTokens - afterSumTokens} tokens)\n`);



    // Node.js的readline模块创建的一个命令行交互界面(CLI)
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout
    })

    const budget: BudgetState = {used: 0,limit:50000}

    // const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。
    // 需要查询信息时，主动使用工具，不要编造数据。
    // 回答要简洁直接。`;

    const allCount = registry.getAll().length
    const activeTools = registry.getActiveTools();
    const estimate = registry.countTokenEstimate();
    console.log(`\n=== 工具统计 ===`);
    console.log(`  全部工具: ${allCount} 个`);
    console.log(`  活跃工具: ${activeTools.length} 个`);
    console.log(`  延迟工具: ${allCount - activeTools.length} 个`);
    console.log(`  Token 估算: ~${estimate.active} (活跃) + ~${estimate.deferred} (延迟，不占 prompt)`);

    //     // Quick triggers for demo
    // function handleQuickTrigger(cmd: string): boolean {
    //   const now = Date.now();
    //
    //   if (cmd === '模拟长对话' || cmd === 'sim') {
    //     console.log('\n[模拟] 注入 20 条历史消息（含大量工具结果）...');
    //     for (let i = 0; i < 5; i++) {
    //       const age = (20 - i * 4) * 60 * 1000;
    //       const userIdx = messages.length;
    //       messages.push({ role: 'user', content: `第 ${i + 1} 轮：帮我读文件 file-${i}.ts` });
    //       timestamps.set(userIdx, now - age);
    //       messages.push({ role: 'assistant', content: [{ type: 'tool-call' as const, toolCallId: `sim-${i}`, toolName: 'read_file', input: { path: `file-${i}.ts` } }] });
    //       timestamps.set(userIdx + 1, now - age);
    //       const bigContent = `// file-${i}.ts\n` + 'export function handler() {\n  // ...\n}\n'.repeat(200);
    //       messages.push({ role: 'tool', content: [{ type: 'tool-result' as const, toolCallId: `sim-${i}`, toolName: 'read_file', output: textToolResultOutput(bigContent) }] });
    //       timestamps.set(userIdx + 2, now - age);
    //       messages.push({ role: 'assistant', content: [{ type: 'text' as const, text: `文件 file-${i}.ts 的内容已读取。` }] });
    //       timestamps.set(userIdx + 3, now - age);
    //     }
    //     const tokens = estimateMessageTokens(messages);
    //     console.log(`[模拟完成] ${messages.length} 条消息, ~${tokens} tokens\n`);
    //     return true;
    //   }
    //
    //   if (cmd === '执行防线' || cmd === 'defend') {
    //     console.log('\n--- 执行三层防线 ---');
    //     const before = estimateMessageTokens(messages);
    //     const def = applyDefense(messages, timestamps);
    //     messages = def.messages;
    //     console.log(`  [Layer 2] 截断: ${def.truncated} 条, 预算清理: ${def.compacted} 条`);
    //     console.log(`  [Layer 3] 软修剪: ${def.softPruned}, 硬清除: ${def.hardPruned}`);
    //     console.log(`  [结果] ~${before} → ~${def.tokenEstimate} tokens (节省 ${before - def.tokenEstimate})\n`);
    //     return true;
    //   }
    //
    //   if (cmd === '查看状态' || cmd === 'status') {
    //     const tokens = estimateMessageTokens(messages);
    //     const toolMsgs = messages.filter(m => m.role === 'tool').length;
    //     console.log(`\n[状态] ${messages.length} 条消息 (${toolMsgs} 条工具结果), ~${tokens} tokens\n`);
    //     return true;
    //   }
    //
    //   // /context: 终端可视化的 context 占用，参考 Claude Code 的 /context
    //   if (cmd === '/context' || cmd === 'context') {
    //     const snapshot = buildContextSnapshot({
    //       modelName: process.env.DASHSCOPE_API_KEY ? 'Qwen Plus' : 'Mock Model (开发用)',
    //       modelId: process.env.DASHSCOPE_API_KEY ? 'qwen3-6-plus' : 'mock-model',
    //       windowTokens: 1_000_000,
    //       systemPromptChars: SYSTEM.length,
    //       toolDescriptionChars: registry.getActiveTools().reduce((a, t) => a + t.name.length + (t.description?.length || 0) + JSON.stringify(t.parameters || {}).length, 0),
    //       memoryChars: 0,
    //       skillsChars: 0,
    //       messages,
    //     });
    //     console.log(renderContextView(snapshot));
    //     return true;
    //   }
    //
    //   if (cmd === '/usage' || cmd === 'usage') {
    //     console.log(renderUsageView(tracker));
    //     return true;
    //   }
    //
    //   if (cmd === '/cache off' || cmd === 'cache off') {
    //     setCacheEnabled(false);
    //     console.log('\n  \x1b[38;5;220m⚠ 已关闭 cache 模拟\x1b[0m  接下来每次请求都按 cache miss 计算\n');
    //     return true;
    //   }
    //   if (cmd === '/cache on' || cmd === 'cache on') {
    //     setCacheEnabled(true);
    //     console.log('\n  \x1b[38;5;36m✓ 已开启 cache 模拟\x1b[0m\n');
    //     return true;
    //   }
    //
    //   return false;
    // }


    // 通过循环来实现对话的功能
    function ask(){
        rl.question("You: ", async (input)=>{
            const trimmed = input.trim();
            if(!trimmed || trimmed ==='exit'){
                console.log('Bye');
                cronService.stop();
                await registry.closeALLMCP();
                // await pluginManager.unloadAll();
                await gateway.stopAll();
                rl.close();
                return;
            }

            // // ------------
            // if (handleQuickTrigger(trimmed)) {
            //     ask();
            //     return;
            // }
            // // ------------

            const ctx: CommandContext = {
                messages, timestamps, registry, builder, tracker,
                sessionStore: store, model, makePromptCtx, ask,
                memoryStore, vectorStore,
            };

            const handled = dispatch(trimmed, ctx);
            if (handled === 'async') return;
            if (handled) { ask(); return; }

            const userMsg: ModelMessage = {role: 'user', content: trimmed}
            messages.push(userMsg);
            // tracker.addMessage(userMsg);
            timestamps.set(messages.length - 1, Date.now());
            store.append(userMsg);

            // const turnDefense = applyDefense(messages, timestamps);
            // tracker.replaceMessages(messages, turnDefense.messages);
            // messages = turnDefense.messages;

            const currentSystem = builder.build(makePromptCtx());
            const beforeLen = messages.length;

            await agentloop(model,registry,messages,currentSystem,tracker);

            const newMessages = messages.slice(beforeLen);
            const now = Date.now();
            for (let i = beforeLen; i < messages.length; i++) timestamps.set(i, now);
            store.appendAll(newMessages);

            // Check if compaction needed after each turn
            const currentTokens = estimateTokens(messages);
            if (currentTokens > 4000) {
                console.log(`\n  [压缩检查] ~${currentTokens} tokens, 触发压缩...`);
                const mc2 = microcompact(messages);
                messages = mc2.messages;
                if (mc2.cleared > 0) console.log(`  [Microcompact] 清理了 ${mc2.cleared} 个工具结果`);

                const comp2 = await summarize(model, messages, summary);
                if (comp2.compressedCount > 0) {
                    messages = comp2.messages;
                    summary = comp2.summary;
                    console.log(`  [Summarization] 压缩了 ${comp2.compressedCount} 条消息, ~${estimateTokens(messages)} tokens`);
                }
            }
            ask()
        })
    }

    // ------------------------------------------------------------------------------
    const role = registry.getRole();
    const toolCount = registry.getActiveTools().length;
    const hooks = hookPipeline.list();

    console.log('Super Agent v0.17 — Permissions & Hooks (type "exit" to quit)');
    console.log('快捷命令：');
    console.log('  /role [角色]      — 查看/切换角色 (owner|collaborator|guest)');
    console.log('  /hooks            — 查看 Hook 管线');
    console.log('  /channel          — 查看通道');
    console.log('  /plugin           — 查看插件');
    console.log('  /skill            — 查看 skills');
    console.log('  /memory           — 查看记忆');
    console.log('');
    console.log(`  当前角色: ${role}，可用工具: ${toolCount} 个`);
    console.log(`  Hook: ${hooks.pre.length} 个 pre + ${hooks.post.length} 个 post`);
    console.log('');
    console.log('  试试：');
    console.log('    /role guest        — 切换到 guest，bash 等工具被禁用');
    console.log('    测试bash           — 执行 echo，会触发 post hook 加时间戳');
    console.log('    测试危险命令        — 模型尝试 rm -rf，会被 bash classifier 拦截');
    console.log('');

    // if (fs.existsSync('docs')) {
    //     const files = fs.readdirSync('docs').filter(f => f.endsWith('.md'));
    //     if (files.length > 0) {
    //         console.log(`  发现 ${files.length} 个文档，自动导入知识库...`);
    //         for (const f of files) {
    //             const path = `docs/${f}`;
    //             const text = fs.readFileSync(path, 'utf-8');
    //             const chunks = chunkDocument(path, text);
    //             const embeddings = await embed(embedFn, chunks.map(c => c.text));
    //             vectorStore.addBatch(chunks.map((c, i) => ({ chunk: c, embedding: embeddings[i] })));
    //             console.log(`    ${f} → ${chunks.length} 个片段`);
    //         }
    //         console.log(`  知识库就绪，共 ${vectorStore.size()} 个片段\n`);
    //     }
    // }

    // 启动时直接秀一次 /context，让用户立刻看到初始上下文构成
    // const startupSnapshot = buildContextSnapshot({
    //   modelName: process.env.DASHSCOPE_API_KEY ? 'Qwen Plus' : 'Mock Model (开发用)',
    //   modelId: process.env.DASHSCOPE_API_KEY ? 'qwen3-6-plus' : 'mock-model',
    //   windowTokens: 1_000_000,
    //   systemPromptChars: SYSTEM.length,
    //   toolDescriptionChars: registry.getActiveTools().reduce((a, t) => a + t.name.length + (t.description?.length || 0) + JSON.stringify(t.parameters || {}).length, 0),
    //   memoryChars: 0,
    //   skillsChars: 0,
    //   messages,
    // });
    // console.log(renderContextView(startupSnapshot));
    // ------------------------------------------------------------------------------

    ask()
}
main().catch(console.error)

