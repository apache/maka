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
import { runConnectionModelDiscoveryEffect } from '../model-fetcher.js';
import { runConnectionTestEffect } from '../test-connection.js';

for (const [apiProtocol, path] of [
  ['openai-chat', '/chat/completions'],
  ['openai-responses', '/responses'],
] as const) {
  test(`${apiProtocol}: full endpoint works for testing, generation and discovery`, async () => {
    for (const prefix of ['', '/v1', '/gateway/team/api']) {
      for (const suffix of ['', '/chat/completions', '/responses', `${path}/`, `${path}${path}`]) {
        const base = `https://relay.example${prefix}`;
        const connection: LlmConnection = {
          slug: 'relay',
          name: 'Relay',
          providerType: 'custom',
          defaultApiProtocol: apiProtocol,
          enabled: true,
          baseUrl: `${base}${suffix}`,
          defaultModel: 'relay-model',
          enabledModelIds: ['relay-model'],
          createdAt: 0,
          updatedAt: 0,
        };
        const urls: string[] = [];
        const fetch: typeof globalThis.fetch = async (input) => {
          const url = input instanceof Request ? input.url : String(input);
          urls.push(url);
          return Response.json(
            url.endsWith('/models')
              ? { data: [{ id: 'relay-model' }] }
              : apiProtocol === 'openai-chat'
                ? {
                    id: 'chat',
                    object: 'chat.completion',
                    created: 0,
                    model: 'relay-model',
                    choices: [
                      {
                        index: 0,
                        message: { role: 'assistant', content: 'Hi' },
                        finish_reason: 'stop',
                      },
                    ],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                  }
                : {
                    id: 'response',
                    object: 'response',
                    status: 'completed',
                    output: [],
                    usage: { input_tokens: 1, output_tokens: 1 },
                  },
          );
        };
        const tested = await runConnectionTestEffect(connection, 'test-key', { fetch });
        assert.equal(tested.ok, true);
        const model = getAIModel({ connection, apiKey: 'test-key', modelId: 'relay-model', fetch });
        await model.doGenerate({
          prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
        });
        const discovered = await runConnectionModelDiscoveryEffect(connection, 'test-key', {
          fetch,
        });
        assert.equal(discovered.ok, true);
        assert.deepEqual(
          urls,
          [`${base}${path}`, `${base}${path}`, `${base}/models`],
          `${base}${suffix}`,
        );
      }
    }
  });
}
