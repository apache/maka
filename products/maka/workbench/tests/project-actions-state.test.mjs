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
import { randomUUID } from 'node:crypto';
import { setImmediate as turn } from 'node:timers/promises';
import test from 'node:test';

const appRoot = new URL('../app/', import.meta.url);
const native = {
  nsh: `let tracking;
    let scope;
    export const mount = fn => {
      const previous = scope;
      const owned = [];
      scope = owned;
      try { return { value: fn(), dispose: () => { for (const dispose of owned.toReversed()) dispose(); } }; }
      finally { scope = previous; }
    };
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
      cleanup(() => { alive = false; });
      run();
    };
    export const cleanup = fn => scope.push(fn);
    export const context = initial => ({ value: initial });`,
  host: `export const host = {}; export class TerminalGrid {}`,
  locale: `export const tr = (key, values) =>
    Object.entries(values ?? {}).reduce((text, [name, value]) => text.replace('{' + name + '}', value), key);`,
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    let key;
    if (specifier === 'nsh') key = 'nsh';
    else if (specifier === 'maka/host') key = 'host';
    else if (context.parentURL?.startsWith(appRoot.href) && specifier === './locale')
      key = 'locale';
    else if (specifier.startsWith('.') && !/\.\w+$/.test(specifier))
      return next(`${specifier}.ts`, context);
    return key
      ? { url: `data:text/javascript,${encodeURIComponent(native[key])}`, shortCircuit: true }
      : next(specifier, context);
  },
});
const { createProjectActions: settingsActions } = await import(
  new URL('projectActionsState.ts?settings', appRoot)
);
const { createProjectActions: conversationActions } = await import(
  new URL('projectActionsState.ts?conversation', appRoot)
);
const { mount, signal } = await import(`data:text/javascript,${encodeURIComponent(native.nsh)}`);
hooks.deregister();

