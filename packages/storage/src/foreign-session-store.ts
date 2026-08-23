/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * Read-only scanner + digest reader over foreign agent session stores
 * (#1057): Claude Code (~/.claude/projects) and Codex (~/.codex).
 *
 * Boundary rules, in order of importance:
 *
 *   1. READ-ONLY. This store never writes, renames, locks, or truncates
 *      anything. It deliberately does NOT take the root-authority
 *      capability — that contract exists for Maka's own workspace; foreign
 *      stores belong to other tools and must stay byte-identical.
 *   2. SCOPED. All reads resolve under the configured home directory's
 *      known subtrees (`.claude/projects`, `.codex`). Paths obtained from
 *      foreign metadata (Codex `rollout_path`) are realpath-checked to
 *      still live inside the source root — a hostile row cannot point the
 *      reader at ~/.ssh.
 *   3. BOUNDED. Byte caps from @maka/core/foreign-session apply to every
 *      read (head window for metadata, head+tail window for titles, hard
 *      cap for digests); scan results cap at 50 sessions / 30 days.
 *   4. UNTRUSTED. All extracted text passes the core sanitize/redact gate;
 *      malformed lines and unreadable files are skipped, never fatal.
 *
 * Codex is read SQLite-first (node:sqlite, readOnly; column availability
 * introspected via PRAGMA so version drift degrades gracefully) with a
 * rollout-file directory walk as fallback.
 */

import { open, readdir, realpath, stat, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import {
  FOREIGN_SESSION_DIGEST_MAX_READ_BYTES,
  FOREIGN_SESSION_HEAD_BYTES,
  FOREIGN_SESSION_SCAN_MAX_AGE_MS,
  FOREIGN_SESSION_SCAN_MAX_SESSIONS,
  FOREIGN_SESSION_TITLE_WINDOW_BYTES,
  claudeAssistantText,
  claudeToolFilePaths,
  claudeUserAuthoredText,
  codexRolloutMessage,
  codexRolloutSessionMeta,
  collectClaudeMeta,
  collectClaudeTitle,
  createDigestAccumulator,
  finishDigest,
  isSafeForeignId,
  normalizeCodexThreadRow,
  parseForeignJsonLine,
  pickClaudeTitle,
  pushDigestFile,
  pushDigestMessage,
  sanitizeForeignMessage,
  sanitizeForeignTitle,
  type ClaudeTitleCandidates,
  type ClaudeTranscriptMeta,
  type CodexThreadRow,
  type ForeignSessionDigest,
  type ForeignSessionSource,
  type ForeignSessionSummary,
} from '@maka/core/foreign-session';

export interface ForeignSessionScanOptions {
  /** Only sessions whose recorded cwd equals this path (after realpath-free
   * string normalization). Empty/undefined lists across all cwds. */
  cwd?: string;
}

export interface ForeignSessionStore {
  /** Which sources are enabled AND present on this machine. */
  availableSources(): Promise<ForeignSessionSource[]>;
  listSessions(options?: ForeignSessionScanOptions): Promise<ForeignSessionSummary[]>;
  readDigest(summary: ForeignSessionSummary): Promise<ForeignSessionDigest>;
}

export interface ForeignSessionStoreOptions {
  /** Overridable for tests. Defaults to os.homedir(). */
  homeDir?: string;
  /** Env for per-source enable flags. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/** Default on; set to '0' to disable (cloak-flag convention). */
export function isClaudeCodeImportEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.MAKA_IMPORT_CLAUDE_CODE !== '0';
}

export function isCodexImportEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.MAKA_IMPORT_CODEX !== '0';
}

export function createForeignSessionStore(
  options: ForeignSessionStoreOptions = {},
): ForeignSessionStore {
  return new FileForeignSessionStore(options.homeDir ?? homedir(), options.env ?? process.env);
}

class FileForeignSessionStore implements ForeignSessionStore {
  constructor(
    private readonly homeDir: string,
    private readonly env: Record<string, string | undefined>,
  ) {}

  private get claudeRoot(): string {
    return join(this.homeDir, '.claude', 'projects');
  }

  private get codexRoot(): string {
    return join(this.homeDir, '.codex');
  }

  async availableSources(): Promise<ForeignSessionSource[]> {
    const sources: ForeignSessionSource[] = [];
    if (isClaudeCodeImportEnabled(this.env) && (await isDirectory(this.claudeRoot))) {
      sources.push('claude-code');
    }
    if (isCodexImportEnabled(this.env) && (await isDirectory(this.codexRoot))) {
      sources.push('codex');
    }
    return sources;
  }

  async listSessions(options: ForeignSessionScanOptions = {}): Promise<ForeignSessionSummary[]> {
    const sources = await this.availableSources();
    const now = Date.now();
    const results: ForeignSessionSummary[] = [];
    if (sources.includes('claude-code')) {
      results.push(...(await this.listClaudeSessions(options, now)));
    }
    if (sources.includes('codex')) {
      results.push(...(await this.listCodexSessions(options, now)));
    }
    results.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    // Sanitize + redact display metadata at the single return choke point.
    // cwd matching upstream used the raw values, so it is safe to scrub the
    // returned cwd/gitBranch here — a TUI consumer must never receive terminal
    // control characters, bidi overrides, or secrets in these fields. (title
    // and id are already gated at their source; transcriptPath stays raw as an
    // internal lookup key confined to the source roots.)
    return results.slice(0, FOREIGN_SESSION_SCAN_MAX_SESSIONS).map((s) => ({
      ...s,
      cwd: sanitizeForeignMessage(s.cwd),
      ...(s.gitBranch !== undefined ? { gitBranch: sanitizeForeignTitle(s.gitBranch) } : {}),
    }));
  }

  /* ------------------------------ Claude ------------------------------ */

  private async listClaudeSessions(
    options: ForeignSessionScanOptions,
    now: number,
  ): Promise<ForeignSessionSummary[]> {
    const projectDirs = await listSubdirectories(this.claudeRoot);
    const candidates: { path: string; mtimeMs: number }[] = [];
    for (const dir of projectDirs) {
      for (const entry of await listFilesWithSuffix(dir, '.jsonl')) {
        candidates.push(entry);
      }
    }
    // Newest transcripts first so the per-source cap keeps the useful ones
    // and old files never get opened at all.
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const results: ForeignSessionSummary[] = [];
    for (const candidate of candidates) {
      if (results.length >= FOREIGN_SESSION_SCAN_MAX_SESSIONS) break;
      if (now - candidate.mtimeMs > FOREIGN_SESSION_SCAN_MAX_AGE_MS) break;
      const summary = await this.scanClaudeTranscript(
        candidate.path,
        candidate.mtimeMs,
        options.cwd,
      );
      if (summary) results.push(summary);
    }
    return results;
  }

  private async scanClaudeTranscript(
    path: string,
    mtimeMs: number,
    cwdFilter: string | undefined,
  ): Promise<ForeignSessionSummary | undefined> {
    const id = basename(path, '.jsonl');
    if (!isSafeForeignId(id)) return undefined;

    // cwd and isSidechain both live in the first `user`/`assistant` record,
    // but a continued session can open with a run of `summary`/`mode` lines
    // or a huge first message, so a fixed 4KB head silently misses them and
    // drops the session. Grow the head window (64KB → 4MB) until cwd is seen.
    // isSidechain is a per-file property (every record in the file carries the
    // same value), so first-defined wins — no need to scan the whole file.
    const meta: ClaudeTranscriptMeta = {};
    for (const record of await readClaudeHeadRecords(path)) {
      collectClaudeMeta(record, meta);
      if (meta.cwd !== undefined && meta.isSidechain !== undefined) break;
    }
    if (meta.isSidechain === true) return undefined;
    if (meta.cwd === undefined) return undefined;
    if (cwdFilter !== undefined && normalizePath(meta.cwd) !== normalizePath(cwdFilter))
      return undefined;

    // Title fields use last-wins (freshest title in the tail beats an older
    // one); firstUserMessage uses first-wins (opening request). Feed the head
    // window first, then the tail, so both semantics fall out of iteration
    // order (see collectClaudeTitle).
    const titles: ClaudeTitleCandidates = {};
    const titleHead = await readWindow(path, 'head', FOREIGN_SESSION_TITLE_WINDOW_BYTES);
    const titleTail = await readWindow(path, 'tail', FOREIGN_SESSION_TITLE_WINDOW_BYTES);
    for (const window of [titleHead, titleTail]) {
      if (window === undefined) continue;
      for (const line of window.split('\n')) {
        const record = parseForeignJsonLine(line);
        if (record) {
          collectClaudeTitle(record, titles);
          collectClaudeMeta(record, meta);
        }
      }
    }
    return {
      source: 'claude-code',
      id,
      title: pickClaudeTitle(titles) || id,
      cwd: meta.cwd,
      updatedAtMs: meta.timestampMs ?? mtimeMs,
      gitBranch: meta.gitBranch,
      transcriptPath: path,
    };
  }

  /* ------------------------------ Codex ------------------------------- */

  private async listCodexSessions(
    options: ForeignSessionScanOptions,
    now: number,
  ): Promise<ForeignSessionSummary[]> {
    // Try state DBs newest-generation first. A DB that cannot be opened or
    // lacks the threads schema (rows === undefined) is skipped so a freshly
    // created generation missing the schema doesn't shadow an older usable
    // one. The FIRST usable DB is authoritative — its result is returned even
    // when empty. Descending past it on an empty result would resurface stale
    // rows from an older generation (e.g. a session archived in the newest DB
    // reappearing active in an older one), and would send every no-match-cwd
    // listing down the expensive rollout walk.
    for (const dbPath of await codexStateDbsNewestFirst(this.codexRoot)) {
      const rows = await readCodexThreadRows(dbPath, options.cwd);
      if (rows === undefined) continue;
      return this.codexRowsToSummaries(rows, options, now);
    }
    // No usable state DB at all → fall back to the rollout directory walk.
    return this.listCodexSessionsFromRollouts(options, now);
  }

  private async codexRowsToSummaries(
    rows: CodexThreadRow[],
    options: ForeignSessionScanOptions,
    now: number,
  ): Promise<ForeignSessionSummary[]> {
    const results: ForeignSessionSummary[] = [];
    for (const row of rows) {
      if (results.length >= FOREIGN_SESSION_SCAN_MAX_SESSIONS) break;
      const normalized = normalizeCodexThreadRow(row);
      if (!normalized) continue;
      if (now - normalized.updatedAtMs > FOREIGN_SESSION_SCAN_MAX_AGE_MS) continue;
      if (options.cwd !== undefined && normalizePath(normalized.cwd) !== normalizePath(options.cwd))
        continue;
      const transcriptPath = await this.resolveCodexRolloutPath(
        normalized.rolloutPath,
        normalized.id,
      );
      if (transcriptPath === undefined) continue;
      results.push({
        source: normalized.source,
        id: normalized.id,
        title: normalized.title,
        cwd: normalized.cwd,
        updatedAtMs: normalized.updatedAtMs,
        gitBranch: normalized.gitBranch,
        transcriptPath,
      });
    }
    return results;
  }

  private async listCodexSessionsFromRollouts(
    options: ForeignSessionScanOptions,
    now: number,
  ): Promise<ForeignSessionSummary[]> {
    const sessionsRoot = join(this.codexRoot, 'sessions');
    const files = await walkRolloutFiles(sessionsRoot, now);
    const results: ForeignSessionSummary[] = [];
    for (const file of files) {
      if (results.length >= FOREIGN_SESSION_SCAN_MAX_SESSIONS) break;
      const head = await readWindow(file.path, 'head', FOREIGN_SESSION_HEAD_BYTES);
      if (head === undefined) continue;
      let meta: ReturnType<typeof codexRolloutSessionMeta>;
      let firstUserText: string | undefined;
      for (const line of head.split('\n')) {
        const record = parseForeignJsonLine(line);
        if (!record) continue;
        meta ??= codexRolloutSessionMeta(record);
        if (firstUserText === undefined) {
          const message = codexRolloutMessage(record);
          if (message?.role === 'user') firstUserText = message.text;
        }
        if (meta && firstUserText !== undefined) break;
      }
      if (!meta?.id || meta.cwd === undefined) continue;
      if (!isSafeForeignId(meta.id)) continue;
      // The transcript filename must belong to this session (defends against
      // renamed / planted rollout files, as in the DB path).
      if (!rolloutFilenameMatchesId(basename(file.path), meta.id)) continue;
      if (options.cwd !== undefined && normalizePath(meta.cwd) !== normalizePath(options.cwd))
        continue;
      results.push({
        source: 'codex',
        id: meta.id,
        // session_meta has no title; the first user message in the head
        // window is the best available label (Grok Build does the same).
        title: sanitizeForeignTitle(firstUserText) || meta.id,
        cwd: meta.cwd,
        updatedAtMs: meta.timestampMs ?? file.mtimeMs,
        gitBranch: meta.gitBranch,
        transcriptPath: file.path,
      });
    }
    return results;
  }

  /**
   * Realpath-confine a rollout path from the (untrusted) DB to ~/.codex, and
   * require the transcript filename to belong to this thread — the id (a uuid)
   * is the trailing component of `rollout-<timestamp>-<id>.jsonl`, so a
   * mismatch means the row points at some other session's transcript (orphan
   * row or a forged path) and is dropped. The timestamp format varies across
   * Codex versions (ISO datetime or epoch), so match by the id suffix rather
   * than parsing the timestamp.
   */
  private async resolveCodexRolloutPath(
    rolloutPath: string,
    expectedId: string,
  ): Promise<string | undefined> {
    try {
      const real = await realpath(resolve(rolloutPath));
      const root = await realpath(this.codexRoot);
      if (real !== root && !real.startsWith(root + sep)) return undefined;
      if (!(await stat(real)).isFile()) return undefined;
      if (!rolloutFilenameMatchesId(basename(real), expectedId)) return undefined;
      return real;
    } catch {
      return undefined;
    }
  }

  /* ------------------------------ Digest ------------------------------ */

  async readDigest(summary: ForeignSessionSummary): Promise<ForeignSessionDigest> {
    // The transcript path was produced by our own scan, but re-confine it
    // anyway: digests can be requested long after the scan, and the file
    // may have been swapped for a symlink in between.
    const root = summary.source === 'claude-code' ? this.claudeRoot : this.codexRoot;
    const real = await realpath(resolve(summary.transcriptPath));
    const realRoot = await realpath(root);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw new Error('Foreign transcript escaped its source root');
    }

    const acc = createDigestAccumulator();
    // Open ONCE and read through the single fd: a stat-then-readFile pair has
    // a TOCTOU window (the regular file could be swapped for a FIFO — which
    // would block readFile forever — or grown past the cap between the two
    // calls). fstat on the held fd, reject anything but a regular file, and
    // never read more than the cap regardless of the size we observe.
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let text: string;
    try {
      handle = await open(real, 'r');
      const st = await handle.stat();
      if (!st.isFile()) throw new Error('Foreign transcript is not a regular file');
      if (st.size > FOREIGN_SESSION_DIGEST_MAX_READ_BYTES) {
        text = await readHandleTailWindow(handle, st.size, FOREIGN_SESSION_DIGEST_MAX_READ_BYTES);
        acc.warnings.push(
          `transcript is ${st.size} bytes; only the trailing ${FOREIGN_SESSION_DIGEST_MAX_READ_BYTES} bytes were read`,
        );
      } else {
        const buffer = Buffer.alloc(st.size);
        await handle.read(buffer, 0, st.size, 0);
        text = buffer.toString('utf8');
      }
    } finally {
      await handle?.close();
    }

    let dropped = 0;
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      const record = parseForeignJsonLine(line);
      if (!record) {
        dropped += 1;
        continue;
      }
      if (summary.source === 'claude-code') {
        // Sidechain records are a sub-agent's own conversation interleaved
        // into the main transcript; they belong to neither role of the main
        // session and must not enter its handoff (drop them for BOTH the user
        // and assistant branches, not just the user one).
        if (record.isSidechain === true) continue;
        if (record.type === 'user') {
          // claudeUserAuthoredText drops isMeta / isCompactSummary records so
          // Claude's own injected context and generated compaction summaries
          // never enter the handoff as user-authored text.
          const text = claudeUserAuthoredText(record);
          if (text !== undefined) pushDigestMessage(acc, 'user', text);
        } else if (record.type === 'assistant') {
          const text = claudeAssistantText(record);
          if (text !== undefined) pushDigestMessage(acc, 'assistant', text);
          for (const path of claudeToolFilePaths(record)) pushDigestFile(acc, path);
        }
      } else {
        const message = codexRolloutMessage(record);
        if (message) pushDigestMessage(acc, message.role, message.text);
      }
    }
    if (dropped > 0) acc.warnings.push(`${dropped} malformed transcript lines were skipped`);

    return finishDigest(acc, {
      source: summary.source,
      id: summary.id,
      title: summary.title,
      cwd: summary.cwd,
      gitBranch: summary.gitBranch,
      updatedAtMs: summary.updatedAtMs,
    });
  }
}

