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
import { test } from 'node:test';
import type { WorkHubDelegationAssignedMessage } from '@maka/core/session';
import type { SessionAdmissionLease } from '../server/session-admission-gate.js';
import {
  HostWorkHubResultCoordinator,
  workHubResultOrigin,
  workHubResultContent,
  type WorkHubResultPorts,
  type WorkHubResultObservation,
} from '../server/workhub-result-coordinator.js';

const assignment: WorkHubDelegationAssignedMessage = {
  type: 'workhub_coordination',
  id: 'wha_one',
  turnId: 'request',
  coordinationTurnId: 'request',
  ts: 1,
  schemaVersion: 1,
  kind: 'delegation_assigned',
  actionId: 'action',
  actionFingerprint: `sha256:${'a'.repeat(64)}`,
  targetSessionId: 'target',
  targetSessionName: 'Build report',
  targetTurnId: 'target-turn',
  targetMessageId: 'target-message',
  delegationId: 'delegation',
  disposition: 'delegate_existing',
  userText: 'Build the report',
  returnResults: true,
};
const observation: WorkHubResultObservation = {
  turnId: 'target-turn',
  runId: 'target-run',
  eventKey: 'terminal-one',
  status: 'completed',
  result: 'Report ready at /workspace/report.pdf',
  sharedTurn: false,
};
function fixture() {
  let current: WorkHubResultObservation | undefined = observation;
  let active = true,
    busy = false,
    fail = false;
  const receipts = new Set<string>(),
    contents: string[] = [];
  const ports: WorkHubResultPorts = {
    listAssignments: async () => (active ? [assignment] : []),
    inspect: async () => (active ? current : undefined),
    deliver: async (origin, prepare) => {
      if (busy) return 'pending';
      if (receipts.has(origin.eventId)) return 'delivered';
      const content = await prepare({} as SessionAdmissionLease);
      if (!content) return 'obsolete';
      if (fail) throw new Error('Interrupted before admission');
      receipts.add(origin.eventId);
      contents.push(content.text);
      return 'delivered';
    },
    acquireResidency: () => ({ release() {} }),
    onError: (e) => {
      throw e;
    },
  };
  return {
    ports,
    receipts,
    contents,
    setCurrent: (value: WorkHubResultObservation | undefined) => {
      current = value;
    },
    setActive: (value: boolean) => {
      active = value;
    },
    setBusy: (value: boolean) => {
      busy = value;
    },
    setFail: (value: boolean) => {
      fail = value;
    },
  };
}
test('completed, failed and cancelled results enter WorkHub once with original scope', async () => {
  for (const status of ['completed', 'failed', 'cancelled'] as const) {
    const f = fixture();
    f.setCurrent({ ...observation, status });
    const c = new HostWorkHubResultCoordinator(f.ports);
    await c.reconcile();
    await c.reconcile();
    assert.equal(f.contents.length, 1);
    assert.ok(f.contents[0]!.includes(assignment.userText));
    assert.ok(f.contents[0]!.includes(status));
  }
});
test('busy WorkHub retains result for the next idle admission', async () => {
  const f = fixture(),
    c = new HostWorkHubResultCoordinator(f.ports);
  f.setBusy(true);
  await c.reconcile();
  assert.equal(f.contents.length, 0);
  f.setBusy(false);
  await c.reconcile();
  assert.equal(f.contents.length, 1);
});
test('reconstruction after restart uses durable admission receipts', async () => {
  const f = fixture();
  await new HostWorkHubResultCoordinator(f.ports).reconcile();
  await new HostWorkHubResultCoordinator(f.ports).reconcile();
  assert.equal(f.contents.length, 1);
});
test('failed admission remains discoverable on restart', async () => {
  const f = fixture();
  f.setFail(true);
  await assert.rejects(new HostWorkHubResultCoordinator(f.ports).reconcile());
  f.setFail(false);
  await new HostWorkHubResultCoordinator(f.ports).reconcile();
  assert.equal(f.contents.length, 1);
});
test('revalidates replacement or cancellation immediately before admission', async () => {
  const f = fixture();
  const deliver = f.ports.deliver;
  f.ports.deliver = async (o, p) => {
    f.setActive(false);
    return deliver(o, p);
  };
  await new HostWorkHubResultCoordinator(f.ports).reconcile();
  assert.equal(f.contents.length, 0);
});
test('an answered question is not delivered late, but completion is delivered', async () => {
  const f = fixture();
  f.setCurrent({ ...observation, status: 'waiting_for_user', eventKey: 'question-one' });
  const deliver = f.ports.deliver;
  f.ports.deliver = async (o, p) => {
    f.setCurrent(observation);
    return deliver(o, p);
  };
  const c = new HostWorkHubResultCoordinator(f.ports);
  await c.reconcile();
  assert.equal(f.contents.length, 0);
  await c.reconcile();
  assert.equal(f.contents.length, 1);
});
test('distinct interactions and continuation runs retain independent identities', () => {
  const one = workHubResultOrigin(assignment, observation);
  assert.notEqual(
    one.eventId,
    workHubResultOrigin(assignment, { ...observation, runId: 'resumed-run' }).eventId,
  );
  assert.notEqual(
    one.eventId,
    workHubResultOrigin(assignment, { ...observation, eventKey: 'question-two' }).eventId,
  );
});
test('does not replay historical delegations without return opt-in', async () => {
  const f = fixture();
  f.ports.listAssignments = async () => [{ ...assignment, returnResults: undefined }];
  await new HostWorkHubResultCoordinator(f.ports).reconcile();
  assert.equal(f.contents.length, 0);
});
test('bounds notification text, marks truncation and retains full-result locator', () => {
  const c = workHubResultContent(assignment, { ...observation, result: '😀'.repeat(20000) });
  assert.equal(c.displayText, assignment.targetSessionName);
  assert.ok(c.text.includes('"resultTruncated":true'));
  assert.ok(c.text.includes('"actionId":"action"'));
  assert.ok(!c.text.includes('�'));
});

