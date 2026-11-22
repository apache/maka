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
import { setImmediate as turn } from 'node:timers/promises';
import test from 'node:test';

const appRoot = new URL('../app/', import.meta.url);
const native = {
  nsh: `export const signal = initial => { let value = initial; const read = () => value; read.set = next => { value = next; }; return read; };
    export const cleanup = () => {}; export const effect = fn => fn(); export const untracked = fn => fn();`,
  grid: `export class TerminalGrid { apply(event) { return {after:event.sequence ?? 0, status:'live'}; } discardDisplay() {} reset() {} }`,
  locale: `export const tr = key => key;`,
  host: `const unused = () => { throw new Error('Unexpected Session host call'); };
    export const terminalMutation = (...args) => globalThis.terminalTestHost.mutate(...args); export const pendingTerminals = (...args) => globalThis.terminalTestHost.pending(...args); export const recoverTerminal = (...args) => globalThis.terminalTestHost.recover(...args); export const abandonTerminal = unused;`,
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    let key;
    if (specifier === 'nsh') key = 'nsh';
    else if (specifier === 'maka/host') key = 'grid';
    else if (context.parentURL?.startsWith(appRoot.href)) {
      if (specifier === './host') key = 'host';
      else if (specifier === './locale') key = 'locale';
      else if (specifier.startsWith('.') && !/\.\w+$/.test(specifier))
        return next(`${specifier}.ts`, context);
    }
    return key
      ? { url: `data:text/javascript,${encodeURIComponent(native[key])}`, shortCircuit: true }
      : next(specifier, context);
  },
});
const { createTerminalPresentation, createTerminals } = await import(
  new URL('terminalState.ts', appRoot)
);
hooks.deregister();

function stream() {
  const values = [];
  const waiting = [];
  let ended = false;
  let cancelled = false;
  const end = () => {
    ended = true;
    for (const resolve of waiting.splice(0)) resolve(null);
  };
  return {
    push(value) {
      const resolve = waiting.shift();
      if (resolve) resolve(value);
      else values.push(value);
    },
    end,
    next() {
      return values.length
        ? Promise.resolve(values.shift())
        : ended
          ? Promise.resolve(null)
          : new Promise((resolve) => waiting.push(resolve));
    },
    async close() {
      cancelled = true;
      end();
    },
    cancelled: () => cancelled,
  };
}
const entry = (status = 'running', mode = 'pty') => ({
  ownership: { kind: 'local' },
  visibility: 'user',
  result: {
    kind: 'shell_run',
    ref: 'shell:original',
    mode,
    status,
    cwd: '/workspace',
    cmd: 'read value',
    startedAt: 1,
    updatedAt: 2,
    revision: 1,
  },
});
const completed = (value) => ({ kind: 'completed', value });
async function setup(t, initial = entry()) {
  const resource = stream();
  const output = stream();
  const lease = stream();
  const reconnectedOutput = stream();
  const outputs = [output, reconnectedOutput];
  output.push(
    completed({
      kind: 'data',
      sequence: 1,
      initialSize: { cols: 80, rows: 24 },
      size: { cols: 80, rows: 24 },
      dataBase64: '',
    }),
  );
  const unused = () => {
    throw new Error('Unexpected terminal operation');
  };
  const model = createTerminalPresentation(
    initial,
    {
      watch: async () => resource,
      watchOutput: async () => outputs.shift(),
      readDisplay: unused,
      acquire: async () => lease,
      control: async (input) =>
        completed({
          controllerId: input.controllerId,
          sequence: input.sequence,
          acceptedBytes: 0,
          resized: !!input.size,
          resizeChanged: false,
        }),
      release: async () => {},
      stop: unused,
    },
    { admitted: () => true, removed: () => {} },
  );
  t.mock.method(console, 'warn', () => {});
  t.after(async () => {
    model.dispose();
    await turn();
  });
  model.activate();
  await turn();
  return { model, resource, output, lease, reconnectedOutput };
}

