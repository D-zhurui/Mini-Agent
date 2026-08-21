import { Cron } from 'croner';
import type { ScheduleType } from './types.js';

// 这段代码就像一个"时间翻译器"，把人类看得懂的定时表达（比如"每天早上9点"、"每隔30秒"）翻译成程序能执行的精确时间。
export interface ParsedSchedule {
    type: ScheduleType;
    intervalMs?: number;       // interval 类型：固定间隔毫秒数
    cronInstance?: Cron;       // cron 类型：croner 实例，负责计算下次执行时间
    onceAt?: Date;             // once 类型：一次性执行的目标时间
}

const INTERVAL_RE = /^every\s+(\d+)\s*(s|sec|m|min|h|hour)s?$/i;

export function parseSchedule(expr: string): ParsedSchedule {
    // 固定间隔："every 30s"、"every 5m"、"every 1h"
    const intervalMatch = expr.match(INTERVAL_RE);
    if (intervalMatch) {
        const value = parseInt(intervalMatch[1]);
        const unit = intervalMatch[2].toLowerCase();
        const multiplier = unit.startsWith('h') ? 3600000
            : unit.startsWith('m') ? 60000
                : 1000;
        return { type: 'interval', intervalMs: value * multiplier };
    }

    // ISO 时间戳："2026-05-11T09:00:00Z"
    if (/^\d{4}-\d{2}-\d{2}/.test(expr)) {
        const date = new Date(expr);
        if (!isNaN(date.getTime())) {
            return { type: 'once', onceAt: date };
        }
    }

    // Cron 表达式：标准五字段 "分 时 日 月 周"
    const cronInstance = new Cron(expr);
    return { type: 'cron', cronInstance };
}

// getNextCronTime 是专门给 Cron 类型的任务用的，它会问 croner 实例："离下次触发还有多少毫秒？"然后系统就用这个时间去设置定时器。
// 如果没有下次了（比如一次性任务已经过期），就默认返回 60000 毫秒作为兜底。
export function getNextCronTime(cron: Cron): number {
    return cron.msToNext() ?? 60000;
}
