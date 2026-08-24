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
 *
 * Milestone input validation lives here too: setMilestone arguments
 * are checked against the closed enum + status union before reaching
 * the SettingsStore.
 */

import { collapseSessionRevisions } from '@maka/core/session-revisions';

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
import type { LlmConnection } from '@maka/core/llm-connections';

export interface OnboardingSnapshot {
  state: OnboardingState;
  milestones: OnboardingMilestone[];
  /**
   * Session list, included so the renderer can populate the sidebar
   * without a separate `sessions:list` IPC.
   */
  sessions: SessionSummary[];
  /** Default Host connection projection used to seed the shell. */
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
          const hasSecret = await deps.hasCredential(connection);
          return [connection.slug, hasSecret] as const;
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
