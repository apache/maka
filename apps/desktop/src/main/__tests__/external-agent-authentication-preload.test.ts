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
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import type { MakaBridge } from '../../preload/bridge-contract.js';

test('authentication reads use the selected Host and refuse a replaced target without launching setup', async () => {
  const active = {
    hostId: 'active-host', targetEpoch: 'active-epoch', profileId: 'active',
    profileName: 'Active', profileKind: 'local', profileAccess: 'owner', readiness: 'ready',
  };
  const selected = {
    ...active, hostId: 'selected-host', targetEpoch: 'selected-epoch', profileId: 'selected',
  };
  let identities = [active, selected];
  const calls: Array<{ channel: string; hostId?: string }> = [];
  const authentication = { acpAgentId: 'antigravity', executable: '/selected/agent', status: 'verified' };
  const ipcRenderer = {
    on() {}, off() {}, send() {},
    async invoke(channel: string, scope?: { hostId: string }) {
      if (channel === 'runtime-host:identities') return identities;
      calls.push({ channel, hostId: scope?.hostId });
      if (channel === 'external-agents:authentication:query') return authentication;
      throw new Error(`Unexpected side effect: ${channel}`);
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
      contextBridge: { exposeInMainWorld(name: string, value: MakaBridge) {
        if (name === 'maka') bridge = value;
      } },
    } : require(id),
    process: { env: {} }, Buffer, console, setTimeout, clearTimeout, TextEncoder, TextDecoder,
    crypto: globalThis.crypto,
  });
  assert.ok(bridge);
  const target = { profileId: 'selected', hostId: 'selected-host' };
  assert.deepEqual(await bridge.externalAgents.authentication(target), authentication);
  identities = [active, { ...selected, hostId: 'replacement-host', targetEpoch: 'replacement-epoch' }];
  await assert.rejects(bridge.externalAgents.authentication(target), /no longer available/);
  assert.deepEqual(calls, [{ channel: 'external-agents:authentication:query', hostId: 'selected-host' }]);
});
