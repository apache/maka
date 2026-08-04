/**
 * Onboarding service — main-process glue between the @maka/core
 * onboarding contract and the desktop stores/IPC (PR110b).
 *
 * The service produces `OnboardingSnapshot` via:
 *   1. ConnectionStore.list() + ConnectionStore.getDefault()
 *   2. Per-connection credential presence resolved in PARALLEL via
 *      `hasCredential` (@kenji PR110b perf gate — never serialize
 *      these lookups). `hasCredential` covers BOTH API-key connections
 *      and OAuth-subscription connections (Claude/Codex), and MUST be
 *      read-only — it must never refresh an OAuth token or otherwise
 *      mutate credential state just because onboarding status was
 *      read. See `hasConnectionSecret` in main.ts for the production
 *      wiring and why it deliberately does NOT reuse the send-path's
 *      refreshing `resolveConnectionSecret`.
 *   3. SessionStore.list() (the runtime layer's listSessions handles
 *      this for us; we pass it in as a callback)
 *   4. SettingsStore.get() for milestones (already sanitized by
 *      normalizeSettings on read)
 *   5. `deriveOnboardingState()` from @maka/core
 *
 * The service NEVER throws credential errors to the renderer; a
 * failed credential lookup is treated as "no credential" with a
 * generalized dev-safe log line.
 *
 * Milestone input validation lives here too: setMilestone arguments
 * are checked against the closed enum + status union before reaching
 * the SettingsStore.
 */

import {
  collapseSessionRevisions,
  deriveOnboardingState,
  hasSettledInitialOnboarding,
  ONBOARDING_MILESTONE_IDS,
  projectSessionSendOutcome,
  type ChatModelChoice,
  type OnboardingMilestone,
  type OnboardingMilestoneId,
  type OnboardingState,
  type SessionSummary,
  type SessionSendProjection,
} from '@maka/core';
import { buildChatModelChoices } from '@maka/core/chat-model-choice';
import type { LlmConnection } from '@maka/core/llm-connections';

export interface OnboardingSnapshot {
  state: OnboardingState;
  milestones: OnboardingMilestone[];
  /**
   * Session list, included so the renderer can populate the sidebar
   * without a separate `sessions:list` IPC.
   */
  sessions: SessionSummary[];
  /** Connection list — bundled to avoid a separate `connections:list` + `getDefault` IPC. */
  connections: LlmConnection[];
  defaultSlug: string | null;
  chatModelChoices: ChatModelChoice[];
  sessionSendOutcomes: Record<string, SessionSendProjection>;
}

export interface OnboardingServiceDeps {
  listConnections(): Promise<LlmConnection[]>;
  getDefaultSlug(): Promise<string | null>;
  listSessions(): Promise<SessionSummary[]>;
  getMilestones(): Promise<OnboardingMilestone[]>;
  upsertMilestone(
    id: OnboardingMilestoneId,
    status: 'completed' | 'skipped',
  ): Promise<OnboardingMilestone[]>;
  clearMilestone(id: OnboardingMilestoneId): Promise<OnboardingMilestone[]>;
  /**
   * Whether `connection` has a usable credential — an API key OR (for
   * OAuth-subscription providers) a stored OAuth token. MUST be
   * read-only: implementations must not refresh tokens or otherwise
   * mutate credential state as a side effect of this check.
   */
  hasCredential(connection: LlmConnection): Promise<boolean>;
}

export interface OnboardingService {
  getSnapshot(): Promise<OnboardingSnapshot>;
  setMilestone(
    id: unknown,
    status: unknown,
  ): Promise<OnboardingSnapshot>;
  clearMilestone(id: unknown): Promise<OnboardingSnapshot>;
}

/**
 * Build the desktop OnboardingService. The constructor takes injected
 * deps (rather than reading the global stores) so the service is
 * trivially unit-testable: a fake `OnboardingServiceDeps` mirrors the
 * real stores in tests.
 */
