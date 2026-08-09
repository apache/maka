import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeHostOperationError } from '@maka/runtime-host/client';
import {
  SESSION_CONTINUITY_SCHEMA_VERSION,
  type SessionCatalogProjection,
  type SessionContinuitySnapshot,
  type SubscriptionFrame,
  type TurnSnapshot,
} from '@maka/runtime-host/protocol';
import {
  createRuntimeHostBotSessionAdapter,
  type RuntimeHostBotSessionAdapterDeps,
} from '../runtime-host-bot-session-adapter.js';
import { runtimeHostSessionFixture } from './runtime-host-session-test-fixture.js';

type BotClient = RuntimeHostBotSessionAdapterDeps['client'];

test('resolves Host-owned conversation continuity and normalizes explore permission', async () => {
  const calls: unknown[] = [];
  const adapter = createRuntimeHostBotSessionAdapter({
    client: botClient({
      reconcileExternalConversation: async (input) => {
        calls.push(input);
        return input.kind === 'resolve' && input.session === undefined
          ? { kind: 'create_required' }
          : {
              kind: 'resolved',
              disposition: 'created',
              session: session('session-1', { permissionMode: 'ask' }),
            };
      },
      updateSessionConfiguration: async (sessionId, patch) => {
        calls.push({ sessionId, patch });
        return session(sessionId, { permissionMode: 'explore' });
      },
    }),
    resolveCreateTarget: async () => ({
      workspace: { kind: 'project', projectId: 'project-1' },
    }),
    emitSessionsChanged() {},
  });

  assert.deepEqual(
    await adapter.resolveSession({
      conversationId: 'slack:channel:C1:thread:1.2',
      name: 'Slack conversation',
      labels: ['bot', 'slack'],
    }),
    { kind: 'ready', sessionId: 'session-1' },
  );
  assert.deepEqual(calls, [
    {
      kind: 'resolve',
      conversationId: 'slack:channel:C1:thread:1.2',
    },
    {
      kind: 'resolve',
      conversationId: 'slack:channel:C1:thread:1.2',
      session: {
        workspace: { kind: 'project', projectId: 'project-1' },
        name: 'Slack conversation',
        labels: ['bot', 'slack'],
        modelTarget: { kind: 'default' },
      },
    },
    { sessionId: 'session-1', patch: { permissionMode: 'explore' } },
  ]);
});

test('does not resolve the current Desktop project for an existing binding', async () => {
  const adapter = createRuntimeHostBotSessionAdapter({
    client: botClient({
      reconcileExternalConversation: async () => ({
        kind: 'resolved',
        disposition: 'existing',
        session: session('session-1'),
      }),
    }),
    resolveCreateTarget: async () => {
      throw new Error('existing bindings must not depend on current project selection');
    },
    emitSessionsChanged() {},
  });

  assert.deepEqual(
    await adapter.resolveSession({
      conversationId: 'telegram:chat-1',
      name: 'Telegram conversation',
      labels: ['bot', 'telegram'],
    }),
    { kind: 'ready', sessionId: 'session-1' },
  );
});

test('releases continuity through an exact Host operation id', async () => {
  let captured: unknown;
  const adapter = createRuntimeHostBotSessionAdapter({
    client: botClient({
      reconcileExternalConversation: async (input) => {
        captured = input;
        return { kind: 'released', hadBinding: true };
      },
    }),
    resolveCreateTarget: hostPathCreateTarget,
    emitSessionsChanged() {},
  });

  assert.equal(
    await adapter.releaseConversation({
      conversationId: 'telegram:chat-1',
      operationId: 'bot_reset_1',
    }),
    true,
  );
  assert.deepEqual(captured, {
    kind: 'release',
    conversationId: 'telegram:chat-1',
    operationId: 'bot_reset_1',
  });
});

