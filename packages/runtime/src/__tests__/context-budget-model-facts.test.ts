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
import test from 'node:test';
import {
  buildDefaultContextBudgetPolicy,
  resolveDeclaredContextWindow,
  resolveSelectedModelContextWindow,
} from '../context-budget-policy.js';

test('context budgeting prefers a model input limit over its context window', () => {
  const connection = {
    slug: 'openai',
    providerType: 'openai' as const,
    defaultModel: 'model-with-narrow-input',
    models: [{ id: 'model-with-narrow-input', contextWindow: 1_000, inputLimit: 600 }],
  };

  assert.equal(resolveSelectedModelContextWindow(connection, undefined), 600);
  assert.equal(resolveDeclaredContextWindow(connection, undefined), undefined);
  assert.deepEqual(buildDefaultContextBudgetPolicy().historyCompact?.midTurn, { enabled: true });
});

test('invalid zero input limits do not disable the context-window fallback', () => {
  const connection = {
    slug: 'openai',
    providerType: 'openai' as const,
    defaultModel: 'model-with-invalid-input',
    models: [{ id: 'model-with-invalid-input', contextWindow: 1_000, inputLimit: 0 }],
  };

  assert.equal(resolveSelectedModelContextWindow(connection, undefined), 1_000);
});

test('a relay user declaration remains ahead of runtime and static model facts', () => {
  const connection = {
    slug: 'relay',
    providerType: 'openai-compatible' as const,
    defaultModel: 'relay-model',
    models: [{ id: 'relay-model', contextWindow: 64_000, inputLimit: 128_000 }],
    relayModelProfiles: { 'relay-model': { contextWindow: 32_000 } },
  };

  assert.equal(resolveSelectedModelContextWindow(connection, undefined), 32_000);
});

test('a model-facts context window is the authoritative user declaration', () => {
  const connection = {
    slug: 'relay',
    providerType: 'openai-compatible' as const,
    defaultModel: 'relay-model',
    models: [
      {
        id: 'relay-model',
        contextWindow: 200_000,
        inputLimit: 200_000,
        factOverriddenFields: ['contextWindow', 'inputLimit'] as const,
      },
    ],
    relayModelProfiles: { 'relay-model': { contextWindow: 8_192 } },
  };

  assert.equal(resolveSelectedModelContextWindow(connection, undefined), 200_000);
  assert.equal(resolveDeclaredContextWindow(connection, undefined), 200_000);
});

test('a reported model context window is metadata, not a Maka declaration', () => {
  const connection = {
    slug: 'openai',
    providerType: 'openai' as const,
    defaultModel: 'reported-model',
    models: [{ id: 'reported-model', contextWindow: 100_000 }],
  };

  assert.equal(resolveSelectedModelContextWindow(connection, undefined), 100_000);
  assert.equal(resolveDeclaredContextWindow(connection, undefined), undefined);
});
