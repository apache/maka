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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { RuntimeHostReconnectingConnection } from '@maka/runtime-host/client';
import { RuntimeHostRunMcp } from '../runtime-host-run-mcp.js';

test('headless MCP preparation rejects an enabled server whose connection failed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-run-mcp-'));
  let replacements = 0;
  const connection = {
    subscribeConnectionAvailability: (listener: (availability: unknown) => void) => {
      listener({ kind: 'connected', hostEpoch: 'epoch', connectionId: 'run' });
      return () => undefined;
    },
    replaceClientCapabilities: async () => {
      replacements += 1;
    },
    unregisterClientCapabilities: async () => undefined,
  } as unknown as RuntimeHostReconnectingConnection;
  const mcp = new RuntimeHostRunMcp(root, connection);
  try {
    await writeFile(
      join(root, 'mcp.json'),
      JSON.stringify({
        version: 3,
        mcpServers: {
          missing: { command: join(root, 'missing-executable'), enabled: true },
        },
      }),
    );
    await assert.rejects(
      () => mcp.prepare('session-1'),
      /Session MCP server\(s\) unavailable: missing \(error\)/u,
    );
    assert.equal(replacements, 0);
  } finally {
    await mcp.close();
    await rm(root, { recursive: true, force: true });
  }
});
