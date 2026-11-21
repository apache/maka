/**
 * 纯函数层：JSONL 解析、批次目录名解析、报错分类、过期日计算、CPA 转换、报错日志解析
 * 不依赖 Node / DOM，可在 Vitest 中直接测试。
 */
import type {
  AccountRow,
  AccountStatus,
  CpaRecord,
  ErrorClassification,
  ExpireRule,
  RawAccount,
} from './domain';

const CN_TZ_OFFSET_MS = 8 * 60 * 60 * 1000; // 固定 +08:00

// ---------- JSONL 解析 ----------

/** 逐行尝试 JSON.parse，跳过非 JSON 行（如「卡密导出」标题行），容忍 BOM */
export function parseJsonl(text: string): RawAccount[] {
  const out: RawAccount[] = [];
  const normalized = text.replace(/^﻿/, '').trim();
  if (!normalized) return out;

  try {
    const parsed = JSON.parse(normalized) as RawAccount | RawAccount[];
    const records = Array.isArray(parsed) ? parsed : [parsed];
    for (const obj of records) {
      if (obj && typeof obj.email === 'string' && obj.email.includes('@')) {
        out.push(obj);
      }
    }
    if (out.length) return out;
  } catch {
    // 不是完整 JSON 文件时，继续按 JSONL 逐行解析
  }

  for (const rawLine of normalized.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !line.startsWith('{')) continue;
    try {
      const obj = JSON.parse(line) as RawAccount;
      if (obj && typeof obj.email === 'string' && obj.email.includes('@')) {
        out.push(obj);
      }
    } catch {
      // 跳过坏行
    }
  }
  return out;
}

/** 从记录中提取 mailapi_url（顶层 > mailbox 内 > mailbox_url） */
export function extractMailApiUrl(rec: RawAccount): string | null {
  if (typeof rec.mailapi_url === 'string' && rec.mailapi_url) return rec.mailapi_url;
  if (rec.mailbox && typeof rec.mailbox.mailapi_url === 'string' && rec.mailbox.mailapi_url)
    return rec.mailbox.mailapi_url;
  if (typeof rec.mailbox_url === 'string' && rec.mailbox_url) return rec.mailbox_url;
  return null;
}

/** 判断一条记录是否来自「重新OA授权」结果 */
export function isReauthRecord(rec: RawAccount, fileName = ''): boolean {
  if (rec.reauth_at || rec.reauth_status || rec.reauth_source) return true;
  return /oauth_success|OA授权/i.test(fileName);
}

// ---------- 批次目录名解析 ----------

export interface ParsedBatchName {
  seq: number | null;
  purchase_date: string | null;
  card_code: string | null;
  total_count: number | null;
  total_price: number | null;
  unit_cost: number | null;
}

/** 解析 `06.2026-05-13-LD260513LLET1J-65件-20.09元`，失败则全 null */
export function parseBatchFolderName(name: string): ParsedBatchName {
  const m = name.match(/^(\d+)\.(\d{4}-\d{2}-\d{2})-([A-Za-z0-9]+)-(\d+)件-([\d.]+)元/);
  if (!m) {
    return { seq: null, purchase_date: null, card_code: null, total_count: null, total_price: null, unit_cost: null };
  }
  const totalCount = parseInt(m[4], 10);
  const totalPrice = parseFloat(m[5]);
  return {
    seq: parseInt(m[1], 10),
    purchase_date: m[2],
    card_code: m[3],
    total_count: totalCount,
    total_price: totalPrice,
    unit_cost: totalCount > 0 ? Math.round((totalPrice / totalCount) * 1000) / 1000 : null,
  };
}

// ---------- 报错分类 ----------

const ERROR_RULES: Array<{ pattern: RegExp; status: AccountStatus; reason: string }> = [
  {
    pattern: /401.*Provided authentication token is expired/i,
    status: 'token_expired',
    reason: '401 token已过期',
  },
  {
    pattern: /401.*authentication token has been invalidated/i,
    status: 'creds_invalid',
    reason: '401 token已失效',
  },
  {
    pattern: /401.*Invalid or expired credentials/i,
    status: 'creds_invalid',
    reason: '401 凭据无效或过期',
  },
  {
    pattern: /402.*deactivated_workspace/i,
    status: 'deactivated_k12',
    reason: '402 工作区已停用(K12)',
  },
  {
    pattern: /429.*connector_rate_limit/i,
    status: 'rate_limited',
    reason: '429 连接器限流',
  },
];

/** 把一段报错文本归类到账号状态；无法识别返回 null */
export function classifyError(text: string): ErrorClassification | null {
  for (const rule of ERROR_RULES) {
    if (rule.pattern.test(text)) return { status: rule.status, reason: rule.reason };
  }
  return null;
}

