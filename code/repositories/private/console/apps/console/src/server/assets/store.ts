/**
 * 业务操作层：批次/账号的入库、授权合并、报错应用、额度与状态变更
 */
import { db, getExpireRule, nowIso } from './db';
import {
  computeExpiry,
  extractMailApiUrl,
  parseBatchFolderName,
  toCnIso,
} from '@ggbdpq/console-shared';
import type { AccountRow, AccountStatus, BatchRow, RawAccount } from '@ggbdpq/console-shared';
import type { NormalizedQuotaSnapshot } from './quota';

// ---------- 批次 ----------

export function upsertBatch(dirPath: string, folderName: string, monthGroup: string | null): number {
  const parsed = parseBatchFolderName(folderName);
  const existing = db.prepare('SELECT id FROM batches WHERE path = ?').get(dirPath) as
    | { id: number }
    | undefined;
  if (existing) {
    db.prepare(
      `UPDATE batches SET folder_name=?, seq=?, purchase_date=?, card_code=?, total_count=?, total_price=?, unit_cost=?, month_group=? WHERE id=?`,
    ).run(
      folderName,
      parsed.seq,
      parsed.purchase_date,
      parsed.card_code,
      parsed.total_count,
      parsed.total_price,
      parsed.unit_cost,
      monthGroup,
      existing.id,
    );
    return existing.id;
  }
  const r = db
    .prepare(
      `INSERT INTO batches(folder_name, path, seq, purchase_date, card_code, total_count, total_price, unit_cost, month_group, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      folderName,
      dirPath,
      parsed.seq,
      parsed.purchase_date,
      parsed.card_code,
      parsed.total_count,
      parsed.total_price,
      parsed.unit_cost,
      monthGroup,
      nowIso(),
    );
  return Number(r.lastInsertRowid);
}

export function listBatches(): Array<BatchRow & { alive: number; total: number }> {
  return db
    .prepare(
      `SELECT b.*, COUNT(a.id) AS total,
              SUM(CASE WHEN a.status NOT IN ('deactivated_k12') THEN 1 ELSE 0 END) AS alive
       FROM batches b LEFT JOIN accounts a ON a.batch_id = b.id
       GROUP BY b.id ORDER BY b.purchase_date DESC, b.seq DESC`,
    )
    .all() as unknown as Array<BatchRow & { alive: number; total: number }>;
}

// ---------- 账号 ----------

function findAccount(email: string): AccountRow | undefined {
  return db.prepare('SELECT * FROM accounts WHERE email = ?').get(email.toLowerCase()) as
    | AccountRow
    | undefined;
}

export function getAccount(id: number): AccountRow | undefined {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;
}

export function clearScannedData(): void {
  db.exec(`
    DELETE FROM quota_history;
    DELETE FROM status_history;
    DELETE FROM accounts;
    DELETE FROM batches;
  `);
}

export function deleteAccounts(ids: number[]): number {
  const uniqueIds = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  if (uniqueIds.length === 0) return 0;
  const placeholders = uniqueIds.map(() => '?').join(',');
  db.prepare(`DELETE FROM quota_history WHERE account_id IN (${placeholders})`).run(...uniqueIds);
  db.prepare(`DELETE FROM status_history WHERE account_id IN (${placeholders})`).run(...uniqueIds);
  const result = db.prepare(`DELETE FROM accounts WHERE id IN (${placeholders})`).run(...uniqueIds);
  refreshDuplicates();
  return Number(result.changes);
}

function recordStatusChange(accountId: number, from: string | null, to: string, reason: string) {
  db.prepare(
    'INSERT INTO status_history(account_id, from_status, to_status, reason, created_at) VALUES(?,?,?,?,?)',
  ).run(accountId, from, to, reason, nowIso());
}

function recordQuotaChange(accountId: number, from: number | null, to: number, reason: string) {
  db.prepare(
    'INSERT INTO quota_history(account_id, from_quota, to_quota, reason, created_at) VALUES(?,?,?,?,?)',
  ).run(accountId, from, to, reason, nowIso());
}

function importedExpiry(rec: RawAccount): string | null {
  if (typeof rec.expired === 'string' && rec.expired.trim()) return rec.expired;
  if (typeof rec.expired === 'number') return toCnIso(rec.expired);
  if (rec.created_at) return computeExpiry(new Date(rec.created_at * 1000).toISOString(), getExpireRule());
  return null;
}

/** 导入原始卡密记录：新建或补充；返回统计 */
export function importOriginal(records: RawAccount[], batchId: number | null) {
  let created = 0;
  let updated = 0;
  const now = nowIso();
  for (const rec of records) {
    const email = rec.email.toLowerCase();
    const existing = findAccount(email);
    const mailapi = extractMailApiUrl(rec);
    if (!existing) {
      const expiresAt = importedExpiry(rec);
      const r = db
        .prepare(
          `INSERT INTO accounts(email, password, phone, access_token, refresh_token, id_token,
             account_id, chatgpt_user_id, organization_id, workspace_id, client_id, mailapi_url,
             platform, status, quota_percent, batch_id, expires_at, created_at_src, first_seen_at, updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          email,
          rec.password ?? null,
          rec.phone ?? null,
          rec.access_token ?? null,
          rec.refresh_token ?? null,
          rec.id_token ?? null,
          rec.account_id ?? rec.chatgpt_account_id ?? null,
          rec.chatgpt_user_id ?? null,
          rec.organization_id ?? null,
          rec.workspace_id ?? null,
          rec.client_id ?? null,
          mailapi,
          rec.platform ?? 'chatgpt',
          'normal',
          100,
          batchId,
          expiresAt,
          rec.created_at ?? null,
          now,
          now,
        );
      recordStatusChange(Number(r.lastInsertRowid), null, 'normal', '原始导入');
      created++;
    } else {
      // 已有账号：补充缺失字段，不覆盖新 token；当从批次目录扫描到同邮箱时，以该购买批次归属为准。
      const nextBatchId = batchId ?? existing.batch_id;
      const dup = existing.batch_id && batchId && existing.batch_id !== batchId ? 1 : existing.duplicate;
      db.prepare(
        `UPDATE accounts SET
           password = COALESCE(accounts.password, ?),
           phone = COALESCE(accounts.phone, ?),
           access_token = COALESCE(accounts.access_token, ?),
           refresh_token = COALESCE(accounts.refresh_token, ?),
           id_token = COALESCE(accounts.id_token, ?),
           account_id = COALESCE(accounts.account_id, ?),
           mailapi_url = COALESCE(accounts.mailapi_url, ?),
           batch_id = ?,
           duplicate = ?,
           updated_at = ?
         WHERE id = ?`,
      ).run(
        rec.password ?? null,
        rec.phone ?? null,
        rec.access_token ?? null,
        rec.refresh_token ?? null,
        rec.id_token ?? null,
        rec.account_id ?? rec.chatgpt_account_id ?? null,
        mailapi,
        nextBatchId,
        dup,
        now,
        existing.id,
      );
      updated++;
    }
  }
  refreshDuplicates();
  return { created, updated };
}

