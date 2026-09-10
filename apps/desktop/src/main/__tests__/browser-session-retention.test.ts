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
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { deferred } from '@maka/core/test-only/async-primitives';
import type { IPage } from '@jackwener/opencli/types';
import type { BrowserViewHost } from '../browser/browser-host.js';
import type * as BrowserSession from '../browser/session.js';

type SessionModule = typeof BrowserSession & {
  retainedReleaseEpochCount(): number;
  provideBrowserViewHost(host: BrowserViewHost | null): void;
};

async function freshSessionModule(): Promise<SessionModule> {
  const sourceUrl = new URL('../../../src/main/browser/session.ts', import.meta.url);
  // Inspect the real module's private state without adding a production debug API.
  const source = await readFile(sourceUrl, 'utf8');
  const bundle = await build({
    stdin: {
      contents: source + `
        export const retainedReleaseEpochCount = () => releaseEpochs.size;
        export { provideBrowserViewHost } from './browser-host.js';
      `,
      loader: 'ts',
      resolveDir: fileURLToPath(new URL('.', sourceUrl)),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
  });
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0]!.text, {
    module,
    exports: module.exports,
    require: createRequire(import.meta.url),
    setTimeout,
    clearTimeout,
    AbortController,
    URL,
  });
  return module.exports as SessionModule;
}

function installFakes(session: SessionModule, overrides: Partial<BrowserViewHost> = {}) {
  const disposed: string[] = [];
  const released: string[] = [];
  const bridges: { closed: boolean }[] = [];
  session.provideBrowserViewHost({
    canDrive: () => true,
    currentUrl: () => 'about:blank',
    openOriginLease: () => { throw new Error('observe does not need an origin lease'); },
    resolveEndpoint: async () => ({ cdpEndpoint: 'ws://127.0.0.1:1' }),
    releaseSession: async (id) => { released.push(id); },
    disposeSession: async (id) => { disposed.push(id); },
    ...overrides,
  });
  session.setBridgeFactoryForTest(() => {
    const bridge = {
      closed: false,
      connect: async () => ({ getCurrentUrl: async () => null }) as unknown as IPage,
      close: async () => { bridge.closed = true; },
      send: async () => ({}),
      waitForEvent: async () => ({}),
    };
    bridges.push(bridge);
    return bridge;
  });
  return { disposed, released, bridges };
}

test('release bookkeeping retains no unattached or completed session identities', async () => {
  const session = await freshSessionModule();
  installFakes(session);
  for (let index = 0; index < 10_000; index += 1) {
    await session.releaseBrowserSession(`unattached-${index}`);
  }
  assert.equal(session.retainedReleaseEpochCount(), 0);

  for (let index = 0; index < 200; index += 1) {
    const id = `attached-${index}`;
    await session.withBrowserPage(id, 'snapshot', async () => 'ok');
    assert.equal(session.retainedReleaseEpochCount(), 0, 'settled acquires discard the epoch');
    await session.releaseBrowserSession(id);
  }
  assert.equal(session.retainedReleaseEpochCount(), 0);
});

test('reentrant and repeated releases retain the active fence until acquire settles', { timeout: 5_000 }, async () => {
  const session = await freshSessionModule();
  const gate = deferred<void>();
  let reentrantRelease: Promise<void> | undefined;
  let resolveCalls = 0;
  const spy = installFakes(session, {
    resolveEndpoint: async (id) => {
      resolveCalls += 1;
      assert.equal(session.retainedReleaseEpochCount(), 1);
      // This runs before pendingAcquires can hold the attempt's promise.
      reentrantRelease = session.releaseBrowserSession(id);
      await gate.promise;
      return { cdpEndpoint: 'ws://127.0.0.1:1' };
    },
  });
  const first = session.withBrowserPage('pending', 'snapshot', async () => assert.fail('released action ran'));
  const second = session.withBrowserPage('pending', 'snapshot', async () => assert.fail('released action ran'));
  const rejected = Promise.all([
    assert.rejects(first, /deleted while the browser was connecting/),
    assert.rejects(second, /deleted while the browser was connecting/),
  ]);
  await reentrantRelease;
  for (let index = 0; index < 3; index += 1) {
    await session.releaseBrowserSession('pending');
    await session.releaseBrowserSession(`unattached-${index}`);
    assert.equal(session.retainedReleaseEpochCount(), 1);
  }
  assert.equal(resolveCalls, 1, 'concurrent callers share the pending attempt');
  gate.resolve();
  await rejected;
  assert.equal(session.retainedReleaseEpochCount(), 0);
  assert.equal(spy.bridges[0]?.closed, true);
  assert.equal(spy.disposed.filter((id) => id === 'pending').length, 5);

  installFakes(session);
  assert.equal(await session.withBrowserPage('pending', 'snapshot', async () => 'retried'), 'retried');
  assert.equal(session.retainedReleaseEpochCount(), 0);
  await session.releaseBrowserSession('pending');
});

test('failed endpoint and bridge connections clear their epochs and allow retry', async () => {
  const session = await freshSessionModule();
  installFakes(session, {
    resolveEndpoint: () => { throw new Error('endpoint failed'); },
  });
  await assert.rejects(session.withBrowserPage('failed', 'snapshot', async () => 'no'), /endpoint failed/);
  assert.equal(session.retainedReleaseEpochCount(), 0);

  const spy = installFakes(session);
  session.setBridgeFactoryForTest(() => ({
    connect: async () => { throw new Error('connect failed'); },
    close: async () => {},
    send: async () => ({}),
    waitForEvent: async () => ({}),
  }));
  await assert.rejects(session.withBrowserPage('failed', 'snapshot', async () => 'no'), /connect failed/);
  assert.equal(session.retainedReleaseEpochCount(), 0);
  assert.deepEqual(spy.released, ['failed']);

  installFakes(session);
  assert.equal(await session.withBrowserPage('failed', 'snapshot', async () => 'retried'), 'retried');
  assert.equal(session.retainedReleaseEpochCount(), 0);
  await session.releaseBrowserSession('failed');
});
