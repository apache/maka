/**
 * 数据库层 —— Node 24 内置 node:sqlite（零原生依赖）
 * 启动时自动备份一份 .bak
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { toCnIso } from '@ggbdpq/console-shared';
import type { ExpireRule } from '@ggbdpq/console-shared';

// 数据目录可经 CONSOLE_DATA_DIR 注入（测试隔离用），默认落在进程工作目录的 data/
const DATA_DIR = process.env.CONSOLE_DATA_DIR
  ? path.resolve(process.env.CONSOLE_DATA_DIR)
  : path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'card-admin.db');

export function getDataDir(): string {
  return DATA_DIR;
}

fs.mkdirSync(DATA_DIR, { recursive: true });

// 启动自动备份。模块在 SSG 的多个 build worker 中并发求值，同时 copy 会撞
// Windows 文件锁（EBUSY）——备份失败只跳过本次，不阻塞模块加载。
if (fs.existsSync(DB_PATH)) {
  try {
    fs.copyFileSync(DB_PATH, `${DB_PATH}.bak`);
  } catch {}
}

export const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  seq INTEGER,
  purchase_date TEXT,
  card_code TEXT,
  total_count INTEGER,
  total_price REAL,
  unit_cost REAL,
  month_group TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password TEXT,
  phone TEXT,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  account_id TEXT,
  chatgpt_user_id TEXT,
  organization_id TEXT,
  workspace_id TEXT,
  client_id TEXT,
  mailapi_url TEXT,
  platform TEXT NOT NULL DEFAULT 'chatgpt',
  status TEXT NOT NULL DEFAULT 'normal',
  quota_percent INTEGER NOT NULL DEFAULT 100,
  quota_updated_at TEXT,
  batch_id INTEGER REFERENCES batches(id),
  duplicate INTEGER NOT NULL DEFAULT 0,
  reauth_at TEXT,
  reauth_status TEXT,
  reauth_source TEXT,
  expires_at TEXT,
  created_at_src INTEGER,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quota_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  from_quota INTEGER,
  to_quota INTEGER NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
CREATE INDEX IF NOT EXISTS idx_accounts_batch ON accounts(batch_id);
CREATE INDEX IF NOT EXISTS idx_accounts_expires ON accounts(expires_at);
CREATE INDEX IF NOT EXISTS idx_status_history_account ON status_history(account_id);
`);

function ensureColumn(table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

for (const [column, definition] of [
  ['quota_source', 'quota_source TEXT'],
  ['quota_plan_type', 'quota_plan_type TEXT'],
  ['quota_used_percent', 'quota_used_percent REAL'],
  ['quota_reset_at', 'quota_reset_at TEXT'],
  ['quota_window_label', 'quota_window_label TEXT'],
  ['quota_window_seconds', 'quota_window_seconds INTEGER'],
  ['quota_limit_reached', 'quota_limit_reached INTEGER'],
  ['quota_allowed', 'quota_allowed INTEGER'],
  ['quota_subscription_active_until', 'quota_subscription_active_until TEXT'],
  ['quota_reset_credits_available', 'quota_reset_credits_available INTEGER'],
  ['quota_health', 'quota_health TEXT'],
  ['quota_error', 'quota_error TEXT'],
  ['quota_snapshot_json', 'quota_snapshot_json TEXT'],
] as const) {
  ensureColumn('accounts', column, definition);
}

const DEFAULTS: Record<string, string> = {
  expire_rule: 'month',
  warn_days: '7',
  card_root: '',
};

const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(
  'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
);

for (const [k, v] of Object.entries(DEFAULTS)) {
  if (!getSettingStmt.get(k)) setSettingStmt.run(k, v);
}

export function getSetting(key: string): string {
  const row = getSettingStmt.get(key) as { value: string } | undefined;
  return row?.value ?? DEFAULTS[key] ?? '';
}

export function setSetting(key: string, value: string): void {
  setSettingStmt.run(key, value);
}

export function getExpireRule(): ExpireRule {
  const v = getSetting('expire_rule');
  return v === '30d' || v === '28d' ? v : 'month';
}

export function nowIso(): string {
  return toCnIso(Date.now());
}
