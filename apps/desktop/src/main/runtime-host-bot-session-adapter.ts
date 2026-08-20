import type { StoredMessage } from '@maka/core/session';
import { foldRuntimeHostAssistantDelta } from '@maka/runtime-host/adapter';
import { RuntimeHostOperationError } from '@maka/runtime-host/client';
import type {
  SessionCatalogProjection,
  SubscriptionFrame,
  WorkspaceTarget,
} from '@maka/runtime-host/protocol';
import type {
  BotSessionAdapter,
  BotSessionTurnResult,
} from './bot-session-adapter.js';
import {
  DesktopRuntimeHostClientError,
  type DesktopRuntimeHostClient,
} from './runtime-host-client.js';

type RuntimeHostBotSessionClient = Pick<
  DesktopRuntimeHostClient,
  | 'reconcileExternalConversation'
  | 'openSession'
  | 'queryTurn'
  | 'submitMessage'
  | 'updateSessionConfiguration'
>;

export interface RuntimeHostBotSessionCreateTarget {
  readonly workspace: WorkspaceTarget;
}

export interface RuntimeHostBotSessionAdapterDeps {
  client: RuntimeHostBotSessionClient;
  resolveCreateTarget(): Promise<RuntimeHostBotSessionCreateTarget>;
  emitSessionsChanged(
    reason: 'created' | 'updated' | 'status-change',
    sessionId: string,
    extra?: { readonly turnId?: string },
  ): void;
}

export function createRuntimeHostBotSessionAdapter(
  deps: RuntimeHostBotSessionAdapterDeps,
): BotSessionAdapter {
  return {
    async resolveSession(input) {
      let outcome = await deps.client.reconcileExternalConversation({
        kind: 'resolve',
        conversationId: input.conversationId,
      });
      if (outcome.kind === 'create_required') {
        const target = await deps.resolveCreateTarget();
        outcome = await deps.client.reconcileExternalConversation({
          kind: 'resolve',
          conversationId: input.conversationId,
          session: {
            workspace: target.workspace,
            name: input.name,
            labels: [...input.labels],
            modelTarget: { kind: 'default' },
          },
        });
      }
      if (outcome.kind !== 'resolved') {
        throw new Error('Runtime Host returned an invalid external-conversation resolution');
      }
      if ('kind' in outcome.session) {
        throw new Error('Runtime Host bound an external conversation to a legacy Session');
      }
      let session: SessionCatalogProjection = outcome.session;
      let permissionUpdated = false;
      if (session.permissionMode !== 'explore') {
        try {
          session = await deps.client.updateSessionConfiguration(session.id, {
            permissionMode: 'explore',
          });
          permissionUpdated = true;
        } catch (error) {
          if (isPermissionUpdateRefusal(error)) return { kind: 'permission_refused' };
          throw error;
        }
      }
      if (session.permissionMode !== 'explore') return { kind: 'permission_refused' };
      if (outcome.disposition === 'created') deps.emitSessionsChanged('created', session.id);
      else if (permissionUpdated) deps.emitSessionsChanged('updated', session.id);
      return { kind: 'ready', sessionId: session.id };
    },

    async releaseConversation(input) {
      const outcome = await deps.client.reconcileExternalConversation({
        kind: 'release',
        conversationId: input.conversationId,
        operationId: input.operationId,
      });
      if (outcome.kind !== 'released') {
        throw new Error('Runtime Host returned an invalid external-conversation release');
      }
      return outcome.hadBinding;
    },

    async runTurn({ sessionId, messageId, text, admissionMode = 'allow', onReplySnapshot }) {
      let session;
      try {
        session = await deps.client.openSession(sessionId);
      } catch (error) {
        throwUnavailable(error, sessionId);
        throw error;
      }

      try {
        const turnId = deferred<string>();
        const completion = collectRuntimeHostBotTurn(
          session,
          turnId.promise,
          onReplySnapshot,
        );
        void completion.catch(() => undefined);
        let submitted;
        try {
          submitted = await deps.client.submitMessage({
            sessionId,
            messageId,
            content: { text },
            placement: 'next_turn',
            busyBehavior: 'reject',
            admissionMode,
          });
        } catch (error) {
          turnId.reject(error);
          await session.close().catch(() => undefined);
          await completion.catch(() => undefined);
          if (
            error instanceof RuntimeHostOperationError &&
            error.operation === 'turn.message.submit' &&
            error.code === 'session_busy'
          ) {
            return { kind: 'errored' as const, reason: 'Session is already running a Turn' };
          }
          if (
            admissionMode === 'replay_only' &&
            error instanceof RuntimeHostOperationError &&
            error.operation === 'turn.message.submit' &&
            error.code === 'outcome_unknown'
          ) {
            return { kind: 'admission_required' as const };
          }
          throwUnavailable(error, sessionId);
          throw error;
        }
        if (submitted.disposition !== 'turn_started') {
          // placement 'next_turn' + busyBehavior 'reject' either starts the
          // Turn or fails; an exact redelivery also resolves to turn_started
          // through the Host's durable proof. A queued disposition therefore
          // means the submit contract changed — fail closed instead of
          // misreporting a busy race.
          const error = new Error(
            `Unexpected turn.message.submit disposition: ${submitted.disposition}`,
          );
          turnId.reject(error);
          await session.close().catch(() => undefined);
          await completion.catch(() => undefined);
          throw error;
        }
        turnId.resolve(submitted.turnId);
        deps.emitSessionsChanged('status-change', sessionId, { turnId: submitted.turnId });
        let canonicalTurn;
        try {
          canonicalTurn = await deps.client.queryTurn({
            sessionId,
            turnId: submitted.turnId,
          });
        } catch (error) {
          await session.close().catch(() => undefined);
          await completion.catch(() => undefined);
          throwUnavailable(error, sessionId);
          throw error;
        }
        if (canonicalTurn.status === 'waiting_for_user' || isTerminal(canonicalTurn.status)) {
          return projectTerminalBotTurn(
            canonicalTurn,
            await session.loadTranscript(),
            submitted.turnId,
          );
        }
        return await completion;
      } finally {
        await session.close().catch(() => undefined);
      }
    },
  };
}

