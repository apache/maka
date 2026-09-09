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
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { MCP_CONFIG_VERSION } from '@maka/core/mcp';
import { McpClientManager } from '../index.js';

const fixturePath = fileURLToPath(new URL('../__fixtures__/form-stdio-server.js', import.meta.url));

test('modern-only stdio auto negotiation completes a form and protects state reflected on stderr', async () => {
  const manager = new McpClientManager({ timeouts: { stdioConnectMs: 5_000, callToolMs: 2_000 } });
  const statuses: unknown[] = [];
  manager.onChange((status) => statuses.push(status));
  try {
    await manager.sync({
      version: MCP_CONFIG_VERSION,
      mcpServers: {
        stdio: { command: process.execPath, args: [fixturePath], protocol: 'auto' },
      },
    });
    assert.deepEqual(manager.status('stdio')?.negotiatedProtocol, {
      era: 'modern',
      revision: '2026-07-28',
    });
    const binding = manager.toolSnapshot().tools[0]?.binding;
    assert.ok(binding);
    let forms = 0;
    const values = { name: 'Ada', email: 'ada@example.com', confirm: true };
    const result = await manager.callTool(
      binding,
      {},
      {
        requestInteraction: async (form) => {
          forms += 1;
          assert.deepEqual(
            form.fields.map((field) => field.name),
            ['name', 'email', 'confirm'],
          );
          return { action: 'accept', values };
        },
      },
    );
    assert.equal(forms, 1);
    assert.deepEqual(result.structuredContent, { answer: { action: 'accept', content: values } });
    assert.ok(manager.status('stdio')?.stderrTail?.some((line) => line.includes('continuation:')));
    assert.equal(
      JSON.stringify([statuses, manager.status('stdio'), result]).includes(
        'stdio-private-continuation-state',
      ),
      false,
    );
  } finally {
    await manager.close();
  }
});
