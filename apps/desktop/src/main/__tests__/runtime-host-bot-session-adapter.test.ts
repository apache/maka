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
import { BotSessionUnavailableError } from '../bot-session-adapter.js';
import {
  createRuntimeHostBotSessionAdapter,
  type RuntimeHostBotSessionAdapterDeps,
} from '../runtime-host-bot-session-adapter.js';
import { runtimeHostSessionFixture } from './runtime-host-session-test-fixture.js';

type BotClient = RuntimeHostBotSessionAdapterDeps['client'];

test('creates an explore Session through the Host-owned default model route', async () => {
  const creates: unknown[] = [];
  const changes: unknown[] = [];
  const client = botClient({
    createSession: async (input) => {
      creates.push(input);
      return session(input.sessionId, { permissionMode: 'explore' });
    },
  });
  const adapter = createRuntimeHostBotSessionAdapter({
    client,
    resolveCreateTarget: async () => ({
      workspace: { kind: 'project', projectId: 'project-1' },
    }),
    emitSessionsChanged: (reason, sessionId, extra) =>
      changes.push({ reason, sessionId, extra }),
    newId: () => 'bot-session-1',
  });

  const sessionId = await adapter.createSession({
    name: 'Telegram conversation',
    labels: ['bot', 'telegram'],
  });

  assert.equal(sessionId, 'bot-session-1');
  assert.deepEqual(creates, [
    {
      sessionId: 'bot-session-1',
      workspace: { kind: 'project', projectId: 'project-1' },
      name: 'Telegram conversation',
      labels: ['bot', 'telegram'],
      modelTarget: { kind: 'default' },
      permissionMode: 'explore',
    },
  ]);
  assert.deepEqual(changes, [
    { reason: 'created', sessionId: 'bot-session-1', extra: undefined },
  ]);
});

test('prepares a bound Session without exposing Host configuration revisions to the Bot', async () => {
  const updates: unknown[] = [];
  const client = botClient({
    getSession: async () => session('bot-session-1', { permissionMode: 'ask' }),
    updateSessionConfiguration: async (sessionId, patch) => {
      updates.push({ sessionId, patch });
      return session(sessionId, { permissionMode: 'explore' });
    },
  });
  const adapter = createRuntimeHostBotSessionAdapter({
    client,
    resolveCreateTarget: hostPathCreateTarget,
    emitSessionsChanged() {},
  });

  assert.equal(await adapter.prepareSession('bot-session-1'), 'ready');
  assert.deepEqual(updates, [
    { sessionId: 'bot-session-1', patch: { permissionMode: 'explore' } },
  ]);

  const unavailable = createRuntimeHostBotSessionAdapter({
    client: botClient({ getSession: async () => null }),
    resolveCreateTarget: hostPathCreateTarget,
    emitSessionsChanged() {},
  });
  await assert.rejects(
    unavailable.prepareSession('removed-session'),
    BotSessionUnavailableError,
  );
});

test('rejects archived Sessions before and after a permission transition', async () => {
  const initiallyArchived = createRuntimeHostBotSessionAdapter({
    client: botClient({
      getSession: async () =>
        session('bot-session-1', { isArchived: true, status: 'active' }),
    }),
    resolveCreateTarget: hostPathCreateTarget,
    emitSessionsChanged() {},
  });
  await assert.rejects(
    initiallyArchived.prepareSession('bot-session-1'),
    BotSessionUnavailableError,
  );

  const archivedDuringUpdate = createRuntimeHostBotSessionAdapter({
    client: botClient({
      getSession: async () => session('bot-session-1', { permissionMode: 'ask' }),
      updateSessionConfiguration: async (sessionId) =>
        session(sessionId, {
          permissionMode: 'explore',
          isArchived: true,
          status: 'active',
        }),
    }),
    resolveCreateTarget: hostPathCreateTarget,
    emitSessionsChanged() {},
  });
  await assert.rejects(
    archivedDuringUpdate.prepareSession('bot-session-1'),
    BotSessionUnavailableError,
  );
});

test('reconciles an uncertain Host Session create with its stable Session identity', async () => {
  const adapter = createRuntimeHostBotSessionAdapter({
    client: botClient({
      createSession: async () => {
        throw new RuntimeHostOperationError(
          'session.create',
          'commit_outcome_unknown',
          'response lost',
        );
      },
      getSession: async (sessionId) => session(sessionId, { permissionMode: 'explore' }),
    }),
    resolveCreateTarget: hostPathCreateTarget,
    emitSessionsChanged() {},
    newId: () => 'stable-session-id',
  });

  assert.equal(
    await adapter.createSession({ name: 'Bot conversation', labels: ['bot'] }),
    'stable-session-id',
  );
});