export function createOnboardingService(deps: OnboardingServiceDeps): OnboardingService {
  return {
    async getSnapshot(): Promise<OnboardingSnapshot> {
      const [connections, defaultSlug, sessions, milestones] = await Promise.all([
        deps.listConnections(),
        deps.getDefaultSlug(),
        deps.listSessions(),
        deps.getMilestones(),
      ]);

      // @kenji PR110b perf gate: per-connection credential lookup must
      // run in parallel, NOT serialized. Even with 4-5 connections,
      // async credential-store reads can add up to noticeable startup
      // latency on cold open.
      const secretEntries = await Promise.all(
        connections.map(async (connection) => {
          try {
            const hasSecret = await deps.hasCredential(connection);
            return [connection.slug, hasSecret] as const;
          } catch (error) {
            // @kenji + @xuan PR110b gate: credential errors must NOT
            // leak to the renderer. Log a generalized dev-safe line
            // and treat the connection as having no secret. The user
            // ends up on `needs_connection_credentials` for that
            // slug, which is the right user-facing fix path anyway.
            console.warn(
              `[onboarding] failed to read credential for ${connection.slug}; treating as missing.`,
              describeErrorClass(error),
            );
            return [connection.slug, false] as const;
          }
        }),
      );
      const secrets: Record<string, boolean> = Object.fromEntries(secretEntries);

      const logicalSessions = collapseSessionRevisions(sessions);
      const state = deriveOnboardingState({
        connections,
        defaultSlug: defaultSlug ?? undefined,
        sessions: logicalSessions,
        secrets,
      });

      // Backfill: existing users who already have sessions but no
      // initial_onboarding milestone (upgraded from before this PR)
      // get auto-marked as completed so the hero never appears.
      if (logicalSessions.length > 0 && !hasSettledInitialOnboarding(milestones)) {
        const updated = await deps.upsertMilestone('initial_onboarding', 'completed');
        return buildSnapshot(state, updated, sessions, connections, defaultSlug, secrets);
      }

      return buildSnapshot(state, milestones, sessions, connections, defaultSlug, secrets);
    },

    async setMilestone(id: unknown, status: unknown): Promise<OnboardingSnapshot> {
      // Strict input validation BEFORE touching the store.
      if (typeof id !== 'string' || !isOnboardingMilestoneId(id)) {
        throw new Error('INVALID_MILESTONE_ID');
      }
      if (status !== 'completed' && status !== 'skipped') {
        throw new Error('INVALID_MILESTONE_STATUS');
      }
      // Timestamp is stamped inside the store (Date.now()); renderer
      // never controls it.
      const milestones = await deps.upsertMilestone(id, status);
      // After the write, re-derive snapshot. State could change (e.g.
      // the user finished `first_chat_sent` while in `ready_empty`
      // → next derive should reflect new history). Re-using the
      // already-fetched milestones avoids a settings round-trip.
      const [connections, defaultSlug, sessions] = await Promise.all([
        deps.listConnections(),
        deps.getDefaultSlug(),
        deps.listSessions(),
      ]);
      const secretEntries = await Promise.all(
        connections.map(async (connection) => {
          try {
            return [connection.slug, await deps.hasCredential(connection)] as const;
          } catch {
            return [connection.slug, false] as const;
          }
        }),
      );
      const secrets: Record<string, boolean> = Object.fromEntries(secretEntries);
      const logicalSessions = collapseSessionRevisions(sessions);
      const state = deriveOnboardingState({
        connections,
        defaultSlug: defaultSlug ?? undefined,
        sessions: logicalSessions,
        secrets,
      });
      return buildSnapshot(state, milestones, sessions, connections, defaultSlug, secrets);
    },

    async clearMilestone(id: unknown): Promise<OnboardingSnapshot> {
      if (typeof id !== 'string' || !isOnboardingMilestoneId(id)) {
        throw new Error('INVALID_MILESTONE_ID');
      }
      const milestones = await deps.clearMilestone(id);
      const [connections, defaultSlug, sessions] = await Promise.all([
        deps.listConnections(),
        deps.getDefaultSlug(),
        deps.listSessions(),
      ]);
      const secretEntries = await Promise.all(
        connections.map(async (connection) => {
          try {
            return [connection.slug, await deps.hasCredential(connection)] as const;
          } catch {
            return [connection.slug, false] as const;
          }
        }),
      );
      const secrets: Record<string, boolean> = Object.fromEntries(secretEntries);
      const logicalSessions = collapseSessionRevisions(sessions);
      const state = deriveOnboardingState({
        connections,
        defaultSlug: defaultSlug ?? undefined,
        sessions: logicalSessions,
        secrets,
      });
      return buildSnapshot(state, milestones, sessions, connections, defaultSlug, secrets);
    },
  };
}

