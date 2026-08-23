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
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { LlmConnection } from '@maka/core/llm-connections';
import { buildSessionRecapMessages } from '../session-recap.js';

test('session recap bounds its request to the newest complete turns', () => {
  const events: RuntimeEvent[] = [];
  for (let index = 0; index < 20; index += 1) {
    const turnId = `turn-${index}`;
    events.push(textEvent(`user-${index}`, turnId, 'user', `user-${index} ${'u'.repeat(2_000)}`));
    events.push(
      textEvent(`model-${index}`, turnId, 'model', `model-${index} ${'m'.repeat(2_000)}`),
    );
  }

  const messages = buildSessionRecapMessages({
    events,
    connection: connection(),
    modelId: 'gpt-4',
  });
  const serialized = JSON.stringify(messages);

  assert.equal(serialized.includes('user-0 '), false);
  assert.equal(serialized.includes('model-19 '), true);
  assert.ok(messages.length < events.length + 1);
});

function textEvent(id: string, turnId: string, role: 'user' | 'model', text: string): RuntimeEvent {
  return {
    id,
    sessionId: 'session-1',
    runId: `run-${turnId}`,
    turnId,
    invocationId: `invocation-${turnId}`,
    ts: Number(turnId.slice('turn-'.length)),
    partial: false,
    role,
    author: role === 'user' ? 'user' : 'agent',
    content: { kind: 'text', text },
  };
}

function connection(): LlmConnection {
  return {
    slug: 'openai-main',
    name: 'OpenAI',
    providerType: 'openai',
    defaultModel: 'gpt-4',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}
