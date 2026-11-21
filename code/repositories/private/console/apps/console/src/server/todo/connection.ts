/**
 * todo 域运行时装配：SQLite 连接 + LLM 客户端 + 确认注册表。
 * 单例挂 globalThis 对冲 dev 热重载；测试直接 new/close，不走这里。
 */

import path from "node:path";
import { EnvSchema } from "@ggbdpq/console-shared/todo";
import { openDatabase, type Db } from "./db/database";
import { createDeepSeekClient, type LlmClient } from "./agent/llm";
import { ApprovalRegistry } from "./agent/approvals";

const g = globalThis as typeof globalThis & {
  __todoDb?: Db;
  __todoDbPath?: string;
  __todoLlm?: LlmClient;
  __todoApprovals?: ApprovalRegistry;
};

export function todoDbPath(): string {
  return process.env.CONSOLE_DATA_DIR
    ? path.resolve(process.env.CONSOLE_DATA_DIR, "todo.db")
    : path.resolve(process.cwd(), "data/todo.db");
}

export function getTodoDb(): Db {
  const p = todoDbPath();
  if (g.__todoDb && g.__todoDbPath === p) return g.__todoDb;
  if (g.__todoDb) {
    try {
      g.__todoDb.close();
    } catch {
      // 已关闭
    }
  }
  const db = openDatabase(p);
  g.__todoDb = db;
  g.__todoDbPath = p;
  return db;
}

export function getTodoLlm(): LlmClient {
  if (g.__todoLlm) return g.__todoLlm;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`todo 域环境变量校验失败：${missing}（请在 apps/console/.env.local 配置 DEEPSEEK_API_KEY）`);
  }
  g.__todoLlm = createDeepSeekClient(parsed.data);
  return g.__todoLlm;
}

export function getTodoApprovals(): ApprovalRegistry {
  g.__todoApprovals ??= new ApprovalRegistry();
  return g.__todoApprovals;
}

export interface TodoDeps {
  db: Db;
  llm: LlmClient;
  approvals: ApprovalRegistry;
}

export function getTodoDeps(): TodoDeps {
  return { db: getTodoDb(), llm: getTodoLlm(), approvals: getTodoApprovals() };
}
