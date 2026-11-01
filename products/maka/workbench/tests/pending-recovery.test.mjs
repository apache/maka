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
      globalThis.recoveryScope.push(() => { alive = false; });
      run();
    };
    export const cleanup = fn => globalThis.recoveryScope.push(fn);`,
  locale: `export const tr = key => key;`,
  'maka/host': `export class TerminalGrid {}`,
  host: `export const findUpload = (...args) => globalThis.uploadBoundary.find(...args);
    export const recoverUpload = (...args) => globalThis.uploadBoundary.recover(...args);
    export const watchUploads = (...args) => globalThis.uploadBoundary.watch(...args);
    export const terminalMutation = (...args) => globalThis.terminalBoundary.mutate(...args);
    export const pendingTerminals = (...args) => globalThis.terminalBoundary.pending(...args);
    export const recoverTerminal = (...args) => globalThis.terminalBoundary.recover(...args);
    export const abandonTerminal = () => { throw new Error('unexpected manual abandonment'); };`,
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    let key = specifier;
    if (context.parentURL?.startsWith(appRoot.href)) {
      if (specifier === './locale') key = 'locale';
      if (specifier === './host') key = 'host';
    }
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
const { createPendingRecovery } = await import(new URL('pendingRecovery.ts', appRoot));
const { createAttachmentDraft } = await import(new URL('attachmentDraft.ts', appRoot));
const { createRootUiSettings } = await import(new URL('rootUiSettingsState.ts', appRoot));
const { createTerminals } = await import(new URL('terminalState.ts', appRoot));
const { signal } = await import('nsh');
hooks.deregister();

function setup(t) {
  globalThis.recoveryScope = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    for (const dispose of globalThis.recoveryScope.reverse()) dispose();
    delete globalThis.recoveryScope;
    delete globalThis.uploadBoundary;
    delete globalThis.terminalBoundary;
  });
}
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
async function tick(t, delay = 0) {
  t.mock.timers.tick(delay);
  await flush();
}
function stream(initial) {
  const queue = [initial];
  let waiting;
  return {
    next: () =>
      queue.length
        ? Promise.resolve(queue.shift())
        : new Promise((resolve) => {
            waiting = resolve;
          }),
    push(value) {
      if (waiting) {
        const resolve = waiting;
        waiting = undefined;
        resolve(value);
      } else queue.push(value);
    },
    close() {
      this.push(null);
    },
  };
}

test('recovery retries after a rejection, respects busy state and cancels on disposal', async (t) => {
  setup(t);
  const warnings = t.mock.method(console, 'warn', () => {});
  const pending = signal(true);
  const blocked = signal(true);
  let calls = 0;
  createPendingRecovery({
    pending,
    blocked,
    recover: async () => {
      calls++;
      if (calls === 1) throw new Error('offline');
      if (calls === 3) pending.set(false);
    },
  });
  await tick(t);
  assert.equal(calls, 0);
  blocked.set(false);
  await tick(t);
  assert.equal(calls, 1);
  assert.equal(warnings.mock.callCount(), 1);
  await tick(t, 2000);
  assert.equal(calls, 2);
  await tick(t, 2000);
  assert.equal(calls, 3);
  await tick(t, 10000);
  assert.equal(calls, 3);
  pending.set(true);
  for (const dispose of globalThis.recoveryScope.reverse()) dispose();
  await tick(t, 2000);
  assert.equal(calls, 3);
});

test('an in-flight recovery is never started a second time by state changes', async (t) => {
  setup(t);
  const pending = signal(true);
  const blocked = signal(false);
  let release;
  let calls = 0;
  createPendingRecovery({
    pending,
    blocked,
    recover: () => {
      calls++;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  await tick(t);
  blocked.set(true);
  blocked.set(false);
  await tick(t, 4000);
  assert.equal(calls, 1);
  pending.set(false);
  release();
  await flush();
  await tick(t, 4000);
  assert.equal(calls, 1);
});

test('automatic upload recovery adopts the returned attachment once and preserves sent removal', async (t) => {
  setup(t);
  const initial = { id: 'operation', upload: { name: 'image.png' }, reference: {} };
  const attachment = {
    sessionId: 'session',
    id: 'asset',
    name: 'image.png',
    mimeType: 'image/png',
    bytes: 42,
  };
  const complete = {
    ...initial,
    receipt: {
      kind: 'recorded',
      outcome: { kind: 'returned', value: { kind: 'uploaded', attachment } },
    },
  };
  const updates = stream([initial]);
  let calls = 0;
  let changes = 0;
  globalThis.uploadBoundary = {
    watch: () => updates,
    find: async () => {
      throw new Error('not a local selection');
    },
    recover: async (_, id) => {
      calls++;
      assert.equal(id, initial.id);
      return complete;
    },
  };
  const draft = createAttachmentDraft({
    sessionId: 'session',
    client: {},
    changed: () => changes++,
    focus() {},
  });
  await tick(t);
  await tick(t, 2000);
  assert.equal(calls, 1);
  assert.deepEqual(draft.files(), [
    { id: 'asset', name: 'image.png', mimeType: 'image/png', bytes: 42 },
  ]);
  assert.equal(changes, 1);
  const snapshot = draft.snapshot();
  assert.deepEqual(snapshot.settledUploads, ['operation']);
  draft.saved(snapshot);
  draft.sent(['asset']);
  updates.push([complete]);
  await flush();
  assert.deepEqual(draft.files(), []);
  assert.deepEqual(draft.rows(), []);
  await tick(t, 4000);
  assert.equal(calls, 1);
});

test('unresolved uploads remain pending and are observed again without duplicating uploads', async (t) => {
  setup(t);
  const original = {
    id: 'pending',
    upload: { name: 'pending.txt' },
    reference: {},
    receipt: { kind: 'recorded', outcome: { kind: 'unresolved' } },
  };
  let recoveries = 0;
  globalThis.uploadBoundary = {
    watch: () => stream([original]),
    recover: async () => {
      recoveries++;
      return original;
    },
  };
  const draft = createAttachmentDraft({
    sessionId: 'session',
    client: {},
    changed() {
      assert.fail('nothing was uploaded');
    },
    focus() {},
  });
  await tick(t);
  await tick(t, 2000);
  await tick(t, 2000);
  assert.equal(recoveries, 2);
  assert.equal(draft.rows()[0].kind, 'unknown');
  assert.equal(draft.blocked(), 'Checking upload status…');
  assert.deepEqual(draft.files(), []);
});

test('upload observation reconnects automatically after disconnection', async (t) => {
  setup(t);
  t.mock.method(console, 'warn', () => {});
  let watches = 0;
  globalThis.uploadBoundary = {
    watch: () => {
      watches++;
      return watches === 1
        ? {
            next: async () => {
              throw new Error('offline');
            },
            close() {},
          }
        : stream([]);
    },
  };
  const draft = createAttachmentDraft({
    sessionId: 'session',
    client: {},
    changed() {},
    focus() {},
  });
  await tick(t);
  await tick(t, 2000);
  assert.equal(watches, 2);
  assert.equal(draft.restoring(), false);
  assert.equal(draft.blocked(), '');
});

test('a locally selected upload retries exact lookup and adopts its original result', async (t) => {
  setup(t);
  let lookups = 0;
  const original = {
    id: 'selected',
    upload: { name: 'notes.txt' },
    receipt: {
      kind: 'recorded',
      outcome: {
        kind: 'returned',
        value: {
          kind: 'uploaded',
          attachment: {
            sessionId: 'session',
            id: 'notes',
            name: 'notes.txt',
            mimeType: 'text/plain',
            bytes: 8,
          },
        },
      },
    },
  };
  globalThis.uploadBoundary = {
    watch: () => stream([]),
    find: async (_, id) => {
      lookups++;
      assert.equal(id, 'selected');
      if (lookups === 1) throw new Error('temporary lookup failure');
      return original;
    },
    recover: async () => assert.fail('an exact lookup already returned a completed upload'),
  };
  const draft = createAttachmentDraft({
    sessionId: 'session',
    client: {},
    changed() {},
    focus() {},
  });
  draft.status({ operationId: 'selected', kind: 'complete', name: 'notes.txt' });
  await flush();
  await tick(t);
  await tick(t, 2000);
  assert.equal(lookups, 2);
  assert.equal(draft.files()[0].id, 'notes');
  assert.deepEqual(draft.rows(), []);
});

test('interface recovery observes reserved and unresolved operations without repeating replacement', async (t) => {
  setup(t);
  const active = signal(false);
  let pending = [
    { id: 'interface', method: 'replaceSource', correlation: { import: 'management' } },
  ];
  let recoveries = 0;
  const owner = createRootUiSettings(
    {
      contributions: () => [],
      root: () => null,
      source: () => ({ revision: 1 }),
    },
    {
      services: {
        management: [
          {
            query: () => assert.fail('recovery does not reconstruct the replacement'),
            mutation: () => assert.fail('recovery does not repeat the replacement'),
          },
        ],
      },
      operations: {
        pending: async () => pending,
        recover: async (id) => {
          assert.equal(id, 'interface');
          recoveries++;
          if (recoveries === 1)
            return { receipt: { kind: 'recorded', outcome: { kind: 'unresolved' } } };
          pending = [];
          return {
            receipt: {
              kind: 'recorded',
              outcome: { kind: 'returned', value: { status: 'committed' } },
            },
          };
        },
      },
    },
    active,
  );
  await tick(t);
  assert.equal(recoveries, 0);
  active.set(true);
  await tick(t);
  assert.equal(recoveries, 1);
  assert.equal(owner.pending().length, 1);
  assert.equal(owner.disabled(), true);
  await tick(t, 2000);
  assert.equal(recoveries, 2);
  assert.equal(owner.disabled(), false);
  assert.equal(owner.notice(), 'Interface selected.');
});

for (const terminal of ['uploaded', 'abandoned']) {
  test(`a successful ${terminal} observation clears an earlier recovery failure`, async (t) => {
    setup(t);
    t.mock.method(console, 'warn', () => {});
    const original = { id: 'recovering-upload', upload: { name: 'file.txt' }, reference: {} };
    const updates = stream([original]);
    globalThis.uploadBoundary = {
      watch: () => updates,
      recover: async () => {
        throw new Error('upload is still being prepared');
      },
    };
    const draft = createAttachmentDraft({
      sessionId: 'session',
      client: {},
      changed() {},
      focus() {},
    });
    await tick(t);
    await tick(t, 2000);
    assert.notEqual(draft.error(), '');
    if (terminal === 'uploaded') {
      updates.push([
        {
          ...original,
          receipt: {
            kind: 'recorded',
            outcome: {
              kind: 'returned',
              value: {
                kind: 'uploaded',
                attachment: {
                  sessionId: 'session',
                  id: 'ready-file',
                  name: 'file.txt',
                  mimeType: 'text/plain',
                  bytes: 8,
                },
              },
            },
          },
        },
      ]);
    } else updates.push([{ ...original, abandoned: true }]);
    await flush();
    assert.equal(draft.error(), '');
    if (terminal === 'uploaded') assert.equal(draft.files()[0].id, 'ready-file');
    else {
      assert.equal(draft.rows()[0].kind, 'failed');
      draft.remove({ owner: 'session', id: original.id });
    }
    assert.equal(draft.blocked(), '');
  });
}

test('a successful exact recovery keeps the observer disconnection visible until reconnection', async (t) => {
  setup(t);
  t.mock.method(console, 'warn', () => {});
  const original = { id: 'upload', upload: { name: 'file.txt' }, reference: {} };
  const complete = {
    ...original,
    receipt: {
      kind: 'recorded',
      outcome: {
        kind: 'returned',
        value: {
          kind: 'uploaded',
          attachment: {
            sessionId: 'session',
            id: 'file',
            name: 'file.txt',
            mimeType: 'text/plain',
            bytes: 8,
          },
        },
      },
    },
  };
  const updates = stream([original]);
  let finishRecovery;
  let watches = 0;
  globalThis.uploadBoundary = {
    watch: () => (++watches === 1 ? updates : stream([complete])),
    recover: () =>
      new Promise((resolve) => {
        finishRecovery = resolve;
      }),
  };
  const draft = createAttachmentDraft({
    sessionId: 'session',
    client: {},
    changed() {},
    focus() {},
  });
  await tick(t);
  await tick(t, 2000);
  updates.push(null);
  await flush();
  const disconnected = draft.error();
  assert.notEqual(disconnected, '');
  finishRecovery(complete);
  await flush();
  assert.equal(draft.files()[0].id, 'file');
  assert.equal(draft.error(), disconnected);
  assert.notEqual(draft.blocked(), '');
  await tick(t, 2000);
  assert.equal(watches, 2);
  assert.equal(draft.error(), '');
  assert.equal(draft.blocked(), '');
});

test('a late recovery failure cannot block an upload already confirmed by observation', async (t) => {
  setup(t);
  t.mock.method(console, 'warn', () => {});
  const original = { id: 'upload', upload: { name: 'file.txt' }, reference: {} };
  const updates = stream([original]);
  let failRecovery;
  globalThis.uploadBoundary = {
    watch: () => updates,
    recover: () =>
      new Promise((_, reject) => {
        failRecovery = reject;
      }),
  };
  const draft = createAttachmentDraft({
    sessionId: 'session',
    client: {},
    changed() {},
    focus() {},
  });
  await tick(t);
  await tick(t, 2000);
  updates.push([
    {
      ...original,
      receipt: {
        kind: 'recorded',
        outcome: {
          kind: 'returned',
          value: {
            kind: 'uploaded',
            attachment: {
              sessionId: 'session',
              id: 'file',
              name: 'file.txt',
              mimeType: 'text/plain',
              bytes: 8,
            },
          },
        },
      },
    },
  ]);
  await flush();
  failRecovery(new Error('late recovery transport failure'));
  await flush();
  assert.equal(draft.files()[0].id, 'file');
  assert.equal(draft.error(), '');
  assert.equal(draft.blocked(), '');
});

test('terminal controls become available after their initial status read fails without replaying input', async (t) => {
  setup(t);
  t.mock.method(console, 'warn', () => {});
  let reads = 0;
  let mutations = 0;
  globalThis.terminalBoundary = {
    pending: async () => {
      if (++reads === 1) throw new Error('temporary transport interruption');
      return [];
    },
    mutate: () => {
      mutations++;
      throw new Error('no user action was requested');
    },
    recover: () => {
      throw new Error('no original operation exists');
    },
  };
  const scope = { sessionId: 'session' };
  const model = createTerminals(
    {
      session: () => scope,
      subscribe: async () => ({ next: () => new Promise(() => {}), close: async () => {} }),
    },
    { sessionId: () => 'session', active: () => true, open() {} },
  );
  await flush();
  assert.equal(model.known(), false);
  await tick(t);
  assert.equal(model.known(), true);
  assert.deepEqual(model.pending(), []);
  assert.equal(mutations, 0);
});

test('a late unresolved recovery cannot resurrect an upload already ended by observation', async (t) => {
  setup(t);
  const original = {
    id: 'upload',
    upload: { name: 'file.txt' },
    reference: {},
    receipt: { kind: 'recorded', outcome: { kind: 'unresolved' } },
  };
  const updates = stream([original]);
  let finishRecovery;
  let recoveries = 0;
  globalThis.uploadBoundary = {
    watch: () => updates,
    recover: () => {
      recoveries++;
      return new Promise((resolve) => {
        finishRecovery = resolve;
      });
    },
  };
  const draft = createAttachmentDraft({
    sessionId: 'session',
    client: {},
    changed() {},
    focus() {},
  });
  await tick(t);
  await tick(t, 2000);
  updates.push([{ ...original, abandoned: true }]);
  await flush();
  finishRecovery(original);
  await flush();
  assert.equal(draft.rows()[0].kind, 'failed');
  draft.remove({ owner: 'session', id: original.id });
  assert.equal(draft.blocked(), '');
  await tick(t, 2000);
  assert.equal(recoveries, 1);
});
