import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test } from 'node:test';
import type { StoredMessage } from '@maka/core/session';
import type {
  DirectRequestOperationKey,
  RuntimeHostSessionSubscription,
} from '@maka/runtime-host/client';
import { RuntimeHostSubscriptionError } from '@maka/runtime-host/client';
import type {
  InteractionPendingSnapshot,
  OperationInput,
  OperationOutput,
  SessionCatalogProjection,
  SessionContinuitySnapshot,
  SubscriptionFrame,
} from '@maka/runtime-host/protocol';
import {
  createRuntimeHostMakaSessionDriver,
  type RuntimeHostMakaSessionDriverInput,
} from '../runtime-host-session-driver.js';
import { SkillInvocationBlockedError, type MakaAttachedSessionTurn } from '../session-driver.js';
import { WAIT_BUDGET_MS } from './tui-terminal-mock.js';

describe('Runtime Host Maka Session driver', () => {
  test('keeps remote Session paths out of Client filesystem policy', async () => {
    const driver = createRuntimeHostMakaSessionDriver({
      connection: new FakeConnection([]).value,
      cwd: '/client/workspace',
      workspace: { kind: 'project', projectId: 'project-1' },
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      executionLocation: { kind: 'host' },
    });

    assert.equal(driver.moveSession, undefined);
    assert.deepEqual(
      await driver.getSessionResumeAvailability!({ cwd: '/srv/remote-only' } as never),
      { available: true },
    );
    await assert.rejects(
      driver.switchSession('session-1', { relocateCwd: '/client/workspace' }),
      /cannot be relocated by this Client/,
    );

    const driverWithoutProject = createRuntimeHostMakaSessionDriver({
      connection: new FakeConnection([]).value,
      cwd: '/client/workspace',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      executionLocation: { kind: 'host' },
    });
    await assert.rejects(
      driverWithoutProject.createSession({
        cwd: '/client/workspace',
        llmConnectionSlug: 'openai-main',
        model: 'gpt-5',
        backend: 'ai-sdk',
        permissionMode: 'ask',
      }),
      /requires an explicit Project/,
    );
  });

  test('honors explicit Project intent before inheriting the current workspace', async () => {
    const cases = [
      { cwd: '/repo', projectId: null, expected: { kind: 'host_path', path: '/repo' } },
      {
        cwd: '/repo',
        projectId: 'project-b',
        expected: { kind: 'project', projectId: 'project-b' },
      },
      {
        cwd: '/other',
        projectId: 'project-b',
        expected: { kind: 'project', projectId: 'project-b' },
      },
      { cwd: '/repo', expected: { kind: 'project', projectId: 'project-a' } },
      { cwd: '/other', expected: { kind: 'host_path', path: '/other' } },
    ] as const;

    for (const candidate of cases) {
      const connection = new FakeConnection([
        new FakeSubscription(continuitySnapshot(), Promise.resolve([])),
      ]);
      const driver = createRuntimeHostMakaSessionDriver({
        connection: connection.value,
        cwd: '/repo',
        workspace: { kind: 'project', projectId: 'project-a' },
        llmConnectionSlug: 'openai-main',
        model: 'gpt-5',
        newId: () => 'session-id',
      });

      await driver.createSession({
        cwd: candidate.cwd,
        ...('projectId' in candidate ? { projectId: candidate.projectId } : {}),
        backend: 'ai-sdk',
        llmConnectionSlug: 'openai-main',
        model: 'gpt-5',
        permissionMode: 'ask',
      });

      assert.deepEqual(
        connection.requests.find(({ operation }) => operation === 'session.create')?.input,
        {
          sessionId: 'session-id',
          workspace: candidate.expected,
          name: 'New Chat',
          modelTarget: {
            kind: 'explicit',
            connectionSlug: 'openai-main',
            model: 'gpt-5',
          },
          permissionMode: 'ask',
        },
      );
    }
  });

  test('relocates a moved Session through Host authority before attaching', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-tui-resume-moved-cwd-'));
    const target = join(root, 'new-worktree');
    await mkdir(target);
    try {
      const oldCwd = join(root, 'old-worktree');
      const connection = new FakeConnection([
        new FakeSubscription(continuitySnapshot(), Promise.resolve([])),
      ]);
      connection.sessionQueries.push(
        sessionProjection({
          workspace: { target: { kind: 'host_path', path: oldCwd }, hostCwd: oldCwd },
        }),
        sessionProjection({
          workspace: { target: { kind: 'host_path', path: oldCwd }, hostCwd: oldCwd },
        }),
      );
      const inspected: string[] = [];
      const driver = createRuntimeHostMakaSessionDriver({
        connection: connection.value,
        cwd: root,
        llmConnectionSlug: 'openai-main',
        model: 'gpt-5',
        inspectCwdChanges: async (cwd) => {
          inspected.push(cwd);
          return undefined;
        },
      });

      const switched = await driver.switchSession('session-1', {
        relocateCwd: './new-worktree',
      });
      const canonicalTarget = await realpath(target);

      assert.equal(switched.summary.cwd, canonicalTarget);
      assert.deepEqual(switched.relocation, {
        previousCwd: oldCwd,
        cwd: canonicalTarget,
        changed: true,
        oldCwdDirty: undefined,
      });
      assert.deepEqual(inspected, [oldCwd]);
      assert.deepEqual(
        connection.requests.map(({ operation }) => operation),
        [
          'session.catalog.query',
          'session.execution_boundary.query',
          'session.catalog.query',
          'session.workspace.relocate',
        ],
      );
      assert.deepEqual(connection.requests.at(-1)?.input, {
        sessionId: 'session-1',
        expectedRevision: 1,
        workspace: { kind: 'host_path', path: canonicalTarget },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('does not relocate an externally isolated Session during resume', async () => {
    const connection = new FakeConnection([]);
    connection.executionBoundary = { kind: 'external', harness: 'harbor', revision: 1 };
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: process.cwd(),
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
    });

    await assert.rejects(
      driver.switchSession('session-1', { relocateCwd: process.cwd() }),
      /Cannot resume externally isolated session/,
    );
    assert.equal(
      connection.requests.some(({ operation }) => operation === 'session.workspace.relocate'),
      false,
    );
  });

  test('atomically joins an active turn without losing output produced during transcript load', async () => {
    const transcript = deferred<StoredMessage[]>();
    const subscription = new FakeSubscription(continuitySnapshot(), transcript.promise);
    const connection = new FakeConnection([subscription]);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      now: () => 50,
    });

    const switching = driver.switchSession('session-1');
    await waitFor(() => subscription.nextCalls > 0);
    subscription.push(deltaFrame(1, 'turn-1', 5, ' world'));
    transcript.resolve([assistantMessage('turn-1', 'Hello')]);

    const switched = await switching;
    assert.deepEqual(switched.messages, [assistantMessage('turn-1', 'Hello')]);
    assert.ok(switched.activeTurn);
    const event = await nextEvent(switched.activeTurn.events);
    assert.deepEqual(event, {
      type: 'text_delta',
      id: 'host-frame:host-1:subscription-1:1',
      turnId: 'turn-1',
      messageId: 'message-turn-1',
      ts: 50,
      startOffset: 5,
      text: ' world',
    });
  });

  test('delivers completed thinking while a later step remains active', async () => {
    const subscription = new FakeSubscription(continuitySnapshot(), Promise.resolve([]));
    const connection = new FakeConnection([subscription]);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      now: () => 50,
    });

    const switched = await driver.switchSession('session-1');
    assert.ok(switched.activeTurn);
    subscription.push(thinkingFrame(1, 'step-1', 0, 'first'));
    subscription.push(thinkingFrame(2, 'step-1', 5, '', true));
    subscription.push(thinkingFrame(3, 'step-2', 0, 'second'));

    assert.deepEqual(
      [
        await nextEvent(switched.activeTurn.events),
        await nextEvent(switched.activeTurn.events),
        await nextEvent(switched.activeTurn.events),
      ].map((event) => ({
        type: event.type,
        messageId: 'messageId' in event ? event.messageId : undefined,
      })),
      [
        { type: 'thinking_delta', messageId: 'step-1' },
        { type: 'thinking_complete', messageId: 'step-1' },
        { type: 'thinking_delta', messageId: 'step-2' },
      ],
    );
  });

  test('restarts initial hydration when the first connection closes during transcript load', async () => {
    const transcript = deferred<StoredMessage[]>();
    const initial = new FakeSubscription(continuitySnapshot(), transcript.promise);
    const replacementMessages = [assistantMessage('turn-1', 'Canonical replacement')];
    const replacement = new FakeSubscription(
      continuitySnapshot({ projectionRevision: 2 }),
      Promise.resolve(replacementMessages),
      'subscription-2',
    );
    const connection = new FakeConnection([initial, replacement], true);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
    });

    const switching = driver.switchSession('session-1');
    await waitFor(() => initial.nextCalls > 0);
    const disconnected = new RuntimeHostSubscriptionError(
      'connection_closed',
      'connection closed during initial hydration',
    );
    initial.fail(disconnected);
    transcript.reject(disconnected);

    const switched = await switching;
    assert.deepEqual(switched.messages, replacementMessages);
    assert.equal(connection.openedSubscriptions, 2);
  });

  test('drains the active cut when its turn completes during transcript load', async () => {
    const transcript = deferred<StoredMessage[]>();
    const subscription = new FakeSubscription(continuitySnapshot(), transcript.promise);
    const connection = new FakeConnection([
      subscription,
      new FakeSubscription(
        continuitySnapshot({ rootTurn: completedTurn('turn-1', 'run-1') }),
        Promise.resolve([assistantMessage('turn-1', 'Hello world')]),
        'subscription-2',
      ),
    ]);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
    });

    const switching = driver.switchSession('session-1');
    await waitFor(() => subscription.nextCalls > 0);
    subscription.push(deltaFrame(1, 'turn-1', 5, ' world'));
    subscription.push({
      kind: 'subscription.session_projection',
      hostEpoch: 'host-1',
      subscriptionId: 'subscription-1',
      sequence: 2,
      snapshot: continuitySnapshot({
        projectionRevision: 2,
        rootTurn: completedTurn('turn-1', 'run-1'),
      }),
    });
    transcript.resolve([assistantMessage('turn-1', 'Hello')]);

    const switched = await switching;
    assert.ok(switched.activeTurn);
    assert.equal((await nextEvent(switched.activeTurn.events)).type, 'text_delta');
    assert.equal((await nextEvent(switched.activeTurn.events)).type, 'text_complete');
    assert.equal((await nextEvent(switched.activeTurn.events)).type, 'complete');
    assert.equal((await switched.activeTurn.events[Symbol.asyncIterator]().next()).done, true);
  });

  test('reattaches atomically when another client starts the successor turn', async () => {
    const first = new FakeSubscription(
      continuitySnapshot(),
      Promise.resolve([assistantMessage('turn-1', 'Finished')]),
    );
    const refresh = new FakeSubscription(
      continuitySnapshot({ rootTurn: completedTurn('turn-1', 'run-1') }),
      Promise.resolve([assistantMessage('turn-1', 'Finished')]),
      'subscription-refresh',
    );
    const second = new FakeSubscription(
      continuitySnapshot({
        projectionRevision: 3,
        rootTurn: runningTurn('turn-2', 'run-2'),
      }),
      Promise.resolve([userMessage('turn-2', 'Follow up'), assistantMessage('turn-2', 'New')]),
      'subscription-2',
    );
    const connection = new FakeConnection([first, refresh, second]);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      now: () => 60,
    });
    const initial = await driver.switchSession('session-1');
    assert.ok(initial.activeTurn);
    const started = deferred<MakaAttachedSessionTurn>();
    driver.subscribeStartedTurns!((turn) => started.resolve(turn));

    first.push({
      kind: 'subscription.session_projection',
      hostEpoch: 'host-1',
      subscriptionId: 'subscription-1',
      sequence: 1,
      snapshot: continuitySnapshot({
        projectionRevision: 2,
        rootTurn: completedTurn('turn-1', 'run-1'),
      }),
    });
    assert.equal((await nextEvent(initial.activeTurn.events)).type, 'complete');
    assert.equal((await initial.activeTurn.events[Symbol.asyncIterator]().next()).done, true);
    await waitFor(() => refresh.nextCalls > 0);
    first.push({
      kind: 'subscription.session_projection',
      hostEpoch: 'host-1',
      subscriptionId: 'subscription-1',
      sequence: 2,
      snapshot: continuitySnapshot({
        projectionRevision: 3,
        rootTurn: runningTurn('turn-2', 'run-2'),
      }),
    });
    const attached = await Promise.race([
      started.promise,
      delay(WAIT_BUDGET_MS).then(() => assert.fail('Timed out waiting for successor turn')),
    ]);
    assert.deepEqual(attached.messages, [
      userMessage('turn-2', 'Follow up'),
      assistantMessage('turn-2', 'New'),
    ]);
    second.push(deltaFrame(1, 'turn-2', 3, ' text', 'subscription-2', 'run-2'));
    assert.equal((await nextEvent(attached.events)).type, 'text_delta');
  });

  test('adopts a successor that finishes before its atomic reattach completes', async () => {
    const first = new FakeSubscription(continuitySnapshot(), Promise.resolve([]));
    const refresh = new FakeSubscription(
      continuitySnapshot({ rootTurn: completedTurn('turn-1', 'run-1') }),
      Promise.resolve([]),
      'subscription-refresh',
    );
    const second = new FakeSubscription(
      continuitySnapshot({
        projectionRevision: 3,
        rootTurn: completedTurn('turn-2', 'run-2'),
      }),
      Promise.resolve([
        userMessage('turn-2', 'Fast follow up'),
        assistantMessage('turn-2', 'Done'),
      ]),
      'subscription-2',
    );
    const connection = new FakeConnection([first, refresh, second]);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
    });
    const switched = await driver.switchSession('session-1');
    assert.ok(switched.activeTurn);
    const started = deferred<MakaAttachedSessionTurn>();
    driver.subscribeStartedTurns!((turn) => started.resolve(turn));

    first.push({
      kind: 'subscription.session_projection',
      hostEpoch: 'host-1',
      subscriptionId: 'subscription-1',
      sequence: 1,
      snapshot: continuitySnapshot({
        projectionRevision: 2,
        rootTurn: completedTurn('turn-1', 'run-1'),
      }),
    });
    assert.equal((await nextEvent(switched.activeTurn.events)).type, 'complete');
    assert.equal((await switched.activeTurn.events[Symbol.asyncIterator]().next()).done, true);
    await waitFor(() => refresh.nextCalls > 0);
    first.push({
      kind: 'subscription.session_projection',
      hostEpoch: 'host-1',
      subscriptionId: 'subscription-1',
      sequence: 2,
      snapshot: continuitySnapshot({
        projectionRevision: 3,
        rootTurn: runningTurn('turn-2', 'run-2'),
      }),
    });

    const attached = await started.promise;
    assert.deepEqual(attached.messages, [
      userMessage('turn-2', 'Fast follow up'),
      assistantMessage('turn-2', 'Done'),
    ]);
    const text = await nextEvent(attached.events);
    assert.equal(text.type, 'text_complete');
    if (text.type !== 'text_complete') assert.fail('Expected the durable assistant answer');
    assert.equal(text.text, 'Done');
    assert.equal((await nextEvent(attached.events)).type, 'complete');
  });

  test('serializes buffered successor reattach so transcript completion cannot reverse turn order', async () => {
    const first = new FakeSubscription(continuitySnapshot(), Promise.resolve([]));
    const refreshFirst = new FakeSubscription(
      continuitySnapshot({ rootTurn: completedTurn('turn-1', 'run-1') }),
      Promise.resolve([]),
      'subscription-refresh-1',
    );
    const refreshSecond = new FakeSubscription(
      continuitySnapshot({ rootTurn: completedTurn('turn-2', 'run-2') }),
      Promise.resolve([]),
      'subscription-refresh-2',
    );
    const secondTranscript = deferred<StoredMessage[]>();
    const thirdTranscript = deferred<StoredMessage[]>();
    const second = new FakeSubscription(
      continuitySnapshot({ projectionRevision: 4, rootTurn: runningTurn('turn-2', 'run-2') }),
      secondTranscript.promise,
      'subscription-2',
    );
    const third = new FakeSubscription(
      continuitySnapshot({ projectionRevision: 5, rootTurn: runningTurn('turn-3', 'run-3') }),
      thirdTranscript.promise,
      'subscription-3',
    );
    const connection = new FakeConnection([first, refreshFirst, refreshSecond, second, third]);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
    });
    const switched = await driver.switchSession('session-1');
    assert.ok(switched.activeTurn);
    const started: MakaAttachedSessionTurn[] = [];
    driver.subscribeStartedTurns!((turn) => started.push(turn));

    first.push(projectionFrame(1, completedTurn('turn-1', 'run-1'), 2));
    first.push(projectionFrame(2, runningTurn('turn-2', 'run-2'), 3));
    first.push(projectionFrame(3, completedTurn('turn-2', 'run-2'), 4));
    first.push(projectionFrame(4, runningTurn('turn-3', 'run-3'), 5));
    assert.equal((await nextEvent(switched.activeTurn.events)).type, 'complete');
    assert.equal((await switched.activeTurn.events[Symbol.asyncIterator]().next()).done, true);

    await waitFor(() => connection.openedSubscriptions === 4);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(connection.openedSubscriptions, 4, 'the later successor must wait for reattach');
    secondTranscript.resolve([userMessage('turn-2', 'Second')]);
    await waitFor(() => started.length === 1 && connection.openedSubscriptions === 5);
    assert.equal(started[0]?.turnId, 'turn-2');

    thirdTranscript.resolve([userMessage('turn-3', 'Third')]);
    await waitFor(() => started.length === 2);
    assert.deepEqual(
      started.map((turn) => turn.turnId),
      ['turn-2', 'turn-3'],
    );
  });

  test('a retired intermediate channel cannot republish its buffered successor', async () => {
    const first = new FakeSubscription(continuitySnapshot(), Promise.resolve([]));
    const refreshFirst = new FakeSubscription(
      continuitySnapshot({ rootTurn: completedTurn('turn-1', 'run-1') }),
      Promise.resolve([]),
      'subscription-refresh-1',
    );
    const refreshSecondFromFirst = new FakeSubscription(
      continuitySnapshot({ rootTurn: completedTurn('turn-2', 'run-2') }),
      Promise.resolve([]),
      'subscription-refresh-2-first',
    );
    const secondTranscript = deferred<StoredMessage[]>();
    const second = new FakeSubscription(
      continuitySnapshot({ projectionRevision: 3, rootTurn: runningTurn('turn-2', 'run-2') }),
      secondTranscript.promise,
      'subscription-2',
    );
    const refreshSecondFromSecond = new FakeSubscription(
      continuitySnapshot({ rootTurn: completedTurn('turn-2', 'run-2') }),
      Promise.resolve([]),
      'subscription-refresh-2-second',
    );
    const third = new FakeSubscription(
      continuitySnapshot({ projectionRevision: 5, rootTurn: runningTurn('turn-3', 'run-3') }),
      Promise.resolve([userMessage('turn-3', 'Third')]),
      'subscription-3',
    );
    const duplicateThird = new FakeSubscription(
      continuitySnapshot({ projectionRevision: 5, rootTurn: runningTurn('turn-3', 'run-3') }),
      Promise.resolve([userMessage('turn-3', 'Duplicate third')]),
      'subscription-3-duplicate',
    );
    const connection = new FakeConnection([
      first,
      refreshFirst,
      refreshSecondFromFirst,
      second,
      refreshSecondFromSecond,
      third,
      duplicateThird,
    ]);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
    });
    const switched = await driver.switchSession('session-1');
    assert.ok(switched.activeTurn);
    const started: MakaAttachedSessionTurn[] = [];
    driver.subscribeStartedTurns!((turn) => started.push(turn));

    first.push(projectionFrame(1, completedTurn('turn-1', 'run-1'), 2));
    first.push(projectionFrame(2, runningTurn('turn-2', 'run-2'), 3));
    first.push(projectionFrame(3, completedTurn('turn-2', 'run-2'), 4));
    first.push(projectionFrame(4, runningTurn('turn-3', 'run-3'), 5));
    assert.equal((await nextEvent(switched.activeTurn.events)).type, 'complete');
    assert.equal((await switched.activeTurn.events[Symbol.asyncIterator]().next()).done, true);
    await waitFor(() => connection.openedSubscriptions === 4 && second.nextCalls > 0);

    second.push(projectionFrame(1, completedTurn('turn-2', 'run-2'), 4, 'subscription-2'));
    second.push(projectionFrame(2, runningTurn('turn-3', 'run-3'), 5, 'subscription-2'));
    secondTranscript.resolve([userMessage('turn-2', 'Second')]);
    await waitFor(
      () =>
        connection.openedSubscriptions === 6 &&
        started.some((turn) => turn.turnId === 'turn-2') &&
        started.some((turn) => turn.turnId === 'turn-3'),
    );

    const secondTurn = started.find((turn) => turn.turnId === 'turn-2');
    assert.ok(secondTurn);
    for await (const _event of secondTurn.events) {
      // Draining the retired channel must not publish its buffered successor.
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(connection.openedSubscriptions, 6);
    assert.deepEqual(
      started.map((turn) => turn.turnId),
      ['turn-2', 'turn-3'],
    );
  });

  test('an explicit Session switch fences an older successor reattach already loading', async () => {
    const first = new FakeSubscription(continuitySnapshot(), Promise.resolve([]));
    const refresh = new FakeSubscription(
      continuitySnapshot({ rootTurn: completedTurn('turn-1', 'run-1') }),
      Promise.resolve([]),
      'subscription-refresh',
    );
    const staleTranscript = deferred<StoredMessage[]>();
    const stale = new FakeSubscription(
      continuitySnapshot({ projectionRevision: 3, rootTurn: runningTurn('turn-2', 'run-2') }),
      staleTranscript.promise,
      'subscription-stale',
    );
    const switchedSubscription = new FakeSubscription(
      continuitySnapshot({ projectionRevision: 4, rootTurn: runningTurn('turn-3', 'run-3') }),
      Promise.resolve([userMessage('turn-3', 'Current')]),
      'subscription-current',
    );
    const connection = new FakeConnection([first, refresh, stale, switchedSubscription]);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
    });
    const initial = await driver.switchSession('session-1');
    assert.ok(initial.activeTurn);
    const started: string[] = [];
    driver.subscribeStartedTurns!((turn) => started.push(turn.turnId));

    first.push(projectionFrame(1, completedTurn('turn-1', 'run-1'), 2));
    first.push(projectionFrame(2, runningTurn('turn-2', 'run-2'), 3));
    assert.equal((await nextEvent(initial.activeTurn.events)).type, 'complete');
    assert.equal((await initial.activeTurn.events[Symbol.asyncIterator]().next()).done, true);
    await waitFor(() => connection.openedSubscriptions === 3);

    const switched = await driver.switchSession('session-1');
    assert.equal(switched.activeTurn?.turnId, 'turn-3');
    staleTranscript.resolve([userMessage('turn-2', 'Stale')]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, []);
  });

  test('a stale reattach cannot overwrite configuration adopted by an explicit switch', async () => {
    const first = new FakeSubscription(continuitySnapshot(), Promise.resolve([]));
    const refresh = new FakeSubscription(
      continuitySnapshot({ rootTurn: completedTurn('turn-1', 'run-1') }),
      Promise.resolve([]),
      'subscription-refresh',
    );
    const stale = new FakeSubscription(
      continuitySnapshot({ projectionRevision: 3, rootTurn: runningTurn('turn-2', 'run-2') }),
      Promise.resolve([userMessage('turn-2', 'Stale')]),
      'subscription-stale',
    );
    const current = new FakeSubscription(
      continuitySnapshot({ projectionRevision: 4, rootTurn: runningTurn('turn-3', 'run-3') }),
      Promise.resolve([userMessage('turn-3', 'Current')]),
      'subscription-current',
    );
    const staleConfiguration = deferred<SessionCatalogProjection>();
    const connection = new FakeConnection([first, refresh, stale, current]);
    connection.sessionQueries.push(
      sessionProjection(),
      staleConfiguration.promise,
      sessionProjection({ orchestrationMode: 'graph' }),
    );
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
    });
    const initial = await driver.switchSession('session-1');
    assert.ok(initial.activeTurn);

    first.push(projectionFrame(1, completedTurn('turn-1', 'run-1'), 2));
    first.push(projectionFrame(2, runningTurn('turn-2', 'run-2'), 3));
    assert.equal((await nextEvent(initial.activeTurn.events)).type, 'complete');
    assert.equal((await initial.activeTurn.events[Symbol.asyncIterator]().next()).done, true);
    await waitFor(
      () =>
        connection.requests.filter((request) => request.operation === 'session.catalog.query')
          .length === 2,
    );

    const switched = await driver.switchSession('session-1');
    assert.ok(switched.activeTurn);
    assert.equal(driver.getOrchestrationMode!(), 'graph');
    staleConfiguration.resolve(sessionProjection({ orchestrationMode: 'default' }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(driver.getOrchestrationMode!(), 'graph');
  });

  test('a stale generation cannot block successor reattach after an explicit switch', async () => {
    const first = new FakeSubscription(continuitySnapshot(), Promise.resolve([]));
    const oldRefresh = new FakeSubscription(
      continuitySnapshot({ rootTurn: completedTurn('turn-1', 'run-1') }),
      Promise.resolve([]),
      'subscription-old-refresh',
    );
    const staleTranscript = deferred<StoredMessage[]>();
    const stale = new FakeSubscription(
      continuitySnapshot({ projectionRevision: 3, rootTurn: runningTurn('turn-2', 'run-2') }),
      staleTranscript.promise,
      'subscription-stale',
    );
    const current = new FakeSubscription(
      continuitySnapshot({ projectionRevision: 4, rootTurn: runningTurn('turn-3', 'run-3') }),
      Promise.resolve([userMessage('turn-3', 'Current')]),
      'subscription-current',
    );
    const currentRefresh = new FakeSubscription(
      continuitySnapshot({ projectionRevision: 5, rootTurn: completedTurn('turn-3', 'run-3') }),
      Promise.resolve([assistantMessage('turn-3', 'Done')]),
      'subscription-current-refresh',
    );
    const successor = new FakeSubscription(
      continuitySnapshot({ projectionRevision: 6, rootTurn: runningTurn('turn-4', 'run-4') }),
      Promise.resolve([userMessage('turn-4', 'Next')]),
      'subscription-successor',
    );
    const connection = new FakeConnection([
      first,
      oldRefresh,
      stale,
      current,
      currentRefresh,
      successor,
    ]);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
    });
    const initial = await driver.switchSession('session-1');
    assert.ok(initial.activeTurn);
    const started: string[] = [];
    driver.subscribeStartedTurns!((turn) => started.push(turn.turnId));

    first.push(projectionFrame(1, completedTurn('turn-1', 'run-1'), 2));
    first.push(projectionFrame(2, runningTurn('turn-2', 'run-2'), 3));
    assert.equal((await nextEvent(initial.activeTurn.events)).type, 'complete');
    assert.equal((await initial.activeTurn.events[Symbol.asyncIterator]().next()).done, true);
    await waitFor(() => connection.openedSubscriptions === 3);

    const switched = await driver.switchSession('session-1');
    assert.ok(switched.activeTurn);
    current.push(projectionFrame(1, completedTurn('turn-3', 'run-3'), 5, 'subscription-current'));
    current.push(projectionFrame(2, runningTurn('turn-4', 'run-4'), 6, 'subscription-current'));
    assert.equal((await nextEvent(switched.activeTurn.events)).type, 'complete');
    assert.equal((await switched.activeTurn.events[Symbol.asyncIterator]().next()).done, true);
    await waitFor(() => connection.openedSubscriptions === 6 && started.includes('turn-4'));
    assert.deepEqual(started, ['turn-4']);
  });

  test('routes queue and retract mutations through Host authority', async () => {
    const subscription = new FakeSubscription(continuitySnapshot(), Promise.resolve([]));
    const connection = new FakeConnection([subscription]);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      newId: sequenceIds('message-1', 'retract-1'),
    });
    await driver.switchSession('session-1');

    assert.deepEqual(await driver.queueMessage!('Later'), { kind: 'queued' });
    assert.equal(await driver.retractQueued!(), 'Later');
    assert.deepEqual(
      connection.requests.filter(
        (request) =>
          request.operation === 'turn.message.submit' || request.operation === 'queue.retract',
      ),
      [
        {
          operation: 'turn.message.submit',
          input: {
            originHostEpoch: 'host-1',
            sessionId: 'session-1',
            messageId: 'message-1',
            content: { text: 'Later' },
            placement: 'next_turn',
          },
        },
        {
          operation: 'queue.retract',
          input: {
            originHostEpoch: 'host-1',
            sessionId: 'session-1',
            retractId: 'retract-1',
          },
        },
      ],
    );
  });

  test('projects the acknowledgement that releases a question answered through the Host', async () => {
    const subscription = new FakeSubscription(
      continuitySnapshot({ interactions: { pending: [pendingQuestion()] } }),
      Promise.resolve([]),
    );
    const connection = new FakeConnection([subscription]);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      now: () => 75,
    });
    const switched = await driver.switchSession('session-1');
    assert.ok(switched.activeTurn);
    assert.equal((await nextEvent(switched.activeTurn.events)).type, 'user_question_request');

    await driver.respondToUserQuestion!({ requestId: 'question-1', answers: ['Yes'] });

    assert.deepEqual(await nextEvent(switched.activeTurn.events), {
      type: 'user_question_answer_ack',
      id: 'host-interaction:question-1:2',
      turnId: 'turn-1',
      ts: 75,
      requestId: 'question-1',
      toolUseId: 'tool-question',
    });
  });

  test('publishes a pending permission that has no transcript event', async () => {
    const permission = pendingPermission();
    const subscription = new FakeSubscription(
      continuitySnapshot({ interactions: { pending: [permission] } }),
      Promise.resolve([]),
    );
    const connection = new FakeConnection([subscription]);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
    });
    const published = deferred<InteractionPendingSnapshot>();
    driver.subscribePendingInteractions((pending) => published.resolve(pending));

    await driver.switchSession('session-1');

    assert.deepEqual(await published.promise, permission);
  });

  test('reads a fresh Host transcript when listing rewind targets', async () => {
    const attached = new FakeSubscription(continuitySnapshot(), Promise.resolve([]));
    const current = new FakeSubscription(
      continuitySnapshot(),
      Promise.resolve([userMessage('turn-new', 'Newest prompt')]),
      'subscription-2',
    );
    const connection = new FakeConnection([attached, current]);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
    });
    await driver.switchSession('session-1');

    assert.deepEqual(await driver.listRewindTargets(), [
      { turnId: 'turn-new', label: 'Newest prompt' },
    ]);
  });

  test('reopens a failed Session channel before starting the next turn', async () => {
    const first = new FakeSubscription(continuitySnapshot({ rootTurn: null }), Promise.resolve([]));
    const second = new FakeSubscription(
      continuitySnapshot({ rootTurn: null }),
      Promise.resolve([]),
      'subscription-2',
    );
    const connection = new FakeConnection([first, second]);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      newId: sequenceIds('turn-2'),
    });
    await driver.switchSession('session-1');

    first.push({
      kind: 'subscription.closed',
      hostEpoch: 'host-1',
      subscriptionId: 'subscription-1',
      sequence: 1,
      reason: 'slow_consumer',
    });
    await new Promise((resolve) => setImmediate(resolve));

    const turn = await driver.preparePrompt('Continue');
    second.push(deltaFrame(1, 'turn-2', 0, 'Recovered', 'subscription-2', 'run-2'));
    assert.equal((await nextEvent(turn.events)).text, 'Recovered');
  });

  test('starts explicit Skills through the Host command and preserves its typed feedback', async () => {
    const subscription = new FakeSubscription(
      continuitySnapshot({ rootTurn: null }),
      Promise.resolve([]),
    );
    const connection = new FakeConnection([subscription]);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      newId: sequenceIds('turn-skill'),
    });
    await driver.switchSession('session-1');

    const turn = await driver.preparePrompt('/skill:alpha Help');
    assert.deepEqual(turn.skillInvocation?.loaded, [{ id: 'alpha', name: 'Alpha' }]);
    assert.equal(connection.requests.at(-1)?.operation, 'turn.start');

    connection.skillStartBlocked = true;
    await assert.rejects(
      driver.preparePrompt('/skill:missing', { turnId: 'turn-blocked' }),
      SkillInvocationBlockedError,
    );
  });

  test('retires a pending question when another client answers it', async () => {
    const subscription = new FakeSubscription(
      continuitySnapshot({ interactions: { pending: [pendingQuestion()] } }),
      Promise.resolve([]),
    );
    const connection = new FakeConnection([subscription]);
    connection.interactionQuery = {
      ...pendingQuestion(),
      revision: 2,
      status: 'answered',
      outcome: { kind: 'question_answer', answers: ['Yes'], committedAt: 80 },
    };
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
    });
    await driver.switchSession('session-1');
    const resolved = deferred<string>();
    driver.subscribeResolvedInteractions!((_sessionId, requestId) => resolved.resolve(requestId));

    subscription.push({
      kind: 'subscription.session_projection',
      hostEpoch: 'host-1',
      subscriptionId: 'subscription-1',
      sequence: 1,
      snapshot: continuitySnapshot({ projectionRevision: 2, interactions: { pending: [] } }),
    });

    assert.equal(await resolved.promise, 'question-1');
  });

  test('reconciles the durable transcript after a turn reaches its terminal boundary', async () => {
    const attached = new FakeSubscription(continuitySnapshot(), Promise.resolve([]));
    const durableMessages = [userMessage('turn-1', 'Run it'), assistantMessage('turn-1', 'Done')];
    const refresh = new FakeSubscription(
      continuitySnapshot({ rootTurn: completedTurn('turn-1', 'run-1') }),
      Promise.resolve(durableMessages),
      'subscription-2',
    );
    const connection = new FakeConnection([attached, refresh]);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
    });
    await driver.switchSession('session-1');
    const replacement = deferred<StoredMessage[]>();
    driver.subscribeTranscriptReplacements!((_sessionId, _turnId, messages) =>
      replacement.resolve(messages),
    );

    attached.push({
      kind: 'subscription.session_projection',
      hostEpoch: 'host-1',
      subscriptionId: 'subscription-1',
      sequence: 1,
      snapshot: continuitySnapshot({
        projectionRevision: 2,
        rootTurn: completedTurn('turn-1', 'run-1'),
      }),
    });

    assert.deepEqual(await replacement.promise, durableMessages);
  });

  test('resnapshots an active Session after reconnect and continues its live stream', async () => {
    const initial = new FakeSubscription(
      continuitySnapshot(),
      Promise.resolve([assistantMessage('turn-1', 'Hello')]),
    );
    const replacement = new FakeSubscription(
      continuitySnapshot({ projectionRevision: 2 }),
      Promise.resolve([assistantMessage('turn-1', 'Hello world')]),
      'subscription-2',
    );
    const connection = new FakeConnection([initial, replacement], true);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      now: () => 50,
    });
    const switched = await driver.switchSession('session-1');
    assert.ok(switched.activeTurn);
    const transcript = deferred<StoredMessage[]>();
    driver.subscribeTranscriptReplacements!((_sessionId, _turnId, messages, reason) => {
      assert.equal(reason, 'reconnect');
      transcript.resolve(messages);
    });

    initial.fail(
      new RuntimeHostSubscriptionError('connection_closed', 'connection lost during active Turn'),
    );
    assert.deepEqual(await transcript.promise, [assistantMessage('turn-1', 'Hello world')]);
    assert.equal(connection.openedSubscriptions, 2);
    replacement.push(deltaFrame(1, 'turn-1', 11, '!', 'subscription-2'));
    assert.equal((await nextEvent(switched.activeTurn.events)).text, '!');
  });

  test('recovers the complete terminal answer when a Turn finishes during reconnect', async () => {
    const initial = new FakeSubscription(
      continuitySnapshot(),
      Promise.resolve([assistantMessage('turn-1', 'Hello')]),
    );
    const replacement = new FakeSubscription(
      continuitySnapshot({
        projectionRevision: 2,
        rootTurn: completedTurn('turn-1', 'run-1'),
      }),
      Promise.resolve([
        assistantMessage('turn-1', 'Hello world'),
        turnStateMessage('turn-1', 'completed'),
      ]),
      'subscription-2',
    );
    const connection = new FakeConnection([initial, replacement], true);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      now: () => 50,
    });
    const switched = await driver.switchSession('session-1');
    assert.ok(switched.activeTurn);

    initial.fail(new RuntimeHostSubscriptionError('connection_closed', 'connection lost'));
    const text = await nextEvent(switched.activeTurn.events);
    assert.equal(text.type, 'text_complete');
    assert.equal(text.text, 'Hello world');
    assert.equal((await nextEvent(switched.activeTurn.events)).type, 'complete');
    assert.equal((await switched.activeTurn.events[Symbol.asyncIterator]().next()).done, true);
  });

  test('settles an attached Turn before publishing its reconnect-gap successor', async () => {
    const initial = new FakeSubscription(
      continuitySnapshot(),
      Promise.resolve([assistantMessage('turn-1', 'Working')]),
    );
    const replacementMessages = [
      assistantMessage('turn-1', 'Finished'),
      turnStateMessage('turn-1', 'completed'),
      userMessage('turn-2', 'Continue'),
      assistantMessage('turn-2', 'Continuing'),
    ];
    const replacement = new FakeSubscription(
      continuitySnapshot({
        projectionRevision: 3,
        rootTurn: runningTurn('turn-2', 'run-2'),
      }),
      Promise.resolve(replacementMessages),
      'subscription-2',
    );
    const successor = new FakeSubscription(
      continuitySnapshot({
        projectionRevision: 3,
        rootTurn: runningTurn('turn-2', 'run-2'),
      }),
      Promise.resolve(replacementMessages),
      'subscription-3',
    );
    const connection = new FakeConnection([initial, replacement, successor], true);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      now: () => 50,
    });
    const switched = await driver.switchSession('session-1');
    assert.ok(switched.activeTurn);
    const started = deferred<MakaAttachedSessionTurn>();
    driver.subscribeStartedTurns!((turn) => started.resolve(turn));

    initial.fail(new RuntimeHostSubscriptionError('connection_closed', 'connection lost'));
    assert.equal((await nextEvent(switched.activeTurn.events)).type, 'text_complete');
    assert.equal((await nextEvent(switched.activeTurn.events)).type, 'complete');
    assert.equal((await switched.activeTurn.events[Symbol.asyncIterator]().next()).done, true);
    assert.equal((await started.promise).turnId, 'turn-2');
  });
});

