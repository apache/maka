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
import type { LlmConnection } from '@maka/core/llm-connections';
import { connectionChipStatus } from '../../renderer/settings/provider-connection-status.js';

function connection(overrides: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: 'openai-live',
    name: 'OpenAI Live',
    providerType: 'openai',
    defaultModel: 'gpt-4.1',
    enabled: true,
    models: [{ id: 'gpt-4.1' }],
    modelSource: 'fetched',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const retired = connection({
  slug: 'claude-subscription',
  name: 'Claude Subscription',
  providerType: 'claude-subscription',
  defaultModel: 'claude-opus-5',
  models: [{ id: 'claude-opus-5' }],
});

test('a retired connection reads as broken rather than repairable', () => {
  // Nothing else in the list marks this row, so without a status the only
  // signal that it has to go is on the detail page the user has no reason to
  // open.
  assert.deepEqual(connectionChipStatus(retired, 'zh'), {
    label: '已停用 · 请删除',
    tone: 'error',
  });
  assert.deepEqual(connectionChipStatus(retired, 'en'), {
    label: 'Retired · delete it',
    tone: 'error',
  });
});

test('retirement outranks every repairable state', () => {
  // Each of these would otherwise render a "sign in again" or "it failed, try
  // again" status, and for a retired provider both point at nothing.
  for (const overrides of [
    { lastTestStatus: 'needs_reauth' as const },
    { lastTestStatus: 'error' as const },
    { lastTestStatus: 'verified' as const },
    { enabled: false },
  ]) {
    assert.deepEqual(
      connectionChipStatus({ ...retired, ...overrides }, 'zh'),
      { label: '已停用 · 请删除', tone: 'error' },
      `retirement must win over ${JSON.stringify(overrides)}`,
    );
  }
});

test('a live connection keeps its existing statuses', () => {
  assert.equal(connectionChipStatus(connection({ lastTestStatus: 'verified' }), 'zh'), null);
  assert.deepEqual(connectionChipStatus(connection({ lastTestStatus: 'needs_reauth' }), 'zh'), {
    label: '需要重新登录',
    tone: 'attention',
  });
  assert.deepEqual(connectionChipStatus(connection({ enabled: false }), 'zh'), {
    label: '暂不可用',
    tone: 'neutral',
  });
});
