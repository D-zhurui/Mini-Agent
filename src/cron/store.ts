import fs from 'node:fs';
import type { CronJobConfig, RunLog } from './types.js';

const JOBS_FILE = '.cron/jobs.json';
const LOGS_FILE = '.cron/logs.jsonl';

// CronStore 是一个轻量级的、基于文件系统的“数据库”，用 jobs.json 存配置、logs.jsonl 存历史，通过同步 fs
// 操作实现了对定时任务状态的持久化，确保了 Agent 在重启后依然拥有完整的任务记忆
export class CronStore {
    constructor(private baseDir: string = '.') {}

    private get jobsPath() { return `${this.baseDir}/${JOBS_FILE}`; }
    private get logsPath() { return `${this.baseDir}/${LOGS_FILE}`; }

    init(): void {
        const dir = `${this.baseDir}/.cron`;
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    loadJobs(): CronJobConfig[] {
        if (!fs.existsSync(this.jobsPath)) return [];
        try {
            const data = JSON.parse(fs.readFileSync(this.jobsPath, 'utf-8'));
            return data.jobs || [];
        } catch {
            return [];
        }
    }

    saveJobs(jobs: CronJobConfig[]): void {
        this.init();
        fs.writeFileSync(this.jobsPath, JSON.stringify({ jobs }, null, 2));
    }

    appendLog(log: RunLog): void {
        this.init();
        fs.appendFileSync(this.logsPath, JSON.stringify(log) + '\n');
    }

    getRecentLogs(jobId?: string, limit = 10): RunLog[] {
        if (!fs.existsSync(this.logsPath)) return [];
        const lines = fs.readFileSync(this.logsPath, 'utf-8')
            .split('\n')
            .filter(Boolean);

        let logs: RunLog[] = lines.map(l => {
            try { return JSON.parse(l); } catch { return null; }
        }).filter(Boolean) as RunLog[];

        if (jobId) logs = logs.filter(l => l.jobId === jobId);
        return logs.slice(-limit);
    }
}