class FakeConnection {
  readonly requests: Array<{ operation: string; input: unknown }> = [];
  readonly sessionQueries: Array<SessionCatalogProjection | Promise<SessionCatalogProjection>> = [];
  openedSubscriptions = 0;
  interactionQuery: unknown;
  executionBoundary: unknown = { kind: 'managed', access: 'read_write', revision: 1 };
  skillStartBlocked = false;
  readonly value: RuntimeHostMakaSessionDriverInput['connection'];

  constructor(
    private readonly subscriptions: FakeSubscription[],
    reconnecting = false,
  ) {
    this.value = {
      ...(reconnecting ? { reconnecting: true as const } : {}),
      hostEpoch: 'host-1',
      request: <K extends DirectRequestOperationKey>(operation: K, input: OperationInput<K>) =>
        this.request(operation, input),
      startTurn: (input) => this.request('turn.start', input),
      openSessionSubscription: async () => {
        const subscription = this.subscriptions[this.openedSubscriptions];
        this.openedSubscriptions += 1;
        if (!subscription) throw new Error('No fake subscription available');
        return subscription;
      },
    } satisfies RuntimeHostMakaSessionDriverInput['connection'];
  }

  async request<K extends DirectRequestOperationKey>(
    operation: K,
    input: OperationInput<K>,
  ): Promise<OperationOutput<K>> {
    this.requests.push({ operation, input });
    if (operation === 'session.workspace.relocate') {
      const workspace = (input as OperationInput<'session.workspace.relocate'>).workspace;
      if (workspace.kind !== 'host_path') throw new Error('Expected Host-path workspace');
      return {
        kind: 'committed',
        session: sessionProjection({
          revision: 2,
          workspace: { target: workspace, hostCwd: workspace.path },
        }),
      } as OperationOutput<K>;
    }
    if (operation === 'session.create') {
      const create = input as OperationInput<'session.create'>;
      return sessionProjection({
        id: create.sessionId,
        workspace: {
          target: create.workspace,
          hostCwd: create.workspace.kind === 'host_path' ? create.workspace.path : '/project',
        },
      }) as OperationOutput<K>;
    }
    const turnInput = input as {
      sessionId?: string;
      turnId?: string;
      content: { text: string };
    };
    const result: unknown =
      operation === 'session.catalog.query'
        ? {
            kind: 'session',
            session: await (this.sessionQueries.shift() ?? sessionProjection()),
          }
        : operation === 'session.execution_boundary.query'
          ? this.executionBoundary
          : operation === 'turn.message.submit'
            ? { disposition: 'queued', queueRevision: 2 }
            : operation === 'queue.retract'
              ? {
                  hostEpoch: 'host-1',
                  queueRevision: 3,
                  retracted: [
                    {
                      entryId: 'entry-1',
                      messageId: 'message-1',
                      content: { text: 'Later' },
                      placement: 'next_turn',
                    },
                  ],
                }
              : operation === 'interaction.answer'
                ? {
                    ...pendingQuestion(),
                    revision: 2,
                    status: 'answered',
                    outcome: { kind: 'question_answer', answers: ['Yes'], committedAt: 75 },
                  }
                : operation === 'interaction.query'
                  ? this.interactionQuery
                  : operation === 'turn.start'
                    ? this.skillStartBlocked
                      ? {
                          kind: 'blocked',
                          skillInvocation: {
                            loaded: [],
                            failed: [{ request: 'missing', reason: 'not_found' }],
                            receipts: [],
                          },
                        }
                      : {
                          kind: 'started',
                          turn: {
                            sessionId: turnInput.sessionId,
                            turnId: turnInput.turnId,
                            runId: 'run-1',
                            status: 'running',
                          },
                          skillInvocation: turnInput.content.text.includes('/skill:')
                            ? {
                                loaded: [{ id: 'alpha', name: 'Alpha' }],
                                failed: [],
                                receipts: [],
                              }
                            : { loaded: [], failed: [], receipts: [] },
                        }
                    : undefined;
    if (result === undefined) throw new Error(`Unexpected fake operation: ${operation}`);
    return result as OperationOutput<K>;
  }
}

