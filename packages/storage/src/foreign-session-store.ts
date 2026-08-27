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

import { lstat, open, readdir, realpath, stat, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  FOREIGN_SESSION_DIGEST_MAX_READ_BYTES,
  FOREIGN_SESSION_HEAD_BYTES,
  FOREIGN_SESSION_SCAN_MAX_AGE_MS,
  FOREIGN_SESSION_SCAN_MAX_SESSIONS,
  FOREIGN_SESSION_TITLE_WINDOW_BYTES,
  claudeAssistantText,
  claudeToolFileUses,
  claudeToolResultIds,
  claudeUserAuthoredText,
  codexRolloutMessage,
  codexRolloutSessionMeta,
  collectClaudeMeta,
  collectClaudeTitle,
  createDigestAccumulator,
  finishDigest,
  foreignRecordTimestampMs,
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
  type ForeignSessionProbeFileState,
  type ForeignSessionRepoProbe,
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
    // #1512 review P1: a file's mtime is set BETWEEN the tool_use record and
    // its tool_result, so the tool_use timestamp misreports every normal
    // Edit/Write as changed-after-session. Anchor each touch to the matching
    // result record instead: remember pending tool_use ids, re-stamp on the
    // record that completes them. Bounded so a hostile transcript cannot
    // grow the map without limit.
    const pendingToolFiles = new Map<string, string[]>();
    const PENDING_TOOL_FILES_MAX = 256;
    // #1512 review P2: the scanner's first-branch observation is not the
    // branch the session ENDED on; track the last one seen in the window.
    let lastGitBranch: string | undefined;
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
        if (typeof record.gitBranch === 'string' && record.gitBranch.length > 0) {
          lastGitBranch = record.gitBranch;
        }
        if (record.type === 'user') {
          // claudeUserAuthoredText drops isMeta / isCompactSummary records so
          // Claude's own injected context and generated compaction summaries
          // never enter the handoff as user-authored text.
          const text = claudeUserAuthoredText(record);
          if (text !== undefined) pushDigestMessage(acc, 'user', text);
          // tool_result blocks live on user-role records; they complete the
          // pending tool uses (even on records whose text is synthetic).
          const resultAtMs = foreignRecordTimestampMs(record);
          for (const id of claudeToolResultIds(record)) {
            const paths = pendingToolFiles.get(id);
            if (paths === undefined) continue;
            pendingToolFiles.delete(id);
            for (const path of paths) pushDigestFile(acc, path, resultAtMs);
          }
        } else if (record.type === 'assistant') {
          const text = claudeAssistantText(record);
          if (text !== undefined) pushDigestMessage(acc, 'assistant', text);
          for (const use of claudeToolFileUses(record)) {
            // Record the touch immediately (timestamp-less); the matching
            // result re-stamps it. An interrupted tool call keeps the
            // conservative session-end fallback.
            for (const path of use.paths) pushDigestFile(acc, path);
            if (use.toolUseId !== undefined && pendingToolFiles.size < PENDING_TOOL_FILES_MAX) {
              pendingToolFiles.set(use.toolUseId, use.paths);
            }
          }
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
      gitBranch: lastGitBranch ?? summary.gitBranch,
      updatedAtMs: summary.updatedAtMs,
      transcriptPath: summary.transcriptPath,
    });
  }
}

/* --------------------- handoff-time repository probe --------------------- */

/** Bytes cap for git metadata reads (.git pointer file, HEAD). */
const GIT_METADATA_MAX_BYTES = 4096;

/**
 * Observe the CURRENT repository state the digest's claims will be compared
 * against (#1057 follow-up; assessment itself is pure and lives in core).
 *
 * Trust rules (#1512 review P1):
 *   - CONFINED. Every touched-file path (transcript-controlled) is
 *     realpath-resolved and must land inside the realpath of the session
 *     cwd; anything else — `../`, absolute paths elsewhere, symlinks out —
 *     is reported `out_of_scope`, never followed. Files are only ever
 *     stat'd, never opened.
 *   - BOUNDED. The only reads are git metadata (`.git` pointer file, HEAD),
 *     each lstat-gated to a regular file ≤4KB and re-checked on the open
 *     handle before reading (same TOCTOU discipline as readDigest).
 *   - TRUSTED CEILING. The transcript file's own mtime is captured so the
 *     assessment can clamp transcript-claimed timestamps — a forged future
 *     timestamp cannot suppress mtime warnings.
 *   - HONEST FAILURE. Never throws, and never folds an error into a
 *     healthy-looking value: every observation carries an explicit
 *     missing/unreadable/out_of_scope state (#1512 review P2).
 */
export async function probeForeignSessionRepoState(
  digest: Pick<ForeignSessionDigest, 'cwd' | 'filesTouched' | 'transcriptPath'>,
  options?: { nowMs?: number },
): Promise<ForeignSessionRepoProbe> {
  const probedAtMs = options?.nowMs ?? Date.now();
  const transcriptMtimeMs = await statRegularFileMtime(digest.transcriptPath);

  let cwdState: ForeignSessionRepoProbe['cwdState'] = 'unknown';
  let realCwd: string | undefined;
  if (digest.cwd.length > 0) {
    try {
      const real = await realpath(digest.cwd);
      cwdState = (await stat(real)).isDirectory() ? 'ok' : 'missing';
      if (cwdState === 'ok') realCwd = real;
    } catch (error) {
      cwdState = isNotFound(error) ? 'missing' : 'unreadable';
    }
  }

  const gitState: ForeignSessionRepoProbe['gitState'] =
    realCwd !== undefined ? await readGitState(realCwd) : { status: 'unchecked' };

  const fileStates = new Map<string, ForeignSessionProbeFileState>();
  if (realCwd !== undefined) {
    for (const touch of digest.filesTouched) {
      // Keyed VERBATIM by the digest path (the assessment matches keys as
      // given); resolution happens only for the confinement check + stat.
      fileStates.set(touch.path, await probeTouchedFile(realCwd, touch.path));
    }
  }

  return { probedAtMs, cwdState, gitState, transcriptMtimeMs, fileStates };
}

