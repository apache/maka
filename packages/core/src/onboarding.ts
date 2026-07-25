/**
 * Onboarding state machine (PR110a).
 *
 * Derives the first-run readiness state of a workspace
 * from connections + defaultSlug + sessions + per-connection secret
 * availability. Pure & sync — never reads credential store, fs, or
 * IPC. Caller is responsible for resolving async inputs (per-slug
 * `hasSecret` lookup) before calling.
 *
 * @kenji + @xuan PR110a review gates (locked):
 *
 *  1. Reuse send-path readiness criteria via
 *     `isConnectionReady()` — do not reimplement.
 *  2. `OnboardingState` is the **derived projection** of
 *     `(connections, defaultSlug, sessions, secrets)`. It is NOT
 *     persisted; the renderer recomputes it on every change.
 *  3. `OnboardingMilestone` is the **persisted** companion (in
 *     settings.json). Its validator rejects extra fields, non-finite
 *     timestamps, negative timestamps, and entries with BOTH
 *     `completedAt` and `skippedAt`.
 *
 * Mapping (`ChatConfigurationReason` → `OnboardingState.kind`) is
 * encoded directly in `deriveOnboardingState()` rather than a table,
 * because some reasons are conditional on the rest of the connection
 * list (e.g. `connection_disabled` on the default slug becomes
 * `needs_default_connection` if there's a ready alternative, but
 * `blocked: all_connections_unhealthy` otherwise).
 */

import { isConnectionReady, isRealConnection } from './connection-readiness.js';
import type { LlmConnection } from './llm-connections.js';
import type { SessionSummary } from './session.js';

// ============================================================================
// OnboardingState (derived; never persisted)
// ============================================================================

/**
 * The single piece of state the onboarding UI uses to decide what to
 * show. Each variant maps to a single user-actionable fix path.
 *
 * Locked PR110a variants (extend with care — every new variant needs
 * a UI fix path AND a derivation test case):
 *
 *  - `needs_connection` — no real connections exist at all. Fix:
 *    walk the user through the add-provider flow.
 *  - `needs_default_connection` — at least one ready real connection
 *    exists, but the persisted `defaultSlug` does not point to it
 *    (unset, missing, points to a fake/disabled connection). Fix:
 *    show the connection list and let the user pick one.
 *  - `needs_connection_credentials` — the default connection exists
 *    but is missing a usable secret (API key / OAuth credential).
 *    Fix: open the credential-entry flow for the named slug.
 *  - `needs_default_model` — the default connection has a usable
 *    secret but no valid model (no defaultModel, empty model list,
 *    persisted defaultModel is no longer enabled, or the model is not
 *    chat-capable). Fix:
 *    open the model picker for the named slug.
 *  - `ready_empty` — fully configured, no sessions yet. #1433: this is
 *    no longer an onboarding surface — the ordinary empty chat state
 *    with its Composer takes over, and the hero renders nothing.
 *  - `ready_with_history` — fully configured, ≥1 session in the
 *    workspace (including archived / aborted — they are still user
 *    history and onboarding must not regress to blank slate).
 *  - `blocked: all_connections_unhealthy` — real connections exist
 *    but NONE can be made ready by a per-connection fix (all
 *    disabled, all missing keys with no defaultSlug to focus, etc.).
 *    Fix: show a "fix your connections" hint pointing at Settings.
 *
 * Note: `blocked.reason` carries only `all_connections_unhealthy` in
 * the v1 enum. The shape `{ kind: 'blocked'; reason: ... }` is
 * preserved for future-proofing (e.g. provider outage detection).
 * `no_real_connection` is intentionally NOT a derived state — the
 * only-fake case rolls back to `needs_connection` because the fix
 * path is the same as having zero connections (add a real one).
 */
export type OnboardingState =
  | { kind: 'needs_connection' }
  | { kind: 'needs_default_connection' }
  | { kind: 'needs_connection_credentials'; connectionSlug: string }
  | { kind: 'needs_default_model'; connectionSlug: string }
  | { kind: 'ready_empty'; defaultConnectionSlug: string; defaultModel: string }
  | { kind: 'ready_with_history'; defaultConnectionSlug: string; defaultModel: string }
  | { kind: 'blocked'; reason: 'all_connections_unhealthy' };

export interface DeriveOnboardingStateInput {
  /** All persisted LlmConnection rows the workspace knows about. */
  connections: ReadonlyArray<LlmConnection>;
  /** The slug the user has chosen as default, if any. */
  defaultSlug?: string | null;
  /**
   * All sessions known to storage. `ready_with_history` counts ANY
   * non-deleted session, including archived and aborted ones — those
   * are still user history.
   */
  sessions: ReadonlyArray<SessionSummary>;
  /**
   * Map of `slug → hasSecret` for every real connection in
   * `connections`. Caller resolves this asynchronously (credential
   * store / IPC) before calling. Slugs not present in the map are
   * treated as `false`.
   */
  secrets: Readonly<Record<string, boolean>>;
}