class FakeSubscription implements RuntimeHostSessionSubscription, AsyncIterator<SubscriptionFrame> {
  readonly hostEpoch = 'host-1';
  readonly activeAssistantStreams = [];
  readonly transcriptBootstrap = null;
  readonly subscriptionId: string;
  readonly #frames: SubscriptionFrame[] = [];
  readonly #waiters: Array<{
    resolve(result: IteratorResult<SubscriptionFrame>): void;
    reject(error: Error): void;
  }> = [];
  nextCalls = 0;
  #closed = false;
  #failure: Error | undefined;

  constructor(
    readonly snapshot: SessionContinuitySnapshot,
    private readonly transcript: Promise<StoredMessage[]>,
    subscriptionId = 'subscription-1',
  ) {
    this.subscriptionId = subscriptionId;
  }

  [Symbol.asyncIterator](): AsyncIterator<SubscriptionFrame> {
    return this;
  }

  next(): Promise<IteratorResult<SubscriptionFrame>> {
    this.nextCalls += 1;
    const frame = this.#frames.shift();
    if (frame) return Promise.resolve({ done: false, value: frame });
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  push(frame: SubscriptionFrame): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: frame });
    else this.#frames.push(frame);
  }

  fail(error: Error): void {
    this.#failure = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  async loadTranscript<T>(decodeMessage: (value: unknown) => T): Promise<T[]> {
    return (await this.transcript).map(decodeMessage);
  }

  async loadTranscriptPage(): Promise<never> {
    throw new Error('Fake subscription does not expose transcript pages');
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }
}

