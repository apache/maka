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
  // The native Host binding; the test scope stands in for the recorded operations.
  host: `export const pendingTerminals = scope => scope.pendingTerminals();
    export const terminalMutation = (scope, method, input) => scope.terminal(method, input);
    export const recoverTerminal = (scope, id) => scope.recover(id);
    export const abandonTerminal = () => { throw new Error('not abandoned in these tests'); };`,
  grid: `export class TerminalGrid { discardDisplay() {} reset() {} }`,
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    const stub =
      specifier === 'nsh'
        ? 'nsh'
        : specifier === 'maka/host'
          ? 'grid'
          : context.parentURL?.startsWith(appRoot.href)
            ? ['locale', 'host'].find((name) => specifier === `./${name}`)
            : undefined;
    if (stub)
      return {
        url: `data:text/javascript,${encodeURIComponent(native[stub])}`,
        shortCircuit: true,
      };
    if (
      context.parentURL?.startsWith(appRoot.href) &&
      specifier.startsWith('.') &&
      !/\.\w+$/.test(specifier)
    )
      return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
const { createTerminals } = await import(new URL('terminalState.ts', appRoot));
hooks.deregister();

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function entry(overrides = {}, result = {}) {
  return {
    sessionId: 'S',
    ownership: { kind: 'local' },
    correlation: null,
    visibility: 'model',
    initiator: 'agent',
    ...overrides,
    result: {
      kind: 'shell_run',
      ref: 'r1',
      mode: 'pipes',
      status: 'running',
      cwd: '/w',
      cmd: 'npm run watch',
      startedAt: 1000,
      updatedAt: 1000,
      revision: 1,
      ...result,
    },
  };
}

/** A Host whose observations stay open and whose terminal operations the test scripts. */
function fakeHost() {
  const host = {
    pending: [],
    stops: [],
    recovered: [],
    holdRecovery: false,
    /** The stop outcome, or an Error to throw. */
    stopReply: null,
    session(sessionId) {
      assert.equal(sessionId, 'S');
      return {
        sessionId,
        pendingTerminals: async () => host.pending,
        async terminal(method, input) {
          assert.equal(method, 'stop');
          host.stops.push(input);
          host.beforeReply?.();
          if (host.stopReply instanceof Error) throw host.stopReply;
          return host.stopReply;
        },
        async recover(id) {
          host.recovered.push(id);
          if (host.holdRecovery) return new Promise(() => {});
          host.pending = [];
          return {
            receipt: {
              kind: 'recorded',
              outcome: { kind: 'returned', result: { kind: 'success' } },
            },
          };
        },
      };
    },
    async subscribe() {
      return { next: () => new Promise(() => {}), close: async () => {} };
    },
  };
  return host;
}

/** Opens one agent command's terminal view, as the Agent tab does. */
async function openAgentCommand(host, initial = entry()) {
  globalThis.taskScope = [];
  let model = null;
  const terminals = createTerminals(host, {
    sessionId: () => 'S',
    active: () => true,
    open: (_entry, opened) => {
      model = opened;
    },
  });
  await settle();
  terminals.open(initial);
  model.activate();
  return { terminals, model };
}

function dispose() {
  for (const release of globalThis.taskScope.splice(0)) release();
}

test('stopping a running agent command applies the Host result', async (t) => {
  t.after(dispose);
  const host = fakeHost();
  const stopped = entry({}, { status: 'cancelled', completedAt: 2000 });
  host.stopReply = { kind: 'completed', value: { resource: stopped } };
  const { model } = await openAgentCommand(host);

  assert.equal(model.agentOwned(), true);
  await model.stop();

  assert.deepEqual(host.stops, [{ sessionId: 'S', ref: 'r1' }]);
  assert.equal(model.entry().result.status, 'cancelled');
  assert.equal(model.running(), false);
  assert.equal(model.stopping(), false);
});

test('a shared agent command is not stopped', async (t) => {
  t.after(dispose);
  const host = fakeHost();
  const { model } = await openAgentCommand(host, entry({ ownership: { kind: 'remote' } }));

  await model.stop();

  assert.deepEqual(host.stops, []);
});

test('stop waits for an earlier unconfirmed terminal operation', async (t) => {
  t.after(dispose);
  const host = fakeHost();
  host.pending = [{ id: 'op-1' }];
  host.holdRecovery = true;
  const { model } = await openAgentCommand(host);

  await model.stop();

  assert.deepEqual(host.stops, []);
  assert.equal(model.running(), true);
});

test('a stop whose reply is lost goes through terminal operation recovery', async (t) => {
  t.after(dispose);
  const host = fakeHost();
  const { terminals, model } = await openAgentCommand(host);
  host.stopReply = new Error('connection lost');
  // The Host recorded the stop, but its reply never arrived.
  host.beforeReply = () => {
    host.pending = [{ id: 'op-1' }];
  };

  await model.stop();
  await settle();

  assert.match(model.error(), /connection lost/);
  assert.deepEqual(host.recovered, ['op-1']);
  assert.deepEqual(terminals.pending(), []);
});