test('subscribes before Turn start and settles a fast Host reply without losing text', async () => {
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
  const client = botClient({
    openSession: async () => handle,
    startTurn: async (input) => {
      assert.equal(events.nextCount, 1, 'the subscription must be draining before Turn start');
      events.push(projectionFrame(1, runningTurn(input.sessionId, input.turnId)));
      events.push(deltaFrame(2, input.sessionId, input.turnId, 0, 'Hello'));
      events.push(deltaFrame(3, input.sessionId, input.turnId, 3, 'lo world'));
      events.push(deltaFrame(4, input.sessionId, input.turnId, 0, 'Hello world'));
      events.push(deltaFrame(5, input.sessionId, input.turnId, 0, 'Corrected reply', true));
      events.push(
        projectionFrame(6, {
          ...runningTurn(input.sessionId, input.turnId),
          status: 'completed',
          terminalEventId: 'terminal-1',
        }),
      );
      return startedTurn(runningTurn(input.sessionId, input.turnId));
    },
  });
  const adapter = createRuntimeHostBotSessionAdapter({
    client,
    resolveCreateTarget: hostPathCreateTarget,
    emitSessionsChanged: (reason, sessionId, extra) =>
      changes.push({ reason, sessionId, extra }),
  });

  const result = await adapter.runTurn({
    sessionId: 'bot-session-1',
    turnId: 'turn-1',
    text: 'hello',
    onReplySnapshot: (text) => replySnapshots.push(text),
  });

  assert.deepEqual(result, { kind: 'completed', text: 'Corrected reply' });
  assert.deepEqual(replySnapshots, ['Hello', 'Hello world', 'Corrected reply']);
  assert.equal(closeCount, 1);
  assert.deepEqual(changes, [
    {
      reason: 'status-change',
      sessionId: 'bot-session-1',
      extra: { turnId: 'turn-1' },
    },
  ]);
});

test('accepts an empty reset delta as the authoritative Bot reply', async () => {
  const events = new AsyncFrameQueue();
  const replySnapshots: string[] = [];
  const adapter = createRuntimeHostBotSessionAdapter({
    client: botClient({
      openSession: async () => runtimeHostSessionFixture({
        snapshot: continuitySnapshot(null),
        activeAssistantStreams: [],
        transcript: Promise.resolve([]),
        events,
        async close() {
          events.end();
        },
      }),
      startTurn: async (input) => {
        events.push(deltaFrame(1, input.sessionId, input.turnId, 0, 'Provisional reply'));
        events.push(deltaFrame(2, input.sessionId, input.turnId, 0, '', true));
        events.push(
          projectionFrame(3, {
            ...runningTurn(input.sessionId, input.turnId),
            status: 'completed',
            terminalEventId: 'terminal-1',
          }),
        );
        return startedTurn(runningTurn(input.sessionId, input.turnId));
      },
    }),
    resolveCreateTarget: hostPathCreateTarget,
    emitSessionsChanged() {},
  });

  assert.deepEqual(
    await adapter.runTurn({
      sessionId: 'bot-session-1',
      turnId: 'turn-1',
      text: 'hello',
      onReplySnapshot: (text) => replySnapshots.push(text),
    }),
    { kind: 'completed', text: '' },
  );
  assert.deepEqual(replySnapshots, ['Provisional reply', '']);
});

test('reply snapshot observers cannot interrupt the authoritative Host Turn', async () => {
  const events = new AsyncFrameQueue();
  const adapter = createRuntimeHostBotSessionAdapter({
    client: botClient({
      openSession: async () => runtimeHostSessionFixture({
        snapshot: continuitySnapshot(null),
        activeAssistantStreams: [],
        transcript: Promise.resolve([]),
        events,
        async close() {
          events.end();
        },
      }),
      startTurn: async (input) => {
        events.push(deltaFrame(1, input.sessionId, input.turnId, 0, 'Reply'));
        events.push(
          projectionFrame(2, {
            ...runningTurn(input.sessionId, input.turnId),
            status: 'completed',
            terminalEventId: 'terminal-1',
          }),
        );
        return startedTurn(runningTurn(input.sessionId, input.turnId));
      },
    }),
    resolveCreateTarget: hostPathCreateTarget,
    emitSessionsChanged() {},
  });

  assert.deepEqual(
    await adapter.runTurn({
      sessionId: 'bot-session-1',
      turnId: 'turn-1',
      text: 'hello',
      onReplySnapshot() {
        throw new Error('delivery failed');
      },
    }),
    { kind: 'completed', text: 'Reply' },
  );
});

