import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, test } from 'node:test';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpConfigFile } from '@maka/core/mcp';
import { buildStdioEnvironment, McpClientManager, McpToolCallError } from '../index.js';

const fixturePath = fileURLToPath(new URL('../__fixtures__/stdio-server.js', import.meta.url));
const managers: McpClientManager[] = [];
const remoteFixtures: RemoteFixture[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(remoteFixtures.splice(0).map((fixture) => fixture.close()));
});

describe('McpClientManager remote transport E2E', () => {
  test('connects with Streamable HTTP and forwards configured headers', async () => {
    const fixture = await createRemoteFixture('streamable-http');
    const manager = createManager();
    await manager.sync(remoteConfig(fixture.url));

    assert.equal(manager.status('remote')?.transport, 'streamable-http');
    assert.deepEqual(await manager.callTool('remote', 'echo', { value: 'http' }), {
      content: [{ type: 'text', text: 'http' }],
      structuredContent: undefined,
    });
    assert.ok(
      fixture.requests.some(
        (request) => request.path === '/mcp' && request.authorization === 'Bearer remote-test',
      ),
    );
  });

  test('auto falls back to legacy SSE without replacing protocol headers', async () => {
    const fixture = await createRemoteFixture('sse');
    const manager = createManager();
    await manager.sync(remoteConfig(`${fixture.url}/sse`, 'auto'));

    assert.equal(manager.status('remote')?.transport, 'sse');
    const result = await manager.callTool('remote', 'echo', { value: 'legacy' });
    assert.deepEqual(result.content, [{ type: 'text', text: 'legacy' }]);
    const get = fixture.requests.find(
      (request) => request.method === 'GET' && request.path === '/sse',
    );
    assert.equal(get?.authorization, 'Bearer remote-test');
    assert.match(get?.accept ?? '', /text\/event-stream/u);
    assert.ok(
      fixture.requests.some(
        (request) =>
          request.method === 'POST' &&
          request.path === '/messages' &&
          request.authorization === 'Bearer remote-test',
      ),
    );
  });
});

describe('McpClientManager stdio E2E', () => {
  test('discovers paginated tools and calls structured content', async () => {
    const manager = createManager();
    await manager.sync(fixtureConfig());

    const status = manager.status('fixture');
    assert.equal(status?.state, 'connected');
    assert.equal(status?.transport, 'stdio');
    assert.deepEqual(
      status?.tools.map((tool) => tool.name),
      ['echo', 'rich', 'fail', 'slow'],
    );
    assert.equal(status?.tools[0]?.annotations?.readOnlyHint, true);

    const echo = await manager.callTool('fixture', 'echo', { value: 'Maka' });
    assert.deepEqual(echo.content, [{ type: 'text', text: 'Maka' }]);
    assert.deepEqual(echo.structuredContent, { echoed: 'Maka' });

    const rich = await manager.callTool('fixture', 'rich', {});
    assert.deepEqual(
      rich.content.map((block) => block.type),
      ['text', 'image', 'audio', 'resource', 'resource_link'],
    );
  });

  test('maps protocol isError to the Maka error path', async () => {
    const manager = createManager();
    await manager.sync(fixtureConfig());
    await assert.rejects(
      manager.callTool('fixture', 'fail', {}),
      (error: unknown) =>
        error instanceof McpToolCallError && /deliberate failure/u.test(error.message),
    );
  });

  test('propagates caller abort to an in-flight tool call', async () => {
    const manager = createManager();
    await manager.sync(fixtureConfig());
    const controller = new AbortController();
    const call = manager.callTool('fixture', 'slow', {}, { signal: controller.signal });
    controller.abort();
    await assert.rejects(call, /abort|cancel/iu);
  });

  test('enforces the configured tool call timeout', async () => {
    const manager = new McpClientManager({
      timeouts: { stdioConnectMs: 5_000, listToolsMs: 5_000, callToolMs: 25 },
    });
    managers.push(manager);
    await manager.sync(fixtureConfig());
    await assert.rejects(manager.callTool('fixture', 'slow', {}), /timed out|timeout/iu);
  });

  test('captures bounded stderr diagnostics when stdio startup fails', async () => {
    const manager = createManager();
    const config = fixtureConfig(['--crash']);
    await manager.sync(config);
    const status = manager.status('fixture');
    assert.equal(status?.state, 'error');
    assert.match(status?.error ?? '', /fixture startup failed/u);
    assert.deepEqual(status?.stderrTail, ['fixture startup failed: deliberate diagnostic']);
  });

  test('cancels an in-flight installation connect without leaving tools visible', async () => {
    const manager = createManager();
    const sync = manager.sync(fixtureConfig(['--slow-start']));
    await waitFor(() => manager.status('fixture')?.state === 'connecting');
    assert.equal(manager.cancelConnect('fixture'), true);
    await sync;
    await manager.sync({ version: 1, mcpServers: {} });
    assert.equal(manager.status('fixture'), undefined);
    assert.deepEqual(manager.tools(), []);
  });

  test('captures and redacts a final stderr fragment without a newline', async () => {
    const manager = createManager();
    await manager.sync(fixtureConfig(['--crash-secret-tail']));
    const status = manager.status('fixture');
    assert.equal(status?.state, 'error');
    assert.deepEqual(status?.stderrTail, ['token=[redacted]']);
    assert.doesNotMatch(status?.error ?? '', /sk-live/u);
  });

  test('does not revise callable tools for status-only stderr updates', async () => {
    const manager = createManager();
    await manager.sync(fixtureConfig(['--runtime-stderr']));
    const revision = manager.toolSnapshotRevision();

    await waitFor(
      () => manager.status('fixture')?.stderrTail?.includes('runtime diagnostic') === true,
      2_000,
    );

    assert.equal(manager.toolSnapshotRevision(), revision);
  });

  test('does not revise callable tools when discovery returns the same catalog', async () => {
    const manager = createManager();
    await manager.sync(fixtureConfig());
    const revision = manager.toolSnapshotRevision();

    await manager.refreshTools('fixture');

    assert.equal(manager.toolSnapshotRevision(), revision);
  });

  test('reconciles disable and removal without leaving tools visible', async () => {
    const manager = createManager();
    await manager.sync(fixtureConfig());
    await manager.sync({
      version: 1,
      mcpServers: { fixture: { ...fixtureConfig().mcpServers.fixture, enabled: false } },
    });
    assert.equal(manager.status('fixture')?.state, 'disabled');
    assert.deepEqual(manager.tools(), []);
    assert.equal((await manager.test('fixture')).ok, false);
    await manager.sync({ version: 1, mcpServers: {} });
    assert.equal(manager.status('fixture'), undefined);
  });
});

