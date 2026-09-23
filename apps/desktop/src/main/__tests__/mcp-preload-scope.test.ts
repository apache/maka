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
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import type { MakaBridge } from '../../preload/bridge-contract.js';
import { unwrapMcpIpcResult, mcpConfigFailureMessage } from '../../renderer/features/module-hub/testing.js';
import { getMcpCopy } from '../../renderer/locales/mcp-copy.js';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// The MCP IPC handlers are registered on the Runtime Host's ScopedIpcMain,
// whose first argument must be a DesktopHostRef. A raw ipcRenderer.invoke
// would put serverId in that slot and fail requireDesktopHostRef before the
// handler ever ran — the bug this contract test pins down at the source
// level, since the preload itself only runs inside Electron.
const preloadSource = readFileSync(
  fileURLToPath(new URL('../../../src/preload/preload.ts', import.meta.url)),
  'utf8',
);

test('every MCP bridge method rides the scoped Runtime Host seam', () => {
  const rawMcpInvokes = preloadSource.match(/ipcRenderer\.invoke\(\s*'mcp:/gu) ?? [];
  assert.deepEqual(rawMcpInvokes, []);
  for (const channel of [
    'mcp:getConfig',
    'mcp:add',
    'mcp:update',
    'mcp:setEnabled',
    'mcp:remove',
    'mcp:login',
    'mcp:cancelLogin',
    'mcp:logout',
    'mcp:chromeStatus',
    'mcp:connectChrome',
  ]) {
    assert.match(preloadSource, new RegExp(`invokeSelectedRuntimeHost\\(host, '${channel}'`, 'u'));
  }
});


test('every MCP bridge method carries typed config failures intact through the bundled preload', async () => {
  const failure = { kind: 'invalid-mcp-config-file', path: '/profile/mcp.json' } as const;
  const events = new EventEmitter();
  const channels: string[] = [];
  const owner = { hostId: 'owner', targetEpoch: 'epoch', profileId: 'local',
    profileName: 'Local', profileKind: 'local', profileAccess: 'owner', readiness: 'ready' };
  const ipcRenderer = {
    on: events.on.bind(events), off: events.off.bind(events), send() {},
    async invoke(channel: string, ...args: unknown[]) {
      if (channel === 'app:bootstrapReady') return undefined;
      if (channel === 'runtime-host:identities') return structuredClone([owner]);
      assert.ok(channel.startsWith('mcp:'), channel);
      assert.deepEqual(JSON.parse(JSON.stringify(args[0])), owner);
      channels.push(channel);
      return structuredClone(failure);
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
  const mcp = bridge.mcp;
  const host = { hostId: 'owner', profileId: 'local' };
  const server = { command: 'unused' };
  const calls = [
    () => mcp.getConfig(host), () => mcp.listStatuses(host),
    () => mcp.importConfig('{}', host), () => mcp.add('id', server, host),
    () => mcp.update('id', server, server, host), () => mcp.setEnabled('id', true, host),
    () => mcp.remove('id', host),
    () => mcp.test('id', host), () => mcp.login('id', host),
    () => mcp.cancelLogin('id', host), () => mcp.logout('id', host),
  ];
  for (const call of calls) {
    // Plain fulfilled data survives the context bridge; rebuilding an Error
    // in preload would introduce a second lossy error-serialization boundary.
    const result: unknown = structuredClone(await call());
    assert.deepEqual(result, failure);
    assert.throws(() => unwrapMcpIpcResult(result), (error) => {
      assert.equal(mcpConfigFailureMessage(error, getMcpCopy('en')), getMcpCopy('en').errors.invalidConfigFile(failure.path));
      return true;
    });
  }
  assert.equal(new Set(channels).size, calls.length);
});
