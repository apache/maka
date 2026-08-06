/**
 * Onboarding state machine (PR110a).
 *
 * Derives the first-run readiness state of a workspace from connections,
 * sessions, and per-connection secret availability. A legacy defaultSlug may
 * order valid candidates, but it is never an activation requirement. Pure &
 * sync — never reads credential store, fs, or
 * IPC. Caller is responsible for resolving async inputs (per-slug
 * `hasSecret` lookup) before calling.
 *
 * @kenji + @xuan PR110a review gates (locked):
 *
 *  1. Reuse send-path readiness criteria via
 *     `isConnectionReady()` — do not reimplement.
 *  2. `OnboardingState` is the **derived projection** of
 *     `(connections, sessions, secrets)`. It is NOT
 *     persisted; the renderer recomputes it on every change.
 *  3. `OnboardingMilestone` is the **persisted** companion (in
 *     settings.json). Its validator rejects extra fields, non-finite
 *     timestamps, negative timestamps, and entries with BOTH
 *     `completedAt` and `skippedAt`.
 *
 * Mapping (`ChatConfigurationReason` → `OnboardingState.kind`) is encoded
 * directly in `deriveOnboardingState()` because activation considers every
 * enabled model on every real connection before choosing a repair path.
 */

import {
  isConnectionReady,
  isRealConnection,
  normalizeOpenAiCodexConnection,
} from './connection-readiness.js';
import { connectionEnabledModelIds, type LlmConnection } from './llm-connections.js';
import type { SessionSummary } from './session.js';
export { hasSettledInitialOnboarding } from './onboarding-milestone.js';

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
 *  - `needs_connection_credentials` — a connection is missing a usable
 *    secret (API key / OAuth credential).
 *    Fix: open the credential-entry flow for the named slug.
 *  - `needs_model` — a credential-ready connection has no enabled,
 *    chat-capable model. Fix: open model management for the named slug.
 *  - `ready_empty` — fully configured, no sessions yet. #1433: this is
 *    no longer an onboarding surface — the ordinary empty chat state
 *    with its Composer takes over, and the hero renders nothing. Its
 *    connection/model pair is the readiness-checked first-task candidate;
 *    the configured connection default leads when it remains usable.
 *  - `ready_with_history` — fully configured, ≥1 session in the
 *    workspace (including archived / aborted — they are still user
 *    history and onboarding must not regress to blank slate). It retains the
 *    same readiness evidence, but does not activate first-task selection.
 *  - `blocked: all_connections_unhealthy` — real connections exist
 *    but NONE can be made ready by a per-connection fix (for example, all
 *    disabled or runtime-unwired).
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
  | { kind: 'needs_connection_credentials'; connectionSlug: string }
  | { kind: 'needs_model'; connectionSlug: string }
  | { kind: 'ready_empty'; connectionSlug: string; model: string }
  | { kind: 'ready_with_history'; connectionSlug: string; model: string }
  | { kind: 'blocked'; reason: 'all_connections_unhealthy' };

export interface DeriveOnboardingStateInput {
  /** All persisted LlmConnection rows the workspace knows about. */
  connections: ReadonlyArray<LlmConnection>;
  /** Legacy preference used only to order otherwise-valid candidates. */
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
 * Derivation order:
 *  1. No real connections at all → `needs_connection`.
 *  2. Walk every enabled model through the shared send-readiness authority;
 *     the first valid pair → `ready_empty` / `ready_with_history`.
 *  3. Classify the first actionable connection as
 *     `needs_connection_credentials` or `needs_model`.
 *  4. Fall-through: real connections exist but none can be made
 *     ready by a per-connection fix → `blocked: all_connections_unhealthy`.
 */
export function deriveOnboardingState(input: DeriveOnboardingStateInput): OnboardingState {
  const realConns = input.connections
    .filter((connection) => isRealConnection(connection))
    .map(normalizeOpenAiCodexConnection);
  if (realConns.length === 0) return { kind: 'needs_connection' };

  // A persisted workspace default is only a compatibility preference now, not
  // an activation gate. Every enabled model is validated by the same readiness
  // authority used by sessions:create; the returned pair lets the Composer use
  // that verdict without reimplementing credential readiness in the renderer.
  const preferred = input.defaultSlug
    ? realConns.find((connection) => connection.slug === input.defaultSlug)
    : undefined;
  const candidates = preferred
    ? [preferred, ...realConns.filter((connection) => connection.slug !== preferred.slug)]
    : realConns;
  for (const connection of candidates) {
    for (const model of connectionEnabledModelIds(connection)) {
      const verdict = isConnectionReady({
        connection,
        hasSecret: input.secrets[connection.slug] === true,
        requestedModel: model,
      });
      if (verdict.ready) {
        return hasHistory(input.sessions)
          ? { kind: 'ready_with_history', connectionSlug: connection.slug, model: verdict.model }
          : { kind: 'ready_empty', connectionSlug: connection.slug, model: verdict.model };
      }
    }
  }

  // No candidate can start a session. Route to the first connection with an
  // actionable repair, using the connection store's stable persisted order.
  for (const connection of candidates) {
    const requestedModel = connectionEnabledModelIds(connection)[0];
    const verdict = isConnectionReady({
      connection,
      hasSecret: input.secrets[connection.slug] === true,
      ...(requestedModel ? { requestedModel } : {}),
    });
    if (verdict.ready) continue;
    switch (verdict.reason) {
      case 'missing_api_key':
        return { kind: 'needs_connection_credentials', connectionSlug: connection.slug };
      case 'missing_model':
      case 'empty_model_list':
      case 'model_not_enabled':
      case 'model_not_chat_capable':
        return { kind: 'needs_model', connectionSlug: connection.slug };
      case 'connection_disabled':
      case 'fake_backend':
      case 'connection_missing':
      case 'missing_default_connection':
      case 'oauth_subscription_not_wired':
        break;
    }
  }

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
