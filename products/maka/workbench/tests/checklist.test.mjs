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
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';

const appRoot = new URL('../app/', import.meta.url);
const native = {
  nsh: `let currentEffect = null;
    let batchDepth = 0;
    const pendingEffects = new Set();
    const runEffect = effect => {
      for (const dep of effect.deps) dep.delete(effect);
      effect.deps.clear();
      const previous = currentEffect;
      currentEffect = effect;
      try {
        effect.fn();
      } finally {
        currentEffect = previous;
      }
    };
    export const batch = fn => {
      batchDepth += 1;
      try {
        return fn();
      } finally {
        batchDepth -= 1;
        if (batchDepth === 0) {
          while (pendingEffects.size > 0) {
            const next = [...pendingEffects];
            pendingEffects.clear();
            for (const effect of next) if (effect.active) runEffect(effect);
          }
        }
      }
    };
    export const untracked = fn => {
      const previous = currentEffect;
      currentEffect = null;
      try {
        return fn();
      } finally {
        currentEffect = previous;
      }
    };
    export const signal = initial => {
      let value = initial;
      const subscribers = new Set();
      const read = () => {
        if (currentEffect) {
          subscribers.add(currentEffect);
          currentEffect.deps.add(subscribers);
        }
        return value;
      };
      read.set = next => {
        if (Object.is(value, next)) return;
        value = next;
        for (const effect of [...subscribers]) {
          if (batchDepth > 0) pendingEffects.add(effect);
          else if (effect.active) runEffect(effect);
        }
      };
      return read;
    };
    export const effect = fn => {
      const entry = { fn, deps: new Set(), active: true };
      globalThis.checklistScope.push(() => {
        entry.active = false;
        for (const dep of entry.deps) dep.delete(entry);
        entry.deps.clear();
      });
      runEffect(entry);
    };
    export const computed = fn => {
      const out = signal(undefined);
      effect(() => out.set(fn()));
      return () => out();
    };
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
const { effect } = await import('data:text/javascript,' + encodeURIComponent(native.nsh));
const { createChecklistState } = await import(new URL('checklistState.ts', appRoot));
hooks.deregister();

const flush = () => new Promise((resolve) => setImmediate(resolve));
async function settled(promise) {
  let result = 'pending';
  promise.then((value) => {
    result = value;
  });
  await flush();
  return result;
}

const item = (content, status) => ({ content, status });
function digestOf(allItems) {
  if (!allItems.length) return null;
  const hash = createHash('sha256');
  const lenBuf = Buffer.alloc(8);
  lenBuf.writeBigUInt64LE(BigInt(allItems.length));
  hash.update(lenBuf);
  for (const entry of allItems) {
    const bytes = Buffer.from(entry.content, 'utf8');
    const itemLen = Buffer.alloc(8);
    itemLen.writeBigUInt64LE(BigInt(bytes.length));
    hash.update(itemLen);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function activeIndexOf(allItems) {
  const active = allItems.findIndex((entry) => entry.status === 'in_progress');
  if (active >= 0) return active;
  const pending = allItems.findIndex((entry) => entry.status !== 'completed');
  return pending >= 0 ? pending : null;
}

function slicePage(revision, allItems, offset = 0, limit = 20) {
  const total = allItems.length;
  const clamped = Math.min(offset, total);
  const activeIndex = activeIndexOf(allItems);
  return {
    enabled: true,
    revision,
    digest: digestOf(allItems),
    total,
    completed: allItems.filter((entry) => entry.status === 'completed').length,
    activeIndex,
    current: activeIndex === null ? null : allItems[activeIndex],
    offset: clamped,
    items: allItems.slice(clamped, clamped + limit),
    nextOffset: limit > 0 && clamped + limit < total ? clamped + limit : null,
  };
}

const release = (statuses) =>
  ['Read the notes', 'Update the changelog', 'Build', 'Tag'].map((content, index) =>
    item(content, statuses[index]),
  );

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
    read(offset, limit) {
      return new Promise((resolve, reject) => reads.push({ offset, limit, resolve, reject }));
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

test('a hidden list stays hidden through progress, remounts, and stream drops, but resets on >20-item edits and ABA replacements', async (t) => {
  setup(t);
  const watched = source();
  const state = createChecklistState(watched, 'hidden-session');
  const shownHistory = [];
  effect(() => shownHistory.push(state.shown()));

  watched.push(slicePage(1, release(['completed', 'in_progress', 'pending', 'pending'])));
  await flush();
  assert.equal(state.shown(), true);

  state.hide();
  assert.equal(state.shown(), false);
  watched.push(slicePage(2, release(['completed', 'completed', 'in_progress', 'pending'])));
  await flush();
  assert.equal(state.shown(), false, 'progress on the same list reopened it');

  const remounted = source();
  const again = createChecklistState(remounted, 'hidden-session');
  remounted.push(slicePage(2, release(['completed', 'completed', 'in_progress', 'pending'])));
  const other = source();
  const elsewhere = createChecklistState(other, 'other-session');
  other.push(slicePage(2, release(['completed', 'completed', 'in_progress', 'pending'])));
  await flush();
  assert.equal(again.shown(), false, 'returning to the conversation reopened it');
  assert.equal(elsewhere.shown(), true, 'hiding one conversation hid another');

  // Replacing the list clears the dismissed latch so a fresh ABA write of `release` shows again.
  watched.push(slicePage(3, [item('Publish', 'completed'), item('Announce', 'in_progress')]));
  await flush();
  assert.equal(state.shown(), true, 'a different list stayed hidden');

  watched.push(slicePage(4, release(['in_progress', 'pending', 'pending', 'pending'])));
  await flush();
  assert.equal(state.shown(), true, 'a fresh ABA list with earlier step names stayed hidden');

  // Editing item #22 of a 25-item checklist changes its digest even though page 1 is unchanged.
  const longPlan = Array.from({ length: 25 }, (_, index) =>
    item(`Step ${index + 1}`, index < 21 ? 'completed' : 'pending'),
  );
  watched.push(slicePage(5, longPlan));
  await flush();
  state.hide();
  assert.equal(state.shown(), false);

  const editedPageTwo = longPlan.map((entry, index) =>
    index === 21 ? item('Rewritten step 22', 'in_progress') : entry,
  );
  watched.push(slicePage(6, editedPageTwo));
  await flush();
  assert.equal(state.shown(), true, 'editing an item past page 1 left the list hidden');

  // A background stream drop while hidden must not resurrect a dismissed checklist.
  state.hide();
  assert.equal(state.shown(), false);
  watched.push(null);
  await flush();
  assert.equal(state.shown(), false, 'a stream error resurrected the dismissed checklist');
  assert.ok(shownHistory.length >= 6);
});

test('reveal joins an in-flight page read and fetches the remaining window in one request', async (t) => {
  setup(t);
  const watched = source();
  const state = createChecklistState(watched, 'reveal-session');
  const full = Array.from({ length: 45 }, (_, index) =>
    item(`Step ${index + 1}`, index < 41 ? 'completed' : index === 41 ? 'in_progress' : 'pending'),
  );
  watched.push(slicePage(1, full, 0, 20));
  await flush();

  void state.loadMore();
  const revealed = state.reveal(() => true);
  await flush();
  assert.deepEqual(
    watched.reads.map((read) => ({ offset: read.offset, limit: read.limit })),
    [{ offset: 20, limit: 20 }],
  );
  watched.reads[0].resolve(slicePage(1, full, 20, 20));
  await flush();
  assert.deepEqual(
    watched.reads.map((read) => ({ offset: read.offset, limit: read.limit })),
    [
      { offset: 20, limit: 20 },
      { offset: 40, limit: 20 },
    ],
  );
  watched.reads[1].resolve(slicePage(1, full, 40, 20));
  await flush();
  assert.equal(await settled(revealed), 41);
  assert.equal(state.items().length, 45);
});

test('an open panel preserves its loaded window across progress updates past item 20', async (t) => {
  setup(t);
  const watched = source();
  const state = createChecklistState(watched, 'open-window-session');
  const fullAt25 = Array.from({ length: 30 }, (_, index) =>
    item(`Task ${index + 1}`, index < 24 ? 'completed' : index === 24 ? 'in_progress' : 'pending'),
  );
  watched.push(slicePage(1, fullAt25, 0, 20));
  await flush();

  const close = state.open();
  const lengths = [];
  effect(() => lengths.push(state.items().length));

  const opening = state.reveal(() => true);
  await flush();
  assert.equal(watched.reads.length, 1);
  assert.deepEqual(
    { offset: watched.reads[0].offset, limit: watched.reads[0].limit },
    {
      offset: 20,
      limit: 20,
    },
  );
  watched.reads[0].resolve(slicePage(1, fullAt25, 20, 20));
  assert.equal(await settled(opening), 24);
  assert.equal(state.items().length, 30);

  // Agent advances from #25 to #26 while the panel stays open:
  const fullAt26 = Array.from({ length: 30 }, (_, index) =>
    item(`Task ${index + 1}`, index < 25 ? 'completed' : index === 25 ? 'in_progress' : 'pending'),
  );
  watched.push(slicePage(2, fullAt26, 0, 20));
  await flush();
  assert.equal(watched.reads.length, 2);
  assert.deepEqual(
    { offset: watched.reads[1].offset, limit: watched.reads[1].limit },
    {
      offset: 0,
      limit: 30,
    },
  );
  watched.reads[1].resolve(slicePage(2, fullAt26, 0, 30));
  await flush();

  assert.equal(state.items().length, 30);
  assert.equal(state.items()[25].status, 'in_progress');
  assert.ok(
    !lengths.slice(lengths.indexOf(30)).includes(20),
    `open list shrank back to 20: ${lengths}`,
  );
  close();
});

test('a concurrent revision bump during reveal adopts the new head without spinning', async (t) => {
  setup(t);
  const watched = source();
  const state = createChecklistState(watched, 'concurrent-reveal-session');
  const rev1 = Array.from({ length: 45 }, (_, index) =>
    item(`Step ${index + 1}`, index < 25 ? 'completed' : index === 25 ? 'in_progress' : 'pending'),
  );
  const rev2 = Array.from({ length: 45 }, (_, index) =>
    item(`Step ${index + 1}`, index < 32 ? 'completed' : index === 32 ? 'in_progress' : 'pending'),
  );
  watched.push(slicePage(1, rev1, 0, 20));
  await flush();

  const revealed = state.reveal(() => true);
  await flush();
  assert.equal(watched.reads.length, 1);
  // Storage moved to revision 2 before watch delivered revision 2:
  watched.reads[0].resolve(slicePage(2, rev2, 20, 25));
  await flush();
  assert.equal(watched.reads.length, 2, 'reveal should refresh head once rather than spin');
  assert.deepEqual(
    { offset: watched.reads[1].offset, limit: watched.reads[1].limit },
    {
      offset: 0,
      limit: 45,
    },
  );
  watched.reads[1].resolve(slicePage(2, rev2, 0, 45));
  assert.equal(await settled(revealed), 32);
  assert.equal(state.items().length, 45);
  assert.equal(watched.reads.length, 2);
});

test('reveal does not read when the item is loaded, the list is done, or it is closed, and stops on error', async (t) => {
  setup(t);
  const watched = source();
  const state = createChecklistState(watched, 'still-session');
  const shortActive = Array.from({ length: 30 }, (_, index) =>
    item(`Step ${index + 1}`, index === 0 ? 'completed' : index === 1 ? 'in_progress' : 'pending'),
  );
  watched.push(slicePage(1, shortActive, 0, 4));
  await flush();
  assert.equal(await settled(state.reveal(() => true)), 1);

  const farActive = Array.from({ length: 30 }, (_, index) =>
    item(`Step ${index + 1}`, index < 24 ? 'completed' : 'in_progress'),
  );
  watched.push(slicePage(2, farActive, 0, 4));
  await flush();
  assert.equal(await settled(state.reveal(() => false)), -1);

  const allDone = release(['completed', 'completed', 'completed', 'completed']);
  watched.push(slicePage(3, allDone, 0, 20));
  await flush();
  assert.equal(await settled(state.reveal(() => true)), -1);
  assert.equal(watched.reads.length, 0);

  // Now fail a needed page read:
  watched.push(slicePage(4, farActive, 0, 20));
  await flush();
  const failed = state.reveal(() => true);
  await flush();
  watched.reads[0].reject(new Error('read failed'));
  assert.equal(await settled(failed), -1);
  assert.ok(state.error(), 'the failed read left no error');
  assert.equal(watched.reads.length, 1);
});
