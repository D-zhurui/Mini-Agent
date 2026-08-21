import {streamText, type ModelMessage} from "ai";
import * as process from "node:process";
import {detect, recordCall, recordResult, resetHistory} from "./loop-detection";
import {isRetryable, calculateDelay, sleep} from "./retry";
import {ToolRegistry} from "../tools/registry";
import {TokenTracker} from "../context/defense";
import {normalizeUsage, type UsageTracker} from "../usage/tracker";

const MAX_STEPS = 15;
const MAX_RETRIES = 3
const TOKEN_BUDGET = 50000

export interface BudgetState {
  used: number;
  limit: number;
}

export async function agentloop(
    model: any,
    registry:ToolRegistry,
    messages: ModelMessage[],
    system: string,
    // budget: BudgetState,
    // budget 只能让你事后算账，“超没超”都定死了；换成 tracker 就能提前摸底，给防线争取时间。
    // tracker: TokenTracker,
    // TokenTracker 只管“数 token”，而 UsageTracker 在数 token 的基础上还能“算钱”和“算 cache 省了多少钱”。
    tracker?: UsageTracker,
){
    let step = 0;
    let totalTokens = 0;
    resetHistory();

    while (step < MAX_STEPS){
        step++;
        console.log(`---Step ${step} ---`);
        let hasToolCall = false;
        // fullText 是从流里收集来的文本片段，最终组装成一个assistant消息，写进messages里
        let fullText = '';
        let shouldBreak = false;
        let lastToolCall: {name:string; input: unknown} | null =null
        // 提取streamText类型中的response属性值，Awaited用来专门解开Promise,取出内部包含的实际值类型
        let stepResponse: Awaited<ReturnType<typeof streamText>['response']>;
        let stepUsage: Awaited<ReturnType<typeof streamText>['usage']>;

        for (let attempt = 1; ;attempt ++) {
            try {
                const result = await streamText({
                model,
                system,
                // 之前的方式——你直接在调用 AI SDK 的地方写一坨 { get_weather: { description: ..., execute: ... } }。工具多了之后，这坨东西又长又乱，而且每个工具的执行逻辑里都没有截断保护，Agent Loop 也不知道这个工具能不能并发。,
                // 现在的方式——所有工具的定义、元数据、执行逻辑都存在 Registry 里。调用的时候，registry.toAISDKFormat() 自动把存着的工具转换成 AI SDK 要的那个格式，同时在每个工具的 execute 外面包一层 truncateResult，保证返回结果不会超长。
                tools:registry.toAISDKFormat(),
                messages,
                maxRetries: 0,
                onError:()=>{}
                });

                for await (const part of result.fullStream) {
                    switch (part.type) {
                        case 'text-delta':
                            process.stdout.write(part.text);
                            fullText += part.text;
                            break;
                        case 'tool-call':
                            hasToolCall = true;
                            lastToolCall = {name: part.toolName, input: part.input}
                            console.log(`[调用： ${part.toolName}(${JSON.stringify(part.input)})]`)

                            const detection = detect(part.toolName, part.input)
                            if (detection.stuck) {
                                console.log(`${detection.message}`)
                                if (detection.level === 'critical') {
                                    shouldBreak = true;
                                } else {
                                    messages.push({
                                        role: 'user' as const,
                                        content: `[系统提示] ${detection.message}.请换一个思路解决问题，不要重复的操作`
                                    })
                                }
                            }
                            recordCall(part.toolName, part.input)
                            break;

                        case 'tool-result':
                            console.log(`[结果： ${JSON.stringify(part.output)}]`);
                            if (lastToolCall) {
                                recordResult(lastToolCall.name, lastToolCall.input, part.output)
                            }
                            break;
                    }
                }
                stepResponse = await result.response;
                stepUsage = await result.usage;
                break;
            }catch (error) {
                if (attempt > MAX_RETRIES || !isRetryable(error as Error)) throw error;
                const delay = calculateDelay(attempt);
                console.log(`[重试] 第${attempt}/${MAX_RETRIES}次失败,${delay}ms后重试。。。`);
                await sleep(delay)
                hasToolCall = false;
                fullText = '';
                shouldBreak = false;
                lastToolCall = null;

            }
        }
        if (shouldBreak){
            console.log('\n[循环检测已经触发，Agent已停止]')
            break;
        }

        // 把 usage 喂给 tracker；tracker 内部按四类 token 分别累加并算 cost
        const norm = normalizeUsage(stepUsage);
        const stepRecord = tracker?.record(model?.modelId || 'mock-model', norm);
        totalTokens += norm.inputTokens + norm.outputTokens + norm.cacheReadTokens + norm.cacheWriteTokens;

        // cache 命中时才打印一行简洁状态，让 cache hit 立刻可见
        if (stepRecord && (norm.cacheReadTokens > 0 || norm.cacheWriteTokens > 0)) {
          const tag = norm.cacheReadTokens > 0 ? `\x1b[38;5;36m✓ cache hit\x1b[0m` : `\x1b[38;5;220m✎ cache write\x1b[0m`;
          const detail = norm.cacheReadTokens > 0 ? `read ${norm.cacheReadTokens}` : `write ${norm.cacheWriteTokens}`;
          console.log(`  [${tag}] ${detail} tokens · 本步 $${stepRecord.cost.toFixed(5)}`);
        }

//         第1步：stepUsage?.inputTokens?.total
        // 如果 stepUsage 存在，尝试获取 inputTokens
        //
        // 如果 inputTokens 存在，尝试获取其 total 属性
        //
        // 如果成功获取到 total 的值（非 null/undefined），就使用它
        //
        // 第2步：?? stepUsage?.inputTokens
        // 如果第1步结果是 null 或 undefined
        //
        // 尝试获取 stepUsage.inputTokens（直接作为数值）
        //
        // 第3步：?? 0
        // 如果第2步结果也是 null 或 undefined
        //
        // 使用默认值 0
        // const inp = (stepUsage?.inputTokens as any)?.totals ?? stepUsage?.inputTokens ?? 0;
        // const out = (stepUsage?.outputTokens as any)?.totals ?? stepUsage?.outputTokens ?? 0;
        // if (inp > 0 ) tracker.updateFromAPI(inp);
        //
        const responseMessages = stepResponse!.messages as ModelMessage[];
        messages.push(...responseMessages);
        // tracker.addMessages(responseMessages);

        // totalTokens += inp + out;
        if (totalTokens > TOKEN_BUDGET * 0.9) {
            console.log(`  [Token] ${totalTokens}/${TOKEN_BUDGET} (${Math.round(totalTokens / TOKEN_BUDGET * 100)}%)`)
        }
        if (totalTokens > TOKEN_BUDGET) {
            console.log('\n[Token 预算耗尽]');
            break;
       }
        //     // fullStream： 事件流，记录每一次调用的结果，不用等整个循环跑完，可实现实时打印机的效果，    response：是Promise，等你跑完整个循环拿最终结果，如果只用response，就无法拿到中间调用工具的过程
        //     // const stepMessages = await result.response;
        //     messages.push(...stepResponse!.messages);
        //
        //     // Token 预算追踪： budget 由调用方持有，跨轮持续累计
        //     const inp = typeof stepUsage?.inputTokens === 'number' ? stepUsage.inputTokens:(stepUsage?.inputTokens as any)?.total ?? 0;
        //     const out = typeof stepUsage?.outputTokens === 'number' ? stepUsage.outputTokens:(stepUsage?.outputTokens as any)?.total ?? 0;
        //     budget.used += inp + out;
        //     const pct = Math.round(budget.used / budget.limit * 100);
        //     console.log(`[Token] ${budget.used}/${budget.limit} (${pct})`);
        //     if (budget.used > budget.limit){
        //         console.log('\n [Token 预算耗尽，强制停止]');
        //         break;
        //     }
        //

        if(!hasToolCall){
            if (fullText) console.log();
            break;
        }

        console.log('模型还在工作，继续下一步...');
    }
    if (step >= MAX_STEPS)
        console.log('\n [达到最大的步数限制，强制停止]')

}

