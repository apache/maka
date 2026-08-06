import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_SESSION_NAME,
  decodeStoredMessageForRecovery,
  isCollaborationMode,
  isOrchestrationMode,
  isPermissionMode,
  isSessionBlockedReason,
  isSessionStatus,
  type SessionHeader,
  type StoredMessage,
} from '@maka/core';
import { normalizeSessionHeader, type SessionAuthorityStore } from './session-store.js';

/**
 * One-time importer for the legacy file-backed session transcripts that the
 * JSONL→SQLite cutover (#1994) left behind.
 *
 * Before #1994, every session lived at `sessions/<session-id>/session.jsonl`:
 * line 1 is a `schemaVersion: 1` header record, every following line is a
 * message record. #1994 made SQLite the sole operational authority and dropped
 * the JSONL session tree (#2029) without an import path, so sessions created
 * before the cutover stay on disk but never appear in the UI (issue #2260).
 *
 * Between #1373 and #1994 the writer stored line 1 as a
 * `{"type":"session_transcript",...}` marker instead (data lived in SQLite),
 * and the pre-#1994 reader fail-closed on a marker file whose SQLite row was
 * absent. The importer preserves that contract: a marker file with no backing
 * SQLite row is reported as failed, never fabricated into a fake session.
 *
 * Design:
 * - Each file imports through one store-level `importSession` call: the
 *   header row (with its historical timestamps and flags) and all messages
 *   land in a single SQLite transaction. A file either imports completely or
 *   is counted as failed with nothing persisted — a partial session can never
 *   survive, even across process death or a failpoint mid-write.
 * - Idempotency is the session id's primary key: `importSession` is
 *   `INSERT OR IGNORE`, so re-runs (and concurrent first launches, e.g. a CLI
 *   pre-check store racing the TUI/desktop store) converge on one winner with
 *   no create claims or fingerprints. A cheap `hasSession` probe runs BEFORE
 *   the file read, so every launch of an upgraded install pays a directory
 *   listing plus per-id existence checks and never re-reads an imported
 *   transcript.
 * - The decoded header is validated through `normalizeSessionHeader` BEFORE
 *   the write, so a malformed header fails the file without persisting
 *   anything.
 * - Best-effort: a malformed or unreadable file is reported in the result and
 *   never blocks startup or the import of other sessions. A whole-run failure
 *   (e.g. an unreadable `sessions/` directory) propagates to the caller; the
 *   store's `ensureReady` latch contains it and logs it.
 * - Legacy files are retained after import, honoring the repository policy
 *   that legacy stores are kept as migration evidence.
 * - Legacy subagent children (real on-disk sessions before the cutover) are
 *   imported under their own legacy id with parent/runtime/spawn lineage
 *   preserved, so session-tree nesting and descendant queries keep working.
 *
 * The compatibility defaults mirror the old `decodeSessionHeader` (kept public
 * for one-way importers before #1994 deleted it): missing `permissionMode`
 * defaults to `ask`, `collaborationMode` to `agent`, `orchestrationMode` to
 * `default`, model to `default`, and `claude`/`pi` backends are remapped.
 */

const LEGACY_SESSIONS_DIR = 'sessions';
const LEGACY_TRANSCRIPT_FILE = 'session.jsonl';
const SESSION_TRANSCRIPT_MARKER_TYPE = 'session_transcript';

export interface LegacySessionImportResult {
  imported: number;
  skipped: number;
  failed: number;
  failures: Array<{ sessionId: string; error: string }>;
}

type LegacySessionFileOutcome = 'imported' | 'skipped';

/**
 * Import all legacy `sessions/<session-id>/session.jsonl` transcripts under
 * `workspaceRoot` into the SQLite-backed session store.
 *
 * The store must be open (a `createSessionStore(workspaceRoot)` instance is
 * ready immediately). Idempotent; safe to call on every launch. A whole-run
 * failure (missing directory is the normal case and is not a failure) throws;
 * per-file failures are reported in the result and never throw.
 */