test('a settled resource observation can end without manufacturing an output error', async (t) => {
  const { model, resource } = await setup(t, entry('running', 'pipes'));
  resource.push(completed(entry('completed', 'pipes')));
  resource.end();
  await turn();
  assert.equal(model.entry().result.status, 'completed');
  assert.equal(model.error(), '');
});
test('EOF while the resource is active remains an observation failure', async (t) => {
  const { model, resource } = await setup(t, entry('running', 'pipes'));
  resource.push(completed(entry('running', 'pipes')));
  resource.end();
  await turn();
  assert.notEqual(model.error(), '');
});
test('retry after a PTY output failure can draw output again', async (t) => {
  const { model, output, reconnectedOutput } = await setup(t);
  output.end();
  await turn();
  assert.equal(model.state(), 'failed');
  model.retry();
  reconnectedOutput.push(completed({ kind: 'data', sequence: 1 }));
  await turn();
  assert.equal(model.state(), 'live');
  assert.equal(model.error(), '');
});
test('a seeded completed entry does not excuse an empty resource observation', async (t) => {
  const { model, resource } = await setup(t, entry('completed', 'pipes'));
  resource.end();
  await turn();
  assert.notEqual(model.error(), '');
});
test('an explicit failure after a settled resource is still reported', async (t) => {
  const { model, resource } = await setup(t, entry('running', 'pipes'));
  resource.push(completed(entry('completed', 'pipes')));
  resource.push({ kind: 'failed', message: 'authority revoked' });
  await turn();
  assert.notEqual(model.error(), '');
});
test('a settled list update does not substitute for the terminal output end marker', async (t) => {
  const { model, output } = await setup(t);
  model.update(entry('completed'));
  assert.equal(model.error(), '');
  output.end();
  await turn();
  assert.notEqual(model.error(), '');
});
async function acquire(t) {
  const state = await setup(t);
  state.lease.push(
    completed({
      controllerId: 'original-controller',
      nextSequence: 1,
      held: true,
      resource: entry(),
    }),
  );
  state.model.takeControl();
  await turn();
  assert.equal(state.model.control(), 'held');
  return state;
}
test('lease release after confirmed process completion is not another controller', async (t) => {
  const { model, lease, output } = await acquire(t);
  lease.push(
    completed({
      controllerId: 'original-controller',
      nextSequence: null,
      held: false,
      resource: entry('completed'),
    }),
  );
  lease.end();
  await turn();
  assert.equal(model.entry().result.status, 'completed');
  assert.equal(model.control(), 'none');
  assert.equal(model.error(), '');
  assert.equal(output.cancelled(), false);
});
test('lease release while the resource remains active still reports loss of input', async (t) => {
  const { model, lease } = await acquire(t);
  lease.push(
    completed({
      controllerId: 'original-controller',
      nextSequence: null,
      held: false,
      resource: entry(),
    }),
  );
  lease.end();
  await turn();
  assert.equal(model.control(), 'refused');
  assert.notEqual(model.error(), '');
});

test('a live PTY draws output and gets its exit status from the terminal list', async (t) => {
  const sessionId = 'session-one';
  const initial = { ...entry(), sessionId };
  const list = stream();
  const output = stream();
  const detail = stream();
  const subscriptions = [];
  let active = true;
  let model;
  globalThis.terminalTestHost = { pending: async () => [], mutate: async () => completed(initial) };
  const terminals = createTerminals(
    {
      session: (id) => ({ sessionId: id }),
      async subscribe(_service, method) {
        subscriptions.push(method);
        return { watchList: list, watchOutput: output, watch: detail }[method];
      },
    },
    {
      sessionId: () => sessionId,
      active: () => active,
      open: (_entry, opened) => (model = opened),
    },
  );
  t.after(async () => {
    active = false;
    model?.dispose();
    await list.close();
  });
  await terminals.start();
  model.activate();
  output.push(completed({ kind: 'data', sequence: 1 }));
  await turn();
  assert.equal(model.state(), 'live');
  assert.equal(subscriptions.includes('watch'), false);
  list.push(completed({ resources: [{ ...entry('completed'), sessionId }], nextOffset: null }));
  output.push(completed({ kind: 'closed' }));
  await turn();
  assert.equal(model.entry().result.status, 'completed');
  assert.equal(model.state(), 'closed');
  assert.equal(model.error(), '');
});

