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
import {
  lookupModelMetadata,
  openAiAdapterApiProtocol,
  resolveModelVisionSupport,
} from '../model-metadata.js';
import { PROVIDER_REGISTRY, providerFallbackModelIds } from '../provider-registry.js';
import type { ModelInfo, ProviderType } from '../llm-connections.js';

describe('model-metadata vision capability', () => {
  it('treats a Claude newer than the generated snapshot as able to read images', () => {
    assert.deepEqual(lookupModelMetadata('anthropic', 'claude-opus-6'), {});
    assert.equal(resolveModelVisionSupport('anthropic', undefined, 'claude-opus-6'), true);
    assert.equal(
      resolveModelVisionSupport('anthropic', undefined, 'claude-3-9-sonnet-20990101'),
      true,
    );
  });

  it('still fails closed for the Claude generation that cannot read images', () => {
    assert.equal(resolveModelVisionSupport('anthropic', undefined, 'claude-2.1'), false);
  });

  it('confines the default to the providers that serve Anthropic their own models', () => {
    const providerType = 'anthropic-compatible' satisfies ProviderType;
    assert.equal(resolveModelVisionSupport(providerType, undefined, 'claude-opus-6'), false);
  });

  it('yields to what a connection reports, in both directions', () => {
    const denied: ModelInfo[] = [{ id: 'claude-opus-6', capabilities: { vision: false } }];
    assert.equal(resolveModelVisionSupport('anthropic', denied, 'claude-opus-6'), false);
    const granted: ModelInfo[] = [{ id: 'some-unlisted-model', capabilities: { vision: true } }];
    assert.equal(resolveModelVisionSupport('openai', granted, 'some-unlisted-model'), true);
  });

  it('lets a user declaration outrank every other signal, in both directions', () => {
    const stored: ModelInfo[] = [{ id: 'my-reasoner', capabilities: { vision: true } }];
    assert.equal(
      resolveModelVisionSupport('openai-compatible', stored, 'my-reasoner', false),
      false,
    );
    assert.equal(
      resolveModelVisionSupport('openai-compatible', undefined, 'some-unlisted-model', true),
      true,
    );
    assert.equal(resolveModelVisionSupport('anthropic', undefined, 'claude-opus-6', false), false);
    assert.equal(
      resolveModelVisionSupport('openai-compatible', stored, 'my-reasoner', undefined),
      true,
    );
    assert.equal(
      resolveModelVisionSupport('openai-compatible', undefined, 'some-unlisted-model', undefined),
      false,
    );
  });
});

describe('openAiAdapterApiProtocol', () => {
  it('routes a normalized gpt-5 family to the Responses wire', () => {
    assert.equal(openAiAdapterApiProtocol(' GPT-5.6-sol '), 'openai-responses');
  });

  it('keeps a non-gpt-5 OpenAI model on the Chat Completions wire', () => {
    assert.equal(openAiAdapterApiProtocol('gpt-4o'), 'openai-chat');
  });

  it('routes only xAI Grok 4.5 through Responses', () => {
    assert.equal(openAiAdapterApiProtocol('grok-4.5', 'xai'), 'openai-responses');
    assert.equal(openAiAdapterApiProtocol('grok-4.5', 'xai-oauth'), 'openai-responses');
    assert.equal(openAiAdapterApiProtocol('grok-4.3', 'xai'), 'openai-chat');
    assert.equal(openAiAdapterApiProtocol('grok-4.5', 'openai'), 'openai-chat');
  });

  it('routes official DeepSeek V4 models through the provider Responses wire', () => {
    assert.equal(openAiAdapterApiProtocol('deepseek-v4-flash', 'deepseek'), 'openai-responses');
    assert.equal(openAiAdapterApiProtocol('deepseek-v4-pro', 'deepseek'), 'openai-responses');
    assert.equal(openAiAdapterApiProtocol('deepseek-chat', 'deepseek'), 'openai-chat');
  });

  it('routes only OpenCode Go Muse Spark through its supported Responses wire', () => {
    assert.equal(
      openAiAdapterApiProtocol('muse-spark-1.2-contributor', 'opencode-go'),
      'openai-responses',
    );
    assert.equal(openAiAdapterApiProtocol('muse-spark-1.2-contributor', 'opencode'), 'openai-chat');
    assert.equal(openAiAdapterApiProtocol('minimax-m3', 'opencode-go'), 'openai-chat');
  });

  it('routes only Qwen3.8 Max through Alibaba Token Plan Responses', () => {
    for (const providerType of ['alibaba-token-plan-cn', 'alibaba-token-plan'] as const) {
      assert.equal(openAiAdapterApiProtocol('qwen3.8-max', providerType), 'openai-responses');
      assert.equal(openAiAdapterApiProtocol('qwen3.7-max', providerType), 'openai-chat');
    }
    assert.equal(openAiAdapterApiProtocol('qwen3.8-max', 'alibaba-cn'), 'openai-chat');
  });
});