/** 导入重新OA授权结果：按 email 匹配，更新 token、reauth_at、过期日，状态归位 normal */
export function importReauth(records: RawAccount[]) {
  let applied = 0;
    const unmatched: string[] = [];
  const now = nowIso();
  for (const rec of records) {
    const email = rec.email.toLowerCase();
    const existing = findAccount(email);
    if (!existing) {
      unmatched.push(email);
      continue;
    }
    // reauth_at 可能是 ISO 字符串，也可能是 epoch 秒/毫秒（部分授权工具输出时间戳）
    const reauthAt =
      rec.reauth_at != null
        ? typeof rec.reauth_at === 'number'
          ? toCnIso(rec.reauth_at)
          : String(rec.reauth_at)
        : now;
    const expiresAt = computeExpiry(reauthAt, getExpireRule());
    db.prepare(
      `UPDATE accounts SET access_token=?, refresh_token=?, id_token=?,
         account_id=COALESCE(?, account_id),
         mailapi_url=COALESCE(?, mailapi_url),
         reauth_at=?, reauth_status=?, reauth_source=?, expires_at=?,
         status=?, quota_percent=100, quota_updated_at=?,
         quota_source=NULL, quota_plan_type=NULL, quota_used_percent=NULL, quota_reset_at=NULL,
         quota_window_label=NULL, quota_window_seconds=NULL, quota_limit_reached=NULL, quota_allowed=NULL,
         quota_subscription_active_until=NULL, quota_reset_credits_available=NULL, quota_health=NULL,
         quota_error=NULL, quota_snapshot_json=NULL,
         updated_at=?
       WHERE id=?`,
    ).run(
      rec.access_token ?? existing.access_token,
      rec.refresh_token ?? existing.refresh_token,
      rec.id_token ?? existing.id_token,
      rec.account_id ?? rec.chatgpt_account_id ?? null,
      extractMailApiUrl(rec),
      reauthAt,
      rec.reauth_status ?? 'success',
      rec.reauth_source ?? 'oa',
      expiresAt,
      'normal',
      now,
      now,
      existing.id,
    );
    if (existing.status !== 'normal') {
      recordStatusChange(existing.id, existing.status, 'normal', '重新OA授权');
    }
    applied++;
  }
  return { applied, unmatched };
}

