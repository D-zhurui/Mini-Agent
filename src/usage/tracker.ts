import * as timers from "node:timers";
import {appendFileSync, mkdir, mkdirSync} from "node:fs";
import {dirname} from "node:path";

export interface ModelPricing {
  input: number;       // $ / 1M input tokens (cache miss)普通输入 token 的价格，也就是没命中缓存的那些前缀。比如你每轮对话里新增的用户消息、变化的工具列表，这些都要按全价付。
  output: number;      // $ / 1M output tokens 模型生成的 token 价格。输出通常比输入贵好几倍，因为生成是逐 token 算的，没法缓存。
  cacheWrite: number;  // $ / 1M tokens written to cache 把前缀写入缓存的单价。只有显式缓存模式（比如 Claude）会单独收这笔钱，是"存进去"的费用，通常比 input 略贵一点，因为多了一次写入操作。
  cacheRead: number;   // $ / 1M tokens read from cache (hit) 命中缓存后读取的单价。这才是省钱的来源——通常只有 input 全价的 10% 到 25%，DeepSeek 甚至能低到 1%。
}

export interface StepUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface UsageContext {
  provider?: string;
  providerMetadate?: any;
}


export const PRICE_TABLE: Record<string, ModelPricing> = {
  // Anthropic（最新主力，2026 上半年发布的 4.7 系列）
  'claude-opus-4-7':      { input: 15.00, output: 75.00, cacheWrite: 18.75, cacheRead: 1.50 },
  'claude-sonnet-4-7':    { input: 3.00,  output: 15.00, cacheWrite: 3.75,  cacheRead: 0.30 },
  'claude-haiku-4-5':     { input: 1.00,  output: 5.00,  cacheWrite: 1.25,  cacheRead: 0.10 },
  // OpenAI（GPT-5 系列；GPT-5.5 默认 24h extended cache）
  'gpt-5-5':              { input: 5.00,  output: 20.00, cacheWrite: 5.00,  cacheRead: 0.50 },
  'gpt-5':                { input: 5.00,  output: 15.00, cacheWrite: 5.00,  cacheRead: 1.25 },
  // Google（Gemini 3 系列，最新 preview）
  'gemini-3-pro':         { input: 2.50,  output: 12.00, cacheWrite: 2.50,  cacheRead: 0.625 },
  'gemini-3-flash':       { input: 0.30,  output: 1.20,  cacheWrite: 0.30,  cacheRead: 0.075 },
  // 国产
  'deepseek-v3-2':        { input: 0.27,  output: 1.10,  cacheWrite: 0.27,  cacheRead: 0.027 },
  'qwen3-6-plus':         { input: 0.40,  output: 1.20,  cacheWrite: 0.40,  cacheRead: 0.04 },
  'kimi-k2-6':            { input: 0.60,  output: 2.50,  cacheWrite: 0.60,  cacheRead: 0.15 },
  'doubao-2-0-pro':       { input: 0.30,  output: 0.90,  cacheWrite: 0.30,  cacheRead: 0.12 },
  // 课程内 mock，用 Haiku 4.5 同档价格
  'mock-model':           { input: 1.00,  output: 5.00,  cacheWrite: 1.25,  cacheRead: 0.10 },
};

// 翻译器：把 OpenAI 说的"含缓存总输入"和 Anthropic 说的"纯输入+缓存读写"都翻译成统一的"纯输入、缓存读、缓存写、输出"四个桶，让后续的成本计算不会算出两套账。
// 这段代码主要在解决 OpenAI 和 Anthropic（Claude） 两家的统计口径差异，顺带兼容了其他走 AI SDK 标准字段的厂商。
export function normalizeUsage(usage: any, context: UsageContext = {}): StepUsage {
  if (!usage) return  { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0}

  const cacheRead = usage.cachedInputTokens ?? 0;   // AI SDK 标准字段

  //Anthropic SDK 直接把它挂在 top-level 的 cacheCreationInputTokens 里，但 AI SDK 标准还没吸纳这个字段，所以得兜底去 providerMetadata 里面找。
  const cacheWrite = usage.cacheCreationInputTokens
      ?? context.providerMetadate?.anthropic?.cacheCreationInputTokens
      ?? 0;

  const rawInputTokens = usage.inputTokens ?? 0;
  const inputTokens = context.provider?.startsWith('openai')
      ? Math.max(0,rawInputTokens - cacheRead)
      : rawInputTokens;

  return {
    inputTokens,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  }
}

export interface StepRecord extends StepUsage {
  ts: number;
  model: string;
  cost: number;
}

//  Token使用量追踪器
export class UsageTracker{
  // 存储每次调用的记录
  private steps: StepRecord[] = [];
  // 存储地址
  private logPath?: string;

  constructor(logPath?:string){
    this.logPath = logPath;
    if (logPath) {mkdirSync(dirname(logPath), {recursive: true})}
  }

  // 记录单次调用的费用
  record(model:string, usage: StepUsage): StepRecord {
    const cost = computeCost(model, usage);   // 根据模型和用量来计算费用
    const record = { ts: Date.now(), model, cost, ...usage};
    this.steps.push(record);

    if (this.logPath) {
      appendFileSync(this.logPath, JSON.stringify(record) + '\n');
    }
    return record;
  }



  totals(){
    // this.steps.reduce() 的作用是将数组中所有 StepRecord 对象的各项数值累加成一个汇总对象。
    const t = this.steps.reduce(
        (a,s) => ({
          inputTokens: a.inputTokens + s.inputTokens,
          outputTokens: a.outputTokens + s.outputTokens,
          cacheReadTokens: a.cacheReadTokens + s.cacheReadTokens,
          cacheWriteTokens: a.cacheWriteTokens + s.cacheWriteTokens,
          cost: a.cost + s.cost
        }), {inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0}
    );

    // 所有"输入类"token：实际输入 + 缓存读取 + 缓存写入
    const totalInputLike = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
    // 缓存命中率 = 缓存读取量 / 总输入类token量
    const hitRate = totalInputLike > 0 ? t.cacheReadTokens / totalInputLike : 0;

    // 计算基准成本
    const baselineCost = (()=>{
      let c = 0;
      for (const s of this.steps){
        const p = PRICE_TABLE[s.model] || PRICE_TABLE['mock-model'];
        const inputLike = s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens;
        c += (inputLike * p.input) / 1_000_000;
        c += (s.outputTokens * p.output) / 1_000_000;
      }
      return c;
    })()
    return {
      ...t, // 展开汇总数据
      hitRate, // 命中率
      baselineCost, // 按照原价计算的成本
      savedCost: baselineCost - t.cost,  //节省的费用
      steps: this.steps.length   // 总调用次数
    };
  }
}

export function computeCost(model:string, usage: StepUsage):number {
  const p = PRICE_TABLE[model] || PRICE_TABLE['mock-model']
  return (
      (usage.inputTokens * p.input
          + usage.outputTokens * p.output
          + usage.cacheReadTokens * p.cacheRead
          + usage.cacheWriteTokens * p.cacheWrite)
      /1_000_000
  );
}




































