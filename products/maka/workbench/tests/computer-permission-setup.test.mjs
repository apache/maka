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
const status = (ready = [], outcome = null, requestable = true) => ({
  outcome,
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

test('only the next missing grant prompts, and effective checks wait for canonical completion', async () => {
  const h = harness();
  await h.model.refresh();
  await h.model.enable('screen_recording');
  assert.deepEqual(h.calls, ['status'], 'observation and out-of-order steps never prompt');
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
  h.observe(status(['accessibility', 'screen_recording']));
  await h.model.refresh();
  assert.equal(nextPermission(h.model.snapshot().status), null);
  assert.equal(h.model.snapshot().status.outcome, null);
  assert.equal(h.ticks.size, 1, 'keep observing until the original producer settles');
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
  await h.model.cancel();
  assert.equal(h.calls.length, count);
  h.model.dispose();
});

test('an original OS request is not replayed after window disposal or an unknown result', async () => {
  const prompt = deferred();
  const h = harness({
    request: async (grant) => {
      h.calls.push(['request', grant]);
      return prompt.promise;
    },
  });
  await h.model.refresh();
  const pending = h.model.enable('accessibility');
  await h.model.enable('accessibility');
  assert.equal(h.calls.filter(Array.isArray).length, 1);
  h.model.dispose();
  const count = h.changes.length;
  prompt.resolve(status());
  await pending;
  assert.equal(h.changes.length, count);
  assert.ok(!h.calls.includes('cancel'));
  assert.ok(!h.calls.some((call) => call[0] === 'action'));

  const uncertain = harness({
    request: async (grant) => {
      uncertain.calls.push(['request', grant]);
      throw new Error('Original request #42 is still unresolved');
    },
  });
  await uncertain.model.refresh();
  await uncertain.model.enable('accessibility');
  assert.equal(
    uncertain.model.snapshot().error.message,
    'Original request #42 is still unresolved',
  );
  await uncertain.model.enable('accessibility');
  assert.deepEqual(uncertain.calls.filter(Array.isArray), [
    ['request', 'accessibility'],
    ['action', 'accessibility'],
  ]);
  uncertain.model.dispose();
});

test('uncertain cancellation is not resent and a late OS reply cannot undo canonical closure', async () => {
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
  assert.equal(h.model.snapshot().error.message, 'connection lost');
  const outcome = { kind: 'closure', reason: 'producer_cancelled', committedAt: 2 };
  h.observe(status([], outcome));
  await h.model.refresh();
  prompt.resolve(status());
  await pending;
  assert.deepEqual(h.model.snapshot().status.outcome, outcome);
  assert.ok(!h.calls.some((call) => call[0] === 'action'));
  assert.equal(h.ticks.size, 0);
  h.model.dispose();
});