/* ------------------------------ fs helpers ------------------------------ */

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function listSubdirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => join(root, e.name));
  } catch {
    return [];
  }
}

async function listFilesWithSuffix(
  dir: string,
  suffix: string,
): Promise<{ path: string; mtimeMs: number }[]> {
  const out: { path: string; mtimeMs: number }[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(suffix)) continue;
      const path = join(dir, entry.name);
      try {
        out.push({ path, mtimeMs: (await stat(path)).mtimeMs });
      } catch {
        // Deleted mid-scan; skip.
      }
    }
  } catch {
    // Unreadable project dir; skip.
  }
  return out;
}

/** Codex sessions/YYYY/MM/DD/rollout-*.jsonl walk, newest days first. */
async function walkRolloutFiles(
  root: string,
  now: number,
): Promise<{ path: string; mtimeMs: number }[]> {
  const out: { path: string; mtimeMs: number }[] = [];
  const years = (await listSubdirectories(root)).sort().reverse();
  for (const year of years) {
    const months = (await listSubdirectories(year)).sort().reverse();
    for (const month of months) {
      const days = (await listSubdirectories(month)).sort().reverse();
      for (const day of days) {
        for (const file of await listFilesWithSuffix(day, '.jsonl')) {
          if (!basename(file.path).startsWith('rollout-')) continue;
          if (now - file.mtimeMs > FOREIGN_SESSION_SCAN_MAX_AGE_MS) continue;
          out.push(file);
        }
        // Enough candidates for the cap even after per-file drops.
        if (out.length >= FOREIGN_SESSION_SCAN_MAX_SESSIONS * 2) {
          out.sort((a, b) => b.mtimeMs - a.mtimeMs);
          return out;
        }
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** All ~/.codex/state_N.sqlite paths, newest generation first. */
async function codexStateDbsNewestFirst(codexRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(codexRoot);
    return entries
      .filter((name) => /^state_\d+\.sqlite$/.test(name))
      .sort((a, b) => Number(b.match(/\d+/)?.[0] ?? 0) - Number(a.match(/\d+/)?.[0] ?? 0))
      .map((name) => join(codexRoot, name));
  } catch {
    return [];
  }
}

/**
 * Codex source tokens as stored in the DB — bare for cli/vscode, JSON-wrapped
 * for the `custom` variants. Used as bound `source IN (…)` params so archived
 * / foreign-source rows are excluded IN SQL (before LIMIT), not after.
 */
const CODEX_SOURCE_SQL_VALUES = ['cli', 'vscode', '{"custom":"atlas"}', '{"custom":"chatgpt"}'];

/**
 * Read candidate thread rows from one state DB, filtered and ordered in SQL.
 * undefined = DB unusable (cannot open, or lacks the id/rollout_path columns)
 * so the caller descends to an older generation. An empty array is a real
 * "this DB has no matching threads".
 */
async function readCodexThreadRows(
  dbPath: string,
  cwdFilter?: string,
): Promise<CodexThreadRow[] | undefined> {
  try {
    const sqlite = await import('node:sqlite');
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      const columns = new Set(
        (db.prepare('PRAGMA table_info(threads)').all() as { name?: unknown }[])
          .map((c) => (typeof c.name === 'string' ? c.name : ''))
          .filter((n) => n.length > 0),
      );
      if (!columns.has('id') || !columns.has('rollout_path')) return undefined;
      // Every identifier below is drawn from this fixed allowlist, never from
      // the DB, so interpolation is injection-safe; values are bound params.
      const wanted = [
        'id',
        'rollout_path',
        'cwd',
        'title',
        'first_user_message',
        'updated_at_ms',
        'updated_at',
        'git_branch',
        'archived',
        'source',
      ].filter((c) => columns.has(c));
      const where: string[] = [];
      const params: string[] = [];
      if (columns.has('archived')) where.push('(archived IS NULL OR archived = 0)');
      if (columns.has('source')) {
        where.push(`source IN (${CODEX_SOURCE_SQL_VALUES.map(() => '?').join(', ')})`);
        params.push(...CODEX_SOURCE_SQL_VALUES);
      }
      // Filter cwd IN SQL, before LIMIT: otherwise a multi-project store with
      // many newer threads from other directories fills the LIMIT window and
      // the target project's older thread never reaches the JS-side filter.
      // This is a COARSE pre-filter across source-native and host-normalized
      // separator forms. The authoritative two-sided normalizePath()
      // comparison still runs in codexRowsToSummaries().
      if (cwdFilter !== undefined && columns.has('cwd')) {
        const variants = codexCwdSqlVariants(cwdFilter);
        where.push(`cwd IN (${variants.map(() => '?').join(', ')})`);
        params.push(...variants);
      }
      const orderColumn = columns.has('updated_at_ms')
        ? 'updated_at_ms'
        : columns.has('updated_at')
          ? 'updated_at'
          : 'id';
      const sql =
        `SELECT ${wanted.join(', ')} FROM threads` +
        (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
        ` ORDER BY ${orderColumn} DESC LIMIT ${FOREIGN_SESSION_SCAN_MAX_SESSIONS * 2}`;
      return db.prepare(sql).all(...params) as CodexThreadRow[];
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * Parsed records from the head of a Claude transcript, growing the read
 * window (64KB → 4MB) so a session that opens with a run of summary lines or
 * a very large first message still yields its cwd record. Stops early once a
 * record carrying `cwd` is seen.
 */
async function readClaudeHeadRecords(path: string): Promise<Record<string, unknown>[]> {
  for (let bytes = 64 * 1024; ; bytes *= 4) {
    const capped = Math.min(bytes, CLAUDE_HEAD_MAX_BYTES);
    const window = await readWindow(path, 'head', capped);
    if (window === undefined) return [];
    const records: Record<string, unknown>[] = [];
    let sawCwd = false;
    for (const line of window.split('\n')) {
      const record = parseForeignJsonLine(line);
      if (!record) continue;
      records.push(record);
      if (typeof record.cwd === 'string') sawCwd = true;
    }
    if (sawCwd || capped >= CLAUDE_HEAD_MAX_BYTES || capped >= (await fileSize(path)))
      return records;
  }
}

const CLAUDE_HEAD_MAX_BYTES = 4 * 1024 * 1024;

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** Read the trailing `bytes` of an open handle, dropping the partial first line. */
async function readHandleTailWindow(
  handle: FileHandle,
  size: number,
  bytes: number,
): Promise<string> {
  const length = Math.min(bytes, size);
  const buffer = Buffer.alloc(length);
  await handle.read(buffer, 0, length, size - length);
  const text = buffer.toString('utf8');
  if (length >= size) return text; // whole file — no partial first line
  const nl = text.indexOf('\n');
  return nl === -1 ? '' : text.slice(nl + 1);
}

/**
 * Bounded read of a file's head or tail window; undefined on any error. A
 * tail window drops its partial first line so a mid-line cut isn't parsed as
 * a malformed record (and isn't reported as one).
 */
async function readWindow(
  path: string,
  where: 'head' | 'tail',
  bytes: number,
): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'r');
    const size = (await handle.stat()).size;
    if (where === 'tail') return await readHandleTailWindow(handle, size, bytes);
    const length = Math.min(bytes, size);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    return buffer.toString('utf8');
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

/**
 * A Codex rollout file `rollout-<timestamp>-<id>.jsonl` belongs to thread
 * `id` when the basename opens with `rollout-` and ends with `-<id>.jsonl`.
 * Timestamp-format-agnostic: the id (a uuid) is always the trailing segment.
 */
function rolloutFilenameMatchesId(base: string, id: string): boolean {
  return base.startsWith('rollout-') && base.endsWith(`-${id}.jsonl`);
}

function normalizePath(path: string): string {
  const resolved = resolve(path);
  return resolved.endsWith(sep) && resolved !== sep ? resolved.slice(0, -1) : resolved;
}

export function codexCwdSqlVariants(path: string): string[] {
  const variants = new Set<string>();
  for (const candidate of [path, normalizePath(path)]) {
    for (const separatorForm of [
      candidate,
      candidate.replaceAll('\\', '/'),
      candidate.replaceAll('/', '\\'),
    ]) {
      const withoutTrailingSeparator = separatorForm.replace(/[\\/]+$/, '') || separatorForm;
      variants.add(withoutTrailingSeparator);
      variants.add(`${withoutTrailingSeparator}/`);
      variants.add(`${withoutTrailingSeparator}\\`);
    }
  }
  return [...variants];
}
