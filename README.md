# Super Agent

一个基于 TypeScript 的 AI Agent 框架，提供交互式命令行助手、多智能体（子 Agent）协作、RAG 知识库检索、定时任务、插件系统与飞书（Lark）渠道接入。

> 程序内自称为 "Super Agent v1.0"，配置文件为 `super-agent.config.json`。

## ✨ 核心特性

- 🤖 **多轮对话 Agent**：内置 Agent 主循环，支持工具调用、重试与循环检测
- 🧰 **可扩展工具系统**：文件、Shell、搜索、网页搜索、RAG、记忆、子 Agent、定时任务等工具
- 📚 **RAG 检索增强**：基于 SQLite + sqlite-vec 的向量检索，支持文档分块与 DashScope 向量化
- 🧠 **记忆存储**：跨会话记忆
- 👥 **子 Agent 协作**：可派生子 Agent，支持最大深度与并发控制
- ⏰ **定时任务**：基于 cron 的定时执行
- 🔌 **插件系统**：Supabase 等插件按需加载
- 📡 **渠道网关**：飞书（Lark）消息渠道接入
- 🛡️ **安全机制**：Hook 管线（审计日志、命令时间戳）、Bash 命令分类、角色控制
- 🎯 **Skills**：可加载自定义技能（`.skills/`）
- 📊 **用量统计**：Token 用量跟踪

## 🛠 技术栈

TypeScript · Node.js · Hono · Vercel AI SDK（`ai` + `@ai-sdk/openai`）· better-sqlite3 · sqlite-vec · croner · zod · fast-glob · turndown · tsx · pnpm

## 📁 目录结构

```
app/          前端页面（index.html、wordle）
docs/         项目文档
src/
  agent/      Agent 主循环、重试、循环检测
  agents/     子 Agent 注册与派生
  channels/   渠道网关（飞书）
  commands/   斜杠命令
  config/     配置加载与初始化
  context/    上下文构建、压缩与防御
  cron/       定时任务
  memory/     记忆存储
  plugins/    插件系统
  rag/        检索增强（分块、向量化、检索）
  security/   安全 Hook 与 Bash 分类
  session/    会话存储
  skills/     技能加载
  tools/      工具集
  usage/      用量统计
main.py       Python 示例脚本（非核心）
super-agent.config.json   配置文件
```

## 🚀 快速开始

### 环境要求

- Node.js 22+
- pnpm

### 安装

```bash
pnpm install
```

### 配置

编辑 `super-agent.config.json`，至少配置模型提供商：

```json
{
  "model": {
    "provider": "dashscope",
    "name": "qwen-plus-latest",
    "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "apiKey": "<你的 API Key>"
  }
}
```

### 运行

```bash
pnpm start       # 启动交互式 Agent
pnpm dev         # 开发模式（热重载）
pnpm init        # 初始化配置
pnpm continue    # 继续上次会话
```

启动后可输入问题，或使用 `/` 斜杠命令（如 `/agents`、`/cron`、`/role`），输入 `exit` 退出。

## ⚙️ 配置说明

`super-agent.config.json` 主要包含以下配置项：

| 配置项 | 说明 |
| ------ | ---- |
| `model` | 模型提供商、名称、baseURL 与 API Key |
| `plugins` | 插件开关（如 supabase） |
| `channels.feishu` | 飞书渠道的 appId / appSecret / 端口 |
| `agents` | 子 Agent 最大派生深度、并发数、超时 |
| `security` | 默认角色、审计日志、命令时间戳 |
| `memory` | 记忆数据目录 |
| `rag` | RAG 开关与文档目录 |
| `cron` | 定时任务开关与数据目录 |
| `session` | 会话 ID |
| `usage` | 用量统计文件路径 |

## 🔒 安全提示

**切勿将 API Key、appSecret 等敏感信息提交到 Git。** 请使用 `.env` 文件或环境变量管理密钥，并将配置文件中的密钥替换为占位符。项目根目录的 `.env` 已被 `.gitignore` 忽略。

## 📄 文档

- [API 设计](docs/api-design.md)
- [部署指南](docs/deployment-guide.md)
