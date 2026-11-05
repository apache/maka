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
        delete s.active.promptVersion;
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
    assert.equal(f.parent.coordinator.previous().outcome, 'interrupted');
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
    assert.equal(f.parent.coordinator.previous().outcome, 'completed');
    if (eventIntake) assert.equal(await f.q.intake.next(), undefined);
    else assert.equal(f.q.state().checkedThrough, active.to);
  });
}

for (const accepted of [false, true]) {
  test(`ambiguous submission retains its identity until Host reconciliation (accepted ${accepted})`, async (t) => {
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
    f.advance(3600000);
    // A missing resolution is not evidence that a new execution can be admitted.
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
