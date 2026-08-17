import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import {
  resolveRootControlNamespace,
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import {
  openInteractiveRuntimePolicyStoresForWrite,
  type RuntimePolicyStoresWriter,
} from '@maka/storage/runtime-policy-stores';
import { z } from 'zod';
import {
  connectRuntimeHost,
  RuntimeHostOperationError,
  type RuntimeHostConnection,
} from '../client/index.js';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '../protocol/index.js';
import type { RuntimeHostKernel } from '../server/host-kernel.js';
import type { StaticTrustedToolExtensionRevision } from '../server/extension-loader.js';
import { startExecutionRuntimeHostService } from '../server/execution-service.js';
import { waitForTerminalTurn } from './fixtures/execution-host-suite.js';

const MODEL_ID = 'extension-e2e-model';
const CONNECTION_SLUG = 'extension-e2e-provider';
const API_KEY = 'extension-e2e-key';
const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

test('trusted Tool Extension works through UDS, provider execution, rollback, and Host restarts', {
  timeout: 120_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-extension-e2e-'));
  const root = join(base, 'interactive');
  const invocationLog = join(base, 'extension-invocations.jsonl');
  const provider = await startProvider();
  const revisions = [
    extensionRevision('1', 21, invocationLog),
    extensionRevision('2', 27, invocationLog),
    extensionRevision('3', 99, invocationLog, async () => {
      throw new Error('weather revision 3 failed its real health check');
    }),
  ] satisfies readonly StaticTrustedToolExtensionRevision[];
  let host: RuntimeHostKernel | undefined;
  let client: RuntimeHostConnection | undefined;
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const statePath = join(
    resolveRootControlNamespace(),
    capability.rootId,
    'extension-bindings-v1.json',
  );

  try {
    await seedProvider(root, provider.baseUrl);
    ({ host, client } = await startHost(root, revisions));

    assert.deepEqual(await client.request('extension.catalog.query', {}), {
      revisions: [
        {
          extensionId: 'weather',
          revision: '1',
          toolNames: ['Weather'],
          uiContributionIds: [],
          eventContributionIds: [],
        },
        {
          extensionId: 'weather',
          revision: '2',
          toolNames: ['Weather'],
          uiContributionIds: [],
          eventContributionIds: [],
        },
        {
          extensionId: 'weather',
          revision: '3',
          toolNames: ['Weather'],
          uiContributionIds: [],
          eventContributionIds: [],
        },
      ],
      bindings: [],
    });
    await createSession(client, 'extension-session-a', root);
    await createSession(client, 'extension-session-b', root);

    const enabled = await client.request('extension.catalog.mutate', {
      kind: 'enable',
      bindingId: 'weather-binding',
      scopeId: 'extension-session-a',
      extensionId: 'weather',
      revision: '1',
    });
    assert.deepEqual(enabled.binding, {
      bindingId: 'weather-binding',
      scopeId: 'extension-session-a',
      extensionId: 'weather',
      desiredRevision: '1',
      lastGoodRevision: '1',
      enabled: true,
      status: 'active',
      error: null,
    });
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);

    const first = await runTurn(client, provider, 'extension-session-a', 'call weather v1');
    assert.deepEqual(first.tools.includes('Weather'), true);
    assert.match(first.toolResult ?? '', /"revision":"1"/u);
    assert.match(first.toolResult ?? '', /"temperature":21/u);
    assert.deepEqual(await invocationRevisions(invocationLog), ['1']);

    const isolated = await runTurn(
      client,
      provider,
      'extension-session-b',
      'scope isolation must hide weather',
    );
    assert.equal(isolated.tools.includes('Weather'), false);
    assert.equal(isolated.toolResult, undefined);
    assert.deepEqual(await invocationRevisions(invocationLog), ['1']);

    await assert.rejects(
      client.request('extension.catalog.mutate', {
        kind: 'enable',
        bindingId: 'duplicate-weather-binding',
        scopeId: 'extension-session-a',
        extensionId: 'weather',
        revision: '1',
      }),
      operationError('operation_conflict'),
    );

    const upgraded = await client.request('extension.catalog.mutate', {
      kind: 'update',
      bindingId: 'weather-binding',
      revision: '2',
    });
    assert.equal(upgraded.binding?.lastGoodRevision, '2');
    const second = await runTurn(client, provider, 'extension-session-a', 'call weather v2');
    assert.match(second.toolResult ?? '', /"revision":"2"/u);
    assert.match(second.toolResult ?? '', /"temperature":27/u);
    assert.deepEqual(await invocationRevisions(invocationLog), ['1', '2']);

    await assert.rejects(
      client.request('extension.catalog.mutate', {
        kind: 'update',
        bindingId: 'weather-binding',
        revision: '3',
      }),
      operationError('operation_conflict', /health_check/u),
    );
    const failed = await client.request('extension.catalog.query', {});
    assert.deepEqual(failed.bindings[0], {
      bindingId: 'weather-binding',
      scopeId: 'extension-session-a',
      extensionId: 'weather',
      desiredRevision: '3',
      lastGoodRevision: '2',
      enabled: true,
      status: 'failed',
      error: 'Extension candidate weather@3 health_check failed',
    });
    const afterFailure = await runTurn(
      client,
      provider,
      'extension-session-a',
      'failed upgrade must still call last-good',
    );
    assert.match(afterFailure.toolResult ?? '', /"revision":"2"/u);
    assert.deepEqual(await invocationRevisions(invocationLog), ['1', '2', '2']);

    await client.close();
    client = undefined;
    await host.close();
    host = undefined;
    ({ host, client } = await startHost(root, revisions));

    const recovered = await client.request('extension.catalog.query', {});
    assert.equal(recovered.bindings[0]?.desiredRevision, '3');
    assert.equal(recovered.bindings[0]?.lastGoodRevision, '2');
    assert.equal(recovered.bindings[0]?.status, 'failed');
    const afterRestart = await runTurn(
      client,
      provider,
      'extension-session-a',
      'restart must restore last-good',
    );
    assert.match(afterRestart.toolResult ?? '', /"revision":"2"/u);
    assert.deepEqual(await invocationRevisions(invocationLog), ['1', '2', '2', '2']);

    const disabled = await client.request('extension.catalog.mutate', {
      kind: 'disable',
      bindingId: 'weather-binding',
    });
    assert.equal(disabled.binding?.status, 'disabled');
    const afterDisable = await runTurn(
      client,
      provider,
      'extension-session-a',
      'disabled extension must disappear',
    );
    assert.equal(afterDisable.tools.includes('Weather'), false);
    assert.equal(afterDisable.toolResult, undefined);

    await client.close();
    client = undefined;
    await host.close();
    host = undefined;
    ({ host, client } = await startHost(root, revisions));
    const disabledAfterRestart = await client.request('extension.catalog.query', {});
    assert.equal(disabledAfterRestart.bindings[0]?.status, 'disabled');
    const stillDisabled = await runTurn(
      client,
      provider,
      'extension-session-a',
      'disabled state must survive restart',
    );
    assert.equal(stillDisabled.tools.includes('Weather'), false);

    await client.request('extension.catalog.mutate', {
      kind: 'enable',
      bindingId: 'weather-binding',
      scopeId: 'extension-session-a',
      extensionId: 'weather',
      revision: '1',
    });
    const reenabled = await runTurn(
      client,
      provider,
      'extension-session-a',
      're-enabled extension must return',
    );
    assert.match(reenabled.toolResult ?? '', /"revision":"1"/u);
    assert.deepEqual(await invocationRevisions(invocationLog), ['1', '2', '2', '2', '1']);

    assert.deepEqual(
      await client.request('extension.catalog.mutate', {
        kind: 'remove',
        bindingId: 'weather-binding',
      }),
      { binding: null },
    );
    const afterRemove = await runTurn(
      client,
      provider,
      'extension-session-a',
      'removed extension must disappear',
    );
    assert.equal(afterRemove.tools.includes('Weather'), false);
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), {
      schemaVersion: 1,
      bindings: [],
    });

    await client.close();
    client = undefined;
    await host.close();
    host = undefined;
    ({ host, client } = await startHost(root, revisions));
    assert.deepEqual((await client.request('extension.catalog.query', {})).bindings, []);
    const removedAfterRestart = await runTurn(
      client,
      provider,
      'extension-session-a',
      'removed state must survive restart',
    );
    assert.equal(removedAfterRestart.tools.includes('Weather'), false);
  } finally {
    await client?.close().catch(() => undefined);
    await host?.close().catch(() => undefined);
    await provider.close();
    await rm(join(resolveRootControlNamespace(), capability.rootId), {
      recursive: true,
      force: true,
    });
    await rm(base, { recursive: true, force: true });
  }
});

