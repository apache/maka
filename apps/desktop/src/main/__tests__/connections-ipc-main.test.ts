import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, test } from 'node:test';
import type { CreateConnectionInput, LlmConnection, UpdateConnectionInput } from '@maka/core';
import { registerConnectionsIpc } from '../connections-ipc-main.js';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

function registerHandlers(
  overrides: Record<string, unknown> = {},
): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const deps = {
    ipcMain: {
      handle(channel: string, handler: Handler) {
        handlers.set(channel, handler);
      },
    },
    connectionStore: {
      create: async (input: CreateConnectionInput) => ({
        ...input,
        defaultModel: input.defaultModel ?? 'test-model',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      }),
      get: async () => null,
      update: async () => null,
      remove: async () => {},
    },
    credentialStore: {
      setSecret: async () => {},
      deleteSecret: async () => {},
    },
    syncOAuthModelConnections: async () => {},
    resolveConnectionSecret: async () => null,
    hasConnectionSecret: async () => false,
    disconnectManagedOAuthConnection: async () => {},
    emitConnectionListChanged: () => {},
    ...overrides,
  } as unknown as Parameters<typeof registerConnectionsIpc>[0];

  registerConnectionsIpc(deps);
  return handlers;
}

describe('connection IPC credential boundary', () => {
  test('create rejects an invalid slug before connection or credential persistence', async () => {
    const sideEffects: string[] = [];
    const handlers = registerHandlers({
      connectionStore: {
        create: async () => {
          sideEffects.push('connection');
          throw new Error('must not persist');
        },
      },
      credentialStore: {
        setSecret: async () => {
          sideEffects.push('credential');
        },
      },
    });

    const create = handlers.get('connections:create');
    assert.ok(create);
    for (const slug of [
      42,
      '',
      'a'.repeat(65),
      'line\nbreak',
      'path/segment',
      'path\\segment',
      'path:segment',
      'white space',
      'a..b',
    ]) {
      await assert.rejects(
        create({}, {
          slug,
          name: 'Invalid',
          providerType: 'openai',
          apiKey: 'safe-test-value',
        }),
        /connection slug/,
      );
    }
    assert.deepEqual(sideEffects, []);
  });

  test('create rejects non-string and oversized API keys before persistence', async () => {
    const sideEffects: string[] = [];
    const handlers = registerHandlers({
      connectionStore: {
        create: async () => {
          sideEffects.push('connection');
          throw new Error('must not persist');
        },
      },
      credentialStore: {
        setSecret: async () => {
          sideEffects.push('credential');
        },
      },
    });

    const create = handlers.get('connections:create');
    assert.ok(create);
    for (const apiKey of [42, 'x'.repeat(4097)]) {
      await assert.rejects(
        create({}, {
          slug: 'openai-main',
          name: 'OpenAI',
          providerType: 'openai',
          apiKey,
        }),
        /apiKey/,
      );
    }
    assert.deepEqual(sideEffects, []);
  });

  test('create rejects an invalid API key without persisting or exposing it', async () => {
    const sideEffects: string[] = [];
    const secret = 'private-value\nwith-control-character';
    const handlers = registerHandlers({
      connectionStore: {
        create: async () => {
          sideEffects.push('connection');
          throw new Error('must not persist');
        },
      },
      credentialStore: {
        setSecret: async () => {
          sideEffects.push('credential');
        },
      },
    });

    const create = handlers.get('connections:create');
    assert.ok(create);
    await assert.rejects(
      create({}, {
        slug: 'openai-main',
        name: 'OpenAI',
        providerType: 'openai',
        apiKey: secret,
      }),
      (error: unknown) => error instanceof Error && !error.message.includes(secret),
    );
    assert.deepEqual(sideEffects, []);
  });

  test('update rejects an invalid slug before reading or mutating persistence', async () => {
    const sideEffects: string[] = [];
    const handlers = registerHandlers({
      connectionStore: {
        get: async () => {
          sideEffects.push('read');
          return null;
        },
        update: async () => {
          sideEffects.push('connection');
          return null;
        },
      },
      credentialStore: {
        setSecret: async () => {
          sideEffects.push('credential');
        },
        deleteSecret: async () => {
          sideEffects.push('credential');
        },
      },
    });

    const update = handlers.get('connections:update');
    assert.ok(update);
    await assert.rejects(update({}, '../escape', { apiKey: 'safe-test-value' }), /connection slug/);
    assert.deepEqual(sideEffects, []);
  });

  test('every renderer-controlled slug handler rejects traversal before external work', async () => {
    const sideEffects: string[] = [];
    const mark = (effect: string) => {
      sideEffects.push(effect);
      return null;
    };
    const handlers = registerHandlers({
      connectionStore: {
        get: async () => mark('connection:get'),
        update: async () => mark('connection:update'),
        remove: async () => mark('connection:remove'),
        setDefault: async () => mark('connection:setDefault'),
      },
      credentialStore: {
        setSecret: async () => mark('credential:set'),
        deleteSecret: async () => mark('credential:delete'),
      },
      resolveConnectionSecret: async () => mark('credential:resolve'),
      hasConnectionSecret: async () => {
        mark('credential:has');
        return false;
      },
      disconnectManagedOAuthConnection: async () => {
        mark('oauth:disconnect');
      },
      fetchModels: async () => {
        mark('provider:fetchModels');
        return [];
      },
    });
    const cases: Array<{ channel: string; args: unknown[] }> = [
      { channel: 'connections:setDefault', args: ['../escape'] },
      {
        channel: 'connections:setDefaultModel',
        args: [{ slug: '../escape', model: 'test-model' }],
      },
      { channel: 'connections:delete', args: ['../escape'] },
      { channel: 'connections:test', args: ['../escape'] },
      { channel: 'connections:fetchModels', args: ['../escape'] },
      { channel: 'connections:hasSecret', args: ['../escape'] },
    ];

    for (const { channel, args } of cases) {
      const handler = handlers.get(channel);
      assert.ok(handler, `${channel} must be registered`);
      await assert.rejects(handler({}, ...args), /connection slug/);
    }
    assert.deepEqual(sideEffects, []);
  });

  test('update rejects an invalid API key without reading, mutating, or exposing it', async () => {
    const sideEffects: string[] = [];
    const secret = 'private-value\u0000with-control-character';
    const handlers = registerHandlers({
      connectionStore: {
        get: async () => {
          sideEffects.push('read');
          return null;
        },
        update: async () => {
          sideEffects.push('connection');
          return null;
        },
      },
      credentialStore: {
        setSecret: async () => {
          sideEffects.push('credential');
        },
        deleteSecret: async () => {
          sideEffects.push('credential');
        },
      },
    });

    const update = handlers.get('connections:update');
    assert.ok(update);
    await assert.rejects(
      update({}, 'openai-main', { apiKey: secret }),
      (error: unknown) => error instanceof Error && !error.message.includes(secret),
    );
    assert.deepEqual(sideEffects, []);
  });

  test('update rejects non-string and oversized API keys before reading persistence', async () => {
    const sideEffects: string[] = [];
    const handlers = registerHandlers({
      connectionStore: {
        get: async () => {
          sideEffects.push('read');
          return null;
        },
        update: async () => {
          sideEffects.push('connection');
          return null;
        },
      },
      credentialStore: {
        setSecret: async () => {
          sideEffects.push('credential');
        },
        deleteSecret: async () => {
          sideEffects.push('credential');
        },
      },
    });

    const update = handlers.get('connections:update');
    assert.ok(update);
    for (const apiKey of [42, 'x'.repeat(4097)]) {
      await assert.rejects(update({}, 'openai-main', { apiKey }), /apiKey/);
    }
    assert.deepEqual(sideEffects, []);
  });

  test('create forces the canonical OAuth base URL', async () => {
    let persistedInput: CreateConnectionInput | undefined;
    const handlers = registerHandlers({
      connectionStore: {
        create: async (input: CreateConnectionInput) => {
          persistedInput = input;
          return {
            ...input,
            defaultModel: 'gpt-5.4',
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
          };
        },
        remove: async () => {},
      },
    });

    const create = handlers.get('connections:create');
    assert.ok(create);
    await create({}, {
      slug: 'openai-codex',
      name: 'OpenAI OAuth',
      providerType: 'openai-codex',
      baseUrl: 'https://attacker.example',
    });
    assert.equal(persistedInput?.baseUrl, 'https://chatgpt.com/backend-api/codex');
  });

  test('update preserves the canonical OAuth base URL', async () => {
    let persistedPatch: UpdateConnectionInput | undefined;
    const existing: LlmConnection = {
      slug: 'openai-codex',
      name: 'OpenAI OAuth',
      providerType: 'openai-codex',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      defaultModel: 'gpt-5.4',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    const handlers = registerHandlers({
      connectionStore: {
        get: async () => existing,
        update: async (_slug: string, patch: UpdateConnectionInput) => {
          persistedPatch = patch;
          return { ...existing, ...patch };
        },
      },
    });

    const update = handlers.get('connections:update');
    assert.ok(update);
    await update({}, existing.slug, { baseUrl: 'https://attacker.example' });
    assert.equal(persistedPatch?.baseUrl, 'https://chatgpt.com/backend-api/codex');
  });

  test('hasSecret uses the read-only credential probe', async () => {
    const connection = {
      slug: 'openai-codex',
      name: 'OpenAI OAuth',
      providerType: 'openai-codex',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      defaultModel: 'gpt-5.4',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    let probedConnection: unknown;
    const handlers = registerHandlers({
      connectionStore: {
        get: async () => connection,
      },
      resolveConnectionSecret: async () => {
        throw new Error('refreshing resolver must not run');
      },
      hasConnectionSecret: async (candidate: unknown) => {
        probedConnection = candidate;
        return true;
      },
    });

    const hasSecret = handlers.get('connections:hasSecret');
    assert.ok(hasSecret);
    assert.equal(await hasSecret({}, connection.slug), true);
    assert.equal(probedConnection, connection);
  });

  test('fetchModels allows LocalAI without an API key', async () => {
    const connection: LlmConnection = {
      slug: 'localai',
      name: 'LocalAI',
      providerType: 'localai',
      baseUrl: 'http://127.0.0.1:8080/v1',
      defaultModel: 'qwen3-8b',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    let receivedApiKey: string | undefined;
    const handlers = registerHandlers({
      connectionStore: {
        get: async () => connection,
        update: async () => connection,
      },
      resolveConnectionSecret: async () => null,
      fetchModels: async (_candidate: LlmConnection, apiKey: string) => {
        receivedApiKey = apiKey;
        return [{ id: 'qwen3-8b' }];
      },
    });

    const fetchModels = handlers.get('connections:fetchModels');
    assert.ok(fetchModels);
    const result = await fetchModels({}, connection.slug);

    assert.equal(receivedApiKey, '');
    assert.deepEqual((result as { models: unknown }).models, [{ id: 'qwen3-8b' }]);
  });

  test('test allows LocalAI without an API key or Authorization header', async () => {
    let authorization: string | undefined;
    const server = createServer((request, response) => {
      authorization = request.headers.authorization;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    const connection: LlmConnection = {
      slug: 'localai',
      name: 'LocalAI',
      providerType: 'localai',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      defaultModel: 'qwen3-8b',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    const handlers = registerHandlers({
      connectionStore: {
        get: async () => connection,
        update: async () => connection,
      },
      resolveConnectionSecret: async () => null,
    });

    try {
      const testConnection = handlers.get('connections:test');
      assert.ok(testConnection);
      const result = await testConnection({}, connection.slug);

      assert.equal((result as { ok: boolean }).ok, true);
      assert.equal(authorization, undefined);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  test('test records the healthy fallback without changing a customized default model', async () => {
    const updates: UpdateConnectionInput[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify(
            body.model === 'custom-broken-free'
              ? { error: { type: 'server_error' } }
              : { choices: [{ message: { role: 'assistant', content: 'ok' } }] },
          ),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const connection: LlmConnection = {
      slug: 'my-opencode-free',
      name: 'My free connection',
      providerType: 'opencode-free',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      defaultModel: 'custom-broken-free',
      enabledModelIds: ['custom-broken-free'],
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    const handlers = registerHandlers({
      connectionStore: {
        get: async () => connection,
        update: async (_slug: string, patch: UpdateConnectionInput) => {
          updates.push(patch);
          return connection;
        },
      },
    });

    try {
      const testConnection = handlers.get('connections:test');
      assert.ok(testConnection);
      const result = (await testConnection({}, connection.slug)) as {
        ok: boolean;
        modelTested?: string;
      };

      assert.equal(result.ok, true);
      assert.equal(result.modelTested, 'nemotron-3-ultra-free');
      assert.equal(updates.length, 1);
      assert.equal(updates[0]?.lastTestStatus, 'verified');
      assert.equal('defaultModel' in updates[0]!, false);
      assert.equal('enabledModelIds' in updates[0]!, false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