test('each Action sends a complete launch request and opens its original terminal', async () => {
  const calls = [];
  const receipts = [Promise.withResolvers(), Promise.withResolvers()];
  const opened = [];
  const sessionId = 'session-one';
  const command = 'printf "%s" ready\nfalse';
  globalThis.terminalTestHost = {
    pending: async () => [],
    async mutate(owner, method, input) {
      const index = calls.length;
      calls.push([method, input]);
      assert.equal(method, 'startWithCommand');
      await receipts[index].promise;
      return completed({
        ...entry(),
        sessionId: owner.sessionId,
        result: { ...entry().result, ref: 'shell:' + index },
      });
    },
  };
  const terminals = createTerminals(
    {
      session: (id) => ({ sessionId: id }),
      async subscribe() {
        throw new Error('The UI must not acquire a lease to submit an Action.');
      },
    },
    {
      sessionId: () => sessionId,
      active: () => false,
      open: (value) => opened.push(value.result.ref),
    },
  );
  const first = terminals.runCommand(command);
  const second = terminals.runCommand(command);
  const start = [
    'startWithCommand',
    { sessionId, size: { cols: 80, rows: 24 }, initialCommand: command },
  ];
  assert.deepEqual(calls, [start, start]);

  for (const [index, action] of [
    [1, second],
    [0, first],
  ]) {
    receipts[index].resolve();
    terminals.open(await action);
  }
  assert.deepEqual(calls, [start, start]);
  assert.deepEqual(opened, ['shell:1', 'shell:0']);
});

test('a lost Action start reply reads the original terminal without resubmitting', async () => {
  const sessionId = 'session-one';
  const ref = 'shell:original';
  const original = { id: 'original-operation', method: 'startWithCommand' };
  const calls = [];
  let pending = [];
  const resource = {
    ...entry(),
    sessionId,
    correlation: { operationId: original.id, initialCommandDelivery: 'pending' },
    result: { ...entry().result, ref, revision: 2 },
  };
  globalThis.terminalTestHost = {
    pending: async () => pending,
    async mutate(_owner, method, input) {
      calls.push([method, input]);
      pending = [original];
      throw new Error('Action start reply lost');
    },
    async recover(_owner, id) {
      assert.equal(id, original.id);
      pending = [];
      return {
        reference: { operation: id },
        receipt: {
          kind: 'recorded',
          outcome: { kind: 'returned', result: { kind: 'success', value: completed(resource) } },
        },
      };
    },
  };
  const terminals = createTerminals(
    {
      session: (id) => ({ sessionId: id }),
      async query(service, method, target) {
        calls.push([service, method, target]);
        return completed({
          ...resource,
          correlation: { ...resource.correlation, initialCommandDelivery: 'submitted' },
          result: { ...resource.result, revision: 3 },
        });
      },
    },
    {
      sessionId: () => sessionId,
      active: () => false,
      open: () => assert.fail('Recovery should preserve the current focus'),
    },
  );
  assert.equal(await terminals.runCommand('echo once'), undefined);
  await terminals.recover({ sessionId, id: original.id, abandon: false });
  assert.deepEqual(calls, [
    ['startWithCommand', { sessionId, size: { cols: 80, rows: 24 }, initialCommand: 'echo once' }],
    ['terminal', 'read', { sessionId, ref }],
  ]);
  assert.equal(terminals.entries()[0].value().correlation.initialCommandDelivery, 'submitted');
  assert.deepEqual(terminals.pending(), []);
});