/**
 * Derive the current `OnboardingState` from inputs. Pure function —
 * same input always produces the same output.
 *
 * Derivation order (matches PR110a test matrix #1-#15):
 *  1. No real connections at all → `needs_connection`.
 *  2. Default slug points to a ready real connection → `ready_empty`
 *     / `ready_with_history`.
 *  3. At least one real connection is ready but it's not the default
 *     → `needs_default_connection` (user picks from the list).
 *  4. Default slug is set and points to a real connection that's not
 *     ready: classify by reason → `needs_connection_credentials` /
 *     `needs_default_model` / fall through.
 *  5. Default slug is unset or points to a missing/fake connection
 *     → `needs_default_connection`.
 *  6. Fall-through: real connections exist but none can be made
 *     ready by a per-connection fix → `blocked: all_connections_unhealthy`.
 */
export function deriveOnboardingState(input: DeriveOnboardingStateInput): OnboardingState {
  const realConns = input.connections.filter((conn) => isRealConnection(conn));
  if (realConns.length === 0) return { kind: 'needs_connection' };

  const slugToConnection = new Map(realConns.map((conn) => [conn.slug, conn]));
  const defaultConn = input.defaultSlug ? slugToConnection.get(input.defaultSlug) : undefined;

  const readyDefault = defaultConn
    ? isConnectionReady({
        connection: defaultConn,
        hasSecret: input.secrets[defaultConn.slug] === true,
      })
    : undefined;

  if (readyDefault?.ready === true && defaultConn) {
    return hasHistory(input.sessions)
      ? {
          kind: 'ready_with_history',
          defaultConnectionSlug: defaultConn.slug,
          defaultModel: readyDefault.model,
        }
      : {
          kind: 'ready_empty',
          defaultConnectionSlug: defaultConn.slug,
          defaultModel: readyDefault.model,
        };
  }

  // Default is not ready. Is there another real connection that IS
  // ready? If so, the user just needs to switch the default.
  const anyRealReady = realConns.some(
    (conn) =>
      isConnectionReady({ connection: conn, hasSecret: input.secrets[conn.slug] === true }).ready,
  );
  if (anyRealReady) return { kind: 'needs_default_connection' };

  // No real connection is ready. Classify by the default's failure
  // reason, when there IS a default real connection. The reason
  // drives which targeted fix UI to show.
  if (defaultConn && readyDefault && readyDefault.ready === false) {
    switch (readyDefault.reason) {
      case 'missing_api_key':
        return { kind: 'needs_connection_credentials', connectionSlug: defaultConn.slug };
      case 'missing_model':
      case 'empty_model_list':
      case 'model_not_enabled':
      case 'model_not_chat_capable':
        return { kind: 'needs_default_model', connectionSlug: defaultConn.slug };
      case 'connection_disabled':
      case 'fake_backend':
      case 'connection_missing':
      case 'missing_default_connection':
      case 'oauth_subscription_not_wired':
        // No actionable per-connection fix path; fall through.
        break;
    }
  }

  // Default slug is unset, OR it points to a non-real / missing
  // connection. The user must pick a default first.
  if (!defaultConn) return { kind: 'needs_default_connection' };

  // Real connections exist but none can be made ready by a
  // per-connection fix.
  return { kind: 'blocked', reason: 'all_connections_unhealthy' };
}

/**
 * Whether the workspace has any user history. Archived and aborted
 * sessions ARE history (PR110a contract gate).
 *
 * SessionSummary in V0.2 has no `deletedAt` field — deletion is
 * implemented by removing the session directory from disk, so any
 * SessionSummary the caller passes in is by definition "not deleted".
 */
function hasHistory(sessions: ReadonlyArray<SessionSummary>): boolean {
  return sessions.length > 0;
}

// ============================================================================
// OnboardingMilestone (persisted in settings.json)
// ============================================================================

/**
 * Closed enum of milestones the onboarding flow can track. Adding a
 * new milestone requires extending this list AND the matching UI
 * surface that drives it. The rule runs both ways: #1433 deleted the
 * first-run task-suggestion cards, so the four
 * `first_run_suggestion_*` ids went with them rather than lingering
 * as a list nothing reads. Removal is safe for already-persisted
 * settings — `sanitizeOnboardingMilestones()` drops ids outside this
 * enum instead of rejecting the file.
 *
 * Persisted in `settings.json` (new `onboarding` section, PR110b).
 * Renderer must NEVER persist anything else under a milestone — see
 * the `sanitizeOnboardingMilestones()` validator for the full
 * field-set gate.
 */
