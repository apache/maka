import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core';
import {
  modelMetadataIdsForProvider,
  PROVIDER_REGISTRY,
  thinkingVariantsForModel,
} from '@maka/core';
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

// The metadata universe for each provider comes from the same alias rules
// `lookupModelMetadata` applies (generated snapshot + static overrides), so
// the sweep cannot silently shrink when the alias rules change.
function wiresAnything(options: Record<string, unknown>): boolean {
  // The inner object must carry at least one field the SDK will translate;
  // `{ openai: {} }` would send nothing while still being non-empty at the top.
  return Object.values(options).some(
    (value) => typeof value === 'object' && value !== null && Object.keys(value).length > 0,
  );
}

function hasRealOffWire(options: Record<string, unknown>): boolean {
  // A declared off choice must map to a wire the target SDK understands:
  // reasoning_effort none, thinking disabled, budget zero, or template false.
  for (const value of Object.values(options)) {
    if (typeof value !== 'object' || value === null) continue;
    const inner = value as Record<string, unknown>;
    if (inner.reasoningEffort === 'none') return true;
    if (
      typeof inner.thinking === 'object' &&
      inner.thinking !== null &&
      (inner.thinking as Record<string, unknown>).type === 'disabled'
    ) {
      return true;
    }
    if (
      typeof inner.thinkingConfig === 'object' &&
      inner.thinkingConfig !== null &&
      (inner.thinkingConfig as Record<string, unknown>).thinkingBudget === 0
    ) {
      return true;
    }
    if (
      typeof inner.chat_template_kwargs === 'object' &&
      inner.chat_template_kwargs !== null &&
      (inner.chat_template_kwargs as Record<string, unknown>).thinking === false
    ) {
      return true;
    }
  }
  return false;
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

  test('every declared thinking variant on every provider path wires something real', () => {
    const gaps: string[] = [];
    for (const providerType of Object.keys(PROVIDER_REGISTRY) as LlmConnection['providerType'][]) {
      // Providers without a runtime adapter (e.g. phase3-experimental
      // gemini-cli) cannot start a request, so there is no wire to honor.
      if (PROVIDER_REGISTRY[providerType].runtimeAdapter?.kind === 'unavailable') continue;
      const modelIds = new Set([
        ...PROVIDER_REGISTRY[providerType].fallbackModels,
        ...modelMetadataIdsForProvider(providerType),
      ]);
      for (const modelId of modelIds) {
        for (const level of thinkingVariantsForModel(providerType, modelId)) {
          const options = buildProviderOptions(conn(providerType), modelId, level);
          if (!wiresAnything(options)) {
            gaps.push(`${providerType}/${modelId} declares "${level}" but wires nothing`);
          } else if (level === 'off' && !hasRealOffWire(options)) {
            gaps.push(
              `${providerType}/${modelId} declares "off" without a real off wire: ${JSON.stringify(options)}`,
            );
          }
        }
      }
    }
    assert.deepEqual(gaps, []);
  });

  test('kimi-coding-plan wires every declared variant over the openai-chat protocol too', () => {
    // The sweep above only exercises conn() without a model apiProtocol, so
    // kimi always takes its anthropic branch. Sweep the openai-chat branch
    // explicitly so a future declared level cannot silently go unwired there.
    const gaps: string[] = [];
    const providerType = 'kimi-coding-plan' as const;
    const modelIds = new Set([
      ...PROVIDER_REGISTRY[providerType].fallbackModels,
      ...modelMetadataIdsForProvider(providerType),
    ]);
    for (const modelId of modelIds) {
      const connection = {
        ...conn(providerType),
        models: [{ id: modelId, apiProtocol: 'openai-chat' as const }],
      };
      for (const level of thinkingVariantsForModel(providerType, modelId)) {
        const options = buildProviderOptions(connection, modelId, level);
        if (!wiresAnything(options)) {
          gaps.push(
            `${providerType}/${modelId} (openai-chat) declares "${level}" but wires nothing`,
          );
        }
      }
    }
    assert.deepEqual(gaps, []);
  });
});
