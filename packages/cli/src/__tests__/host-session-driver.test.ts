import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { InteractionPendingSnapshot } from '@maka/runtime-host/protocol';
import type { StoredMessage } from '@maka/core/session';
import type {
  RuntimeHostConnection,
  RuntimeHostSessionTranscript,
  RuntimeHostSessionSubscription,
} from '@maka/runtime-host/client';
import type {
  OperationKey,
  SessionCatalogProjection,
  SessionContinuitySnapshot,
  SubscriptionFrame,
  TurnSnapshot,
} from '@maka/runtime-host/protocol';
import { createHostMakaSessionDriver } from '../host-session-driver.js';

describe('HostMakaSessionDriver', () => {
  test('starts lazily, projects bounded live events, and reloads the durable transcript', async () => {
    const session = sessionProjection();
    const transcriptMessages: StoredMessage[] = [
      { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'hello' },
      {
        type: 'assistant',
        id: 'assistant-1',
        turnId: 'turn-1',
        ts: 2,
        text: 'world',
        modelId: 'model-1',
      },
    ];
    const calls: string[] = [];
    const connection = fakeConnection({
      calls,
      session,
      transcript: {
        revision: 2,
        boundary: { kind: 'managed', revision: 0, displayMode: 'ask' },
        messages: transcriptMessages,
      },
      frames: [
        {
          kind: 'subscription.session_delta',
          hostEpoch: 'host-1',
          subscriptionId: 'subscription-1',
          sequence: 1,
          sessionId: session.id,
          delta: {
            kind: 'text',
            turnId: 'turn-1',
            runId: 'run-1',
            messageId: 'assistant-1',
            text: 'world',
          },
        },
        {
          kind: 'subscription.session_event',
          hostEpoch: 'host-1',
          subscriptionId: 'subscription-1',
          sequence: 2,
          sessionId: session.id,
          runId: 'run-1',
          event: {
            type: 'tool_start',
            id: 'tool-start-1',
            turnId: 'turn-1',
            ts: 2,
            toolUseId: 'tool-1',
            toolName: 'Read',
          },
        },
        {
          kind: 'subscription.session_projection',
          hostEpoch: 'host-1',
          subscriptionId: 'subscription-1',
          sequence: 3,
          snapshot: snapshot({
            ...runningTurn(),
            status: 'completed',
            terminalEventId: 'terminal-1',
          }),
        },
      ],
    });
    let id = 0;
    const driver = createHostMakaSessionDriver({
      connection,
      cwd: '/tmp',
      llmConnectionSlug: 'connection-1',
      model: 'model-1',
      newId: () => (id++ === 0 ? 'session-1' : id === 2 ? 'turn-1' : `id-${id}`),
    });

    const prepared = await driver.preparePrompt('hello');
    assert.deepEqual(calls, ['session.create']);
    const events = [];
    for await (const event of prepared.events) events.push(event);

    assert.deepEqual(
      events.map((event) => event.type),
      ['queue_update', 'text_delta', 'tool_start', 'complete'],
    );
    const toolStart = events.find((event) => event.type === 'tool_start');
    assert.equal(toolStart?.type === 'tool_start' ? toolStart.args : null, undefined);
    assert.deepEqual(calls, [
      'session.create',
      'subscription.open',
      'turn.start',
      'subscription.close',
    ]);
    assert.deepEqual(await driver.reloadTranscript?.(), transcriptMessages);
    assert.equal(driver.getSessionId(), 'session-1');
    assert.equal(driver.getPermissionMode?.(), 'ask');
  });

  test('maps Host-owned turn_started queue placement to accepted delivery', async () => {
    const session = sessionProjection();
    const calls: string[] = [];
    const connection = fakeConnection({
      calls,
      session,
      transcript: {
        revision: 1,
        boundary: { kind: 'bypass', revision: 0, displayMode: 'bypass' },
        messages: [],
      },
      frames: [],
      requestResult: (operation) =>
        operation === 'turn.message.submit'
          ? { disposition: 'turn_started', turnId: 'turn-2' }
          : undefined,
    });
    const driver = createHostMakaSessionDriver({
      connection,
      cwd: '/tmp',
      llmConnectionSlug: 'connection-1',
      model: 'model-1',
      newId: sequenceIds('session-1', 'turn-1', 'message-1'),
    });
    await driver.preparePrompt('hello');

    assert.deepEqual(await driver.steer?.('redirected'), { kind: 'queued' });
    assert.ok(calls.includes('turn.message.submit'));
  });

  test('keeps observing a Host-started followup instead of ending at the previous turn', async () => {
    const session = sessionProjection();
    const calls: string[] = [];
    const nextTurn = turnSnapshot('turn-2', 'run-2');
    const connection = fakeConnection({
      calls,
      session,
      transcript: {
        revision: 1,
        boundary: { kind: 'managed', revision: 0, displayMode: 'ask' },
        messages: [],
      },
      frames: [
        projectionFrame(1, terminalTurn(runningTurn())),
        projectionFrame(2, nextTurn),
        {
          kind: 'subscription.session_delta',
          hostEpoch: 'host-1',
          subscriptionId: 'subscription-1',
          sequence: 3,
          sessionId: session.id,
          delta: {
            kind: 'text',
            turnId: nextTurn.turnId,
            runId: nextTurn.runId,
            messageId: 'assistant-2',
            text: 'followup',
          },
        },
        projectionFrame(4, terminalTurn(nextTurn, 'terminal-2')),
      ],
      requestResult: (operation) =>
        operation === 'turn.message.submit'
          ? { disposition: 'turn_started', turnId: 'turn-2' }
          : undefined,
    });
    const driver = createHostMakaSessionDriver({
      connection,
      cwd: '/tmp',
      llmConnectionSlug: 'connection-1',
      model: 'model-1',
      newId: sequenceIds('session-1', 'turn-1', 'message-1', 'event-1'),
    });

    const prepared = await driver.preparePrompt('hello');
    const events = prepared.events[Symbol.asyncIterator]();
    assert.equal((await events.next()).value?.type, 'queue_update');
    assert.deepEqual(await driver.queueMessage?.('followup'), { kind: 'queued' });

    const delta = await events.next();
    assert.equal(delta.value?.type, 'text_delta');
    assert.equal(delta.value?.turnId, 'turn-2');
    const terminal = await events.next();
    assert.equal(terminal.value?.type, 'complete');
    assert.equal(terminal.value?.turnId, 'turn-2');
    assert.equal((await events.next()).done, true);
  });

  test('projects and answers Host-owned permission interactions', async () => {
    const session = sessionProjection();
    const requests: Array<{ operation: OperationKey; input: unknown }> = [];
    const permission = pendingPermission();
    if (permission.request.kind !== 'permission') throw new Error('Expected permission request');
    const connection = fakeConnection({
      calls: [],
      requests,
      session,
      transcript: {
        revision: 1,
        boundary: { kind: 'managed', revision: 0, displayMode: 'ask' },
        messages: [],
      },
      snapshot: snapshot(null, [permission]),
      frames: [projectionFrame(1, terminalTurn(runningTurn()))],
      requestResult: (operation) =>
        operation === 'interaction.answer'
          ? {
              ...permission,
              revision: 2,
              status: 'answered',
              outcome: {
                kind: 'permission_answer',
                reviewer: 'user',
                decision: 'allow',
                rememberForTurn: false,
                committedAt: 2,
              },
            }
          : undefined,
    });
    const driver = createHostMakaSessionDriver({
      connection,
      cwd: '/tmp',
      llmConnectionSlug: 'connection-1',
      model: 'model-1',
      newId: sequenceIds('session-1', 'turn-1'),
    });

    const prepared = await driver.preparePrompt('hello');
    const events = [];
    for await (const event of prepared.events) events.push(event);
    assert.deepEqual(
      events.map((event) => event.type),
      [
        'queue_update',
        'host_interaction_permission_request',
        'host_interaction_resolved',
        'complete',
      ],
    );
    const projected = events.find((event) => event.type === 'host_interaction_permission_request');
    assert.deepEqual(projected, {
      id: 'interaction-interaction-1',
      type: 'host_interaction_permission_request',
      turnId: 'turn-1',
      ts: projected?.ts,
      requestId: 'interaction-1',
      toolUseId: 'tool-1',
      prompt: permission.request.prompt,
    });

    await driver.respondToPermission?.({
      requestId: 'interaction-1',
      kind: 'permission',
      decision: 'allow',
      rememberForTurn: false,
    });
    assert.deepEqual(
      requests.find((request) => request.operation === 'interaction.answer')?.input,
      {
        interactionId: 'interaction-1',
        answer: {
          kind: 'permission',
          decision: 'allow',
          rememberForTurn: false,
        },
      },
    );
  });

  test('observes a turn started by another Client and marks its durable boundaries', async () => {
    const session = sessionProjection();
    const connection = fakeConnection({
      calls: [],
      session,
      transcript: {
        revision: 1,
        boundary: { kind: 'managed', revision: 0, displayMode: 'ask' },
        messages: [],
      },
      frames: [
        projectionFrame(1, runningTurn()),
        {
          kind: 'subscription.session_delta',
          hostEpoch: 'host-1',
          subscriptionId: 'subscription-1',
          sequence: 2,
          sessionId: session.id,
          delta: {
            kind: 'text',
            turnId: 'turn-1',
            runId: 'run-1',
            messageId: 'assistant-1',
            text: 'remote output',
          },
        },
        projectionFrame(3, terminalTurn(runningTurn())),
      ],
    });
    const driver = createHostMakaSessionDriver({
      connection,
      cwd: '/tmp',
      llmConnectionSlug: 'connection-1',
      model: 'model-1',
      newId: sequenceIds('event-1'),
    });
    const observations: Array<{
      eventTypes: string[];
      reloadTranscript: boolean;
      activeTurn: boolean;
    }> = [];
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const unsubscribe = driver.subscribeSessionObservations?.((observation) => {
      observations.push({
        eventTypes: observation.events.map((event) => event.type),
        reloadTranscript: observation.reloadTranscript,
        activeTurn: observation.activeTurn,
      });
      if (
        observation.reloadTranscript &&
        !observation.activeTurn &&
        observation.events.some((event) => event.type === 'complete')
      ) {
        finish();
      }
    });

    await driver.switchSession(session.id);
    await finished;
    unsubscribe?.();

    assert.ok(
      observations.some((observation) => observation.reloadTranscript && observation.activeTurn),
    );
    assert.ok(observations.some((observation) => observation.eventTypes.includes('text_delta')));
    assert.ok(
      observations.some(
        (observation) =>
          observation.reloadTranscript &&
          !observation.activeTurn &&
          observation.eventTypes.includes('complete'),
      ),
    );
  });

  test('projects catch-up frames when joining a Turn that is already running', async () => {
    const session = sessionProjection();
    const connection = fakeConnection({
      calls: [],
      session,
      transcript: {
        revision: 1,
        boundary: { kind: 'managed', revision: 0, displayMode: 'ask' },
        messages: [],
      },
      snapshot: snapshot(runningTurn()),
      frames: [
        {
          kind: 'subscription.session_delta',
          hostEpoch: 'host-1',
          subscriptionId: 'subscription-1',
          sequence: 1,
          sessionId: session.id,
          delta: {
            kind: 'text',
            turnId: 'turn-1',
            runId: 'run-1',
            messageId: 'assistant-1',
            text: 'output before this Client joined',
          },
        },
        {
          kind: 'subscription.session_delta',
          hostEpoch: 'host-1',
          subscriptionId: 'subscription-1',
          sequence: 2,
          sessionId: session.id,
          delta: {
            kind: 'text',
            turnId: 'turn-1',
            runId: 'run-1',
            messageId: 'assistant-1',
            text: ' and output after it joined',
          },
        },
        projectionFrame(3, terminalTurn(runningTurn())),
      ],
    });
    const driver = createHostMakaSessionDriver({
      connection,
      cwd: '/tmp',
      llmConnectionSlug: 'connection-1',
      model: 'model-1',
      newId: sequenceIds('event-1', 'event-2'),
    });
    const observedText: string[] = [];
    const activeStates: boolean[] = [];
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const unsubscribe = driver.subscribeSessionObservations?.((observation) => {
      activeStates.push(observation.activeTurn);
      for (const event of observation.events) {
        if (event.type === 'text_delta') observedText.push(event.text);
      }
      if (!observation.activeTurn) finish();
    });

    await driver.switchSession(session.id);
    await finished;
    unsubscribe?.();

    assert.equal(activeStates[0], true);
    assert.deepEqual(observedText, [
      'output before this Client joined',
      ' and output after it joined',
    ]);
  });

  test('requests a durable reload when the initial subscription cut is terminal', async () => {
    const session = sessionProjection();
    const connection = fakeConnection({
      calls: [],
      session,
      transcript: {
        revision: 1,
        boundary: { kind: 'managed', revision: 0, displayMode: 'ask' },
        messages: [],
      },
      snapshot: snapshot(terminalTurn(runningTurn())),
      frames: [],
    });
    const driver = createHostMakaSessionDriver({
      connection,
      cwd: '/tmp',
      llmConnectionSlug: 'connection-1',
      model: 'model-1',
    });
    let initial:
      | {
          reloadTranscript: boolean;
          activeTurn: boolean;
        }
      | undefined;
    let observed!: () => void;
    const observation = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const unsubscribe = driver.subscribeSessionObservations?.((value) => {
      initial ??= {
        reloadTranscript: value.reloadTranscript,
        activeTurn: value.activeTurn,
      };
      observed();
    });

    await driver.switchSession(session.id);
    await observation;
    unsubscribe?.();

    assert.deepEqual(initial, { reloadTranscript: true, activeTurn: false });
  });

  test('fails closed when a resumed Session belongs to an external harness', async () => {
    const session = sessionProjection();
    const connection = fakeConnection({
      calls: [],
      session,
      transcript: {
        revision: 1,
        boundary: { kind: 'external', revision: 0, displayMode: null },
        messages: [],
      },
      frames: [],
    });
    const driver = createHostMakaSessionDriver({
      connection,
      cwd: '/tmp',
      llmConnectionSlug: 'connection-1',
      model: 'model-1',
    });

    await assert.rejects(
      driver.switchSession('session-1'),
      /externally isolated session session-1/,
    );
    assert.equal(driver.getSessionId(), null);
  });
});

