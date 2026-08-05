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
import type { SessionAuthorityStore } from './session-store.js';

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
 * Design:
 * - Runs once per session: idempotency key is the session id itself. We probe
 *   with `probeStableSessionCreate` and skip any id already present in SQLite,
 *   so re-running (e.g. after a partial failure or a second launch) is safe
 *   and does not duplicate data.
 * - Per-file atomicity: a file either imports completely (header + all
 *   messages) or is skipped and counted as failed. We never write a partial
 *   session, and we never silently degrade a corrupt record into a synthetic
 *   note in the new authoritative store.
 * - Best-effort: a malformed or unreadable file is reported in the result and
 *   never blocks startup or the import of other sessions.
 * - Legacy files are retained after import, honoring the repository policy
 *   that legacy stores are kept as migration evidence.
 *
 * The compatibility defaults mirror the old `decodeSessionHeader` (kept public
 * for one-way importers before #1994 deleted it): missing `permissionMode`
 * defaults to `ask`, `collaborationMode` to `agent`, `orchestrationMode` to
 * `default`, model to `default`, and `claude`/`pi` backends are remapped.
 * Final header validation happens inside `createStableSession` (the metadata
 * store runs `normalizeSessionHeader`), so this module does not re-implement
 * it.
 */

const LEGACY_SESSIONS_DIR = 'sessions';
const LEGACY_TRANSCRIPT_FILE = 'session.jsonl';

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
}

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
  const result: LegacySessionImportResult = { imported: 0, skipped: 0, failed: 0, failures: [] };
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
): Promise<'imported' | 'skipped'> {
  const { header, messages } = await readLegacyTranscript(transcriptPath, sessionId);

  // Idempotency: any session id already known to SQLite — whether imported by
  // an earlier run or created by the user — is left untouched.
  const probe = await store.probeStableSessionCreate(sessionId, LEGACY_IMPORT_FINGERPRINT);
  if (probe.kind !== 'absent') return 'skipped';

  const input = toCreateSessionInput(header);
  const created = await store.createStableSession({
    sessionId,
    requestFingerprint: LEGACY_IMPORT_FINGERPRINT,
    input,
  });
  // A concurrent process may have won the race between probe and create;
  // both `existing` and `conflict` mean the id is taken, so skip.
  if (created.kind !== 'created') return 'skipped';

  await store.appendMessages(sessionId, messages);

  // `createStableSession` stamps now-based timestamps and default flags; the
  // legacy header carries the real lifecycle facts, so restore them.
  await store.updateHeader(sessionId, legacyHeaderPatch(header, messages));

  return 'imported';
}

async function readLegacyTranscript(
  transcriptPath: string,
  sessionId: string,
): Promise<{ header: SessionHeader; messages: StoredMessage[] }> {
  const text = await readFile(transcriptPath, 'utf8');
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    throw new Error(`Legacy session ${sessionId} is empty`);
  }

  const header = decodeLegacySessionHeader(JSON.parse(lines[0]!), sessionId);
  const messages: StoredMessage[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
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
    permissionMode: header.permissionMode,
    collaborationMode: header.collaborationMode,
    orchestrationMode: header.orchestrationMode,
    ...(header.status !== undefined ? { status: header.status } : {}),
    ...(header.blockedReason !== undefined ? { blockedReason: header.blockedReason } : {}),
    labels: header.labels,
    ...(header.parentSessionId !== undefined ? { parentSessionId: header.parentSessionId } : {}),
    ...(header.branchOfTurnId !== undefined ? { branchOfTurnId: header.branchOfTurnId } : {}),
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
 * through `normalizeSessionHeader`, so the values must be canonically shaped.
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
