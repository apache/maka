/**
 * CPA 导出器：按状态/批次过滤 → 每号一个 `<email>.json` → tar 包
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { db, getDataDir } from './db';
import { toCpaRecord } from '@ggbdpq/console-shared';
import type { AccountRow, AccountStatus } from '@ggbdpq/console-shared';

const EXPORT_DIR = path.join(getDataDir(), 'exports');
export interface ExportOptions {
  batchIds?: number[];
  statuses?: AccountStatus[];
}

export interface ExportResult {
  fileName: string;
  filePath: string;
  count: number;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function selectExportAccounts(opts: ExportOptions): AccountRow[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (opts.statuses && opts.statuses.length) {
    where.push(`status IN (${opts.statuses.map(() => '?').join(',')})`);
    params.push(...opts.statuses);
  }
  if (opts.batchIds && opts.batchIds.length) {
    where.push(`batch_id IN (${opts.batchIds.map(() => '?').join(',')})`);
    params.push(...opts.batchIds);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db
    .prepare(`SELECT * FROM accounts ${whereSql} ORDER BY email ASC`)
    .all(...params) as unknown as AccountRow[];
}

export async function exportCpaTar(opts: ExportOptions): Promise<ExportResult> {
  const accounts = selectExportAccounts(opts);
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const fileName = `${accounts.length}_${stamp}.tar`;

  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-export-'));
  try {
    for (const acc of accounts) {
      const rec = toCpaRecord(acc);
      fs.writeFileSync(path.join(tmpDir, `${acc.email}.json`), JSON.stringify(rec), 'utf-8');
    }
    const filePath = path.join(EXPORT_DIR, fileName);
    await tar.c({ file: filePath, cwd: tmpDir }, fs.readdirSync(tmpDir));
    return { fileName, filePath, count: accounts.length };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
