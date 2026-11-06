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
import test from 'node:test';
import {
  createComputerPermissionSetup,
  nextPermission,
} from '../app/computerPermissionSetupState.ts';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const record = (outcome = null, grants = ['accessibility', 'screen_recording']) => ({
  sessionId: 'session',
  requestId: 'request',
  turnId: 'turn',
  runId: 'run',
  createdAt: 1,
  outcome,
  request: {
    kind: 'system_permission',
    toolUseId: 'tool',
    application: 'Maka Host',
    grants,
    applicationLocation: null,
  },
});
const status = (ready = [], outcome = null, requestable = true) => ({
  record: record(outcome),
  requestable,
  grants: ['accessibility', 'screen_recording'].map((grant) => ({
    grant,
    effective: ready.includes(grant),
  })),
});
function harness(overrides = {}) {
  const calls = [];
  const ticks = new Set();
  let observed = status();
  const client = {
    status: async () => {
      calls.push('status');
      return observed;
    },
    actions: async () => ['accessibility', 'screen_recording', 'reveal_application'],
    request: async (grant) => {
      calls.push(['request', grant]);
      return observed;
    },
    action: async (action) => {
      calls.push(['action', action]);
    },
    cancel: async () => {
      calls.push('cancel');
    },
    ...overrides,
  };
  const changes = [];
  const model = createComputerPermissionSetup(
    client,
    (state) => changes.push(state),
    (tick, ms) => {
      assert.equal(ms, 1500);
      ticks.add(tick);
      return () => ticks.delete(tick);
    },
  );
  return {
    model,
    calls,
    ticks,
    changes,
    observe(value) {
      observed = value;
    },
  };
}

test('observation never triggers TCC, and only the next missing grant can be requested', async () => {
  const h = harness();
  await h.model.refresh();
  assert.deepEqual(h.calls, ['status']);
  assert.equal(nextPermission(h.model.snapshot().status), 'accessibility');
  await h.model.enable('screen_recording');
  assert.deepEqual(h.calls, ['status']);
  await h.model.enable('accessibility');
  assert.deepEqual(h.calls.slice(1), [
    ['request', 'accessibility'],
    ['action', 'accessibility'],
  ]);
  assert.equal(
    h.model.snapshot().status.grants[0].effective,
    false,
    'opening Settings is not permission',
  );
  h.observe(status(['accessibility']));
  await h.model.refresh();
  assert.equal(nextPermission(h.model.snapshot().status), 'screen_recording');
  h.model.dispose();
  assert.equal(h.ticks.size, 0);
});

test('a pending OS request is single-flight and is not cancelled when its window closes', async () => {
  const prompt = deferred();
  const h = harness({
    request: async (grant) => {
      h.calls.push(['request', grant]);
      return prompt.promise;
    },
  });
  await h.model.refresh();
  const pending = h.model.enable('accessibility');
  assert.equal(h.model.snapshot().operation, 'requesting');
  await h.model.enable('accessibility');
  assert.equal(h.calls.filter(Array.isArray).length, 1);
  h.model.dispose();
  const count = h.changes.length;
  prompt.resolve(status());
  await pending;
  assert.equal(h.changes.length, count);
  assert.ok(!h.calls.includes('cancel'));
  assert.ok(!h.calls.some((call) => call[0] === 'action'));
});

test('completion requires the canonical granted outcome, not only effective checks', async () => {
  const h = harness();
  h.observe(status(['accessibility', 'screen_recording']));
  await h.model.refresh();
  assert.equal(nextPermission(h.model.snapshot().status), null);
  assert.equal(h.model.snapshot().status.record.outcome, null);
  assert.equal(h.ticks.size, 1, 'keep observing until Host settles the original call');
  h.observe(
    status(['accessibility', 'screen_recording'], {
      kind: 'system_permission_granted',
      committedAt: 2,
    }),
  );
  await h.model.refresh();
  assert.equal(h.ticks.size, 0);
  const count = h.calls.length;
  await h.model.enable('accessibility');
  await h.model.open('reveal_application');
  await h.model.cancel();
  assert.equal(h.calls.length, count);
});

