/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  discoveryTag,
  dossierInterrupt,
  leadFilePaths,
  notificationTarget,
  pinDossier,
} from '../app/discoveryDossiersCore.ts';

const dossier = (topicId, fields = {}) => ({
  topicId,
  title: topicId,
  signal: 'green',
  muted: false,
  revision: 1,
  lastMaterialChangeAt: 1000,
  artifactCount: 0,
  ...fields,
});
const a = dossier('a');
const b = dossier('b', { signal: 'yellow' });

test('dropping files retains path order and decodes escaped and non-ASCII names once', () => {
  const files = [resolve('合同 final.pdf'), resolve('50% #1.png')];
  const uris = files.map((file) => pathToFileURL(file).href);
  assert.deepEqual(leadFilePaths([uris[0], ...uris]), files);
  assert.deepEqual(leadFilePaths(uris, [files[0]]), files);
});

test('initial selection follows backend order and keeps the same topic across reorder and refresh', () => {
  const ordered = [a, b];
  const selected = pinDossier(ordered, null);
  assert.deepEqual(selected, { topicId: 'a' });
  assert.equal(pinDossier([b, { ...a, title: 'Revised', revision: 2 }], selected), selected);
  assert.deepEqual(pinDossier([b], selected), { topicId: 'b' });
  assert.equal(pinDossier([], selected), null);
});

test('a notification or lead receipt pins its requested topic ahead of list delivery', () => {
  const requested = { topicId: 'incoming', requested: true };
  assert.equal(pinDossier([], requested), requested);
  assert.equal(pinDossier([a], requested), requested);
  const arrived = pinDossier([b, dossier('incoming'), a], requested);
  assert.deepEqual(arrived, { topicId: 'incoming' });
  assert.equal(pinDossier([a, b, dossier('incoming')], arrived), arrived);
});

const update = (topic, revision, fields = {}) => ({
  dossiers: [a, b],
  notificationsEnabled: true,
  latestInterrupt: topic ? { topicId: topic, revision, reason: 'Deadline moved', at: 1000 } : null,
  ...fields,
});

test('a first snapshot and a reconnected snapshot seed interrupt revisions without replay', () => {
  for (const baseline of [update(null), update('a', 7)]) {
    const seed = dossierInterrupt(null, baseline);
    assert.equal(seed.notification, null);
    assert.equal(dossierInterrupt(seed.seen, baseline).notification, null);
  }
  const reconnect = dossierInterrupt(null, update('b', 12));
  assert.equal(reconnect.notification, null);
  assert.equal(dossierInterrupt(reconnect.seen, update('b', 12)).notification, null);
  assert.equal(dossierInterrupt(reconnect.seen, update('b', 13)).notification.tag, 'discovery:b');
});

test('quiet revisions do not notify and a later interrupt for an already visible revision does', () => {
  const quiet = update(null, 0, { dossiers: [dossier('a', { revision: 8 })] });
  const seed = dossierInterrupt(null, quiet);
  assert.equal(dossierInterrupt(seed.seen, quiet).notification, null);
  const interrupt = update('a', 8, {
    dossiers: [dossier('a', { revision: 8, title: 'Revised deadline' })],
  });
  const first = dossierInterrupt(seed.seen, interrupt);
  assert.deepEqual(first.notification, {
    tag: 'discovery:a',
    title: 'Revised deadline',
    body: 'Deadline moved',
  });
  const second = dossierInterrupt(first.seen, update('b', 1));
  assert.equal(second.notification.tag, 'discovery:b');
  assert.equal(dossierInterrupt(second.seen, interrupt).notification, null);
  assert.equal(dossierInterrupt(second.seen, update('a', 7)).notification, null);
});

test('disabled, muted or missing topics do not replay a suppressed interrupt later', () => {
  for (const fields of [
    { notificationsEnabled: false },
    { dossiers: [b, { ...a, muted: true }] },
    { dossiers: [b] },
  ]) {
    const seed = dossierInterrupt(null, update(null));
    const hidden = dossierInterrupt(seed.seen, update('a', 2, fields));
    assert.equal(hidden.notification, null);
    assert.equal(dossierInterrupt(hidden.seen, update('a', 2)).notification, null);
    assert.equal(dossierInterrupt(hidden.seen, update('a', 3)).notification.tag, 'discovery:a');
  }
});