function continuitySnapshot(
  overrides: Partial<SessionContinuitySnapshot> = {},
): SessionContinuitySnapshot {
  return {
    schemaVersion: 3,
    session: {
      sessionId: 'session-1',
      metadataRevision: 1,
      status: 'running',
      createdAt: 1,
      lastUsedAt: 1,
      isArchived: false,
    },
    projectionRevision: 1,
    rootTurn: runningTurn('turn-1', 'run-1'),
    goal: null,
    queue: { hostEpoch: 'host-1', queueRevision: 0, steering: [], followup: [] },
    interactions: { pending: [] },
    ...overrides,
  };
}

function runningTurn(turnId: string, runId: string) {
  return { sessionId: 'session-1', turnId, runId, status: 'running' as const };
}

function completedTurn(turnId: string, runId: string) {
  return {
    sessionId: 'session-1',
    turnId,
    runId,
    status: 'completed' as const,
    completedAt: 80,
    terminalEventId: `terminal-${turnId}`,
  };
}

function sessionProjection(
  overrides: Partial<SessionCatalogProjection> = {},
): SessionCatalogProjection {
  return {
    id: 'session-1',
    revision: 1,
    workspace: {
      target: { kind: 'host_path', path: '/tmp' },
      hostCwd: '/tmp',
    },
    createdAt: 1,
    lastUsedAt: 2,
    name: 'Session',
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'openai-main',
    connectionLocked: true,
    model: 'gpt-5',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    ...overrides,
  };
}

