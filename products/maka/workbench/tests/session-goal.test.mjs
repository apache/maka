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
import { registerHooks } from 'node:module';
import test from 'node:test';

const appRoot = new URL('../app/', import.meta.url);
const native = {
  nsh: `export const signal = initial => {
      let value = initial;
      const read = () => value;
      read.set = next => { value = next; };
      return read;
    };
    export const batch = fn => fn();
    export const cleanup = () => {};`,
  locale: `export const tr = key => key;`,
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    const key =
      context.parentURL?.startsWith(appRoot.href) && specifier === './locale'
        ? 'locale'
        : specifier;
    if (key in native)
      return { url: `data:text/javascript,${encodeURIComponent(native[key])}`, shortCircuit: true };
    if (
      context.parentURL?.startsWith(appRoot.href) &&
      specifier.startsWith('.') &&
      !/\.\w+$/.test(specifier)
    )
      return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
const { createSessionGoal } = await import(new URL('sessionGoal.ts', appRoot));
hooks.deregister();

const snapshot = (revision, id = 'goal') => ({ current: { id, revision, pending: false } });

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function setup({ beforeQueryReturns, backend = null, permissions = {} } = {}) {
  const queued = [];
  let waiting;
  let latest = snapshot(4);
  const sent = [];
  const requests = [];
  const host = {
    subscribe: async () => ({
      next: () =>
        queued.length
          ? Promise.resolve(queued.shift())
          : new Promise((resolve) => {
              waiting = resolve;
            }),
      close: async () => {},
    }),
    query: async () => {
      const read = latest;
      await beforeQueryReturns?.();
      return read;
    },
  };
  const control = async (_method, request) => {
    requests.push(request);
    sent.push(request.revision);
    latest = snapshot(request.kind === 'create' ? 1 : request.revision + 1);
    return { kind: 'committed' };
  };
  const goal = createSessionGoal(host, 'session', control, permissions, async () => backend);
  const push = async (view) => {
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(view);
    } else queued.push(view);
    await flush();
  };
  return { goal, push, sent, requests };
}

test('a stale stream snapshot does not undo what a change returned', async () => {
  const { goal, push, sent } = setup();
  await push(snapshot(4));
  assert.equal(await goal.change('pause'), true);
  assert.equal(goal.view().current.revision, 5);

  await push(snapshot(4));
  assert.equal(goal.view().current.revision, 5);
  assert.equal(await goal.change('resume'), true);
  assert.deepEqual(sent, [4, 5]);
});

test('an external Agent supplies the approval for Goal creation and resume', async () => {
  const backend = {
    kind: 'executor',
    selection: {
      executor: 'external',
      settings: { runtime: 'antigravity', model: 'gemini-4-neon', thinkingLevel: 'high' },
    },
  };
  const session = {
    workspace: { path: '/workspace' },
    permissions: { access: 'workspace_write', requestPermissions: false },
    boundaryRevision: 3,
    binding: { id: 'binding', permissionEpoch: 4 },
  };
  const { goal, push, requests } = setup({
    backend,
    permissions: { snapshot: () => session },
  });
  await push({ current: null });

  assert.equal(await goal.create('keep working', null), true);
  assert.equal(await goal.change('pause'), true);
  assert.equal(await goal.change('resume'), true);

  const approval = {
    target: { sessionId: 'session', ...session },
    backend,
  };
  assert.deepEqual(
    requests.map((request) => request.kind),
    ['create', 'control', 'control'],
  );
  assert.deepEqual(requests[0].approval, approval);
  assert.equal(requests[1].approval, undefined);
  assert.deepEqual(requests[2].approval, approval);
});

test('a change whose query is overtaken by the stream keeps the newer snapshot', async () => {
  const { goal, push } = setup({ beforeQueryReturns: () => push(snapshot(6)) });
  await push(snapshot(4));
  assert.equal(await goal.change('pause'), true);
  assert.equal(goal.view().current.revision, 6);
});

test('a stale snapshot of the previous Goal, or of none, does not replace a newer Goal', async () => {
  const { goal, push } = setup();
  await push({ current: null });
  await push(snapshot(4, 'first'));
  await push(snapshot(5, 'next'));
  await push(snapshot(4, 'first'));
  await push({ current: null });
  assert.deepEqual(goal.view().current, snapshot(5, 'next').current);
});

test('the stream moves the Goal forward and refreshes one at the same revision', async () => {
  const { goal, push } = setup();
  await push(snapshot(4));
  await push(snapshot(6));
  assert.equal(goal.view().current.revision, 6);
  const refreshed = { current: { ...snapshot(6).current, consumed: 100 } };
  await push(refreshed);
  assert.equal(goal.view().current.consumed, 100);
});

test('goal observation cancellation reconnects immediately without flashing connectionError', async () => {
  let watches = 0;
  let rejectFirst;
  let resolveSecond;
  const host = {
    subscribe: async () => {
      watches += 1;
      if (watches === 1) {
        let delivered = false;
        return {
          next: () => {
            if (!delivered) {
              delivered = true;
              return Promise.resolve(snapshot(4));
            }
            return new Promise((_, reject) => {
              rejectFirst = reject;
            });
          },
          close: async () => {},
        };
      }
      return {
        next: () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
        close: async () => {},
      };
    },
    query: async () => snapshot(4),
  };
  const goal = createSessionGoal(
    host,
    'session',
    async () => ({ kind: 'committed' }),
    {},
    async () => null,
  );
  await flush();
  assert.equal(goal.view().current.revision, 4);
  assert.equal(goal.error(), '');

  rejectFirst(new Error('goal_observation_cancelled'));
  await flush();
  assert.equal(watches, 2);
  assert.equal(goal.error(), '');

  resolveSecond(snapshot(5));
  await flush();
  assert.equal(goal.view().current.revision, 5);
  assert.equal(goal.error(), '');
});
