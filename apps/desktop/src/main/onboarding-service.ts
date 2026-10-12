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
 *      read. Production wiring queries the Runtime Host credential
 *      projection without resolving or refreshing credential material.
 *   3. SessionStore.list() (the runtime layer's listSessions handles
 *      this for us; we pass it in as a callback)
 *   4. SettingsStore.get() for milestones (already sanitized by
 *      normalizeSettings on read)
 *   5. `deriveOnboardingState()` from @maka/core
 *
 * Credential adapters project ordinary read failures to `false` and
 * propagate connection failures before they reach this service.
 * After a complete read, named Session changes use a targeted Host lookup
 * against the retained, per-Host readiness inputs and history membership.
 *
 * Milestone input validation lives here too: setMilestone arguments
 * are checked against the closed enum + status union before reaching
 * the SettingsStore.
 */

import {
  deriveOnboardingState,
  hasSettledInitialOnboarding,
  ONBOARDING_MILESTONE_IDS,
  type OnboardingMilestone,
  type OnboardingMilestoneId,
  type OnboardingState,
} from '@maka/core/onboarding';

import { projectSessionSendOutcome, type SessionSendProjection } from '@maka/core/session-send-projection';

import { type SessionSummary } from '@maka/core/session';
import { buildChatModelChoices, type ChatModelChoice } from '@maka/core/chat-model-choice';
import type { ProjectedLlmConnection } from '@maka/core/llm-connections';
import type { LlmConnection } from '@maka/core/llm-connections';

export interface OnboardingSnapshot {
  state: OnboardingState;
  milestones: OnboardingMilestone[];
  /** Complete authenticated Owner seed for preload's sidebar catalog. */
  sessions: SessionSummary[];
  /** Default Host connection projection used to seed the shell. */
  connections: ProjectedLlmConnection[];
  defaultSlug: string | null;
  chatModelChoices: ChatModelChoice[];
  sessionSendOutcomes: Record<string, SessionSendProjection>;
}

export interface OnboardingServiceDeps {
  listConnections(): Promise<ProjectedLlmConnection[]>;
  getDefaultSlug(): Promise<string | null>;
  listSessions(): Promise<SessionSummary[]>;
  getSession(sessionId: string): Promise<SessionSummary | null>;
  getMilestones(): Promise<OnboardingMilestone[]>;
  upsertMilestone(
    id: OnboardingMilestoneId,
    status: 'completed' | 'skipped',
  ): Promise<OnboardingMilestone[]>;
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
  getSessionUpdate(sessionId: string): Promise<OnboardingSessionUpdate>;
  setMilestone(
    id: unknown,
    status: unknown,
  ): Promise<OnboardingSnapshot>;
}

export type OnboardingSessionUpdate =
  | { kind: 'resync' }
  | {
      kind: 'delta';
      outcome: SessionSendProjection | null;
      state: OnboardingState;
      milestones: OnboardingMilestone[];
    };

interface OnboardingBaseline {
  readonly sessionIds: Set<string>;
  readonly connections: ProjectedLlmConnection[];
  readonly defaultSlug: string | null;
  readonly secrets: Readonly<Record<string, boolean>>;
  milestones: OnboardingMilestone[];
}

/**
 * Build the desktop OnboardingService. The constructor takes injected
 * deps (rather than reading the global stores) so the service is
 * trivially unit-testable: a fake `OnboardingServiceDeps` mirrors the
 * real stores in tests.
 */
export function createOnboardingService(deps: OnboardingServiceDeps): OnboardingService {
  let baseline: OnboardingBaseline | null = null;
  let updateTail: Promise<void> = Promise.resolve();

  function enqueue<T>(read: () => Promise<T>): Promise<T> {
    const pending = updateTail.then(read);
    updateTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async function loadSnapshot(credentialFailureFallback = false): Promise<OnboardingSnapshot> {
    const [connections, defaultSlug, sessions, milestones] = await Promise.all([
      deps.listConnections(),
      deps.getDefaultSlug(),
      deps.listSessions(),
      deps.getMilestones(),
    ]);

    // Credential reads stay parallel and read-only. A global connection
    // invalidation is allowed to rebuild every Session's projection.
    const secretEntries = await Promise.all(
      connections.map(async (connection) => {
        try {
          return [connection.slug, await deps.hasCredential(connection)] as const;
        } catch (error) {
          if (!credentialFailureFallback) throw error;
          return [connection.slug, false] as const;
        }
      }),
    );
    const secrets: Record<string, boolean> = Object.fromEntries(secretEntries);
    // Revision collapse always retains one member of every nonempty family.
    // Onboarding only needs presence, so a second all-Session fold is unnecessary.
    const hasHistory = sessions.length > 0;
    const state = deriveOnboardingState({
      connections,
      defaultSlug: defaultSlug ?? undefined,
      hasHistory,
      secrets,
    });
    const settledMilestones = hasHistory && !hasSettledInitialOnboarding(milestones)
      ? await deps.upsertMilestone('initial_onboarding', 'completed')
      : milestones;
    baseline = {
      sessionIds: new Set(sessions.map(({ id }) => id)),
      connections,
      defaultSlug,
      secrets,
      milestones: settledMilestones,
    };
    return buildSnapshot(state, settledMilestones, sessions, connections, defaultSlug, secrets);
  }

  async function readSessionUpdate(sessionId: string): Promise<OnboardingSessionUpdate> {
    const observed = baseline;
    if (!observed) return { kind: 'resync' };
    const session = await deps.getSession(sessionId);
    const hasHistory = session !== null ||
      observed.sessionIds.size > (observed.sessionIds.has(sessionId) ? 1 : 0);
    const milestones = hasHistory && !hasSettledInitialOnboarding(observed.milestones)
      ? await deps.upsertMilestone('initial_onboarding', 'completed')
      : observed.milestones;
    if (session === null) observed.sessionIds.delete(sessionId);
    else observed.sessionIds.add(sessionId);
    if (milestones !== observed.milestones) {
      observed.milestones = milestones;
    }
    return {
      kind: 'delta',
      outcome: session === null ? null : projectSessionSendOutcome({
        session,
        connections: observed.connections,
        hasSecret: (slug) => observed.secrets[slug] ?? false,
      }),
      state: deriveOnboardingState({
        connections: observed.connections,
        defaultSlug: observed.defaultSlug ?? undefined,
        hasHistory,
        secrets: observed.secrets,
      }),
      milestones: observed.milestones,
    };
  }

  return {
    getSnapshot: () => enqueue(() => loadSnapshot()),
    getSessionUpdate(sessionId: string): Promise<OnboardingSessionUpdate> {
      return enqueue(() => readSessionUpdate(sessionId));
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
      return enqueue(async () => {
        await deps.upsertMilestone(id, status);
        baseline = null;
        // The global milestone write may alter which guide is shown; rebuild
        // from the same authoritative sources as an explicit full refresh.
        return loadSnapshot(true);
      });
    },
  };
}

function buildSnapshot(
  state: OnboardingState,
  milestones: OnboardingMilestone[],
  sessions: SessionSummary[],
  connections: ProjectedLlmConnection[],
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
          hasSecret: (slug) => secrets[slug] ?? false,
        }),
      ]),
    ),
  };
}

function isOnboardingMilestoneId(value: string): value is OnboardingMilestoneId {
  return (ONBOARDING_MILESTONE_IDS as readonly string[]).includes(value);
}
