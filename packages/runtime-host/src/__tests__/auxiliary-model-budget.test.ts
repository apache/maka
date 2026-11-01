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

import test from 'node:test';
import assert from 'node:assert/strict';
import { auxiliaryModelBudget } from '../server/execution-model-authority.js';
import type { RuntimeExecutionConnection } from '@maka/core/llm-connections';

const connection = (limits: object): RuntimeExecutionConnection => ({
  slug: 'fixture',
  providerType: 'custom',
  defaultModel: 'fixture',
  models: [{ id: 'fixture', ...limits }],
});

test('capacity reserves output and respects explicit input limit and model overrides', () => {
  assert.equal(
    auxiliaryModelBudget(connection({ contextWindow: 32000 }), 'fixture', 2000).maxInputTokens,
    27000,
  );
  assert.equal(
    auxiliaryModelBudget(connection({ contextWindow: 32000, inputLimit: 10000 }), 'fixture', 2000)
      .maxInputTokens,
    9000,
  );
  const c = connection({ contextWindow: 32000 });
  c.modelOverrides = { fixture: { contextWindow: 8000, maxOutputTokens: 1000 } };
  const budget = auxiliaryModelBudget(c, 'fixture', 2000);
  assert.equal(budget.maxInputTokens, 6300);
  assert.equal(budget.maxOutputTokens, 1000);
  c.models![0].maxOutputTokens = 500;
  assert.equal(auxiliaryModelBudget(c, 'fixture', 2000).maxOutputTokens, 1000);
  assert.equal(
    auxiliaryModelBudget(connection({ inputLimit: 6000 }), 'fixture', 2000).maxInputTokens,
    5400,
  );
});

test('unknown, conflicting and exhausted model capacities are configuration errors', () => {
  assert.throws(() => auxiliaryModelBudget(connection({}), 'fixture'), /unknown/);
  assert.throws(
    () => auxiliaryModelBudget(connection({ contextWindow: 1000, inputLimit: 2000 }), 'fixture'),
    /exceeds/,
  );
  assert.throws(
    () => auxiliaryModelBudget(connection({ contextWindow: 1000 }), 'fixture', 2000),
    /no usable/,
  );
});
