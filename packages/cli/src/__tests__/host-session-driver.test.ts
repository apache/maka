import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { InteractionPendingSnapshot } from '@maka/runtime-host/protocol';
import type { StoredMessage } from '@maka/core/session';
import type {
  RuntimeHostConnection,
  RuntimeHostSessionTranscript,
  RuntimeHostSessionSubscription,
} from '@maka/runtime-host/client';
import { RuntimeHostOperationError, RuntimeHostSubscriptionError } from '@maka/runtime-host/client';
import type {
  OperationKey,
  SessionCatalogProjection,
  SessionContinuitySnapshot,
  SubscriptionFrame,
  TurnStartInput,
  TurnStopInput,
  TurnSnapshot,
} from '@maka/runtime-host/protocol';
import { createHostMakaSessionDriver } from '../host-session-driver.js';
import type { MakaSessionObservation } from '../session-driver.js';

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
    assert.deepEqual(await driver.sessionObservation?.reloadTranscript(), transcriptMessages);
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

  test('forwards trusted per-turn orchestration to Host admission', async () => {
    const session = sessionProjection();
    const turnStarts: TurnStartInput[] = [];
    const connection = fakeConnection({
      calls: [],
      turnStarts,
      session,
      transcript: {
        revision: 1,
        boundary: { kind: 'managed', revision: 0, displayMode: 'ask' },
        messages: [],
      },
      frames: [projectionFrame(1, terminalTurn(runningTurn()))],
    });
    const driver = createHostMakaSessionDriver({
      connection,
      cwd: '/tmp',
      llmConnectionSlug: 'connection-1',
      model: 'model-1',
      newId: sequenceIds('session-1', 'turn-1'),
    });

    const prepared = await driver.preparePrompt('coordinate this', {
      turnOrchestration: { mode: 'graph', source: 'slash_command' },
    });
    for await (const _event of prepared.events) {
      // Drain the Host-owned turn.
    }

    assert.deepEqual(turnStarts, [
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        content: { text: 'coordinate this' },
        turnOrchestration: { mode: 'graph', source: 'slash_command' },
      },
    ]);
  });

  test('interrupt waits for an admitted turn identity while turn.start is pending', async () => {
    const session = sessionProjection();
    const calls: string[] = [];
    const requests: Array<{ operation: OperationKey; input: unknown }> = [];
    const start = deferred<TurnSnapshot>();
    const connection = fakeConnection({
      calls,
      requests,
      session,
      transcript: {
        revision: 1,
        boundary: { kind: 'managed', revision: 0, displayMode: 'ask' },
        messages: [],
      },
      frames: [],
      startTurnResult: start.promise,
      requestResult: (operation) =>
        operation === 'turn.interrupt'
          ? {
              queueRevision: 1,
              retracted: [],
              turn: {
                ...runningTurn(),
                status: 'cancelled',
                terminalEventId: 'terminal-1',
                abortSource: 'user_stop',
              },
            }
          : undefined,
    });
    const driver = createHostMakaSessionDriver({
      connection,
      cwd: '/tmp',
      llmConnectionSlug: 'connection-1',
      model: 'model-1',
      newId: sequenceIds('session-1', 'turn-1', 'interrupt-1'),
    });

    const prepared = await driver.preparePrompt('hello');
    const events = prepared.events[Symbol.asyncIterator]();
    const firstEvent = events.next();
    while (!calls.includes('turn.start')) await new Promise((resolve) => setImmediate(resolve));

    const interrupted = driver.interrupt?.();
    await Promise.resolve();
    assert.ok(!calls.includes('turn.interrupt'));

    start.resolve(runningTurn());
    assert.equal(await interrupted, '');
    assert.equal((await firstEvent).value?.type, 'queue_update');
    await events.return?.();
    assert.deepEqual(
      requests.filter((request) => request.operation === 'turn.interrupt'),
      [
        {
          operation: 'turn.interrupt',
          input: {
            originHostEpoch: 'host-1',
            sessionId: 'session-1',
            interruptId: 'interrupt-1',
            turnId: 'turn-1',
            runId: 'run-1',
          },
        },
      ],
    );
  });

  test('stop waits for an admitted turn identity while turn.start is pending', async () => {
    const session = sessionProjection();
    const calls: string[] = [];
    const turnStops: TurnStopInput[] = [];
    const start = deferred<TurnSnapshot>();
    const connection = fakeConnection({
      calls,
      turnStops,
      session,
      transcript: {
        revision: 1,
        boundary: { kind: 'managed', revision: 0, displayMode: 'ask' },
        messages: [],
      },
      frames: [],
      startTurnResult: start.promise,
    });
    const driver = createHostMakaSessionDriver({
      connection,
      cwd: '/tmp',
      llmConnectionSlug: 'connection-1',
      model: 'model-1',
      newId: sequenceIds('session-1', 'turn-1'),
    });
    const prepared = await driver.preparePrompt('hello');
    const events = prepared.events[Symbol.asyncIterator]();
    const firstEvent = events.next();
    await waitFor(() => calls.includes('turn.start'));

    const stopped = driver.stop();
    await Promise.resolve();
    assert.ok(!calls.includes('turn.stop'));

    start.resolve(runningTurn());
    await stopped;
    assert.equal((await firstEvent).value?.type, 'queue_update');
    await events.return?.();
    assert.deepEqual(turnStops, [{ sessionId: 'session-1', turnId: 'turn-1', runId: 'run-1' }]);
  });

  test('keeps a newly observed remote turn identity when the local stream closes', async () => {
    const session = sessionProjection();
    const calls: string[] = [];
    const requests: Array<{ operation: OperationKey; input: unknown }> = [];
    const publishRemote = deferred<void>();
    const remoteConsumed = deferred<void>();
    const localCloseStarted = deferred<void>();
    const releaseLocalClose = deferred<void>();
    const remoteTurn = turnSnapshot('turn-remote', 'run-remote');
    const initialObservation: RuntimeHostSessionSubscription = {
      hostEpoch: 'host-1',
      subscriptionId: 'observation-1',
      snapshot: snapshot(null),
      async *[Symbol.asyncIterator]() {
        await publishRemote.promise;
        yield projectionFrame(1, remoteTurn);
        remoteConsumed.resolve();
        await new Promise(() => {});
      },
      async close() {},
    };
    const localTurn: RuntimeHostSessionSubscription = {
      hostEpoch: 'host-1',
      subscriptionId: 'local-turn',
      snapshot: snapshot(null),
      async *[Symbol.asyncIterator]() {
        yield projectionFrame(1, terminalTurn(runningTurn()));
      },
      async close() {
        localCloseStarted.resolve();
        await releaseLocalClose.promise;
      },
    };
    const reconciledObservation: RuntimeHostSessionSubscription = {
      hostEpoch: 'host-1',
      subscriptionId: 'observation-2',
      snapshot: snapshot(remoteTurn),
      async *[Symbol.asyncIterator]() {
        await new Promise(() => {});
      },
      async close() {},
    };
    const connection = fakeConnection({
      calls,
      requests,
      session,
      transcript: {
        revision: 1,
        boundary: { kind: 'managed', revision: 0, displayMode: 'ask' },
        messages: [],
      },
      frames: [],
      subscriptions: [initialObservation, localTurn, reconciledObservation],
      requestResult: (operation) =>
        operation === 'turn.interrupt'
          ? {
              queueRevision: 1,
              retracted: [],
              turn: {
                ...remoteTurn,
                status: 'cancelled',
                terminalEventId: 'terminal-remote',
                abortSource: 'user_stop',
              },
            }
          : undefined,
    });
    const driver = createHostMakaSessionDriver({
      connection,
      cwd: '/tmp',
      llmConnectionSlug: 'connection-1',
      model: 'model-1',
      newId: sequenceIds('turn-1', 'interrupt-remote'),
    });
    let observeRemote!: () => void;
    const remoteObserved = new Promise<void>((resolve) => {
      observeRemote = resolve;
    });
    const unsubscribe = driver.sessionObservation?.subscribe((observation) => {
      if (observation.cut === 'active') observeRemote();
    });

    await driver.switchSession(session.id);
    await waitFor(() => calls.filter((call) => call === 'subscription.open').length === 1);
    const prepared = await driver.preparePrompt('local prompt');
    const drain = (async () => {
      for await (const _event of prepared.events) {
        // Drain through local subscription cleanup.
      }
    })();
    await localCloseStarted.promise;
    publishRemote.resolve();
    await remoteConsumed.promise;
    releaseLocalClose.resolve();
    await drain;
    await remoteObserved;

    await driver.interrupt?.();
    unsubscribe?.();

    const interrupt = requests.find((request) => request.operation === 'turn.interrupt');
    assert.deepEqual(interrupt?.input, {
      originHostEpoch: 'host-1',
      sessionId: 'session-1',
      interruptId: 'interrupt-remote',
      turnId: 'turn-remote',
      runId: 'run-remote',
    });
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
      cut: MakaSessionObservation['cut'];
    }> = [];
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const unsubscribe = driver.sessionObservation?.subscribe((observation) => {
      observations.push({
        eventTypes: observation.events.map((event) => event.type),
        reloadTranscript: observation.reloadTranscript,
        cut: observation.cut,
      });
      if (
        observation.reloadTranscript &&
        observation.cut === 'idle' &&
        observation.events.some((event) => event.type === 'complete')
      ) {
        finish();
      }
    });

    await driver.switchSession(session.id);
    await finished;
    unsubscribe?.();

    assert.ok(
      observations.some(
        (observation) => observation.reloadTranscript && observation.cut === 'active',
      ),
    );
    assert.ok(observations.some((observation) => observation.eventTypes.includes('text_delta')));
    assert.ok(
      observations.some(
        (observation) =>
          observation.reloadTranscript &&
          observation.cut === 'idle' &&
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
    const cuts: MakaSessionObservation['cut'][] = [];
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const unsubscribe = driver.sessionObservation?.subscribe((observation) => {
      cuts.push(observation.cut);
      for (const event of observation.events) {
        if (event.type === 'text_delta') observedText.push(event.text);
      }
      if (observation.cut === 'idle') finish();
    });

    await driver.switchSession(session.id);
    await finished;
    unsubscribe?.();

    assert.equal(cuts[0], 'active');
    assert.deepEqual(observedText, [
      'output before this Client joined',
      ' and output after it joined',
    ]);
  });

  test('reopens a slow-consumer observation from a fresh durable cut', {
    timeout: 2_000,
  }, async () => {
    const session = sessionProjection();
    const calls: string[] = [];
    const slowConsumer: RuntimeHostSessionSubscription = {
      hostEpoch: 'host-1',
      subscriptionId: 'subscription-1',
      snapshot: snapshot(runningTurn()),
      async *[Symbol.asyncIterator]() {
        throw new RuntimeHostSubscriptionError(
          'slow_consumer',
          'Session subscription consumer exceeded its local queue bound',
        );
      },
      async close() {},
    };
    const recovered: RuntimeHostSessionSubscription = {
      hostEpoch: 'host-1',
      subscriptionId: 'subscription-2',
      snapshot: snapshot(runningTurn()),
      async *[Symbol.asyncIterator]() {
        yield {
          ...projectionFrame(1, terminalTurn(runningTurn())),
          subscriptionId: 'subscription-2',
        };
      },
      async close() {},
    };
    const connection = fakeConnection({
      calls,
      session,
      transcript: {
        revision: 1,
        boundary: { kind: 'managed', revision: 0, displayMode: 'ask' },
        messages: [],
      },
      frames: [],
      subscriptions: [slowConsumer, recovered],
    });
    const driver = createHostMakaSessionDriver({
      connection,
      cwd: '/tmp',
      llmConnectionSlug: 'connection-1',
      model: 'model-1',
    });
    const observations: MakaSessionObservation[] = [];
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const unsubscribe = driver.sessionObservation?.subscribe((observation) => {
      observations.push(observation);
      if (observation.events.some((event) => event.type === 'complete')) finish();
    });

    await driver.switchSession(session.id);
    await finished;
    unsubscribe?.();

    assert.equal(calls.filter((call) => call === 'subscription.open').length, 2);
    assert.ok(
      observations.some(
        (observation) => observation.reloadTranscript && observation.cut === 'active',
      ),
    );
    assert.ok(
      observations.some(
        (observation) =>
          observation.cut === 'idle' &&
          observation.events.some((event) => event.type === 'complete'),
      ),
    );
  });

  test('stops observation after the Session disappears instead of reopening forever', async () => {
    const session = sessionProjection();
    const calls: string[] = [];
    const connection = fakeConnection({
      calls,
      session,
      transcript: {
        revision: 1,
        boundary: { kind: 'managed', revision: 0, displayMode: 'ask' },
        messages: [],
      },
      frames: [],
      openSessionSubscription: async () => {
        throw new RuntimeHostOperationError(
          'subscription.open',
          'not_found',
          'Session was not found',
        );
      },
    });
    const driver = createHostMakaSessionDriver({
      connection,
      cwd: '/tmp',
      llmConnectionSlug: 'connection-1',
      model: 'model-1',
      newId: sequenceIds('session-removed-1'),
    });
    let failure: MakaSessionObservation | undefined;
    let finish!: () => void;
    const failed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const unsubscribe = driver.sessionObservation?.subscribe((observation) => {
      if (observation.events.some((event) => event.type === 'error')) {
        failure = observation;
        finish();
      }
    });

    await driver.switchSession(session.id);
    await failed;
    await new Promise((resolve) => setTimeout(resolve, 80));
    unsubscribe?.();

    assert.equal(calls.filter((call) => call === 'subscription.open').length, 1);
    assert.equal(failure?.cut, 'unavailable');
    const error = failure?.events.find((event) => event.type === 'error');
    assert.equal(error?.type === 'error' ? error.code : undefined, 'runtime_host_session_removed');
  });

  test('reports a closed Host connection and clears remote turn activity', async () => {
    const session = sessionProjection();
    const closed = deferred<void>();
    const releaseStream = deferred<void>();
    const subscription: RuntimeHostSessionSubscription = {
      hostEpoch: 'host-1',
      subscriptionId: 'subscription-1',
      snapshot: snapshot(runningTurn()),
      async *[Symbol.asyncIterator]() {
        await releaseStream.promise;
      },
      async close() {},
    };
    const connection = fakeConnection({
      calls: [],
      session,
      transcript: {
        revision: 1,
        boundary: { kind: 'managed', revision: 0, displayMode: 'ask' },
        messages: [],
      },
      frames: [],
      closed: closed.promise,
      subscriptions: [subscription],
    });
    const driver = createHostMakaSessionDriver({
      connection,
      cwd: '/tmp',
      llmConnectionSlug: 'connection-1',
      model: 'model-1',
      newId: sequenceIds('connection-error-1'),
    });
    let failure: MakaSessionObservation | undefined;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const unsubscribe = driver.sessionObservation?.subscribe((observation) => {
      if (observation.events.some((event) => event.type === 'error')) {
        failure = observation;
        finish();
      }
    });

    await driver.switchSession(session.id);
    closed.resolve();
    await finished;
    unsubscribe?.();
    releaseStream.resolve();

    assert.equal(failure?.cut, 'unavailable');
    const error = failure?.events.find((event) => event.type === 'error');
    assert.equal(
      error?.type === 'error' ? error.code : undefined,
      'runtime_host_connection_closed',
    );
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
          cut: MakaSessionObservation['cut'];
        }
      | undefined;
    let observed!: () => void;
    const observation = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const unsubscribe = driver.sessionObservation?.subscribe((value) => {
      initial ??= {
        reloadTranscript: value.reloadTranscript,
        cut: value.cut,
      };
      observed();
    });

    await driver.switchSession(session.id);
    await observation;
    unsubscribe?.();

    assert.deepEqual(initial, { reloadTranscript: true, cut: 'idle' });
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
  readonly closed?: Promise<void>;
  readonly requests?: Array<{ operation: OperationKey; input: unknown }>;
  readonly turnStarts?: TurnStartInput[];
  readonly turnStops?: TurnStopInput[];
  readonly session: SessionCatalogProjection;
  readonly transcript: RuntimeHostSessionTranscript;
  readonly snapshot?: SessionContinuitySnapshot;
  readonly frames: readonly SubscriptionFrame[];
  readonly subscriptions?: readonly RuntimeHostSessionSubscription[];
  readonly openSessionSubscription?: () => Promise<RuntimeHostSessionSubscription>;
  readonly startTurnResult?: Promise<TurnSnapshot>;
  readonly requestResult?: (operation: OperationKey) => unknown;
}

function fakeConnection(input: FakeConnectionInput): RuntimeHostConnection {
  let subscriptionIndex = 0;
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
    closed: input.closed ?? new Promise(() => {}),
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
    async startTurn(turn: TurnStartInput) {
      input.calls.push('turn.start');
      input.turnStarts?.push(turn);
      return input.startTurnResult ?? runningTurn();
    },
    async queryTurn() {
      throw new Error('not used');
    },
    async stopTurn(stop: TurnStopInput) {
      input.calls.push('turn.stop');
      input.turnStops?.push(stop);
      return {
        ...runningTurn(),
        status: 'cancelled',
        terminalEventId: 'terminal-stop',
        abortSource: 'user_stop',
      };
    },
    async readSessionTranscript() {
      return input.transcript;
    },
    async openSessionSubscription() {
      input.calls.push('subscription.open');
      if (input.openSessionSubscription) return input.openSessionSubscription();
      return input.subscriptions?.[subscriptionIndex++] ?? subscription;
    },
    async replaceClientCapabilities() {
      throw new Error('not used');
    },
    async unregisterClientCapabilities() {
      throw new Error('not used');
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
    schemaVersion: 3,
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
    goal: null,
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('Condition was not met');
}
