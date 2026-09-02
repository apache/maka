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
import { describe, it } from 'node:test';
import { lookupModelMetadata } from '../model-metadata.js';
import { resolveHostedWebSearchCapability } from '../model-web-search.js';

describe('hosted web search capability', () => {
  it('enables the implemented Responses path only for declared model families', () => {
    assert.deepEqual(resolveHostedWebSearchCapability('deepseek', undefined, 'deepseek-v4-flash'), {
      adapter: 'openai-responses',
      implemented: false,
    });
    assert.deepEqual(resolveHostedWebSearchCapability('deepseek', undefined, 'deepseek-v4-pro'), {
      adapter: 'openai-responses',
      implemented: false,
    });
    assert.equal(resolveHostedWebSearchCapability('deepseek', undefined, 'deepseek-chat'), null);
    assert.deepEqual(resolveHostedWebSearchCapability('openai', undefined, 'gpt-5.5'), {
      adapter: 'openai-responses',
      implemented: true,
    });
    assert.deepEqual(resolveHostedWebSearchCapability('xai', undefined, 'grok-4.5'), {
      adapter: 'openai-responses',
      implemented: true,
    });
    assert.deepEqual(resolveHostedWebSearchCapability('alibaba', undefined, 'qwen3.5-plus'), {
      adapter: 'openai-responses',
      implemented: false,
    });
    assert.deepEqual(resolveHostedWebSearchCapability('alibaba-cn', undefined, 'qwen3.5-plus'), {
      adapter: 'openai-responses',
      implemented: false,
    });
    for (const providerType of ['alibaba-token-plan-cn', 'alibaba-token-plan'] as const) {
      assert.deepEqual(resolveHostedWebSearchCapability(providerType, undefined, 'qwen3.8-max'), {
        adapter: 'openai-responses',
        implemented: true,
      });
      assert.equal(resolveHostedWebSearchCapability(providerType, undefined, 'qwen3.7-max'), null);
      assert.equal(resolveHostedWebSearchCapability(providerType, undefined, 'qwen3.7-plus'), null);
      assert.equal(
        resolveHostedWebSearchCapability(providerType, undefined, 'qwen3.8-max-preview'),
        null,
      );
      assert.equal(resolveHostedWebSearchCapability(providerType, undefined, 'qwen3.6-plus'), null);
    }
    assert.equal(resolveHostedWebSearchCapability('openai', undefined, 'gpt-4.1'), null);
  });

  it('reports provider support separately from Maka adapter readiness', () => {
    assert.deepEqual(
      resolveHostedWebSearchCapability('anthropic', undefined, 'claude-sonnet-4-6'),
      { adapter: 'anthropic-messages', implemented: true },
    );
    assert.deepEqual(resolveHostedWebSearchCapability('google', undefined, 'gemini-2.5-flash'), {
      adapter: 'google-grounding',
      implemented: false,
    });
    assert.deepEqual(resolveHostedWebSearchCapability('zai', undefined, 'glm-5'), {
      adapter: 'zai-web-search',
      implemented: false,
    });
    assert.equal(resolveHostedWebSearchCapability('moonshot', undefined, 'kimi-k2.6'), null);
  });

  it('lets explicit connection model metadata deny or grant provider-hosted search', () => {
    assert.equal(
      resolveHostedWebSearchCapability(
        'deepseek',
        [{ id: 'deepseek-v4-flash', capabilities: { webSearch: false } }],
        'deepseek-v4-flash',
      ),
      null,
    );
    assert.deepEqual(
      resolveHostedWebSearchCapability(
        'openai',
        [
          {
            id: 'custom-responses-model',
            apiProtocol: 'openai-responses',
            capabilities: { webSearch: true },
          },
        ],
        'custom-responses-model',
      ),
      { adapter: 'openai-responses', implemented: true },
    );
    assert.equal(
      resolveHostedWebSearchCapability(
        'openai',
        [
          {
            id: 'custom-chat-model',
            apiProtocol: 'openai-chat',
            capabilities: { webSearch: true },
          },
        ],
        'custom-chat-model',
      ),
      null,
    );
    assert.deepEqual(
      resolveHostedWebSearchCapability(
        'openai-responses-compatible',
        [
          {
            id: 'relay-model',
            apiProtocol: 'openai-responses',
            capabilities: { webSearch: true },
          },
        ],
        'relay-model',
      ),
      { adapter: 'openai-responses', implemented: true },
    );
  });

  it('keeps dual-wire providers on the configured connection protocol', () => {
    assert.deepEqual(resolveHostedWebSearchCapability('deepseek', undefined, 'deepseek-v4-flash'), {
      adapter: 'openai-responses',
      implemented: false,
    });
    assert.deepEqual(
      resolveHostedWebSearchCapability(
        'anthropic-compatible',
        [
          {
            id: 'deepseek-v4-flash',
            apiProtocol: 'anthropic-messages',
          },
        ],
        'deepseek-v4-flash',
      ),
      { adapter: 'anthropic-messages', implemented: true },
    );
    assert.equal(
      resolveHostedWebSearchCapability(
        'deepseek',
        [{ id: 'deepseek-v4-flash', apiProtocol: 'openai-chat' }],
        'deepseek-v4-flash',
      ),
      null,
    );
    assert.equal(
      resolveHostedWebSearchCapability(
        'openai',
        [{ id: 'gpt-5.5', apiProtocol: 'openai-chat' }],
        'gpt-5.5',
      ),
      null,
    );
    assert.equal(
      resolveHostedWebSearchCapability(
        'alibaba-token-plan-cn',
        [{ id: 'qwen3.8-max', apiProtocol: 'openai-chat' }],
        'qwen3.8-max',
      ),
      null,
    );
  });

  it('publishes native search for both first-party DeepSeek V4 models', () => {
    assert.equal(
      lookupModelMetadata('deepseek', 'deepseek-v4-flash').capabilities?.webSearch,
      true,
    );
    assert.equal(lookupModelMetadata('deepseek', 'deepseek-v4-pro').capabilities?.webSearch, true);
    assert.equal(lookupModelMetadata('deepseek', 'deepseek-v4-pro').lastUpdated, '2026-08-13');
  });
});