async function collectRuntimeHostBotTurn(
  session: {
    readonly snapshot: import('@maka/runtime-host/protocol').SessionContinuitySnapshot;
    loadTranscript(): Promise<StoredMessage[]>;
    readonly events: AsyncIterable<SubscriptionFrame>;
  },
  turnIdPromise: Promise<string>,
  onReplySnapshot?: (text: string) => void,
): Promise<BotSessionTurnResult> {
  const iterator = session.events[Symbol.asyncIterator]();
  // Start the subscription read before message admission. The Host owns the
  // Turn id, but a fast Turn (or a concurrent connection close) must not race
  // ahead of the Desktop consumer while submitMessage is still returning it.
  const firstFrame = iterator.next();
  void firstFrame.catch(() => undefined);
  const turnId = await turnIdPromise;
  const initialTurn = session.snapshot.rootTurn;
  if (
    initialTurn?.turnId === turnId &&
    (initialTurn.status === 'waiting_for_user' || isTerminal(initialTurn.status))
  ) {
    return projectTerminalBotTurn(initialTurn, await session.loadTranscript(), turnId);
  }
  const assistantText = new Map<string, string>();
  let publishedSnapshot: string | undefined;
  if (initialTurn?.turnId === turnId) {
    for (const message of await session.loadTranscript()) {
      if (message.type === 'assistant' && message.turnId === turnId) {
        assistantText.set(message.id, message.text);
      }
    }
  }

  let next = await firstFrame;
  while (!next.done) {
    const frame = next.value;
    if (frame.kind === 'subscription.closed') {
      throw new Error(`Runtime Host Bot Session subscription closed: ${frame.reason}`);
    }
    if (frame.kind === 'subscription.session_delta') {
      if (frame.delta.turnId === turnId && frame.delta.kind === 'text') {
        const messageId = frame.delta.messageId;
        const folded = foldRuntimeHostAssistantDelta(
          frame.delta.reset ? '' : (assistantText.get(messageId) ?? ''),
          frame.delta,
        );
        assistantText.set(messageId, folded.text);
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
      }
    } else if (frame.kind === 'subscription.session_projection') {
      const turn = frame.snapshot.rootTurn;
      if (turn?.turnId === turnId) {
        if (turn.status === 'waiting_for_user') return { kind: 'suspended' };
        if (turn.status === 'completed') {
          return projectTerminalBotTurn(turn, await session.loadTranscript(), turnId);
        }
        if (turn.status === 'failed') return { kind: 'errored', reason: turn.failureClass };
        if (turn.status === 'cancelled') {
          return { kind: 'errored', reason: `Turn cancelled: ${turn.abortSource}` };
        }
      }
    }
    next = await iterator.next();
  }

  throw new Error('Runtime Host Bot Session subscription ended before the Turn settled');
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function projectTerminalBotTurn(
  turn: NonNullable<import('@maka/runtime-host/protocol').SessionContinuitySnapshot['rootTurn']>,
  transcript: readonly StoredMessage[],
  turnId: string,
): BotSessionTurnResult {
  if (turn.status === 'waiting_for_user') return { kind: 'suspended' };
  if (turn.status === 'completed') {
    for (let index = transcript.length - 1; index >= 0; index -= 1) {
      const message = transcript[index];
      if (message?.type === 'assistant' && message.turnId === turnId) {
        return { kind: 'completed', text: message.text };
      }
    }
    return { kind: 'completed', text: '' };
  }
  if (turn.status === 'failed') return { kind: 'errored', reason: turn.failureClass };
  if (turn.status === 'cancelled') {
    return { kind: 'errored', reason: `Turn cancelled: ${turn.abortSource}` };
  }
  throw new Error(`Runtime Host Bot Turn has unsupported terminal status: ${turn.status}`);
}

function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function throwUnavailable(error: unknown, sessionId: string): void {
  if (
    (error instanceof RuntimeHostOperationError && error.code === 'not_found') ||
    (error instanceof DesktopRuntimeHostClientError && error.code === 'session_not_found')
  ) {
    throw new Error(`Bot Session is missing: ${sessionId}`, { cause: error });
  }
  if (error instanceof RuntimeHostOperationError && error.code === 'session_archived') {
    throw new Error(`Bot Session is retired: ${sessionId}`, { cause: error });
  }
}

function isPermissionUpdateRefusal(error: unknown): boolean {
  return (
    (error instanceof RuntimeHostOperationError &&
      (error.code === 'session_busy' || error.code === 'operation_conflict')) ||
    (error instanceof DesktopRuntimeHostClientError && error.code === 'revision_conflict')
  );
}
