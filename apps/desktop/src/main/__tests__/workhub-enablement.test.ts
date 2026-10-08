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
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { act, createElement, StrictMode } from 'react';
import {
  createWorkHubEnablement,
  WorkHubEnablementProvider,
  WorkHubEnablementWatch,
  type WorkHubEnablementSource,
} from '../../renderer/application/contracts/workhub-workspace/workhub-enablement.js';
import { createDesktopWorkHubEnablementSource } from '../../renderer/platform/desktop/create-workhub-enablement-source.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

afterEach(cleanupFakeDom);

function controllableSource() {
  const reads: Array<{ resolve(enabled: boolean): void; reject(error: Error): void }> = [];
  const handlers = new Set<() => void>();
  const source: WorkHubEnablementSource = {
    read: () => new Promise((resolve, reject) => { reads.push({ resolve, reject }); }),
    subscribeChanges(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  return { source, reads, handlers, change: () => [...handlers].forEach((handler) => handler()) };
}

test('reads only while subscribed, keeps the last value on a failed read, and restarts from off', async () => {
  const { source, reads, handlers, change } = controllableSource();
  const enablement = createWorkHubEnablement(source);
  assert.equal(reads.length, 0, 'no reader, no read');
  let notified = 0;
  const unsubscribe = enablement.subscribe(() => { notified += 1; });
  assert.equal(handlers.size, 1);
  await act(async () => reads[0]!.resolve(true));
  assert.deepEqual([enablement.isEnabled(), notified], [true, 1]);
  change();
  await act(async () => reads[1]!.reject(new Error('settings unavailable')));
  assert.deepEqual([enablement.isEnabled(), notified], [true, 1], 'a failed read keeps the last known value');
  change();
  await act(async () => reads[2]!.resolve(true));
  assert.equal(notified, 1, 'an unchanged value does not notify');
  change();
  unsubscribe();
  await act(async () => reads[3]!.resolve(false));
  assert.deepEqual([enablement.isEnabled(), notified, handlers.size], [false, 1, 0], 'a read that lands after the last reader left is dropped');
});

test('the watch hands the shell each edge of the switch, once, under StrictMode', async () => {
  const { source, reads, change } = controllableSource();
  const enablement = createWorkHubEnablement(source);
  const edges: string[] = [];
  const { root } = installReactRenderer();
  await act(async () => root.render(createElement(StrictMode, null,
    createElement(WorkHubEnablementProvider, { value: enablement },
      createElement(WorkHubEnablementWatch, { onEnabled: () => edges.push('on'), onDisabled: () => edges.push('off') })))));
  await act(async () => { for (const read of reads) read.resolve(false); });
  assert.deepEqual(edges, [], 'starting off is not an edge');
  change();
  await act(async () => reads.at(-1)!.resolve(true));
  change();
  await act(async () => reads.at(-1)!.resolve(true));
  change();
  await act(async () => reads.at(-1)!.resolve(false));
  assert.deepEqual(edges, ['on', 'off']);
  await act(async () => root.unmount());
});

test('Desktop reads the client WorkHub switch; AppShell no longer reaches it', async () => {
  const subscribed: Array<() => void> = [];
  const source = createDesktopWorkHubEnablementSource({
    settings: {
      getClient: async () => ({ workHub: { enabled: true } }),
      subscribeClientChanged: (handler: () => void) => { subscribed.push(handler); return () => {}; },
    },
  } as unknown as Parameters<typeof createDesktopWorkHubEnablementSource>[0]);
  assert.equal(await source.read(), true);
  const handler = () => {};
  source.subscribeChanges(handler);
  assert.deepEqual(subscribed, [handler]);
  const shell = readFileSync(fileURLToPath(new URL('../../../src/renderer/app-shell.tsx', import.meta.url)), 'utf8');
  assert.deepEqual(shell.split('\n').filter((line) => /\bsettings\s*\.\s*(?:getClient|subscribeClientChanged)\b|\bworkHubEnabled\b/.test(line)), []);
});

test('a composition without the WorkHub switch fails instead of reading off', () => {
  const { root } = installReactRenderer();
  assert.throws(() => act(() => root.render(createElement(WorkHubEnablementWatch, { onEnabled() {}, onDisabled() {} }))),
    /WorkHubEnablementProvider is missing/);
});
