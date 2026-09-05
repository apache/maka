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

import { deferred } from '@maka/core/test-only/async-primitives';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test } from 'node:test';
import type { StoredMessage } from '@maka/core/session';
import type { ShellRunUpdate } from '@maka/core/events';
import type {
  DirectRequestOperationKey,
  RuntimeHostSessionSubscription,
} from '@maka/runtime-host/client';
import {
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
  RuntimeHostSubscriptionError,
} from '@maka/runtime-host/client';
import {
  SESSION_CONTINUITY_SCHEMA_VERSION,
  type GoalProjection,
  type InteractionPendingSnapshot,
  type OperationInput,
  type OperationOutput,
  type SessionCatalogProjection,
  type SessionContinuitySnapshot,
  type SessionUpdateResult,
  type SubscriptionFrame,
} from '@maka/runtime-host/protocol';
import { projectSessionCatalogSummary } from '@maka/runtime-host/client';
import {
  createRuntimeHostMakaSessionDriver,
  type RuntimeHostMakaSessionDriverInput,
} from '../runtime-host-session-driver.js';
import type {
  MakaAttachedSessionTurn,
  MakaSideConversationParentStatus,
} from '../session-driver.js';
import { WAIT_BUDGET_MS } from './tui-terminal-mock.js';
import { waitFor as pollFor } from '@maka/core/test-only/async-primitives';