const completed = (value) => ({ kind: 'completed', value });
const returned = (value) => ({
  receipt: { kind: 'recorded', outcome: { kind: 'returned', result: { kind: 'success', value } } },
});
const deferred = () => {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
};
function setup(t, { workspaceReadFailures = 0 } = {}) {
  const rows = new Map();
  const models = [];
  const calls = [];
  let sequence = 0;
  function open(factory, projectId, launch) {
    let pending = [];
    const receipts = new Map();
    const recoveredIds = [];
    let blockedJournal;
    let blockedRead;
    let failRead = false;
    let remainingWorkspaceFailures = workspaceReadFailures;
    let blockedMutation;
    let failed = false;
    let lostReply;
    let journalAvailable = true;
    let journalReadFailures = 0;
    const selection = signal(
      factory === settingsActions
        ? { kind: 'project', projectId, path: '/last-used' }
        : { kind: 'workspace', path: `/${projectId}` },
    );
    const queries = [];
    const context = {
      operations: {
        pending: async () => {
          if (!journalAvailable) {
            journalReadFailures++;
            throw new Error('Local operation log unavailable');
          }
          const snapshot = [...pending];
          if (blockedJournal) {
            const delay = blockedJournal;
            blockedJournal = undefined;
            await delay.promise;
          }
          return snapshot;
        },
        recover: async (id) => {
          assert.ok(
            pending.some((item) => item.id === id),
            'recover the original pending ID',
          );
          recoveredIds.push(id);
          const receipt = await receipts.get(id);
          if (receipt.receipt.kind === 'recorded')
            pending = pending.filter((item) => item.id !== id);
          return receipt;
        },
      },
      application: {
        async mutation(_endpoint, _method, input) {
          queries.push(input.kind);
          return { reply: returned({ kind: 'committed' }) };
        },
      },
    };
    const host = {
      async query(endpoint, method, input) {
        queries.push(method);
        if (endpoint === 'agent') {
          if (remainingWorkspaceFailures > 0) {
            remainingWorkspaceFailures--;
            throw new Error('Workspace lookup temporarily unavailable');
          }
          return {
            kind: 'directory',
            location: {
              project:
                input.path === '/unregistered' ? null : { reference: { id: input.path.slice(1) } },
            },
          };
        }
        if (method === 'definitions') {
          if (failRead) {
            failRead = false;
            throw new Error('Definitions temporarily unavailable');
          }
          const value = structuredClone(rows.get(input.projectId) ?? []);
          if (blockedRead) {
            const delay = blockedRead;
            blockedRead = undefined;
            await delay.promise;
          }
          return completed(value);
        }
        if (method === 'runs') return completed({ runs: [], next: null });
        throw new Error(`Unexpected query ${endpoint}.${method}`);
      },
      async projectActionMutation(method, input, started) {
        const operationId = `operation-${++sequence}`;
        started?.(operationId);
        calls.push({ method, input });
        if (method === 'select')
          return completed({
            id: randomUUID(),
            projectId: input.projectId,
            path: input.path,
            identity: 'identity',
            authority: 'authority',
          });
        if (blockedMutation) {
          const delay = blockedMutation;
          blockedMutation = undefined;
          await delay.promise;
        }
        if (failed) return { kind: 'failed', message: 'Action rejected' };
        const current = rows.get(input.projectId) ?? [];
        let result = null;
        if (method === 'remove') {
          rows.set(
            input.projectId,
            current.filter((row) => row.id !== input.id),
          );
        } else {
          result = {
            id: input.id ?? randomUUID(),
            projectId: input.projectId,
            revision: (input.revision ?? 0) + 1,
            name: input.name,
            command: input.command,
          };
          rows.set(input.projectId, [...current.filter((row) => row.id !== result.id), result]);
        }
        if (lostReply) {
          const outcome = lostReply;
          lostReply = undefined;
          pending = [
            ...pending,
            {
              id: operationId,
              endpoint: 'projectActions',
              method,
              correlation: { projectId: input.projectId },
            },
          ];
          receipts.set(operationId, outcome === 'success' ? returned(completed(result)) : outcome);
          throw new Error('Action reply lost after commit');
        }
        return completed(result);
      },
      subscribe() {
        throw new Error('Definition changes must not open terminals');
      },
    };
    const scope = mount(() => factory(context, host, selection, launch));
    models.push(scope);
    const model = scope.value;
    return {
      model,
      selection,
      queries,
      dispose: scope.dispose,
      loseNextReply(outcome = 'success') {
        lostReply = outcome;
      },
      failNextRead() {
        failRead = true;
      },
      blockRead() {
        return (blockedRead = deferred());
      },
      blockMutation() {
        return (blockedMutation = deferred());
      },
      fail() {
        failed = true;
      },
      setJournalAvailable(available) {
        journalAvailable = available;
      },
      journalReadFailures: () => journalReadFailures,
      recoveredIds,
      blockJournal() {
        return (blockedJournal = deferred());
      },
      recover(method, outcome, correlation, endpoint = 'projectActions') {
        const id = `operation-${++sequence}`;
        pending = [...pending, { id, endpoint, method, correlation }];
        receipts.set(id, Promise.resolve(outcome).then(returned));
        return id;
      },
    };
  }
  t.mock.method(console, 'warn', () => {});
  t.after(() => {
    for (const scope of models.toReversed()) scope.dispose();
  });
  return { rows, calls, open, projectId: randomUUID() };
}
async function ready(...views) {
  await turn();
  for (const { model } of views) {
    assert.equal(model.loading(), false);
    assert.equal(model.problem().message, '');
    assert.ok(model.directory());
  }
}

test('a confirmed create survives a failed list refresh and retry only reads definitions', async (t) => {
  const { open, calls, projectId } = setup(t);
  const view = open(settingsActions, projectId);
  await ready(view);
  view.failNextRead();
  const saved = await view.model.save(null, 'Build', 'make');
  assert.ok(saved.id);
  assert.deepEqual(view.model.definitions(), [saved]);
  assert.ok(view.model.problem().message);
  assert.equal(view.model.ready(), true, 'a list error does not block new commands');
  view.model.dismissError();
  assert.ok(view.model.problem().message, 'dismissing a command error preserves the list error');
  await view.model.problem().retry.run();
  assert.equal(view.model.problem().message, '');
  assert.deepEqual(view.model.definitions(), [saved]);
  assert.deepEqual(
    calls.map(({ method }) => method),
    ['create'],
  );
});

