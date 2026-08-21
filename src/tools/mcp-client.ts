import { spawn, type ChildProcess} from "node:child_process";
import { createInterface, type Interface} from "node:readline";
import {clearTimeout} from "node:timers";
// 这段代码在干什么？一句话：它是一个"翻译官"，让你的 Agent 能和 GitHub 工具箱（MCP Server）用同一套语言（JSON-RPC）对话。

interface MCPTool{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>
}

interface MCPCallResult {
    content: Array<{type: string; text?: string}>;
    inError ?: boolean;
}

export class MCPClient {
    private process: ChildProcess | null = null;
    private rl: Interface | null = null;
    private requestId = 0;
    // 这段代码是一个"待办事项记事本"——它记录了所有发出去了但还没收到回复的请求。
    private pending = new Map<number,{
        resolve: (v:any) => void;
        reject: (e:Error) => void;
    }>();


    private serverName: string;
    constructor(
        private command: string,
        private args: string[],
        private env?: Record<string, string> // 存放环境变量
    ) {
        this.serverName = args[args.length - 1]?.replace(/^@.*\//, '') || 'mcp-server';
    }


    async connect(): Promise<void> {
        /*
        这段代码就是在启动 MCP Server 进程，并且告诉它"咱俩通过标准输入输出来聊天"。
        简单说，spawn 就是 Node.js 里开一个新进程的方法。这里它启动了 GitHub MCP Server（一个独立的命令行程序），然后通过
        stdio: ['pipe', 'pipe', 'pipe'] 把三个通道都设成"管道模式"——stdin 用来往 Server 发 JSON 指令，stdout 用来
        收 Server 的 JSON 回复，stderr 用来接收错误日志。你可以把它想象成：你找了个翻译，你写好纸条（JSON-RPC 请求）
        从他左边口袋塞进去，他从右边口袋掏出翻译结果（JSON-RPC 响应），偶尔从领口掉出个错误提示。
        至于 env: { ...process.env, ...this.env }，这是在合并环境变量。GitHub MCP Server 需要 GITHUB_TOKEN 之类的认证信息
        才能访问 GitHub API，这些敏感信息存在 .env 文件里。这行代码把当前进程的环境变量和你在构造函数里传入的额外环境变量拼在一起，传给
        子进程，这样 Server 启动后就能读到 Token 去调 GitHub 了。
        这段是整个 MCP Client 的地基——没有它，后面的 send() 往 stdin 写消息就无从谈起。*/

//      this.command 和 this.args 就是启动 MCP Server 进程时用的「命令」和「参数」。
//      打个比方：你在终端里运行 npx @anthropic/mcp-server-github，那 command 就是 npx，args 就是 ['@anthropic/mcp-server-github']。
        this.process = spawn(this.command, this.args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {...process.env, ...this.env},
        });

        this.process.on('error', (err) => {
            console.error(`[MCP] 进程启动失败 ：${err.message}`);
        });
        // stderr 是进程用来报错和打日志的通道，这里只是把它的数据"吞掉"了，什么都不做。
        this.process.stderr?.on('data', ()=>{});

        // rl.on()会持续监听，
        /*
        this.process.stdout! 是子进程的标准输出流，它只是把数据"吐出来"，本身不做任何监听
        createInterface({ input: this.process.stdout! }) 创建了一个 readline 接口，它会持续监听这个流，每当收到完整的换行符 \n，
        就触发 line 事件 rl.on('line', ...) 才是真正处理每一行 JSON 响应的地方，这块代码会一直运行，直到你调用 close() 关闭接口*/
        this.rl = createInterface({input: this.process.stdout!});
        this.rl.on('line',(line)=>{
            try {
                const msg = JSON.parse(line);
                if (msg.id !== undefined && this.pending.has(msg.id)){
                    const p = this.pending.get(msg.id)!;
                    this.pending.delete (msg.id);
                    if (msg.error) {
                        p.reject(new Error( `MCP error ${msg.error.code}: ${msg.error.message}`))
                    }else {
                        p.resolve(msg.result)
                    }
                }
            }catch { }
        });

        // 这两段代码的作用就是激活 MCP Server，完成"握手"
        // initialize 让双方确认协议版本和能力集
        await this.send('initialize',{
            protocolVersion:'2024-11-05',
            capabilities: {},
            clientInfo: {name: 'super-agent', version: '0.5.0'}
        });

        // initialized 是客户端单方面宣布"我已经准备好开始干活了"。
        this.process.stdin!.write(JSON.stringify({
            jconrpc:'2.0',
            method: 'notifications/initialized',
        }) + '\n');
    };

