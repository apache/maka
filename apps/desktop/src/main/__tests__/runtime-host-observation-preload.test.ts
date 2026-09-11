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
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';
import type { MakaBridge } from '../../preload/bridge-contract.js';

test('observation readiness includes its active seed even when the invoke reply overtakes event IPC', async () => {
  const owner = {
    hostId: 'owner-host', targetEpoch: 'owner-epoch', profileId: 'local',
    profileName: 'Local', profileKind: 'local', profileAccess: 'owner', readiness: 'ready',
  };
  const ipcRenderer = {
    // Deliberately never deliver event IPC: only the invoke response arrives.
    on() {}, off() {}, send() {},
    async invoke(channel: string) {
      if (channel === 'runtime-host:activeIdentity') return owner;
      if (channel === 'runtime-host:identities') return [owner];
      if (channel === 'sessions:unobserve') return;
      if (channel === 'sessions:observe') return [{
        type: 'text_delta', id: 'seed-1', turnId: 'turn-1', messageId: 'message-1',
        ts: 1, startOffset: 0, text: 'All output accumulated while away',
      }];
      throw new Error('Unexpected channel: ' + channel);
    },
  };
  let bridge: MakaBridge | undefined;
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../../../src/preload/preload.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['electron'],
  });
  const require = createRequire(import.meta.url);
  runInNewContext(bundle.outputFiles[0]!.text, {
    require: (id: string) => id === 'electron' ? {
      ipcRenderer,
      contextBridge: { exposeInMainWorld: (name: string, value: MakaBridge) => {
        if (name === 'maka') bridge = value;
      } },
    } : require(id),
    process: { env: {} }, Buffer, console, setTimeout, clearTimeout, TextEncoder, TextDecoder,
    crypto: globalThis.crypto,
  });
  assert.ok(bridge);
  const order: string[] = [];
  let unsubscribe = () => {};
  await new Promise<void>((resolve, reject) => {
    unsubscribe = bridge!.sessions.subscribeEvents(
      JSON.stringify([owner.hostId, 'session-1']),
      (event) => { if (event.type === 'text_delta') order.push(event.text); },
      () => { order.push('ready'); resolve(); },
      undefined,
      reject,
    );
  });
  assert.deepEqual(order, ['All output accumulated while away', 'ready']);
  unsubscribe();
});
