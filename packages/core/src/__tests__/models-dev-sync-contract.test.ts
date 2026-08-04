/**
 * models.dev sync contract — every provider type must declare where its
 * metadata comes from, and that declaration must be truthful.
 *
 * This closes the silent-forget gap that kimi-coding-plan and
 * stepfun-step-plan fell into:
 * - kimi's shape: registry entry exists, upstream provider exists, but
 *   neither modelsDevId nor a sync-map entry connected them (metadata
 *   stayed frozen in hand-written overrides).
 * - stepfun/minimax's shape: registry entry declared a *neighbour* segment
 *   id (stepfun / MiniMax) instead of its own, and nothing checked it.
 *
 * Every registry provider must satisfy exactly one of:
 * - have its own snapshot segment (modelsDevId === its segment id), or
 * - be a declared access-path alias to another provider's segment
 *   (MODELS_DEV_SEGMENT_ALIAS below, modelsDevId === the alias target's id),
 *   or
 * - be in the NOT_IN_MODELS_DEV whitelist (upstream has no entry: local
 *   runtimes, user-configured endpoints, volcengine which models.dev does
 *   not cover).
 *
 * A provider in none of the three buckets, or whose modelsDevId does not
 * match the bucket's expected id, is the exact bug shape this suite exists
 * to catch.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GENERATED_MODELS_DEV_DIRECTORY,
  GENERATED_MODELS_DEV_PROVIDER_FACTS,
} from '../model-metadata.generated.js';
import { PROVIDER_REGISTRY, type ProviderType } from '../provider-registry.js';

/**
 * Access paths that intentionally reuse another provider's models.dev
 * segment. Each entry must stay in sync with the metadata lookup alias
 * rules in model-metadata.ts.
 */
const MODELS_DEV_SEGMENT_ALIAS: Readonly<Record<string, ProviderType>> = {
  'xai-oauth': 'xai',
  'opencode-free': 'opencode',
  'claude-subscription': 'anthropic',
  'openai-codex': 'openai',
};

/**
 * Providers that intentionally have no models.dev segment: local/self-hosted
 * runtimes, user-configured endpoints, and volcengine (absent from the
 * upstream catalog). A new registry entry must land in one of the other two
 * buckets; adding it here requires a reason.
 */
const NOT_IN_MODELS_DEV: Readonly<Record<string, string>> = {
  'volcengine-ark': 'models.dev does not cover Volcengine Ark',
  'volcengine-coding-plan': 'models.dev does not cover Volcengine Ark',
  'volcengine-agent-plan': 'models.dev does not cover Volcengine Ark',
  ollama: 'local runtime, not an upstream service',
  'lm-studio': 'local runtime, not an upstream service',
  localai: 'local runtime, not an upstream service',
  'openai-compatible': 'user-configured endpoint, no upstream catalog entry',
  'openai-responses-compatible': 'user-configured endpoint, no upstream catalog entry',
  'anthropic-compatible': 'user-configured endpoint, no upstream catalog entry',
};

function expectedSegmentId(providerType: ProviderType): string | undefined {
  const facts = GENERATED_MODELS_DEV_PROVIDER_FACTS as Partial<
    Record<ProviderType, { id: string }>
  >;
  const own = facts[providerType];
  if (own) return own.id;
  const alias = MODELS_DEV_SEGMENT_ALIAS[providerType];
  if (alias) return facts[alias]!.id;
  return undefined;
}

function hostOf(value: string): string | undefined {
  try {
    return new URL(value).host;
  } catch {
    return undefined;
  }
}

describe('models.dev sync contract', () => {
  it('every provider type declares a truthful models.dev segment or is whitelisted', () => {
    const gaps: string[] = [];
    for (const [providerType, def] of Object.entries(PROVIDER_REGISTRY) as [
      ProviderType,
      (typeof PROVIDER_REGISTRY)[ProviderType],
    ][]) {
      const expected = expectedSegmentId(providerType);
      if (expected !== undefined) {
        if (def.modelsDevId !== expected) {
          gaps.push(
            `${providerType} must declare modelsDevId ${expected} (own segment or alias); got ${def.modelsDevId ?? 'nothing'}`,
          );
        }
        continue;
      }
      if (!(providerType in NOT_IN_MODELS_DEV)) {
        gaps.push(
          `${providerType} is neither snapshot-backed nor aliased nor whitelisted — the kimi/stepfun orphan shape`,
        );
      }
    }
    assert.deepEqual(gaps, []);
  });

  it('every snapshot segment is declared by the registry', () => {
    const gaps: string[] = [];
    for (const providerType of Object.keys(GENERATED_MODELS_DEV_PROVIDER_FACTS)) {
      if (!(providerType in PROVIDER_REGISTRY)) {
        gaps.push(`snapshot segment ${providerType} is missing from the provider registry`);
      }
    }
    assert.deepEqual(gaps, []);
  });

  it('a whitelisted provider whose base URL matches a directory provider must declare it', () => {
    const gaps: string[] = [];
    for (const providerType of Object.keys(NOT_IN_MODELS_DEV)) {
      const def = PROVIDER_REGISTRY[providerType as ProviderType];
      if (!def?.baseUrl) continue;
      const registryHost = hostOf(def.baseUrl);
      if (!registryHost) continue;
      if (registryHost.startsWith('localhost') || registryHost.startsWith('127.0.0.1')) continue;
      const matched = Object.entries(GENERATED_MODELS_DEV_DIRECTORY).find(
        ([, entry]) => entry.api !== undefined && hostOf(entry.api) === registryHost,
      );
      if (matched) {
        gaps.push(
          `${providerType} is whitelisted but base URL host ${registryHost} matches models.dev provider ${matched[0]}`,
        );
      }
    }
    assert.deepEqual(gaps, []);
  });
});
