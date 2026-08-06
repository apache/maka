import { createHash } from 'node:crypto';
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
  type CreateSessionInput,
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
 * - Runs once per session: idempotency key is the session id itself. We probe
 *   with `probeStableSessionCreate` first and skip any id already present in
 *   SQLite, so re-running (e.g. after a partial failure or a second launch)
 *   is safe and does not duplicate data — and the probe runs BEFORE the
 *   expensive file read, so every launch of an upgraded install skips known
 *   ids without touching the transcript.
 * - Per-file atomicity: a file either imports completely (header + all
 *   messages) or is skipped and counted as failed. The decoded header and the
 *   post-create header patch are validated through `normalizeSessionHeader`
 *   BEFORE any write, so the three store writes (create → append → update)
 *   cannot fail validation after two of three commits — the failure mode that
 *   used to leave a permanent partial session.
 * - Best-effort: a malformed or unreadable file is reported in the result and
 *   never blocks startup or the import of other sessions.
 * - Legacy files are retained after import, honoring the repository policy
 *   that legacy stores are kept as migration evidence.
 * - Legacy subagent children (real on-disk sessions before the cutover) are
 *   routed through `createSubagent` so their parent/child lineage is kept; a
 *   subagent header whose spawn identity is incomplete fails the file instead
 *   of silently flattening into a top-level session.
 *
 * The compatibility defaults mirror the old `decodeSessionHeader` (kept public
 * for one-way importers before #1994 deleted it): missing `permissionMode`
 * defaults to `ask`, `collaborationMode` to `agent`, `orchestrationMode` to
 * `default`, model to `default`, and `claude`/`pi` backends are remapped.
 */

const LEGACY_SESSIONS_DIR = 'sessions';
const LEGACY_TRANSCRIPT_FILE = 'session.jsonl';
const SESSION_TRANSCRIPT_MARKER_TYPE = 'session_transcript';

/**
 * Stable request fingerprint for legacy imports. `createStableSession`
 * requires a `sha256:` fingerprint; using a constant derived from this
 * module's identity makes every import of the same session id the "same
 * request", so concurrent first-launch processes converge on one winner.
 */
const LEGACY_IMPORT_FINGERPRINT = `sha256:${createHash('sha256')
  .update('maka-legacy-session-import')
  .digest('hex')}`;

export interface LegacySessionImportResult {
  imported: number;
  skipped: number;
  failed: number;
  failures: Array<{ sessionId: string; error: string }>;
  /** `skipped` where the session id already existed in SQLite (already imported, or a concurrent process won the race). */
  skippedExisting: number;
  /** `skipped` where the session id was claimed by a different request fingerprint or tombstoned. */
  skippedCollision: number;
}

type LegacySessionFileOutcome =
  | { kind: 'imported' }
  | { kind: 'skipped'; reason: 'existing' | 'conflict' };

/**
 * Import all legacy `sessions/<session-id>/session.jsonl` transcripts under
 * `workspaceRoot` into the SQLite-backed session store.
 *
 * The store must be open (a `createSessionStore(workspaceRoot)` instance is
 * ready immediately). Idempotent; safe to call on every launch.
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
    skippedExisting: 0,
    skippedCollision: 0,
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
      const outcome = await importLegacySessionFile(store, sessionId, transcriptPath);
      if (outcome.kind === 'imported') {
        result.imported += 1;
      } else {
        result.skipped += 1;
        if (outcome.reason === 'conflict') {
          result.skippedCollision += 1;
        } else {
          result.skippedExisting += 1;
        }
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
  // Idempotency probe FIRST: any session id already known to SQLite — whether
  // imported by an earlier run, created by the user, or claimed by a
  // concurrent first-launch process — is left untouched, and we never read or
  // parse its transcript on later launches.
  const probe = await store.probeStableSessionCreate(sessionId, LEGACY_IMPORT_FINGERPRINT);
  if (probe.kind === 'existing') return { kind: 'skipped', reason: 'existing' };
  if (probe.kind === 'conflict') return { kind: 'skipped', reason: 'conflict' };

  const { header, messages } = await readLegacyTranscript(transcriptPath, sessionId);

  // Validate BEFORE any write. `createStableSession` and `updateHeader` both
  // re-validate through `normalizeSessionHeader`; the old flow let the update
  // (the third of three transactions) throw after create+append had already
  // committed, leaving a permanent partial session that the next run's probe
  // would report as "skipped". Validating the decoded header AND the final
  // post-patch shape here moves that failure before the first write.
  const normalized = normalizeSessionHeader(header);
  const patch = legacyHeaderPatch(header, messages);
  normalizeSessionHeader({ ...normalized, ...patch }, sessionId);

  const input = toCreateSessionInput(header);
  if (header.subagentParent) {
    // Legacy subagent children carry parent/runtime/spawn metadata; route
    // through createSubagent so lineage is preserved. A malformed/incomplete
    // spawn identity throws (requireSubagentSpawnIdentity) and fails the file
    // rather than flattening the child into a top-level session.
    const created = await store.createSubagent(input);
    if (!created.created) return { kind: 'skipped', reason: 'existing' };
  } else {
    const created = await store.createStableSession({
      sessionId,
      requestFingerprint: LEGACY_IMPORT_FINGERPRINT,
      input,
    });
    // A concurrent process may have won the race between probe and create;
    // both `existing` and `conflict` mean the id is taken, so skip.
    if (created.kind !== 'created') {
      return { kind: 'skipped', reason: created.kind };
    }
  }

  await store.appendMessages(sessionId, messages);

  // `createStableSession`/`createSubagent` stamp now-based timestamps and
  // default flags; the legacy header carries the real lifecycle facts, so
  // restore them. The final shape was pre-validated above, so this update
  // cannot fail validation.
  await store.updateHeader(sessionId, patch);

  return { kind: 'imported' };
}

async function readLegacyTranscript(
  transcriptPath: string,
  sessionId: string,
): Promise<{ header: SessionHeader; messages: StoredMessage[] }> {
  const text = await readFile(transcriptPath, 'utf8');
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
      // The classic interrupted-append artifact: a final line cut off mid-write.
      // The pre-#1994 strict reader skipped such a torn tail; the rest of the
      // file is intact and still imports.
      if (isLastContentLine(rawLines, index)) break;
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

function isLastContentLine(rawLines: string[], index: number): boolean {
  for (let i = index + 1; i < rawLines.length; i += 1) {
    if (rawLines[i]!.trim().length > 0) return false;
  }
  return true;
}

/**
 * The legacy header was a loose JSON object (some fields optional, old
 * backends named differently). This mirrors the pre-#1994 `decodeSessionHeader`
 * compatibility rules; the final strict shape is enforced by the metadata
 * store's `normalizeSessionHeader` on create.
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

function toCreateSessionInput(header: SessionHeader): CreateSessionInput {
  return {
    cwd: header.cwd,
    ...(header.projectId !== undefined ? { projectId: header.projectId } : {}),
    name: header.name,
    backend: header.backend,
    llmConnectionSlug: header.llmConnectionSlug,
    model: header.model,
    ...(header.thinkingLevel !== undefined ? { thinkingLevel: header.thinkingLevel } : {}),
    permissionMode: header.permissionMode,
    collaborationMode: header.collaborationMode,
    orchestrationMode: header.orchestrationMode,
    ...(header.status !== undefined ? { status: header.status } : {}),
    ...(header.blockedReason !== undefined ? { blockedReason: header.blockedReason } : {}),
    labels: header.labels,
    ...(header.parentSessionId !== undefined ? { parentSessionId: header.parentSessionId } : {}),
    ...(header.branchOfTurnId !== undefined ? { branchOfTurnId: header.branchOfTurnId } : {}),
    ...(header.subagentParent !== undefined ? { subagentParent: header.subagentParent } : {}),
    ...(header.subagentRuntime !== undefined ? { subagentRuntime: header.subagentRuntime } : {}),
    ...(header.subagentSpawn !== undefined ? { subagentSpawn: header.subagentSpawn } : {}),
    ...(header.subagentWorkspace !== undefined
      ? { subagentWorkspace: header.subagentWorkspace }
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
  };
}

/**
 * Fields `buildSessionHeader` cannot express (it stamps `Date.now()` and
 * default flags) but the legacy header carries. `updateHeader` re-validates
 * through `normalizeSessionHeader`, so the values must be canonically shaped —
 * `importLegacySessionFile` pre-validates this exact merged shape before the
 * first write.
 */
function legacyHeaderPatch(
  header: SessionHeader,
  messages: readonly StoredMessage[],
): Partial<SessionHeader> {
  const hasUserMessage = messages.some((message) => message.type === 'user');
  return {
    createdAt: header.createdAt,
    lastUsedAt: header.lastUsedAt,
    ...(header.lastMessageAt !== undefined ? { lastMessageAt: header.lastMessageAt } : {}),
    statusUpdatedAt: header.statusUpdatedAt,
    titleIsManual: header.titleIsManual,
    isFlagged: header.isFlagged,
    isArchived: header.isArchived,
    ...(header.archivedAt !== undefined ? { archivedAt: header.archivedAt } : {}),
    hasUnread: header.hasUnread,
    connectionLocked: header.connectionLocked || hasUserMessage,
  };
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
