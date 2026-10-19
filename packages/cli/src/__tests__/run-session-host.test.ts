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

import assert from 'node:assert/strict';
import type { BackendSendInput } from '@maka/core/backend-types';
import type { SessionEvent } from '@maka/core/events';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import {
  FakeBackend,
  FAKE_ASK_USER_QUESTION_PROMPT,
  FAKE_ASK_SANDBOX_BOUNDARY_PROMPT,
  FAKE_WAIT_FOR_STEERING_PROMPT,
  FAKE_ERROR_PROMPT_PREFIX,
} from '@maka/runtime/test-only/fake-backend';
import { startExecutionRuntimeHostService } from '@maka/runtime-host/server';
import { runMakaSessionCommand } from '../run-session-command.js';
import { updateRuntimeHostSession } from '../runtime-host-session-update.js';
import { RunSessionInterrupted } from '../run-session-result.js';
import { randomUUID } from 'node:crypto';
import { connectRuntimeHost } from '@maka/runtime-host/client';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '@maka/runtime-host/protocol';

const children = new Set<ChildProcess>();

const fixturePath = fileURLToPath(new URL('./run-session-process-fixture.js', import.meta.url));

test('real Host keeps AskUser alive across CLI processes and returns the original Turn result', {
  timeout: 120_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-run-session-'));
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  let sessionId: string;
  try {
    sessionId = (
      await stores.sessionStore.create({
        cwd: root,
        llmConnectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      })
    ).id;
  } finally {
    await stores.sessionStore.close?.();
    await owner.close();
  }
  const { createExecutionRuntimeHostComposition } = await import(
    new URL('./execution-composition.js', import.meta.resolve('@maka/runtime-host/server')).href
  );
  const host = await startExecutionRuntimeHostService(
    { rootPath: root },
    {
      createComposition: (context, options) =>
        createExecutionRuntimeHostComposition(
          context,
          { ...options, bootstrapRuntimePolicy: false },
          {
            primaryBackendFactory: (backendContext: ConstructorParameters<typeof FakeBackend>[0]) =>
              new RecoveryBackend(backendContext),
            generateSessionTitle: async () => undefined,
          },
        ),
    },
  );
  try {
    const asked = await cli(root, '--session', sessionId, FAKE_ASK_USER_QUESTION_PROMPT, '--json');
    assert.equal(asked.code, 0, asked.stderr);
    const question = JSON.parse(asked.stdout);
    assert.equal(question.status, 'needs_input');
    assert.ok(question.questions.length > 0);
    const connected = await connectRuntimeHost({
      rootPath: root,
      protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    });
    assert.equal(connected.kind, 'connected');
    const probe = connected.connection;
    const subscription = await probe.openSessionSubscription({
      sessionId,
      transcript: { kind: 'none' },
    });
    await subscription.ready();
    const original = subscription.snapshot.rootTurn!;
    assert.ok(original.status === 'running' || original.status === 'waiting_for_user');
    const answers = question.questions.map(
      (q: { options: Array<{ label: string }> }) => q.options[0]!.label,
    );
    const status = await cli(root, '--session', sessionId, '--status');
    assert.equal(JSON.parse(status.stdout).status, 'needs_input');
    const answered = await cli(
      root,
      '--session',
      sessionId,
      '--answer',
      JSON.stringify(answers),
      '--json',
    );
    assert.equal(answered.code, 0, answered.stderr);
    assert.equal(JSON.parse(answered.stdout).status, 'completed');
    assert.match(JSON.parse(answered.stdout).finalOutput, /Fake question answers:/);
    const terminal = await probe.request('turn.query', { sessionId, turnId: original.turnId });
    assert.equal(terminal.status, 'completed');
    assert.equal(terminal.runId, original.runId);
    const result = await cli(root, '--session', sessionId, '--result', '--json');
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), JSON.parse(answered.stdout));
    // Assistant Inbox admission is not a queued worker Turn. Never wait for an
    // execution identity or return the previous Turn's answer for this message.
    let inboxAdmissions = 0;
    const inboxConnection = new Proxy(probe, {
      get(target, key) {
        if (key === 'request')
          return async (...args: Parameters<typeof probe.request>) => {
            if (args[0] === 'turn.message.submit') {
              inboxAdmissions++;
              return {
                disposition: 'inbox',
                skillInvocation: { loaded: [], failed: [], receipts: [] },
              };
            }
            if (args[0] === 'turn.message.execution.query' || args[0] === 'turn.query')
              throw new Error('Inbox admission must not wait for a worker Turn');
            return Reflect.apply(probe.request, probe, args);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    for (const noWait of [true, false]) {
      const receipt = await runMakaSessionCommand(
        inboxConnection,
        {
          sessionId,
          stdinPrompt: false,
          prompt: 'Inbox input',
          ...(noWait ? { noWait: true as const } : { wait: true as const }),
        },
        { onSigint: () => () => {}, newId: randomUUID },
      );
      assert.equal(receipt.submission, 'inbox');
      assert.equal(receipt.finalOutput, undefined);
      assert.equal(receipt.queued, undefined);
    }
    assert.equal(inboxAdmissions, 2);
    const duplicate = await cli(root, '--session', sessionId, '--answer', JSON.stringify(answers));
    assert.equal(duplicate.code, 1);
    assert.match(duplicate.stderr, /found 0/);
    // Rejected commands must not elevate the saved Session permissions.
    const originalBoundary = await probe.request('session.execution_boundary.query', { sessionId });
    const invalidAnswer = await cli(
      root,
      '--session',
      sessionId,
      '--answer',
      JSON.stringify(answers),
      '--yolo',
    );
    assert.equal(invalidAnswer.code, 1);
    assert.deepEqual(
      await probe.request('session.execution_boundary.query', { sessionId }),
      originalBoundary,
    );
    // Ctrl+C while a read is in flight must not admit a new message afterward.
    let interrupt: (() => void) | undefined;
    let interruptedAdmissions = 0;
    const interruptedConnection = new Proxy(probe, {
      get(target, key) {
        if (key === 'request')
          return async (...args: Parameters<typeof probe.request>) => {
            const value = await Reflect.apply(probe.request, probe, args);
            if (args[0] === 'session.execution_boundary.query') interrupt?.();
            if (args[0] === 'turn.message.submit') interruptedAdmissions++;
            return value;
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await assert.rejects(
      () =>
        runMakaSessionCommand(
          interruptedConnection,
          {
            sessionId,
            stdinPrompt: false,
            prompt: 'must-not-be-admitted',
            noWait: true,
          },
          {
            onSigint: (handler) => {
              interrupt = handler;
              return () => {
                interrupt = undefined;
              };
            },
            newId: randomUUID,
          },
        ),
      RunSessionInterrupted,
    );
    assert.equal(interruptedAdmissions, 0);
    // Keep the next Turn parked while two independent CLI messages are admitted.
    const askedAgain = await cli(
      root,
      '--session',
      sessionId,
      FAKE_ASK_USER_QUESTION_PROMPT,
      '--json',
    );
    assert.equal(askedAgain.code, 0, askedAgain.stderr);
    const wrongAnswerCount = await cli(
      root,
      '--session',
      sessionId,
      '--answer',
      JSON.stringify([...answers, 'extra']),
      '--yolo',
    );
    assert.equal(wrongAnswerCount.code, 1);
    assert.deepEqual(
      await probe.request('session.execution_boundary.query', { sessionId }),
      originalBoundary,
    );
    const activeStepCap = await cli(
      root,
      '--session',
      sessionId,
      'invalid-step-cap',
      '--max-steps',
      '1',
      '--yolo',
    );
    assert.equal(activeStepCap.code, 1);
    assert.deepEqual(
      await probe.request('session.execution_boundary.query', { sessionId }),
      originalBoundary,
    );
    const invalidResume = await cli(root, '--session', sessionId, '--resume', '--yolo');
    assert.equal(invalidResume.code, 1);
    assert.deepEqual(
      await probe.request('session.execution_boundary.query', { sessionId }),
      originalBoundary,
    );
    const queuedFirst = await cli(root, '--session', sessionId, 'queued-first', '--no-wait');
    assert.equal(queuedFirst.code, 0, queuedFirst.stderr);
    const queuedReceipt = JSON.parse(queuedFirst.stdout);
    assert.equal(queuedReceipt.submission, 'queued');
    assert.equal(queuedReceipt.status, 'needs_input');
    assert.ok(queuedReceipt.questions.length > 0);
    const queuedSecond = cli(root, '--session', sessionId, 'queued-second', '--wait', '--json');
    let admitted = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const current = await cli(root, '--session', sessionId, '--status');
      if (JSON.parse(current.stdout).queued >= 2) {
        admitted = true;
        break;
      }
    }
    assert.equal(admitted, true, 'both explicit follow-ups must be queued before answering');
    const waitingCurrent = await cli(root, '--session', sessionId, '--wait');
    assert.equal(JSON.parse(waitingCurrent.stdout).status, 'needs_input');
    const answeredAgain = await cli(
      root,
      '--session',
      sessionId,
      '--answer',
      JSON.stringify(answers),
      '--json',
    );
    assert.equal(answeredAgain.code, 0, answeredAgain.stderr);
    assert.match(JSON.parse(answeredAgain.stdout).finalOutput, /Fake question answers:/);
    const secondResult = await queuedSecond;
    assert.equal(secondResult.code, 0, secondResult.stderr);
    assert.match(JSON.parse(secondResult.stdout).finalOutput, /queued-second/);
    const turns = await probe.request('session.turns.query', {
      sessionId,
      throughSequence: null,
      position: 0,
      maxContributions: 128,
    });
    const first = turns.contributions.find((t) => t.userPromptPreview === 'queued-first');
    const second = turns.contributions.find((t) => t.userPromptPreview === 'queued-second');
    assert.ok(first);
    assert.ok(second);
    assert.notEqual(first.turnId, second.turnId);
    const awaitingSteer = await cli(
      root,
      '--session',
      sessionId,
      FAKE_WAIT_FOR_STEERING_PROMPT,
      '--no-wait',
    );
    assert.equal(awaitingSteer.code, 0, awaitingSteer.stderr);
    const steered = await cli(
      root,
      '--session',
      sessionId,
      'steer-this-turn',
      '--steer',
      '--wait',
      '--json',
    );
    assert.equal(steered.code, 0, steered.stderr);
    assert.match(JSON.parse(steered.stdout).finalOutput, /Acknowledged steering: steer-this-turn/);
    const failed = await cli(
      root,
      '--session',
      sessionId,
      `${FAKE_ERROR_PROMPT_PREFIX}rate_limit`,
      '--json',
    );
    assert.equal(failed.code, 1);
    assert.match(JSON.parse(failed.stdout).error, /Deterministic rate_limit failure/);
    const failedResult = await cli(root, '--session', sessionId, '--result', '--json');
    assert.equal(failedResult.code, 1);
    assert.match(JSON.parse(failedResult.stdout).error, /Deterministic rate_limit failure/);
    const failedStatus = await cli(root, '--session', sessionId, '--status', '--json');
    assert.equal(failedStatus.code, 0, failedStatus.stderr);
    assert.equal(JSON.parse(failedStatus.stdout).status, 'failed');
    // A detached non-bypass Turn can request a boundary after its launcher exits.
    const detachedBoundary = await cli(
      root,
      '--session',
      sessionId,
      FAKE_ASK_SANDBOX_BOUNDARY_PROMPT,
      '--no-wait',
    );
    assert.equal(detachedBoundary.code, 0, detachedBoundary.stderr);
    const blocked = await cli(root, '--session', sessionId, '--wait', '--json');
    assert.equal(blocked.code, 0, blocked.stderr);
    const approval = JSON.parse(blocked.stdout);
    assert.equal(approval.status, 'needs_approval');
    assert.deepEqual(approval.approvalRequests, [
      {
        kind: 'sandbox_boundary',
        expansion: { network: { enabled: true } },
        justification: 'Connect to the deterministic fake test endpoint.',
      },
    ]);
    assert.deepEqual(Object.keys(approval).sort(), ['approvalRequests', 'sessionId', 'status']);
    const blockedSubscription = await probe.openSessionSubscription({
      sessionId,
      transcript: { kind: 'none' },
    });
    await blockedSubscription.ready();
    const blockedTurn = blockedSubscription.snapshot.rootTurn!;
    assert.ok(
      blockedSubscription.snapshot.interactions.pending.some(
        (p) => p.request.kind === 'sandbox_boundary',
      ),
    );
    await blockedSubscription.close();
    const stopped = await cli(root, '--session', sessionId, '--stop', '--json');
    assert.equal(stopped.code, 0, stopped.stderr);
    const cancelled = await probe.request('turn.query', { sessionId, turnId: blockedTurn.turnId });
    assert.equal(cancelled.status, 'cancelled');
    const afterStop = await cli(
      root,
      '--session',
      sessionId,
      'after-explicit-stop',
      '--wait',
      '--json',
    );
    assert.equal(afterStop.code, 0, afterStop.stderr);
    assert.match(JSON.parse(afterStop.stdout).finalOutput, /after-explicit-stop/);
    // A lost decision response must not cause the CLI to answer the next queued request.
    const uncertainTask = await cli(
      root,
      '--session',
      sessionId,
      FAKE_ASK_SANDBOX_BOUNDARY_PROMPT,
      '--no-wait',
    );
    assert.equal(uncertainTask.code, 0, uncertainTask.stderr);
    const firstPending = await cli(root, '--session', sessionId, '--wait', '--json');
    assert.equal(JSON.parse(firstPending.stdout).status, 'needs_approval');
    const nextPending = await cli(
      root,
      '--session',
      sessionId,
      FAKE_ASK_SANDBOX_BOUNDARY_PROMPT,
      '--queue',
      '--no-wait',
    );
    assert.equal(nextPending.code, 0, nextPending.stderr);
    let uncertainDecisions = 0;
    const lostResponse = new Proxy(probe, {
      get(target, key) {
        if (key === 'request')
          return async (...args: Parameters<typeof probe.request>) => {
            if (args[0] === 'interaction.answer') uncertainDecisions++;
            const result = await Reflect.apply(probe.request, probe, args);
            if (args[0] === 'interaction.answer')
              throw new Error('Decision response lost after Host acceptance');
            return result;
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await assert.rejects(
      () =>
        runMakaSessionCommand(
          lostResponse,
          { sessionId, stdinPrompt: false, sandboxDecision: 'deny' },
          { onSigint: () => () => {}, newId: randomUUID },
        ),
      /response lost/,
    );
    assert.equal(uncertainDecisions, 1);
    const stillPending = await cli(root, '--session', sessionId, '--wait', '--json');
    assert.equal(
      JSON.parse(stillPending.stdout).status,
      'needs_approval',
      'the next request must remain unanswered',
    );
    const stopUncertainFollowup = await cli(root, '--session', sessionId, '--stop', '--json');
    assert.equal(stopUncertainFollowup.code, 0, stopUncertainFollowup.stderr);
    // Each sandbox decision comes from a later CLI process and continues the exact original Run.
    for (const [flag, decision] of [
      ['--deny', 'deny'],
      ['--approve', 'allow'],
    ] as const) {
      const submitted = await cli(
        root,
        '--session',
        sessionId,
        FAKE_ASK_SANDBOX_BOUNDARY_PROMPT,
        '--no-wait',
      );
      assert.equal(submitted.code, 0, submitted.stderr);
      const waiting = await cli(root, '--session', sessionId, '--wait', '--json');
      assert.equal(waiting.code, 0, waiting.stderr);
      assert.equal(JSON.parse(waiting.stdout).status, 'needs_approval');
      const current = await probe.openSessionSubscription({
        sessionId,
        transcript: { kind: 'none' },
      });
      await current.ready();
      const pendingTurn = current.snapshot.rootTurn!;
      await current.close();
      const boundaryBefore = await probe.request('session.execution_boundary.query', { sessionId });
      const observedStatus = await cli(root, '--session', sessionId, '--status', '--json');
      assert.equal(observedStatus.code, 0, observedStatus.stderr);
      assert.equal(JSON.parse(observedStatus.stdout).status, 'needs_approval');
      // Ambiguous pending requests must not dispatch any decision or elevate permissions.
      let decisionRequests = 0;
      const ambiguous = new Proxy(probe, {
        get(target, key) {
          if (key === 'openSessionSubscription')
            return async (...args: Parameters<typeof probe.openSessionSubscription>) => {
              const actual = await probe.openSessionSubscription(...args);
              return new Proxy(actual, {
                get(subscription, property) {
                  if (property === 'snapshot') {
                    const snapshot = subscription.snapshot;
                    const request = snapshot.interactions.pending.find(
                      (p) => p.request.kind === 'sandbox_boundary',
                    )!;
                    return {
                      ...snapshot,
                      interactions: {
                        ...snapshot.interactions,
                        pending: [
                          ...snapshot.interactions.pending,
                          { ...request, interactionId: randomUUID() },
                        ],
                      },
                    };
                  }
                  const value = Reflect.get(subscription, property, subscription);
                  return typeof value === 'function' ? value.bind(subscription) : value;
                },
              });
            };
          if (key === 'request')
            return async (...args: Parameters<typeof probe.request>) => {
              if (args[0] === 'interaction.answer') decisionRequests++;
              return Reflect.apply(probe.request, probe, args);
            };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      await assert.rejects(
        () =>
          runMakaSessionCommand(
            ambiguous,
            { sessionId, stdinPrompt: false, sandboxDecision: decision },
            { onSigint: () => () => {}, newId: randomUUID },
          ),
        /found 2/,
      );
      assert.equal(decisionRequests, 0);
      const decided = await cli(root, '--session', sessionId, flag, '--wait', '--json');
      assert.equal(decided.code, decision === 'allow' ? 0 : 1, decided.stderr);
      assert.equal(
        JSON.parse(decided.stdout).status,
        decision === 'allow' ? 'completed' : 'failed',
        decided.stdout,
      );
      const savedResult = await cli(root, '--session', sessionId, '--result', '--json');
      assert.deepEqual(JSON.parse(savedResult.stdout), JSON.parse(decided.stdout));
      if (decision === 'allow')
        assert.match(
          JSON.parse(decided.stdout).finalOutput,
          new RegExp(`Fake sandbox boundary decision: ${decision}`),
        );
      const resumedTurn = await probe.request('turn.query', {
        sessionId,
        turnId: pendingTurn.turnId,
      });
      assert.equal(resumedTurn.status, 'completed');
      assert.equal(resumedTurn.runId, pendingTurn.runId);
      const boundaryAfter = await probe.request('session.execution_boundary.query', { sessionId });
      assert.equal(boundaryAfter.kind, 'managed', 'approval must not switch the Session to bypass');
      if (decision === 'deny') assert.deepEqual(boundaryAfter, boundaryBefore);
      const duplicateDecision = await cli(root, '--session', sessionId, flag, '--wait', '--json');
      assert.equal(duplicateDecision.code, 1);
      assert.match(duplicateDecision.stderr, /found 0/);
    }
    // Session controls inherit saved full access without another elevation flag or config write.
    await updateRuntimeHostSession(
      probe,
      sessionId,
      (current) =>
        probe.request('session.configuration.update', {
          sessionId,
          expectedRevision: current.revision,
          patch: { permissionMode: 'bypass' },
        }),
      { operation: 'session.configuration.update' },
    );
    const inheritedBoundary = await probe.request('session.execution_boundary.query', {
      sessionId,
    });
    const inheritedAsk = await cli(
      root,
      '--session',
      sessionId,
      FAKE_ASK_USER_QUESTION_PROMPT,
      '--wait',
      '--json',
    );
    assert.equal(inheritedAsk.code, 0, inheritedAsk.stderr);
    assert.equal(JSON.parse(inheritedAsk.stdout).status, 'needs_input');
    const inheritedStatus = await cli(root, '--session', sessionId, '--status', '--json');
    assert.deepEqual(JSON.parse(inheritedStatus.stdout).executionBoundary, inheritedBoundary);
    const inheritedQueue = await cli(
      root,
      '--session',
      sessionId,
      'inherited-followup',
      '--queue',
      '--no-wait',
      '--json',
    );
    assert.equal(inheritedQueue.code, 0, inheritedQueue.stderr);
    const receipt = JSON.parse(inheritedQueue.stdout);
    assert.equal(receipt.submission, 'queued');
    assert.equal(receipt.status, 'needs_input');
    assert.ok(
      receipt.queued === undefined || receipt.queued >= 1,
      'do not publish a stale pre-admission queue count',
    );
    const afterQueueStatus = await cli(root, '--session', sessionId, '--status', '--json');
    assert.equal(JSON.parse(afterQueueStatus.stdout).queued, 1);
    assert.deepEqual(JSON.parse(afterQueueStatus.stdout).executionBoundary, inheritedBoundary);
    const inheritedAnswer = await cli(
      root,
      '--session',
      sessionId,
      '--answer',
      JSON.stringify(answers),
      '--wait',
      '--json',
    );
    assert.equal(inheritedAnswer.code, 0, inheritedAnswer.stderr);
    const inheritedWait = await cli(root, '--session', sessionId, '--wait', '--json');
    assert.equal(inheritedWait.code, 0, inheritedWait.stderr);
    assert.match(JSON.parse(inheritedWait.stdout).finalOutput, /inherited-followup/);
    const inheritedResult = await cli(root, '--session', sessionId, '--result', '--json');
    assert.equal(inheritedResult.code, 0, inheritedResult.stderr);
    assert.match(JSON.parse(inheritedResult.stdout).finalOutput, /inherited-followup/);
    assert.deepEqual(
      await probe.request('session.execution_boundary.query', { sessionId }),
      inheritedBoundary,
    );
    await subscription.close();
    await probe.close();
  } finally {
    for (const child of children) child.kill('SIGTERM');
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI persists catalog-managed executor model changes without native settings', {
  timeout: 60_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-cli-executor-model-'));
  let host: Awaited<ReturnType<typeof startExecutionRuntimeHostService>> | undefined;
  t.after(async () => {
    await host?.close();
    await rm(root, { recursive: true, force: true });
  });
  const owner = await tryAcquireInteractiveRootOwner(
    await resolveStorageRoot({ path: root, kind: 'interactive' }),
  );
  assert.ok(owner);
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  let sessionId: string;
  try {
    sessionId = (
      await stores.sessionStore.create({
        cwd: root,
        executorId: 'fixture-executor',
        executorConfig: { model: 'before', mode: 'auto' },
        llmConnectionSlug: 'executor:fixture-executor',
        model: 'before',
        permissionMode: 'ask',
      })
    ).id;
  } finally {
    await stores.sessionStore.close?.();
    await owner.close();
  }
  const source = join(root, 'executor-fixture');
  await mkdir(source);
  await writeFile(
    join(source, 'maka.extension.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'cli-executor-fixture',
      runtime: { entry: 'index.mjs' },
      composition: { patch: 'maka.composition.json', structuralDependencies: [] },
    }),
  );
  await writeFile(
    join(source, 'maka.composition.json'),
    JSON.stringify([
      {
        type: 'insert',
        rootId: 'profile',
        entry: { id: 'executor', packageId: 'cli-executor-fixture', config: {} },
      },
    ]),
  );
  await writeFile(
    join(source, 'index.mjs'),
    `export default {
    packageId: 'cli-executor-fixture', contributions: [{ id: 'executor', kind: 'executor' }],
    host: { apply(ctx) { ctx.executors.register({
      id: 'fixture-executor',
      discover: async () => ({ id: 'fixture-executor', displayName: 'Fixture', readiness: 'ready',
        models: [{ id: 'before', name: 'Before' }, { id: 'after', name: 'After' }],
        supportsAttachments: false, supportsModelChange: true }),
      configureConversation: async ({ configuration }) => configuration,
      execute: async () => ({ status: 'completed', text: '' }),
    }); } },
  };`,
  );
  const { createExecutionRuntimeHostComposition } = await import(
    new URL('./execution-composition.js', import.meta.resolve('@maka/runtime-host/server')).href
  );
  let composition: Awaited<ReturnType<typeof createExecutionRuntimeHostComposition>> | undefined;
  host = await startExecutionRuntimeHostService(
    { rootPath: root },
    {
      createComposition: async (context, options) => {
        composition = await createExecutionRuntimeHostComposition(context, {
          ...options,
          bootstrapRuntimePolicy: false,
        });
        return composition;
      },
    },
  );
  assert.ok(composition);
  const installed = await composition.plugins.installPackage(source);
  assert.equal(installed.convergence, 'converged', JSON.stringify(installed));
  const changed = await cli(root, '--session', sessionId, '--model', 'after');
  assert.equal(changed.code, 0, changed.stderr);
  assert.equal(JSON.parse(changed.stdout).configuration.model, 'after');
  const connected = await connectRuntimeHost({
    rootPath: root,
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
  });
  assert.equal(connected.kind, 'connected');
  const probe = connected.connection;
  try {
    const saved = await probe.request('session.catalog.query', { kind: 'get', sessionId });
    assert.equal(saved.kind, 'session');
    assert.ok(saved.kind === 'session' && saved.session && 'executorConfig' in saved.session);
    assert.deepEqual(saved.session.executorConfig, { model: 'after' });
    const unsupported = await cli(root, '--session', sessionId, '--thinking', 'high');
    assert.equal(unsupported.code, 1);
    assert.match(unsupported.stderr, /Native execution settings require a new Maka task/);
  } finally {
    await probe.close();
  }
});

async function cli(
  root: string,
  ...args: string[]
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [fixturePath, root, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8').on('data', (data) => {
    stdout += data;
  });
  child.stderr!.setEncoding('utf8').on('data', (data) => {
    stderr += data;
  });
  return await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      children.delete(child);
      resolve({ code, stdout, stderr });
    });
  });
}

class RecoveryBackend extends FakeBackend {
  override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    if (input.text !== FAKE_ASK_SANDBOX_BOUNDARY_PROMPT) {
      yield* super.send(input);
      return;
    }
    const call = (id: string, stepId: string): SessionEvent => ({
      type: 'tool_start',
      id: randomUUID(),
      toolUseId: id,
      stepId,
      turnId: input.turnId,
      ts: Date.now(),
      toolName: 'Fetch',
      args: { url: 'https://example.test' },
    });
    const failed = randomUUID();
    yield call(failed, randomUUID());
    yield {
      type: 'tool_result',
      id: randomUUID(),
      toolUseId: failed,
      turnId: input.turnId,
      ts: Date.now(),
      isError: true,
      content: {
        kind: 'text',
        text: 'Network denied',
        sandboxFailure: {
          reason: 'sandbox_boundary_required',
          requiredExpansion: { network: { enabled: true } },
        },
      },
    };
    for await (const event of super.send(input)) {
      yield event;
      if (event.type === 'sandbox_boundary_decision_ack' && event.status === 'approved') {
        const retried = randomUUID();
        yield call(retried, randomUUID());
        yield {
          type: 'tool_result',
          id: randomUUID(),
          toolUseId: retried,
          turnId: input.turnId,
          ts: Date.now(),
          isError: false,
          content: { kind: 'text', text: 'Fetched successfully' },
        };
      }
    }
  }
}
