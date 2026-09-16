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
import { MODELS_DEV_PROVIDERS } from '../models-dev-projection.js';
import { MODELS_DEV_RESPONSE_MAX_BYTES, fetchModelsDevProjection } from '../models-dev-refresh.js';

test('a refresh reports every committed path upstream stopped carrying', async () => {
  const removals: string[][] = [];
  const metadata = await fetchModelsDevProjection({
    fetch: respondWith(JSON.stringify(catalog())),
    previous: {
      anthropic: {
        'claude-gone': { displayName: 'Gone', contextWindow: 1_000 },
        'claude-kept': { displayName: 'Kept', contextWindow: 2_000 },
      },
    },
    onRemovals: (paths) => removals.push([...paths]),
  });

  assert.equal(metadata.anthropic?.['claude-kept']?.displayName, 'Kept Model');
  assert.deepEqual(removals, [['/metadata/anthropic/claude-gone']]);
});

test('a refresh that removes nothing does not call back', async () => {
  let called = false;
  await fetchModelsDevProjection({
    fetch: respondWith(JSON.stringify(catalog())),
    previous: { anthropic: { 'claude-kept': { displayName: 'Kept', contextWindow: 2_000 } } },
    onRemovals: () => {
      called = true;
    },
  });

  assert.equal(called, false);
});

test('a declared oversized body is refused instead of drained', async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
    {
      headers: {
        'content-type': 'application/json',
        'content-length': String(MODELS_DEV_RESPONSE_MAX_BYTES + 1),
      },
    },
  );

  await assert.rejects(
    fetchModelsDevProjection({ fetch: async () => response }),
    /exceeded the accepted size/u,
  );
  assert.equal(cancelled, true, 'the declared length alone ends it — the body is never read');
});

test('a non-ok response never reaches the projection', async () => {
  await assert.rejects(
    fetchModelsDevProjection({
      fetch: async () => new Response('nope', { status: 503 }),
    }),
    /models\.dev responded 503/u,
  );
});

/** Every provider the projection demands; only anthropic's model is asserted on. */
function catalog(): Record<string, unknown> {
  const providers: Record<string, unknown> = {};
  for (const sourceId of new Set(Object.values(MODELS_DEV_PROVIDERS))) {
    providers[sourceId] = {
      id: sourceId,
      name: sourceId,
      doc: `https://models.dev/${sourceId}`,
      models: {
        'claude-kept': {
          name: 'Kept Model',
          reasoning: false,
          tool_call: true,
          limit: { context: 2_000, output: 100 },
          modalities: { input: ['text'], output: ['text'] },
        },
      },
    };
  }
  return providers;
}

function respondWith(body: string): typeof globalThis.fetch {
  return (async () =>
    new Response(body, {
      headers: { 'content-type': 'application/json' },
    })) as typeof globalThis.fetch;
}
