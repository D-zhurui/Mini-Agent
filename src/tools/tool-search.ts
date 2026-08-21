import type { ToolRegistry, ToolDefinition } from './registry.js';

/* 
流程是这样：
启动时——System prompt 里塞了两样东西：① active 工具的完整 Schema；② 一份延迟工具的名字列表（只有名字 + 简短 hint，没有 Schema）
模型遇到需要延迟工具的任务——它从名字列表里选中工具名，调用 tool_search(query="mcp__github__list_issues")
tool_search 返回完整 Schema——这次调用的结果里包含了工具的 name、description、parameters，模型拿到后就能在下一轮调用这个工具了
同时标记为已发现——discoveredTools 集合记录了这个工具名，后续对话里这个工具的 Schema 会被 getActiveTools() 正常输出，不用再搜一次
所以准确说是：active 工具一开始就带着 Schema 进 prompt，延迟工具需要模型主动搜一次才能用，搜过之后就"升级"成活跃状态了。这个"升级"不是换个表，而是同一个表里的过滤条件变了——搜索前被 getActiveTools() 过滤掉，搜索后就被放行了。
* */
export function createToolSearchTool(registry: ToolRegistry): ToolDefinition {
  return {
    name: 'tool_search',
    description: '获取延迟工具的完整定义',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async ({ query }: { query: string }) => {
      const results = registry.searchTools(query);
      if (results.length === 0) return `没有找到工具: ${query}`;
      return results.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
    },
  };
}
