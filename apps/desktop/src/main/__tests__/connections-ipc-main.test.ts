import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { registerConnectionsIpc } from '../connections-ipc-main.js';

type Handler = (...args: any[]) => Promise<any>;

function registerHandlers(
  overrides: Record<string, unknown> = {},
): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const deps = {
    connectionStore: {
      create: async (input: any) => ({
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

  registerConnectionsIpc(deps, {
    handle(channel, handler) {
      handlers.set(channel, handler as Handler);
    },
  });
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
    await assert.rejects(
      create({}, {
        slug: '../escape',
        name: 'Invalid',
        providerType: 'openai',
        apiKey: 'safe-test-value',
      }),
      /connection slug/,
    );
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

  test('create forces the canonical OAuth base URL', async () => {
    let persistedInput: any;
    const handlers = registerHandlers({
      connectionStore: {
        create: async (input: any) => {
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
    assert.equal(persistedInput.baseUrl, 'https://chatgpt.com/backend-api/codex');
  });

  test('update preserves the canonical OAuth base URL', async () => {
    let persistedPatch: any;
    const existing = {
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
        update: async (_slug: string, patch: any) => {
          persistedPatch = patch;
          return { ...existing, ...patch };
        },
      },
    });

    const update = handlers.get('connections:update');
    assert.ok(update);
    await update({}, existing.slug, { baseUrl: 'https://attacker.example' });
    assert.equal(persistedPatch.baseUrl, 'https://chatgpt.com/backend-api/codex');
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
});
