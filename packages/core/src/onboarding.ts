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

/** Pure onboarding projection; persisted milestones are validated separately below. */

import {
  isConnectionReady,
  isRealConnection,
  normalizeOpenAiCodexConnection,
} from './connection-readiness.js';
import { connectionEnabledModelIds, type LlmConnection } from './llm-connections.js';
import type { SessionSummary } from './session.js';
export { hasSettledInitialOnboarding } from './onboarding-milestone.js';

/** Derived UI state; every non-ready variant identifies one actionable repair path. */
export type OnboardingState =
  | { kind: 'needs_connection' }
  | { kind: 'needs_connection_credentials'; connectionSlug: string }
  | { kind: 'needs_model'; connectionSlug: string }
  | { kind: 'ready_empty'; connectionSlug: string; model: string }
  | { kind: 'ready_with_history'; connectionSlug: string; model: string }
  | { kind: 'blocked'; reason: 'all_connections_unhealthy' | 'all_connections_retired' };

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

/** Derive onboarding from the same connection readiness authority used by sends. */
export function deriveOnboardingState(input: DeriveOnboardingStateInput): OnboardingState {
  const realConns = input.connections
    .filter((connection) => isRealConnection(connection))
    .map(normalizeOpenAiCodexConnection);
  if (realConns.length === 0) return { kind: 'needs_connection' };

  // The workspace default orders valid candidates but is not an activation gate.
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
  let everyConnectionRetired = true;
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
      case 'provider_retired':
        // Not routed to the connection: there is no repair to make there.
        break;
      case 'connection_disabled':
      case 'fake_backend':
      case 'connection_missing':
      case 'missing_default_connection':
        everyConnectionRetired = false;
        break;
    }
  }

  // Real connections exist but none can be made ready by a
  // per-connection fix. Retirement is called out separately: telling these
  // users to re-check credentials would send them to a sign-in Maka removed.
  return everyConnectionRetired
    ? { kind: 'blocked', reason: 'all_connections_retired' }
    : { kind: 'blocked', reason: 'all_connections_unhealthy' };
}

function hasHistory(sessions: ReadonlyArray<SessionSummary>): boolean {
  return sessions.length > 0;
}

/** Closed milestone ids persisted in settings. */
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

/** Strict milestone schema gate; extra fields prevent private content persistence. */
export function isOnboardingMilestone(value: unknown): value is OnboardingMilestone {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  // Reject class instances and other non-record objects.
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

/** Drop invalid milestones and dedupe by last value while preserving first-seen order. */
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
