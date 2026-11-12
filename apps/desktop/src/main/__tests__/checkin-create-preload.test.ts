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

/** Two Owner Hosts: A is active, B holds an older Session a check-in card points at. */
async function loadBridge() {
  const hosts = ['host-a', 'host-b'].map((hostId, index) => ({
    hostId,
    targetEpoch: `${hostId}-epoch`,
    profileId: `profile-${hostId}`,
    profileName: hostId,
    profileKind: index === 0 ? 'local' : 'remote',
    profileAccess: 'owner',
    readiness: 'ready',
  }));
  const created: string[] = [];
  const ipcRenderer = {
    on() {},
    off() {},
    send() {},
    async invoke(channel: string, scope?: { hostId?: string }) {
      switch (channel) {
        case 'runtime-host:identities':
          return hosts.map((host, index) => ({ ...host, epoch: host.targetEpoch, isDefault: index === 0 }));
        case 'runtime-host:awaitReady': return { ready: true };
        case 'runtime-host-profiles:getSnapshot':
          return {
            defaultProfileId: 'profile-host-a',
            entries: hosts.map((host) => ({
              profile: { id: host.profileId, name: host.profileName, kind: host.profileKind },
              hostId: host.hostId,
              enabled: true,
              readiness: 'ready',
            })),
          };
        case 'sessions:create':
          created.push(scope?.hostId ?? 'none');
          return { id: `created-on-${scope?.hostId}`, name: 'New task', cwd: '/work', activityAt: created.length, status: 'active' };
        case 'session-local:catalog': return [];
        case 'session-collaboration:mount:list':
        case 'sessions:list': return [];
        default: throw new Error('Unexpected channel: ' + channel);
      }
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
  return { bridge, created };
}

test('a Session created beside another stays on that Session\'s Host', async () => {
  const { bridge, created } = await loadBridge();

  await bridge.sessions.create({ cwd: '/work' }, { besideSessionId: JSON.stringify(['host-b', 'source-1']) });
  await bridge.sessions.create({ cwd: '/work' });
  assert.deepEqual(created, ['host-b', 'host-a']);

  // A source whose Host is gone fails instead of falling back to the active Host.
  await assert.rejects(
    bridge.sessions.create({ cwd: '/work' }, { besideSessionId: JSON.stringify(['host-gone', 'source-2']) }),
    /Runtime Host for this task is unavailable/,
  );
  assert.deepEqual(created, ['host-b', 'host-a']);
});