test('a broken target does not block other completed delegations', async () => {
  const f = fixture();
  const errors: unknown[] = [];
  f.ports.onError = (error) => {
    errors.push(error);
  };
  f.ports.listAssignments = async () => [{ ...assignment, delegationId: 'broken' }, assignment];
  f.ports.inspect = async (a) => {
    if (a.delegationId === 'broken') throw new Error('Unavailable transcript');
    return observation;
  };
  await new HostWorkHubResultCoordinator(f.ports).reconcile();
  assert.equal(errors.length, 1);
  assert.equal(f.contents.length, 1);
});

test('a transient startup read failure retries even before any target was discovered', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  let attempts = 0;
  const errors: unknown[] = [];
  f.ports.onError = (error) => {
    errors.push(error);
  };
  f.ports.listAssignments = async () => {
    if (++attempts === 1) throw new Error('Temporary storage read failure');
    return [assignment];
  };
  const coordinator = new HostWorkHubResultCoordinator(f.ports);
  try {
    coordinator.start();
    t.mock.timers.tick(100);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 1);
    assert.equal(f.contents.length, 0);
    t.mock.timers.tick(5000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.contents.length, 1);
    coordinator.beginDrain();
    t.mock.timers.tick(10000);
    assert.equal(attempts, 2);
  } finally {
    await coordinator.close();
  }
});

test('a new target event wakes reconciliation ahead of the delivered-event backstop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  let inspections = 0;
  const inspect = f.ports.inspect;
  f.ports.inspect = (...args) => {
    inspections++;
    return inspect(...args);
  };
  const coordinator = new HostWorkHubResultCoordinator(f.ports);
  try {
    coordinator.start();
    t.mock.timers.tick(100);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const afterDelivery = inspections;
    assert.ok(afterDelivery > 0);
    t.mock.timers.tick(5000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(inspections, afterDelivery);
    coordinator.notify(assignment.targetSessionId);
    t.mock.timers.tick(100);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(inspections > afterDelivery);
  } finally {
    await coordinator.close();
  }
});
