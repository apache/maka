import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SessionHeader, StoredMessage, E2eFixtureScenario } from '@maka/core';

// Fixed clock for the e2e-fixture. All seeded timestamps and
// transient fixture state derive from this value unless tests explicitly
// pass `now`, so two runs produce identical visible time copy.
export const E2E_FIXTURE_NOW = Date.UTC(2026, 4, 22, 3, 0, 0);

export const TURN_SESSION_ID = 'e2e-fixture-turn';
export const LONG_TRANSCRIPT_SESSION_ID = 'e2e-fixture-long-transcript';
export const PROCESSING_SESSION_ID = 'e2e-fixture-processing';
export const STREAMING_SESSION_ID = 'e2e-fixture-streaming';
export const PERMISSION_SESSION_ID = 'e2e-fixture-permission';
export const WORKSTATION_RUNNING_SESSION_ID = 'e2e-fixture-ws-running';
export const WORKSTATION_WAITING_SESSION_ID = 'e2e-fixture-ws-waiting';
export const WORKSTATION_BLOCKED_AUTH_SESSION_ID = 'e2e-fixture-ws-blocked-auth';
export const WORKSTATION_BLOCKED_PERM_SESSION_ID = 'e2e-fixture-ws-blocked-perm';
export const WORKSTATION_BLOCKED_TOOL_SESSION_ID = 'e2e-fixture-ws-blocked-tool';
export const WORKSTATION_BLOCKED_UNKNOWN_SESSION_ID = 'e2e-fixture-ws-blocked-unknown';
export const WORKSTATION_ACTIVE_SESSION_ID = 'e2e-fixture-ws-active';
export const WORKSTATION_REVIEW_SESSION_ID = 'e2e-fixture-ws-review';
export const WORKSTATION_DONE_SESSION_ID = 'e2e-fixture-ws-done';
export const WORKSTATION_ARCHIVED_SESSION_ID = 'e2e-fixture-ws-archived';
export const WORKSTATION_ABORTED_SESSION_ID = 'e2e-fixture-ws-aborted';
export const ERROR_SESSION_ID = 'e2e-fixture-error';
export const ARTIFACT_SESSION_ID = 'e2e-fixture-artifact';
export const STALE_FAKE_SESSION_ID = 'e2e-fixture-stale-fake';
export const STALE_LEGACY_SESSION_ID = 'e2e-fixture-stale-legacy';
export const HEALTHY_SESSION_ID = 'e2e-fixture-healthy';
// PR109f (g): turn-control-history primary + branch sessions. The
// `BRANCH_ORPHAN` session's `parentSessionId` intentionally references
// a session id that is NEVER written to disk so the renderer's
// `deriveBranchBanner()` resolves the parent as missing and renders no
// banner in the negative screenshot case.
export const TURN_CONTROL_PRIMARY_SESSION_ID = 'e2e-fixture-turn-control-primary';
export const TURN_CONTROL_BRANCH_VISIBLE_SESSION_ID = 'e2e-fixture-turn-control-branch-visible';
export const TURN_CONTROL_BRANCH_ORPHAN_SESSION_ID = 'e2e-fixture-turn-control-branch-orphan';
export const TURN_CONTROL_ORPHAN_PARENT_ID = 'e2e-fixture-turn-control-deleted-parent';

/**
 * PR-SIDEBAR-IA-0 Phase 1: sidebar-long-sessions scenario seeds many
 * sessions with this prefix. Two digits → 60 distinct IDs (00..59).
 * Active session is always `${LONG_SIDEBAR_SESSION_PREFIX}00` (newest by
 * lastMessageAt). Path is short so it stays stable in screenshot
 * baselines.
 */
export const LONG_SIDEBAR_SESSION_PREFIX = 'e2e-fixture-sidebar-long-';
export const LONG_SIDEBAR_SESSION_COUNT = 60;

/**
 * Scenarios that share the long-sidebar (60-session) on-disk seed.
 * Kept as a Set so future scenarios reusing the same seed can be
 * registered in one place. Mirrors `TURN_CONTROL_SCENARIOS`.
 */
export const LONG_SIDEBAR_SCENARIOS = new Set<E2eFixtureScenario>([
  'module-skills',
  'module-daily-review',
  'plan-reminders',
  'sidebar-long-sessions',
  'sidebar-search-modal-open',
  'command-palette-open',
  'sidebar-row-actions-visible',
]);

/**
 * PR109f (g): scenarios that share the turn-control-history on-disk
 * seed. Keeps the trio listed in one place so a reviewer can confirm
 * they're variants of the same state family (active session differs,
 * everything else identical).
 */
export const TURN_CONTROL_SCENARIOS = new Set<E2eFixtureScenario>([
  'turn-control-history',
  'turn-control-branch-visible',
  'turn-control-branch-orphan',
]);

export function header(input: {
  id: string;
  name: string;
  connection: string;
  model: string;
  now: number;
  lastMessageAt: number;
  hasUnread?: boolean;
  /**
   * Override default `backend: 'ai-sdk'`. Used by stale-sessions fixture
   * to seed FakeBackend + legacy backend kinds. SessionHeader's BackendKind
   * union allows widening via `as unknown` for legacy values like
   * 'claude' that no longer exist in the type.
   */
  backend?: SessionHeader['backend'] | 'claude';
  connectionLocked?: boolean;
  /**
   * PR109b workstation-statuses fixture: override default
   * `status: 'active'` so seeded sessions land in every status group.
   */
  status?: SessionHeader['status'];
  blockedReason?: SessionHeader['blockedReason'];
  isArchived?: boolean;
  isFlagged?: boolean;
  orchestrationMode?: SessionHeader['orchestrationMode'];
}): SessionHeader {
  return {
    id: input.id,
    workspaceRoot: 'e2e-fixture',
    cwd: '/workspace/maka',
    createdAt: input.now - 3_600_000,
    lastUsedAt: input.lastMessageAt,
    lastMessageAt: input.lastMessageAt,
    name: input.name,
    titleIsManual: true,
    isFlagged: input.isFlagged ?? false,
    labels: [],
    isArchived: input.isArchived ?? false,
    status: input.status ?? 'active',
    ...(input.blockedReason ? { blockedReason: input.blockedReason } : {}),
    statusUpdatedAt: input.lastMessageAt,
    hasUnread: input.hasUnread ?? false,
    ...(input.orchestrationMode ? { orchestrationMode: input.orchestrationMode } : {}),
    // Legacy backend kinds like 'claude' aren't in the current BackendKind
    // union but are needed for the stale-sessions reproduction. Forward
    // the value verbatim into the JSONL so the renderer sees exactly what
    // a real legacy workspace would have on disk.
    backend: (input.backend ?? 'ai-sdk') as SessionHeader['backend'],
    llmConnectionSlug: input.connection,
    connectionLocked: input.connectionLocked ?? true,
    model: input.model,
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

export async function writeSession(workspaceRoot: string, session: SessionHeader, messages: StoredMessage[]): Promise<void> {
  const dir = join(workspaceRoot, 'sessions', session.id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'session.jsonl'),
    [session, ...messages].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    'utf8',
  );
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}