test('returns blocked Skill feedback without waiting for a Turn that was not created', async () => {
  const events = new AsyncFrameQueue();
  let closeCount = 0;
  const adapter = createRuntimeHostBotSessionAdapter({
    client: botClient({
      openSession: async () => runtimeHostSessionFixture({
        snapshot: continuitySnapshot(null),
        activeAssistantStreams: [],
        transcript: Promise.resolve([]),
        events,
        async close() {
          closeCount += 1;
          events.end();
        },
      }),
      startTurn: async () => ({
        kind: 'blocked',
        skillInvocation: {
          loaded: [],
          failed: [{ request: 'writer', reason: 'not_found' }],
          receipts: [],
        },
      }),
    }),
    resolveCreateTarget: hostPathCreateTarget,
    emitSessionsChanged() {},
  });

  assert.deepEqual(
    await adapter.runTurn({
      sessionId: 'bot-session-1',
      turnId: 'turn-blocked',
      text: '/skill:writer help',
    }),
    { kind: 'errored', reason: 'writer: not_found' },
  );
  assert.equal(closeCount, 1);
});

test('projects Host interaction and failure outcomes into the Bot reply contract', async () => {
  const suspended = await runProjectedTurn({
    ...runningTurn('bot-session-1', 'turn-1'),
    status: 'waiting_for_user',
  });
  const failed = await runProjectedTurn({
    ...runningTurn('bot-session-1', 'turn-1'),
    status: 'failed',
    terminalEventId: 'terminal-1',
    failureClass: 'model_unavailable',
  });

  assert.deepEqual(suspended, { kind: 'suspended' });
  assert.deepEqual(failed, { kind: 'errored', reason: 'model_unavailable' });
});

async function runProjectedTurn(rootTurn: TurnSnapshot) {
  const events = new AsyncFrameQueue();
  const adapter = createRuntimeHostBotSessionAdapter({
    client: botClient({
      openSession: async () => runtimeHostSessionFixture({
        snapshot: continuitySnapshot(null),
        activeAssistantStreams: [],
        transcript: Promise.resolve([]),
        events,
        async close() {
          events.end();
        },
      }),
      startTurn: async () => {
        events.push(projectionFrame(1, rootTurn));
        return startedTurn(runningTurn(rootTurn.sessionId, rootTurn.turnId));
      },
    }),
    resolveCreateTarget: hostPathCreateTarget,
    emitSessionsChanged() {},
  });
  return adapter.runTurn({
    sessionId: rootTurn.sessionId,
    turnId: rootTurn.turnId,
    text: 'hello',
  });
}

function botClient(overrides: Partial<BotClient>): BotClient {
  const unexpected = (): never => {
    throw new Error('Unexpected Runtime Host Bot client call');
  };
  return {
    createSession: unexpected,
    getSession: unexpected,
    openSession: unexpected,
    startTurn: unexpected,
    updateSessionConfiguration: unexpected,
    ...overrides,
  };
}

function session(
  id: string,
  overrides: Partial<SessionCatalogProjection> = {},
): SessionCatalogProjection {
  return {
    id,
    revision: 1,
    workspace: {
      target: { kind: 'host_path', path: '/workspace' },
      hostCwd: '/workspace',
    },
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
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    ...overrides,
  };
}

async function hostPathCreateTarget() {
  return { workspace: { kind: 'host_path' as const, path: '/workspace' } };
}

function runningTurn(sessionId: string, turnId: string): TurnSnapshot {
  return { sessionId, turnId, runId: 'run-1', status: 'running' };
}

function startedTurn(turn: TurnSnapshot) {
  return {
    kind: 'started' as const,
    turn,
    skillInvocation: { loaded: [], failed: [], receipts: [] },
  };
}

function continuitySnapshot(rootTurn: TurnSnapshot | null): SessionContinuitySnapshot {
  return {
    schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
    session: {
      sessionId: 'bot-session-1',
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
      messageId: 'message-1',
      startOffset,
      text,
      ...(reset ? { reset: true } : {}),
    },
  };
}

class AsyncFrameQueue implements AsyncIterable<SubscriptionFrame> {
  readonly #frames: SubscriptionFrame[] = [];
  readonly #waiters: Array<(result: IteratorResult<SubscriptionFrame>) => void> = [];
  nextCount = 0;
  #ended = false;

  push(frame: SubscriptionFrame): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: frame, done: false });
    else this.#frames.push(frame);
  }

  end(): void {
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SubscriptionFrame> {
    return {
      next: () => {
        this.nextCount += 1;
        const frame = this.#frames.shift();
        if (frame) return Promise.resolve({ value: frame, done: false });
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}