test('notification clicks preserve arbitrary topic IDs and ordinary session tags', () => {
  const topic = '收件箱:release/v2';
  assert.deepEqual(notificationTarget(discoveryTag(topic)), { kind: 'discovery', id: topic });
  assert.deepEqual(notificationTarget('conversation-1'), { kind: 'session', id: 'conversation-1' });
  for (const tag of [null, 42, {}, '', 'discovery:']) assert.equal(notificationTarget(tag), null);
});

test('the window posts native interrupts, rebaselines a reconnected stream and routes clicks once', async (t) => {
  const source = (js) => `data:text/javascript,${encodeURIComponent(js)}`;
  const native = source(`
    export const calls = [], listeners = new Map(), disposers = [];
    export const host = {
      call: async (method, data) => { calls.push({method, data}); },
      on: (event, handler) => { listeners.set(event, handler); return () => listeners.delete(event); },
    };
    export const signal = (value) => Object.assign(() => value, {set: (next) => { value = next; }});
    export const cleanup = (fn) => disposers.push(fn);
    export const effect = (run) => { const stop = run(); if (stop) cleanup(stop); };
    export const computed = (fn) => fn, untracked = (fn) => fn(), batch = untracked;
  `);
  const desktop = source(
    'export let focused = 0; export const currentWindow = () => ({focus: () => focused++});',
  );
  const stubs = new Map([
    ['nsh', native],
    ['nsh/desktop', desktop],
    ['./chrome', source('export const ownTitleBar = true;')],
    ['./locale', source('export const tr = key => key;')],
    ['./sessionStatus', source('export const sessionStatusCaption = {};')],
  ]);
  const app = new URL('../app/', import.meta.url);
  const hooks = registerHooks({
    resolve(name, context, next) {
      if (context.parentURL?.startsWith(app.href)) {
        if (stubs.has(name)) return { url: stubs.get(name), shortCircuit: true };
        if (name.startsWith('.') && !name.endsWith('.ts')) return next(name + '.ts', context);
      }
      return next(name, context);
    },
  });
  t.after(() => hooks.deregister());
  const { watchDiscoveryDossiers, watchNotifications } = await import(
    new URL('notifications.ts', app)
  );
  const { calls, listeners, disposers } = await import(native);
  const window = await import(desktop);
  const opened = [],
    streams = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  watchDiscoveryDossiers(
    {
      async subscribe(endpoint, method) {
        assert.deepEqual([endpoint, method], ['agent', 'watchDossiers']);
        const reader = new ReadableStream({
          start(controller) {
            streams.push(controller);
          },
        }).getReader();
        return {
          next: async () => (await reader.read()).value ?? null,
          close: () => reader.cancel(),
        };
      },
    },
    () => false,
  );
  watchNotifications({
    sessions: () => [],
    foreground: () => true,
    open: (id) => opened.push(['session', id]),
    openDiscovery: (id) => opened.push(['dossier', id]),
  });
  const revision = (n) =>
    update('b', n, {
      latestInterrupt: { topicId: 'b', revision: n, reason: `Deadline ${n}`, at: 1000 + n },
    });
  streams[0].enqueue(update('a', 1));
  streams[0].enqueue(revision(3));
  streams[0].enqueue(revision(3));
  await flush();
  streams[0].close();
  await flush();
  t.mock.timers.tick(500);
  await flush();
  streams[1].enqueue(revision(4));
  streams[1].enqueue(revision(4));
  streams[1].enqueue(revision(5));
  await flush();
  assert.deepEqual(
    calls,
    [3, 5].map((n) => ({
      method: 'notification.show',
      data: { tag: 'discovery:b', title: 'b', body: `Deadline ${n}` },
    })),
  );
  const click = listeners.get('notification.open');
  click({ tag: 'discovery:b' });
  click({ tag: 'main-session' });
  assert.deepEqual(opened, [
    ['dossier', 'b'],
    ['session', 'main-session'],
  ]);
  assert.equal(window.focused, 1);
  for (const stop of disposers.reverse()) stop();
  await flush();
  t.mock.timers.tick(10000);
  assert.equal(streams.length, 2);
  assert.equal(listeners.size, 0);
});
