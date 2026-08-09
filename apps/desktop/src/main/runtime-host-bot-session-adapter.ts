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

    async runTurn({ sessionId, messageId, text, onReplySnapshot }) {
      let session;
      try {
        session = await deps.client.openSession(sessionId);
      } catch (error) {
        throwUnavailable(error, sessionId);
        throw error;
      }

      try {
        const active = session.snapshot.rootTurn;
        if (active && !isTerminal(active.status)) {
          return active.status === 'waiting_for_user'
            ? { kind: 'suspended' as const }
            : { kind: 'errored' as const, reason: 'Session is already running a Turn' };
        }
        let submitted;
        try {
          submitted = await deps.client.submitMessage({
            sessionId,
            messageId,
            content: { text },
            placement: 'next_turn',
          });
        } catch (error) {
          throwUnavailable(error, sessionId);
          throw error;
        }
        if (submitted.disposition !== 'turn_started') {
          return {
            kind: 'errored' as const,
            reason: 'Message was queued because another Turn started first',
          };
        }
        deps.emitSessionsChanged('status-change', sessionId, { turnId: submitted.turnId });
        return await collectRuntimeHostBotTurn(session, submitted.turnId, onReplySnapshot);
      } finally {
        await session.close().catch(() => undefined);
      }
    },
  };
}

async function collectRuntimeHostBotTurn(
  session: {
    readonly snapshot: import('@maka/runtime-host/protocol').SessionContinuitySnapshot;
    readonly transcript: Promise<StoredMessage[]>;
    readonly events: AsyncIterable<SubscriptionFrame>;
  },
  turnId: string,
  onReplySnapshot?: (text: string) => void,
): Promise<BotSessionTurnResult> {
  const initialTurn = session.snapshot.rootTurn;
  if (
    initialTurn?.turnId === turnId &&
    (initialTurn.status === 'waiting_for_user' || isTerminal(initialTurn.status))
  ) {
    return projectTerminalBotTurn(initialTurn, await session.transcript, turnId);
  }
  const assistantText = new Map<string, string>();
  let latestMessageId: string | undefined;
  let publishedSnapshot: string | undefined;

  for await (const frame of session.events) {
    if (frame.kind === 'subscription.closed') {
      throw new Error(`Runtime Host Bot Session subscription closed: ${frame.reason}`);
    }
    if (frame.kind === 'subscription.session_delta') {
      if (frame.delta.turnId !== turnId || frame.delta.kind !== 'text') continue;
      const messageId = frame.delta.messageId;
      latestMessageId = messageId;
      const folded = foldRuntimeHostAssistantDelta(
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
    if (turn.status === 'failed') return { kind: 'errored', reason: turn.failureClass };
    if (turn.status === 'cancelled') {
      return { kind: 'errored', reason: `Turn cancelled: ${turn.abortSource}` };
    }
  }

  throw new Error('Runtime Host Bot Session subscription ended before the Turn settled');
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