function assistantMessage(turnId: string, text: string): StoredMessage {
  return {
    type: 'assistant',
    id: `message-${turnId}`,
    turnId,
    ts: 10,
    text,
    modelId: 'gpt-5',
  };
}

function userMessage(turnId: string, text: string): StoredMessage {
  return { type: 'user', id: `user-${turnId}`, turnId, ts: 9, text };
}

function turnStateMessage(
  turnId: string,
  status: 'completed' | 'failed' | 'aborted',
): StoredMessage {
  return {
    type: 'turn_state',
    id: `state-${turnId}`,
    turnId,
    ts: 80,
    status,
    partialOutputRetained: true,
  };
}

function deltaFrame(
  sequence: number,
  turnId: string,
  startOffset: number,
  text: string,
  subscriptionId = 'subscription-1',
  runId = 'run-1',
): SubscriptionFrame {
  return {
    kind: 'subscription.session_delta',
    hostEpoch: 'host-1',
    subscriptionId,
    sequence,
    sessionId: 'session-1',
    delta: {
      kind: 'text',
      turnId,
      runId,
      messageId: `message-${turnId}`,
      startOffset,
      text,
    },
  };
}

function thinkingFrame(
  sequence: number,
  messageId: string,
  startOffset: number,
  text: string,
  complete = false,
): SubscriptionFrame {
  return {
    kind: 'subscription.session_delta',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sequence,
    sessionId: 'session-1',
    delta: {
      kind: 'thinking',
      turnId: 'turn-1',
      runId: 'run-1',
      messageId,
      startOffset,
      text,
      ...(complete ? { complete: true } : {}),
    },
  };
}

