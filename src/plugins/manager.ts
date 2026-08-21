import {PluginApi, PluginConfig, PluginDefinition} from "./types";
import {ToolDefinition, ToolRegistry} from "../tools/registry";

// PluginDefinition 描述的是一个"插件"的整体身份，而插件实际提供的能力——也就是工具——是在 activate 里通
// 过 api.registerTools() 注册进去的，一个插件可以注册多个工具。
// LoadedPlugin 这个接口就是用来记录"这个插件当前加载了什么"的账本：definition 保存插件自身的元信息（名字、版本、描述），
// tools 是一个字符串数组，存的是这个插件注册的所有工具名（注意是加了前缀之后的完整名字，比如 supabase__query）。当插件被卸
// 载时，PluginManager 就靠这个 tools 数组知道该从 Registry 里删掉哪些工具。
interface LoadedPlugin {
    definition: PluginDefinition;
    tools: string[];
}

export class PluginManager {
    // 键是插件名（string），值是 LoadedPlugin（包含插件的定义 definition 和它注册的工具列表 tools）。
    private plugins = new Map<string, LoadedPlugin>();
    private registry: ToolRegistry;

    constructor(registry: ToolRegistry) {
        // this.registry = new ToolRegistry() 与 this.registry = registry的区别
        // 死绑定（紧耦合）：PluginManager 把自己的命和 ToolRegistry 死死绑在了一起。如果未来你想用 MockRegistry 做单元测试，
        // 完全做不到，因为代码写死了必须 new ToolRegistry()。
        //
        // 无法共享状态（致命伤）：注意你 index.ts 里的代码，你事先已经在 registry 里注册了 allTools、rag_search 等几十个工具。
        // 如果 PluginManager 内部自己 new 了一个新的 registry，那个新的 registry 里面是空的！插件注册的工具会跑到空的那个里面，
        // 而你的 agentloop 用的是外面那个（含 allTools 的）。结果就是：插件工具永远无法被 Agent 调用。
        //
        // 难以测试：如果内部 new 的时候需要读取配置文件或环境变量，写单元测试时会非常痛苦。
        this.registry = registry;
    }

    async load(definition: PluginDefinition, config?: PluginConfig): Promise<string[]> {
        if(this.plugins.has(definition.name)) {
            throw new Error(`插件 "${definition.name}" 已加载`);
        }

        // {
        // ...definition.config,
        // ...config,
        // }  实现合并，config 可以替换 definition.config里面的内容
        const resolvedConfig = this.resolveEnvVars({
            ...definition.config,
            ...config,
        });

        const registeredTools: string[] = [];

        const api: PluginApi = {
            registerTools:( tools: ToolDefinition[]) => {
                for (const tool of tools) {
                    const prefixedName = `${definition.name}_${tool.name}`;
                    const prefixedTool: ToolDefinition = {
                        ...tool,
                        name: prefixedName,
                        description: `[Plugin:${definition.name}] ${tool.description}`
                    };
                    // 真正把工具挂到 ToolRegistry 上。
                    this.registry.register(prefixedTool);
                    // 把注册成功的名字存入 registeredTools 数组，方便后续卸载时清理。
                    registeredTools.push(prefixedName);
                }
            },
            getConfig: () => resolvedConfig,
            log: (message:string) => {
                console.log(` [plugin:${definition.name}] ${message}`);
            }
        };

        // ：调用插件定义的 activate 函数，并把刚才构造好的 api 传给它。插件内部会使用 api.registerTools 来注册它的工具。
        try {
            await definition.activate(api);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`[plugin: ${definition.name}] 激活失败： ${msg}`);
            throw err;
        }

        // 把插件定义和它注册的工具列表存入 plugins Map，方便后续卸载或查询。
        this.plugins.set(definition.name, {
            definition,
            tools: registeredTools,
        });

        return registeredTools;
    }



    async unload(name: string): Promise<boolean> {
        const plugin = this.plugins.get(name);
        if (!plugin) return false;

        if (plugin.definition.destroy) {
            try {
                await plugin.definition.destroy();
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`  [plugin:${name}] destroy 出错: ${msg}`);
            }
        }

        for (const toolName of plugin.tools) {
            this.registry.unregister(toolName);
        }

        this.plugins.delete(name);
        return true;
    }



    async unloadAll(): Promise<void> {
        const names = Array.from(this.plugins.keys());
        for (const name of names) {
            await this.unload(name);
        }
    }

    get(name: string): LoadedPlugin | undefined {
        return this.plugins.get(name);
    }

    list(): Array<{ name: string; version: string; description: string; tools: string[] }> {
        return Array.from(this.plugins.values()).map(p => ({
            name: p.definition.name,
            version: p.definition.version,
            description: p.definition.description,
            tools: p.tools,
        }));
    }

    // 它负责把插件配置里的占位符（如 ${API_KEY}），替换成系统环境变量（process.env）里的真实值。
    private resolveEnvVars(config: PluginConfig): PluginConfig {
        const resolved: PluginConfig = {};
        for (const [key, value] of Object.entries(config)) {
            if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
                const envKey = value.slice(2, -1);
                resolved[key] = process.env[envKey] || '';
            } else {
                resolved[key] = value;
            }
        }
        return resolved;
    }

}