// ---------- 过期日计算 ----------

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** epoch 秒/ms → +08:00 ISO 字符串（秒级） */
export function toCnIso(input: number | string | Date): string {
  let ms: number;
  if (typeof input === 'number') ms = input < 1e12 ? input * 1000 : input;
  else if (input instanceof Date) ms = input.getTime();
  else {
    const t = Date.parse(input);
    if (Number.isNaN(t)) throw new Error(`无法解析时间: ${input}`);
    ms = t;
  }
  const d = new Date(ms + CN_TZ_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+08:00`;
}

/** +08:00 当日零点的 Date（UTC 表示） */
function cnMidnight(ms: number): Date {
  const shifted = new Date(ms + CN_TZ_OFFSET_MS);
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - CN_TZ_OFFSET_MS,
  );
}

/**
 * 过期日 = 基准时间 + 规则（自然月+1 / 30天 / 28天），时区 +08:00。
 * 自然月：按 +08:00 日历日加一个月，日期溢出时钳制到月末（如 1/31 → 2/28）。
 * 基准可以是 ISO 字符串或 epoch（秒/毫秒）。
 */
export function computeExpiry(base: string | number, rule: ExpireRule = 'month'): string {
  let baseMs: number;
  if (typeof base === 'number') {
    baseMs = base < 1e12 ? base * 1000 : base;
  } else {
    baseMs = Date.parse(base);
  }
  if (Number.isNaN(baseMs)) throw new Error(`无法解析基准时间: ${base}`);
  if (rule === 'month') {
    const shifted = new Date(baseMs + CN_TZ_OFFSET_MS);
    const y = shifted.getUTCFullYear();
    const mo = shifted.getUTCMonth();
    const targetMonth = mo + 1;
    const ty = y + Math.floor(targetMonth / 12);
    const tm = targetMonth % 12;
    const daysInTarget = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
    const day = Math.min(shifted.getUTCDate(), daysInTarget);
    const resultMs =
      Date.UTC(ty, tm, day, shifted.getUTCHours(), shifted.getUTCMinutes(), shifted.getUTCSeconds()) -
      CN_TZ_OFFSET_MS;
    return toCnIso(resultMs);
  }
  const days = rule === '30d' ? 30 : 28;
  return toCnIso(baseMs + days * 24 * 60 * 60 * 1000);
}

/** 距离过期的剩余天数（按 +08:00 自然日），已过期返回负数 */
export function daysUntilExpiry(expiresIso: string, nowMs = Date.now()): number {
  const expMs = Date.parse(expiresIso);
  if (Number.isNaN(expMs)) return 0;
  const a = cnMidnight(nowMs).getTime();
  const b = cnMidnight(expMs).getTime();
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

// ---------- JWT ----------

/** 解码 JWT payload 的 exp（秒），失败返回 null */
export function decodeJwtExp(token: string | null | undefined): number | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    // atob + TextDecoder：Node 16+ 与浏览器通用，避免引入 Node Buffer 依赖
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    const bytes = Uint8Array.from(atob(b64 + pad), (c) => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

// ---------- CPA 转换 ----------

const DISABLED_STATUSES: AccountStatus[] = ['quota_exhausted', 'token_expired', 'creds_invalid'];

/**
 * 账号 → CPA 单文件记录。
 * expired 取 access_token 的 JWT exp（+08:00 ISO）；disabled 依状态诚实标记。
 */
export function toCpaRecord(acc: AccountRow, nowMs = Date.now()): CpaRecord {
  const expSec = decodeJwtExp(acc.access_token);
  return {
    type: 'codex',
    email: acc.email,
    expired: expSec ? toCnIso(expSec) : acc.expires_at ?? toCnIso(nowMs),
    id_token: acc.id_token,
    account_id: acc.account_id,
    disabled: DISABLED_STATUSES.includes(acc.status),
    access_token: acc.access_token,
    last_refresh: toCnIso(nowMs),
    refresh_token: acc.refresh_token,
  };
}

// ---------- 报错日志解析（双模） ----------

export interface ParsedErrorLine {
  email: string | null;
  errorText: string;
  classification: ErrorClassification | null;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** 逐行解析粘贴的日志：有邮箱的行归属账号，否则 email=null（配合勾选账号的批量模式） */
export function parseErrorLog(text: string): ParsedErrorLine[] {
  const out: ParsedErrorLine[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const emailMatch = line.match(EMAIL_RE);
    const classification = classifyError(line);
    if (!emailMatch && !classification) continue; // 噪声行
    out.push({
      email: emailMatch ? emailMatch[0].toLowerCase() : null,
      errorText: line,
      classification,
    });
  }
  return out;
}
