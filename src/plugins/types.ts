import { ChannelDefinition } from "../channels/types";
import {ToolDefinition} from "../tools/registry";


// 插件的私有配置项（如 API 密钥、开关状态）。
export interface PluginConfig {
    [key: string]: string | number | boolean;
}

// 系统限制性地暴露给插件的权限。插件只能通过这把“钥匙”去注册工具、获取配置、打日志，无法直接操作系统的核心内核。
export interface PluginApi {
    registerTools( tools: ToolDefinition[]): void;
    // registerChannel(channel: ChannelDefinition): void;
    getConfig (): PluginConfig;
    log(message: string): void;
}

// 插件必须实现的契约。定义了插件叫什么（name）、怎么启动（activate）、怎么打扫退房（destroy）。
export interface PluginDefinition {
    name: string;
    version: string;
    description: string;
    config?: PluginConfig;

    activate(api: PluginApi): Promise<void> | void;
    destroy?(): Promise<void> | void;
}