test('a transient journal read failure after saving recovers without replaying the save', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { open, rows, calls, projectId } = setup(t);
  const { model, setJournalAvailable } = open(settingsActions, projectId);
  await ready({ model });

  setJournalAvailable(false);
  await model.save(null, 'First', 'true');
  assert.deepEqual(
    rows.get(projectId).map(({ name }) => name),
    ['First'],
  );
  assert.equal(model.ready(), false);
  await model.save(null, 'Second', 'true');
  assert.equal(calls.length, 1);

  setJournalAvailable(true);
  t.mock.timers.tick(0);
  await turn();
  assert.equal(model.ready(), true);
  assert.equal(model.problem().message, '');
  assert.equal(calls.length, 1);
  await model.save(null, 'Second', 'true');
  assert.deepEqual(
    rows.get(projectId).map(({ name }) => name),
    ['First', 'Second'],
  );
});

test('a persistent journal failure keeps saving disabled and can be retried manually', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { open, calls, projectId } = setup(t);
  const settings = open(settingsActions, projectId);
  const { model } = settings;
  await ready(settings);

  settings.setJournalAvailable(false);
  await model.save(null, 'First', 'true');
  const failures = settings.journalReadFailures();
  t.mock.timers.tick(0);
  await turn();
  assert.equal(settings.journalReadFailures(), failures + 1);
  t.mock.timers.tick(2000);
  await turn();
  assert.equal(settings.journalReadFailures(), failures + 1, 'retry waits longer after a failure');
  t.mock.timers.tick(2000);
  await turn();
  assert.equal(settings.journalReadFailures(), failures + 2);
  assert.equal(model.ready(), false);
  assert.ok(model.problem().message);
  assert.equal(model.definitions()[0].name, 'First', 'a successful save retains its result');
  await model.save(null, 'Second', 'true');
  assert.equal(calls.length, 1);

  settings.setJournalAvailable(true);
  await model.problem().retry.run();
  assert.equal(model.ready(), true);
  assert.equal(model.problem().message, '');
  assert.equal(calls.length, 1);
});

test('Settings loads definitions by selected project ID when projects share a last-used path', async (t) => {
  const { open, rows, projectId } = setup(t);
  const otherProject = randomUUID();
  rows.set(projectId, [{ name: 'First project' }]);
  rows.set(otherProject, [{ name: 'Second project' }]);
  const settings = open(settingsActions, projectId);
  await ready(settings);
  assert.deepEqual(settings.model.definitions(), rows.get(projectId));

  settings.selection.set({ kind: 'project', projectId: otherProject, path: '/last-used' });
  await ready(settings);
  assert.deepEqual(settings.model.definitions(), rows.get(otherProject));
  assert.deepEqual(settings.queries, ['definitions', 'definitions']);
});

test('recovering a lost remove completes its original operation once', async (t) => {
  const { open, rows, projectId } = setup(t);
  const original = {
    id: randomUUID(),
    projectId,
    revision: 1,
    name: 'Remove',
    command: 'echo old',
  };
  rows.set(projectId, [original]);
  const settings = open(settingsActions, projectId);
  await ready(settings);
  let completions = 0;
  settings.loseNextReply();
  await settings.model.remove(original, () => completions++);
  assert.equal(completions, 0);
  await settings.model.recover();
  assert.equal(completions, 1);
  assert.deepEqual(settings.model.definitions(), []);
  await settings.model.recover();
  assert.equal(completions, 1);
});

test('a pending removal stays with its project across selection changes and recovers by original ID', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { open, rows, calls, projectId: a } = setup(t);
  const b = randomUUID();
  const select = (projectId) => ({ kind: 'project', projectId, path: '/shared' });
  const row = { id: randomUUID(), projectId: b, revision: 1, name: 'Old B', command: 'true' };
  rows.set(b, [row]);
  const settings = open(settingsActions, b);
  const aMenu = open(conversationActions, a);
  const bMenu = open(conversationActions, b);
  await ready(settings, aMenu, bMenu);
  const id = settings.recover('remove', completed(null), { projectId: a });
  const delayed = settings.blockJournal();
  settings.selection.set(select(a));
  settings.selection.set(select(b));
  await ready(settings);
  delayed.resolve();
  await turn();
  assert.equal(settings.model.ready(), true);
  assert.deepEqual(settings.model.definitions(), [row]);
  await settings.model.save(row, 'Edited B', 'echo B');
  assert.equal(settings.model.definitions()[0].name, 'Edited B');
  assert.deepEqual(settings.recoveredIds, []);

  settings.selection.set(select(a));
  await ready(settings);
  assert.equal(settings.model.ready(), false);
  await settings.model.save(null, 'Blocked A', 'false');
  assert.deepEqual(
    calls.map(({ input }) => input.projectId),
    [b],
  );
  const aReads = aMenu.queries.length;
  const bReads = bMenu.queries.length;
  await settings.model.recover();
  assert.deepEqual(settings.recoveredIds, [id]);
  assert.equal(settings.model.ready(), true);
  assert.equal(aMenu.queries.length, aReads + 1);
  assert.equal(bMenu.queries.length, bReads);
});