    /*send() 负责跑车——每次调用它，它会生成一个唯一编号 id，写一张“小纸条”放进 pending：
    “编号 X 的请求，如果成功了就调这个 resolve，失败了就调这个 reject”。然后把请求消息往 stdin 一写，就开始等。注意它自己不监听响应
    ，它只是把“等”这件事挂在了 pending 里，然后靠 connect() 里那个监听器来兑现。*/

    private send(method: string, params?: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const id = ++this.requestId;

            const timeout= setTimeout(()=>{
                this.pending.delete(id);
                reject(new Error(`MCP request timeout: ${method}`));
            },15000);

            this.pending.set(id,{
                resolve: (v:any)=>{clearTimeout(timeout); resolve(v);},
                reject: (e: Error) => { clearTimeout(timeout); reject(e); },
            });
            const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
            this.process!.stdin!.write(msg + '\n');
        })
    }

    async listTools(): Promise<MCPTool[]> {
        const result = await this.send('tools/list',{});
        return result.tools || [];
    }

    // 把非文本的噪音过滤掉，有用的信息交给模型（Agent的模型通常只认文本）
    async callTool(
        name: string, args: Record<string, unknown>
    ): Promise<string>{
        const result: MCPCallResult = await this.send(
            'tools/call', {name, arguments:args}
        );
        const texts = (result.content || [])
            .filter(c => c.type === 'text' && c.text)
            .map(c=> c.text!);
        return texts.join('\n') || '无返回内容';
    }


    async close(): Promise<void> {
        if (this.rl) this.rl.close();
        if (this.process) this.process.kill();
    }
}

export class MockMCPClient {
    async connect(): Promise<void> {}

    async listTools(): Promise<MCPTool[]> {
        return [
            {
                name: 'list_issues',
                description: '列出GitHUb 仓房的 Issues',
                inputSchema:{
                   type: 'object',
                   properties: {
                       owner: { type:'string', description: '仓库所有者'},
                       repo: { type: 'string', description: '仓库名称' },
                   },
                   required:['owner', 'repo'],
                }
            },
            {
                 name: 'search_repositories',
                 description: '搜索 GitHub 仓库',
                 inputSchema: {
                     type: 'object',
                     properties: {
                         query: { type: 'string', description: '搜索关键词' },
                     },
                     required: ['query'],
                 },
            },
            {
                name: 'get_file_contents',
                description: '获取仓库中文件的内容',
                inputSchema: {
                    type: 'object',
                    properties: {
                        owner: { type: 'string', description: '仓库所有者' },
                        repo: { type: 'string', description: '仓库名称' },
                        path: { type: 'string', description: '文件路径' },
                    },
                    required: ['owner', 'repo', 'path'],
                },
            }
        ]
    }

    async callTool(
        name: string, args: Record<string, unknown>
    ): Promise<string> {
        switch (name) {
            case 'list_issues':
                return JSON.stringify([
                    {number: 42, title: '支持 MCP 协议接入', state: 'open'},
                    {number: 41, title: '循环检测阈值可配置化', state: 'open'},
                    {number: 39, title: 'Token 预算用完后的优雅降级', state: 'closed'}
                ], null, 2);
            case 'search_repositories':
                return JSON.stringify([
                   { full_name: 'anthropics/anthropic-sdk-python', stars: 2800 },
                   { full_name: 'vercel/ai', stars: 12000 },
                   { full_name: 'modelcontextprotocol/servers', stars: 5600 },
                ], null,2)
            case 'get_file_contents':
                return `# README\n\nMock file: ${args.owner}/${args.repo}/${args.path}`;
            default:
                return `未知工具: ${name}`;
        }
    }

    async close(): Promise<void> {}
}