/** 应用一条报错到指定账号 */
export function applyError(email: string, status: AccountStatus, reason: string): boolean {
  const acc = findAccount(email);
  if (!acc) return false;
  const now = nowIso();
  db.prepare('UPDATE accounts SET status=?, updated_at=? WHERE id=?').run(status, now, acc.id);
  if (acc.status !== status) recordStatusChange(acc.id, acc.status, status, reason);
  return true;
}

/** 设置额度；归零自动联动状态 */
export function setQuota(id: number, quota: number, reason = '手动设置') {
  const acc = getAccount(id);
  if (!acc) return null;
  const q = Math.max(0, Math.min(100, Math.round(quota)));
  const now = nowIso();
  let status = acc.status;
  if (q === 0 && acc.status === 'normal') status = 'quota_exhausted';
  if (q > 0 && acc.status === 'quota_exhausted') status = 'normal';
  db.prepare('UPDATE accounts SET quota_percent=?, quota_updated_at=?, status=?, updated_at=? WHERE id=?').run(
    q,
    now,
    status,
    now,
    id,
  );
  if (q !== acc.quota_percent) recordQuotaChange(id, acc.quota_percent, q, reason);
  if (status !== acc.status) {
    recordStatusChange(id, acc.status, status, q === 0 ? '额度归零' : '额度恢复');
  }
  return getAccount(id);
}

/** 保存 OpenAI/ChatGPT 真实额度快照；quota_percent 表示当前最紧额度窗口的可用百分比。 */
export function applyQuotaSnapshot(id: number, snapshot: NormalizedQuotaSnapshot) {
  const acc = getAccount(id);
  if (!acc) return null;
  const q = Math.max(0, Math.min(100, Math.round(snapshot.quotaPercent)));
  const now = nowIso();
  let status = acc.status;
  if (acc.status !== 'deactivated_k12') {
    if (snapshot.health === 'quota_exhausted') status = 'quota_exhausted';
    else if (acc.status === 'quota_exhausted' && q > 0) status = 'normal';
  }

  db.prepare(
    `UPDATE accounts SET
       quota_percent=?,
       quota_updated_at=?,
       quota_source=?,
       quota_plan_type=?,
       quota_used_percent=?,
       quota_reset_at=?,
       quota_window_label=?,
       quota_window_seconds=?,
       quota_limit_reached=?,
       quota_allowed=?,
       quota_subscription_active_until=?,
       quota_reset_credits_available=?,
       quota_health=?,
       quota_error=NULL,
       quota_snapshot_json=?,
       status=?,
       updated_at=?
     WHERE id=?`,
  ).run(
    q,
    now,
    snapshot.source,
    snapshot.planType,
    snapshot.usedPercent,
    snapshot.resetAt,
    snapshot.windowLabel,
    snapshot.windowSeconds,
    snapshot.limitReached ? 1 : 0,
    snapshot.allowed == null ? null : snapshot.allowed ? 1 : 0,
    snapshot.subscriptionActiveUntil,
    snapshot.resetCreditsAvailable,
    snapshot.health,
    JSON.stringify(snapshot),
    status,
    now,
    id,
  );
  if (q !== acc.quota_percent) {
    recordQuotaChange(id, acc.quota_percent, q, `OpenAI真实额度刷新${snapshot.windowLabel ? `：${snapshot.windowLabel}` : ''}`);
  }
  if (status !== acc.status) {
    recordStatusChange(id, acc.status, status, snapshot.health === 'quota_exhausted' ? 'OpenAI额度耗尽' : 'OpenAI额度恢复');
  }
  return getAccount(id);
}