function buildSnapshot(
  state: OnboardingState,
  milestones: OnboardingMilestone[],
  sessions: SessionSummary[],
  connections: LlmConnection[],
  defaultSlug: string | null,
  secrets: Readonly<Record<string, boolean>>,
): OnboardingSnapshot {
  return {
    state,
    milestones,
    sessions,
    connections,
    defaultSlug: defaultSlug ?? null,
    chatModelChoices: buildChatModelChoices(connections),
    sessionSendOutcomes: Object.fromEntries(
      sessions.map((session) => [
        session.id,
        projectSessionSendOutcome({
          session,
          connections,
          defaultSlug,
          hasSecret: (slug) => secrets[slug] ?? false,
        }),
      ]),
    ),
  };
}

function isOnboardingMilestoneId(value: string): value is OnboardingMilestoneId {
  return (ONBOARDING_MILESTONE_IDS as readonly string[]).includes(value);
}

/**
 * Return a generalized error class string ('error_name' or 'unknown')
 * suitable for dev logs. We never log the underlying error message
 * because it might contain credential bytes / paths / etc.
 */
function describeErrorClass(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  return 'unknown';
}

/**
 * Bind helpers that wire the live `SettingsStore` + `ConnectionStore`
 * + credential store to `OnboardingServiceDeps`. Exposed separately so
 * tests can mix-and-match: real settings store + fake credential store,
 * etc.
 */
export function bindOnboardingDeps(input: {
  settingsStore: {
    get(): Promise<{ onboarding: { milestones: OnboardingMilestone[] } }>;
    upsertOnboardingMilestone(
      id: OnboardingMilestoneId,
      status: 'completed' | 'skipped',
    ): Promise<OnboardingMilestone[]>;
    clearOnboardingMilestone(id: OnboardingMilestoneId): Promise<OnboardingMilestone[]>;
  };
  connectionStore: {
    list(): Promise<LlmConnection[]>;
    getDefault(): Promise<string | null>;
  };
  /**
   * Read-only credential-presence check, covering both API-key
   * connections (credential store) and OAuth-subscription connections
   * (claude-subscription / openai-codex stored tokens). Callers
   * must pass a resolver that NEVER refreshes an OAuth token or
   * otherwise mutates credential state — see `hasConnectionSecret` in
   * main.ts, which deliberately does not reuse the send-path's
   * refreshing `resolveConnectionSecret`. A resolver that only checks
   * the API-key credential store makes every OAuth-subscription
   * connection look like it's missing credentials, even when it's the
   * verified default.
   */
  hasCredential(connection: LlmConnection): Promise<boolean>;
  listSessions(): Promise<SessionSummary[]>;
}): OnboardingServiceDeps {
  return {
    listConnections: () => input.connectionStore.list(),
    getDefaultSlug: () => input.connectionStore.getDefault(),
    listSessions: () => input.listSessions(),
    getMilestones: async () => (await input.settingsStore.get()).onboarding.milestones,
    upsertMilestone: (id, status) => input.settingsStore.upsertOnboardingMilestone(id, status),
    clearMilestone: (id) => input.settingsStore.clearOnboardingMilestone(id),
    hasCredential: (connection) => input.hasCredential(connection),
  };
}
