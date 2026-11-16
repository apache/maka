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
  nsh: `let tracking;
    export const signal = initial => {
      let value = initial;
      const observers = new Set();
      const read = () => { if (tracking) observers.add(tracking); return value; };
      read.set = next => {
        if (Object.is(value, next)) return;
        value = next;
        for (const observer of [...observers]) observer();
      };
      return read;
    };
    export const computed = fn => fn;
    export const untracked = fn => { const previous = tracking; tracking = undefined; try { return fn(); } finally { tracking = previous; } };
    export const effect = fn => {
      let alive = true;
      const run = () => {
        if (!alive) return;
        const previous = tracking;
        tracking = run;
        try { fn(); } finally { tracking = previous; }
      };
      globalThis.taskScope.push(() => { alive = false; });
      run();
    };
    export const cleanup = fn => globalThis.taskScope.push(fn);`,
  locale: `export const tr = (key, values) => values ? key.replace(/\\{(\\w+)\\}/g, (_, name) => String(values[name])) : key;`,
  // The native Host binding; the tests' scope stands in for the recorded mutation.
  host: `export const pendingTerminals = scope => scope.pendingTerminals();
    export const terminalMutation = (scope, method, input) => scope.terminal(method, input);`,
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    const stub =
      specifier === 'nsh'
        ? 'nsh'
        : context.parentURL?.startsWith(appRoot.href)
          ? ['locale', 'host'].find((name) => specifier === `./${name}`)
          : undefined;
    if (stub) {
      const key = stub;
      return {
        url: `data:text/javascript,${encodeURIComponent(native[key])}`,
        shortCircuit: true,
      };
    }
    if (
      context.parentURL?.startsWith(appRoot.href) &&
      specifier.startsWith('.') &&
      !/\.\w+$/.test(specifier)
    )
      return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
const { createBackgroundTasks } = await import(new URL('backgroundTaskState.ts', appRoot));
const { signal } = await import(`data:text/javascript,${encodeURIComponent(native.nsh)}`);
hooks.deregister();

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function entry(ref, overrides = {}, result = {}) {
  return {
    sessionId: 'S',
    ownership: { kind: 'local' },
    correlation: null,
    visibility: 'model',
    initiator: 'agent',
    ...overrides,
    result: {
      kind: 'shell_run',
      ref,
      mode: 'pipes',
      status: 'running',
      cwd: '/w',
      cmd: `cmd ${ref}`,
      startedAt: 1000,
      updatedAt: 1000,
      revision: 1,
      ...result,
    },
  };
}

/** A Host whose list watches deliver what the test pushes. */
function fakeHost(pages = {}) {
  const streams = [];
  const queries = [];
  const host = {
    streams,
    queries,
    pending: [],
    stops: [],
    /** The stop outcome, or an Error to throw. */
    stopReply: null,
    session(sessionId) {
      assert.equal(sessionId, 'S');
      return {
        pendingTerminals: async () => host.pending,
        async terminal(method, input) {
          assert.equal(method, 'stop');
          host.stops.push(input);
          if (host.stopReply instanceof Error) throw host.stopReply;
          return host.stopReply;
        },
      };
    },
    async subscribe(endpoint, method, input) {
      assert.equal(endpoint, 'terminal');
      assert.equal(method, 'watchList');
      const waiting = [];
      const queued = [];
      const stream = {
        input,
        closed: false,
        push(value) {
          const waiter = waiting.shift();
          if (waiter) waiter(value);
          else queued.push(value);
        },
        next() {
          if (queued.length) return Promise.resolve(queued.shift());
          return new Promise((resolve, reject) =>
            waiting.push((value) => (value instanceof Error ? reject(value) : resolve(value))),
          );
        },
        async close() {
          stream.closed = true;
          for (const waiter of waiting.splice(0)) waiter(null);
        },
      };
      streams.push(stream);
      return stream;
    },
    async query(endpoint, method, input) {
      assert.equal(`${endpoint}.${method}`, 'terminal.list');
      queries.push(input);
      return { kind: 'completed', value: pages[input.offset] };
    },
  };
  return host;
}

function setup(t, host, active = signal(true)) {
  globalThis.taskScope = [];
  const tasks = createBackgroundTasks(host, { sessionId: 'S', active });
  const scope = globalThis.taskScope;
  t.after(() => {
    for (const dispose of scope.toReversed()) dispose();
  });
  return { tasks, active, scope };
}

const page = (resources, nextOffset) => ({
  kind: 'completed',
  value: { resources, ...(nextOffset === undefined ? {} : { nextOffset }) },
});