test('an in-flight receipt check for A allows editing B and its late reply only refreshes A', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { open, calls, projectId: a } = setup(t);
  const b = randomUUID();
  const settings = open(settingsActions, a);
  const aMenu = open(conversationActions, a);
  await ready(settings, aMenu);
  const delayed = deferred();
  const id = settings.recover('remove', delayed.promise, { projectId: a });
  const checking = settings.model.recover();
  await turn();
  assert.deepEqual(settings.recoveredIds, [id]);
  assert.equal(settings.model.performing(), false);
  settings.selection.set({ kind: 'project', projectId: b, path: '/b' });
  await ready(settings);
  const writing = settings.blockMutation();
  const saving = settings.model.save(null, 'New B', 'echo B');
  assert.deepEqual(
    calls.map(({ input }) => input.projectId),
    [b],
  );
  const bReads = settings.queries.length;
  const aReads = aMenu.queries.length;
  delayed.resolve(completed(null));
  await checking;
  assert.equal(aMenu.queries.length, aReads + 1);
  assert.equal(settings.queries.length, bReads);
  assert.equal(settings.model.performing(), true, 'B still owns its in-flight write');
  writing.resolve();
  await saving;
  assert.equal(settings.model.definitions()[0].name, 'New B');
});

test('legacy Action and agent project operations remain recoverable on another project', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { open, calls, projectId } = setup(t);
  const settings = open(settingsActions, projectId);
  const peer = open(conversationActions, projectId);
  await ready(settings, peer);
  const legacy = settings.recover('remove', completed(null), { kind: 'ui' });
  const register = settings.recover('project', { kind: 'committed' }, undefined, 'agent');
  settings.selection.set({ kind: 'project', projectId: randomUUID(), path: '/other' });
  await ready(settings);
  assert.equal(settings.model.ready(), false);
  await settings.model.save(null, 'Blocked', 'false');
  assert.deepEqual(calls, []);
  const reads = peer.queries.length;
  await settings.model.recover();
  assert.deepEqual(settings.recoveredIds, [legacy, register]);
  assert.equal(peer.queries.length, reads + 1);
});

test('an unregistered conversation directory stays ineligible for Actions', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { open, projectId } = setup(t, { workspaceReadFailures: 1 });
  const view = open(conversationActions, 'unregistered');
  await turn();
  t.mock.timers.tick(0);
  await turn();
  assert.deepEqual(view.queries, ['projects', 'projects']);
  assert.equal(view.model.directory(), null);
  assert.equal(view.model.problem().message, '');

  view.selection.set({ kind: 'workspace', path: `/${projectId}` });
  await ready(view);
  assert.equal(view.model.directory().projectId, projectId);
  assert.deepEqual(view.model.definitions(), []);

  view.selection.set({ kind: 'workspace', path: '/unregistered' });
  await turn();
  t.mock.timers.tick(30_000);
  await turn();
  assert.equal(view.model.directory(), null);
  assert.deepEqual(view.queries, ['projects', 'projects', 'projects', 'definitions', 'projects']);
});

test('Settings save refreshes a conversation whose first project lookup failed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { open, projectId } = setup(t, { workspaceReadFailures: 1 });
  const settings = open(settingsActions, projectId);
  const header = open(conversationActions, projectId);
  await ready(settings);
  assert.equal(header.model.directory(), null);

  const action = await settings.model.save(null, 'Run', 'echo ready');
  await ready(header);
  assert.deepEqual(header.model.definitions(), [action]);
  t.mock.timers.tick(2_000);
  await turn();
  assert.deepEqual(header.queries, ['projects', 'projects', 'definitions']);
});

