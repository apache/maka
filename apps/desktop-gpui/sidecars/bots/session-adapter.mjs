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

// Runs bot conversations as Runtime Host Sessions.
//
// A port of `createRuntimeHostBotSessionAdapter` in Maka Desktop's
// apps/desktop/src/main/runtime-host-bot-session-adapter.ts, and of the parts
// of `DesktopRuntimeHostClient` (apps/desktop/src/main/runtime-host-client.ts)
// it calls, written against the bare `RuntimeHostConnection` of
// `@maka/runtime-host/client`. Desktop also tells its renderer that the
// Session list changed (`emitSessionsChanged`); here the client's windows
// learn that from the Host's own `session.catalog.changed` frames.

import { randomUUID } from 'node:crypto';

/** `BotSessionUnavailableError` in apps/desktop/src/main/bot-session-adapter.ts. */
export class BotSessionUnavailableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'BotSessionUnavailableError';
  }
}

export function isBotSessionUnavailableError(error) {
  return error instanceof BotSessionUnavailableError;
}

/**
 * The codes of `DesktopRuntimeHostClientError` this module raises
 * (`session_not_found`, `revision_conflict`, `unsupported_session`,
 * `catalog_unstable`).
 */
export class HostClientError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'HostClientError';
  }
}

/** `MAX_SESSION_REVISION_ATTEMPTS` in runtime-host-client.ts. */
const MAX_SESSION_REVISION_ATTEMPTS = 8;

/**
 * The Session calls of `DesktopRuntimeHostClient` over `connection`.
 *
 * @param {object} connection a `RuntimeHostConnection`
 * @param {object} protocol `@maka/runtime-host/protocol` from `loadMaka`
 */
export function createHostSessionClient(connection, protocol) {
  async function getSession(sessionId) {
    const result = await connection.request('session.catalog.query', { kind: 'get', sessionId });
    if (result.kind !== 'session') {
      throw new HostClientError(
        'catalog_unstable',
        'Runtime Host returned an invalid Session catalog lookup',
      );
    }
    return result.session === null ? null : requireSessionProjection(result.session);
  }

  async function requireSession(sessionId) {
    const session = await getSession(sessionId);
    if (session) return session;
    throw new HostClientError('session_not_found', `Runtime Host Session not found: ${sessionId}`);
  }

  return {
    getSession,

    async createSession(input) {
      return requireSessionProjection(await connection.request('session.create', input));
    },

    async updateSessionConfiguration(sessionId, patch) {
      const definedPatch = Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      );
      if (Object.keys(definedPatch).length === 0) return requireSession(sessionId);
      for (let attempt = 0; attempt < MAX_SESSION_REVISION_ATTEMPTS; attempt += 1) {
        const current = await requireSession(sessionId);
        const result = await connection.request('session.configuration.update', {
          sessionId,
          expectedRevision: current.revision,
          patch: definedPatch,
        });
        if (result.kind === 'committed') return requireSessionProjection(result.session);
      }
      throw new HostClientError(
        'revision_conflict',
        `Runtime Host Session kept changing during update: ${sessionId}`,
      );
    },

    /** A Session subscription: an async iterable of frames, held until `ready()`. */
    openSession(sessionId) {
      return connection.openSessionSubscription({
        sessionId,
        transcript: { kind: 'tail', maxBytes: protocol.SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES },
      });
    },

    startTurn(input) {
      return connection.request('turn.start', input);
    },
  };
}

function requireSessionProjection(item) {
  if (!('kind' in item)) return item;
  throw new HostClientError(
    'unsupported_session',
    `Runtime Host Session is not representable by this client: ${item.id}`,
  );
}

/**
 * @param {object} deps
 * @param {object} deps.client from `createHostSessionClient`
 * @param {() => Promise<{ workspace: object }>} deps.resolveCreateTarget
 * @param {object} deps.maka `{ client, adapter }` from `loadMaka`
 * @param {() => string} [deps.newId]
 */
