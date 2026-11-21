/**
 * register 域数据层：只读注册库 + token 落盘文件浏览。
 * 数据由 CLI `register` 命令（@ggbdpq/register-core）写入 apps/console/data/register/，
 * 这里不 import register-core（避免把 playwright/puppeteer 拖进 Next 服务端包），
 * 表结构对齐其 src/persistence/migrations/*.sql。
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const g = globalThis as typeof globalThis & {
  __registerDb?: DatabaseSync;
  __registerDbPath?: string;
};

function registerDataDir(): string {
  return process.env.CONSOLE_DATA_DIR
    ? path.resolve(process.env.CONSOLE_DATA_DIR, "register")
    : path.resolve(process.cwd(), "data/register");
}

export function registerDbPath(): string {
  return path.join(registerDataDir(), "app.db");
}

/** 库不存在或尚未迁移（无 accounts 表，如 CLI 未跑过）时返回 null，由调用方决定空态。 */
export function getRegisterDb(): DatabaseSync | null {
  const p = registerDbPath();
  if (!fs.existsSync(p)) return null;
  if (g.__registerDb && g.__registerDbPath === p) return g.__registerDb;
  if (g.__registerDb) {
    try {
      g.__registerDb.close();
    } catch {
      // 已关闭
    }
    g.__registerDb = undefined;
  }
  const db = new DatabaseSync(p, { readOnly: true });
  const migrated = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'").get();
  if (!migrated) {
    db.close();
    return null;
  }
  g.__registerDb = db;
  g.__registerDbPath = p;
  return db;
}

export interface RegisterAccountRow {
  id: number;
  phone: string;
  fullName: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterTokenRow {
  id: number;
  email: string;
  accountId: string;
  expiredAt: string | null;
  createdAt: string;
}

export interface RegisterRunRow {
  runId: string;
  mode: string;
  status: string;
  accountPhone: string | null;
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
  phasesReached: string | null;
}

export interface RegisterOverview {
  dbExists: boolean;
  accountsTotal: number;
  accountsOauthDone: number;
  tokensTotal: number;
  runsTotal: number;
  runsSuccess: number;
  latestRunAt: string | null;
}

const row = <T,>(db: DatabaseSync, sql: string, ...params: (string | number)[]): T | null => {
  const r = db.prepare(sql).get(...params);
  return (r ?? null) as T | null;
};

const rows = <T,>(db: DatabaseSync, sql: string, ...params: (string | number)[]): T[] =>
  db.prepare(sql).all(...params) as unknown as T[];

export function listAccounts(limit = 200): RegisterAccountRow[] {
  const db = getRegisterDb();
  if (!db) return [];
  return rows<RegisterAccountRow>(
    db,
    `SELECT id, phone, full_name AS fullName, status, created_at AS createdAt, updated_at AS updatedAt
     FROM accounts ORDER BY id DESC LIMIT ?`,
    limit,
  );
}

export function listTokens(limit = 200): RegisterTokenRow[] {
  const db = getRegisterDb();
  if (!db) return [];
  return rows<RegisterTokenRow>(
    db,
    `SELECT id, email, COALESCE(account_id, '') AS accountId, expired_at AS expiredAt, created_at AS createdAt
     FROM tokens ORDER BY id DESC LIMIT ?`,
    limit,
  );
}

export function listRuns(limit = 50): RegisterRunRow[] {
  const db = getRegisterDb();
  if (!db) return [];
  return rows<RegisterRunRow>(
    db,
    `SELECT run_id AS runId, mode, status, account_phone AS accountPhone, started_at AS startedAt,
            finished_at AS finishedAt, error_message AS errorMessage, phases_reached AS phasesReached
     FROM runs ORDER BY id DESC LIMIT ?`,
    limit,
  );
}

export function getRunDetail(runId: string): (RegisterRunRow & { report: unknown }) | null {
  const db = getRegisterDb();
  if (!db) return null;
  const r = row<{
    runId: string;
    mode: string;
    status: string;
    accountPhone: string | null;
    startedAt: string;
    finishedAt: string | null;
    errorMessage: string | null;
    phasesReached: string | null;
    reportJson: string | null;
  }>(
    db,
    `SELECT run_id AS runId, mode, status, account_phone AS accountPhone, started_at AS startedAt,
            finished_at AS finishedAt, error_message AS errorMessage, phases_reached AS phasesReached,
            report_json AS reportJson
     FROM runs WHERE run_id = ?`,
    runId,
  );
  if (!r) return null;
  let report: unknown = null;
  try {
    report = r.reportJson ? (JSON.parse(r.reportJson) as unknown) : null;
  } catch {
    report = null;
  }
  const { reportJson, ...rest } = r;
  return { ...rest, report };
}

export function getOverview(): RegisterOverview {
  const db = getRegisterDb();
  if (!db) {
    return { dbExists: false, accountsTotal: 0, accountsOauthDone: 0, tokensTotal: 0, runsTotal: 0, runsSuccess: 0, latestRunAt: null };
  }
  const acc = row<{ total: number; done: number }>(
    db,
    `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'oauth_done' THEN 1 ELSE 0 END) AS done FROM accounts`,
  );
  const tok = row<{ total: number }>(db, `SELECT COUNT(*) AS total FROM tokens`);
  const run = row<{ total: number; ok: number; latest: string | null }>(
    db,
    `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS ok, MAX(started_at) AS latest FROM runs`,
  );
  return {
    dbExists: true,
    accountsTotal: acc?.total ?? 0,
    accountsOauthDone: acc?.done ?? 0,
    tokensTotal: tok?.total ?? 0,
    runsTotal: run?.total ?? 0,
    runsSuccess: run?.ok ?? 0,
    latestRunAt: run?.latest ?? null,
  };
}

/** data/register/tokens/ 下的 token 落盘 JSON（文件名即邮箱）。 */
export function listTokenFiles(): Array<{ file: string; mtime: string }> {
  const dir = path.join(registerDataDir(), "tokens");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ file: f, mtime: fs.statSync(path.join(dir, f)).mtime.toISOString() }))
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

/** 读取单个 token 落盘文件内容（basename 防目录穿越）。 */
export function readTokenFile(file: string): unknown | null {
  const name = path.basename(file);
  const p = path.join(registerDataDir(), "tokens", name);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
  } catch {
    return null;
  }
}