test('installed Tool package works through real UDS, provider execution, sandbox, restart, and uninstall', {
  timeout: 120_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-package-extension-e2e-'));
  const root = join(base, 'interactive');
  const source = join(base, 'weather-package');
  const invocationLog = join(root, 'package-weather-invocations.jsonl');
  const provider = await startProvider();
  let host: RuntimeHostKernel | undefined;
  let client: RuntimeHostConnection | undefined;
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });

  try {
    await createWeatherPackage(source);
    await seedProvider(root, provider.baseUrl);
    ({ host, client } = await startHost(root, []));
    const installed = await client.request('extension.package.install', { sourcePath: source });
    assert.equal(installed.extensionId, 'package-weather');
    assert.deepEqual(installed.toolNames, ['Weather']);
    assert.match(installed.revision, /^sha256-[a-f0-9]{64}$/u);

    await createSession(client, 'package-extension-session', root);
    const enabled = await client.request('extension.catalog.mutate', {
      kind: 'enable',
      bindingId: 'package-weather-binding',
      scopeId: 'package-extension-session',
      extensionId: installed.extensionId,
      revision: installed.revision,
    });
    assert.equal(enabled.binding?.status, 'active');
    const first = await runTurn(
      client,
      provider,
      'package-extension-session',
      'call installed package weather',
    );
    assert.equal(first.tools.includes('Weather'), true);
    assert.match(first.toolResult ?? '', /"source":"installed-package"/u);
    assert.match(first.toolResult ?? '', /"temperature":31/u);
    assert.equal((await readFile(invocationLog, 'utf8')).trim().split('\n').length, 1);

    await client.close();
    client = undefined;
    await host.close();
    host = undefined;
    ({ host, client } = await startHost(root, []));
    const recovered = await client.request('extension.catalog.query', {});
    assert.equal(recovered.bindings[0]?.status, 'active');
    assert.equal(recovered.revisions[0]?.revision, installed.revision);
    const afterRestart = await runTurn(
      client,
      provider,
      'package-extension-session',
      'call recovered package weather',
    );
    assert.match(afterRestart.toolResult ?? '', /"source":"installed-package"/u);
    assert.equal((await readFile(invocationLog, 'utf8')).trim().split('\n').length, 2);

    await client.request('extension.catalog.mutate', {
      kind: 'remove',
      bindingId: 'package-weather-binding',
    });
    await client.request('extension.package.uninstall', {
      extensionId: installed.extensionId,
      revision: installed.revision,
    });
    assert.deepEqual(await client.request('extension.catalog.query', {}), {
      revisions: [],
      bindings: [],
    });
    const removed = await runTurn(
      client,
      provider,
      'package-extension-session',
      'uninstalled package must disappear',
    );
    assert.equal(removed.tools.includes('Weather'), false);
  } finally {
    await client?.close().catch(() => undefined);
    await host?.close().catch(() => undefined);
    await provider.close();
    await rm(join(resolveRootControlNamespace(), capability.rootId), {
      recursive: true,
      force: true,
    });
    await rm(base, { recursive: true, force: true });
  }
});

