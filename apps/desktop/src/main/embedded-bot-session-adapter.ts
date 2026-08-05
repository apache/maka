import type { SessionChangedEvent, SessionChangedReason, SessionEvent } from '@maka/core';
import type { GoalTurnOutcome, SessionManager } from '@maka/runtime';
import {
  BotSessionUnavailableError,
  type BotSessionAdapter,
} from './bot-session-adapter.js';
import type { DesktopCreateSessionInput } from './new-session-project.js';
import {
  assertSessionCanSendFromHeader,
  isSessionLifecycleError,
} from './session-lifecycle.js';

interface EmbeddedBotSessionAdapterDeps {
  runtime: SessionManager;
  createSession: (
    input: DesktopCreateSessionInput,
  ) => ReturnType<SessionManager['createSession']>;
  getDefaultConnectionSlug(): Promise<string | null>;
  getReadyConnection(
    slug: string | null | undefined,
    model?: string,
  ): Promise<{ connection: { slug: string }; model: string }>;
  readSessionHeader(sessionId: string): Promise<{
    permissionMode: string;
    isArchived: boolean;
    status: string;
  }>;
  ensureSessionCanSend(sessionId: string): Promise<void>;
  emitSessionsChanged(
    reason: SessionChangedReason,
    sessionId?: string,
    extra?: Pick<SessionChangedEvent, 'connectionSlug' | 'modelId'>,
  ): void;
  runAgentTurn(input: {
    sessionId: string;
    iterator: AsyncIterable<SessionEvent>;
    turnId: string;
    onEvent: (event: SessionEvent) => void;
  }): Promise<{ outcome: GoalTurnOutcome; error?: string }>;
}

export function createEmbeddedBotSessionAdapter(
  deps: EmbeddedBotSessionAdapterDeps,
): BotSessionAdapter {
  return {
    async createSession(input) {
      const ready = await deps.getReadyConnection(
        await deps.getDefaultConnectionSlug(),
        undefined,
      );
      const summary = await deps.createSession({
        backend: 'ai-sdk',
        llmConnectionSlug: ready.connection.slug,
        model: ready.model,
        permissionMode: 'explore',
        name: input.name,
        labels: [...input.labels],
      });
      deps.emitSessionsChanged('created', summary.id);
      await deps.ensureSessionCanSend(summary.id);
      return summary.id;
    },

    async prepareSession(sessionId) {
      try {
        const header = await deps.readSessionHeader(sessionId);
        assertSessionCanSendFromHeader(header);
        try {
          await deps.runtime.setPermissionMode(sessionId, 'explore');
        } catch (error) {
          if (isSessionLifecycleError(error)) throw error;
          return 'permission_refused';
        }
        deps.emitSessionsChanged('updated', sessionId);
        await deps.ensureSessionCanSend(sessionId);
        return 'ready';
      } catch (error) {
        if (!isSessionLifecycleError(error)) throw error;
        throw new BotSessionUnavailableError(error.message, { cause: error });
      }
    },

    async runTurn({ sessionId, turnId, text }) {
      const iterator = deps.runtime.sendMessage(sessionId, { turnId, text });
      let latestText = '';
      const result = await deps.runAgentTurn({
        sessionId,
        iterator,
        turnId,
        onEvent: (event) => {
          if (event.type === 'text_complete') latestText = event.text;
        },
      });
      if (result.outcome.kind === 'suspended') return { kind: 'suspended' };
      if (result.outcome.kind === 'errored') {
        return {
          kind: 'errored',
          reason: result.error ?? result.outcome.reason,
        };
      }
      return { kind: 'completed', text: latestText };
    },
  };
}
