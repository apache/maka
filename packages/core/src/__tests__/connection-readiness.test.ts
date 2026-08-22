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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isConnectionReady } from '../connection-readiness.js';
import type { LlmConnection } from '../llm-connections.js';

function connection(overrides: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: 'openai-live',
    name: 'OpenAI Live',
    providerType: 'openai',
    defaultModel: 'gpt-4.1',
    enabled: true,
    models: [{ id: 'gpt-4.1', capabilities: { chat: true, functionCalling: true } }],
    modelSource: 'fetched',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('isConnectionReady — model capability gate', () => {
  it('rejects an explicitly image-only default model', () => {
    const verdict = isConnectionReady({
      connection: connection({
        defaultModel: 'gpt-image-1',
        models: [{ id: 'gpt-image-1', capabilities: { imageGeneration: true, chat: false } }],
      }),
      hasSecret: true,
    });

    assert.deepEqual(verdict, { ready: false, reason: 'model_not_chat_capable' });
  });

  it('rejects an explicitly image-only requested model even when the default is chat-capable', () => {
    const verdict = isConnectionReady({
      connection: connection({
        defaultModel: 'gpt-4.1',
        enabledModelIds: ['gpt-4.1', 'gpt-image-1'],
        models: [
          { id: 'gpt-4.1', capabilities: { chat: true, functionCalling: true } },
          { id: 'gpt-image-1', capabilities: { imageGeneration: true, chat: false } },
        ],
      }),
      hasSecret: true,
      requestedModel: 'gpt-image-1',
    });

    assert.deepEqual(verdict, { ready: false, reason: 'model_not_chat_capable' });
  });

  it('rejects a discovered model after the user disables it', () => {
    const verdict = isConnectionReady({
      connection: connection({
        defaultModel: 'gpt-4.1',
        enabledModelIds: ['gpt-4.1'],
        models: [
          { id: 'gpt-4.1', capabilities: { chat: true } },
          { id: 'gpt-4.1-mini', capabilities: { chat: true } },
        ],
      }),
      hasSecret: true,
      requestedModel: 'gpt-4.1-mini',
    });

    assert.deepEqual(verdict, { ready: false, reason: 'model_not_enabled' });
  });

  it('keeps explicit chat models send-ready even when they also support image generation', () => {
    const verdict = isConnectionReady({
      connection: connection({
        defaultModel: 'multimodal-chat',
        models: [{ id: 'multimodal-chat', capabilities: { chat: true, imageGeneration: true } }],
      }),
      hasSecret: true,
    });

    assert.deepEqual(verdict, { ready: true, model: 'multimodal-chat' });
  });

  it('does not block models with unknown capability metadata', () => {
    const verdict = isConnectionReady({
      connection: connection({
        defaultModel: 'custom-chat',
        models: [{ id: 'custom-chat' }],
      }),
      hasSecret: true,
    });

    assert.deepEqual(verdict, { ready: true, model: 'custom-chat' });
  });

  it('keeps optional-key LocalAI ready when no credential is stored', () => {
    const verdict = isConnectionReady({
      connection: connection({
        slug: 'localai',
        name: 'LocalAI',
        providerType: 'localai',
        defaultModel: 'qwen3-8b',
        models: [{ id: 'qwen3-8b' }],
      }),
      hasSecret: false,
    });

    assert.deepEqual(verdict, { ready: true, model: 'qwen3-8b' });
  });

  it('keeps Vercel Gateway gated on its key', () => {
    const vercel = connection({
      slug: 'vercel',
      name: 'Vercel AI Gateway',
      providerType: 'vercel',
      defaultModel: 'xai/grok-4.3',
      models: [{ id: 'xai/grok-4.3', capabilities: { chat: true, functionCalling: true } }],
    });

    assert.deepEqual(isConnectionReady({ connection: vercel, hasSecret: false }), {
      ready: false,
      reason: 'missing_api_key',
    });
  });

  it('does not let a live list veto a model the user enabled', () => {
    // A live list is the best observation Maka has and still only an
    // observation: it ages, it can arrive filtered, and it answers for the
    // moment it was fetched. The request goes out and the provider answers for
    // its own account — an error from there beats one Maka invents (#1584).
    const verdict = isConnectionReady({
      connection: connection({
        defaultModel: 'custom-chat',
        models: [{ id: 'relay-static-model' }],
        modelSource: 'fetched',
      }),
      hasSecret: true,
    });

    assert.deepEqual(verdict, { ready: true, model: 'custom-chat' });
  });

  it('does not let a seed list veto a default model', () => {
    // The same connection before its first discovery run: `models` is the
    // array this build shipped, which is not evidence about the account. The
    // request goes out and the provider answers for itself (#1584).
    const verdict = isConnectionReady({
      connection: connection({
        defaultModel: 'custom-chat',
        models: [{ id: 'relay-static-model' }],
        modelSource: 'fallback',
      }),
      hasSecret: true,
    });

    assert.deepEqual(verdict, { ready: true, model: 'custom-chat' });
  });

  it('admits an enabled model a snapshot provider never listed', () => {
    // `modelSource: 'fetched'` is the real persisted state here, and that is
    // the whole point: `volcengine-agent-plan` has no model-list endpoint, so
    // its discovery run replays the array this build shipped and honestly
    // records that a run happened. Provenance is not content — only
    // `providerSupportsModelDiscovery && fetched` means a provider enumerated
    // this account, and reading the flag alone let a release snapshot veto the
    // model an Ark plan actually serves (#1584).
    const verdict = isConnectionReady({
      connection: connection({
        providerType: 'volcengine-agent-plan',
        defaultModel: 'deepseek-v4-pro-beta',
        enabledModelIds: ['deepseek-v4-pro-beta'],
        models: [{ id: 'doubao-seed-2.1-turbo' }],
        modelSource: 'fetched',
      }),
      hasSecret: true,
    });

    assert.deepEqual(verdict, { ready: true, model: 'deepseek-v4-pro-beta' });
  });

  it('still rejects a snapshot model the snapshot itself marks image-only', () => {
    // Capabilities are facts wherever they came from; only inventory claims
    // lose their authority when the list is a shipped snapshot. Guards against
    // folding the capability check back inside the inventory gate.
    const verdict = isConnectionReady({
      connection: connection({
        providerType: 'volcengine-agent-plan',
        defaultModel: 'doubao-seedream',
        enabledModelIds: ['doubao-seedream'],
        models: [{ id: 'doubao-seedream', capabilities: { imageGeneration: true, chat: false } }],
        modelSource: 'fetched',
      }),
      hasSecret: true,
    });

    assert.deepEqual(verdict, { ready: false, reason: 'model_not_chat_capable' });
  });

  it('returns the normalized requested model id', () => {
    assert.deepEqual(
      isConnectionReady({
        connection: connection(),
        hasSecret: true,
        requestedModel: ' gpt-4.1 ',
      }),
      { ready: true, model: 'gpt-4.1' },
    );
  });
});

describe('isConnectionReady — retired provider gate', () => {
  // A connection stored before its provider was retired still looks complete:
  // enabled, credential on disk, models listed, default among them. Without
  // this gate the send is admitted and only fails when the Runtime cannot name
  // an adapter for it.
  const retired = connection({
    slug: 'claude-subscription',
    name: 'Claude Subscription',
    providerType: 'claude-subscription',
    defaultModel: 'claude-opus-5',
    enabledModelIds: ['claude-opus-5'],
    models: [{ id: 'claude-opus-5', capabilities: { chat: true } }],
  });

  it('refuses to send on a retired provider', () => {
    assert.deepEqual(isConnectionReady({ connection: retired, hasSecret: true }), {
      ready: false,
      reason: 'provider_retired',
    });
  });

  it('reports retirement rather than a repairable reason', () => {
    // `missing_api_key` would tell the user to sign in again, and the sign-in
    // no longer exists.
    assert.deepEqual(isConnectionReady({ connection: retired, hasSecret: false }), {
      ready: false,
      reason: 'provider_retired',
    });
  });
});
