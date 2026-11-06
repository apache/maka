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

import test from 'node:test';
import { restoreJob } from './runner-fixture.js';
import assert from 'node:assert/strict';
import { intakeFixture } from './intake-fixture.js';
import { HostMessageCoordinator } from '../../../../src/server/message-coordinator.js';
import { SessionAdmissionGate } from '../../../../src/server/session-admission-gate.js';

// Keep durable receipts across Host epochs. Admission/digest reconciliation is production
// code; only execution and persistence ports are controlled by this fixture.
function admissionHost(f: any) {
  const receipts = new Map<string, any>();
  const admissions = new Map<string, any>();
  const skillInvocation = { loaded: [], failed: [], receipts: [] };
  let starts = 0,
    epoch = 0;
  const create = () =>
    new HostMessageCoordinator({
      hostEpoch: `test-epoch-${++epoch}`,
      root: {
        readSessionHeader: async () => ({ isArchived: false }),
        readRootState: async () => ({ kind: 'idle' }),
        readLatestRootTurnLineage: async (identity: any) => identity,
        prepareMessage: async (input: any) => ({
          kind: 'ready',
          content: input.content,
          skillInvocation,
        }),
        startFromMessage: async (input: any, _admission: any, commit: any) => {
          starts++;
          await commit(input.content, skillInvocation);
          const sourceMessage = { ...input.sourceMessage, skillInvocation };
          receipts.set(sourceMessage.messageId, {
            admission: {
              schemaVersion: 1,
              sessionId: input.sessionId,
              turnId: input.turnId,
              runId: input.runId,
              userMessageId: `user-${starts}`,
              execution: {
                kind: 'external_message',
                inputDigest: sourceMessage.submittedContentDigest,
              },
              previousRootTurnId: null,
              normalizedInput: input.content,
              sourceMessages: [sourceMessage],
              admittedAt: Date.now(),
            },
            sourceMessage,
          });
          admissions.delete(sourceMessage.messageId);
          return { turnId: input.turnId, skillInvocation };
        },
      },
      durableProof: {
        readRootTurnSourceMessageReceipt: async (_session: string, id: string) => receipts.get(id),
        readImmutableSteeringMessageProof: async () => undefined,
        readLogicalExecution: async () => undefined,
      },
      admissions: {
        readMessageAdmission: async (_session: string, id: string) => admissions.get(id),
        commitMessageAdmission: async (value: any) => {
          admissions.set(value.messageId, value);
          return value;
        },
        hasCancelledMessageAdmission: async () => false,
        listMessageAdmissions: async () => [],
      },
      sessionAdmission: new SessionAdmissionGate(),
      preflightSessionSnapshot: () => true,
      acquireResidency: () => ({ release() {} }),
    } as any);
  let host = create();
  const context = {
    get hostEpoch() {
      return `test-epoch-${epoch}`;
    },
    connectionId: 'plugin-agent',
    principal: 'runtime_host' as const,
    acquireResidency: () => ({ release() {} }),
  };
  const submissions: any[] = [];
  f.agent.followup = async (text: string, { messageId }: any) => {
    submissions.push({ text, messageId });
    const result = await host.handlers['turn.message.submit'](
      {
        originHostEpoch: context.hostEpoch,
        sessionId: 'worker',
        messageId,
        content: { text },
        placement: 'next_turn',
      },
      context,
    );
    if (!result.ok) throw Error(result.error.message);
    return result.result;
  };
  f.agent.messageExecution = async (messageId: string) => {
    const result = await host.handlers['turn.message.execution.query'](
      { sessionId: 'worker', messageIds: [messageId] },
      context,
    );
    if (!result.ok) throw Error(result.error.message);
    return result.result.resolutions[0];
  };
  return {
    submissions,
    receipts,
    starts: () => starts,
    restart: async () => {
      await host.close();
      host = create();
    },
    close: () => host.close(),
  };
}

