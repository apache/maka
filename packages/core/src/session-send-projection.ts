/**
 * Session send projection — pure, sync answer to "will the next send on
 * this session succeed, silently rebind, or fail?". #1038.
 *
 * This is the single decision source shared by:
 *   - the main-process send gate (`ensureSessionCanSendOrRebind` in
 *     apps/desktop/src/main/chat-readiness.ts), which resolves the async
 *     facts (connections, secrets), calls this projection, then performs
 *     the actual rebind mutation / throws the canonical error copy;
 *   - the renderer session health notice above the composer, which maps
 *     a `blocked` outcome to actionable copy.
 *
 * The logic mirrors the send path exactly:
 *   1. The session's own connection must pass `isConnectionReady` with
 *      the sticky session model.
 *   2. A locked session (has user messages) can never rebind — any
 *      failure of its own connection blocks the send.
 *   3. An unlocked session may silently rebind only for reasons in
 *      `shouldRebindSessionToDefault`; the walk tries the default
 *      connection first, then every other persisted connection.
 *   4. Otherwise the send is blocked.
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
   * Session backend kind. `string` (not `BackendKind`) so legacy on-disk
   * values like `'claude'` are surfaced exactly as the JSONL stored them;
   * only `'fake'` is special-cased, everything else goes through the
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
   * Secret presence per connection slug, resolved by the caller
   * (credential store in main, `connections:hasSecret` IPC probe in the
   * renderer). Only consulted for connections that exist.
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
    if (!slug || slug === 'fake') continue;
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
 * Why the session's own connection cannot send, or `undefined` when it
 * can. Mirrors `assertSessionCanSend` + `requireReadyConnection` in the
 * desktop main process — keep the reason order in sync with the throwing
 * path so both surfaces report identical causes.
 *
 * Exported for the send gate's staged fact resolution (#1038 review):
 * main resolves only the session's OWN connection in phase 1 and calls
 * this directly, so a healthy session never waits on — nor is failed
 * by — unrelated connections. The full projection reuses the same
 * helper, keeping one implementation of the own-connection judgment.
 */
export function sessionOwnConnectionBlockReason(
  session: SessionSendProjectionSession,
  ownConnection: LlmConnection | null,
  hasSecret: (slug: string) => boolean,
): ChatConfigurationReason | undefined {
  if (session.backend === 'fake') return 'fake_backend';
  const slug = session.llmConnectionSlug;
  if (!slug || slug === 'fake') return 'missing_default_connection';
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
  const own =
    session.backend === 'fake'
      ? null
      : (connections.find((entry) => entry.slug === session.llmConnectionSlug) ?? null);
  return sessionOwnConnectionBlockReason(session, own, hasSecret);
}

/**
 * Whether an unlocked session whose own connection failed with `reason`
 * may silently rebind to another ready connection on send. Failures not
 * listed here (e.g. `missing_api_key`, `connection_disabled`) block the
 * send even when unlocked — silently moving a session off a connection
 * the user explicitly configured would be surprising.
 */
export function shouldRebindSessionToDefault(reason: string | undefined): boolean {
  return (
    reason === 'fake_backend' ||
    reason === 'connection_missing' ||
    reason === 'missing_model' ||
    reason === 'empty_model_list' ||
    reason === 'model_not_enabled' ||
    reason === 'model_not_chat_capable'
  );
}
