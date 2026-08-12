import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeHostConnection } from '../client/connection.js';
import { configureHostedExecutionTarget } from '../client/hosted-execution-target.js';

test('explicit hosted target preserves the default target and proves the requested model', async () => {
  const requests: Array<{ operation: string; input: unknown }> = [];
  let queryCount = 0;
  const connection = {
    request: async (operation: string, input: unknown) => {
      requests.push({ operation, input });
      if (operation === 'connection.catalog.query') {
        queryCount += 1;
        return queryCount === 1
          ? catalogPage(['gpt-4o-mini'], ['gpt-4o-mini'])
          : catalogPage(
              ['gpt-4o-mini', 'deepseek-v4-flash'],
              ['gpt-4o-mini', 'deepseek-v4-flash'],
              'https://api.deepseek.com/',
            );
      }
      if (operation === 'connection.catalog.update') {
        return {
          kind: 'committed',
          catalogRevision: 2,
          connection: { connectionId: CONNECTION_ID, revision: 2 },
        };
      }
      if (operation === 'connection.models.fetch') {
        return {
          kind: 'committed',
          catalogRevision: 3,
          connection: { connectionId: CONNECTION_ID, revision: 3 },
          modelCount: 2,
          source: 'fetched',
          fetchedAt: 1,
        };
      }
      throw new Error(`Unexpected operation ${operation}`);
    },
  } as unknown as Pick<RuntimeHostConnection, 'request'>;

  assert.equal(
    await configureHostedExecutionTarget(connection, {
      connectionSlug: 'env-openai',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com',
    }),
    true,
  );

  assert.deepEqual(
    requests.map(({ operation }) => operation),
    [
      'connection.catalog.query',
      'connection.catalog.update',
      'connection.models.fetch',
      'connection.catalog.query',
    ],
  );
  assert.deepEqual(requests[1]?.input, {
    expected: { connectionId: CONNECTION_ID, revision: 1 },
    changes: {
      name: 'OpenAI',
      baseUrl: 'https://api.deepseek.com/',
      enabled: true,
      enabledModelIds: ['gpt-4o-mini', 'deepseek-v4-flash'],
    },
  });
});

test('explicit hosted target stops waiting when cancelled', { timeout: 1_000 }, async () => {
  const abort = new AbortController();
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const connection = {
    request: async () => {
      started();
      return await new Promise<never>(() => {});
    },
  } as unknown as Pick<RuntimeHostConnection, 'request'>;
  const configuring = configureHostedExecutionTarget(
    connection,
    {
      connectionSlug: 'env-openai',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com',
    },
    abort.signal,
  );
  await requestStarted;
  abort.abort(new Error('cancelled'));

  await assert.rejects(configuring, /cancelled/u);
});

test('explicit hosted target reports an already admitted target as unchanged', async () => {
  const connection = {
    request: async (operation: string) => {
      assert.equal(operation, 'connection.catalog.query');
      return catalogPage(['deepseek-v4-flash'], ['deepseek-v4-flash'], null, 'deepseek');
    },
  } as unknown as Pick<RuntimeHostConnection, 'request'>;

  assert.equal(
    await configureHostedExecutionTarget(connection, {
      connectionSlug: 'env-openai',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com',
    }),
    false,
  );
});

test('explicit hosted target replaces a missing effective endpoint', async () => {
  const operations: string[] = [];
  let queryCount = 0;
  const connection = {
    request: async (operation: string) => {
      operations.push(operation);
      if (operation === 'connection.catalog.query') {
        queryCount += 1;
        return queryCount === 1
          ? catalogPage(['deepseek-v4-flash'], [], null, 'openai-compatible')
          : catalogPage(
              ['deepseek-v4-flash'],
              ['deepseek-v4-flash'],
              'https://api.deepseek.com/',
              'openai-compatible',
            );
      }
      if (operation === 'connection.catalog.update') {
        return {
          kind: 'committed',
          catalogRevision: 2,
          connection: { connectionId: CONNECTION_ID, revision: 2 },
        };
      }
      if (operation === 'connection.models.fetch') {
        return {
          kind: 'committed',
          catalogRevision: 3,
          connection: { connectionId: CONNECTION_ID, revision: 3 },
          modelCount: 1,
          source: 'fetched',
          fetchedAt: 1,
        };
      }
      throw new Error(`Unexpected operation ${operation}`);
    },
  } as unknown as Pick<RuntimeHostConnection, 'request'>;

  assert.equal(
    await configureHostedExecutionTarget(connection, {
      connectionSlug: 'env-openai',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com',
    }),
    true,
  );
  assert.deepEqual(operations, [
    'connection.catalog.query',
    'connection.catalog.update',
    'connection.models.fetch',
    'connection.catalog.query',
  ]);
});

const CONNECTION_ID = '00000000-0000-4000-8000-000000000001';

function catalogPage(
  enabledModelIds: string[],
  models: string[],
  baseUrl: string | null = 'https://api.openai.com/v1/',
  providerType: 'openai' | 'deepseek' | 'openai-compatible' = 'openai',
) {
  return {
    kind: 'page' as const,
    revision: 1,
    defaultTarget: { connectionId: CONNECTION_ID, modelId: 'gpt-4o-mini' },
    connectionCount: 1,
    items: [
      {
        kind: 'connection' as const,
        connectionIndex: 0,
        connectionId: CONNECTION_ID,
        revision: 1,
        slug: 'env-openai',
        name: 'OpenAI',
        providerType,
        ...(baseUrl === null ? {} : { baseUrl }),
        enabled: true,
        enabledModelIdCount: enabledModelIds.length,
        modelCount: models.length,
      },
      ...enabledModelIds.map((modelId, itemIndex) => ({
        kind: 'enabled_model_id' as const,
        connectionIndex: 0,
        itemIndex,
        modelId,
      })),
      ...models.map((id, itemIndex) => ({
        kind: 'model' as const,
        connectionIndex: 0,
        itemIndex,
        model: { id },
      })),
    ],
    nextCursor: null,
  };
}
