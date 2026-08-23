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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { deriveModelSwitchTranscript, type StoredMessage } from '../session.js';

describe('deriveModelSwitchTranscript', () => {
  it('treats any durable transcript as an existing conversation', () => {
    const messages: StoredMessage[] = [
      {
        type: 'user',
        id: 'user-1',
        turnId: 'turn-1',
        ts: 1,
        text: 'hello',
      },
    ];

    assert.deepEqual(deriveModelSwitchTranscript(messages), {
      hasConversation: true,
    });
  });

  it('uses the latest assistant model as the actual baseline', () => {
    const messages: StoredMessage[] = [
      {
        type: 'assistant',
        id: 'assistant-1',
        turnId: 'turn-1',
        ts: 1,
        text: 'first',
        modelId: 'model-a',
      },
      {
        type: 'assistant',
        id: 'assistant-2',
        turnId: 'turn-2',
        ts: 2,
        text: 'second',
        modelId: 'model-b',
      },
    ];

    assert.deepEqual(deriveModelSwitchTranscript(messages), {
      hasConversation: true,
      lastUsedModel: 'model-b',
    });
  });
});
