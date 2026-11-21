/**
 * workflow 域 Task CRUD（task.service.ts 降栈）
 */

import { getWorkflowDb, nowIso, cuid, rowToExecution } from "./db";

export interface TaskRecord {
  id: string;
  userId: string | null;
  title: string;
  spec: unknown;
  createdAt: string;
  updatedAt: string;
}

function rowToTask(row: Record<string, unknown>): TaskRecord {
  return {
    id: row.id as string,
    userId: (row.user_id as string | null) ?? null,
    title: row.title as string,
    spec: JSON.parse(row.spec as string),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function createTask(input: { title: string; spec: unknown; userId?: string }): TaskRecord & { currentExecution: unknown } {
  const db = getWorkflowDb();
  const now = nowIso();
  const id = cuid();
  db.prepare(
    "INSERT INTO tasks (id, user_id, title, spec, created_at, updated_at) VALUES (?,?,?,?,?,?)",
  ).run(id, input.userId ?? null, input.title, JSON.stringify(input.spec), now, now);
  // 原版语义：创建任务时同时创建第一条 Execution（attemptNumber=1, PENDING）
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  db.prepare(
    `INSERT INTO executions (id, task_id, job_id, status, attempt_number, progress, created_at, updated_at)
     VALUES (?, ?, ?, 'PENDING', 1, 0, ?, ?)`,
  ).run(cuid(), id, jobId, now, now);
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown>;
  const currentExecution = db.prepare("SELECT * FROM executions WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1").get(id);
  return { ...rowToTask(row), currentExecution: currentExecution ? rowToExecution(currentExecution as Record<string, unknown>) : null };
}

export function listTasks(limit = 50): TaskRecord[] {
  const rows = getWorkflowDb()
    .prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?")
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map(rowToTask);
}

export function getTask(id: string): TaskRecord | null {
  const row = getWorkflowDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToTask(row) : null;
}

export function listExecutionsByTask(taskId: string) {
  const rows = getWorkflowDb()
    .prepare("SELECT * FROM executions WHERE task_id = ? ORDER BY attempt_number DESC")
    .all(taskId) as Array<Record<string, unknown>>;
  return rows.map(rowToExecution);
}
