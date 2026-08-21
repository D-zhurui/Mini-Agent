import {ModelMessage} from "ai";
import {before} from "node:test";
import {config} from "dotenv";
import {textToolResultOutput, toolResultOutputToText} from "./tool-result-output";
import {Mode} from "node:fs";
import * as timers from "node:timers";
import {estimateTokens} from "./compressor";


 // ----------Layer 1: Token估算，知道自己还剩多少空间---------------
export class TokenTracker {
    private lastPreciseCount = 0; //上次 API 返回的精确值
    private pendingChars = 0 //新增消息的字符数

    updateFromAPI(promptTokens: number): void{
        this.lastPreciseCount = promptTokens;
        this.pendingChars = 0;  // 精确值到了，将估计值清零
    }

    addMessage(message: ModelMessage): void{
        this.pendingChars += countMessageChars(message);
    }

    addMessages(messages: ModelMessage[]): void{
        for (const message of messages) this.addMessage(message);
    }

    replaceMessages(before: ModelMessage[], after: ModelMessage[]): void{
        this.pendingChars += countMessagesChars(after) - countMessagesChars(before)
    }

    get estimatedTokens(): number {
        return this.lastPreciseCount + Math.ceil(this.pendingChars / 4)
    }
}

export function estimatedMessageTokens(messages: ModelMessage[]): number {
    let chars = 0;
    for (const msg of messages) {
        // ... 遍历所有消息内容，累加字符数 ...
    }

    return Math.ceil((chars/4) * 1.2); // 1.2 的中文安全系数
}

function countMessageChars(message: ModelMessage): number{
    let chars= 0;
    if (typeof message.content === 'string') {
        return message.content.length;
    }
    if (!Array.isArray(message.content)) return chars;

    for (const part of message.content) {
        if ('text' in part && part.text === 'string') {
            chars += part.text.length;
        } else if ('output' in part){
            chars += toolResultOutputToText(part.output).length;
        } else if ('input' in part){
            chars += JSON.stringify(part.input)?.length ?? 0;
        }
    }
    return chars;
}

function countMessagesChars(messages: ModelMessage[]): number{
    let chars = 0 ;
    for (const message of messages){
        chars += countMessageChars(message);
    }
    return chars;
}

// export function estimateMessageTokens(messages: ModelMessage[]):number{
//     let chars = 0;
//     for (const message of messages){
//         chars += countMessageChars(message);
//     }
//     return Math.ceil((chars / 4) * 1.2)
// }

export function estimateMessageTokens(messages: ModelMessage[]): number {
  const chars = countMessagesChars(messages);
  // 4 chars per token, with 1.2x safety factor for Chinese
  return Math.ceil((chars / 4) * 1.2);
}
// ---------Layer 2: 工具结果动态截断 -------------

const CONTEXT_WINDOW = 200_000

export function truncateToolResults(
    messages: ModelMessage[],
    config = {
        maxSingleResult: CONTEXT_WINDOW * 0.5 * 2,   // 单个工具结果不超过上下文窗口的 50%, 2个中文字符约1个Token
        contextBudgetChars: CONTEXT_WINDOW * 0.75 * 4, // 总上下文不超过 75%, 4个字符约1个Token
    },
): { messages: ModelMessage[]; truncated: number; compacted: number} {
    let truncated = 0;
    let compacted = 0;
    // pass 1: 单条截断————超过窗口 50% 的工具结果做 Head/Tail 分隔
    let result = messages.map(msg => {
        if (msg.role !== 'tool') return msg;
        const newContent = msg.content.map((part: any) => {
            if (!part.output) return part;
            const outputText = toolResultOutputToText(part.output);
            if (outputText.length <= config.maxSingleResult) return part;
            truncated++;
            const maxChars = config.maxSingleResult;
            const head = outputText.slice(0, Math.floor(maxChars * 0.6));
            const tail = outputText.slice(-Math.floor(maxChars * 0.4));
            return {
                ...part,
                output: textToolResultOutput(
                    `${head} \n\n [truncated: ${outputText.length} ➡ ${maxChars} chars] \n\n ${tail}`
                )
            }
        })
        return {...msg, content: newContent}
    })

    // Pass 2: 总量预算——如果总字符数还超 75%，从最老的 tool result 开始清理
    let totalChars = result.reduce( (sum, msg)=>{
        if (typeof msg.content === 'string') return sum + msg.content.length;
        if (Array.isArray(msg.content)){
            return sum + msg.content.reduce((s: number, p: any) => s + (p.output ? toolResultOutputToText(p.output).length : p.text?.length || 0) ,0)
        }
        return sum;
    } ,0);

    if (totalChars > config.contextBudgetChars) {
        for (let i = 0; i < result.length && totalChars > config.contextBudgetChars; i++) {
            const msg = result[i];
            if (msg.role !== 'tool' && !Array.isArray(msg.content)) continue;
            const toolName = (msg.content[0] as any)?.toolName || 'unknown';
            const oldSize = (msg.content as any[]).reduce((s:number, p: any) =>
                s + (p.output ? toolResultOutputToText(p.output).length : 0),0);
            result[i] = { ...msg, content: (msg.content as any).map((p: any)=>({
                    ...p,
                    output: textToolResultOutput(`[compacted: ${toolName} output removed to free context]`)
                }))};
            totalChars -= oldSize;
            compacted++;
        }
    }

    return {messages: result, truncated, compacted}
}