export function createHostBotSessionAdapter(deps) {
  const newId = deps.newId ?? randomUUID;
  const { RuntimeHostOperationError } = deps.maka.client;
  const { foldRuntimeHostAssistantDelta } = deps.maka.adapter;

  function throwUnavailable(error, sessionId) {
    if (
      (error instanceof RuntimeHostOperationError &&
        (error.code === 'not_found' || error.code === 'session_archived')) ||
      (error instanceof HostClientError && error.code === 'session_not_found')
    ) {
      throw unavailableSession(sessionId, error);
    }
  }

  function isPermissionUpdateRefusal(error) {
    return (
      (error instanceof RuntimeHostOperationError &&
        (error.code === 'session_busy' || error.code === 'operation_conflict')) ||
      (error instanceof HostClientError && error.code === 'revision_conflict')
    );
  }

  return {
    async createSession(input) {
      const target = await deps.resolveCreateTarget();
      const sessionId = newId();
      let session;
      try {
        session = await deps.client.createSession({
          sessionId,
          workspace: target.workspace,
          name: input.name,
          labels: [...input.labels],
          modelTarget: { kind: 'default' },
          mode: 'bot',
        });
      } catch (error) {
        if (!(error instanceof RuntimeHostOperationError) || error.code !== 'commit_outcome_unknown') {
          throw error;
        }
        const reconciled = await deps.client.getSession(sessionId);
        if (!reconciled) throw error;
        session = reconciled;
      }
      return session.id;
    },

    async prepareSession(sessionId) {
      let session;
      try {
        session = await deps.client.getSession(sessionId);
      } catch (error) {
        throwUnavailable(error, sessionId);
        throw error;
      }
      if (!session || session.isArchived) {
        throw unavailableSession(sessionId);
      }
      if (session.permissionMode === 'explore') return 'ready';

      try {
        session = await deps.client.updateSessionConfiguration(sessionId, {
          permissionMode: 'explore',
        });
      } catch (error) {
        throwUnavailable(error, sessionId);
        if (isPermissionUpdateRefusal(error)) return 'permission_refused';
        throw error;
      }
      if (session.isArchived) {
        throw unavailableSession(sessionId);
      }
      if (session.permissionMode !== 'explore') return 'permission_refused';
      return 'ready';
    },

    async runTurn({ sessionId, turnId, text, onReplySnapshot }) {
      let session;
      try {
        session = await deps.client.openSession(sessionId);
      } catch (error) {
        throwUnavailable(error, sessionId);
        throw error;
      }

      const completion = collectHostBotTurn(
        session,
        turnId,
        onReplySnapshot,
        foldRuntimeHostAssistantDelta,
      );
      void completion.catch(() => undefined);
      try {
        try {
          // The Host holds this subscription's frames until here, so the reply
          // has to be collectable before the Turn that produces it starts.
          await session.ready();
          const started = await deps.client.startTurn({
            sessionId,
            turnId,
            content: { text },
          });
          if (started.kind === 'blocked') {
            return {
              kind: 'errored',
              reason: started.skillInvocation.failed
                .map((failure) =>
                  failure.reason === 'too_many_requests'
                    ? `Skill request limit exceeded: ${failure.requestLimit}`
                    : `${failure.request}: ${failure.reason}`,
                )
                .join(', '),
            };
          }
        } catch (error) {
          await session.close().catch(() => undefined);
          await completion.catch(() => undefined);
          throwUnavailable(error, sessionId);
          throw error;
        }
        return await completion;
      } finally {
        await session.close().catch(() => undefined);
      }
    },
  };
}

/**
 * Folds the Turn's assistant text deltas into snapshots and resolves when its
 * root Turn settles (`collectRuntimeHostBotTurn`).
 */
export async function collectHostBotTurn(events, turnId, onReplySnapshot, fold) {
  const assistantText = new Map();
  let latestMessageId;
  let publishedSnapshot;

  for await (const frame of events) {
    if (frame.kind === 'subscription.closed') {
      throw new Error(`Runtime Host Bot Session subscription closed: ${frame.reason}`);
    }
    if (frame.kind === 'subscription.session_delta') {
      if (frame.delta.turnId !== turnId || frame.delta.kind !== 'text') continue;
      latestMessageId = frame.delta.messageId;
      const folded = fold(
        frame.delta.reset ? '' : (assistantText.get(latestMessageId) ?? ''),
        frame.delta,
      );
      assistantText.set(latestMessageId, folded.text);
      if (folded.text !== publishedSnapshot) {
        publishedSnapshot = folded.text;
        try {
          onReplySnapshot?.(folded.text);
        } catch {
          // Reply streaming is a best-effort projection. A channel-specific
          // delivery failure must not stop subscription draining or change the
          // authoritative Runtime Host Turn outcome.
        }
      }
      continue;
    }
    if (frame.kind !== 'subscription.session_projection') continue;
    const turn = frame.snapshot.rootTurn;
    if (!turn || turn.turnId !== turnId) continue;
    if (turn.status === 'waiting_for_user') return { kind: 'suspended' };
    if (turn.status === 'completed') {
      return {
        kind: 'completed',
        text: latestMessageId ? (assistantText.get(latestMessageId) ?? '') : '',
      };
    }
    if (turn.status === 'failed') {
      return { kind: 'errored', reason: turn.failureClass };
    }
    if (turn.status === 'cancelled') {
      return { kind: 'errored', reason: `Turn cancelled: ${turn.abortSource}` };
    }
  }

  throw new Error('Runtime Host Bot Session subscription ended before the Turn settled');
}

function unavailableSession(sessionId, cause) {
  return new BotSessionUnavailableError(`Bot Session is unavailable: ${sessionId}`, { cause });
}