async function probeTouchedFile(
  realCwd: string,
  touchPath: string,
): Promise<ForeignSessionProbeFileState> {
  const candidate = isAbsolute(touchPath) ? touchPath : resolve(realCwd, touchPath);
  let real: string;
  try {
    real = await realpath(candidate);
  } catch (error) {
    if (!isNotFound(error)) return { status: 'unreadable' };
    // The leaf does not exist. Confine on the parent's real path so a
    // symlinked directory cannot smuggle the check out of the repo, then
    // report an honest `missing` for in-scope paths.
    try {
      const realParent = await realpath(dirname(candidate));
      return isInsideOrSamePath(realCwd, join(realParent, basename(candidate)))
        ? { status: 'missing' }
        : { status: 'out_of_scope' };
    } catch {
      return { status: 'missing' };
    }
  }
  if (!isInsideOrSamePath(realCwd, real)) return { status: 'out_of_scope' };
  try {
    const st = await stat(real);
    return st.isFile() ? { status: 'ok', mtimeMs: st.mtimeMs } : { status: 'unreadable' };
  } catch (error) {
    return isNotFound(error) ? { status: 'missing' } : { status: 'unreadable' };
  }
}

/** Same strict-interior recipe as artifact-store.ts / session-metadata-
 *  maintenance.ts (the family the containment-guard contract allows in
 *  packages that cannot import @maka/runtime's isPathInside). Inputs here
 *  are realpath-resolved absolute paths. */
function isInsideOrSamePath(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = relative(root, target);
  return (
    rel !== '' &&
    !rel.startsWith('..') &&
    rel !== '..' &&
    !rel.includes(`..${sep}`) &&
    !rel.startsWith(sep)
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as NodeJS.ErrnoException).code === 'ENOENT' ||
      (error as NodeJS.ErrnoException).code === 'ENOTDIR')
  );
}

/** mtime of a path iff it is (still) a regular file; undefined otherwise. */
async function statRegularFileMtime(path: string): Promise<number | undefined> {
  try {
    const st = await stat(path);
    return st.isFile() ? st.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Current branch from `.git/HEAD` without spawning git, with explicit
 * failure states. Handles the worktree/submodule layout where `.git` is a
 * FILE containing `gitdir: <path>` (one level — enough for worktrees; the
 * target may legitimately live outside the cwd, but every read stays
 * bounded to a ≤4KB regular file).
 */
async function readGitState(realCwd: string): Promise<ForeignSessionRepoProbe['gitState']> {
  const gitPath = join(realCwd, '.git');
  let gitDir = gitPath;
  try {
    const st = await stat(gitPath);
    if (st.isFile()) {
      const pointer = await readBoundedRegularFile(gitPath, GIT_METADATA_MAX_BYTES);
      if (pointer === undefined) return { status: 'unreadable' };
      const match = pointer.match(/^gitdir:\s*(.+)\s*$/m);
      if (!match) return { status: 'unreadable' };
      const target = match[1]!.trim();
      gitDir = isAbsolute(target) ? target : resolve(dirname(gitPath), target);
    } else if (!st.isDirectory()) {
      return { status: 'unreadable' };
    }
  } catch (error) {
    return isNotFound(error) ? { status: 'not_a_repo' } : { status: 'unreadable' };
  }
  const head = await readBoundedRegularFile(join(gitDir, 'HEAD'), GIT_METADATA_MAX_BYTES);
  if (head === undefined) return { status: 'unreadable' };
  const ref = head.match(/^ref:\s*refs\/heads\/(.+)\s*$/m);
  if (ref) return { status: 'branch', branch: ref[1]!.trim() };
  // A bare commit hash is a legitimate detached HEAD; anything else is noise.
  return /^[0-9a-f]{4,64}\s*$/i.test(head) ? { status: 'detached' } : { status: 'unreadable' };
}

/**
 * Read a small metadata file defensively: lstat-gate (no symlinks, regular
 * file, size cap) then open and re-check on the held fd before reading —
 * the same TOCTOU discipline as readDigest. Undefined on ANY failure or
 * bound violation; callers map that to an explicit unreadable state.
 */
async function readBoundedRegularFile(path: string, maxBytes: number): Promise<string | undefined> {
  try {
    const pre = await lstat(path);
    if (!pre.isFile() || pre.size > maxBytes) return undefined;
  } catch {
    return undefined;
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'r');
    const st = await handle.stat();
    if (!st.isFile() || st.size > maxBytes) return undefined;
    const buffer = Buffer.alloc(st.size);
    await handle.read(buffer, 0, st.size, 0);
    return buffer.toString('utf8');
  } catch {
    return undefined;
  } finally {
    await handle?.close();
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