test('buildStdioEnvironment uses an allowlist and explicit values override it', () => {
  assert.deepEqual(
    buildStdioEnvironment(
      { API_TOKEN: 'explicit', PATH: '/custom' },
      {
        PATH: '/bin',
        HOME: '/home/u',
        AWS_SECRET_ACCESS_KEY: 'leak',
        LC_ALL: 'C',
        XDG_CONFIG_HOME: '/x',
      },
    ),
    { PATH: '/custom', HOME: '/home/u', LC_ALL: 'C', XDG_CONFIG_HOME: '/x', API_TOKEN: 'explicit' },
  );
});

function createManager(): McpClientManager {
  const manager = new McpClientManager({
    timeouts: { stdioConnectMs: 5_000, listToolsMs: 5_000, callToolMs: 5_000 },
  });
  managers.push(manager);
  return manager;
}

function fixtureConfig(extraArgs: string[] = []): McpConfigFile {
  return {
    version: 1,
    mcpServers: {
      fixture: {
        command: process.execPath,
        args: [fixturePath, ...extraArgs],
      },
    },
  };
}

function remoteConfig(
  url: string,
  transport: 'auto' | 'streamable-http' = 'streamable-http',
): McpConfigFile {
  return {
    version: 1,
    mcpServers: {
      remote: { url, transport, headers: { Authorization: 'Bearer remote-test' } },
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not reached');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface RemoteRequest {
  method: string;
  path: string;
  authorization?: string;
  accept?: string;
}

interface RemoteFixture {
  url: string;
  requests: RemoteRequest[];
  close(): Promise<void>;
}

async function createRemoteFixture(kind: 'streamable-http' | 'sse'): Promise<RemoteFixture> {
  const requests: RemoteRequest[] = [];
  const sseTransports = new Map<string, { transport: SSEServerTransport; server: McpServer }>();
  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({
      method: req.method ?? 'GET',
      path: url.pathname,
      ...(typeof req.headers.authorization === 'string'
        ? { authorization: req.headers.authorization }
        : {}),
      ...(typeof req.headers.accept === 'string' ? { accept: req.headers.accept } : {}),
    });
    try {
      if (kind === 'streamable-http' && url.pathname === '/mcp' && req.method === 'POST') {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const server = createProtocolServer();
        await server.connect(transport);
        res.once('close', () => {
          void transport.close();
          void server.close();
        });
        await transport.handleRequest(req, res, await readJsonBody(req));
        return;
      }
      if (kind === 'sse' && url.pathname === '/sse' && req.method === 'GET') {
        const transport = new SSEServerTransport('/messages', res);
        const server = createProtocolServer();
        sseTransports.set(transport.sessionId, { transport, server });
        res.once('close', () => sseTransports.delete(transport.sessionId));
        await server.connect(transport);
        return;
      }
      if (kind === 'sse' && url.pathname === '/messages' && req.method === 'POST') {
        const entry = sseTransports.get(url.searchParams.get('sessionId') ?? '');
        if (!entry) {
          res.writeHead(400).end('unknown SSE session');
          return;
        }
        await entry.transport.handlePostMessage(req, res, await readJsonBody(req));
        return;
      }
      res
        .writeHead(404, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'not found' }));
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('remote fixture did not bind TCP');
  const fixture: RemoteFixture = {
    url: `http://127.0.0.1:${address.port}${kind === 'streamable-http' ? '/mcp' : ''}`,
    requests,
    close: async () => {
      await Promise.all(
        [...sseTransports.values()].map(async ({ transport, server }) => {
          await transport.close().catch(() => {});
          await server.close().catch(() => {});
        }),
      );
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
  remoteFixtures.push(fixture);
  return fixture;
}

function createProtocolServer(): McpServer {
  const server = new McpServer(
    { name: 'maka-remote-fixture', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'echo',
        description: 'Echo text',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({
    content: [{ type: 'text', text: String(params.arguments?.value ?? '') }],
  }));
  return server;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}