for (const eventIntake of [false, true]) {
  test(`recovery reconciles an admitted wake before rebuilding its changed context (event intake ${eventIntake})`, async (t) => {
    const f = await intakeFixture();
    const host = admissionHost(f);
    t.after(async () => {
      await host.close();
      await f.close();
    });
    await f.q.control({ action: 'configure', eventIntake });
    if (eventIntake) {
      await f.q.intake.collect();
      f.add('changed-item');
      await f.q.intake.collect();
      f.advance();
      await f.q.intake.judge();
    } else await f.q.control({ action: 'check' });
    const followup = f.agent.followup;
    f.agent.followup = async (...args: any[]) => {
      const result = await (followup as any)(...args);
      // Stop at the crash boundary: receipt committed, executionCompleted not committed.
      // Also exercise an activation persisted before submission prompt versions existed.
      f.q.store.update((s: any) => {
        delete s.active.submission;
      });
      f.q.abort.abort(Error('terminated after admission'));
      return result;
    };
    await f.q.dispatch();
    await f.q.running;
    const active = f.q.state().active;
    assert.ok(active && !active.executionCompleted);
    assert.equal(host.starts(), 1);
    assert.ok(host.receipts.has(active.messageId));
    assert.equal(f.parent.runner.status().running?.lane, 'quick');
    f.agent.followup = followup;
    f.advance(3600000); // Hint ages/current time also differ on replay.
    await host.restart();
    await f.restart();
    await f.q.control({ action: 'configure', eventIntake });
    await f.q.dispatch();
    await f.q.running;
    assert.equal(f.q.state().lastError, null);
    assert.equal(f.q.state().pending, null);
    assert.equal(host.submissions.length, 1, 'never resubmit a different payload for an owned ID');
    assert.equal(host.starts(), 1, 'do not start a replacement investigation');
    assert.equal(f.parent.runner.previous().outcome, 'completed');
    if (eventIntake) assert.equal(await f.q.intake.next(), undefined);
    else assert.equal(f.q.state().checkedThrough, active.to);
  });
}

for (const accepted of [false, true]) {
  test(`ambiguous submission retains its identity during the recovery grace period (accepted ${accepted})`, async (t) => {
    const f = await intakeFixture();
    const host = admissionHost(f);
    t.after(async () => {
      await host.close();
      await f.close();
    });
    await f.q.control({ action: 'check', eventIntake: false });
    const followup = f.agent.followup;
    let messageId: string | undefined;
    f.agent.followup = async (text: string, options: any) => {
      messageId = options.messageId;
      if (accepted) await followup(text, options);
      throw Error('submission response unavailable');
    };
    await f.q.dispatch();
    await f.q.running;
    assert.equal(f.q.state().pending.messageId, messageId);
    f.agent.followup = followup;
    f.advance(60_000);
    // Before the recovery deadline, a missing resolution retains the original ID.
    const query = f.agent.messageExecution;
    f.agent.messageExecution = async () => undefined as any;
    await f.q.dispatch();
    await f.q.running;
    assert.equal(f.q.state().pending.messageId, messageId);
    assert.equal(host.starts(), Number(accepted));
    f.agent.messageExecution = query;
    f.advance(3600000);
    await f.q.dispatch();
    await f.q.running;
    assert.equal(f.q.state().lastError, null);
    assert.equal(f.q.state().pending, null);
    assert.equal(host.starts(), 1);
    assert.equal(host.submissions.length, 1);
    assert.equal(host.submissions[0].messageId, messageId);
  });
}

for (const terminalFailure of [false, true]) {
  test(`only a confirmed terminal failure creates a replacement execution (${terminalFailure})`, async (t) => {
    const f = await intakeFixture();
    const host = admissionHost(f);
    t.after(async () => {
      await host.close();
      await f.close();
    });
    await f.q.control({ action: 'check', eventIntake: false });
    f.agent.whenIdle = async () => {
      if (terminalFailure)
        f.agent.snapshot = async () => ({ agent: { status: 'blocked' }, pendingInteractions: 0 });
      throw Error(terminalFailure ? 'execution failed' : 'observation unavailable');
    };
    await f.q.dispatch();
    await f.q.running;
    const pending = f.q.state().pending;
    if (terminalFailure) assert.notEqual(pending.messageId, host.submissions[0].messageId);
    else assert.equal(pending.messageId, host.submissions[0].messageId);
    await f.q.dispatch();
    assert.equal(host.starts(), 1, 'retain the configured retry delay');
    f.agent.whenIdle = async () => {};
    f.agent.snapshot = async () => ({ agent: { status: 'active' } });
    f.advance(3600000);
    await f.q.dispatch();
    await f.q.running;
    assert.equal(host.starts(), terminalFailure ? 2 : 1);
    assert.equal(f.q.state().pending, null);
    assert.equal(f.q.state().workerSession, 'worker');
    assert.equal(f.q.state().checkedThrough, pending.to);
  });
}

