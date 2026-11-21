/**
 * 定时任务调度循环 —— node-cron（6 位支持秒级）+ Quartz 表达式兼容转换。
 * 对齐 liliya 首期边界：misfire 策略与并发控制仅存储，不做补跑与并发互斥；
 * invoke_target 注册表（noop/echoParam），未注册目标执行记失败日志。
 * 全局单例挂在 globalThis 上（dev 热重载防重复调度）。
 */
import cron, { type ScheduledTask } from 'node-cron';
import { db } from '@/server/db';

export interface JobRow {
  job_id: number;
  job_name: string;
  job_group: string;
  invoke_target: string;
  cron_expression: string | null;
  status: string;
  concurrent: string | null;
  misfire_policy: string | null;
}

export const TARGETS: Record<string, (arg: string) => string> = {
  noop: () => 'noop 执行成功',
  echoParam: (arg: string) => `echo: ${arg}`,
};

/** Quartz(6~7 位，? 通配，年段) → node-cron(6 位)。非法返回 null。 */
export function normalizeQuartz(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 6 || parts.length > 7) return null;
  const [sec, min, hour, dom, mon, dow, year] = parts;
  if (year) return null; // 带年份的 Quartz 表达式不支持（裁剪声明）
  const fix = (x: string) => (x === '?' ? '*' : x);
  // Quartz 周 1-7 = SUN-SAT；node-cron 0-6 = SUN-SAT
  const fixDow = (x: string) =>
    fix(x).replace(/\d/g, (n) => String((Number(n) - 1 + 7) % 7));
  const out = [fix(sec), fix(min), fix(hour), fix(dom), fix(mon), fixDow(dow)].join(' ');
  return cron.validate(out) ? out : null;
}

interface SchedulerState {
  tasks: Map<number, ScheduledTask>;
}

const g = globalThis as typeof globalThis & { __adminScheduler?: SchedulerState };
const state = (g.__adminScheduler ??= { tasks: new Map() });

function execJob(job: JobRow, trigger: 'cron' | 'manual') {
  const started = Date.now();
  const [target, rest = ''] = job.invoke_target.split('(');
  const arg = rest.replace(/\)$/, '');
  const fn = TARGETS[target];
  const isFn = typeof fn === 'function';
  const message = isFn ? (fn as (a: string) => string)(arg) : `未注册的调用目标 ${target}`;
  db.prepare(
    "INSERT INTO sys_job_log (job_name, job_group, invoke_target, job_message, status, create_time) VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))",
  ).run(job.job_name, job.job_group, `${job.invoke_target}(${trigger})`, message, isFn ? '0' : '1');
  return { message, costMs: Date.now() - started };
}

/** 全量重载：停掉现有注册表，按 DB 里 status='0' 的任务重新注册。 */
export function reloadScheduler() {
  for (const t of state.tasks.values()) t.stop();
  state.tasks.clear();
  const jobs = db.prepare("SELECT * FROM sys_job WHERE status = '0'").all() as unknown as JobRow[];
  let registered = 0;
  for (const job of jobs) {
    const expr = normalizeQuartz(job.cron_expression ?? '');
    if (!expr) {
      db.prepare(
        "INSERT INTO sys_job_log (job_name, job_group, invoke_target, job_message, status, create_time) VALUES (?, ?, ?, ?, '1', datetime('now','localtime'))",
      ).run(job.job_name, job.job_group, job.invoke_target, `cron 表达式无法解析或不受支持：${job.cron_expression}`);
      continue;
    }
    const task = cron.schedule(expr, () => {
      const current = db.prepare('SELECT * FROM sys_job WHERE job_id = ?').get(job.job_id) as JobRow | undefined;
      if (!current || current.status !== '0') return; // 暂停/已删后不再执行
      execJob(current, 'cron');
    });
    state.tasks.set(job.job_id, task);
    registered++;
  }
  return { total: jobs.length, registered };
}

export function schedulerInfo() {
  return { running: state.tasks.size };
}

export function runJobManual(job: JobRow) {
  return execJob(job, 'manual');
}
