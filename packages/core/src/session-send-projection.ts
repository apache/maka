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
 * whether that exact target looks usable for presentation and readiness checks.
 *
 * The compatibility rules are:
 *   1. The session's own connection must pass `isConnectionReady` with
 *      the sticky session model.
 *   2. Legacy Sessions without an immutable connection id are blocked until
 *      the user explicitly selects an account.
 *   3. A missing id, slug mismatch, or unusable exact connection is blocked.
 *
 * `lastTestStatus` deliberately plays no part here (E4): telemetry about
 * a past credential test must not gate send, so it must not gate the
 * notice's "send will fail" answer either.
 */

import { isConnectionReady, type ChatConfigurationReason } from './connection-readiness.js';
import { normalizeOpenAiCodexConnection } from './model-catalog.js';
import type { IdentifiedLlmConnection, LlmConnection } from './llm-connections.js';

export interface SessionSendProjectionSession {
  /**
   * Session backend kind. `string` (not `PersistedBackendKind`) so legacy
   * on-disk values like `'claude'` are surfaced exactly as the JSONL stored
   * them; only `'fake'` is special-cased, everything else goes through the
   * normal connection readiness gate.
   */
  backend: string;
  llmConnectionId?: string;
  llmConnectionSlug: string;
  /** Sticky session model captured when the session was created. */
  model: string;
  /** True once the session has user messages; locked sessions never rebind. */
  connectionLocked: boolean;
}

export interface SessionSendProjectionInput {
  session: SessionSendProjectionSession;
  /** Every persisted connection. */
  connections: readonly IdentifiedLlmConnection[];
  /**
   * Secret presence per connection slug, resolved by the caller. Only
   * consulted for connections that exist.
   */
  hasSecret(slug: string): boolean;
}

export type SessionSendProjection =
  | { kind: 'ready' }
  | {
      kind: 'blocked';
      reason:
        | ChatConfigurationReason
        | 'legacy_connection_identity'
        | 'connection_identity_mismatch';
      connectionLocked: boolean;
    };

export function projectSessionSendOutcome(
  input: SessionSendProjectionInput,
): SessionSendProjection {
  const { session, connections, hasSecret } = input;

  const ownReason = ownConnectionBlockReason(session, connections, hasSecret);
  if (ownReason === undefined) return { kind: 'ready' };

  return { kind: 'blocked', reason: ownReason, connectionLocked: session.connectionLocked };
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
  connections: readonly IdentifiedLlmConnection[],
  hasSecret: (slug: string) => boolean,
):
  | ChatConfigurationReason
  | 'legacy_connection_identity'
  | 'connection_identity_mismatch'
  | undefined {
  if (session.backend === 'fake') return 'fake_backend';
  if (!session.llmConnectionId) return 'legacy_connection_identity';
  const identified =
    connections.find((entry) => entry.connectionId === session.llmConnectionId) ?? null;
  if (identified && identified.slug !== session.llmConnectionSlug) {
    return 'connection_identity_mismatch';
  }
  const own = identified;
  return sessionOwnConnectionBlockReason(session, own, hasSecret);
}
