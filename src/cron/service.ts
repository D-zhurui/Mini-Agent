import type { CronJobConfig, CronJobState, RunLog, JobPayload } from './types.js';
import { parseSchedule, getNextCronTime } from './parser.js';
import { CronStore } from './store.js';

const QUOTES = [
    '\u201C知之为知之，不知为不知，是知也。\u201D \u2014\u2014 孔子',
    '\u201C学而不思则罔，思而不学则殆。\u201D \u2014\u2014 孔子',
    '\u201C千里之行，始于足下。\u201D \u2014\u2014 老子',
    '\u201C天行健，君子以自强不息。\u201D \u2014\u2014 《周易》',
    '\u201C不积跬步，无以至千里。\u201D \u2014\u2014 荀子',
    '\u201CStay hungry, stay foolish.\u201D \u2014\u2014 Steve Jobs',
    '\u201CThe best way to predict the future is to invent it.\u201D \u2014\u2014 Alan Kay',
    '\u201CTalk is cheap. Show me the code.\u201D \u2014\u2014 Linus Torvalds',
    '\u201CSimplicity is the ultimate sophistication.\u201D \u2014\u2014 Leonardo da Vinci',
    '\u201CFirst, solve the problem. Then, write the code.\u201D \u2014\u2014 John Johnson',
];

export interface CronExecutor {
    runAgentPrompt: (prompt: string, timeout?: number) => Promise<string>;
    notify?: (message: string) => void;
}

export class CronService {
    private jobs = new Map<string, CronJobState>();
    private store: CronStore;
    private executor?: CronExecutor;
    private running = false;

    constructor(baseDir = '.') {
        this.store = new CronStore(baseDir);
        this.store.init();
    }

    setExecutor(executor: CronExecutor): void {
        this.executor = executor;
    }

    load(): void {
        const configs = this.store.loadJobs();
        for (const config of configs) {
            if (config.enabled) {
                this.jobs.set(config.id, {
                    config, timerId: null, consecutiveFailures: 0, running: false,
                });
            }
        }
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        for (const state of this.jobs.values()) {
            if (state.config.enabled) this.scheduleJob(state);
        }
    }

    stop(): void {
        this.running = false;
        for (const state of this.jobs.values()) {
            if (state.timerId) { clearTimeout(state.timerId); state.timerId = null; }
        }
    }

    add(config: CronJobConfig): void {
        if (this.jobs.has(config.id)) throw new Error(`任务 ${config.id} 已存在`);
        const state: CronJobState = { config, timerId: null, consecutiveFailures: 0, running: false };
        this.jobs.set(config.id, state);
        this.persist();
        if (this.running && config.enabled) this.scheduleJob(state);
    }

    remove(id: string): boolean {
        const state = this.jobs.get(id);
        if (!state) return false;
        if (state.timerId) clearTimeout(state.timerId);
        this.jobs.delete(id);
        this.persist();
        return true;
    }

    enable(id: string): boolean {
        const state = this.jobs.get(id);
        if (!state) return false;
        state.config.enabled = true;
        state.consecutiveFailures = 0;
        this.persist();
        if (this.running) this.scheduleJob(state);
        return true;
    }

    disable(id: string): boolean {
        const state = this.jobs.get(id);
        if (!state) return false;
        state.config.enabled = false;
        if (state.timerId) { clearTimeout(state.timerId); state.timerId = null; }
        this.persist();
        return true;
    }

    list(): Array<{ config: CronJobConfig; status: string; lastRun?: RunLog }> {
        return Array.from(this.jobs.values()).map(state => ({
            config: state.config,
            status: state.running ? 'running'
                : !state.config.enabled ? 'disabled'
                    : state.timerId ? 'scheduled' : 'idle',
            lastRun: state.lastRun,
        }));
    }

    async runNow(id: string): Promise<string> {
        const state = this.jobs.get(id);
        if (!state) return `任务 ${id} 不存在`;
        return this.executeJob(state);
    }

    getRecentLogs(jobId?: string, limit?: number): RunLog[] {
        return this.store.getRecentLogs(jobId, limit);
    }

