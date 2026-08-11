import { randomUUID } from 'node:crypto';
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
import { BotSessionUnavailableError } from './bot-session-adapter.js';
import {
  DesktopRuntimeHostClientError,
  type DesktopRuntimeHostClient,
} from './runtime-host-client.js';
import { foldRuntimeHostAssistantDelta } from '@maka/runtime-host/adapter';

type RuntimeHostBotSessionClient = Pick<
  DesktopRuntimeHostClient,
  | 'createSession'
  | 'getSession'
  | 'openSession'
  | 'startTurn'
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
  newId?: () => string;
}

export function createRuntimeHostBotSessionAdapter(
  deps: RuntimeHostBotSessionAdapterDeps,
): BotSessionAdapter {
  const newId = deps.newId ?? randomUUID;

  return {
    async createSession(input) {
      const target = await deps.resolveCreateTarget();
      const sessionId = newId();
      let session: SessionCatalogProjection;
      try {
        session = await deps.client.createSession({
          sessionId,
          workspace: target.workspace,
          name: input.name,
          labels: [...input.labels],
          modelTarget: { kind: 'default' },
          permissionMode: 'explore',
        });
      } catch (error) {
        if (
          !(error instanceof RuntimeHostOperationError) ||
          error.code !== 'commit_outcome_unknown'
        ) {
          throw error;
        }
        const reconciled = await deps.client.getSession(sessionId);
        if (!reconciled) throw error;
        session = reconciled;
      }
      deps.emitSessionsChanged('created', session.id);
      return session.id;
    },

    async prepareSession(sessionId) {
      let session: SessionCatalogProjection | null;
      try {
        session = await deps.client.getSession(sessionId);
      } catch (error) {
        throwUnavailable(error, sessionId);
        throw error;
      }
      if (!session || session.isArchived || session.status === 'archived') {
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
      if (session.isArchived || session.status === 'archived') {
        throw unavailableSession(sessionId);
      }
      if (session.permissionMode !== 'explore') return 'permission_refused';
      deps.emitSessionsChanged('updated', sessionId);
      return 'ready';
    },

    async runTurn({ sessionId, turnId, text }) {
      let session;
      try {
        session = await deps.client.openSession(sessionId);
      } catch (error) {
        throwUnavailable(error, sessionId);
        throw error;
      }

      const completion = collectRuntimeHostBotTurn(session.events, turnId);
      void completion.catch(() => undefined);
      try {
        try {
          const started = await deps.client.startTurn({
            sessionId,
            turnId,
            content: { text },
          });
          if (started.kind === 'blocked') {
            return {
              kind: 'errored' as const,
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
        deps.emitSessionsChanged('status-change', sessionId, { turnId });
        return await completion;
      } finally {
        await session.close().catch(() => undefined);
      }
    },
  };
}

async function collectRuntimeHostBotTurn(
  events: AsyncIterable<SubscriptionFrame>,
  turnId: string,
): Promise<BotSessionTurnResult> {
  const assistantText = new Map<string, string>();
  let latestMessageId: string | undefined;

  for await (const frame of events) {
    if (frame.kind === 'subscription.closed') {
      throw new Error(`Runtime Host Bot Session subscription closed: ${frame.reason}`);
    }
    if (frame.kind === 'subscription.session_delta') {
      if (frame.delta.turnId !== turnId || frame.delta.kind !== 'text') continue;
      latestMessageId = frame.delta.messageId;
      const folded = foldRuntimeHostAssistantDelta(
        frame.delta.reset ? '' : (assistantText.get(latestMessageId) ?? ''),
        frame.delta,
      );
      assistantText.set(latestMessageId, folded.text);
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

function throwUnavailable(error: unknown, sessionId: string): void {
  if (
    (error instanceof RuntimeHostOperationError &&
      (error.code === 'not_found' || error.code === 'session_archived')) ||
    (error instanceof DesktopRuntimeHostClientError && error.code === 'session_not_found')
  ) {
    throw unavailableSession(sessionId, error);
  }
}

function isPermissionUpdateRefusal(error: unknown): boolean {
  return (
    (error instanceof RuntimeHostOperationError &&
      (error.code === 'session_busy' || error.code === 'operation_conflict')) ||
    (error instanceof DesktopRuntimeHostClientError && error.code === 'revision_conflict')
  );
}

function unavailableSession(sessionId: string, cause?: unknown): BotSessionUnavailableError {
  return new BotSessionUnavailableError(`Bot Session is unavailable: ${sessionId}`, { cause });
}