interface FakeConnectionInput {
  readonly calls: string[];
  readonly requests?: Array<{ operation: OperationKey; input: unknown }>;
  readonly session: SessionCatalogProjection;
  readonly transcript: RuntimeHostSessionTranscript;
  readonly snapshot?: SessionContinuitySnapshot;
  readonly frames: readonly SubscriptionFrame[];
  readonly requestResult?: (operation: OperationKey) => unknown;
}

function fakeConnection(input: FakeConnectionInput): RuntimeHostConnection {
  const subscription: RuntimeHostSessionSubscription = {
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    snapshot: input.snapshot ?? snapshot(null),
    async *[Symbol.asyncIterator]() {
      yield* input.frames;
    },
    async close() {
      input.calls.push('subscription.close');
    },
  };
  return {
    hostEpoch: 'host-1',
    connectionId: 'connection-1',
    selectedProtocol: 0,
    closed: new Promise(() => {}),
    async request(operation: OperationKey, operationInput: unknown) {
      input.calls.push(operation);
      input.requests?.push({ operation, input: operationInput });
      const override = input.requestResult?.(operation);
      if (override !== undefined) return override;
      if (operation === 'session.create') return input.session;
      if (operation === 'session.catalog.query') {
        return { kind: 'session', session: input.session };
      }
      throw new Error(`Unexpected operation: ${operation}`);
    },
    async status() {
      throw new Error('not used');
    },
    async startTurn() {
      input.calls.push('turn.start');
      return runningTurn();
    },
    async queryTurn() {
      throw new Error('not used');
    },
    async stopTurn() {
      throw new Error('not used');
    },
    async readSessionTranscript() {
      return input.transcript;
    },
    async openSessionSubscription() {
      input.calls.push('subscription.open');
      return subscription;
    },
    async close() {},
  } as RuntimeHostConnection;
}

