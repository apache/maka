/**
 * models.dev sync contract — the registry, the sync map, and the upstream
 * directory must stay aligned in all three directions.
 *
 * This closes the silent-forget gap that kimi-coding-plan and
 * stepfun-step-plan fell into: a provider missing from the sync map had no
 * snapshot segment (so its metadata stayed frozen in hand-written overrides),
 * while a registry entry could declare a modelsDevId pointing at the wrong
 * segment and nothing noticed.
 *
 * Three directions:
 * - forward: a declared modelsDevId must name a provider that actually exists
 *   in the models.dev directory (catches a sync map key pointing at a source
 *   that does not exist, or a stale id after upstream renames).
 * - reverse: every snapshot segment must be declared by the registry with
 *   the segment's own id, so adding a provider to the sync map without
 *   wiring its registry entry is a test failure.
 * - directory: every registry provider whose base URL matches a models.dev
 *   directory provider (same host) must declare modelsDevId — the exact
 *   kimi-coding-plan shape (registry entry exists, upstream provider exists,
 *   neither side connected) is a test failure instead of a silent gap.
 *   Local/self-hosted providers (localhost, empty baseUrl) and providers
 *   whose upstream has no api field are intentionally not matched.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GENERATED_MODELS_DEV_DIRECTORY,
  GENERATED_MODELS_DEV_PROVIDER_FACTS,
} from '../model-metadata.generated.js';
import { PROVIDER_REGISTRY, type ProviderType } from '../provider-registry.js';

// The sync map covers a subset of provider types (the ones models.dev
// declares), so index by the full ProviderType union as possibly-absent.
const FACTS_BY_PROVIDER: Readonly<Partial<Record<ProviderType, { id: string }>>> =
  GENERATED_MODELS_DEV_PROVIDER_FACTS;

function hostOf(value: string): string | undefined {
  try {
    return new URL(value).host;
  } catch {
    return undefined;
  }
}

// Local/self-hosted software (ollama, LM Studio, LocalAI, ...) legitimately
// appears in the models.dev directory with a loopback api, but those registry
// providers are user-configured endpoints, not upstream services to sync.
function isLocalHost(value: string): boolean {
  const hostname = value.split(':')[0];
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    hostname === '::1'
  );
}

describe('models.dev sync contract', () => {
  it('every declared modelsDevId names a provider that exists in the models.dev directory', () => {
    const gaps: string[] = [];
    for (const [providerType, def] of Object.entries(PROVIDER_REGISTRY) as [
      ProviderType,
      (typeof PROVIDER_REGISTRY)[ProviderType],
    ][]) {
      if (def.modelsDevId === undefined) continue;
      if (!(def.modelsDevId in GENERATED_MODELS_DEV_DIRECTORY)) {
        gaps.push(
          `${providerType} declares modelsDevId ${def.modelsDevId} which is not a models.dev provider id`,
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

  it('every registry provider whose base URL matches a directory provider must declare it', () => {
    const gaps: string[] = [];
    for (const [providerType, def] of Object.entries(PROVIDER_REGISTRY) as [
      ProviderType,
      (typeof PROVIDER_REGISTRY)[ProviderType],
    ][]) {
      if (def.modelsDevId !== undefined) continue;
      if (!def.baseUrl) continue; // local / user-configured / account paths
      const registryHost = hostOf(def.baseUrl);
      if (!registryHost || isLocalHost(registryHost)) continue;
      const matched = Object.entries(GENERATED_MODELS_DEV_DIRECTORY).find(
        ([, entry]) => entry.api !== undefined && hostOf(entry.api) === registryHost,
      );
      if (matched) {
        gaps.push(
          `${providerType} base URL host ${registryHost} matches models.dev provider ${matched[0]} but declares no modelsDevId`,
        );
      }
    }
    assert.deepEqual(gaps, []);
  });
});