test('starts collecting before submitting the stable source message for the Host-selected Turn', async () => {
  const events = new AsyncFrameQueue();
  const changes: unknown[] = [];
  const replySnapshots: string[] = [];
  let closeCount = 0;
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(null),
    activeAssistantStreams: [],
    transcript: Promise.resolve([]),
    events,
    async close() {
      closeCount += 1;
      events.end();
    },
  });
  const adapter = createRuntimeHostBotSessionAdapter({
    client: botClient({
      openSession: async () => handle,
      submitMessage: async (input) => {
        assert.equal(events.started, true);
        assert.deepEqual(input, {
          sessionId: 'session-1',
          messageId: 'bot_source_1',
          content: { text: 'hello' },
          placement: 'next_turn',
        });
        events.push(projectionFrame(1, runningTurn('session-1', 'host-turn-1')));
        events.push(deltaFrame(2, 'session-1', 'host-turn-1', 0, 'Hello'));
        events.push(deltaFrame(3, 'session-1', 'host-turn-1', 5, ' world'));
        events.push(
          projectionFrame(4, {
            ...runningTurn('session-1', 'host-turn-1'),
            status: 'completed',
            terminalEventId: 'terminal-1',
          }),
        );
        return { disposition: 'turn_started', turnId: 'host-turn-1' };
      },
    }),
    resolveCreateTarget: hostPathCreateTarget,
    emitSessionsChanged: (reason, sessionId, extra) =>
      changes.push({ reason, sessionId, extra }),
  });

  assert.deepEqual(
    await adapter.runTurn({
      sessionId: 'session-1',
      messageId: 'bot_source_1',
      text: 'hello',
      onReplySnapshot: (text) => replySnapshots.push(text),
    }),
    { kind: 'completed', text: 'Hello world' },
  );
  assert.deepEqual(replySnapshots, ['Hello', 'Hello world']);
  assert.equal(closeCount, 1);
  assert.deepEqual(changes, [
    { reason: 'status-change', sessionId: 'session-1', extra: { turnId: 'host-turn-1' } },
  ]);
});

function botClient(overrides: Partial<BotClient>): BotClient {
  const unexpected = (): never => {
    throw new Error('Unexpected Runtime Host Bot client call');
  };
  return {
    reconcileExternalConversation: unexpected,
    openSession: unexpected,
    submitMessage: unexpected,
    updateSessionConfiguration: unexpected,
    ...overrides,
  };
}

function hostPathCreateTarget() {
  return Promise.resolve({
    workspace: { kind: 'host_path' as const, path: '/workspace' },
  });
}

function session(
  id: string,
  overrides: Partial<SessionCatalogProjection> = {},
): SessionCatalogProjection {
  return {
    id,
    revision: 1,
    cwd: '/workspace',
    createdAt: 1,
    lastUsedAt: 1,
    name: id,
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'test-connection',
    connectionLocked: false,
    model: 'test-model',
    permissionMode: 'explore',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    ...overrides,
  };
}

function runningTurn(sessionId: string, turnId: string): TurnSnapshot {
  return { sessionId, turnId, runId: 'run-1', status: 'running' };
}

function continuitySnapshot(rootTurn: TurnSnapshot | null): SessionContinuitySnapshot {
  return {
    schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
    session: {
      sessionId: rootTurn?.sessionId ?? 'session-1',
      metadataRevision: 1,
      status: rootTurn ? 'running' : 'active',
      createdAt: 1,
      lastUsedAt: 1,
      isArchived: false,
    },
    projectionRevision: 1,
    rootTurn,
    goal: null,
    queue: { hostEpoch: 'host-1', queueRevision: 0, steering: [], followup: [] },
    interactions: { pending: [] },
  };
}

function projectionFrame(sequence: number, rootTurn: TurnSnapshot): SubscriptionFrame {
  return {
    kind: 'subscription.session_projection',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sequence,
    snapshot: continuitySnapshot(rootTurn),
  };
}

function deltaFrame(
  sequence: number,
  sessionId: string,
  turnId: string,
  startOffset: number,
  text: string,
  reset = false,
): SubscriptionFrame {
  return {
    kind: 'subscription.session_delta',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sequence,
    sessionId,
    delta: {
      kind: 'text',
      turnId,
      runId: 'run-1',
      messageId: 'assistant-1',
      startOffset,
      text,
      ...(reset ? { reset: true } : {}),
    },
  };
}

class AsyncFrameQueue implements AsyncIterable<SubscriptionFrame> {
  readonly #frames: SubscriptionFrame[] = [];
  readonly #waiters: Array<(result: IteratorResult<SubscriptionFrame>) => void> = [];
  #ended = false;
  #started = false;

  get started(): boolean {
    return this.#started;
  }

  push(frame: SubscriptionFrame): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: frame, done: false });
    else this.#frames.push(frame);
  }

  end(): void {
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SubscriptionFrame> {
    return {
      next: () => {
        this.#started = true;
        const frame = this.#frames.shift();
        if (frame) return Promise.resolve({ value: frame, done: false });
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}
