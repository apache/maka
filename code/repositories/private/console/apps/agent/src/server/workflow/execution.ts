/**
 * workflow 域执行状态机：execution.service.ts（453 行 NestJS）忠实降栈为 node:sqlite。
 * 九操作：claim / findByJobId / start / progress / complete / fail / heartbeat /
 * checkTimeouts / cancel / rerun。每步对齐原版的审计日志与事件发射语义。
 */

import { getWorkflowDb, nowIso, cuid, rowToExecution, type ExecutionRecord } from "./db";
import * as events from "./events";

function audit(action: string, resource: string, details: Record<string, unknown>): void {
  const db = getWorkflowDb();
  db.prepare(
    "INSERT INTO audit_logs (id, timestamp, action, resource, details) VALUES (?,?,?,?,?)",
  ).run(cuid(), nowIso(), action, resource, JSON.stringify(details));
}

function getWithTask(executionId: string): (ExecutionRecord & { taskSpec: unknown; taskTitle: string }) | null {
  const db = getWorkflowDb();
  const row = db
    .prepare(
      `SELECT e.*, t.spec AS task_spec, t.title AS task_title
       FROM executions e JOIN tasks t ON t.id = e.task_id WHERE e.id = ?`,
    )
    .get(executionId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return { ...rowToExecution(row), taskSpec: JSON.parse(row.task_spec as string), taskTitle: row.task_title as string };
}

function updateExecution(executionId: string, fields: Record<string, unknown>): ExecutionRecord {
  const db = getWorkflowDb();
  const cols = Object.keys(fields);
  const setSql = cols.map((c) => `${c} = ?`).join(", ");
  // 在共享写入口保护终态，检查与更新由同一 SQL 完成。
  const result = db.prepare(
    `UPDATE executions SET ${setSql}, updated_at = ? WHERE id = ? AND status IN ('PENDING','CLAIMED','RUNNING')`,
  ).run(
    ...cols.map((c) => fields[c] as string | number | null),
    nowIso(),
    executionId,
  );
  if (result.changes !== 1) throw new Error("执行记录不存在或已进入终态，不可变更");
  const row = db.prepare("SELECT * FROM executions WHERE id = ?").get(executionId) as Record<string, unknown>;
  return rowToExecution(row);
}

// ---------- 原子 Claim（PENDING → CLAIMED，事务保证） ----------

export function claim(input: { workerId: string; limit?: number }): {
  executions: Array<{ executionId: string; jobId: string; taskId: string; spec: unknown }>;
} {
  const { workerId, limit = 1 } = input;
  const db = getWorkflowDb();
  const claimed: Array<{ executionId: string; jobId: string; taskId: string; spec: unknown }> = [];

  // node:sqlite 无自动事务包装：BEGIN IMMEDIATE 串行化写者，保证原子性
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db
      .prepare(
        `SELECT e.id, e.job_id, e.task_id, t.spec
         FROM executions e JOIN tasks t ON t.id = e.task_id
         WHERE e.status = 'PENDING' ORDER BY e.created_at ASC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, string>>;
    for (const row of rows) {
      db.prepare(
        `UPDATE executions SET status = 'CLAIMED', worker_id = ?, claimed_at = ?, updated_at = ? WHERE id = ?`,
      ).run(workerId, nowIso(), nowIso(), row.id);
      claimed.push({ executionId: row.id, jobId: row.job_id, taskId: row.task_id, spec: JSON.parse(String(row.spec)) });
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  for (const c of claimed) {
    audit("execution.claimed", `execution:${c.jobId}`, { workerId, executionId: c.executionId });
    events.emit("execution.claimed", {
      jobId: c.jobId, taskId: c.taskId, status: "CLAIMED", progress: 0, timestamp: nowIso(),
    });
  }
  return { executions: claimed };
}

// ---------- 生命周期转换 ----------

export function findByJobId(jobId: string): ExecutionRecord | null {
  const row = getWorkflowDb().prepare("SELECT * FROM executions WHERE job_id = ?").get(jobId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToExecution(row) : null;
}

export function start(executionId: string): ExecutionRecord {
  const full = getWithTask(executionId);
  if (!full) throw new Error("执行记录不存在");
  const r = updateExecution(executionId, { status: "RUNNING", started_at: nowIso(), last_heartbeat_at: nowIso() });
  audit("execution.started", `execution:${full.jobId}`, { executionId });
  events.emit("execution.started", {
    jobId: full.jobId, taskId: full.taskId, status: "RUNNING", progress: 0, timestamp: nowIso(),
  });
  return r;
}

export function progress(executionId: string, progress: number, currentStep?: string): ExecutionRecord {
  const full = getWithTask(executionId);
  if (!full) throw new Error("执行记录不存在");
  const r = updateExecution(executionId, { progress, current_step: currentStep ?? null, last_heartbeat_at: nowIso() });
  events.emit("execution.progress", {
    jobId: full.jobId, taskId: full.taskId, status: "RUNNING", progress,
    timestamp: nowIso(), step: currentStep,
  });
  return r;
}

export function complete(executionId: string, result: unknown): ExecutionRecord {
  const full = getWithTask(executionId);
  if (!full) throw new Error("执行记录不存在");
  const r = updateExecution(executionId, {
    status: "COMPLETED", progress: 100, result: JSON.stringify(result ?? null), completed_at: nowIso(),
  });
  audit("execution.completed", `execution:${full.jobId}`, { executionId, result });
  events.emit("execution.completed", {
    jobId: full.jobId, taskId: full.taskId, status: "COMPLETED", progress: 100,
    timestamp: nowIso(), result,
  });
  return r;
}

export function fail(executionId: string, error: unknown): ExecutionRecord {
  const full = getWithTask(executionId);
  if (!full) throw new Error("执行记录不存在");
  const r = updateExecution(executionId, {
    status: "FAILED", error: JSON.stringify(error ?? null), completed_at: nowIso(),
  });
  audit("execution.failed", `execution:${full.jobId}`, { executionId, error });
  events.emit("execution.failed", {
    jobId: full.jobId, taskId: full.taskId, status: "FAILED", progress: r.progress,
    timestamp: nowIso(), error,
  });
  return r;
}

export function heartbeat(executionId: string): ExecutionRecord {
  return updateExecution(executionId, { last_heartbeat_at: nowIso() });
}

// ---------- 超时检测（CLAIMED/RUNNING 且心跳超时 → TIMEOUT） ----------

export function checkTimeouts(timeoutMs = 5 * 60 * 1000): number {
  const db = getWorkflowDb();
  const threshold = new Date(Date.now() - timeoutMs).toISOString();
  const rows = db
    .prepare(
      `SELECT * FROM executions WHERE status IN ('CLAIMED','RUNNING') AND last_heartbeat_at IS NOT NULL AND last_heartbeat_at < ?`,
    )
    .all(threshold) as Array<Record<string, unknown>>;

  for (const row of rows) {
    const rec = rowToExecution(row);
    updateExecution(rec.id, { status: "TIMEOUT", completed_at: nowIso() });
    audit("execution.timeout", `execution:${rec.jobId}`, {
      executionId: rec.id, lastHeartbeatAt: rec.lastHeartbeatAt,
    });
    events.emit("execution.failed", {
      jobId: rec.jobId, taskId: rec.taskId, status: "TIMEOUT", progress: rec.progress,
      timestamp: nowIso(), error: { message: "执行超时", lastHeartbeatAt: rec.lastHeartbeatAt },
    });
  }
  return rows.length;
}

// ---------- 取消 / 重跑 ----------

const CANCELLABLE = ["PENDING", "CLAIMED", "RUNNING"];

export function cancel(taskId: string, executionId?: string): ExecutionRecord {
  const db = getWorkflowDb();
  let row: Record<string, unknown> | undefined;
  if (executionId) {
    row = db.prepare("SELECT * FROM executions WHERE id = ?").get(executionId);
  } else {
    row = db
      .prepare(
        `SELECT * FROM executions WHERE task_id = ? AND status IN ('PENDING','CLAIMED','RUNNING')
         ORDER BY attempt_number DESC LIMIT 1`,
      )
      .get(taskId);
  }
  if (!row) throw new Error("未找到可取消的执行记录");
  const rec = rowToExecution(row);
  if (!CANCELLABLE.includes(rec.status)) {
    throw new Error(`执行状态 ${rec.status} 不可取消`);
  }
  const updated = updateExecution(rec.id, { status: "CANCELLED", completed_at: nowIso() });
  audit("execution.cancelled", `execution:${rec.jobId}`, {
    executionId: rec.id, previousStatus: rec.status,
  });
  events.emit("execution.failed", {
    jobId: rec.jobId, taskId: rec.taskId, status: "CANCELLED", progress: rec.progress,
    timestamp: nowIso(), error: { message: "用户取消执行" },
  });
  return updated;
}

export function rerun(taskId: string): ExecutionRecord {
  const db = getWorkflowDb();
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
  if (!task) throw new Error("任务不存在");
  const last = db
    .prepare("SELECT attempt_number FROM executions WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1")
    .get(taskId) as { attempt_number: number } | undefined;
  const attemptNumber = (last?.attempt_number ?? 0) + 1;
  const jobId = `job_${taskId}_${attemptNumber}_${Date.now()}`;
  const now = nowIso();
  const id = cuid();
  db.prepare(
    `INSERT INTO executions (id, task_id, job_id, status, attempt_number, progress, created_at, updated_at)
     VALUES (?, ?, ?, 'PENDING', ?, 0, ?, ?)`,
  ).run(id, taskId, jobId, attemptNumber, now, now);

  audit("execution.rerun", `execution:${jobId}`, { taskId, executionId: id, attemptNumber });
  events.emit("task.created", {
    taskId, jobId, title: task.title as string, timestamp: nowIso(), attemptNumber,
  });
  const row = db.prepare("SELECT * FROM executions WHERE id = ?").get(id) as Record<string, unknown>;
  return rowToExecution(row);
}