async function createWeatherPackage(source: string): Promise<void> {
  await mkdir(join(source, 'dist'), { recursive: true });
  await writeFile(
    join(source, 'maka.extension.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: 'package-weather',
        version: '1.0.0',
        runtime: {
          entry: 'dist/index.mjs',
          tools: [
            {
              name: 'Weather',
              description: 'Read deterministic weather from an installed package.',
              handler: 'Weather',
              inputSchema: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
                additionalProperties: false,
              },
              category: 'file_write',
              recoveryMode: 'never_auto_retry',
            },
          ],
          events: [],
          listeners: [],
          services: [],
          timers: [],
          permissions: { workspace: 'write', network: false },
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(source, 'dist', 'index.mjs'),
    `import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
export default {
  Weather: async ({ city }, context) => {
    await appendFile(join(context.cwd, 'package-weather-invocations.jsonl'), JSON.stringify({ city, sessionId: context.sessionId }) + '\\n', 'utf8');
    return { source: 'installed-package', city, temperature: 31 };
  },
};
`,
  );
}

function extensionRevision(
  revision: string,
  temperature: number,
  invocationLog: string,
  healthCheck?: () => void | Promise<void>,
): StaticTrustedToolExtensionRevision {
  const tool: MakaTool = {
    name: 'Weather',
    description: `Read deterministic weather from trusted revision ${revision}.`,
    parameters: z.object({ city: z.string().min(1) }),
    impl: async ({ city }: { city: string }, context) => {
      await appendFile(
        invocationLog,
        `${JSON.stringify({
          revision,
          city,
          sessionId: context.sessionId,
          turnId: context.turnId,
          toolCallId: context.toolCallId,
        })}\n`,
        'utf8',
      );
      return { source: 'trusted-extension', revision, city, temperature };
    },
  };
  return {
    extensionId: 'weather',
    revision,
    tools: [tool],
    ...(healthCheck ? { healthCheck } : {}),
  };
}

async function seedProvider(root: string, baseUrl: string): Promise<void> {
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  try {
    const policy = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const created = await policy.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: CONNECTION_SLUG,
        name: 'Extension E2E provider',
        providerType: 'moonshot',
        baseUrl,
        enabled: true,
        enabledModelIds: [MODEL_ID],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') return;
    const connection = created.snapshot.connections[0];
    assert.ok(connection);
    if (!connection) return;
    const credential = await policy.credentialVault.set({
      locator: {
        scope: 'connection',
        connectionId: connection.connectionId,
        kind: 'api_key',
      },
      expected: null,
      secret: API_KEY,
    });
    assert.equal(credential.kind, 'committed');
    await publishConnectionModel(policy, connection.connectionId);
  } finally {
    await owner.close();
  }
}

async function publishConnectionModel(
  policy: RuntimePolicyStoresWriter,
  connectionId: string,
): Promise<void> {
  const prepared = await policy.operations.beginModelFetch(connectionId);
  assert.equal(prepared.kind, 'ready');
  if (prepared.kind !== 'ready') return;
  const committed = await policy.operations.completeModelFetch(prepared.ticket, {
    models: [
      {
        id: MODEL_ID,
        capabilities: { chat: true, functionCalling: true },
        contextWindow: 8_192,
        maxOutputTokens: 256,
      },
    ],
    source: 'fetched',
    fetchedAt: Date.now(),
  });
  assert.equal(committed.kind, 'committed');
}

async function startHost(
  root: string,
  trustedToolExtensions: readonly StaticTrustedToolExtensionRevision[],
): Promise<{ host: RuntimeHostKernel; client: RuntimeHostConnection }> {
  const host = await startExecutionRuntimeHostService({
    rootPath: root,
    trustedToolExtensions,
  });
  const connected = await connectRuntimeHost({
    rootPath: root,
    surface: 'desktop',
    protocol: PROTOCOL,
  });
  assert.equal(connected.kind, 'connected');
  if (connected.kind !== 'connected') {
    await host.close();
    throw new Error('Runtime Host Client did not connect');
  }
  return { host, client: connected.connection };
}

async function createSession(
  client: RuntimeHostConnection,
  sessionId: string,
  root: string,
): Promise<void> {
  const created = await client.request('session.create', {
    sessionId,
    workspace: { kind: 'host_path', path: root },
    modelTarget: {
      kind: 'explicit',
      connectionSlug: CONNECTION_SLUG,
      model: MODEL_ID,
    },
    permissionMode: 'bypass',
  });
  assert.equal('kind' in created, false);
}

async function runTurn(
  client: RuntimeHostConnection,
  provider: Awaited<ReturnType<typeof startProvider>>,
  sessionId: string,
  marker: string,
): Promise<{ tools: readonly string[]; toolResult: string | undefined }> {
  const before = provider.requests.length;
  const turnId = randomUUID();
  const started = await client.startTurn({
    sessionId,
    turnId,
    content: { text: marker },
    maxSteps: 8,
  });
  assert.equal(started.kind, 'started');
  const terminal = await waitForTerminalTurn(client, sessionId, turnId);
  assert.equal(terminal.status, 'completed', JSON.stringify(terminal));
  const requests = provider.requests.slice(before).filter(({ body }) => body.stream === true);
  assert.ok(requests.length >= 1, `Provider did not receive Turn ${turnId}`);
  const first = requests[0];
  const toolResult = requests.map(({ body }) => latestToolResult(body)).find(Boolean);
  return { tools: toolNames(first?.body), toolResult };
}

async function invocationRevisions(path: string): Promise<string[]> {
  const content = await readFile(path, 'utf8');
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { revision: string }).revision);
}

