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

test('appUpdater transitions across check, progress events, dismiss, download, and installAndRestart', async (t) => {
  const { createAppUpdater } = await loadUpdaterModule(t);
  const calls = [];
  const listeners = new Map();
  const opened = [];

  const availableSnapshot = {
    channel: 'nightly',
    currentVersion: '0.2.0-nightly.20261121.1',
    canInstall: true,
    status: 'available',
    available: {
      version: '0.2.0-nightly.20261121.2',
      url: 'https://github.com/apache/maka/releases/download/nightly/Maka-nightly-macos-arm64.tar.gz',
      size: 1000,
    },
  };
  const readySnapshot = {
    ...availableSnapshot,
    status: 'ready',
    progress: { received: 1000, total: 1000 },
  };

  const updater = createAppUpdater(
    {
      async call(method) {
        calls.push(method);
        if (method === 'updater.state') {
          return { ...availableSnapshot, status: 'idle', available: null };
        }
        if (method === 'updater.check') return availableSnapshot;
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
  assert.equal(updater.bannerVisible(), false);

  await updater.check();
  assert.equal(updater.bannerVisible(), true);

  updater.dismiss();
  assert.equal(updater.bannerVisible(), false);

  // Pushing a progress update re-shows the banner with accurate percentage.
  listeners.get('updater.state')({
    ...availableSnapshot,
    status: 'downloading',
    progress: { received: 450, total: 1000 },
  });
  assert.equal(updater.bannerVisible(), true);
  assert.equal(updater.progressPercent(), 45);

  await updater.download();
  assert.equal(updater.snapshot().status, 'ready');
  assert.equal(updater.bannerVisible(), true);

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
  assert.equal(updater.bannerVisible(), false);
});