// ------------- Layer 3：TTL 修剪——时间衰减 ----------------

export interface PruneResult {
  messages: ModelMessage[];
  softPruned: number;
  hardPruned: number;
}

export function ttlPrune(
    messages: ModelMessage[],
    timestamps: Map<number,number>,
    config = { softTTLMs: 5* 60_000, hardTTLMs: 10 * 60_000, keepHeadTail: 1500},
): PruneResult {
    const now = Date.now();
    let softPruned = 0, hardPruned = 0;
    const result = messages.map((msg, idx)=>{
        // 只修剪 tool 结果，user/assistant 消息永不修剪
        if (msg.role !== 'tool') return msg;
        const age = now - (timestamps.get(idx) || now);
        // 保留错误经验——失败的工具结果永不修剪
        const outputText = msg.content
            .map((p:any)=> p.output ? toolResultOutputToText(p.output) : '').join('');
        if (/error|失败|不存在|denied|timeout/i.test(outputText)) return msg;
        // 硬清除（10 分钟）——整个工具结果替换成 [tool result expired: read_file]。只保留"发生过什么"的事实，内容全部清掉。
        if (age >= config.hardTTLMs){
            hardPruned++;
            return {
                ...msg,
                content: msg.content.map((part: any)=>({
                    ...part,
                    output: textToolResultOutput('[tool result expired]')
                }))
            }
        }
        // 软修剪（5 分钟）——保留头部和尾部各 1500 字符，中间替换成 [soft pruned] 标记。
        if (age >= config.softTTLMs){
            const newContent = msg.content.map((part: any) => {
            if (!part.output) return part;
            const outputText = toolResultOutputToText(part.output);
            if (outputText.length <= config.keepHeadTail * 2) return part;

            softPruned++;
            const head = outputText.slice(0, config.keepHeadTail);
            const tail = outputText.slice(-config.keepHeadTail);
            const removed = outputText.length - config.keepHeadTail * 2;

            return {
              ...part,
              output: textToolResultOutput(`${head}\n\n[soft pruned: ${removed} chars removed, content older than ${Math.round(config.softTTLMs / 60000)}min]\n\n${tail}`),
            };
          });
          return { ...msg, content: newContent };
        }

        return msg;
    })
    return { messages: result, softPruned, hardPruned };
}

// ---------combined Defense----------------
export interface DefenseResult {
    messages: ModelMessage[];
    tokenEstimate: number;
    truncated: number;
    compacted: number;
    softPruned: number;
    hardPruned: number;
}

export function applyDefense(
    messages: ModelMessage[],
    timestamps: Map<number,number>
): DefenseResult {
    // layer 2: truncate oversized tool results
    const trunc = truncateToolResults(messages);
    let result = trunc.messages;
    // layer 3: TTL prune old tool results
    const prune = ttlPrune(result, timestamps);
    result = prune.messages;
    // layer 1: estimate final token count
    const tokenEstimate = estimateMessageTokens(result)

    return {
        messages: result,
        tokenEstimate,
        truncated: trunc.truncated,
        compacted: trunc.compacted,
        softPruned: prune.softPruned,
        hardPruned: prune.hardPruned,

    }
}