describe('Runtime Host Maka Session driver', () => {
  test('maps authoritative Catalog activity into Session summaries', () => {
    assert.equal(
      projectSessionCatalogSummary(sessionProjection({ activityAt: 42 })).activityAt,
      42,
    );
  });

  test('maps authoritative live Turn ids into Session summaries', () => {
    assert.deepEqual(
      projectSessionCatalogSummary(
        sessionProjection({
          status: 'running',
          liveRunState: { schemaVersion: 1, runningTurnIds: ['turn-1', 'turn-2'] },
        }),
      ).runningTurnIds,
      ['turn-1', 'turn-2'],
    );
    const knownEmpty = projectSessionCatalogSummary(
      sessionProjection({ liveRunState: { schemaVersion: 1, runningTurnIds: [] } }),
    );
    assert.equal(Object.hasOwn(knownEmpty, 'runningTurnIds'), true);
    assert.deepEqual(knownEmpty.runningTurnIds, []);
    assert.equal(
      Object.hasOwn(projectSessionCatalogSummary(sessionProjection()), 'runningTurnIds'),
      false,
    );
  });

  test('keeps remote Session paths out of Client filesystem policy', async () => {
    const driver = createRuntimeHostMakaSessionDriver({
      connection: new FakeConnection([]).value,
      cwd: '/client/workspace',
      workspace: { kind: 'project', projectId: 'project-1' },
      llmConnectionId: 'connection-1',
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
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      executionLocation: { kind: 'host' },
    });
    await assert.rejects(
      driverWithoutProject.createSession({
        cwd: '/client/workspace',
        llmConnectionId: 'connection-1',
        llmConnectionSlug: 'openai-main',
        model: 'gpt-5',
        permissionMode: 'ask',
      }),
      /requires an explicit Project/,
    );
  });

  test('exposes the session goal from the pushed continuity snapshot', async () => {
    const armedGoal = goalProjection({ status: 'active' });
    const subscription = new FakeSubscription(
      continuitySnapshot({ goal: armedGoal }),
      Promise.resolve([]),
    );
    const connection = new FakeConnection([subscription]);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/repo',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      newId: () => 'session-id',
    });

    // No session attached yet: no channel, no goal.
    assert.equal(driver.getGoal!(), null);

    const observations: Array<string | null> = [];
    const unsubscribe = driver.subscribeGoalChanges!((goal) =>
      observations.push(goal === null ? null : `${goal.status}@${goal.revision}`),
    );

    await driver.createSession({
      cwd: '/repo',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      permissionMode: 'ask',
    });

    // Channel adoption publishes the snapshot's goal without any RPC.
    assert.equal(driver.getGoal!()?.goalId, 'goal-1');
    assert.deepEqual(observations, ['active@1']);
    assert.equal(
      connection.requests.some(({ operation }) => operation === 'goal.query'),
      false,
    );

    // A pushed projection frame with a bumped revision updates the read and
    // notifies listeners — this is how an abort auto-pause reaches the TUI.
    const pausedGoal = goalProjection({ status: 'paused', revision: 2, pausedAt: 90 });
    subscription.push({
      kind: 'subscription.session_projection',
      hostEpoch: 'host-1',
      subscriptionId: 'subscription-1',
      sequence: 1,
      snapshot: continuitySnapshot({ goal: pausedGoal, projectionRevision: 2 }),
    });
    await waitFor(() => driver.getGoal!()?.status === 'paused');
    assert.deepEqual(observations, ['active@1', 'paused@2']);

    // An unchanged goal in a later frame must not re-notify. Proven by the
    // exact sequence: if it had notified, a duplicate 'paused@2' would appear
    // before the 'cleared@3' below.
    subscription.push({
      kind: 'subscription.session_projection',
      hostEpoch: 'host-1',
      subscriptionId: 'subscription-1',
      sequence: 2,
      snapshot: continuitySnapshot({ goal: pausedGoal, projectionRevision: 3 }),
    });
    subscription.push({
      kind: 'subscription.session_projection',
      hostEpoch: 'host-1',
      subscriptionId: 'subscription-1',
      sequence: 3,
      snapshot: continuitySnapshot({
        goal: goalProjection({ status: 'cleared', revision: 3 }),
        projectionRevision: 4,
      }),
    });
    await waitFor(() => observations.length === 3);
    assert.deepEqual(observations, ['active@1', 'paused@2', 'cleared@3']);

    // startNewSession drops the channel: goal reads null and listeners hear it.
    await driver.startNewSession();
    assert.equal(driver.getGoal!(), null);
    assert.deepEqual(observations, ['active@1', 'paused@2', 'cleared@3', null]);

    unsubscribe();
  });

  test('controlGoal applies actions with the snapshot revision and retries conflicts', async () => {
    const armedGoal = goalProjection({ status: 'active' });
    const subscription = new FakeSubscription(
      continuitySnapshot({ goal: armedGoal }),
      Promise.resolve([]),
    );
    const connection = new FakeConnection([subscription]);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/repo',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      newId: () => 'session-id',
    });

    // No session attached: no-op, no RPC.
    assert.equal(await driver.controlGoal!('pause'), null);
    assert.equal(
      connection.requests.some(({ operation }) => operation === 'goal.control'),
      false,
    );

    await driver.createSession({
      cwd: '/repo',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      permissionMode: 'ask',
    });

    // Clean path: one control request carrying the snapshot revision, no query.
    connection.goalControlOutcomes.push(
      goalProjection({ status: 'paused', revision: 2, pausedAt: 90 }),
    );
    assert.equal((await driver.controlGoal!('pause'))?.status, 'paused');
    let controlRevisions = connection.requests
      .filter(({ operation }) => operation === 'goal.control')
      .map(({ input }) => (input as OperationInput<'goal.control'>).expectedRevision);
    assert.deepEqual(controlRevisions, [1]);
    assert.equal(
      connection.requests.some(({ operation }) => operation === 'goal.query'),
      false,
    );

    // The host broadcasts the pause; the snapshot folds it before the next action.
    subscription.push({
      kind: 'subscription.session_projection',
      hostEpoch: 'host-1',
      subscriptionId: 'subscription-1',
      sequence: 1,
      snapshot: continuitySnapshot({
        goal: goalProjection({ status: 'paused', revision: 2, pausedAt: 90 }),
        projectionRevision: 2,
      }),
    });
    await waitFor(() => driver.getGoal!()?.revision === 2);

    // Conflict path: re-query for the fresh revision and retry against it.
    connection.goalControlOutcomes.push(
      new RuntimeHostOperationError('goal.control', 'operation_conflict', 'revision conflict'),
      goalProjection({ status: 'active', revision: 4 }),
    );
    connection.goalQueryResults.push(
      goalProjection({ status: 'paused', revision: 3, pausedAt: 95 }),
    );
    assert.equal((await driver.controlGoal!('resume'))?.revision, 4);
    controlRevisions = connection.requests
      .filter(({ operation }) => operation === 'goal.control')
      .map(({ input }) => (input as OperationInput<'goal.control'>).expectedRevision);
    assert.deepEqual(controlRevisions, [1, 2, 3]);
    assert.equal(
      connection.requests.filter(({ operation }) => operation === 'goal.query').length,
      1,
    );

    // Conflict where a concurrent controller removed the goal mid-flight: null
    // (for clear, that is the desired end state).
    connection.goalControlOutcomes.push(
      new RuntimeHostOperationError('goal.control', 'operation_conflict', 'revision conflict'),
    );
    connection.goalQueryResults.push(null);
    assert.equal(await driver.controlGoal!('clear'), null);

    // Status conflict (invalid transition): the re-query returns the SAME
    // revision — every accepted transition bumps it — proving a refusal, not
    // a race. The host's reason is rethrown, not a misleading retry-exhaustion
    // error, and the loop stops instead of burning the remaining attempts.
    connection.goalControlOutcomes.push(
      new RuntimeHostOperationError(
        'goal.control',
        'operation_conflict',
        'Goal cannot pause from status paused',
      ),
    );
    connection.goalQueryResults.push(
      goalProjection({ status: 'paused', revision: 2, pausedAt: 90 }),
    );
    await assert.rejects(driver.controlGoal!('pause'), /Goal cannot pause from status paused/);
    const attempts = connection.requests.filter(
      ({ operation }) => operation === 'goal.control',
    ).length;
    assert.equal(attempts, 5); // 1 clean + 2 raced + 1 raced-then-gone + 1 refused — no futile retries

    // A third conflict has no retry left to serve, so preserve that final Host
    // reason instead of replacing it with a generic retry-exhaustion message.
    connection.goalControlOutcomes.push(
      new RuntimeHostOperationError('goal.control', 'operation_conflict', 'revision conflict 1'),
      new RuntimeHostOperationError('goal.control', 'operation_conflict', 'revision conflict 2'),
      new RuntimeHostOperationError(
        'goal.control',
        'operation_conflict',
        'Goal cannot resume from status active',
      ),
    );
    connection.goalQueryResults.push(
      goalProjection({ status: 'paused', revision: 3, pausedAt: 95 }),
      goalProjection({ status: 'paused', revision: 4, pausedAt: 95 }),
    );
    await assert.rejects(driver.controlGoal!('resume'), /Goal cannot resume from status active/);
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
        llmConnectionId: 'connection-1',
        llmConnectionSlug: 'openai-main',
        model: 'gpt-5',
        newId: () => 'session-id',
      });

      await driver.createSession({
        cwd: candidate.cwd,
        ...('projectId' in candidate ? { projectId: candidate.projectId } : {}),
        llmConnectionId: 'connection-1',
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
            connectionId: 'connection-1',
            connectionSlug: 'openai-main',
            model: 'gpt-5',
          },
          permissionMode: 'ask',
        },
      );
    }
  });

  test('starts one user command without opening an agent turn', async () => {
    const subscription = new FakeSubscription(
      continuitySnapshot({
        rootTurn: null,
        session: {
          sessionId: 'id-1',
          metadataRevision: 1,
          status: 'running',
          createdAt: 1,
          isArchived: false,
        },
      }),
      Promise.resolve([]),
    );
    const connection = new FakeConnection([subscription]);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/repo',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      newId: (() => {
        let id = 0;
        return () => `id-${++id}`;
      })(),
    });
    const command = await driver.runUserCommand!('pwd');

    assert.equal(command.commandId, 'user-command-id-2');
    assert.equal(command.result.mode, 'pipes');
    assert.deepEqual(
      connection.requests.map((request) => request.operation),
      ['session.create', 'runtime.resource.start'],
    );
    assert.deepEqual(connection.requests[1]?.input, {
      sessionId: 'id-1',
      launchId: 'user-command-id-2',
      command: 'pwd',
    });
    assert.equal(command.takeRacedUpdate(), undefined);
  });

  test('retains a terminal user-command update that arrives before its card is created', async () => {
    const subscription = new FakeSubscription(
      continuitySnapshot({
        rootTurn: null,
        session: {
          sessionId: 'id-1',
          metadataRevision: 1,
          status: 'running',
          createdAt: 1,
          isArchived: false,
        },
      }),
      Promise.resolve([]),
    );
    const connection = new FakeConnection([subscription]);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/repo',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      newId: (() => {
        let id = 0;
        return () => `id-${++id}`;
      })(),
    });
    connection.onRuntimeResourceStart = async () => {
      const startRequest = connection.requests.at(-1);
      if (!startRequest) throw new Error('Expected Runtime Resource start request');
      const launchId = (startRequest.input as { launchId: string }).launchId;
      connection.runtimeResourceQuery = {
        kind: 'resource',
        sessionId: 'id-1',
        revision: `sha256:${'a'.repeat(64)}`,
        resource: {
          sessionId: 'id-1',
          ownership: { kind: 'local' },
          sourceTurnId: launchId,
          sourceToolCallId: launchId,
          result: {
            ...connection.userCommandResource,
            status: 'completed',
            output: { ...connection.userCommandResource.output, stdout: 'done\n' },
            updatedAt: 2,
            completedAt: 2,
            exitCode: 0,
            revision: 2,
          },
        } satisfies ShellRunUpdate,
      };
      subscription.push({
        kind: 'subscription.session_domain_changed',
        hostEpoch: 'host-1',
        subscriptionId: 'subscription-1',
        sequence: 1,
        sessionId: 'id-1',
        domain: 'runtime_resource',
        resources: [{ sourceSessionId: 'id-1', ref: connection.userCommandResource.ref }],
      });
      await waitFor(() =>
        connection.requests.some((request) => request.operation === 'runtime.resource.query'),
      );
      await delay(0);
    };

    const command = await driver.runUserCommand!('printf done');
    const raced = command.takeRacedUpdate();

    assert.equal(raced?.status, 'completed');
    assert.equal(raced?.output?.mode, 'pipes');
    assert.equal(raced?.output?.mode === 'pipes' && raced.output.stdout, 'done\n');
  });

  test('stops an already-running user command when the driver closes', async () => {
    const subscription = new FakeSubscription(
      continuitySnapshot({
        rootTurn: null,
        session: {
          sessionId: 'id-1',
          metadataRevision: 1,
          status: 'running',
          createdAt: 1,
          isArchived: false,
        },
      }),
      Promise.resolve([]),
    );
    const connection = new FakeConnection([subscription]);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/repo',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      newId: sequenceIds('id-1', 'id-2'),
    });
    const command = await driver.runUserCommand!('sleep 3600');
    command.takeRacedUpdate();

    await driver.stop();

    const stop = connection.requests.find(
      (request) => request.operation === 'runtime.resource.stop',
    );
    assert.deepEqual(stop?.input, {
      sessionId: 'id-1',
      ref: connection.userCommandResource.ref,
    });
  });

  test('stops a user command whose start races driver close', async () => {
    const subscription = new FakeSubscription(
      continuitySnapshot({
        rootTurn: null,
        session: {
          sessionId: 'id-1',
          metadataRevision: 1,
          status: 'running',
          createdAt: 1,
          isArchived: false,
        },
      }),
      Promise.resolve([]),
    );
    const connection = new FakeConnection([subscription]);
    const releaseStart = deferred<void>();
    connection.onRuntimeResourceStart = () => releaseStart.promise;
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/repo',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      newId: sequenceIds('id-1', 'id-2'),
    });

    const starting = driver.runUserCommand!('sleep 3600');
    await waitFor(() =>
      connection.requests.some((request) => request.operation === 'runtime.resource.start'),
    );
    const stopping = driver.stop();
    releaseStart.resolve();
    const command = await starting;
    command.takeRacedUpdate();
    await stopping;

    assert.equal(
      connection.requests.filter((request) => request.operation === 'runtime.resource.stop').length,
      1,
    );
  });

  test('a rejecting user-command stop does not fail the turn interrupt (#3210)', async () => {
    const subscription = new FakeSubscription(
      continuitySnapshot({
        rootTurn: runningTurn('turn-1', 'run-1'),
        session: {
          sessionId: 'id-1',
          metadataRevision: 1,
          status: 'running',
          createdAt: 1,
          isArchived: false,
        },
      }),
      Promise.resolve([]),
    );
    const connection = new FakeConnection([subscription]);
    connection.runtimeResourceStopFailure = new Error('host_draining');
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/repo',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      newId: sequenceIds('id-1', 'id-2'),
    });
    const command = await driver.runUserCommand!('sleep 3600');
    command.takeRacedUpdate();

    // turn.stop succeeds while the user-command stop rejects: the interrupt
    // itself must still report success.
    await driver.stop();

    assert.ok(connection.requests.some((request) => request.operation === 'turn.stop'));
    assert.ok(connection.requests.some((request) => request.operation === 'runtime.resource.stop'));
  });

  test('stops a running user command before switching Sessions (#3210)', async () => {
    const subscription = new FakeSubscription(
      continuitySnapshot({
        rootTurn: null,
        session: {
          sessionId: 'id-1',
          metadataRevision: 1,
          status: 'running',
          createdAt: 1,
          isArchived: false,
        },
      }),
      Promise.resolve([]),
    );
    const switchSubscription = new FakeSubscription(
      continuitySnapshot({ rootTurn: null }),
      Promise.resolve([]),
    );
    const connection = new FakeConnection([subscription, switchSubscription]);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/repo',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      newId: sequenceIds('id-1', 'id-2'),
    });
    const command = await driver.runUserCommand!('sleep 3600');
    command.takeRacedUpdate();

    await driver.switchSession('session-1');

    const stopIndex = connection.requests.findIndex(
      (request) => request.operation === 'runtime.resource.stop',
    );
    assert.notEqual(stopIndex, -1);
    assert.deepEqual(connection.requests[stopIndex]?.input, {
      sessionId: 'id-1',
      ref: connection.userCommandResource.ref,
    });
    assert.equal(driver.getSessionId(), 'session-1');
  });

  test('a rejecting user-command stop aborts the switch before any durable relocation commits (#3210)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-tui-switch-stop-failure-'));
    const target = join(root, 'new-worktree');
    await mkdir(target);
    try {
      const oldCwd = join(root, 'old-worktree');
      const subscription = new FakeSubscription(
        continuitySnapshot({
          rootTurn: null,
          session: {
            sessionId: 'id-1',
            metadataRevision: 1,
            status: 'running',
            createdAt: 1,
            isArchived: false,
          },
        }),
        Promise.resolve([]),
      );
      const connection = new FakeConnection([subscription]);
      connection.sessionQueries.push(
        sessionProjection({
          workspace: { target: { kind: 'host_path', path: oldCwd }, hostCwd: oldCwd },
        }),
      );
      connection.runtimeResourceStopFailure = new Error('host_draining');
      const driver = createRuntimeHostMakaSessionDriver({
        connection: connection.value,
        cwd: root,
        llmConnectionId: 'connection-1',
        llmConnectionSlug: 'openai-main',
        model: 'gpt-5',
        newId: sequenceIds('id-1', 'id-2'),
        inspectCwdChanges: async () => undefined,
      });
      const command = await driver.runUserCommand!('sleep 3600');
      command.takeRacedUpdate();

      await assert.rejects(
        driver.switchSession('session-1', { relocateCwd: './new-worktree' }),
        /host_draining/,
      );

      // The switch aborted before anything durable: no relocation was
      // committed and the driver still owns the original Session.
      assert.equal(
        connection.requests.some(({ operation }) => operation === 'session.workspace.relocate'),
        false,
      );
      assert.equal(driver.getSessionId(), 'id-1');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('awaits the user-command stop before clearing identity on /new (#3210)', async () => {
    const subscription = new FakeSubscription(
      continuitySnapshot({
        rootTurn: null,
        session: {
          sessionId: 'id-1',
          metadataRevision: 1,
          status: 'running',
          createdAt: 1,
          isArchived: false,
        },
      }),
      Promise.resolve([]),
    );
    const connection = new FakeConnection([subscription]);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/repo',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      newId: sequenceIds('id-1', 'id-2'),
    });
    const command = await driver.runUserCommand!('sleep 3600');
    command.takeRacedUpdate();

    await driver.startNewSession();

    const stop = connection.requests.find(
      (request) => request.operation === 'runtime.resource.stop',
    );
    assert.deepEqual(stop?.input, {
      sessionId: 'id-1',
      ref: connection.userCommandResource.ref,
    });
    assert.equal(driver.getSessionId(), null);
  });

  test('a rejected user-command stop aborts /new without clearing identity (#3210 review)', async () => {
    const subscription = new FakeSubscription(
      continuitySnapshot({
        rootTurn: null,
        session: {
          sessionId: 'id-1',
          metadataRevision: 1,
          status: 'running',
          createdAt: 1,
          isArchived: false,
        },
      }),
      Promise.resolve([]),
    );
    const connection = new FakeConnection([subscription]);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/repo',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      newId: sequenceIds('id-1', 'id-2'),
    });
    const command = await driver.runUserCommand!('sleep 3600');
    command.takeRacedUpdate();

    connection.runtimeResourceStopFailure = new Error('host_draining');
    await assert.rejects(() => driver.startNewSession(), /host_draining/);

    // Nothing committed: the previous Session is still owned, so its card and
    // Ctrl+C affordance remain live.
    assert.equal(driver.getSessionId(), 'id-1');

    // Once the Host recovers, /new proceeds normally.
    connection.runtimeResourceStopFailure = undefined;
    await driver.startNewSession();
    assert.equal(driver.getSessionId(), null);
  });

  test('submits a same-slug model recovery with the newly selected Connection id', async () => {
    const connection = new FakeConnection([
      new FakeSubscription(continuitySnapshot(), Promise.resolve([])),
    ]);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/repo',
      llmConnectionId: 'connection-a',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      newId: () => 'session-id',
    });

    await driver.createSession({
      cwd: '/repo',
      llmConnectionId: 'connection-a',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
    });
    connection.sessionQueries.push(
      sessionProjection({ revision: 1, llmConnectionId: 'connection-a' }),
      sessionProjection({ revision: 2, llmConnectionId: 'connection-a' }),
    );
    connection.configurationOutcomes.push(
      { kind: 'revision_conflict', expectedRevision: 1, actualRevision: 2 },
      {
        kind: 'committed',
        session: sessionProjection({
          revision: 3,
          llmConnectionId: 'connection-b',
          llmConnectionSlug: 'openai-main',
          model: 'gpt-5',
        }),
      },
    );
    await driver.setModel('gpt-5', 'openai-main', 'connection-b');

    assert.deepEqual(
      connection.requests
        .filter(({ operation }) => operation === 'session.configuration.update')
        .map(({ input }) => input),
      [1, 2].map((expectedRevision) => ({
        sessionId: 'session-id',
        expectedRevision,
        patch: {
          modelTarget: {
            kind: 'explicit',
            connectionId: 'connection-b',
            connectionSlug: 'openai-main',
            model: 'gpt-5',
          },
          thinkingLevel: null,
        },
      })),
    );
  });

  test('drops a per-session Full access elevation when a fresh Session starts (#3020)', async () => {
    // The TUI flow behind /new: session A is elevated to bypass, then the
    // driver is asked to start over. The next prompt lazily creates session B
    // through preparePrompt. Session B must be created with the
    // construction-time default — Full access is an explicit per-session
    // opt-in, never inherited.
    const connection = new FakeConnection([
      new FakeSubscription(continuitySnapshot(), Promise.resolve([])),
      new FakeSubscription(
        continuitySnapshot({
          session: {
            sessionId: 'session-2',
            metadataRevision: 1,
            status: 'running',
            createdAt: 1,
            isArchived: false,
          },
          rootTurn: null,
        }),
        Promise.resolve([]),
      ),
    ]);
    let nextId = 0;
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/repo',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      prospectivePermissionMode: 'ask',
      newId: () => `session-${++nextId}`,
    });

    await driver.createSession({
      cwd: '/repo',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      permissionMode: 'ask',
    });
    connection.executionBoundary = { kind: 'bypass', revision: 2 };
    await driver.setPermissionMode('bypass');
    assert.equal(driver.getPermissionMode?.(), 'bypass');

    await driver.startNewSession();
    assert.equal(driver.getPermissionMode?.(), 'ask');

    // The fresh Session's boundary is managed again once it exists.
    connection.executionBoundary = { kind: 'managed', access: 'writable', revision: 3 };
    await driver.preparePrompt('hello');

    const creates = connection.requests.filter(({ operation }) => operation === 'session.create');
    assert.equal(creates.length, 2);
    // The elevation does not leak, and the fresh Session carries no client
    // claim at all: an omitted field is what leaves the starting mode to the
    // Host's `chatDefaults`. Substituting the launch reading here would make
    // the CLI a second authority over it.
    assert.deepEqual(creates[1]!.input, {
      sessionId: 'session-2',
      workspace: { kind: 'host_path', path: '/repo' },
      name: 'New Chat',
      modelTarget: {
        kind: 'explicit',
        connectionId: 'connection-1',
        connectionSlug: 'openai-main',
        model: 'gpt-5',
      },
    });
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
        llmConnectionId: 'connection-1',
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
      llmConnectionId: 'connection-1',
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
      llmConnectionId: 'connection-1',
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
      llmConnectionId: 'connection-1',
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
      llmConnectionId: 'connection-1',
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
      llmConnectionId: 'connection-1',
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
      llmConnectionId: 'connection-1',
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

  test('hides the copied parent transcript when a Host starts the side successor turn', async () => {
    const parentTranscript = [
      userMessage('turn-parent', 'Parent question'),
      assistantMessage('turn-parent', 'Parent answer'),
    ];
    const first = new FakeSubscription(
      continuitySnapshot(),
      Promise.resolve([...parentTranscript]),
    );
    const refresh = new FakeSubscription(
      continuitySnapshot({ rootTurn: completedTurn('turn-1', 'run-1') }),
      Promise.resolve([...parentTranscript]),
      'subscription-refresh',
    );
    const second = new FakeSubscription(
      continuitySnapshot({
        projectionRevision: 3,
        rootTurn: runningTurn('turn-2', 'run-2'),
      }),
      Promise.resolve([
        ...parentTranscript,
        userMessage('turn-2', 'Side follow up'),
        assistantMessage('turn-2', 'Side answer'),
      ]),
      'subscription-2',
    );
    const connection = new FakeConnection([first, refresh, second]);
    // A side Session is a copy that carries the parent transcript; both the
    // initial switch and the reattach's configuration load must see the side
    // labels so the driver keeps hiding everything through `turn-parent`.
    const sideProjection = () =>
      sessionProjection({
        labels: ['mode:side_conversation'],
        parentSessionId: 'parent-1',
        branchOfTurnId: 'turn-parent',
      });
    connection.sessionQueries.push(sideProjection(), sideProjection());
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      now: () => 60,
    });
    const initial = await driver.switchSession('session-1');
    assert.ok(initial.activeTurn);
    // The visible side transcript starts empty even though the copy carried
    // the parent's messages.
    assert.deepEqual(initial.messages, []);
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
    // Without the filter this replaced the visible transcript with the copied
    // parent conversation the user opened `/side` to leave (#3881).
    assert.deepEqual(attached.messages, [
      userMessage('turn-2', 'Side follow up'),
      assistantMessage('turn-2', 'Side answer'),
    ]);
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
      llmConnectionId: 'connection-1',
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
      llmConnectionId: 'connection-1',
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
      llmConnectionId: 'connection-1',
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
      llmConnectionId: 'connection-1',
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
      llmConnectionId: 'connection-1',
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
      llmConnectionId: 'connection-1',
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
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      newId: sequenceIds('retract-1'),
    });
    await driver.switchSession('session-1');

    await driver.submitMessage!('Later', {
      messageId: 'message-1',
      placement: 'next_turn',
    });
    assert.deepEqual(await driver.retractQueued!(), {
      text: 'Later',
      messageIds: ['message-1'],
    });
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

  test('submits an idle message under the caller-owned stable identity', async () => {
    const subscription = new FakeSubscription(continuitySnapshot(), Promise.resolve([]));
    const connection = new FakeConnection([subscription]);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      newId: sequenceIds('unused-generated-id'),
    });
    await driver.switchSession('session-1');

    await driver.submitMessage!('Visible prompt', {
      messageId: 'message-1',
      placement: 'current_turn',
      modelText: 'Expanded prompt',
    });
    assert.deepEqual(connection.requests.at(-1), {
      operation: 'turn.message.submit',
      input: {
        originHostEpoch: 'host-1',
        sessionId: 'session-1',
        messageId: 'message-1',
        content: { text: 'Expanded prompt', displayText: 'Visible prompt' },
        placement: 'current_turn',
      },
    });
  });

  test('admits concurrent first messages into one Session in submission order', async () => {
    // Two subscriptions so a driver that creates two Sessions fails on the
    // claim rather than on missing fake infrastructure.
    const connection = new FakeConnection([
      new FakeSubscription(continuitySnapshot(), Promise.resolve([])),
      new FakeSubscription(continuitySnapshot(), Promise.resolve([])),
    ]);
    const create = deferred<void>();
    connection.heldOperations.set('session.create', create.promise);
    let nextId = 0;
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/repo',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      newId: () => `session-${++nextId}`,
    });

    // Two Enters before the first round trip resolves. Nothing about the TUI
    // holds the second one back, so the driver is what has to keep them from
    // racing into two Sessions or reaching the Host out of order.
    const first = driver.submitMessage!('first', {
      messageId: 'message-1',
      placement: 'current_turn',
    });
    const second = driver.submitMessage!('second', {
      messageId: 'message-2',
      placement: 'current_turn',
    });
    create.resolve();
    await Promise.all([first, second]);

    const creates = connection.requests.filter(({ operation }) => operation === 'session.create');
    assert.equal(creates.length, 1);
    const submits = connection.requests.filter(
      ({ operation }) => operation === 'turn.message.submit',
    );
    assert.deepEqual(
      submits.map(({ input }) => (input as OperationInput<'turn.message.submit'>).messageId),
      ['message-1', 'message-2'],
    );
    assert.deepEqual(
      new Set(
        submits.map(({ input }) => (input as OperationInput<'turn.message.submit'>).sessionId),
      ),
      new Set(['session-1']),
    );
  });

  test('keeps a configuration change from crossing a pending admission', async () => {
    const subscription = new FakeSubscription(continuitySnapshot(), Promise.resolve([]));
    const connection = new FakeConnection([subscription]);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
    });
    await driver.switchSession('session-1');

    const submit = deferred<void>();
    connection.heldOperations.set('turn.message.submit', submit.promise);
    const admitted = driver.submitMessage!('before the model change', {
      messageId: 'message-1',
      placement: 'current_turn',
    });
    // `/model` typed while the Message is still in flight. The Host must see
    // it after the Message it was typed after, or the Turn that Message opens
    // runs under a model the user had not chosen yet.
    const changed = driver.setModel('gpt-5-codex');
    submit.resolve();
    await Promise.all([admitted, changed]);

    const ordered = connection.requests
      .map(({ operation }) => operation)
      .filter(
        (operation) =>
          operation === 'turn.message.submit' || operation === 'session.configuration.update',
      );
    assert.deepEqual(ordered, ['turn.message.submit', 'session.configuration.update']);
  });

  test('keeps an unknown message admission available for transcript reconciliation', async () => {
    const subscription = new FakeSubscription(continuitySnapshot(), Promise.resolve([]));
    const connection = new FakeConnection([subscription]);
    connection.messageSubmitOutcomes.push(
      new RuntimeHostOperationError(
        'turn.message.submit',
        'outcome_unknown',
        'Message disposition cannot be proven in this Host Epoch',
      ),
    );
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
    });
    await driver.switchSession('session-1');

    await assert.doesNotReject(() =>
      driver.submitMessage!('Keep this visible', {
        messageId: 'message-unknown',
        placement: 'current_turn',
      }),
    );
  });

  test('keeps a dispatched interrupted admission available for transcript reconciliation', async () => {
    const subscription = new FakeSubscription(continuitySnapshot(), Promise.resolve([]));
    const connection = new FakeConnection([subscription]);
    connection.messageSubmitOutcomes.push(
      new RuntimeHostRequestInterruptedError(
        'turn.message.submit',
        'command',
        'dispatched',
        'connection_lost',
      ),
    );
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
    });
    await driver.switchSession('session-1');

    await assert.doesNotReject(() =>
      driver.submitMessage!('Keep this visible', {
        messageId: 'message-interrupted',
        placement: 'current_turn',
      }),
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
      llmConnectionId: 'connection-1',
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

  test('answers and releases a Host-owned form through the generic Interaction operation', async () => {
    const subscription = new FakeSubscription(
      continuitySnapshot({ interactions: { pending: [pendingForm()] } }),
      Promise.resolve([]),
    );
    const connection = new FakeConnection([subscription]);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      now: () => 76,
    });
    const switched = await driver.switchSession('session-1');
    assert.ok(switched.activeTurn);
    assert.equal((await nextEvent(switched.activeTurn.events)).type, 'form_request');

    await driver.respondToUserForm!({
      requestId: 'form-1',
      action: 'accept',
      values: { version: 'v2' },
    });

    assert.deepEqual(connection.requests.at(-1), {
      operation: 'interaction.answer',
      input: {
        sessionId: 'session-1',
        interactionId: 'form-1',
        answer: { kind: 'form', action: 'accept', values: { version: 'v2' } },
      },
    });
    assert.deepEqual(await nextEvent(switched.activeTurn.events), {
      type: 'form_answer_ack',
      id: 'host-interaction:form-1:2',
      turnId: 'turn-1',
      ts: 76,
      requestId: 'form-1',
      toolUseId: 'tool-form',
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
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
    });
    const published = deferred<InteractionPendingSnapshot>();
    driver.subscribePendingInteractions((pending) => published.resolve(pending));

    await driver.switchSession('session-1');

    assert.deepEqual(await published.promise, permission);
  });

  test('keeps Host-triggered prompts out of rewind', async () => {
    const attached = new FakeSubscription(continuitySnapshot(), Promise.resolve([]));
    const messages: StoredMessage[] = [
      userMessage('turn-new', 'Newest prompt'),
      {
        ...userMessage('turn-automation', 'Automated prompt'),
        origin: { kind: 'legacy_automation', automationId: 'automation-1' },
      },
      {
        ...userMessage('turn-automation', 'Steer the automated turn'),
        id: 'user-turn-automation-steering',
        steeringEventId: 'runtime-event-steering',
      },
    ];
    const current = new FakeSubscription(
      continuitySnapshot(),
      Promise.resolve(messages),
      'subscription-2',
    );
    const direct = new FakeSubscription(
      continuitySnapshot(),
      Promise.resolve(messages),
      'subscription-3',
    );
    const connection = new FakeConnection([attached, current, direct]);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
    });
    await driver.switchSession('session-1');

    assert.deepEqual(await driver.listRewindTargets(), [
      { turnId: 'turn-new', label: 'Newest prompt' },
    ]);
    await assert.rejects(
      driver.rewindToTurn('turn-automation'),
      /Host-triggered prompts are read-only/,
    );
    assert.equal(
      connection.requests.some(({ operation }) => operation === 'session.revision.create'),
      false,
    );
  });

  test('opens a hidden side copy at the latest completed Turn and removes it on close', async (t) => {
    const cleanupRoot = await mkdtemp(join(tmpdir(), 'maka-tui-side-'));
    t.after(() => rm(cleanupRoot, { recursive: true, force: true }));
    const sourceMessages: StoredMessage[] = [
      userMessage('turn-completed', 'Settled question'),
      assistantMessage('turn-completed', 'Settled answer'),
      turnStateMessage('turn-completed', 'completed'),
      userMessage('turn-failed', 'Failed question'),
      turnStateMessage('turn-failed', 'failed'),
    ];
    const subscriptions = [
      new FakeSubscription(continuitySnapshot({ rootTurn: null }), Promise.resolve(sourceMessages)),
      new FakeSubscription(
        continuitySnapshot({ rootTurn: null }),
        Promise.resolve(sourceMessages),
        'subscription-copy-source',
      ),
      new FakeSubscription(
        continuitySnapshot({ rootTurn: null }),
        Promise.resolve(sourceMessages.slice(0, 3)),
        'subscription-side',
      ),
      new FakeSubscription(
        continuitySnapshot({ rootTurn: null }),
        Promise.resolve([
          ...sourceMessages.slice(0, 3),
          userMessage('turn-side', 'Side question'),
          assistantMessage('turn-side', 'Side answer'),
        ]),
        'subscription-side-read',
      ),
      new FakeSubscription(
        continuitySnapshot({ rootTurn: null }),
        Promise.resolve(sourceMessages),
        'subscription-parent-return',
      ),
    ];
    const connection = new FakeConnection(subscriptions);
    connection.sessionQueries.push(
      sessionProjection({ id: 'session-1' }),
      sessionProjection({ id: 'session-1', revision: 4 }),
      sessionProjection({
        id: 'side-1',
        labels: ['mode:side_conversation'],
        parentSessionId: 'session-1',
        branchOfTurnId: 'turn-completed',
      }),
      sessionProjection({ id: 'session-1' }),
      sessionProjection({ id: 'side-1', labels: ['mode:side_conversation'] }),
    );
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      newId: () => 'side-1',
      sessionCopyCleanupRoot: cleanupRoot,
    });
    await driver.switchSession('session-1');

    const opened = await driver.openSideConversation!();

    assert.equal((await stat(join(cleanupRoot, 'a'.repeat(64), 'runtime.sqlite'))).isFile(), true);

    assert.equal(opened.parentSessionId, 'session-1');
    assert.equal(opened.sideSessionId, 'side-1');
    assert.deepEqual(opened.messages, []);
    assert.deepEqual(
      (await driver.readMessages()).map((message) =>
        'turnId' in message ? `${message.type}:${message.turnId}` : message.type,
      ),
      ['user:turn-side', 'assistant:turn-side'],
    );
    assert.deepEqual(
      connection.requests.find(({ operation }) => operation === 'session.branch.create')?.input,
      {
        sourceSessionId: 'session-1',
        targetSessionId: 'side-1',
        sourceTurnId: 'turn-completed',
        expectedSourceRevision: 4,
        intent: 'side_conversation',
      },
    );

    const closed = await driver.closeSideConversation!('side-1', 'session-1');
    assert.equal(closed.summary.id, 'session-1');
    assert.equal(closed.cleanup, 'removed');
    assert.deepEqual(
      connection.requests.find(({ operation }) => operation === 'session.remove')?.input,
      { sessionId: 'side-1', expectedRevision: 1 },
    );
  });

  test('opens an empty side copy when the parent has no completed Turn yet', async (t) => {
    const cleanupRoot = await mkdtemp(join(tmpdir(), 'maka-tui-side-empty-'));
    t.after(() => rm(cleanupRoot, { recursive: true, force: true }));
    // The parent's first Turn is still running (an explicit running turn_state),
    // so there is no completed Turn to branch through. The side conversation
    // must still open, forking with an empty context instead of erroring.
    const sourceMessages: StoredMessage[] = [
      userMessage('turn-running', 'In-flight question'),
      {
        type: 'turn_state',
        id: 'state-turn-running',
        turnId: 'turn-running',
        ts: 80,
        status: 'running',
        partialOutputRetained: true,
      },
    ];
    const subscriptions = [
      new FakeSubscription(continuitySnapshot({ rootTurn: null }), Promise.resolve(sourceMessages)),
      new FakeSubscription(
        continuitySnapshot({ rootTurn: null }),
        Promise.resolve(sourceMessages),
        'subscription-copy-source',
      ),
      // The empty copy carries no source transcript.
      new FakeSubscription(
        continuitySnapshot({ rootTurn: null }),
        Promise.resolve([]),
        'subscription-side',
      ),
      new FakeSubscription(
        continuitySnapshot({ rootTurn: null }),
        Promise.resolve([]),
        'subscription-side-read',
      ),
      new FakeSubscription(
        continuitySnapshot({ rootTurn: null }),
        Promise.resolve(sourceMessages),
        'subscription-parent-return',
      ),
    ];
    const connection = new FakeConnection(subscriptions);
    connection.sessionQueries.push(
      sessionProjection({ id: 'session-1' }),
      sessionProjection({ id: 'session-1', revision: 4 }),
      // The empty copy records provenance (parentSessionId) but fabricates no
      // branchOfTurnId.
      sessionProjection({
        id: 'side-1',
        labels: ['mode:side_conversation'],
        parentSessionId: 'session-1',
      }),
      sessionProjection({ id: 'session-1' }),
      sessionProjection({ id: 'side-1', labels: ['mode:side_conversation'] }),
    );
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      newId: () => 'side-1',
      sessionCopyCleanupRoot: cleanupRoot,
    });
    await driver.switchSession('session-1');

    const opened = await driver.openSideConversation!();

    assert.equal((await stat(join(cleanupRoot, 'a'.repeat(64), 'runtime.sqlite'))).isFile(), true);

    assert.equal(opened.parentSessionId, 'session-1');
    assert.equal(opened.sideSessionId, 'side-1');
    assert.deepEqual(opened.messages, []);
    assert.deepEqual(await driver.readMessages(), []);
    // The branch omits sourceTurnId entirely (empty copy) while still carrying
    // the side_conversation intent the Host requires for an empty copy.
    assert.deepEqual(
      connection.requests.find(({ operation }) => operation === 'session.branch.create')?.input,
      {
        sourceSessionId: 'session-1',
        targetSessionId: 'side-1',
        expectedSourceRevision: 4,
        intent: 'side_conversation',
      },
    );

    const closed = await driver.closeSideConversation!('side-1', 'session-1');
    assert.equal(closed.summary.id, 'session-1');
    assert.equal(closed.cleanup, 'removed');
  });

  test('observes actionable and terminal parent status from the Host projection', async () => {
    const subscription = new FakeSubscription(
      continuitySnapshot({ interactions: { pending: [pendingPermission()] } }),
      Promise.resolve([]),
    );
    const driver = createRuntimeHostMakaSessionDriver({
      connection: new FakeConnection([subscription]).value,
      cwd: '/tmp',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
    });
    const statuses: Array<MakaSideConversationParentStatus | undefined> = [];

    const stop = await driver.observeSideConversationParent!('session-1', (status) => {
      statuses.push(status);
    });
    assert.equal(statuses.at(-1), 'needs_approval');

    subscription.push(projectionFrame(1, runningTurn('turn-2', 'run-2'), 2));
    await waitFor(() => statuses.at(-1) === undefined);
    subscription.push(projectionFrame(2, completedTurn('turn-2', 'run-2'), 3));
    await waitFor(() => statuses.at(-1) === 'finished');

    await stop();
  });

  test('clears parent status when observer recovery is exhausted', async () => {
    const snapshot = continuitySnapshot({ interactions: { pending: [pendingPermission()] } });
    const initial = new FakeSubscription(snapshot, Promise.resolve([]));
    const ended = Array.from({ length: 8 }, (_, index) => {
      const subscription = new FakeSubscription(
        { ...snapshot, projectionRevision: index + 2 },
        Promise.resolve([]),
        `subscription-${index + 2}`,
      );
      void subscription.close();
      return subscription;
    });
    const connection = new FakeConnection([initial, ...ended], true);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
    });
    const statuses: Array<MakaSideConversationParentStatus | undefined> = [];
    const cleared = deferred<void>();

    await driver.observeSideConversationParent!('session-1', (status) => {
      statuses.push(status);
      if (status === undefined) cleared.resolve();
    });
    assert.equal(statuses.at(-1), 'needs_approval');

    await initial.close();
    await Promise.race([
      cleared.promise,
      delay(3_000).then(() => assert.fail('Timed out waiting for observer recovery exhaustion')),
    ]);
    assert.equal(connection.openedSubscriptions, 9);
    assert.equal(statuses.at(-1), undefined);
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
      llmConnectionId: 'connection-1',
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
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      newId: sequenceIds('turn-skill'),
    });
    await driver.switchSession('session-1');

    const turn = await driver.preparePrompt('/skill:alpha Help');
    assert.deepEqual(turn.skillInvocation?.loaded, [{ id: 'alpha', name: 'Alpha' }]);
    assert.equal(connection.requests.at(-1)?.operation, 'turn.start');

    connection.skillStartBlocked = true;
    // The failure names what could not be resolved: headless `maka run` reports
    // this message and nothing reads a structured payload off it.
    await assert.rejects(driver.preparePrompt('/skill:missing', { turnId: 'turn-blocked' }), {
      message: /Could not resolve the Skill this Turn asked for: \/skill:missing \(not found\)/,
    });
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
      llmConnectionId: 'connection-1',
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
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
    });
    await driver.switchSession('session-1');
    const replacement = deferred<readonly StoredMessage[]>();
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

  test('publishes only the newest live tool-result transcript refresh', async () => {
    const attached = new FakeSubscription(continuitySnapshot(), Promise.resolve([]));
    const firstRefresh = new FakeSubscription(
      continuitySnapshot(),
      new Promise<StoredMessage[]>(() => undefined),
      'subscription-2',
    );
    const secondMessages = [userMessage('turn-1', 'Run it'), assistantMessage('turn-1', 'Done')];
    const secondRefresh = new FakeSubscription(
      continuitySnapshot(),
      Promise.resolve(secondMessages),
      'subscription-3',
    );
    const connection = new FakeConnection([attached, firstRefresh, secondRefresh]);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
    });
    await driver.switchSession('session-1');
    const replacements: Array<readonly StoredMessage[]> = [];
    driver.subscribeTranscriptReplacements!((_sessionId, _turnId, messages, reason) => {
      assert.equal(reason, 'reconcile');
      replacements.push(messages);
    });

    attached.push(toolResultFrame(1));
    attached.push(toolResultFrame(2));
    await waitFor(() => connection.openedSubscriptions === 3);
    await waitFor(() => replacements.length === 1);
    assert.deepEqual(replacements, [secondMessages]);
  });

  test('does not publish an older tool-result transcript after the terminal transcript', async () => {
    const attached = new FakeSubscription(continuitySnapshot(), Promise.resolve([]));
    const liveTranscript = deferred<StoredMessage[]>();
    const liveRefresh = new FakeSubscription(
      continuitySnapshot(),
      liveTranscript.promise,
      'subscription-2',
    );
    const terminalMessages = [userMessage('turn-1', 'Run it'), assistantMessage('turn-1', 'Done')];
    const terminalRefresh = new FakeSubscription(
      continuitySnapshot({ rootTurn: completedTurn('turn-1', 'run-1') }),
      Promise.resolve(terminalMessages),
      'subscription-3',
    );
    const connection = new FakeConnection([attached, liveRefresh, terminalRefresh]);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
    });
    await driver.switchSession('session-1');
    const replacements: Array<{ messages: readonly StoredMessage[]; reason: string }> = [];
    driver.subscribeTranscriptReplacements!((_sessionId, _turnId, messages, reason) => {
      replacements.push({ messages, reason });
    });

    attached.push(toolResultFrame(1));
    await waitFor(() => connection.openedSubscriptions === 2);
    attached.push(projectionFrame(2, completedTurn('turn-1', 'run-1'), 2));
    await waitFor(() => replacements.length === 1);
    assert.deepEqual(replacements, [{ messages: terminalMessages, reason: 'reconcile' }]);

    liveTranscript.resolve([userMessage('turn-1', 'Run it')]);
    await delay(0);
    assert.deepEqual(replacements, [{ messages: terminalMessages, reason: 'reconcile' }]);
  });

  test('does not publish an older tool-result transcript after reconnect recovery', async () => {
    const initial = new FakeSubscription(continuitySnapshot(), Promise.resolve([]));
    const liveTranscript = deferred<StoredMessage[]>();
    const liveRefresh = new FakeSubscription(
      continuitySnapshot(),
      liveTranscript.promise,
      'subscription-2',
    );
    const recoveredMessages = [
      userMessage('turn-1', 'Run it'),
      assistantMessage('turn-1', 'Recovered'),
    ];
    const recovered = new FakeSubscription(
      continuitySnapshot({ projectionRevision: 2 }),
      Promise.resolve(recoveredMessages),
      'subscription-3',
    );
    const connection = new FakeConnection([initial, liveRefresh, recovered], true);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
    });
    await driver.switchSession('session-1');
    const replacements: Array<{ messages: readonly StoredMessage[]; reason: string }> = [];
    driver.subscribeTranscriptReplacements!((_sessionId, _turnId, messages, reason) => {
      replacements.push({ messages, reason });
    });

    initial.push(toolResultFrame(1));
    await waitFor(() => connection.openedSubscriptions === 2);
    initial.fail(
      new RuntimeHostSubscriptionError('connection_closed', 'connection lost during active Turn'),
    );
    await waitFor(() => replacements.length === 1);
    assert.deepEqual(replacements, [{ messages: recoveredMessages, reason: 'reconnect' }]);

    liveTranscript.resolve([userMessage('turn-1', 'Run it')]);
    await delay(0);
    assert.deepEqual(replacements, [{ messages: recoveredMessages, reason: 'reconnect' }]);
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
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      now: () => 50,
    });
    const switched = await driver.switchSession('session-1');
    assert.ok(switched.activeTurn);
    const transcript = deferred<readonly StoredMessage[]>();
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
      llmConnectionId: 'connection-1',
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
      llmConnectionId: 'connection-1',
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
  runtimeResourceQuery: unknown;
  onRuntimeResourceStart: (() => Promise<void>) | undefined;
  executionBoundary: unknown = { kind: 'managed', access: 'read_write', revision: 1 };
  skillStartBlocked = false;
  /** When set, runtime.resource.stop rejects with this error (e.g. a draining Host). */
  runtimeResourceStopFailure: Error | undefined;
  /** Scripted outcomes for goal.control: return the result goal, or throw (e.g. operation_conflict). */
  readonly goalControlOutcomes: Array<GoalProjection | Error> = [];
  /** Scripted goal.query results, shifted per call; defaults to null (no goal). */
  readonly goalQueryResults: Array<GoalProjection | null> = [];
  readonly messageSubmitOutcomes: Array<OperationOutput<'turn.message.submit'> | Error> = [];
  /**
   * Operations held open by a test. The request is recorded on entry and then
   * waits, so a test can hold one round trip and observe what the driver does
   * with a second call while the first is still in flight.
   */
  readonly heldOperations = new Map<string, Promise<void>>();
  readonly userCommandResource = {
    kind: 'shell_run' as const,
    ref: 'maka://runtime/background-tasks/user-command',
    mode: 'pipes' as const,
    status: 'running' as const,
    cwd: '/repo',
    cmd: 'pwd',
    startedAt: 1,
    updatedAt: 1,
    revision: 1,
    output: {
      mode: 'pipes' as const,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      redacted: false,
    },
  };
  readonly configurationOutcomes: SessionUpdateResult[] = [];
  readonly value: RuntimeHostMakaSessionDriverInput['connection'];

  constructor(
    private readonly subscriptions: FakeSubscription[],
    reconnecting = false,
  ) {
    this.value = {
      ...(reconnecting ? { reconnecting: true as const } : {}),
      rootId: 'a'.repeat(64),
      hostEpoch: 'host-1',
      request: <K extends DirectRequestOperationKey>(operation: K, input: OperationInput<K>) =>
        this.request(operation, input),
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
    const held = this.heldOperations.get(operation);
    if (held) await held;
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
    if (operation === 'session.branch.create') {
      const copy = input as OperationInput<'session.branch.create'>;
      return {
        kind: 'committed',
        session: sessionProjection({
          id: copy.targetSessionId,
          labels: copy.intent === 'side_conversation' ? ['mode:side_conversation'] : [],
          parentSessionId: copy.sourceSessionId,
          branchOfTurnId: copy.sourceTurnId,
        }),
      } as OperationOutput<K>;
    }
    if (operation === 'session.remove') {
      return {
        kind: 'removed',
        sessionId: (input as OperationInput<'session.remove'>).sessionId,
      } as OperationOutput<K>;
    }
    if (operation === 'goal.control') {
      const outcome = this.goalControlOutcomes.shift();
      if (outcome === undefined) throw new Error('Unexpected goal.control request');
      if (outcome instanceof Error) throw outcome;
      return {
        sessionId: (input as OperationInput<'goal.control'>).sessionId,
        goal: outcome,
      } as OperationOutput<K>;
    }
    if (operation === 'goal.query') {
      return {
        sessionId: (input as OperationInput<'goal.query'>).sessionId,
        goal: this.goalQueryResults.shift() ?? null,
      } as OperationOutput<K>;
    }
    if (operation === 'session.configuration.update') {
      const update = input as OperationInput<'session.configuration.update'>;
      const outcome = this.configurationOutcomes.shift();
      if (outcome) return outcome as OperationOutput<K>;
      return {
        kind: 'committed',
        session: sessionProjection({
          revision: update.expectedRevision + 1,
          permissionMode: update.patch.permissionMode ?? 'ask',
        }),
      } as OperationOutput<K>;
    }
    if (operation === 'runtime.resource.start') {
      await this.onRuntimeResourceStart?.();
      return { resource: this.userCommandResource } as OperationOutput<K>;
    }
    if (operation === 'runtime.resource.stop') {
      if (this.runtimeResourceStopFailure) throw this.runtimeResourceStopFailure;
      return {
        resource: {
          ...this.userCommandResource,
          status: 'cancelled',
          updatedAt: 2,
          completedAt: 2,
          revision: 2,
        },
      } as OperationOutput<K>;
    }
    if (operation === 'runtime.resource.query') {
      if (this.runtimeResourceQuery === undefined) {
        throw new Error('Unexpected Runtime Resource query');
      }
      return this.runtimeResourceQuery as OperationOutput<K>;
    }
    if (operation === 'turn.stop') {
      return {} as OperationOutput<K>;
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
            ? (() => {
                const outcome = this.messageSubmitOutcomes.shift();
                if (outcome instanceof Error) throw outcome;
                return (
                  outcome ?? {
                    disposition:
                      (input as OperationInput<'turn.message.submit'>).placement === 'next_turn'
                        ? 'followup'
                        : 'steering',
                    queueRevision: 2,
                  }
                );
              })()
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
                ? (input as OperationInput<'interaction.answer'>).answer.kind === 'form'
                  ? {
                      ...pendingForm(),
                      revision: 2,
                      status: 'answered',
                      outcome: {
                        kind: 'form_answer',
                        action: 'accept',
                        values: { version: 'v2' },
                        committedAt: 76,
                      },
                    }
                  : {
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

  async loadTranscriptOverlay<T>(_decodeMessage: (value: unknown) => T): Promise<T[]> {
    return [];
  }

  async decodeTranscriptPage(): Promise<never> {
    throw new Error('Fake subscription does not expose transcript pages');
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
    schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
    session: {
      sessionId: 'session-1',
      metadataRevision: 1,
      status: 'running',
      createdAt: 1,
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

function goalProjection(overrides: Partial<GoalProjection> = {}): GoalProjection {
  return {
    goalId: 'goal-1',
    revision: 1,
    sessionId: 'session-id',
    condition: 'Ship the feature',
    status: 'active',
    setAt: 1,
    iterations: 2,
    maxIterations: 50,
    consecutiveNoProgress: 0,
    blockCap: 8,
    tokenBudget: 100_000,
    tokensSpent: 12_000,
    lastReason: null,
    achievedAt: null,
    pausedAt: null,
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
    activityAt: 2,
    name: 'Session',
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionId: 'connection-1',
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

function userMessage(turnId: string, text: string): Extract<StoredMessage, { type: 'user' }> {
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

function textCompleteFrame(
  sequence: number,
  turnId: string,
  startOffset: number,
  text: string,
  subscriptionId = 'subscription-1',
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
      runId: 'run-1',
      messageId: `message-${turnId}`,
      startOffset,
      text,
      complete: true,
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

function pendingForm() {
  return {
    schemaVersion: 1 as const,
    interactionId: 'form-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    runId: 'run-1',
    revision: 1 as const,
    status: 'pending' as const,
    outcome: null,
    request: {
      kind: 'form' as const,
      toolUseId: 'tool-form',
      message: 'Configure deployment',
      requester: { name: 'deploy', source: 'Acme MCP' },
      fields: [{ kind: 'string' as const, name: 'version', label: 'Version', required: true }],
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
async function waitFor(predicate: () => boolean): Promise<void> {
  await pollFor(predicate, {
    timeoutMs: WAIT_BUDGET_MS,
    message: 'Timed out waiting for fake Host state',
  });
}

describe('turn consumer lag recovery (#3180)', () => {
  async function floodTurnStream(
    subscription: InstanceType<typeof FakeSubscription>,
    count: number,
    startOffset: number,
    subscriptionId = 'subscription-1',
  ): Promise<void> {
    let offset = startOffset;
    for (let index = 0; index < count; index += 1) {
      const text = `x${String(index).padStart(4, '0')}`;
      subscription.push(deltaFrame(index + 1, 'turn-1', offset, text, subscriptionId));
      offset += text.length;
      if (index % 64 === 63) await delay(0);
    }
    await delay(0);
  }

  async function floodToolStream(
    subscription: InstanceType<typeof FakeSubscription>,
    count: number,
    subscriptionId = 'subscription-1',
    startSequence = 1,
  ): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      subscription.push(
        toolStartFrame(startSequence + index, startSequence + index, subscriptionId),
      );
      if (index % 64 === 63) await delay(0);
    }
    await delay(0);
  }

  async function floodToolOutput(
    subscription: InstanceType<typeof FakeSubscription>,
    count: number,
    subscriptionId = 'subscription-1',
    startSequence = 1,
  ): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      subscription.push(
        toolOutputDeltaFrame(startSequence + index, startSequence + index, subscriptionId),
      );
      if (index % 64 === 63) await delay(0);
    }
    await delay(0);
  }

  async function waitForSubscriptions(connection: FakeConnection, count: number): Promise<void> {
    const deadline = Date.now() + WAIT_BUDGET_MS;
    while (connection.openedSubscriptions !== count && Date.now() < deadline) await delay(5);
    assert.equal(connection.openedSubscriptions, count);
  }

  function lagRecoveryFixture() {
    const initial = new FakeSubscription(
      continuitySnapshot(),
      Promise.resolve([assistantMessage('turn-1', 'Hello')]),
    );
    const replacement = new FakeSubscription(
      continuitySnapshot({ projectionRevision: 2 }),
      Promise.resolve([assistantMessage('turn-1', 'Hello')]),
      'subscription-2',
    );
    const connection = new FakeConnection([initial, replacement], true);
    const resynced = deferred<void>();
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      now: () => 50,
    });
    driver.subscribeTranscriptReplacements!((_sessionId, _turnId, _messages, reason) => {
      if (reason === 'reconnect') resynced.resolve();
    });
    return { initial, replacement, connection, driver, resynced };
  }

  async function drainUntilDone(events: AsyncIterable<unknown>): Promise<boolean> {
    const iterator = events[Symbol.asyncIterator]();
    let completed = false;
    for (let index = 0; index < 1_200; index += 1) {
      const result = await iterator.next();
      if (result.done) return completed;
      if ((result.value as { type?: string }).type === 'complete') completed = true;
    }
    return false;
  }

  test('resubscribes instead of failing when a turn event consumer falls behind', async () => {
    const { initial, replacement, connection, driver, resynced } = lagRecoveryFixture();
    const switched = await driver.switchSession('session-1');
    assert.ok(switched.activeTurn);

    // Flood the unconsumed turn stream past its 1024-event bound.
    await floodTurnStream(initial, 1_100, 5);

    // The channel retires the lagged subscription, resubscribes, and compacts
    // the sheddable backlog the canonical resync supersedes.
    await waitForSubscriptions(connection, 2);
    await resynced.promise;

    // The stream never rejected, and live events land right away.
    replacement.push(deltaFrame(1, 'turn-1', 5, ' world', 'subscription-2'));
    assert.equal((await nextEvent(switched.activeTurn.events)).text, ' world');
  });

  test('lands terminal events while shedding deltas from a lagging consumer', async () => {
    const { initial, replacement, connection, driver, resynced } = lagRecoveryFixture();
    const switched = await driver.switchSession('session-1');
    assert.ok(switched.activeTurn);

    await floodTurnStream(initial, 1_100, 5);
    await waitForSubscriptions(connection, 2);
    await resynced.promise;

    await floodTurnStream(replacement, 1_024, 5, 'subscription-2');
    replacement.push(projectionFrame(1_025, completedTurn('turn-1', 'run-1'), 2, 'subscription-2'));
    await delay(0);
    assert.ok(
      await drainUntilDone(switched.activeTurn.events),
      'terminal complete event survived the lagged delta backlog',
    );
  });

  test('admits a terminal outcome when the lagged backlog holds no deltas', async () => {
    const { initial, replacement, connection, driver, resynced } = lagRecoveryFixture();
    const switched = await driver.switchSession('session-1');
    assert.ok(switched.activeTurn);

    // Fill the bound with non-delta events: nothing sheddable to evict.
    await floodToolStream(initial, 1_100);
    await waitForSubscriptions(connection, 2);
    await resynced.promise;

    await floodToolStream(replacement, 1_024, 'subscription-2');
    // The terminal outcome must land even though no delta can be evicted;
    // process the frame before draining so the backlog is still full.
    replacement.push(projectionFrame(1_025, completedTurn('turn-1', 'run-1'), 2, 'subscription-2'));
    await delay(0);
    assert.ok(
      await drainUntilDone(switched.activeTurn.events),
      'terminal complete event was admitted over a non-delta backlog',
    );
  });

  test('admits assistant completion before the terminal outcome over a non-delta backlog', async () => {
    const { initial, replacement, connection, driver, resynced } = lagRecoveryFixture();
    const switched = await driver.switchSession('session-1');
    assert.ok(switched.activeTurn);

    await floodToolStream(initial, 1_100);
    await waitForSubscriptions(connection, 2);
    await resynced.promise;

    await floodToolStream(replacement, 1_024, 'subscription-2');
    replacement.push(textCompleteFrame(1_025, 'turn-1', 5, ' final answer', 'subscription-2'));
    replacement.push(projectionFrame(1_026, completedTurn('turn-1', 'run-1'), 2, 'subscription-2'));
    await delay(0);

    let finalOutput: string | undefined;
    let completed = false;
    for await (const event of switched.activeTurn.events) {
      if (event.type === 'text_complete') finalOutput = event.text;
      if (event.type === 'complete') completed = true;
    }
    assert.equal(finalOutput, 'Hello final answer');
    assert.equal(completed, true);
  });

  test('drops the entire pre-resync tool backlog at the canonical cut', async () => {
    const { initial, replacement, connection, driver, resynced } = lagRecoveryFixture();
    const switched = await driver.switchSession('session-1');
    assert.ok(switched.activeTurn);

    await floodToolStream(initial, 1_100);
    await waitForSubscriptions(connection, 2);
    await resynced.promise;

    replacement.push(toolStartFrame(1, 9_000, 'subscription-2'));
    replacement.push(projectionFrame(2, completedTurn('turn-1', 'run-1'), 2, 'subscription-2'));
    await delay(0);

    const iterator = switched.activeTurn.events[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.done, false);
    assert.equal(first.value.type, 'tool_start');
    if (first.value.type === 'tool_start') assert.equal(first.value.toolUseId, 'tool-9000');
  });

  test('admits a tool result when the lagged backlog holds no deltas', async () => {
    const { initial, replacement, connection, driver, resynced } = lagRecoveryFixture();
    const switched = await driver.switchSession('session-1');
    assert.ok(switched.activeTurn);

    // Fill the bound with non-delta events: nothing sheddable to evict.
    await floodToolStream(initial, 1_100);
    await waitForSubscriptions(connection, 2);
    await resynced.promise;

    await floodToolStream(replacement, 1_024, 'subscription-2');
    // The tool result is the authoritative terminal outcome for its tool and
    // must land even though no delta can be evicted; otherwise the live tool
    // card stays running until the durable transcript heals it.
    replacement.push(toolResultFrame(1_025, 'subscription-2'));
    replacement.push(projectionFrame(1_026, completedTurn('turn-1', 'run-1'), 2, 'subscription-2'));
    await delay(0);

    let sawToolResult = false;
    const iterator = switched.activeTurn.events[Symbol.asyncIterator]();
    for (let index = 0; index < 1_200; index += 1) {
      const result = await iterator.next();
      if (result.done) break;
      if ((result.value as { type?: string }).type === 'tool_result') sawToolResult = true;
    }
    assert.ok(sawToolResult, 'tool_result was admitted over a non-delta backlog');
  });

  test('sheds lagged tool output deltas so the tool result and terminal outcome land', async () => {
    const { initial, replacement, connection, driver, resynced } = lagRecoveryFixture();
    const switched = await driver.switchSession('session-1');
    assert.ok(switched.activeTurn);

    // A noisy tool floods the unconsumed stream with seq-ordered output
    // deltas, the realistic way a consumer falls behind.
    await floodToolOutput(initial, 1_100);
    await waitForSubscriptions(connection, 2);
    await resynced.promise;

    await floodToolOutput(replacement, 1_024, 'subscription-2');
    // The canonical resync compacts the unseen tool deltas, so the tool
    // result lands instead of being dropped behind a full non-delta backlog
    // (which would leave the live card stuck at "running" until the durable
    // transcript heals it).
    replacement.push(toolResultFrame(1_025, 'subscription-2'));
    replacement.push(projectionFrame(1_026, completedTurn('turn-1', 'run-1'), 2, 'subscription-2'));
    await delay(0);

    let sawToolResult = false;
    const iterator = switched.activeTurn.events[Symbol.asyncIterator]();
    for (let index = 0; index < 1_200; index += 1) {
      const result = await iterator.next();
      if (result.done) break;
      if ((result.value as { type?: string }).type === 'tool_result') sawToolResult = true;
      if ((result.value as { type?: string }).type === 'complete') {
        assert.ok(sawToolResult, 'tool_result landed ahead of the terminal outcome');
        return;
      }
    }
    assert.fail('stream ended without the terminal complete event');
  });

  test('resubscribes when the live stream ends without a terminal close', async () => {
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
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      now: () => 50,
    });
    const switched = await driver.switchSession('session-1');
    assert.ok(switched.activeTurn);
    const transcript = deferred<readonly StoredMessage[]>();
    driver.subscribeTranscriptReplacements!((_sessionId, _turnId, messages, reason) => {
      assert.equal(reason, 'reconnect');
      transcript.resolve(messages);
    });

    // A clean iterator end with no subscription.closed frame — e.g. the Host
    // evicted the subscription as a slow consumer while the channel was still
    // buffering the catch-up transcript — used to fail the channel
    // permanently. It must resubscribe and continue the live stream instead.
    await initial.close();
    assert.deepEqual(await transcript.promise, [assistantMessage('turn-1', 'Hello world')]);
    assert.equal(connection.openedSubscriptions, 2);
    replacement.push(deltaFrame(1, 'turn-1', 11, '!', 'subscription-2'));
    assert.equal((await nextEvent(switched.activeTurn.events)).text, '!');
  });

  test('recovers when slow-consumer closure is buffered during initial hydration', async () => {
    const transcript = deferred<StoredMessage[]>();
    const initial = new FakeSubscription(continuitySnapshot(), transcript.promise);
    const replacement = new FakeSubscription(
      continuitySnapshot({ projectionRevision: 2 }),
      Promise.resolve([assistantMessage('turn-1', 'Hello world')]),
      'subscription-2',
    );
    const connection = new FakeConnection([initial, replacement], true);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      now: () => 50,
    });

    const switching = driver.switchSession('session-1');
    await waitFor(() => initial.nextCalls === 1);
    initial.push({
      kind: 'subscription.closed',
      hostEpoch: 'host-1',
      subscriptionId: 'subscription-1',
      sequence: 1,
      reason: 'slow_consumer',
    });
    await waitFor(() => initial.nextCalls === 2);
    transcript.resolve([assistantMessage('turn-1', 'Hello')]);

    const switched = await switching;
    assert.ok(switched.activeTurn);
    assert.equal(connection.openedSubscriptions, 2);
    replacement.push(deltaFrame(1, 'turn-1', 11, '!', 'subscription-2'));
    assert.equal((await nextEvent(switched.activeTurn.events)).text, '!');
  });

  test('backs off several immediate clean-EOF replacements before recovering', async () => {
    const initial = new FakeSubscription(
      continuitySnapshot(),
      Promise.resolve([assistantMessage('turn-1', 'Hello')]),
    );
    const ended = [2, 3, 4].map(
      (index) =>
        new FakeSubscription(
          continuitySnapshot({ projectionRevision: index }),
          Promise.resolve([assistantMessage('turn-1', 'Hello')]),
          `subscription-${index}`,
        ),
    );
    for (const subscription of ended) await subscription.close();
    const stable = new FakeSubscription(
      continuitySnapshot({ projectionRevision: 5 }),
      Promise.resolve([assistantMessage('turn-1', 'Hello world')]),
      'subscription-5',
    );
    const connection = new FakeConnection([initial, ...ended, stable], true);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      now: () => 50,
    });
    const switched = await driver.switchSession('session-1');
    assert.ok(switched.activeTurn);
    const resynced = deferred<void>();
    driver.subscribeTranscriptReplacements!((_sessionId, _turnId, _messages, reason) => {
      if (reason === 'reconnect') resynced.resolve();
    });

    await initial.close();
    await waitForSubscriptions(connection, 2);
    await delay(5);
    assert.equal(connection.openedSubscriptions, 2, 'the first repeated EOF is backoff-gated');

    await resynced.promise;
    assert.equal(connection.openedSubscriptions, 5);
    stable.push(deltaFrame(1, 'turn-1', 11, '!', 'subscription-5'));
    assert.equal((await nextEvent(switched.activeTurn.events)).text, '!');
  });

  for (const [name, replacementRoot] of [
    ['the same terminal turn', completedTurn('turn-1', 'run-1')],
    ['a successor turn', runningTurn('turn-2', 'run-2')],
  ] as const) {
    test(`preserves an unconsumed terminal event across a replacement with ${name}`, async () => {
      const initial = new FakeSubscription(
        continuitySnapshot(),
        Promise.resolve([assistantMessage('turn-1', 'Hello')]),
      );
      const replacement = new FakeSubscription(
        continuitySnapshot({ projectionRevision: 3, rootTurn: replacementRoot }),
        Promise.resolve([
          assistantMessage('turn-1', 'Hello'),
          turnStateMessage('turn-1', 'completed'),
          ...(replacementRoot.turnId === 'turn-2' ? [userMessage('turn-2', 'Continue')] : []),
        ]),
        'subscription-2',
      );
      const connection = new FakeConnection([initial, replacement], true);
      const driver = createRuntimeHostMakaSessionDriver({
        connection: connection.value,
        cwd: '/tmp',
        llmConnectionId: 'connection-1',
        llmConnectionSlug: 'openai-main',
        model: 'gpt-5',
        now: () => 50,
      });
      const switched = await driver.switchSession('session-1');
      assert.ok(switched.activeTurn);

      initial.push(projectionFrame(1, completedTurn('turn-1', 'run-1'), 2));
      await delay(0);
      initial.fail(new RuntimeHostSubscriptionError('connection_closed', 'connection lost'));
      await waitForSubscriptions(connection, 2);

      assert.equal((await nextEvent(switched.activeTurn.events)).type, 'complete');
      assert.equal((await switched.activeTurn.events[Symbol.asyncIterator]().next()).done, true);
    });
  }

  test('exhausts recovery after repeated one-frame clean-EOF replacements', async () => {
    const initial = new FakeSubscription(
      continuitySnapshot(),
      Promise.resolve([assistantMessage('turn-1', 'Hello')]),
    );
    const ended = Array.from({ length: 8 }, (_, index) => {
      const subscription = new FakeSubscription(
        continuitySnapshot({ projectionRevision: index + 2 }),
        Promise.resolve([assistantMessage('turn-1', 'Hello')]),
        `subscription-${index + 2}`,
      );
      subscription.push(deltaFrame(1, 'turn-1', 5, String(index), `subscription-${index + 2}`));
      return subscription;
    });
    for (const subscription of ended) await subscription.close();
    const connection = new FakeConnection([initial, ...ended], true);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      now: () => 50,
    });
    const switched = await driver.switchSession('session-1');
    assert.ok(switched.activeTurn);

    await initial.close();
    await assert.rejects(async () => {
      for await (const _event of switched.activeTurn!.events) {
        // Drain each replacement's single live frame until recovery fails.
      }
    }, /recovery exhausted its retry budget/u);
    assert.equal(connection.openedSubscriptions, 9);
  });

  test('does not reset recovery after a silent replacement outlives the stability window', async () => {
    const initial = new FakeSubscription(
      continuitySnapshot(),
      Promise.resolve([assistantMessage('turn-1', 'Hello')]),
    );
    const silent = new FakeSubscription(
      continuitySnapshot({ projectionRevision: 2 }),
      Promise.resolve([assistantMessage('turn-1', 'Hello')]),
      'subscription-2',
    );
    const ended = Array.from({ length: 7 }, (_, index) => {
      const subscription = new FakeSubscription(
        continuitySnapshot({ projectionRevision: index + 3 }),
        Promise.resolve([assistantMessage('turn-1', 'Hello')]),
        `subscription-${index + 3}`,
      );
      void subscription.close();
      return subscription;
    });
    const connection = new FakeConnection([initial, silent, ...ended], true);
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      now: () => 50,
    });
    const switched = await driver.switchSession('session-1');
    assert.ok(switched.activeTurn);

    await initial.close();
    await waitForSubscriptions(connection, 2);
    await delay(1_100);
    await silent.close();

    await assert.rejects(async () => {
      for await (const _event of switched.activeTurn!.events) {
        // A silent hydrated subscription is not evidence of live stability.
      }
    }, /recovery exhausted its retry budget/u);
    assert.equal(connection.openedSubscriptions, 9);
  });

  test('re-arms lag detection exactly at the hysteresis watermark', async () => {
    const initial = new FakeSubscription(
      continuitySnapshot(),
      Promise.resolve([assistantMessage('turn-1', 'Hello')]),
    );
    const second = new FakeSubscription(
      continuitySnapshot({ projectionRevision: 2 }),
      Promise.resolve([assistantMessage('turn-1', 'Hello')]),
      'subscription-2',
    );
    const third = new FakeSubscription(
      continuitySnapshot({ projectionRevision: 3 }),
      Promise.resolve([assistantMessage('turn-1', 'Hello')]),
      'subscription-3',
    );
    const connection = new FakeConnection([initial, second, third], true);
    let resyncs = 0;
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      now: () => 50,
    });
    driver.subscribeTranscriptReplacements!((_sessionId, _turnId, _messages, reason) => {
      if (reason === 'reconnect') resyncs += 1;
    });
    const switched = await driver.switchSession('session-1');
    assert.ok(switched.activeTurn);

    // Latch the lag flag with a non-delta backlog. The canonical cut clears
    // every pre-cut event, then a still-wedged consumer fills again without
    // triggering a resubscribe loop.
    await floodToolStream(initial, 1_100);
    await waitForSubscriptions(connection, 2);
    await waitFor(() => resyncs === 1);
    await floodToolStream(second, 1_100, 'subscription-2', 1);
    await delay(20);
    assert.equal(connection.openedSubscriptions, 2, 'the post-cut lag latch stayed armed');

    // Draining to one event above the watermark (513 pending) must NOT
    // re-arm: a fresh overflow on the still-latched queue is the same lag
    // episode and triggers no new recovery. The flood refills the backlog
    // to the bound.
    const iterator = switched.activeTurn.events[Symbol.asyncIterator]();
    for (let index = 0; index < 511; index += 1) {
      assert.equal((await iterator.next()).done, false);
    }
    await floodToolStream(second, 600, 'subscription-2', 1_101);
    await delay(20);
    assert.equal(connection.openedSubscriptions, 2, 'lag latch held above the watermark');

    // Draining the refilled backlog down to the watermark (512 pending)
    // re-arms: the next overflow is a new lag episode and resubscribes again.
    for (let index = 0; index < 512; index += 1) {
      assert.equal((await iterator.next()).done, false);
    }
    await floodToolStream(second, 600, 'subscription-2', 1_701);
    await waitForSubscriptions(connection, 3);
    await waitFor(() => resyncs === 2);
  });

  test('recovers again when the consumer lags again after making progress', async () => {
    const initial = new FakeSubscription(
      continuitySnapshot(),
      Promise.resolve([assistantMessage('turn-1', 'Hello')]),
    );
    const second = new FakeSubscription(
      continuitySnapshot({ projectionRevision: 2 }),
      Promise.resolve([assistantMessage('turn-1', 'Hello')]),
      'subscription-2',
    );
    const third = new FakeSubscription(
      continuitySnapshot({ projectionRevision: 3 }),
      Promise.resolve([assistantMessage('turn-1', 'Hello')]),
      'subscription-3',
    );
    const connection = new FakeConnection([initial, second, third], true);
    let resyncs = 0;
    const driver = createRuntimeHostMakaSessionDriver({
      connection: connection.value,
      cwd: '/tmp',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      now: () => 50,
    });
    driver.subscribeTranscriptReplacements!((_sessionId, _turnId, _messages, reason) => {
      if (reason === 'reconnect') resyncs += 1;
    });
    const switched = await driver.switchSession('session-1');
    assert.ok(switched.activeTurn);

    // First lag episode over a non-delta backlog. The canonical cut clears the
    // retired subscription's events; a still-wedged consumer can fill again
    // without immediately looping recovery.
    await floodToolStream(initial, 1_100);
    await waitForSubscriptions(connection, 2);
    await waitFor(() => resyncs === 1);
    await floodToolStream(second, 1_100, 'subscription-2', 1);

    // The consumer drains past the hysteresis watermark, re-arming lag
    // detection, and fresh output flows again. One hundred events stay queued
    // behind the delta, so the backlog never empties.
    const iterator = switched.activeTurn.events[Symbol.asyncIterator]();
    for (let index = 0; index < 600; index += 1) {
      const result = await iterator.next();
      assert.equal(result.done, false);
    }
    second.push(deltaFrame(1_101, 'turn-1', 5, ' world', 'subscription-2'));
    for (let index = 0; index < 100; index += 1) {
      second.push(toolStartFrame(1_102 + index, 2_000 + index, 'subscription-2'));
    }
    await delay(0);
    let fresh = '';
    for (let index = 0; index < 425; index += 1) {
      const result = await iterator.next();
      assert.equal(result.done, false);
      fresh = (result.value as { text?: string }).text ?? '';
    }
    assert.equal(fresh, ' world');

    // A second lag episode is a new episode, not a dead latch: it triggers a
    // fresh canonical resync. The stream stays contiguous on `second`.
    await floodToolStream(second, 1_100, 'subscription-2', 1_202);
    await waitForSubscriptions(connection, 3);
    await waitFor(() => resyncs === 2);

    third.push(projectionFrame(1, completedTurn('turn-1', 'run-1'), 3, 'subscription-3'));
    await delay(0);
    assert.ok(
      await drainUntilDone(switched.activeTurn.events),
      'stream still completes after repeated lag recoveries',
    );
  });
});

