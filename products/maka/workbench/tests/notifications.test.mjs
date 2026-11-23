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
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';

const appRoot = new URL('../app/', import.meta.url);
const session = (id, activity, title = id) => ({ id, activity, title });

async function setup(t, initialStatus = 'default', desktop = true) {
  let status = initialStatus;
  const state = { sessions: [], foreground: false };
  const effects = { sessions: new Set(), foreground: new Set() };
  let observer;
  function track(effect, run) {
    const previous = observer;
    observer = effect;
    try {
      return run();
    } finally {
      observer = previous;
    }
  }
  function read(key) {
    if (observer) effects[key].add(observer);
    return state[key];
  }
  function update(key, value) {
    state[key] = value;
    for (const effect of [...effects[key]]) effect();
  }
  const cleanups = [];
  const presses = new EventEmitter();
  const prompt = Promise.withResolvers();
  const shown = [];
  const actions = [];
  const permission = t.mock.fn(async () => status);
  const requestPermission = t.mock.fn(() => prompt.promise);
  globalThis.__notificationFixture = {
    cleanup: (fn) => cleanups.push(fn),
    effect(fn) {
      const run = () => {
        effects.sessions.delete(run);
        effects.foreground.delete(run);
        track(run, fn);
      };
      run();
    },
    untracked: (read) => track(undefined, read),
    Notifications: {
      permission,
      requestPermission,
      show: async (notice) => {
        shown.push(notice);
        return true;
      },
      on(event, listener) {
        presses.on(event, listener);
        return () => presses.off(event, listener);
      },
    },
    Window: { get: (id) => ({ focus: () => actions.push(['focus', id]) }) },
  };
  const native = {
    nsh: 'export const { cleanup, effect, Notifications, untracked } = globalThis.__notificationFixture;',
    'nsh/desktop': 'export const { Window } = globalThis.__notificationFixture;',
    './chrome': `export const ownTitleBar = ${desktop};`,
    './locale': 'export const tr = key => key;',
  };
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL?.startsWith(appRoot.href)) {
        if (specifier in native)
          return {
            url: `data:text/javascript,${encodeURIComponent(native[specifier])}#${encodeURIComponent(t.name)}`,
            shortCircuit: true,
          };
        if (specifier.startsWith('.')) return next(`${specifier}.ts`, context);
      }
      return next(specifier, context);
    },
  });
  const { watchNotifications } = await import(
    new URL(`notifications.ts?test=${encodeURIComponent(t.name)}`, appRoot)
  ).finally(() => {
    hooks.deregister();
    delete globalThis.__notificationFixture;
  });
  const owner = {
    mount: () =>
      watchNotifications({
        sessions: () => read('sessions'),
        foreground: () => read('foreground'),
        open: (id) => actions.push(['open', id]),
      }),
    update: (...rows) => update('sessions', rows),
    foreground: (value) => update('foreground', value),
    dispose() {
      effects.sessions.clear();
      effects.foreground.clear();
      for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    },
  };
  t.after(owner.dispose);
  owner.mount();
  return {
    owner,
    setStatus: (next) => {
      status = next;
    },
    permission,
    requestPermission,
    prompt,
    shown,
    presses,
    actions,
  };
}

test('one pending permission request delivers only the latest eligible transition per session', async (t) => {
  const { owner, permission, requestPermission, prompt, shown } = await setup(t);
  const working = ['a', 'b', 'c', 'd'].map((id) => session(id, 'working'));
  owner.update(...working);
  assert.equal(permission.mock.callCount(), 0);
  owner.update(...working.map(({ id }) => session(id, 'waiting')));
  await setImmediate();
  owner.update(working[0], session('b', 'waiting'), working[2]);
  owner.update(session('a', 'idle', ''), session('b', 'waiting', 'Renamed'), working[2]);
  await setImmediate();
  assert.equal(permission.mock.callCount(), 1);
  assert.equal(requestPermission.mock.callCount(), 1);
  assert.deepEqual(shown, []);

  prompt.resolve('granted');
  await setImmediate();
  assert.deepEqual(
    shown.toSorted((a, b) => a.id.localeCompare(b.id)),
    [
      { id: 'a', title: 'Untitled conversation', body: 'Turn finished' },
      { id: 'b', title: 'Renamed', body: 'Waiting for you' },
    ],
  );
});

test('enabling notifications in OS settings after denial takes effect without restart', async (t) => {
  const { owner, setStatus, permission, requestPermission, shown } = await setup(t, 'denied');
  owner.update(session('a', 'working'));
  owner.update(session('a', 'idle', 'First'));
  await setImmediate();
  assert.equal(permission.mock.callCount(), 1);
  assert.equal(requestPermission.mock.callCount(), 0);
  assert.deepEqual(shown, []);

  setStatus('granted');
  owner.update(session('a', 'working', 'First'));
  owner.update(session('a', 'waiting', 'First'));
  await setImmediate();
  assert.equal(permission.mock.callCount(), 2);
  assert.equal(requestPermission.mock.callCount(), 0);
  assert.deepEqual(shown, [{ id: 'a', title: 'First', body: 'Waiting for you' }]);
});

test('returning to the foreground retires pending alerts for that background interval', async (t) => {
  const { owner, prompt, shown } = await setup(t);
  owner.update(session('a', 'working'));
  owner.update(session('a', 'waiting'));
  await setImmediate();
  owner.foreground(true);
  owner.foreground(false);
  prompt.resolve('granted');
  await setImmediate();
  assert.deepEqual(shown, []);
});

test('presses focus then open, and a remounted owner shares only the pending permission', async (t) => {
  const { owner, presses, actions, prompt, requestPermission, shown } = await setup(t);
  owner.update(session('a', 'working'));
  owner.update(session('a', 'waiting'));
  await setImmediate();
  presses.emit('press', { id: 'a' });
  owner.dispose();
  assert.equal(presses.emit('press', { id: 'b' }), false);
  owner.mount();
  owner.update(session('b', 'working'));
  owner.update(session('b', 'idle'));
  await setImmediate();
  assert.equal(requestPermission.mock.callCount(), 1);
  prompt.resolve('granted');
  await setImmediate();
  assert.deepEqual(actions, [
    ['focus', 'main'],
    ['open', 'a'],
  ]);
  assert.deepEqual(shown, [{ id: 'b', title: 'b', body: 'Turn finished' }]);
});

for (const status of ['granted', 'denied', 'unavailable']) {
  test(`an existing ${status} permission is respected without a prompt`, async (t) => {
    const { owner, requestPermission, shown } = await setup(t, status);
    owner.update(session('a', 'working'));
    owner.update(session('a', 'idle', 'First conversation'));
    await setImmediate();
    assert.equal(requestPermission.mock.callCount(), 0);
    assert.deepEqual(
      shown,
      status === 'granted' ? [{ id: 'a', title: 'First conversation', body: 'Turn finished' }] : [],
    );
  });
}

test('a terminal never subscribes or asks for notification permission', async (t) => {
  const { owner, permission, presses } = await setup(t, 'default', false);
  owner.update(session('a', 'working'));
  owner.update(session('a', 'idle'));
  assert.equal(permission.mock.callCount(), 0);
  assert.equal(presses.listenerCount('press'), 0);
});