test('an initial project lookup retries at the observation cadence without a settings save', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { open, projectId, calls } = setup(t, { workspaceReadFailures: 2 });
  const header = open(conversationActions, projectId);
  await turn();
  assert.deepEqual(header.queries, ['projects']);

  t.mock.timers.tick(0);
  await turn();
  t.mock.timers.tick(1_999);
  await turn();
  assert.deepEqual(header.queries, ['projects', 'projects']);
  assert.equal(header.model.directory(), null);

  t.mock.timers.tick(1);
  await ready(header);
  assert.equal(header.model.directory().projectId, projectId);
  assert.deepEqual(header.queries, ['projects', 'projects', 'projects', 'definitions']);
  assert.deepEqual(calls, []);
});

for (const method of ['create', 'update', 'remove']) {
  test(`Settings ${method} refreshes existing conversation Actions across bundle copies`, async (t) => {
    const { open, rows, projectId } = setup(t);
    const original = {
      id: randomUUID(),
      projectId,
      revision: 1,
      name: 'old',
      command: 'old-command',
    };
    if (method !== 'create') rows.set(projectId, [original]);
    const settings = open(settingsActions, projectId);
    const header = open(conversationActions, projectId);
    const other = open(conversationActions, randomUUID());
    await ready(settings, header, other);
    const otherReads = other.queries.length;
    const historyReads = header.queries.filter((method) => method === 'runs').length;
    const ownReads = settings.queries.filter((method) => method === 'definitions').length;
    if (method === 'remove') await settings.model.remove(original);
    else await settings.model.save(method === 'create' ? null : original, 'new', 'new-command');
    await turn();
    assert.deepEqual(header.model.definitions(), rows.get(projectId));
    assert.equal(other.queries.length, otherReads, 'other projects keep their own list');
    assert.equal(header.queries.filter((method) => method === 'runs').length, historyReads);
    assert.equal(
      settings.queries.filter((method) => method === 'definitions').length,
      ownReads + 1,
    );
    header.dispose();
    const closedReads = header.queries.length;
    await settings.model.save(null, 'another', 'another-command');
    await turn();
    assert.equal(header.queries.length, closedReads, 'closed surfaces unsubscribe');
  });
}

test('a delayed older definitions read cannot overwrite a newer mutation refresh', async (t) => {
  const { open, rows, projectId } = setup(t);
  const settings = open(settingsActions, projectId);
  const header = open(conversationActions, projectId);
  await ready(settings, header);
  const delayed = header.blockRead();
  const refreshing = header.model.refresh();
  await turn();
  await settings.model.save(null, 'new', 'new-command');
  await turn();
  delayed.resolve();
  await refreshing;
  assert.deepEqual(header.model.definitions(), rows.get(projectId));
});

test('a successful save still notifies peers after its Settings surface closes', async (t) => {
  const { open, rows, projectId } = setup(t);
  const settings = open(settingsActions, projectId);
  const header = open(conversationActions, projectId);
  await ready(settings, header);
  const delayed = settings.blockMutation();
  const saving = settings.model.save(null, 'new', 'new-command');
  settings.dispose();
  delayed.resolve();
  await saving;
  await turn();
  assert.deepEqual(header.model.definitions(), rows.get(projectId));
});

test('a save completing after a project switch refreshes its original project', async (t) => {
  const { open, rows, projectId } = setup(t);
  const settings = open(settingsActions, projectId);
  const header = open(conversationActions, projectId);
  const otherProject = randomUUID();
  const other = open(conversationActions, otherProject);
  await ready(settings, header, other);
  const delayed = settings.blockMutation();
  const saving = settings.model.save(null, 'original project', 'command');
  settings.selection.set({ kind: 'project', projectId: otherProject, path: '/last-used' });
  await ready(settings);
  const otherReads = other.queries.length;
  delayed.resolve();
  await saving;
  await turn();
  assert.deepEqual(header.model.definitions(), rows.get(projectId));
  assert.deepEqual(settings.model.definitions(), []);
  assert.equal(other.queries.length, otherReads);
});