for (const unknown of [false, true]) {
  test(`restored quick work blocks new broad admission until ownership is reconciled (${unknown})`, async (t) => {
    const f = await intakeFixture();
    t.after(() => f.close());
    await f.q.control({ action: 'check', eventIntake: false });
    let release!: () => void;
    let running = true;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.agent.snapshot = async () => ({
      agent: { status: running ? 'running' : 'active' },
      pendingInteractions: 0,
    });
    // Initial admission still starts from an idle worker.
    const snapshot = f.agent.snapshot;
    f.agent.snapshot = async () => ({ agent: { status: 'active' }, pendingInteractions: 0 });
    f.agent.whenIdle = async (signal?: AbortSignal) => {
      f.agent.snapshot = snapshot;
      signal?.throwIfAborted();
      let abort!: () => void;
      try {
        await Promise.race([
          done,
          new Promise<never>((_, reject) => {
            abort = () => reject(signal?.reason);
            signal?.addEventListener('abort', abort, { once: true });
          }),
        ]);
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    };
    try {
      await f.q.dispatch();
      // Reach durable admission/observation before simulating scheduler replacement.
      for (let i = 0; i < 100 && !f.counts().workerCalls; i++)
        await new Promise((r) => setTimeout(r, 5));
      const activation = f.q.state().active;
      assert.ok(activation);
      const query = f.agent.messageExecution;
      if (unknown) f.agent.messageExecution = async () => undefined as any;
      await f.restart();
      const coordinator = f.parent.runner;
      assert.equal(coordinator.status().running?.lane, 'quick');
      if (unknown) {
        await f.q.dispatch();
        assert.equal(
          coordinator.status().running?.lane,
          'quick',
          'an unknown receipt cannot free recovery capacity',
        );
        f.agent.messageExecution = query;
      }
      await f.q.dispatch();
      assert.equal(f.q.state().active?.id, activation.id);
      assert.equal(coordinator.status().running?.lane, 'quick');
      assert.equal(
        f.counts().workerCalls,
        1,
        'observe the original submission, never submit again',
      );
      await f.q.report({ key: 'restored', messages: ['Recovered finding'] }, 'worker');
      const observing = f.q.running;
      running = false;
      release();
      await observing;
      assert.equal(f.q.state().pending, null);
      assert.equal(f.delivered.size, 1);
      assert.equal(coordinator.status().running, null, 'capacity is released after settlement');
    } finally {
      running = false;
      release();
    }
  });
}

for (const missing of [false, true]) {
  test(`recovery never adopts a busy or removed worker for an unadmitted message (missing ${missing})`, async (t) => {
    const f = await intakeFixture();
    t.after(() => f.close());
    await f.q.control({ action: 'check', eventIntake: false });
    await f.q.dispatch();
    await f.q.running;
    restoreJob(f.q.store, 'quick', (s: any) => {
      s.pending = {
        id: 'not-started',
        messageId: 'not-admitted',
        from: s.startedAt,
        to: s.startedAt,
        reports: [],
        tokens: {},
      };
    });
    f.agent.snapshot = async () => ({ agent: { status: 'running' }, pendingInteractions: 0 });
    if (missing) f.ctx.sessionQuery.list = async () => [];
    await f.restart();
    await f.q.dispatch();
    assert.equal(f.q.state().active, null);
    assert.equal(f.q.state().pending.id, 'not-started');
    assert.equal(f.counts().workerCalls, 1);
    assert.equal(f.parent.runner.status().running, null);
  });
}