test('remote observations are real but cannot invoke local TCC', async () => {
  const h = harness();
  h.observe(status([], null, false));
  await h.model.refresh();
  await h.model.enable('accessibility');
  assert.deepEqual(h.calls, ['status']);
  h.observe(status(['accessibility'], null, false));
  await h.model.refresh();
  assert.equal(h.model.snapshot().status.grants[0].effective, true);
  h.model.dispose();
});

test('cancel during an OS prompt prevents subsequent Settings actions and does not resend an uncertain cancellation', async () => {
  const prompt = deferred();
  const h = harness({
    request: () => prompt.promise,
    cancel: async () => {
      h.calls.push('cancel');
      throw new Error('connection lost');
    },
  });
  await h.model.refresh();
  const pending = h.model.enable('accessibility');
  await h.model.cancel();
  await h.model.cancel();
  assert.equal(h.calls.filter((call) => call === 'cancel').length, 1);
  prompt.resolve(status());
  await pending;
  assert.equal(h.model.snapshot().operation, 'cancelling');
  assert.equal(h.model.snapshot().error.message, 'connection lost');
  assert.ok(!h.calls.some((call) => call[0] === 'action'));
  h.observe(status([], { kind: 'closure', reason: 'producer_cancelled', committedAt: 2 }));
  await h.model.refresh();
  assert.equal(h.ticks.size, 0);
});

test('a late pending TCC reply cannot undo a settled observation', async () => {
  const prompt = deferred();
  const h = harness({ request: () => prompt.promise });
  await h.model.refresh();
  const pending = h.model.enable('accessibility');
  h.observe(status([], { kind: 'closure', reason: 'producer_cancelled', committedAt: 2 }));
  await h.model.refresh();
  prompt.resolve(status());
  await pending;
  assert.equal(h.model.snapshot().status.record.outcome.reason, 'producer_cancelled');
  assert.ok(!h.calls.some((call) => call[0] === 'action'));
  assert.equal(h.ticks.size, 0);
});

test('observation failure is visible, recovery clears it without inventing denial', async () => {
  let failed = true;
  const h = harness({
    status: async () => {
      if (failed) throw new Error('Host offline');
      return status();
    },
  });
  await h.model.refresh();
  assert.equal(h.model.snapshot().error.message, 'Host offline');
  assert.equal(h.model.snapshot().status, null);
  failed = false;
  await h.model.refresh();
  assert.equal(h.model.snapshot().error, null);
  assert.equal(nextPermission(h.model.snapshot().status), 'accessibility');
  h.model.dispose();
});

test('effective permission skips Settings, and the original request limits which grants appear', async () => {
  const h = harness({ request: async () => status(['accessibility']) });
  await h.model.refresh();
  await h.model.enable('accessibility');
  assert.ok(!h.calls.some((call) => call[0] === 'action'));
  assert.equal(nextPermission(h.model.snapshot().status), 'screen_recording');
  h.observe({ ...status(), record: record(null, ['screen_recording']) });
  await h.model.refresh();
  assert.equal(nextPermission(h.model.snapshot().status), 'screen_recording');
  h.model.dispose();
});

test('a stale observation started before a human request cannot overwrite its result', async () => {
  const oldRead = deferred();
  let reads = 0;
  const h = harness({
    status: async () => (++reads === 2 ? oldRead.promise : status()),
    request: async () => status(['accessibility']),
  });
  await h.model.refresh();
  const reading = h.model.refresh();
  await h.model.enable('accessibility');
  oldRead.resolve(status());
  await reading;
  assert.equal(nextPermission(h.model.snapshot().status), 'screen_recording');
  h.model.dispose();
});

test('an unknown TCC result is never resubmitted; only Settings and observation remain available', async () => {
  const h = harness({
    request: async (grant) => {
      h.calls.push(['request', grant]);
      throw new Error('Original request #42 is still unresolved');
    },
  });
  await h.model.refresh();
  await h.model.enable('accessibility');
  assert.equal(h.model.snapshot().error.message, 'Original request #42 is still unresolved');
  await h.model.enable('accessibility');
  assert.deepEqual(h.calls.filter(Array.isArray), [
    ['request', 'accessibility'],
    ['action', 'accessibility'],
  ]);
  assert.equal(h.model.snapshot().status.grants[0].effective, false);
  h.model.dispose();
});