export async function importLegacySessionsOnce(
  store: SessionAuthorityStore,
  workspaceRoot: string,
): Promise<LegacySessionImportResult> {
  const result: LegacySessionImportResult = {
    imported: 0,
    skipped: 0,
    failed: 0,
    failures: [],
  };
  const sessionsDir = join(workspaceRoot, LEGACY_SESSIONS_DIR);

  let entries: Dirent[];
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true });
  } catch (error) {
    // No legacy sessions directory is the normal case for installs that
    // never predate the cutover; it is not a failure.
    if (isNodeErrorWithCode(error, 'ENOENT')) return result;
    throw error;
  }

  const sessionDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const sessionId of sessionDirs) {
    const transcriptPath = join(sessionsDir, sessionId, LEGACY_TRANSCRIPT_FILE);
    try {
      // Idempotency probe BEFORE the file read: an id already known to
      // SQLite — imported by an earlier run, created by the user, or claimed
      // by a concurrent first-launch process — is skipped without opening or
      // parsing its transcript, so every launch of an upgraded install pays
      // only a directory listing plus per-id existence checks. importSession
      // remains the authority on idempotency (a race between this probe and
      // the write converges on one winner via the primary key).
      if (await store.hasSession(sessionId)) {
        result.skipped += 1;
        continue;
      }
      const outcome = await importLegacySessionFile(store, sessionId, transcriptPath);
      if (outcome === 'imported') {
        result.imported += 1;
      } else {
        result.skipped += 1;
      }
    } catch (error) {
      result.failed += 1;
      result.failures.push({
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

async function importLegacySessionFile(
  store: SessionAuthorityStore,
  sessionId: string,
  transcriptPath: string,
): Promise<LegacySessionFileOutcome> {
  const { header, messages } = await readLegacyTranscript(transcriptPath, sessionId);

  // Validate the fully-decoded header BEFORE any write. The single import
  // transaction below is atomic, so a malformed header must fail here — never
  // after a partial commit.
  const normalized = normalizeSessionHeader(header, sessionId);

  // One transaction: header row (with historical timestamps/flags) + all
  // messages in order. Idempotent by primary key, so an id already in SQLite
  // (earlier run, user-created, concurrent winner) is skipped, never clobbered.
  const outcome = await store.importSession(normalized, messages);
  return outcome === 'imported' ? 'imported' : 'skipped';
}

async function readLegacyTranscript(
  transcriptPath: string,
  sessionId: string,
): Promise<{ header: SessionHeader; messages: StoredMessage[] }> {
  const text = await readFile(transcriptPath, 'utf8');
  const endsWithNewline = text.endsWith('\n');
  const rawLines = text.split('\n');
  const contentLines = rawLines.filter((line) => line.trim().length > 0);
  if (contentLines.length === 0) {
    throw new Error(`Legacy session ${sessionId} is empty`);
  }

  let firstRecord: unknown;
  try {
    firstRecord = JSON.parse(contentLines[0]!);
  } catch (error) {
    throw new Error(
      `Legacy session ${sessionId} has an invalid header line: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // Between #1373 and #1994 line 1 was a `session_transcript` marker and the
  // data lived in SQLite. A marker file with no backing SQLite row (restored
  // backup, copied sessions/, reset DB) cannot be imported from JSONL — the
  // pre-#1994 reader fail-closed on this shape, and so do we: report it as
  // failed rather than fabricating a fake session with import-time stamps.
  if (isSessionTranscriptMarker(firstRecord)) {
    throw new Error(
      `Legacy session ${sessionId} is a session_transcript marker whose SQLite metadata is absent; ` +
        'refusing to fabricate a session from the marker alone',
    );
  }

  const header = decodeLegacySessionHeader(firstRecord, sessionId);
  const messages: StoredMessage[] = [];
  for (let index = 1; index < rawLines.length; index += 1) {
    const line = rawLines[index]!;
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      // The classic interrupted-append artifact is a final line cut off
      // mid-write: the file does not end with a newline and the truncated
      // record never closed its outer bracket. The pre-#1994 strict reader
      // skipped exactly that shape (`!endsWithNewline && lastLine &&
      // incomplete-prefix`) and failed on anything else; so do we — a corrupt
      // line that ends in a newline, or a garbage tail, fails the whole file
      // rather than silently dropping a record.
      if (isTornTail(rawLines, index, endsWithNewline)) break;
      throw new Error(
        `Legacy session ${sessionId} has a corrupt JSONL record at line ${index + 1}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    // Strict decode: a malformed record fails the whole file rather than
    // being laundered into the new authoritative store.
    messages.push(decodeStoredMessageForRecovery(parsed));
  }
  return { header, messages };
}

function isSessionTranscriptMarker(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return (value as { type?: unknown }).type === SESSION_TRANSCRIPT_MARKER_TYPE;
}

/**
 * True only for the torn-tail shape the pre-#1994 strict reader tolerated: the
 * final line of a file that does not end with a newline, whose parse failure
 * is explained by an unclosed JSON bracket (i.e. the record was truncated
 * mid-write rather than being garbage). Any other unparseable line — including
 * a truncated line that still ends in a newline — is a real corruption.
 */
function isTornTail(rawLines: string[], index: number, endsWithNewline: boolean): boolean {
  if (endsWithNewline) return false;
  if (index !== rawLines.length - 1) return false;
  return isIncompleteJsonPrefix(rawLines[index]!);
}

function isIncompleteJsonPrefix(line: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of line) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') depth -= 1;
  }
  return depth > 0;
}

/**
 * The legacy header was a loose JSON object (some fields optional, old
 * backends named differently). This mirrors the pre-#1994 `decodeSessionHeader`
 * compatibility rules; the final strict shape is enforced by
 * `normalizeSessionHeader` before any write.
 */
export function decodeLegacySessionHeader(value: unknown, sessionId: string): SessionHeader {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid legacy session header for session ${sessionId}: expected an object`);
  }
  const header = value as LegacyStoredSessionHeader;
  const permissionMode = isPermissionMode(header.permissionMode) ? header.permissionMode : 'ask';
  const collaborationMode = isCollaborationMode(header.collaborationMode)
    ? header.collaborationMode
    : 'agent';
  const orchestrationMode = isOrchestrationMode(header.orchestrationMode)
    ? header.orchestrationMode
    : 'default';
  const model =
    typeof header.model === 'string' && header.model.length > 0 ? header.model : 'default';
  const status = resolveLegacyStatus(header);
  const blockedReason =
    status === 'blocked' && isSessionBlockedReason(header.blockedReason)
      ? header.blockedReason
      : undefined;
  const statusUpdatedAt =
    header.statusUpdatedAt ??
    header.archivedAt ??
    header.lastMessageAt ??
    header.lastUsedAt ??
    header.createdAt;
  const titleIsManual =
    typeof header.titleIsManual === 'boolean'
      ? header.titleIsManual
      : normalizeLegacySessionName(header.name) !== DEFAULT_SESSION_NAME;

  const backend = legacyBackend(header.backend);

  return {
    id: sessionId,
    workspaceRoot: header.workspaceRoot,
    cwd: header.cwd,
    ...(header.projectId !== undefined ? { projectId: header.projectId } : {}),
    createdAt: header.createdAt,
    lastUsedAt: header.lastUsedAt,
    ...(header.lastMessageAt !== undefined ? { lastMessageAt: header.lastMessageAt } : {}),
    name: header.name,
    titleIsManual,
    isFlagged: header.isFlagged,
    labels: (header.labels ?? []) as string[],
    isArchived: header.isArchived,
    ...(header.archivedAt !== undefined ? { archivedAt: header.archivedAt } : {}),
    status,
    ...(blockedReason !== undefined ? { blockedReason } : {}),
    statusUpdatedAt,
    ...(header.parentSessionId !== undefined ? { parentSessionId: header.parentSessionId } : {}),
    ...(header.branchOfTurnId !== undefined ? { branchOfTurnId: header.branchOfTurnId } : {}),
    // Legacy subagent lineage and per-session state that the pre-#1994 decoder
    // preserved by spreading the whole stored header. Dropping these silently
    // flattened subagent children into top-level sessions and lost
    // thinkingLevel / unread position.
    ...(header.subagentParent !== undefined ? { subagentParent: header.subagentParent } : {}),
    ...(header.subagentRuntime !== undefined ? { subagentRuntime: header.subagentRuntime } : {}),
    ...(header.subagentSpawn !== undefined ? { subagentSpawn: header.subagentSpawn } : {}),
    ...(header.subagentWorkspace !== undefined
      ? { subagentWorkspace: header.subagentWorkspace }
      : {}),
    ...(header.thinkingLevel !== undefined ? { thinkingLevel: header.thinkingLevel } : {}),
    ...(header.lastReadMessageId !== undefined
      ? { lastReadMessageId: header.lastReadMessageId }
      : {}),
    ...(header.revisionRootSessionId !== undefined
      ? { revisionRootSessionId: header.revisionRootSessionId }
      : {}),
    ...(header.revisionParentSessionId !== undefined
      ? { revisionParentSessionId: header.revisionParentSessionId }
      : {}),
    ...(header.revisionOfTurnId !== undefined ? { revisionOfTurnId: header.revisionOfTurnId } : {}),
    ...(header.revisionIndex !== undefined ? { revisionIndex: header.revisionIndex } : {}),
    ...(header.revisionState !== undefined ? { revisionState: header.revisionState } : {}),
    hasUnread: header.hasUnread,
    backend,
    llmConnectionSlug: header.llmConnectionSlug,
    connectionLocked: header.connectionLocked,
    model,
    permissionMode,
    collaborationMode,
    orchestrationMode,
    schemaVersion: 1,
  };
}

function legacyBackend(backend: unknown): SessionHeader['backend'] {
  if (backend === 'ai-sdk' || backend === 'claude') return 'ai-sdk';
  if (backend === 'pi-agent' || backend === 'pi') return 'pi-agent';
  return 'fake';
}

function resolveLegacyStatus(header: LegacyStoredSessionHeader): SessionHeader['status'] {
  if (header.isArchived) return 'archived';
  if (isSessionStatus(header.status) && header.status !== 'archived') return header.status;
  return 'active';
}

function normalizeLegacySessionName(name: string): string {
  return name === 'New Session' ? DEFAULT_SESSION_NAME : name;
}

/** The loose legacy header shape accepted by `decodeLegacySessionHeader`. */
type LegacyStoredSessionHeader = {
  workspaceRoot: string;
  cwd: string;
  projectId?: string | null;
  createdAt: number;
  lastUsedAt: number;
  lastMessageAt?: number;
  name: string;
  titleIsManual?: unknown;
  isFlagged: boolean;
  labels?: unknown;
  isArchived: boolean;
  archivedAt?: number;
  status?: unknown;
  blockedReason?: unknown;
  statusUpdatedAt?: number;
  parentSessionId?: string;
  branchOfTurnId?: string;
  subagentParent?: SessionHeader['subagentParent'];
  subagentRuntime?: SessionHeader['subagentRuntime'];
  subagentSpawn?: SessionHeader['subagentSpawn'];
  subagentWorkspace?: SessionHeader['subagentWorkspace'];
  thinkingLevel?: SessionHeader['thinkingLevel'];
  lastReadMessageId?: string;
  revisionRootSessionId?: string;
  revisionParentSessionId?: string;
  revisionOfTurnId?: string;
  revisionIndex?: number;
  revisionState?: 'preparing' | 'committed';
  hasUnread: boolean;
  backend: unknown;
  llmConnectionSlug: string;
  connectionLocked: boolean;
  model?: unknown;
  permissionMode?: unknown;
  collaborationMode?: unknown;
  orchestrationMode?: unknown;
};

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
