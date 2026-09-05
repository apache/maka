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

import {
  mergeOpenAiResponsesProviderOptions,
  persistedOpenAiResponsesStepMessages,
  planOpenAiResponsesContinuation,
} from '../openai-responses-continuation.js';
import type { ModelMessage } from '../model-protocol.js';

const user = (text: string): ModelMessage => ({ role: 'user', content: text });
const assistant = (text: string): ModelMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text, providerOptions: { openai: { itemId: `msg-${text}` } } }],
});
const tool = (toolCallId: string, value: string): ModelMessage => ({
  role: 'tool',
  content: [
    {
      type: 'tool-result',
      toolCallId,
      toolName: 'shell',
      output: { type: 'text', value },
    },
  ],
});

describe('OpenAI Responses semantic continuation', () => {
  test('uses Maka persisted reasoning shape as the next continuation baseline', () => {
    const requestMessages = [user('fix it')];
    const reasoningOptions = { openai: { itemId: 'reasoning-1' } };
    const persistedResponse: ModelMessage = {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'inspect first', providerOptions: reasoningOptions },
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'shell',
          input: { command: 'pwd' },
        },
      ],
      // Durable replay hoists the reasoning item metadata to the message.
      providerOptions: reasoningOptions,
    };
    const result = tool('call-1', '/workspace');
    const responseMessages = persistedOpenAiResponsesStepMessages(
      requestMessages,
      [...requestMessages, persistedResponse, result],
      ['call-1'],
    );

    assert.deepEqual(responseMessages, [persistedResponse]);
    assert.deepEqual(
      planOpenAiResponsesContinuation(
        [...requestMessages, persistedResponse, result],
        responseMessages ? { requestMessages, responseMessages, responseId: 'resp-1' } : undefined,
      ),
      { messages: [result], previousResponseId: 'resp-1' },
    );
  });

  test('fails closed when the persisted request prefix or tool-result tail changed', () => {
    const requestMessages = [user('fix it')];
    const response = assistant('calling shell');

    assert.equal(
      persistedOpenAiResponsesStepMessages(
        requestMessages,
        [user('changed'), response, tool('call-1', 'ok')],
        ['call-1'],
      ),
      undefined,
    );
    assert.equal(
      persistedOpenAiResponsesStepMessages(
        requestMessages,
        [...requestMessages, response, tool('other-call', 'ok')],
        ['call-1'],
      ),
      undefined,
    );
  });

  test('sends only messages after the exact prior request and response', () => {
    const priorRequest = [user('fix it')];
    const priorResponse = [assistant('calling shell')];
    const delta = [tool('call-1', 'ok')];

    assert.deepEqual(
      planOpenAiResponsesContinuation([...priorRequest, ...priorResponse, ...delta], {
        requestMessages: priorRequest,
        responseMessages: priorResponse,
        responseId: 'resp-1',
      }),
      { messages: delta, previousResponseId: 'resp-1' },
    );
  });

  test('uses a full request when any prior request message changed', () => {
    const messages = [user('changed'), assistant('calling shell'), tool('call-1', 'ok')];
    assert.deepEqual(
      planOpenAiResponsesContinuation(messages, {
        requestMessages: [user('fix it')],
        responseMessages: [assistant('calling shell')],
        responseId: 'resp-1',
      }),
      { messages },
    );
  });

  test('uses a full request when the replayed response is not exact', () => {
    const messages = [user('fix it'), assistant('different'), tool('call-1', 'ok')];
    assert.deepEqual(
      planOpenAiResponsesContinuation(messages, {
        requestMessages: [user('fix it')],
        responseMessages: [assistant('calling shell')],
        responseId: 'resp-1',
      }),
      { messages },
    );
  });

  test('does not create an empty continuation', () => {
    const messages = [user('fix it'), assistant('done')];
    assert.deepEqual(
      planOpenAiResponsesContinuation(messages, {
        requestMessages: [user('fix it')],
        responseMessages: [assistant('done')],
        responseId: 'resp-1',
      }),
      { messages },
    );
  });

  test('adds a session-stable cache key while preserving explicit OpenAI options', () => {
    assert.deepEqual(
      mergeOpenAiResponsesProviderOptions(
        { openai: { store: false, reasoningEffort: 'high' }, other: { keep: true } },
        'session-1',
      ),
      {
        openai: { store: false, reasoningEffort: 'high', promptCacheKey: 'maka:session-1' },
        other: { keep: true },
      },
    );
  });

  test('never overwrites an explicit cache key or mutates caller options', () => {
    const input = { openai: { store: false, promptCacheKey: 'caller-key' } };
    const merged = mergeOpenAiResponsesProviderOptions(input, 'session-1');
    assert.deepEqual(merged, input);
    assert.notEqual(merged, input);
    assert.notEqual(merged.openai, input.openai);
  });
});