for (const method of ['create', 'update', 'remove']) {
  test(`confirmed recovered ${method} refreshes peer definitions`, async (t) => {
    const { open, rows, projectId } = setup(t);
    const row = { id: randomUUID(), projectId, revision: 2, name: 'recovered', command: 'command' };
    if (method !== 'create') rows.set(projectId, [{ ...row, revision: 1, name: 'old' }]);
    const settings = open(settingsActions, projectId);
    const header = open(conversationActions, projectId);
    await ready(settings, header);
    rows.set(projectId, method === 'remove' ? [] : [row]);
    settings.recover(method, completed(method === 'remove' ? null : row));
    await settings.model.recover();
    await turn();
    assert.deepEqual(header.model.definitions(), rows.get(projectId));
  });
}

for (const method of ['create', 'update', 'remove']) {
  test(`failed ${method} does not invalidate peers`, async (t) => {
    const { open, projectId } = setup(t);
    const settings = open(settingsActions, projectId);
    const header = open(conversationActions, projectId);
    await ready(settings, header);
    const reads = header.queries.length;
    settings.fail();
    const original = { id: randomUUID(), projectId, revision: 1, name: 'old', command: 'command' };
    if (method === 'remove') await settings.model.remove(original);
    else await settings.model.save(method === 'update' ? original : null, 'new', 'command');
    assert.equal(header.queries.length, reads);
    settings.recover(method, { kind: 'failed', message: 'Action rejected' });
    await settings.model.recover();
    assert.equal(header.queries.length, reads);
  });
}

test('each Action activation launches a session terminal without selecting a directory or creating Action runs', async (t) => {
  const { open, rows, calls, projectId } = setup(t);
  const definition = {
    id: randomUUID(),
    projectId,
    revision: 1,
    name: 'dev',
    command: 'npm run dev',
  };
  rows.set(projectId, [definition]);
  const launched = [];
  const receipt = Promise.withResolvers();
  const view = open(conversationActions, projectId, async (action) => {
    launched.push(action);
    await receipt.promise;
  });
  await ready(view);
  const first = view.model.activate(definition);
  const second = view.model.activate(definition);
  assert.deepEqual(launched, [definition, definition]);
  receipt.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(calls, []);
  assert.ok(!view.queries.includes('runs'));
  view.selection.set(null);
  await view.model.activate(definition);
  assert.equal(launched.length, 2);
});

test('selection loading and disposal block commands through the same interface used by the UI', async (t) => {
  const { open, calls, projectId } = setup(t);
  const launched = [];
  const view = open(settingsActions, projectId, async (action) => launched.push(action));
  await ready(view);
  const otherProject = randomUUID();
  const definition = {
    id: randomUUID(),
    projectId: otherProject,
    revision: 1,
    name: 'Build',
    command: 'make',
  };
  const delayed = view.blockRead();
  view.selection.set({ kind: 'project', projectId: otherProject, path: '/other' });
  await turn();
  assert.equal(view.model.ready(), false);
  await view.model.save(null, 'Blocked', 'false');
  await view.model.remove(definition);
  await view.model.activate(definition);
  assert.deepEqual(calls, []);
  assert.deepEqual(launched, []);

  delayed.resolve();
  await ready(view);
  assert.equal(view.model.ready(), true);
  await view.model.activate(definition);
  assert.deepEqual(launched, [definition]);

  view.dispose();
  const reads = view.queries.length;
  assert.equal(view.model.ready(), false);
  await view.model.save(null, 'Closed', 'false');
  await view.model.remove(definition);
  await view.model.activate(definition);
  await view.model.refresh();
  await view.model.recover();
  assert.deepEqual(calls, []);
  assert.deepEqual(launched, [definition]);
  assert.equal(view.queries.length, reads);
});

test('the offered recovery action checks the original receipt and stays disabled while checking', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { open, calls, projectId } = setup(t);
  const view = open(settingsActions, projectId);
  await ready(view);
  const delayed = deferred();
  const id = view.recover('remove', delayed.promise, { projectId });
  view.selection.set({ kind: 'project', projectId, path: '/same-project' });
  await ready(view);
  assert.equal(view.model.ready(), false);
  assert.equal(view.model.problem().retry.enabled, true);
  const checking = view.model.problem().retry.run();
  await turn();
  assert.equal(view.model.problem().retry.enabled, false);
  await view.model.problem().retry.run();
  await view.model.save(null, 'Blocked', 'false');
  assert.deepEqual(view.recoveredIds, [id]);
  assert.deepEqual(calls, []);

  delayed.resolve(completed(null));
  await checking;
  assert.equal(view.model.ready(), true);
  assert.equal(view.model.problem().retry, null);
});