function toolStartFrame(
  sequence: number,
  index: number,
  subscriptionId = 'subscription-1',
): SubscriptionFrame {
  return {
    kind: 'subscription.session_event',
    hostEpoch: 'host-1',
    subscriptionId,
    sequence,
    sessionId: 'session-1',
    runId: 'run-1',
    event: {
      type: 'tool_start',
      id: `tool-${index}`,
      turnId: 'turn-1',
      ts: 10,
      toolUseId: `tool-${index}`,
      toolName: 'Bash',
    },
  };
}

function toolOutputDeltaFrame(
  sequence: number,
  seq: number,
  subscriptionId = 'subscription-1',
): SubscriptionFrame {
  return {
    kind: 'subscription.session_event',
    hostEpoch: 'host-1',
    subscriptionId,
    sequence,
    sessionId: 'session-1',
    runId: 'run-1',
    event: {
      type: 'tool_output_delta',
      id: `output-${seq}`,
      turnId: 'turn-1',
      ts: 10,
      toolUseId: 'tool-1',
      seq,
      stream: 'stdout',
      chunk: `chunk-${seq}`,
      redacted: false,
      createdAt: 10,
    },
  };
}

function toolResultFrame(sequence: number, subscriptionId = 'subscription-1'): SubscriptionFrame {
  return {
    kind: 'subscription.session_event',
    hostEpoch: 'host-1',
    subscriptionId,
    sequence,
    sessionId: 'session-1',
    runId: 'run-1',
    event: {
      type: 'tool_result',
      id: 'result-tool-1',
      turnId: 'turn-1',
      ts: 11,
      toolUseId: 'tool-1',
      status: 'completed',
    },
  };
}