describe('deepseek v4 flash vision exp metadata regression', () => {
  it('resolves the bare model id with vision support', () => {
    assert.equal(
      resolveModelVisionSupport('deepseek', undefined, 'deepseek-v4-flash-vision-exp'),
      true,
    );
  });

  it('keeps the model present in the deepseek shipped baseline', () => {
    assert.ok(
      providerFallbackModelIds(PROVIDER_REGISTRY.deepseek).includes('deepseek-v4-flash-vision-exp'),
    );
  });

  it('returns expected metadata from lookupModelMetadata', () => {
    const modelId = 'deepseek-v4-flash-vision-exp';
    const metadata = lookupModelMetadata('deepseek', modelId);

    assert.equal(metadata.displayName, 'DeepSeek-V4-Flash-Vision-Exp');
    assert.equal(
      metadata.description,
      'Experimental DeepSeek V4 Flash model for image understanding and multimodal agent tasks',
    );
    assert.equal(metadata.contextWindow, 1_000_000);
    assert.equal(metadata.maxOutputTokens, 384_000);
    assert.equal(metadata.structuredOutput, true);
    assert.equal(metadata.lastUpdated, '2026-08-21');
    assert.deepEqual(metadata.thinkingOptions, {
      efforts: ['low', 'high', 'max'],
      toggle: true,
    });
    assert.equal(metadata.capabilities?.vision, true);
    assert.deepEqual(metadata.modalities, { input: ['text', 'image'], output: ['text'] });
  });

  it('is recognized from a bare discovered id', () => {
    const modelId = 'deepseek-v4-flash-vision-exp';
    const discovered: ModelInfo[] = [{ id: modelId }];
    const metadata = lookupModelMetadata('deepseek', modelId);

    assert.equal(metadata.displayName, 'DeepSeek-V4-Flash-Vision-Exp');
    assert.equal(metadata.capabilities?.vision, true);
    assert.equal(resolveModelVisionSupport('deepseek', discovered, modelId), true);
    assert.equal(
      resolveModelVisionSupport('deepseek', [{ id: 'deepseek-v4-flash' }], 'deepseek-v4-flash'),
      false,
    );
  });
});

// The Agent Plan gateway has no model-list endpoint its key can reach and has
// no models.dev snapshot, so its catalog is a hand-maintained mirror of the
// official plan page (volcengine docs 2366394) and its model release and
// retirement announcements. These tests pin that mirror to the facts those
// pages published as of 2026-09.
describe('Volcengine Agent Plan official catalog mirror', () => {
  it('offers glm-5.3-flash with the facts the plan page publishes', () => {
    assert.ok(
      providerFallbackModelIds(PROVIDER_REGISTRY['volcengine-agent-plan']).includes(
        'glm-5.3-flash',
      ),
    );
    const metadata = lookupModelMetadata('volcengine-agent-plan', 'glm-5.3-flash');
    assert.equal(metadata.displayName, 'GLM-5.3-Flash');
    assert.equal(metadata.contextWindow, 1_024_000);
    assert.equal(metadata.maxOutputTokens, 128_000);
    assert.equal(metadata.capabilities?.vision, true);
  });

  it('pins glm-5.3 to the plan page table literals', () => {
    const metadata = lookupModelMetadata('volcengine-agent-plan', 'glm-5.3');
    assert.equal(metadata.contextWindow, 1_024_000);
    assert.equal(metadata.maxOutputTokens, 128_000);
  });

  it('carries the official 1M context window for minimax-m3', () => {
    assert.equal(
      lookupModelMetadata('volcengine-agent-plan', 'minimax-m3').contextWindow,
      1_024_000,
    );
  });

  it('records the upstream retirement of glm-5.2, kimi-k2.6 and minimax-m2.7', () => {
    for (const modelId of ['glm-5.2', 'kimi-k2.6', 'minimax-m2.7']) {
      assert.equal(
        lookupModelMetadata('volcengine-agent-plan', modelId).lifecycle,
        'deprecated',
        modelId,
      );
    }
  });
});
