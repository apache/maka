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
    'mcp:upsert',
    'mcp:remove',
    'mcp:login',
    'mcp:cancelLogin',
    'mcp:logout',
  ]) {
    assert.match(preloadSource, new RegExp(`invokeSelectedRuntimeHost\\(host, '${channel}'`, 'u'));
  }
});