function sessionProjection(): SessionCatalogProjection {
  return {
    id: 'session-1',
    revision: 1,
    cwd: '/tmp',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Session',
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'connection-1',
    connectionLocked: false,
    model: 'model-1',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
  };
}

function snapshot(
  rootTurn: TurnSnapshot | null,
  interactions: readonly InteractionPendingSnapshot[] = [],
): SessionContinuitySnapshot {
  return {
    schemaVersion: 2,
    session: {
      sessionId: 'session-1',
      metadataRevision: 1,
      status: rootTurn && !isTerminal(rootTurn) ? 'running' : 'active',
      createdAt: 1,
      lastUsedAt: 1,
      isArchived: false,
    },
    projectionRevision: rootTurn ? 2 : 1,
    rootTurn,
    queue: {
      hostEpoch: 'host-1',
      queueRevision: 0,
      steering: [],
      followup: [],
    },
    interactions: { pending: interactions },
  };
}

function runningTurn(): TurnSnapshot {
  return turnSnapshot('turn-1', 'run-1');
}

function turnSnapshot(turnId: string, runId: string): TurnSnapshot {
  return { sessionId: 'session-1', turnId, runId, status: 'running' };
}

function terminalTurn(turn: TurnSnapshot, terminalEventId = 'terminal-1'): TurnSnapshot {
  return { ...turn, status: 'completed', terminalEventId };
}

function projectionFrame(sequence: number, rootTurn: TurnSnapshot): SubscriptionFrame {
  return {
    kind: 'subscription.session_projection',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sequence,
    snapshot: snapshot(rootTurn),
  };
}

function pendingPermission(): InteractionPendingSnapshot {
  return {
    schemaVersion: 1,
    interactionId: 'interaction-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    runId: 'run-1',
    revision: 1,
    request: {
      kind: 'permission',
      toolUseId: 'tool-1',
      prompt: {
        kind: 'tool_permission',
        toolName: 'Bash',
        category: 'shell_unsafe',
        reason: 'shell_dangerous',
        review: { kind: 'command', command: 'npm test', cwd: '/tmp' },
        rememberForTurnAllowed: true,
      },
    },
    status: 'pending',
    outcome: null,
  };
}

function isTerminal(turn: TurnSnapshot): boolean {
  return turn.status === 'completed' || turn.status === 'failed' || turn.status === 'cancelled';
}

function sequenceIds(...ids: string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? `id-${index}`;
}
