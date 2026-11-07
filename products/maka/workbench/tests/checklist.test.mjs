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
    export const cleanup = fn => globalThis.checklistScope.push(fn);`,
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
const { checklistPosition, createChecklistState } = await import(
  new URL('checklistState.ts', appRoot)
);
hooks.deregister();

// Lets every pending continuation run, however many awaits it takes.
const flush = () => new Promise((resolve) => setImmediate(resolve));
// What `promise` settled to once nothing else is pending; 'pending' while it still waits.
async function settled(promise) {
  let result = 'pending';
  promise.then((value) => {
    result = value;
  });
  await flush();
  return result;
}

const item = (content, status) => ({ content, status });
const page = (revision, items, { total = items.length, offset = 0, nextOffset = null } = {}) => ({
  enabled: true,
  revision,
  total,
  completed: items.filter((entry) => entry.status === 'completed').length,
  current: items.find((entry) => entry.status === 'in_progress') ?? null,
  offset,
  items,
  nextOffset,
});
const release = (statuses) =>
  ['Read the notes', 'Update the changelog', 'Build', 'Tag'].map((content, index) =>
    item(content, statuses[index]),
  );

// A checklist source whose watch delivers what the test pushes and whose
// reads the test answers one at a time.
function source() {
  const pushed = [];
  let waiting;
  const reads = [];
  return {
    reads,
    push(next) {
      if (waiting) {
        const resolve = waiting;
        waiting = undefined;
        resolve(next);
      } else pushed.push(next);
    },
    watch: async () => ({
      next: () =>
        pushed.length
          ? Promise.resolve(pushed.shift())
          : new Promise((resolve) => {
              waiting = resolve;
            }),
      close: async () => {},
    }),
    read(offset) {
      return new Promise((resolve, reject) => reads.push({ offset, resolve, reject }));
    },
  };
}

function setup(t) {
  globalThis.checklistScope = [];
  t.after(() => {
    for (const dispose of globalThis.checklistScope.reverse()) dispose();
    delete globalThis.checklistScope;
  });
}

test('the position is the item in progress, else the first one left to do', () => {
  assert.equal(checklistPosition(release(['completed', 'pending', 'in_progress', 'pending'])), 2);
  assert.equal(checklistPosition(release(['completed', 'completed', 'pending', 'pending'])), 2);
  assert.equal(
    checklistPosition(release(['completed', 'completed', 'completed', 'completed'])),
    -1,
  );
  assert.equal(checklistPosition([]), -1);
});

test('a hidden list stays hidden through progress and remounts until the list changes', async (t) => {
  setup(t);
  const watched = source();
  const state = createChecklistState(watched, 'hidden-session');
  watched.push(page(1, release(['completed', 'in_progress', 'pending', 'pending'])));
  await flush();
  assert.equal(state.shown(), true);

  state.hide();
  assert.equal(state.shown(), false);
  watched.push(page(2, release(['completed', 'completed', 'in_progress', 'pending'])));
  await flush();
  assert.equal(state.shown(), false, 'progress on the same list reopened it');

  const remounted = source();
  const again = createChecklistState(remounted, 'hidden-session');
  remounted.push(page(2, release(['completed', 'completed', 'in_progress', 'pending'])));
  const other = source();
  const elsewhere = createChecklistState(other, 'other-session');
  other.push(page(2, release(['completed', 'completed', 'in_progress', 'pending'])));
  await flush();
  assert.equal(again.shown(), false, 'returning to the conversation reopened it');
  assert.equal(elsewhere.shown(), true, 'hiding one conversation hid another');

  watched.push(page(3, [item('Publish', 'completed'), item('Announce', 'in_progress')]));
  await flush();
  assert.equal(state.shown(), true, 'a different list stayed hidden');
});

test('reveal reads past done pages until the item in progress arrives', async (t) => {
  setup(t);
  const watched = source();
  const state = createChecklistState(watched, 'reveal-session');
  const done = Array.from({ length: 20 }, (_, index) => item(`Step ${index + 1}`, 'completed'));
  watched.push(page(1, done, { total: 45, nextOffset: 20 }));
  await flush();

  // The list's own scroll asked for the next page first; reveal waits for it
  // instead of reading the same page again.
  void state.loadMore();
  const revealed = state.reveal(() => true);
  await flush();
  assert.deepEqual(
    watched.reads.map((read) => read.offset),
    [20],
  );
  watched.reads[0].resolve(
    page(
      1,
      done.map((entry) => ({ ...entry, content: `More ${entry.content}` })),
      { total: 45, offset: 20, nextOffset: 40 },
    ),
  );
  await flush();
  assert.deepEqual(
    watched.reads.map((read) => read.offset),
    [20, 40],
  );
  watched.reads[1].resolve(
    page(1, [item('Step 41', 'completed'), item('Step 42', 'in_progress')], {
      total: 45,
      offset: 40,
      nextOffset: 42,
    }),
  );
  await flush();
  assert.equal(watched.reads.length, 2, 'reveal read past the item in progress');
  assert.equal(await settled(revealed), 41);
  assert.equal(state.items().length, 42);
});

test('reveal does not read when the item is loaded, the list is done, or it is closed', async (t) => {
  setup(t);
  const watched = source();
  const state = createChecklistState(watched, 'still-session');
  watched.push(
    page(1, release(['completed', 'in_progress', 'pending', 'pending']), {
      total: 30,
      nextOffset: 4,
    }),
  );
  await flush();
  assert.equal(await settled(state.reveal(() => true)), 1);

  watched.push(
    page(2, release(['completed', 'completed', 'completed', 'completed']), {
      total: 30,
      nextOffset: 4,
    }),
  );
  await flush();
  assert.equal(await settled(state.reveal(() => false)), -1);

  watched.push(
    page(3, release(['completed', 'completed', 'completed', 'completed']), {
      total: 4,
      nextOffset: null,
    }),
  );
  await flush();
  assert.equal(await settled(state.reveal(() => true)), -1);
  assert.equal(watched.reads.length, 0);
});

test('reveal stops at a failed read and leaves the error to the list', async (t) => {
  setup(t);
  const watched = source();
  const state = createChecklistState(watched, 'failed-session');
  const done = Array.from({ length: 20 }, (_, index) => item(`Step ${index + 1}`, 'completed'));
  watched.push(page(1, done, { total: 25, nextOffset: 20 }));
  await flush();
  const revealed = state.reveal(() => true);
  await flush();
  watched.reads[0].reject(new Error('read failed'));
  assert.equal(await settled(revealed), -1);
  assert.ok(state.error(), 'the failed read left no error');
  assert.equal(watched.reads.length, 1);
});
