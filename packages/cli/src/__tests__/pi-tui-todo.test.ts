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
import { stripAnsi } from '../tui-ansi.js';
import {
  CurrentTodoStore,
  TodoOverlay,
  TodoQueryState,
  renderTodoIndicator,
  type SessionTodoReader,
} from '../pi-tui-todo.js';

const snapshot = (
  items: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>,
) => ({
  items,
});

test('TodoQueryState distinguishes loading, empty, ready, and failure', async () => {
  const state = new TodoQueryState();
  const pending = deferred<ReturnType<typeof snapshot>>();
  const reader: SessionTodoReader = { read: async () => pending.promise };
  const load = state.load('session-1', reader);
  assert.equal(state.getSnapshot().status, 'loading');
  pending.resolve(snapshot([]));
  assert.equal(await load, true);
  assert.equal(state.getSnapshot().status, 'empty');

  const failing = await state.load('session-1', {
    read: async () => {
      throw new Error('unavailable');
    },
  });
  assert.equal(failing, true);
  assert.equal(state.getSnapshot().status, 'error');
});

test('TodoQueryState ignores a late response from an older session', async () => {
  const state = new TodoQueryState();
  const first = deferred<ReturnType<typeof snapshot>>();
  const second = deferred<ReturnType<typeof snapshot>>();
  const firstLoad = state.load('old', { read: async () => first.promise });
  const secondLoad = state.load('new', { read: async () => second.promise });
  second.resolve(snapshot([{ content: 'new item', status: 'in_progress' }]));
  assert.equal(await secondLoad, true);
  first.resolve(snapshot([{ content: 'stale item', status: 'completed' }]));
  assert.equal(await firstLoad, false);
  assert.equal(state.getSnapshot().sessionId, 'new');
  assert.equal(state.getSnapshot().items[0]?.content, 'new item');
});

test('CurrentTodoStore exposes one current session and invalidates on dispose', async () => {
  const pending = deferred<ReturnType<typeof snapshot>>();
  const store = new CurrentTodoStore({ read: async () => pending.promise });
  store.setSession('session-1');
  assert.equal(store.getState().status, 'loading');
  store.dispose();
  pending.resolve(snapshot([{ content: 'late', status: 'in_progress' }]));
  await Promise.resolve();
  assert.equal(store.getState().status, 'idle');
  assert.equal(await store.refresh(), false);
});

test('CurrentTodoStore starts the new session while an old refresh is pending', async () => {
  const old = deferred<ReturnType<typeof snapshot>>();
  const next = deferred<ReturnType<typeof snapshot>>();
  const store = new CurrentTodoStore({
    read: async (sessionId) => (sessionId === 'old' ? old.promise : next.promise),
  });
  store.setSession('old');
  store.setSession('new');
  assert.equal(store.getState().sessionId, 'new');
  assert.equal(store.getState().status, 'loading');
  next.resolve(snapshot([{ content: 'new', status: 'in_progress' }]));
  assert.equal(await store.refresh(), true);
  assert.equal(store.getState().items[0]?.content, 'new');
  old.resolve(snapshot([{ content: 'old', status: 'completed' }]));
});

test('renders a bounded indicator and hides empty state', async () => {
  const state = new TodoQueryState();
  await state.load('s', {
    read: async () =>
      snapshot([
        { content: 'Implement the current Todo preview', status: 'in_progress' },
        { content: 'Done', status: 'completed' },
        { content: 'Next', status: 'pending' },
      ]),
  });
  const indicator = renderTodoIndicator(state.getSnapshot(), { locale: 'en', width: 40 });
  const plainIndicator = stripAnsi(indicator ?? '');
  assert.ok(plainIndicator.length <= 40);
  assert.match(plainIndicator, /Todo 1\/3 · \/todo to view$/);

  await state.load('s', { read: async () => snapshot([]) });
  assert.equal(renderTodoIndicator(state.getSnapshot(), { locale: 'zh-CN', width: 80 }), undefined);
});

test('CurrentTodoStore does not coalesce across A -> undefined -> A', async () => {
  const first = deferred<ReturnType<typeof snapshot>>();
  const second = deferred<ReturnType<typeof snapshot>>();
  let reads = 0;
  const store = new CurrentTodoStore({
    read: async () => (reads++ === 0 ? first.promise : second.promise),
  });
  store.setSession('A');
  store.setSession(undefined);
  store.setSession('A');
  assert.equal(reads, 2);
  second.resolve(snapshot([{ content: 'fresh', status: 'in_progress' }]));
  assert.equal(await store.refresh(), true);
  assert.equal(store.getState().items[0]?.content, 'fresh');
  first.resolve(snapshot([{ content: 'stale', status: 'completed' }]));
  await Promise.resolve();
  assert.equal(store.getState().items[0]?.content, 'fresh');
});

test('TodoOverlay renders status symbols, failure, and scrolls safely', async () => {
  const state = new TodoQueryState();
  await state.load('s', {
    read: async () =>
      snapshot([
        { content: 'pending item', status: 'pending' },
        { content: 'active item', status: 'in_progress' },
        { content: 'done item', status: 'completed' },
      ]),
  });
  let closed = false;
  const overlay = new TodoOverlay({
    locale: 'zh-CN',
    getState: () => state.getSnapshot(),
    viewportRows: () => 4,
    onClose: () => {
      closed = true;
    },
  });
  assert.match(stripAnsi(overlay.render(24).join('\n')), /待办/);
  assert.match(overlay.render(24).join('\n'), /○|●|✓/);
  overlay.handleInput('\x1b[B');
  assert.match(stripAnsi(overlay.render(24).join('\n')), /active item/);
  overlay.handleInput('\x1b');
  assert.equal(closed, true);
});

test('TodoOverlay wraps grapheme-safe content and supports Home/End', async () => {
  const state = new TodoQueryState();
  await state.load('s', {
    read: async () => snapshot([{ content: '👩‍💻 中文内容很长', status: 'pending' }]),
  });
  let changes = 0;
  const overlay = new TodoOverlay({
    locale: 'en',
    getState: () => state.getSnapshot(),
    viewportRows: () => 4,
    onClose: () => undefined,
    onChange: () => changes++,
  });
  // The existing display projection removes zero-width format characters.
  assert.match(stripAnsi(overlay.render(8).join('\n')), /👩💻/);
  overlay.handleInput('\x1b[H');
  overlay.handleInput('\x1b[F');
  assert.equal(changes, 2);
});

test('error state renders unavailable instead of exposing query errors', async () => {
  const state = new TodoQueryState();
  await state.load('s', {
    read: async () => {
      throw new Error('secret-token');
    },
  });
  const indicator = stripAnsi(
    renderTodoIndicator(state.getSnapshot(), { locale: 'en', width: 80 }) ?? '',
  );
  assert.equal(indicator, 'Todo unavailable · /todo to view');
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
