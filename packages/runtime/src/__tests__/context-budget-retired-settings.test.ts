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
import { describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import { buildDefaultContextBudgetPolicy } from '../context-budget-policy.js';

describe('retired context policy settings', () => {
  test('retired semantic compact environment settings do not change the runtime policy', () => {
    const baseline = buildDefaultContextBudgetPolicy(connection(), { env: {} });
    const configured = buildDefaultContextBudgetPolicy(connection(), {
      env: {
        MAKA_CONTEXT_SEMANTIC_COMPACT: 'on',
        MAKA_CONTEXT_SEMANTIC_COMPACT_MODE: 'replace',
        MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_ACTIVE_ESTIMATED_TOKENS: '4096',
      },
    });
    assert.deepEqual(configured, baseline);
  });
});

function connection(): LlmConnection {
  return {
    slug: 'anthropic-main',
    name: 'Anthropic',
    providerType: 'anthropic',
    defaultModel: 'claude-sonnet-4-5-20250929',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}
