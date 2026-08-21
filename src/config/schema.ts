import { z } from 'zod';

export const ModelConfigSchema = z.object({
    provider: z.enum(['dashscope', 'openai', 'custom']).default('dashscope'),
    name: z.string().default('qwen-plus-latest'),
    baseURL: z.string().default('https://dashscope.aliyuncs.com/compatible-mode/v1'),
    apiKey: z.string().default(''),
});

export const PluginConfigSchema = z.object({
    name: z.string(),
    enabled: z.boolean().default(true),
    config: z.record(z.string(), z.unknown()).default({}),
});

export const FeishuChannelConfigSchema = z.object({
    enabled: z.boolean().default(false),
    appId: z.string().default(''),
    appSecret: z.string().default(''),
    port: z.number().default(3000),
});

export const ChannelConfigSchema = z.object({
    feishu: FeishuChannelConfigSchema.default({} as any),
});

export const AgentConfigSchema = z.object({
    maxSpawnDepth: z.number().min(0).max(5).default(1),
    maxConcurrent: z.number().min(1).max(10).default(3),
    defaultTimeout: z.number().default(60000),
});

export const SecurityConfigSchema = z.object({
    defaultRole: z.string().default('developer'),
    auditLog: z.boolean().default(true),
    bashTimestamp: z.boolean().default(true),
});

export const MemoryConfigSchema = z.object({
    dataDir: z.string().default('.'),
});

export const RagConfigSchema = z.object({
    enabled: z.boolean().default(true),
    docsDir: z.string().default('docs'),
});

export const CronConfigSchema = z.object({
    enabled: z.boolean().default(true),
    dataDir: z.string().default('.'),
});

export const SessionConfigSchema = z.object({
    id: z.string().default('default'),
});

export const UsageConfigSchema = z.object({
    trackingFile: z.string().default('.usage/today.jsonl'),
});

export const SuperAgentConfigSchema = z.object({
    version: z.string().default('1.0'),
    model: ModelConfigSchema.default({} as any),
    plugins: z.array(PluginConfigSchema).default([]),
    channels: ChannelConfigSchema.default({} as any),
    agents: AgentConfigSchema.default({} as any),
    security: SecurityConfigSchema.default({} as any),
    memory: MemoryConfigSchema.default({} as any),
    rag: RagConfigSchema.default({} as any),
    cron: CronConfigSchema.default({} as any),
    session: SessionConfigSchema.default({} as any),
    usage: UsageConfigSchema.default({} as any),
});

// z.infer 是 Zod Schema 的“回音壁”——它不产生新的声音，只是把 Schema 中定义的结构（运行时规则）原原本本地
// 反射到 TypeScript 类型空间（编译时检查），确保你写的代码和跑的数据永远保持同步。
export type SuperAgentConfig = z.infer<typeof SuperAgentConfigSchema>;