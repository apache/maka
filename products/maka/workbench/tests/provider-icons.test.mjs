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
import test from 'node:test';
import {
  PROVIDER_BRANDS,
  resolveExternalAgentBrand,
  resolveProviderBrand,
} from '../app/providerBrands.ts';

test('built-in provider identities and aliases resolve to their brand marks', () => {
  const cases = [
    [{ packageId: 'maka.codex', name: 'chatgpt' }, 'openai'],
    [{ packageId: 'maka.providers', name: 'openai' }, 'openai'],
    [{ packageId: 'maka.providers', name: 'openai-codex' }, 'openai'],
    [{ packageId: 'maka.providers', name: 'anthropic' }, 'claude'],
    [{ packageId: 'maka.providers', name: 'google' }, 'gemini'],
    [{ packageId: 'maka.providers', name: 'deepseek' }, 'deepseek'],
    [{ packageId: 'maka.providers', name: 'openrouter' }, 'openrouter'],
    [{ packageId: 'maka.providers', name: 'xai' }, 'xai'],
    [{ packageId: 'maka.providers', name: 'mistral' }, 'mistral'],
    [{ packageId: 'maka.providers', name: 'groq' }, 'groq'],
    [{ packageId: 'maka.providers', name: 'togetherai' }, 'together'],
    [{ packageId: 'maka.providers', name: 'fireworks-ai' }, 'fireworks'],
    [{ packageId: 'maka.providers', name: 'deepinfra' }, 'deepinfra'],
    [{ packageId: 'maka.providers', name: 'cohere' }, 'cohere'],
    [{ packageId: 'maka.providers', name: 'cerebras' }, 'cerebras'],
    [{ packageId: 'maka.providers', name: 'alibaba-coding-plan-cn' }, 'alibaba'],
    [{ packageId: 'maka.providers', name: 'volcengine-coding-plan' }, 'volcengine'],
    [{ packageId: 'maka.providers', name: 'tencent-tokenhub' }, 'hunyuan'],
    [{ packageId: 'maka.providers', name: 'tencent-token-plan-enterprise' }, 'tencentcloud'],
    [{ packageId: 'maka.providers', name: 'zai-coding-plan' }, 'zai'],
    [{ packageId: 'maka.providers', name: 'zhipu-coding-plan' }, 'zai'],
    [{ packageId: 'maka.providers', name: 'moonshot-global' }, 'kimi'],
    [{ packageId: 'maka.providers', name: 'kimi-coding-plan' }, 'kimi'],
    [{ packageId: 'maka.providers', name: 'siliconflow' }, 'siliconflow'],
    [{ packageId: 'maka.providers', name: 'ollama-cloud' }, 'ollama'],
    [{ packageId: 'maka.providers', name: 'lm-studio' }, 'lmstudio'],
    [{ packageId: 'maka.providers', name: 'cloudflare-workers-ai' }, 'cloudflare'],
    [{ packageId: 'maka.providers', name: 'huggingface' }, 'huggingface'],
    [{ packageId: 'maka.providers', name: 'nvidia' }, 'nvidia'],
    [{ packageId: 'maka.providers', name: 'vercel' }, 'vercel'],
    [{ packageId: 'maka.providers', name: 'opencode-go' }, 'opencode'],
    [{ packageId: 'maka.providers', name: 'stepfun-ai-step-plan' }, 'stepfun'],
    [{ packageId: 'maka.providers', name: 'xiaomi-token-plan-cn' }, 'xiaomimimo'],
    [{ packageId: 'maka.providers', name: 'zenmux' }, 'zenmux'],
  ];
  for (const [identity, expected] of cases) {
    assert.equal(resolveProviderBrand(identity), expected, JSON.stringify(identity));
  }
});

test('custom endpoints, excluded marks, and third-party plugin providers fall back cleanly', () => {
  const fallbacks = [
    null,
    undefined,
    { packageId: 'maka.codex', name: 'other' },
    { packageId: 'maka.providers', name: 'openai-compatible' },
    { packageId: 'maka.providers', name: 'openai-responses-compatible' },
    { packageId: 'maka.providers', name: 'anthropic-compatible' },
    { packageId: 'maka.providers', name: 'github-copilot' },
    { packageId: 'maka.providers', name: 'MiniMax' },
    { packageId: 'maka.providers', name: 'minimax-coding-plan' },
    { packageId: 'maka.providers', name: 'localai' },
    { packageId: 'maka.providers', name: 'unknown-vendor' },
    { packageId: 'acme.custom-plugin', name: 'openai' },
  ];
  for (const identity of fallbacks) {
    assert.equal(resolveProviderBrand(identity), null, JSON.stringify(identity));
  }
});

test('external agent runtimes resolve known brands and fall back on unknown IDs', () => {
  assert.equal(resolveExternalAgentBrand('antigravity'), 'antigravity');
  assert.equal(resolveExternalAgentBrand('antigravity-acp'), 'antigravity');
  assert.equal(resolveExternalAgentBrand('codex'), 'openai');
  assert.equal(resolveExternalAgentBrand('claude'), 'claude');
  assert.equal(resolveExternalAgentBrand('claude-code'), 'claude');
  assert.equal(resolveExternalAgentBrand('Claude'), 'claude');
  assert.equal(resolveExternalAgentBrand('opencode'), 'opencode');
  assert.equal(resolveExternalAgentBrand('gemini-cli'), 'gemini');
  assert.equal(resolveExternalAgentBrand('unknown-agent'), null);
  assert.equal(resolveExternalAgentBrand(''), null);
  assert.equal(resolveExternalAgentBrand(null), null);
});

test('every vendored brand mark has well-formed vector geometry and gradient stops', () => {
  for (const [id, mark] of Object.entries(PROVIDER_BRANDS)) {
    assert.ok(mark.shapes.length > 0, `${id} has no shapes`);
    if ('scale' in mark && mark.scale !== undefined) {
      assert.ok(mark.scale > 0, `${id} scale must be positive`);
    }
    for (const shape of mark.shapes) {
      if (shape.tag === 'path') {
        assert.ok(shape.d.trim().length > 0, `${id} has empty path`);
      } else {
        assert.ok(shape.r > 0, `${id} has non-positive circle radius`);
      }
      if (typeof shape.fill !== 'string') {
        assert.ok(shape.fill.stops.length >= 2, `${id} gradient needs at least 2 stops`);
        for (const [offset, color] of shape.fill.stops) {
          assert.ok(offset >= 0 && offset <= 1, `${id} gradient offset out of range: ${offset}`);
          assert.ok(color.startsWith('#'), `${id} gradient stop color should be hex: ${color}`);
        }
      }
    }
  }
});