function projectionFrame(
  sequence: number,
  rootTurn: NonNullable<SessionContinuitySnapshot['rootTurn']>,
  projectionRevision: number,
  subscriptionId = 'subscription-1',
): SubscriptionFrame {
  return {
    kind: 'subscription.session_projection',
    hostEpoch: 'host-1',
    subscriptionId,
    sequence,
    snapshot: continuitySnapshot({ projectionRevision, rootTurn }),
  };
}

function pendingQuestion() {
  return {
    schemaVersion: 1 as const,
    interactionId: 'question-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    runId: 'run-1',
    revision: 1 as const,
    status: 'pending' as const,
    outcome: null,
    request: {
      kind: 'question' as const,
      toolUseId: 'tool-question',
      questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
    },
  };
}

function pendingPermission() {
  return {
    schemaVersion: 1 as const,
    interactionId: 'permission-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    runId: 'run-1',
    revision: 1 as const,
    status: 'pending' as const,
    outcome: null,
    request: {
      kind: 'permission' as const,
      toolUseId: 'tool-permission',
      prompt: {
        kind: 'tool_permission' as const,
        toolName: 'Bash',
        category: 'shell_unsafe' as const,
        reason: 'shell_dangerous' as const,
        review: { kind: 'command' as const, command: 'echo protected', cwd: '/tmp' },
        rememberForTurnAllowed: true,
      },
    },
  };
}

async function nextEvent(events: AsyncIterable<unknown>): Promise<any> {
  const iterator = events[Symbol.asyncIterator]();
  const result = await Promise.race([
    iterator.next(),
    delay(WAIT_BUDGET_MS).then(() => assert.fail('Timed out waiting for Session event')),
  ]);
  assert.equal(result.done, false);
  return result.value;
}

function sequenceIds(...ids: string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? `id-${index}`;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_BUDGET_MS;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('Timed out waiting for fake Host state');
}
