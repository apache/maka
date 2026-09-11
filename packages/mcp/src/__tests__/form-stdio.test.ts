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
    await waitForDiagnostic(manager, 'safe diagnostic');
    assert.ok(manager.status('stdio')?.stderrTail?.some((line) => line.includes('[redacted]')));
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

const PRIVATE_STATE = 'stdio-private-continuation-state';
const FORM_ANSWER = {
  action: 'accept' as const,
  values: { name: 'Ada', email: 'ada@example.com', confirm: true },
};

for (const mode of ['before', 'partial', 'continued', 'control'] as const) {
  test(`stdio ${mode} cannot expose continuation state before response or after settlement`, {
    timeout: 10_000,
  }, async () => {
    await withStdio(async (manager, statuses) => {
      const binding = manager.toolSnapshot().tools[0]!.binding;
      await manager.callTool(binding, { mode }, { requestInteraction: async () => FORM_ANSWER });
      if (mode === 'control') {
        await new Promise((resolve) => setTimeout(resolve, 100));
        await manager.callTool(binding, { mode: 'diagnostic' });
        assert.deepEqual(manager.status('stdio')?.stderrTail ?? [], []);
      } else {
        await waitForDiagnostic(manager, 'safe diagnostic');
      }
      const published = JSON.stringify([statuses, manager.status('stdio')]);
      assert.equal(published.includes(PRIVATE_STATE), false);
      assert.equal(published.includes('control-private-suffix'), false);
      assert.equal(published.includes(PRIVATE_STATE.slice(12)), false);
    });
  });
}

for (const [mode, allowed] of [
  ['retention', 64],
  ['byte-retention', 16],
] as const) {
  test(`stdio ${mode} retains old states without eviction and fails closed until reconnect`, {
    timeout: 20_000,
  }, async () => {
    await withStdio(async (manager, statuses) => {
      const binding = manager.toolSnapshot().tools[0]!.binding;
      for (let call = 0; call < allowed; call += 1) {
        await manager.callTool(binding, { mode }, { requestInteraction: async () => FORM_ANSWER });
      }
      await manager.callTool(binding, { mode: 'first-diagnostic' });
      assert.equal(JSON.stringify(statuses).includes(`${PRIVATE_STATE}-1`), false);
      await assert.rejects(
        manager.callTool(binding, { mode }, { requestInteraction: async () => FORM_ANSWER }),
      );
      await assert.rejects(
        manager.callTool(
          binding,
          { mode },
          {
            requestInteraction: async () =>
              assert.fail('exhausted connection must not show a form'),
          },
        ),
        /retention exhausted/,
      );
      await assert.rejects(
        manager.callTool(binding, { mode: 'diagnostic' }),
        /retention exhausted/,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(manager.status('stdio')?.stderrTail ?? [], []);
      assert.equal(JSON.stringify(statuses).includes(PRIVATE_STATE), false);
      await manager.reconnect('stdio');
      const freshBinding = manager.toolSnapshot().tools[0]!.binding;
      await manager.callTool(freshBinding, {}, { requestInteraction: async () => FORM_ANSWER });
      await waitForDiagnostic(manager, 'safe diagnostic');
      assert.equal(
        JSON.stringify([statuses, manager.status('stdio')]).includes(PRIVATE_STATE),
        false,
      );
    });
  });
}

async function withStdio(run: (manager: McpClientManager, statuses: unknown[]) => Promise<void>) {
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
    await run(manager, statuses);
  } finally {
    await manager.close();
  }
}

async function waitForDiagnostic(manager: McpClientManager, text: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (manager.status('stdio')?.stderrTail?.some((line) => line.includes(text))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Expected stderr diagnostic: ${text}`);
}

test('stdio non-ASCII state suppresses the generation even when UTF-8 stderr bytes split', {
  timeout: 10_000,
}, async () => {
  await withStdio(async (manager, statuses) => {
    const binding = manager.toolSnapshot().tools[0]!.binding;
    await manager.callTool(
      binding,
      { mode: 'unicode' },
      { requestInteraction: async () => FORM_ANSWER },
    );
    await manager.callTool(binding, { mode: 'unicode-diagnostic' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(manager.status('stdio')?.stderrTail ?? [], []);
    assert.equal(JSON.stringify(statuses).includes(PRIVATE_STATE), false);
  });
});

test('learning state clears already formatted or truncated stderr and notifies subscribers', {
  timeout: 10_000,
}, async () => {
  await withStdio(async (manager, statuses) => {
    const binding = manager.toolSnapshot().tools[0]!.binding;
    await manager.callTool(binding, { mode: 'future-diagnostic' });
    await waitForDiagnostic(manager, 'future-state-prefix');
    // The server emitted this value before it was identified as private state.
    assert.equal(JSON.stringify(statuses).includes('future-state-prefix'), true);
    await manager.callTool(
      binding,
      { mode: 'future' },
      {
        requestInteraction: async () => {
          assert.deepEqual(manager.status('stdio')?.stderrTail ?? [], []);
          assert.equal(JSON.stringify(statuses.at(-1)).includes('future-state-prefix'), false);
          return FORM_ANSWER;
        },
      },
    );
    assert.equal(JSON.stringify(manager.status('stdio')).includes('future-state-prefix'), false);
  });
});
