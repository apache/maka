/**
 * models.dev sync contract — every snapshot segment must be reachable from
 * the provider registry, and every declared modelsDevId must be truthful.
 *
 * This closes the silent-forget gap that kimi-coding-plan and
 * stepfun-step-plan fell into: a provider missing from the sync map had no
 * snapshot segment (so its metadata stayed frozen in hand-written overrides),
 * while a registry entry could declare a modelsDevId pointing at the wrong
 * segment and nothing noticed.
 *
 * Two directions:
 * - forward: a declared modelsDevId must resolve — to the provider's own
 *   snapshot segment when one exists, or through the metadata alias rules
 *   (xai-oauth -> xai, opencode-free -> opencode) when it does not.
 * - reverse: every snapshot segment must be declared by the registry with
 *   the segment's own id, so adding a provider to the sync map without
 *   wiring its registry entry is a test failure.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GENERATED_MODELS_DEV_PROVIDER_FACTS } from '../model-metadata.generated.js';
import { modelMetadataIdsForProvider } from '../model-metadata.js';
import { PROVIDER_REGISTRY, type ProviderType } from '../provider-registry.js';

// The sync map covers a subset of provider types (the ones models.dev
// declares), so index by the full ProviderType union as possibly-absent.
const FACTS_BY_PROVIDER: Readonly<Partial<Record<ProviderType, { id: string }>>> =
  GENERATED_MODELS_DEV_PROVIDER_FACTS;

describe('models.dev sync contract', () => {
  it('every declared modelsDevId resolves to the provider snapshot or alias metadata', () => {
    const gaps: string[] = [];
    for (const [providerType, def] of Object.entries(
      PROVIDER_REGISTRY,
    ) as [ProviderType, (typeof PROVIDER_REGISTRY)[ProviderType]][]) {
      if (def.modelsDevId === undefined) continue;
      const facts = FACTS_BY_PROVIDER[providerType];
      if (facts) {
        if (facts.id !== def.modelsDevId) {
          gaps.push(
            `${providerType} declares modelsDevId ${def.modelsDevId} but its snapshot segment id is ${facts.id}`,
          );
        }
      } else if (modelMetadataIdsForProvider(providerType).length === 0) {
        gaps.push(
          `${providerType} declares modelsDevId ${def.modelsDevId} but has no snapshot segment and no alias-resolved metadata`,
        );
      }
    }
    assert.deepEqual(gaps, []);
  });

  it('every snapshot segment is declared by the registry with its own id', () => {
    const gaps: string[] = [];
    for (const [providerType, facts] of Object.entries(GENERATED_MODELS_DEV_PROVIDER_FACTS)) {
      const def = PROVIDER_REGISTRY[providerType as ProviderType];
      if (!def) {
        gaps.push(`snapshot segment ${providerType} is missing from the provider registry`);
        continue;
      }
      if (def.modelsDevId !== facts.id) {
        gaps.push(
          `${providerType} must declare modelsDevId ${facts.id} (its own snapshot segment); got ${def.modelsDevId ?? 'nothing'}`,
        );
      }
    }
    assert.deepEqual(gaps, []);
  });
});