function operationError(code: string, message?: RegExp): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof RuntimeHostOperationError &&
    error.code === code &&
    (message ? message.test(error.message) : true);
}

interface ProviderRequest {
  readonly body: Record<string, unknown>;
}

async function startProvider(): Promise<{
  readonly baseUrl: string;
  readonly requests: ProviderRequest[];
  close(): Promise<void>;
}> {
  const requests: ProviderRequest[] = [];
  let callSequence = 0;
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.authorization, `Bearer ${API_KEY}`);
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      requests.push({ body });
      if (body.stream !== true) {
        respondJson(response, 'Extension E2E background effect completed.');
        return;
      }
      const result = latestToolResult(body);
      if (result !== undefined) {
        respondText(response, `Observed trusted Tool result: ${result}`);
        return;
      }
      if (toolNames(body).includes('Weather')) {
        callSequence += 1;
        respondToolCall(response, callSequence, 'Weather', { city: 'Hangzhou' });
        return;
      }
      respondText(response, 'Weather is not available in this Session scope.');
    })().catch((error) => response.destroy(error as Error));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function toolNames(body: Record<string, unknown> | undefined): string[] {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return tools.flatMap((tool) => {
    if (!tool || typeof tool !== 'object') return [];
    const fn = (tool as { function?: unknown }).function;
    if (!fn || typeof fn !== 'object') return [];
    const name = (fn as { name?: unknown }).name;
    return typeof name === 'string' ? [name] : [];
  });
}

