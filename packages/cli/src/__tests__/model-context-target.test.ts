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
import {
  normalizeUpdateCatalogConnectionInput,
  type UpdateCatalogConnectionInput,
} from '@maka/core/runtime-policy';
import type { RelayModelProfiles } from '@maka/core/model-thinking';
import type { RuntimeHostConnection } from '@maka/runtime-host/client';
import {
  parseContextTarget,
  updateRuntimeHostModelContextTarget,
} from '../model-context-target.js';

function fixture(resultKind = 'committed') {
  let profiles: RelayModelProfiles | undefined = {
    model: { vision: false, thinkingLevels: ['high'] },
    other: { contextWindow: 128_000 },
  };
  const writes: UpdateCatalogConnectionInput[] = [];
  const connection = {
    request: async (operation: string, input: unknown) => {
      if (operation === 'connection.catalog.query') {
        return {
          kind: 'page',
          revision: 1,
          defaultTarget: null,
          connectionCount: 1,
          nextCursor: null,
          items: [
            {
              kind: 'connection',
              connectionIndex: 0,
              connectionId: '11111111-1111-4111-8111-111111111111',
              revision: 7,
              slug: 'account',
              name: 'Account',
              providerType: 'openai-compatible',
              baseUrl: 'https://relay.example/v1',
              enabled: true,
              enabledModelIdCount: 2,
              modelCount: 0,
              catalogEntryCount: 1,
            },
            ...['model', 'other'].map((modelId, itemIndex) => ({
              kind: 'enabled_model_id',
              connectionIndex: 0,
              itemIndex,
              modelId,
              relayProfile: profiles?.[modelId],
            })),
            {
              kind: 'catalog_entry',
              connectionIndex: 0,
              itemIndex: 0,
              entry: { id: 'model', canUseAsChatDefault: true, contextWindow: 1_000_000 },
            },
          ],
        };
      }
      assert.equal(operation, 'connection.catalog.update');
      const update = normalizeUpdateCatalogConnectionInput(input);
      writes.push(update);
      if (resultKind === 'committed') profiles = update.changes.relayModelProfiles ?? undefined;
      return { kind: resultKind };
    },
  } as unknown as RuntimeHostConnection;
  return { connection, writes };
}
const identity = {
  connectionId: '11111111-1111-4111-8111-111111111111',
  connectionSlug: 'account',
  model: 'model',
};

test('parses decimal K/M and Auto without accepting invalid token counts', () => {
  for (const [value, expected] of [
    ['256k', 256_000],
    ['512K', 512_000],
    ['1M', 1_000_000],
    ['0.5m', 500_000],
    ['384000', 384_000],
    ['auto', undefined],
    ['AUTO', undefined],
  ] as const)
    assert.equal(parseContextTarget(value), expected);
  for (const value of ['0', '-1', '1.1', 'NaN', 'Infinity', '1kb', '', '999999999999999999']) {
    assert.throws(() => parseContextTarget(value), /Usage/);
  }
});

test('updates the exact Host connection and preserves endpoint, model list and declarations', async () => {
  const { connection, writes } = fixture();
  await updateRuntimeHostModelContextTarget(connection, { ...identity, target: 256_000 });
  assert.deepEqual(writes[0], {
    expected: { connectionId: identity.connectionId, revision: 7 },
    changes: {
      name: 'Account',
      enabled: true,
      enabledModelIds: ['model', 'other'],
      baseUrl: 'https://relay.example/v1',
      relayModelProfiles: {
        model: { vision: false, thinkingLevels: ['high'], contextWindow: 256_000 },
        other: { contextWindow: 128_000 },
      },
    },
  });
  await updateRuntimeHostModelContextTarget(connection, { ...identity, target: undefined });
  assert.deepEqual(writes[1]?.changes.relayModelProfiles, {
    model: { vision: false, thinkingLevels: ['high'] },
    other: { contextWindow: 128_000 },
  });
});

test('rejects a target beyond the known maximum or a stale connection identity without writing', async () => {
  const { connection, writes } = fixture();
  await assert.rejects(
    updateRuntimeHostModelContextTarget(connection, { ...identity, target: 2_000_000 }),
    /exceeds the model maximum/,
  );
  await assert.rejects(
    updateRuntimeHostModelContextTarget(connection, {
      ...identity,
      connectionId: 'old-id',
      target: 256_000,
    }),
    /unavailable/,
  );
  assert.deepEqual(writes, []);
});

test('surfaces Host conflicts instead of treating an uncommitted change as saved', async () => {
  const { connection } = fixture('conflict');
  await assert.rejects(
    updateRuntimeHostModelContextTarget(connection, { ...identity, target: 512_000 }),
    /not saved: conflict/,
  );
});
