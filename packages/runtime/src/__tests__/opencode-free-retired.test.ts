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
import { getAIModel } from '../model-factory.js';
import { testConnection } from '../test-connection.js';

test('a stored OpenCode Free connection cannot probe or create a model', async () => {
  const connection: LlmConnection = {
    slug: 'opencode-free',
    name: 'OpenCode Free',
    providerType: 'opencode-free',
    defaultModel: 'nemotron-3-ultra-free',
    enabledModelIds: ['nemotron-3-ultra-free'],
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
  const fetchFn = async () => {
    throw new Error('Retired provider must not make requests');
  };
  const result = await testConnection(connection, '', undefined, { fetch: fetchFn });
  assert.equal(result.ok, false);
  assert.match(result.errorMessage ?? '', /no longer supported|retired|not available/i);
  assert.throws(
    () => getAIModel({ connection, apiKey: '', modelId: 'nemotron-3-ultra-free', fetch: fetchFn }),
    /retired and can no longer resolve/,
  );
});
