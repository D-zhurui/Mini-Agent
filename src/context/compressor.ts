import {textToolResultOutput, toolResultOutputToText} from "./tool-result-output";
import {generateText, ModelMessage} from "ai";

// 白名单设置
const CLEARABLE_TOOLS = new Set([
    'read_file', 'bash','grep','glob','list_direatory',
    'edit_file','write_file'
])

// 保留最近3个工具调用的结果
const KEEP_RECENT_TOOL_RESULTS = 3;

export function microcompact(messages: ModelMessage[]): {
    messages: ModelMessage[];
    cleared: number;
} {
    // 找到所有tool result消息的位置
    // 记下这些索引
    const toolResultIndices: number[] = [];
    for (let i= 0; i<messages.length; i++){
        if(messages[i].role === 'tool') toolResultIndices.push(i);
    }

    // 去掉需要保留的索引
    const toClear = toolResultIndices.slice(
        0, Math.max(0,toolResultIndices.length - KEEP_RECENT_TOOL_RESULTS)
    );

    let cleared = 0
    const result = messages.map((msg,idx) => {
        if (!toClear.includes(idx)) return msg;
        if (msg.role !== 'tool' || !Array.isArray(msg.content)) return msg;

        const toolName = (msg.content[0] as any) ?. toolName || 'unknown';
        if (!CLEARABLE_TOOLS.has(toolName)) return msg;

        cleared++;
        return  {
            ...msg,
            content: msg.content.map(part => ({
                ...part, output: textToolResultOutput('[tool result cleared]'),
            }))
        }
    })
    return {messages:result, cleared}
}

const COMPRESS_PROMPT = `你是一个对话压缩系统。你的任务是把 Agent 和用户之间的
对话历史压缩成一份结构化摘要，确保后续对话能够无缝继续。

请严格按照以下模板输出，每个字段都要填写：

## 用户意图
（用户在这次对话中想要完成什么）

## 已完成的操作
（Agent 执行了哪些工具调用、产生了什么结果）

## 关键发现
（读取的文件内容要点、搜索结果、命令输出中的关键信息）

## 当前状态
（对话进行到哪一步了、还有什么没做完）

## 需要保留的细节
（文件路径、变量名、配置值、错误信息等不能丢失的具体内容）

注意事项：
- 用对话中使用的语言输出
- 文件路径、UUID、版本号等标识符必须原样保留，不要翻译或改写
- 不要写笼统的概述，只保留具体的、可操作的信息
- 总长度控制在 800 字以内`;

const CONTEXT_TOKEN_THRESHOLD = 300;
const KEEP_RECENT_MESSAGES = 6;

// estimateTokens的计算逻辑如下
// const messages = [
//   {
//     role: 'user',
//     content: '请帮我读取文件'  // 8字符
//   },
//   {
//     role: 'assistant',
//     content: '好的，我来读取'  // 7字符
//   },
//   {
//     role: 'tool',
//     content: [
//       {
//         type: 'tool-result',
//         toolName: 'read_file',
//         output: { content: 'Hello World' }  // 11字符
//       }
//     ]
//   }
// ];
//
// // 计算过程：
// // msg1: content是字符串 → chars += 8
// // msg2: content是字符串 → chars += 7
// // msg3: content是数组 → 遍历part
// //   - 'output' in part → toolResultOutputToText() → 'Hello World' (11字符)
// //   - chars += 11
// // 总字符数 = 8 + 7 + 11 = 26
// // Token估算 = ceil(26 / 4) = ceil(6.5) = 7
//
// console.log(estimateTokens(messages)); // 输出: 7

function estimateTokens(messages: ModelMessage[]): number {
    let chars = 0;
    for (const msg of messages){
        if (typeof msg.content === 'string') {
            chars += msg.content.length
        } else if(Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if ('text' in part && typeof part.text === 'string'){
                    chars += part.text.length;
                } else if ('output' in part){
                    chars += toolResultOutputToText(part.output).length
                }
            }
        }
    }
    return Math.ceil(chars/4)
}

export interface CompactionResult{
    messages: ModelMessage[],
    summary: string,
    compressedCount: number,
}

export async function summarize(
    model: any,
    messages: ModelMessage[],
    existingSummary ?: string
):Promise<CompactionResult>{
    const tokenEstimate = estimateTokens(messages);
    if (tokenEstimate < CONTEXT_TOKEN_THRESHOLD) {
        return {messages, summary: existingSummary || '', compressedCount: 0};
    }

    // 保留最近N条消息，对齐到user消息边界
    const splitIdx= Math.max(0, messages.length - KEEP_RECENT_MESSAGES);
    // ...对齐逻辑...
    let alignedIdx = splitIdx
    while (alignedIdx > 0 && messages[alignedIdx].role !== 'user'){
        alignedIdx--;
    }
    if (alignedIdx === 0) {
        return {messages, summary: existingSummary || '', compressedCount: 0}
    }

    const toCompress = messages.slice(0, alignedIdx);
    const toKeep = messages.slice(alignedIdx);

    // 将需要压缩的消息列表格式化为纯文本，以便发送给AI模型生成摘要。
    const conversationText = toCompress.map(msg => {
        const content = typeof msg.content === 'string'
            ? msg.content
            : Array.isArray(msg.content)
                ? msg.content.map(part => 'text' in part
                    ? part.text
                    : 'output' in part ? toolResultOutputToText(part.output)
                        : '').join('')
                : '';
        return content ? `**${msg.role}**:${content}` : '';
    }).filter(Boolean).join('\n\n');

    // 如果格式化后的文本为空或只有空白字符，说明没有有效内容可压缩，直接返回原始消息。
    if (!conversationText.trim()) {
        return {messages, summary: existingSummary || '', compressedCount: 0};
    }


    // 如果有上一次的摘要，合并进去一起压缩
    const userPrompt = existingSummary ? `## 已有摘要 \n\n ${existingSummary} \n\n 新对话 \n\n ${conversationText}` : conversationText;

    try{

        const { text: summary} = await generateText({
            model, system: COMPRESS_PROMPT, prompt: userPrompt
        });

        // 摘要作为第一条消息，后面跟着保留的最近对话
        const summaryMessage: ModelMessage = {
            role: 'user',
            content: `[以下是之前对话的压缩摘要]\n\n${summary} \n\n[摘要结束]`,
        };

        const newMessages: ModelMessage[] = [summaryMessage, ...toKeep];
        return {
            messages: newMessages,
            summary,
            compressedCount: toCompress.length,
        }
    }catch (err){
        console.error('[Compaction] LLM 摘要失败:', err);
        return { messages, summary: existingSummary || '', compressedCount: 0 };
    }
}

export { estimateTokens };