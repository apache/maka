import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core';
import { PROVIDER_REGISTRY, thinkingVariantsForModel } from '@maka/core';
import { buildProviderOptions } from '@maka/runtime';

function conn(providerType: LlmConnection['providerType'], slug = 'test'): LlmConnection {
  return {
    slug,
    name: slug,
    providerType,
    defaultModel: 'm',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('thinking wire contract', () => {
  test('issue #1858: opencode-go wires the declared effort for deepseek-v4-flash', () => {
    assert.deepEqual(buildProviderOptions(conn('opencode-go'), 'deepseek-v4-flash', 'high'), {
      'opencode-go': { reasoningEffort: 'high' },
    });
    assert.deepEqual(buildProviderOptions(conn('opencode-go'), 'deepseek-v4-flash', 'max'), {
      'opencode-go': { reasoningEffort: 'max' },
    });
  });

  test('every declared thinking variant on every provider path is wireable', () => {
    const gaps: string[] = [];
    for (const providerType of Object.keys(PROVIDER_REGISTRY) as LlmConnection['providerType'][]) {
      // Providers without a runtime adapter (e.g. phase3-experimental
      // gemini-cli) cannot start a request, so there is no wire to honor.
      if (PROVIDER_REGISTRY[providerType].runtimeAdapter?.kind === 'unavailable') continue;
      for (const modelId of PROVIDER_REGISTRY[providerType].fallbackModels) {
        for (const level of thinkingVariantsForModel(providerType, modelId)) {
          const options = buildProviderOptions(conn(providerType), modelId, level);
          if (Object.keys(options).length === 0) {
            gaps.push(`${providerType}/${modelId} declares "${level}" but wires nothing`);
          }
        }
      }
    }
    assert.deepEqual(gaps, []);
  });
});