/** 记录真实额度刷新失败，便于前端显示接口健康度，而不是继续相信旧额度。 */
export function applyQuotaRefreshError(id: number, message: string, upstreamStatus?: number) {
  const acc = getAccount(id);
  if (!acc) return null;
  const now = nowIso();
  let status = acc.status;
  if (upstreamStatus === 401 && acc.status !== 'deactivated_k12') status = 'token_expired';
  const health = upstreamStatus === 401 || upstreamStatus === 403 ? 'auth_error' : 'unknown';
  db.prepare(
    `UPDATE accounts SET
       quota_updated_at=?,
       quota_health=?,
       quota_error=?,
       status=?,
       updated_at=?
     WHERE id=?`,
  ).run(now, health, message.slice(0, 1000), status, now, id);
  if (status !== acc.status) {
    recordStatusChange(id, acc.status, status, 'OpenAI额度接口鉴权失败');
  }
  return getAccount(id);
}

/** 手动改状态 */
export function setStatus(id: number, status: AccountStatus, reason = '手动标记') {
  const acc = getAccount(id);
  if (!acc) return null;
  db.prepare('UPDATE accounts SET status=?, updated_at=? WHERE id=?').run(status, nowIso(), id);
  if (acc.status !== status) recordStatusChange(id, acc.status, status, reason);
  return getAccount(id);
}

// ---------- 查询 ----------

export interface AccountFilter {
  batchId?: number;
  status?: string;
  email?: string;
  expiringWithinDays?: number;
  limit?: number;
  offset?: number;
}

export function queryAccounts(f: AccountFilter): { rows: AccountRow[]; total: number } {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (f.batchId) {
    where.push('batch_id = ?');
    params.push(f.batchId);
  }
  if (f.status) {
    where.push('status = ?');
    params.push(f.status);
  }
  if (f.email) {
    where.push('email LIKE ?');
    params.push(`%${f.email.toLowerCase()}%`);
  }
  if (f.expiringWithinDays !== undefined) {
    where.push(`expires_at IS NOT NULL AND date(expires_at) <= date('now', '+8 hours', '+' || ? || ' days')`);
    params.push(f.expiringWithinDays);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM accounts ${whereSql}`).get(...params) as { c: number }
  ).c;
  const rows = db
    .prepare(
      `SELECT * FROM accounts ${whereSql} ORDER BY expires_at IS NULL, expires_at ASC LIMIT ? OFFSET ?`,
    )
    .all(...params, f.limit ?? 500, f.offset ?? 0) as unknown as AccountRow[];
  return { rows, total };
}

export function overview(warnDays: number) {
  const byStatus = db
    .prepare('SELECT status, COUNT(*) AS c FROM accounts GROUP BY status')
    .all() as Array<{ status: string; c: number }>;
  const expiring = db
    .prepare(
      `SELECT id, email, status, expires_at, reauth_at FROM accounts
       WHERE expires_at IS NOT NULL AND status != 'deactivated_k12'
         AND date(expires_at) <= date('now', '+8 hours', '+' || ? || ' days')
       ORDER BY expires_at ASC LIMIT 50`,
    )
    .all(warnDays);
  const recentReauth = db
    .prepare(
      `SELECT id, email, reauth_at, expires_at FROM accounts
       WHERE reauth_at IS NOT NULL ORDER BY reauth_at DESC LIMIT 20`,
    )
    .all();
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status != 'deactivated_k12' THEN 1 ELSE 0 END) AS alive
       FROM accounts`,
    )
    .get() as { total: number; alive: number };
  return { byStatus, expiring, recentReauth, ...totals };
}

export function accountHistory(id: number) {
  const status = db
    .prepare('SELECT * FROM status_history WHERE account_id=? ORDER BY id DESC LIMIT 100')
    .all(id);
  const quota = db
    .prepare('SELECT * FROM quota_history WHERE account_id=? ORDER BY id DESC LIMIT 100')
    .all(id);
  return { status, quota };
}

/** 跨批次重复 email 标记 */
export function refreshDuplicates() {
  db.exec(`
    UPDATE accounts SET duplicate = 0;
    UPDATE accounts SET duplicate = 1
    WHERE email IN (SELECT email FROM accounts GROUP BY email HAVING COUNT(DISTINCT batch_id) > 1);
  `);
}
