import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { McpClientManager } from '@maka/mcp';
import { buildMcpTools } from '@maka/runtime/mcp-tools';

const fixturePath = fileURLToPath(new URL('../../../../../packages/mcp/dist/__fixtures__/stdio-server.js', import.meta.url));

test('MCP tools stay bound to the connection generation that advertised them', async () => {
  const manager = new McpClientManager({
    timeouts: { stdioConnectMs: 5_000, listToolsMs: 5_000, callToolMs: 5_000 },
  });
  try {
    await manager.sync({
      version: 1,
      mcpServers: {
        fixture: { command: process.execPath, args: [fixturePath] },
      },
    });
    const tools = buildMcpTools(manager);
    const echo = tools.find((tool) => tool.name === 'mcp__fixture__echo');
    assert.ok(echo);
    assert.equal(echo.categoryHint, 'network_send');
    const result = await echo.impl({ value: 'runtime-e2e' }, {
      sessionId: 'session', turnId: 'turn', cwd: process.cwd(), toolCallId: 'call',
      abortSignal: new AbortController().signal, emitOutput() {},
    });
    assert.deepEqual(result, {
      content: [{ type: 'text', text: 'runtime-e2e' }],
      structuredContent: { echoed: 'runtime-e2e' },
    });

    const firstRevision = manager.toolSnapshot().revision;
    await manager.reconnect('fixture');
    assert.ok(manager.toolSnapshot().revision > firstRevision);
    await assert.rejects(
      async () =>
        echo.impl(
          { value: 'stale-generation' },
          {
            sessionId: 'session',
            turnId: 'turn',
            cwd: process.cwd(),
            toolCallId: 'stale-call',
            abortSignal: new AbortController().signal,
            emitOutput() {},
          },
        ),
      /tool binding is stale/u,
    );

    const replacement = buildMcpTools(manager).find(
      (tool) => tool.name === 'mcp__fixture__echo',
    );
    assert.ok(replacement);
    assert.deepEqual(
      await replacement.impl(
        { value: 'replacement-generation' },
        {
          sessionId: 'session',
          turnId: 'turn',
          cwd: process.cwd(),
          toolCallId: 'replacement-call',
          abortSignal: new AbortController().signal,
          emitOutput() {},
        },
      ),
      {
        content: [{ type: 'text', text: 'replacement-generation' }],
        structuredContent: { echoed: 'replacement-generation' },
      },
    );
  } finally {
    await manager.close();
  }
});