export const ONBOARDING_MILESTONE_IDS = [
  'initial_onboarding',
  'first_chat_sent',
  'first_personalization',
  'first_model_swap',
  'first_artifact_open',
] as const;

export type OnboardingMilestoneId = (typeof ONBOARDING_MILESTONE_IDS)[number];

export interface OnboardingMilestone {
  id: OnboardingMilestoneId;
  /** Unix epoch ms when the user completed this milestone. */
  completedAt?: number;
  /** Unix epoch ms when the user explicitly skipped this milestone. */
  skippedAt?: number;
}

/**
 * Type guard with strict schema validation. Rejects:
 *   - non-object / null / array input
 *   - `id` that is not a known `OnboardingMilestoneId`
 *   - non-finite or negative timestamps (`NaN`, `Infinity`, `-1`, strings)
 *   - entries with BOTH `completedAt` and `skippedAt` set
 *   - any extra fields beyond `{ id, completedAt, skippedAt }`
 *
 * @kenji + @xuan PR110a review gate: any future leak of prompt text
 * / provider error / user content into a milestone must fail this
 * gate. Don't relax it.
 */
export function isOnboardingMilestone(value: unknown): value is OnboardingMilestone {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  // Plain-object check per @kenji + @xuan PR110a review. Rejects
  // `Date`, `RegExp`, `Map`, `Set`, and any other object whose
  // prototype isn't `Object.prototype` or `null` (Object.create(null)).
  // Without this guard, `new Date()` would pass the typeof check and
  // we'd start digging into its own keys.
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return false;
  const record = value as Record<string, unknown>;

  // Required `id` from the closed enum.
  if (typeof record.id !== 'string') return false;
  if (!(ONBOARDING_MILESTONE_IDS as readonly string[]).includes(record.id)) return false;

  // No extra fields beyond the documented set.
  const allowed = new Set(['id', 'completedAt', 'skippedAt']);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) return false;
  }

  const completedAt = record.completedAt;
  const skippedAt = record.skippedAt;

  if (completedAt !== undefined && !isValidTimestamp(completedAt)) return false;
  if (skippedAt !== undefined && !isValidTimestamp(skippedAt)) return false;

  // At-most-one terminal timestamp.
  if (completedAt !== undefined && skippedAt !== undefined) return false;

  return true;
}

/**
 * Settings read-path sanitizer. Accepts the raw value from
 * `settings.json`, drops invalid entries, and returns the valid ones.
 *
 * Strategy per @kenji + @xuan PR110a review: "drop invalid entries,
 * keep valid ones" — better than fail-empty because a single bad
 * entry should not erase the user's whole milestone progress.
 *
 * Returns an empty array if the input is not an array at all.
 *
 * **Dedup policy: last-valid-entry wins, deterministic.** If a
 * milestone id appears more than once after invalid entries are
 * dropped, the LAST valid occurrence's VALUE survives, but the
 * RESULTING ARRAY POSITION is the FIRST-seen index of that id.
 *
 * Worked example:
 *   input:  [{ id: A, completedAt: 1 },
 *            { id: B, completedAt: 10 },
 *            { id: A, completedAt: 2 }]
 *   output: [{ id: A, completedAt: 2 },   // value from last A,
 *                                         //   position from first A
 *            { id: B, completedAt: 10 }]
 *
 * Rationale (@kenji PR110a review): milestone is a user-progress
 * snapshot, not an audit log; later entries reflect newer state. A
 * `{ id }` placeholder followed by `{ id, completedAt: T }` must
 * produce `completedAt: T` — anything else loses the terminal
 * transition. Stable first-seen position protects consumers from
 * re-orderings every time the user updates a single milestone.
 *
 * The settings WRITE path (PR110b) is responsible for upserting
 * milestones in place, so legitimate progressions never produce
 * duplicates that reach this sanitizer.
 */
export function sanitizeOnboardingMilestones(raw: unknown): OnboardingMilestone[] {
  if (!Array.isArray(raw)) return [];
  // Map.set updates the value but preserves the original insertion
  // position — so we get last-value-wins with first-seen ordering.
  const dedup = new Map<OnboardingMilestoneId, OnboardingMilestone>();
  for (const entry of raw) {
    if (!isOnboardingMilestone(entry)) continue;
    dedup.set(entry.id, entry);
  }
  return Array.from(dedup.values());
}

function isValidTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Whether the initial onboarding has been settled (completed or
 * skipped). Used by the renderer to gate `showOnboardingHero` so
 * onboarding is a one-time guide, not a gate that revives when
 * the user deletes all sessions.
 */
export function hasSettledInitialOnboarding(
  milestones: ReadonlyArray<OnboardingMilestone>,
): boolean {
  return milestones.some(
    (m) =>
      m.id === 'initial_onboarding' && (m.completedAt !== undefined || m.skippedAt !== undefined),
  );
}
