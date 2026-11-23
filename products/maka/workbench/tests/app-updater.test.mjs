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
let sequence = 0;

async function loadUpdaterModule(t) {
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'nsh') {
        return { url: `maka-test:///nsh/${sequence}`, shortCircuit: true };
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url.startsWith('maka-test:///nsh/')) {
        return {
          format: 'module',
          shortCircuit: true,
          source: `
            export const platform = { idiom: 'desktop', os: 'macos' };
            export const host = { call: async () => null, on: () => () => {} };
            export const openUrl = async () => ({ opened: true });
            export function signal(initial) {
              let value = initial;
              const read = () => value;
              read.set = (next) => { value = next; };
              return read;
            }
          `,
        };
      }
      return next(url, context);
    },
  });
  t.after(() => hooks.deregister());
  sequence += 1;
  return import(new URL(`appUpdater.ts?test=${sequence}`, appRoot));
}

test('appUpdater stays silent in sidebar until ready or installing', async (t) => {
  const { createAppUpdater } = await loadUpdaterModule(t);
  const calls = [];
  const listeners = new Map();
  const opened = [];

  const baseSnapshot = {
    channel: 'nightly',
    currentVersion: '0.2.0-nightly.20261121.1',
    canInstall: true,
    available: {
      version: '0.2.0-nightly.20261121.2',
      url: 'https://github.com/apache/maka/releases/download/nightly/Maka-nightly-macos-arm64.tar.gz',
      size: 1000,
    },
  };
  const downloadingSnapshot = {
    ...baseSnapshot,
    status: 'downloading',
    progress: { received: 0, total: 1000 },
  };
  const readySnapshot = {
    ...baseSnapshot,
    status: 'ready',
    progress: null,
  };

  const updater = createAppUpdater(
    {
      async call(method) {
        calls.push(method);
        if (method === 'updater.state') {
          return { ...baseSnapshot, status: 'idle', available: null };
        }
        if (method === 'updater.check') return downloadingSnapshot;
        if (method === 'updater.download') return readySnapshot;
        if (method === 'updater.installAndRestart') return null;
        throw new Error('unexpected ' + method);
      },
      on(event, listener) {
        listeners.set(event, listener);
        return () => listeners.delete(event);
      },
      async openUrl(url) {
        opened.push(url);
      },
    },
    true,
  );

  updater.init();
  await Promise.resolve();
  assert.equal(updater.sidebarVisible(), false);

  await updater.check();
  assert.equal(updater.snapshot().status, 'downloading');
  assert.equal(updater.sidebarVisible(), false);

  // Silent discovery/download/read-only available/error never clutter the sidebar.
  for (const status of ['checking', 'available', 'downloading', 'upToDate', 'error']) {
    listeners.get('updater.state')({
      ...baseSnapshot,
      status,
      progress: status === 'downloading' ? { received: 450, total: 1000 } : null,
    });
    assert.equal(updater.sidebarVisible(), false, `sidebar should stay hidden for ${status}`);
  }

  listeners.get('updater.state')({
    ...baseSnapshot,
    status: 'downloading',
    progress: { received: 450, total: 1000 },
  });
  assert.equal(updater.progressPercent(), 45);
  assert.equal(updater.sidebarVisible(), false);

  await updater.download();
  assert.equal(updater.snapshot().status, 'ready');
  assert.equal(updater.sidebarVisible(), true);

  listeners.get('updater.state')({
    ...baseSnapshot,
    status: 'installing',
  });
  assert.equal(updater.sidebarVisible(), true);

  // Dev builds never surface sidebar actions even if a ready payload arrives.
  listeners.get('updater.state')({
    ...readySnapshot,
    channel: 'dev',
  });
  assert.equal(updater.sidebarVisible(), false);

  listeners.get('updater.state')(readySnapshot);
  await updater.installAndRestart();
  assert.deepEqual(calls, [
    'updater.state',
    'updater.check',
    'updater.download',
    'updater.installAndRestart',
  ]);

  await updater.openDownload();
  assert.equal(opened.length, 1);
});

test('appUpdater preserves ready status when installAndRestart rejects after host stop failure', async (t) => {
  const { createAppUpdater } = await loadUpdaterModule(t);
  const listeners = new Map();
  const readySnapshot = {
    channel: 'nightly',
    currentVersion: '0.2.0-nightly.1',
    canInstall: true,
    status: 'ready',
    available: {
      version: '0.2.0-nightly.2',
      url: 'https://example.invalid/maka.tar.gz',
      size: 1000,
    },
  };

  const updater = createAppUpdater(
    {
      async call(method) {
        if (method === 'updater.state') return readySnapshot;
        if (method === 'updater.installAndRestart') {
          listeners.get('updater.state')({
            ...readySnapshot,
            error: 'Host stop timed out',
          });
          throw new Error('Host stop timed out');
        }
        throw new Error('unexpected ' + method);
      },
      on(event, listener) {
        listeners.set(event, listener);
        return () => listeners.delete(event);
      },
      async openUrl() {},
    },
    true,
  );

  updater.init();
  await Promise.resolve();
  assert.equal(updater.sidebarVisible(), true);

  await updater.installAndRestart();
  assert.equal(updater.snapshot().status, 'ready');
  assert.equal(updater.snapshot().error, 'Host stop timed out');
  assert.equal(updater.sidebarVisible(), true);
});

test('appUpdater keeps receiving updates after an earlier owner unsubscribes and a new owner mounts', async (t) => {
  const { createAppUpdater } = await loadUpdaterModule(t);
  const listeners = new Set();
  let current = {
    channel: 'nightly',
    currentVersion: '0.2.0-nightly.1',
    canInstall: true,
    status: 'upToDate',
    available: null,
    progress: null,
    error: null,
  };

  const updater = createAppUpdater(
    {
      async call(method) {
        if (method === 'updater.state') return current;
        throw new Error('unexpected ' + method);
      },
      on(_event, listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async openUrl() {},
    },
    true,
  );

  // First owner mounts and then disposes (e.g., Settings remounting after loading preferences).
  const offFirst = updater.init();
  await Promise.resolve();
  assert.equal(updater.snapshot().status, 'upToDate');
  offFirst();
  assert.equal(listeners.size, 0);

  // Second owner mounts, syncs fresh state, and continues receiving live events.
  current = {
    ...current,
    status: 'downloading',
    available: {
      version: '0.2.0-nightly.2',
      url: 'https://example.invalid/maka.tar.gz',
      size: 1000,
    },
    progress: { received: 250, total: 1000 },
  };
  const offSecond = updater.init();
  await Promise.resolve();
  assert.equal(updater.snapshot().status, 'downloading');
  assert.equal(updater.progressPercent(), 25);

  const ready = { ...current, status: 'ready', progress: null };
  for (const listener of listeners) listener(ready);
  assert.equal(updater.snapshot().status, 'ready');
  assert.equal(updater.sidebarVisible(), true);
  offSecond();
});

test('appUpdater stays inert on terminal idiom', async (t) => {
  const { createAppUpdater } = await loadUpdaterModule(t);
  let called = false;
  const updater = createAppUpdater(
    {
      async call() {
        called = true;
        return null;
      },
      on() {
        called = true;
        return () => {};
      },
      async openUrl() {},
    },
    false,
  );
  updater.init();
  await updater.check();
  assert.equal(called, false);
  assert.equal(updater.snapshot(), null);
  assert.equal(updater.sidebarVisible(), false);
});
