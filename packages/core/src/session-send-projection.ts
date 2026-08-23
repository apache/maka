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
 * Session send projection — pure, sync compatibility answer for an existing
 * session's stored model target. #1038.
 *
 * This is the shared compatibility projection used by Desktop onboarding and
 * the renderer session-health notice above the composer. Runtime Host owns the
 * authoritative submission and execution path; this projection only explains
 * whether that target looks usable or whether an empty legacy session has a
 * compatible fallback for presentation and readiness checks.
 *
 * The compatibility rules are:
 *   1. The session's own connection must pass `isConnectionReady` with
 *      the sticky session model.
 *   2. A locked session (has user messages) can never select a fallback — any
 *      failure of its own connection projects as blocked.
 *   3. An unlocked session may select a fallback only for reasons in
 *      `shouldRebindSessionToDefault`; the walk tries the default
 *      connection first, then every other persisted connection.
 *   4. Otherwise the compatibility projection is blocked.
 *
 * `lastTestStatus` deliberately plays no part here (E4): telemetry about
 * a past credential test must not gate send, so it must not gate the
 * notice's "send will fail" answer either.
 */

import {
  isConnectionReady,
  normalizeOpenAiCodexConnection,
  type ChatConfigurationReason,
} from './connection-readiness.js';
import type { LlmConnection } from './llm-connections.js';

export interface SessionSendProjectionSession {
  /**
   * Session backend kind. `string` (not `PersistedBackendKind`) so legacy
   * on-disk values like `'claude'` are surfaced exactly as the JSONL stored
   * them; only `'fake'` is special-cased, everything else goes through the
   * normal connection readiness gate.
   */
  backend: string;
  llmConnectionSlug: string;
  /** Sticky session model captured when the session was created. */
  model: string;
  /** True once the session has user messages; locked sessions never rebind. */
  connectionLocked: boolean;
}

export interface SessionSendProjectionInput {
  session: SessionSendProjectionSession;
  /** Every persisted connection (the rebind walk considers all of them). */
  connections: readonly LlmConnection[];
  defaultSlug: string | null;
  /**
   * Secret presence per connection slug, resolved by the caller. Only
   * consulted for connections that exist.
   */
  hasSecret(slug: string): boolean;
}

export type SessionSendProjection =
  | { kind: 'ready' }
  | { kind: 'rebind'; connectionSlug: string; model: string }
  | { kind: 'blocked'; reason: ChatConfigurationReason; connectionLocked: boolean };

export function projectSessionSendOutcome(
  input: SessionSendProjectionInput,
): SessionSendProjection {
  const { session, connections, defaultSlug, hasSecret } = input;

  const ownReason = ownConnectionBlockReason(session, connections, hasSecret);
  if (ownReason === undefined) return { kind: 'ready' };

  // Once a session has user messages, its connection/model is sticky.
  // Rebind remains only a recovery path for empty legacy placeholders.
  if (session.connectionLocked) {
    return { kind: 'blocked', reason: ownReason, connectionLocked: true };
  }
  if (!shouldRebindSessionToDefault(ownReason)) {
    return { kind: 'blocked', reason: ownReason, connectionLocked: false };
  }

  for (const slug of new Set([defaultSlug, ...connections.map((connection) => connection.slug)])) {
    if (!slug) continue;
    const connection = connections.find((entry) => entry.slug === slug);
    if (!connection) continue;
    const normalized = normalizeOpenAiCodexConnection(connection);
    const verdict = isConnectionReady({
      connection: normalized,
      hasSecret: hasSecret(normalized.slug),
    });
    if (verdict.ready) {
      return { kind: 'rebind', connectionSlug: normalized.slug, model: verdict.model };
    }
  }
  return { kind: 'blocked', reason: ownReason, connectionLocked: false };
}

/**
 * Why the session's own connection cannot satisfy the compatibility
 * projection, or `undefined` when it can. Kept private so Runtime Host
 * admission cannot accidentally grow a second dependency on this UI-facing
 * legacy-session policy.
 */
function sessionOwnConnectionBlockReason(
  session: SessionSendProjectionSession,
  ownConnection: LlmConnection | null,
  hasSecret: (slug: string) => boolean,
): ChatConfigurationReason | undefined {
  // Sessions written by builds that shipped FakeBackend keep `'fake'` on disk
  // forever (#3211). They are refused here — and at activation — rather than
  // rewritten, because their `llmConnectionSlug` still points at nothing.
  if (session.backend === 'fake') return 'fake_backend';
  const slug = session.llmConnectionSlug;
  if (!slug) return 'missing_default_connection';
  if (!ownConnection) return 'connection_missing';
  const normalized = normalizeOpenAiCodexConnection(ownConnection);
  const verdict = isConnectionReady({
    connection: normalized,
    hasSecret: hasSecret(normalized.slug),
    requestedModel: session.model,
  });
  return verdict.ready ? undefined : verdict.reason;
}

function ownConnectionBlockReason(
  session: SessionSendProjectionSession,
  connections: readonly LlmConnection[],
  hasSecret: (slug: string) => boolean,
): ChatConfigurationReason | undefined {
  const own = connections.find((entry) => entry.slug === session.llmConnectionSlug) ?? null;
  return sessionOwnConnectionBlockReason(session, own, hasSecret);
}

/**
 * Whether an unlocked session whose own connection failed with `reason` may
 * project another ready connection as a compatibility target. Failures not
 * listed here (e.g. `missing_api_key`, `connection_disabled`) stay blocked
 * even when unlocked because masking an explicitly configured connection
 * would make the health/readiness UI misleading.
 *
 * `fake_backend` is deliberately absent (#3211). Every reason listed here
 * names a broken *connection*, which another connection can stand in for. A
 * retired backend is not: activation dispatches off the session header's own
 * `backend`, so pointing the session at a healthy connection still leaves
 * `'fake'` in the header and still gets refused. Claiming a rebind for these
 * rows made the projection promise a recovery nothing performs — and the
 * surfaces that must answer "is this task usable?" had to bypass the
 * projection and read `backend` themselves to work around it.
 */
function shouldRebindSessionToDefault(reason: string | undefined): boolean {
  return (
    reason === 'connection_missing' ||
    reason === 'missing_model' ||
    reason === 'empty_model_list' ||
    reason === 'model_not_enabled' ||
    reason === 'model_not_chat_capable'
  );
}
