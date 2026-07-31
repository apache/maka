import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PROVIDER_DEFAULTS } from '@maka/core';
import { PROVIDER_DISPLAY_COPY } from '../../renderer/settings/provider-display-copy.js';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

describe('Custom relay provider setup contract', () => {
  it('surfaces custom relay protocols as first-class recommended providers', () => {
    const chatRelay = PROVIDER_DEFAULTS['openai-compatible'];
    const responsesRelay = PROVIDER_DEFAULTS['openai-responses-compatible'];
    const anthropicRelay = PROVIDER_DEFAULTS['anthropic-compatible'];

    assert.equal(chatRelay.status, 'ready');
    assert.equal(chatRelay.catalogGroup, 'aggregators');
    assert.equal(chatRelay.category, 'custom');
    assert.equal(chatRelay.catalogBadge, 'Relay');
    assert.equal(chatRelay.recommendedOrder, 7.5);
    assert.deepEqual(chatRelay.runtimeAdapter, {
      kind: 'openai-compatible',
      name: 'connection',
      requireBaseUrl: true,
    });
    assert.equal(chatRelay.modelDiscovery.kind, 'protocol');

    assert.deepEqual(responsesRelay.runtimeAdapter, {
      kind: 'openai',
      apiProtocol: 'openai-responses',
    });
    assert.equal(responsesRelay.catalogBadge, 'Responses');
    assert.equal(responsesRelay.recommendedOrder, 7.6);
    assert.equal(responsesRelay.modelDiscovery.kind, 'protocol');

    assert.deepEqual(anthropicRelay.runtimeAdapter, {
      kind: 'anthropic',
      auth: 'api-key',
      normalizeBaseUrl: true,
    });
    assert.equal(anthropicRelay.catalogBadge, 'Anthropic');
    assert.equal(anthropicRelay.recommendedOrder, 7.7);
    assert.equal(anthropicRelay.modelDiscovery.kind, 'protocol');
  });

  it('uses relay-first catalog copy so users can find the中转站入口 without mixing protocols', () => {
    assert.equal(PROVIDER_DISPLAY_COPY['openai-compatible'].zh.name, '自定义中转站（OpenAI Chat）');
    assert.match(PROVIDER_DISPLAY_COPY['openai-compatible'].zh.description, /OpenAI Chat Completions 兼容中转站/);
    assert.equal(PROVIDER_DISPLAY_COPY['openai-compatible'].en.name, 'Custom relay (OpenAI Chat)');
    assert.match(PROVIDER_DISPLAY_COPY['openai-compatible'].en.description, /OpenAI Chat Completions-compatible relay/);

    assert.equal(PROVIDER_DISPLAY_COPY['openai-responses-compatible'].zh.name, '自定义中转站（OpenAI Responses）');
    assert.match(PROVIDER_DISPLAY_COPY['openai-responses-compatible'].zh.description, /OpenAI Responses API 兼容中转站/);
    assert.equal(PROVIDER_DISPLAY_COPY['anthropic-compatible'].zh.name, '自定义中转站（Anthropic）');
    assert.match(PROVIDER_DISPLAY_COPY['anthropic-compatible'].zh.description, /Anthropic Messages 兼容中转站/);
  });

  it('keeps custom relay creation on the full profile form with endpoint, key, required model, and gated model fetch', async () => {
    const form = await readRepo('apps/desktop/src/renderer/settings/provider-add-form.tsx');
    const copy = await readRepo('apps/desktop/src/renderer/locales/settings-provider-copy.ts');

    assert.match(form, /const requiresBaseUrl = !defaults\.baseUrl && !isCloudflareWorkersAi;/);
    assert.match(form, /const showsDefaultModel = recommendedDefaultModel\.trim\(\) === '';/);
    assert.match(form, /const isCustomRelay = defaults\.category === 'custom';/);
    assert.match(form, /if \(requiresBaseUrl && !baseUrl\.trim\(\)\) return setError\(copy\.endpointRequired\);/);
    assert.match(form, /if \(isCustomRelay && !normalizedDefaultModel\) return setError\(copy\.defaultModelRequired\);/);
    assert.match(form, /baseUrl: resolvedBaseUrl,/);
    assert.match(form, /defaultModel: normalizedDefaultModel \|\| recommendedDefaultModel,/);
    assert.match(
      form,
      /const supportsRemoteDiscovery = providerSupportsModelDiscovery\(props\.providerType\);[\s\S]*if \(supportsRemoteDiscovery\) \{[\s\S]*await props\.bridge\.fetchModels\(connection\.slug\)[\s\S]*if \(!isCustomRelay\) modelDiscoveryError = error/,
    );
    assert.match(form, /label=\{copy\.defaultModelAria\}[\s\S]*isLabelHidden/);
    assert.match(form, /<small>\{copy\.defaultModelHelp\}<\/small>/);

    assert.match(copy, /defaultModel: '默认模型'/);
    assert.match(copy, /defaultModelRequired: '请填写默认模型 ID。保存后仍会自动拉取模型目录。'/);
    assert.match(copy, /defaultModel: 'Default model'/);
    assert.match(copy, /defaultModelRequired: 'Enter a default model id\. Maka still fetches the model catalog after saving\.'/);
  });
});