for (const factory of [conversationActions, settingsActions]) {
  test(`recovered create completes its original ${factory === conversationActions ? 'dialog' : 'settings'} save once`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { open, calls, rows, projectId } = setup(t);
    const view = open(factory, projectId);
    await ready(view);
    let closed = 0;
    view.loseNextReply();
    await view.model.save(null, 'Dev', 'npm run dev', () => closed++);
    assert.equal(closed, 0);
    assert.equal(view.model.ready(), false);
    await view.model.recover();
    assert.equal(closed, 1);
    assert.equal(view.model.ready(), true);
    await view.model.recover();
    assert.equal(closed, 1);
    assert.equal(rows.get(projectId).length, 1);
    assert.equal(calls.length, 1);
  });
}

test('recovering a historical create does not complete a new save', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { open, projectId } = setup(t);
  const view = open(settingsActions, projectId);
  await ready(view);
  let closed = 0;
  await view.model.save(null, 'Direct', 'true', () => closed++);
  assert.equal(closed, 1);
  view.recover('create', completed({ id: 'old', projectId }), { projectId });
  await view.model.recover();
  assert.equal(closed, 1);
});

test('switching projects or disposing ignores a late recovered save', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { open, projectId } = setup(t);
  for (const dispose of [false, true]) {
    const view = open(settingsActions, projectId);
    await ready(view);
    const receipt = deferred();
    let closed = 0;
    view.loseNextReply(receipt.promise);
    await view.model.save(null, 'Dev', 'true', () => closed++);
    const recovery = view.model.recover();
    await turn();
    if (dispose) view.dispose();
    else view.selection.set({ kind: 'project', projectId: randomUUID(), path: '/other' });
    receipt.resolve(returned(completed({ id: 'saved', projectId })));
    await recovery;
    assert.equal(closed, 0);
  }
});

test('unresolved and failed recovery do not complete a save', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { open, projectId } = setup(t);
  for (const receipt of [
    { kind: 'unknown' },
    {
      kind: 'recorded',
      outcome: { kind: 'returned', result: { kind: 'failure', diagnostic: 'rejected' } },
    },
    returned({ kind: 'failed', message: 'Action rejected' }).receipt,
  ]) {
    const view = open(settingsActions, projectId);
    await ready(view);
    let closed = 0;
    view.loseNextReply({ receipt });
    await view.model.save(null, 'Dev', 'true', () => closed++);
    await view.model.recover();
    assert.equal(closed, 0);
  }
});

for (const receipt of [
  returned({ kind: 'failed', message: 'Action rejected' }),
  {
    receipt: {
      kind: 'recorded',
      outcome: { kind: 'returned', result: { kind: 'failure', diagnostic: 'Action rejected' } },
    },
  },
]) {
  test(`settings reload definitions after a rejected ${receipt.receipt.outcome.result.kind} receipt`, async (t) => {
    const { open, rows, projectId } = setup(t);
    const original = {
      id: randomUUID(),
      projectId,
      revision: 1,
      name: 'Existing',
      command: 'true',
    };
    rows.set(projectId, [original]);
    const view = open(settingsActions, projectId);
    view.loseNextReply(receipt);
    await ready(view);
    await view.model.save(null, 'Lost edit', 'true');
    rows.set(projectId, [original]);
    const other = { kind: 'project', projectId: randomUUID(), path: '/other' };
    view.selection.set(other);
    view.selection.set({ kind: 'project', projectId, path: '/last-used' });
    await turn();

    assert.deepEqual(view.model.definitions(), [original]);
    assert.equal(view.model.ready(), false);

    const current = { ...original, name: 'Updated while offline', revision: 2 };
    rows.set(projectId, [current]);
    await view.model.recover();
    assert.deepEqual(view.model.definitions(), [current]);
    assert.match(view.model.problem().message, /Action rejected/);
    assert.equal(view.model.ready(), true);
  });
}
