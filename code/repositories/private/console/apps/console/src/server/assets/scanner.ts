/**
 * 目录扫描器：遍历卡密管理目录树，识别批次目录与其中的原始/授权文件
 * 严格只读，永不修改原始文件。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isReauthRecord, parseJsonl } from '@ggbdpq/console-shared';
import { importOriginal, importReauth, upsertBatch } from './store';
import { getSetting } from './db';

export function defaultCardRoot(): string {
  // 默认以购买批次目录为准，才能保留邮箱属于哪一批卡密。
  return path.normalize('E:\\开发文档\\06-卡密管理');
}

export function cliProxyCardRoot(): string {
  return path.join(os.homedir(), 'CLIProxyAPI', '.cli-proxy-api');
}

export function getCardRoot(): string {
  return getSetting('card_root') || defaultCardRoot();
}

const BATCH_NAME_RE = /^\d+\.\d{4}-\d{2}-\d{2}-.+-(\d+)件-([\d.]+)元/;
const DATA_FILE_RE = /\.(txt|json|jsonl)$/i;

export interface ScanResult {
  batchesFound: number;
  filesRead: number;
  original: { created: number; updated: number };
  reauth: { applied: number; unmatched: string[] };
  errors: string[];
}

function readText(fp: string): string {
  return fs.readFileSync(fp, 'utf-8').replace(/^﻿/, '');
}

/** 扫描一个批次目录（含子目录），返回文件中的两类记录 */
function scanBatchDir(dir: string, errors: string[]) {
  const originals: ReturnType<typeof parseJsonl> = [];
  const reauths: ReturnType<typeof parseJsonl> = [];
  let filesRead = 0;

  const walk = (d: string, depth: number) => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === '_导入收件箱') continue;
        walk(fp, depth + 1);
      } else if (DATA_FILE_RE.test(e.name) && !e.name.endsWith('.tar')) {
        try {
          const records = parseJsonl(readText(fp));
          if (records.length === 0) continue;
          filesRead++;
          // 文件名或记录特征判断是否为授权结果
          const reauthRecs = records.filter((r) => isReauthRecord(r, e.name));
          const originalRecs = records.filter((r) => !isReauthRecord(r, e.name));
          originals.push(...originalRecs);
          reauths.push(...reauthRecs);
        } catch (err) {
          errors.push(`${fp}: ${String(err)}`);
        }
      }
    }
  };
  walk(dir, 0);
  return { originals, reauths, filesRead };
}

/** 全量扫描卡密根目录 */
export function scanCardRoot(root = getCardRoot()): ScanResult {
  const result: ScanResult = {
    batchesFound: 0,
    filesRead: 0,
    original: { created: 0, updated: 0 },
    reauth: { applied: 0, unmatched: [] },
    errors: [],
  };
  if (!fs.existsSync(root)) {
    result.errors.push(`卡密根目录不存在: ${root}`);
    return result;
  }

  interface BatchDir {
    dir: string;
    name: string;
    monthGroup: string | null;
  }
  const batchDirs: BatchDir[] = [];
  const looseOriginals: ReturnType<typeof parseJsonl> = [];
  const looseReauths: ReturnType<typeof parseJsonl> = [];

  const walk = (d: string, monthGroup: string | null, depth: number) => {
    if (depth > 5) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === '_导入收件箱') continue;
        if (BATCH_NAME_RE.test(e.name)) {
          batchDirs.push({ dir: fp, name: e.name, monthGroup });
        } else {
          const mg = /^\d{4}-\d{2}$/.test(e.name) ? e.name : monthGroup;
          walk(fp, mg, depth + 1);
        }
      } else if (DATA_FILE_RE.test(e.name) && !e.name.endsWith('.tar')) {
        try {
          const records = parseJsonl(readText(fp));
          if (records.length === 0) continue;
          result.filesRead++;
          const reauthRecs = records.filter((r) => isReauthRecord(r, e.name));
          const originalRecs = records.filter((r) => !isReauthRecord(r, e.name));
          looseOriginals.push(...originalRecs);
          looseReauths.push(...reauthRecs);
        } catch (err) {
          result.errors.push(`${fp}: ${String(err)}`);
        }
      }
    }
  };
  walk(root, null, 0);

  if (looseOriginals.length) {
    const o = importOriginal(looseOriginals, null);
    result.original.created += o.created;
    result.original.updated += o.updated;
  }
  if (looseReauths.length) {
    const r = importReauth(looseReauths);
    result.reauth.applied += r.applied;
    result.reauth.unmatched.push(...r.unmatched);
  }

  for (const b of batchDirs) {
    const batchId = upsertBatch(b.dir, b.name, b.monthGroup);
    result.batchesFound++;
    const { originals, reauths, filesRead } = scanBatchDir(b.dir, result.errors);
    result.filesRead += filesRead;
    const o = importOriginal(originals, batchId);
    result.original.created += o.created;
    result.original.updated += o.updated;
    const r = importReauth(reauths);
    result.reauth.applied += r.applied;
    result.reauth.unmatched.push(...r.unmatched);
  }
  return result;
}
