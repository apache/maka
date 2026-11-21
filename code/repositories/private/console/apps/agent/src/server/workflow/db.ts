/**
 * workflow 域数据层：node:sqlite 降栈（原 Prisma/PostgreSQL schema 等价）
 * 表结构对齐 prisma schema：tasks / executions / audit_logs / api_keys
 * 数据文件：CONSOLE_DATA_DIR（测试注入）→ data/workflow.db
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const g = globalThis as typeof globalThis & {
  __workflowDb?: DatabaseSync;
  __workflowDbDir?: string;
};

export function getWorkflowDb(): DatabaseSync {
  const dataDir = process.env.CONSOLE_DATA_DIR
    ? path.resolve(process.env.CONSOLE_DATA_DIR)
    : path.resolve(process.cwd(), "data");
  // CONSOLE_DATA_DIR 变化（测试隔离）时重开连接；单例仅在同目录内复用
  if (g.__workflowDb && g.__workflowDbDir === dataDir) return g.__workflowDb;
  if (g.__workflowDb) {
    try {
      g.__workflowDb.close();
    } catch {
      // 已关闭
    }
    g.__workflowDb = undefined;
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "workflow.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  title TEXT NOT NULL,
  spec TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);

CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'PENDING',
  progress INTEGER NOT NULL DEFAULT 0,
  current_step TEXT,
  result TEXT,
  error TEXT,
  claimed_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  last_heartbeat_at TEXT,
  worker_id TEXT,
  attempt_number INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exec_task ON executions(task_id);
CREATE INDEX IF NOT EXISTS idx_exec_job ON executions(job_id);
CREATE INDEX IF NOT EXISTS idx_exec_status ON executions(status);
CREATE INDEX IF NOT EXISTS idx_exec_heartbeat ON executions(last_heartbeat_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT,
  details TEXT,
  user_id TEXT
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);
  g.__workflowDb = db;
  g.__workflowDbDir = dataDir;
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function cuid(): string {
  return randomUUID().replace(/-/g, "").slice(0, 25);
}

/** 行 → 驼峰对象（对齐 Prisma 返回形态） */
export function rowToExecution(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    jobId: row.job_id as string,
    status: row.status as string,
    progress: row.progress as number,
    currentStep: (row.current_step as string | null) ?? null,
    result: row.result ? JSON.parse(row.result as string) : null,
    error: row.error ? JSON.parse(row.error as string) : null,
    claimedAt: (row.claimed_at as string | null) ?? null,
    startedAt: (row.started_at as string | null) ?? null,
    completedAt: (row.completed_at as string | null) ?? null,
    lastHeartbeatAt: (row.last_heartbeat_at as string | null) ?? null,
    workerId: (row.worker_id as string | null) ?? null,
    attemptNumber: row.attempt_number as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export type ExecutionRecord = ReturnType<typeof rowToExecution>;