function latestToolResult(body: Record<string, unknown>): string | undefined {
  const messages: unknown[] = Array.isArray(body.messages) ? body.messages : [];
  let currentTurnStart = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && typeof message === 'object' && 'role' in message && message.role === 'user') {
      currentTurnStart = index;
      break;
    }
  }
  const content = messages
    .slice(currentTurnStart + 1)
    .filter(
      (message): message is Record<string, unknown> =>
        message !== null &&
        typeof message === 'object' &&
        'role' in message &&
        message.role === 'tool',
    )
    .at(-1)?.content;
  return typeof content === 'string'
    ? content
    : content === undefined
      ? undefined
      : JSON.stringify(content);
}

function respondToolCall(
  response: ServerResponse,
  sequence: number,
  toolName: string,
  args: Record<string, unknown>,
): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(
    `data: ${JSON.stringify({
      id: `extension-tool-${sequence}`,
      object: 'chat.completion.chunk',
      created: sequence,
      model: MODEL_ID,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `extension-tool-call-${sequence}`,
                type: 'function',
                function: { name: toolName, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      id: `extension-tool-${sequence}`,
      object: 'chat.completion.chunk',
      created: sequence,
      model: MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })}\n\n`,
  );
  response.end('data: [DONE]\n\n');
}

function respondText(response: ServerResponse, text: string): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(
    `data: ${JSON.stringify({
      id: `extension-text-${randomUUID()}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: MODEL_ID,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: text },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      id: `extension-text-${randomUUID()}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
    })}\n\n`,
  );
  response.end('data: [DONE]\n\n');
}

function respondJson(response: ServerResponse, text: string): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      id: 'extension-background-effect',
      object: 'chat.completion',
      created: 1,
      model: MODEL_ID,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }),
  );
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}