    // 递归调度， 是一个调度引擎的"定时重连"逻辑。简单说就是：每次任务执行完后，如果任务还没失效，就自动计算下一次执行时间，重新预约自己。
    private scheduleJob(state: CronJobState): void {
        // 如果这个任务之前已经设了一个 setTimeout（存在 timerId），就先 clearTimeout 清掉它。
        if (state.timerId) { clearTimeout(state.timerId); state.timerId = null; }
        try {
            const parsed = parseSchedule(state.config.schedule);
            let delayMs: number;
            // "翻译调度表达式，算出要等多久"
            switch (parsed.type) {
                case 'interval': delayMs = parsed.intervalMs!; break;
                case 'once': {
                    const diff = parsed.onceAt!.getTime() - Date.now();
                    if (diff <= 0) { this.executeJob(state); return; }
                    delayMs = diff; break;
                }
                case 'cron': delayMs = getNextCronTime(parsed.cronInstance!); break;
            }
            /* 第三段是"设闹钟，闹钟响了干活，干完活看要不要再设一个"。
             setTimeout 的核心回调里有三步：
             await this.executeJob(state) — 到点了，真干活（跑 Agent prompt）。
             如果不是一次性任务，且任务还启用着、整个 Service 还在跑，就递归调用 this.scheduleJob(state) — 自己再预约自己，形成循环。
             如果是一次性任务，直接调用 this.remove(state.config.id) 把自己删了。*/
            // state.timerId你可以把它理解成"定时器的遥控器"，拿着它才能控制这个定时任务什么时候该等、什么时候该停。
            state.timerId = setTimeout(async () => {
                await this.executeJob(state);
                if (parsed.type !== 'once' && state.config.enabled && this.running) {
                    this.scheduleJob(state);
                } else if (parsed.type === 'once') { this.remove(state.config.id); }
            }, delayMs);
        } catch (err: any) {
            console.log(`  [cron] ✗ 调度失败 ${state.config.id}: ${err.message}`);
        }
    }

    // 这段代码就是任务执行器的安全外壳——它确保同一时间只有一个任务在跑，跑完自动记录日志，连续失败太多还会自己关掉开关。
    private async executeJob(state: CronJobState): Promise<string> {
        if (state.running) return '任务正在执行中';
        state.running = true;
        const startedAt = new Date().toISOString();
        let output = ''; let status: RunLog['status'] = 'success'; let error: string | undefined;
        try {
            const timeout = state.config.timeout || 60000;
            output = await this.runPayload(state.config.payload, timeout);
            state.consecutiveFailures = 0;
        } catch (err: any) {
            status = err.message?.includes('timeout') ? 'timeout' : 'error';
            error = err.message; output = `执行失败: ${err.message}`;
            state.consecutiveFailures++;
            const maxRetries = state.config.maxRetries ?? 3;
            if (state.consecutiveFailures >= maxRetries) {
                state.config.enabled = false;
                console.log(`  [cron] ✗ ${state.config.id} 连续失败 ${maxRetries} 次，已自动禁用`);
                this.persist();
            }
        } finally { state.running = false; }

        const log: RunLog = { jobId: state.config.id, startedAt, finishedAt: new Date().toISOString(), status, output: output.slice(0, 1000), error };
        state.lastRun = log;
        this.store.appendLog(log);
        if (this.executor?.notify) {
            const icon = status === 'success' ? '✓' : '✗';
            this.executor.notify(`[cron] ${icon} ${state.config.name}: ${output.slice(0, 200)}`);
        }
        return output;
    }

    private async runPayload(payload: JobPayload, timeout: number): Promise<string> {
        if (!this.executor) return '[cron] 未设置执行器，无法运行任务';
        if (payload.type === 'agent') {
            return this.executor.runAgentPrompt(payload.prompt, timeout);
        }
        if (payload.type === 'handler') {
            if (payload.handler === 'random-quote') {
                return QUOTES[Math.floor(Math.random() * QUOTES.length)];
            }
            return `[handler] ${payload.handler} — handler 类型需要通过插件注册`;
        }
        return '未知 payload 类型';
    }

    // 这段代码的作用是保存运行时动态创建的任务，让它们即使进程重启也不会丢失。
    private persist(): void {
        const configs = Array.from(this.jobs.values())
            .filter(s => s.config.source === 'runtime').map(s => s.config);
        const existing = this.store.loadJobs().filter(j => j.source === 'config');
        this.store.saveJobs([...existing, ...configs]);
    }
}