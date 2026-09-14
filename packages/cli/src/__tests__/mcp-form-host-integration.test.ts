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
import { test } from 'node:test';
import { MCP_CONFIG_VERSION } from '@maka/core/mcp';
import { McpClientManager } from '@maka/mcp';
import { createMcpFormFixture } from '@maka/mcp/test-only/form-server';
import { withClientCapabilityFormHost } from '@maka/runtime-host/test-only/client-capability-host';
import { createMcpCapabilityProvider } from '../mcp-capability-provider.js';

const values = { name: 'Ada', email: 'ada@example.com', confirm: true };

for (const action of ['accept', 'decline', 'cancel'] as const) {
  test(`TUI modern MCP ${action} travels through the canonical Host form and back to the server`, {
    timeout: 15_000,
  }, async () => {
    await withFixture(async (manager, server, provider) => {
      await withClientCapabilityFormHost(provider, async (host) => {
        const result = host.start();
        const pending = await host.pending();
        assert.equal(pending.request.kind, 'form');
        assert.equal(server.calls.length, 1);
        // The real broker has paused its execution timer while the Host owns the form.
        assert.equal(host.timers.size, 0);
        await new Promise<void>((resolve) => setTimeout(resolve, action === 'accept' ? 1_100 : 30));
        assert.equal(host.timers.size, 0);
        assert.equal((await host.store.listSessionPending('session_1')).length, 1);
        if (action === 'accept') {
          const rejected = await host.answer(pending.requestId, {
            action,
            values: { ...values, confirm: 'yes' },
          });
          assert.equal(rejected.ok, false);
          assert.equal(server.calls.length, 1);
        }
        const answered = await host.answer(
          pending.requestId,
          action === 'accept' ? { action, values } : { action },
        );
        assert.equal(answered.ok, true, JSON.stringify(answered));
        const settled = await result;
        assert.deepEqual(settled.result, { content: [{ type: 'text', text: 'complete' }] });
        assert.equal(server.calls.length, 2);
        assert.notEqual(server.calls[0]?.id, server.calls[1]?.id);
        assert.deepEqual(server.calls[1]?.params.arguments, server.calls[0]?.params.arguments);
        assert.equal(server.calls[1]?.params.requestState, 'opaque-state');
        assert.deepEqual(server.calls[1]?.params.inputResponses, {
          form: action === 'accept' ? { action, content: values } : { action },
        });
        assert.equal((await host.store.listSessionPending('session_1')).length, 0);
        assert.equal(host.events.filter((event) => event.type === 'form_answer_ack').length, 1);
        assert.equal(JSON.stringify(host.events).includes('opaque-state'), false);
        assert.ok(manager.status('fixture'));
      });
    });
  });
}

test('TUI handles a second MCP question as a new canonical Host form', {
  timeout: 15_000,
}, async () => {
  await withFixture(async (_manager, server, provider) => {
    const originalRespond = server.respond;
    let answeredRounds = 0;
    server.respond = (params) => {
      if (params.inputResponses && ++answeredRounds === 1)
        return originalRespond({ name: params.name });
      return originalRespond(params);
    };
    await withClientCapabilityFormHost(provider, async (host) => {
      const result = host.start();
      const first = await host.pending();
      assert.equal((await host.answer(first.requestId, { action: 'decline' })).ok, true);
      const second = await host.pending();
      assert.notEqual(second.requestId, first.requestId);
      assert.equal(server.calls.length, 2);
      assert.equal((await host.answer(second.requestId, { action: 'accept', values })).ok, true);
      assert.deepEqual((await result).result, { content: [{ type: 'text', text: 'complete' }] });
      assert.equal(server.calls.length, 3);
      assert.deepEqual(server.calls[1]?.params.inputResponses, { form: { action: 'decline' } });
      assert.deepEqual(server.calls[2]?.params.inputResponses, {
        form: { action: 'accept', content: values },
      });
      assert.equal((await host.store.listSessionPending('session_1')).length, 0);
    });
  });
});

for (const exit of ['stop', 'disconnect', 'provider loss'] as const) {
  test(`TUI ${exit} closes a pending modern MCP Host form without a user answer or retry`, {
    timeout: 15_000,
  }, async () => {
    await withFixture(async (manager, server, provider) => {
      await withClientCapabilityFormHost(provider, async (host) => {
        const result = host.start();
        const pending = await host.pending();
        if (exit === 'stop') await host.stop();
        else if (exit === 'provider loss') await host.disconnectProvider();
        else await manager.disconnect('fixture');
        await result;
        const stored = await host.store.readInteraction(pending.requestId);
        assert.equal(stored?.outcome?.outcome.kind, 'closure');
        assert.equal((await host.store.listSessionPending('session_1')).length, 0);
        assert.equal(server.calls.length, 1);
        assert.equal(host.events.filter((event) => event.type === 'form_answer_ack').length, 0);
        assert.equal(
          (await host.answer(pending.requestId, { action: 'accept', values })).ok,
          false,
        );
        assert.equal(host.timers.size, 0);
      });
    });
  });
}

async function withFixture(
  run: (
    manager: McpClientManager,
    server: Awaited<ReturnType<typeof createMcpFormFixture>>,
    provider: ReturnType<typeof createProvider>,
  ) => Promise<void>,
) {
  const server = await createMcpFormFixture();
  const manager = new McpClientManager({ timeouts: { callToolMs: 1_000 } });
  try {
    await manager.sync({
      version: MCP_CONFIG_VERSION,
      mcpServers: {
        fixture: { url: server.url, transport: 'streamable-http', protocol: '2026-07-28' },
      },
    });
    const provider = createProvider(manager);
    await run(manager, server, provider);
  } finally {
    await manager.close();
    await server.close();
  }
}

function createProvider(manager: McpClientManager) {
  const provider = createMcpCapabilityProvider(manager);
  assert.ok(provider);
  return provider;
}