test('lists only agent background commands of the Session, running then finished', async (t) => {
  const host = fakeHost();
  const { tasks } = setup(t, host);
  await settle();
  host.streams[0].push(
    page([
      entry('late', {}, { startedAt: 3000 }),
      entry('early', {}, { startedAt: 2000, status: 'starting' }),
      entry('shell', { initiator: 'user', visibility: 'user' }),
      entry('other', { sessionId: 'T' }),
      entry('old', {}, { status: 'completed', completedAt: 4000, exitCode: 0 }),
      entry('new', {}, { status: 'failed', completedAt: 9000, exitCode: 2 }),
    ]),
  );
  await settle();
  assert.deepEqual(
    tasks.running().map((task) => task.ref),
    ['early', 'late'],
  );
  assert.deepEqual(
    tasks.finished().map((task) => task.ref),
    ['new', 'old'],
  );
  assert.deepEqual(tasks.finished()[0], {
    ref: 'new',
    command: 'cmd new',
    status: 'failed',
    startedAt: 1000,
    completedAt: 9000,
    exitCode: 2,
    stoppable: false,
  });
  assert.equal(tasks.running()[0].stoppable, true);
  assert.equal(tasks.error(), '');
});

test('reads every later page before replacing the list', async (t) => {
  const host = fakeHost({
    1: { resources: [entry('b')], nextOffset: 2 },
    2: { resources: [entry('c')] },
  });
  const { tasks } = setup(t, host);
  await settle();
  host.streams[0].push(page([entry('a')], 1));
  await settle();
  await settle();
  assert.deepEqual(
    host.queries.map((query) => query.offset),
    [1, 2],
  );
  assert.deepEqual(
    tasks.running().map((task) => task.ref),
    ['a', 'b', 'c'],
  );
});

test('watches only while active and keeps the last rows when paused', async (t) => {
  const active = signal(false);
  const host = fakeHost();
  const { tasks } = setup(t, host, active);
  await settle();
  assert.equal(host.streams.length, 0);
  active.set(true);
  await settle();
  assert.equal(host.streams.length, 1);
  assert.deepEqual(host.streams[0].input, { sessionId: 'S', offset: 0 });
  host.streams[0].push(page([entry('a')]));
  await settle();
  active.set(false);
  await settle();
  assert.equal(host.streams[0].closed, true);
  assert.deepEqual(
    tasks.running().map((task) => task.ref),
    ['a'],
  );
});

test('reports a failed list and refresh starts a new watch', async (t) => {
  const host = fakeHost();
  const { tasks } = setup(t, host);
  await settle();
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => {
    console.warn = warn;
  });
  host.streams[0].push({ kind: 'failed', message: 'denied' });
  await settle();
  await settle();
  assert.notEqual(tasks.error(), '');
  tasks.refresh();
  await settle();
  assert.equal(host.streams.length, 2);
  host.streams[1].push(page([entry('a')]));
  await settle();
  assert.equal(tasks.error(), '');
  assert.equal(tasks.running().length, 1);
});

test('closes its watch when the conversation is disposed', async (t) => {
  const host = fakeHost();
  const { scope } = setup(t, host);
  await settle();
  for (const dispose of scope.splice(0).toReversed()) dispose();
  await settle();
  assert.equal(host.streams[0].closed, true);
});

async function following(t, host, resources = [entry('a')], active = signal(true)) {
  const { tasks } = setup(t, host, active);
  await settle();
  host.streams[0].push(page(resources));
  await settle();
  return tasks;
}

test('stops a running task and shows the Host result at once', async (t) => {
  const host = fakeHost();
  const tasks = await following(t, host);
  const stopped = entry('a', {}, { status: 'cancelled', completedAt: 5000 });
  host.stopReply = { kind: 'completed', value: { applied: true, resource: stopped } };
  const request = tasks.stop('a');
  assert.equal(tasks.stopping('a'), true);
  await request;
  assert.deepEqual(host.stops, [{ sessionId: 'S', ref: 'a' }]);
  assert.equal(tasks.stopping('a'), false);
  assert.equal(tasks.running().length, 0);
  assert.equal(tasks.finished()[0].status, 'cancelled');
  assert.equal(tasks.error(), '');
});

test('does not race an unconfirmed terminal action', async (t) => {
  const host = fakeHost();
  const tasks = await following(t, host);
  host.pending = [{ id: 'earlier' }];
  await tasks.stop('a');
  assert.deepEqual(host.stops, []);
  assert.notEqual(tasks.error(), '');
  assert.equal(tasks.running().length, 1);
});

test('reports a refused stop and keeps the task', async (t) => {
  const host = fakeHost();
  const tasks = await following(t, host);
  host.stopReply = new Error('stop refused');
  await tasks.stop('a');
  assert.equal(tasks.error(), 'Could not stop the background task. stop refused');
  assert.equal(tasks.stopping('a'), false);
  assert.equal(tasks.running().length, 1);
});

test('offers stop only for running tasks this Host owns while connected', async (t) => {
  const active = signal(true);
  const host = fakeHost();
  const shared = { kind: 'source_owned', sourceSessionId: 'X', ownerSessionId: 'S' };
  const tasks = await following(
    t,
    host,
    [entry('own'), entry('shared', { ownership: shared })],
    active,
  );
  assert.deepEqual(
    tasks.running().map((task) => [task.ref, task.stoppable]),
    [
      ['own', true],
      ['shared', false],
    ],
  );
  await tasks.stop('shared');
  active.set(false);
  assert.equal(tasks.running()[0].stoppable, false);
  await tasks.stop('own');
  assert.deepEqual(host.stops, []);
});
