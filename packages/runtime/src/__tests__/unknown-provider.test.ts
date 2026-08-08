/**
 * Unknown-providerType tolerance for the runtime send/discovery paths.
 *
 * A connection persisted on another branch may carry a providerType this
 * build's PROVIDER_REGISTRY doesn't know. The runtime helpers
 * must fail gracefully with a clear error / `ok:false` result instead of
 * crashing on `PROVIDER_DEFAULTS[providerType].<field>`. Mirrors the
 * `isFakeBackend` "unknown → non-real" convention in
 * @maka/core/connection-readiness.ts. No network I/O is needed — every path
 * here short-circuits before any fetch.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection, ProviderType } from '@maka/core';
import { fetchProviderModels } from '../model-fetcher.js';
import { resolveModelRuntime } from '../model-runtime.js';
import { testConnection } from '../test-connection.js';

function unknownConnection(): LlmConnection {
  return {
    slug: 'branch-only-provider',
    name: 'Branch-only provider',
    providerType: 'branch-only-provider' as ProviderType,
    defaultModel: 'branch-model',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('unknown-providerType runtime fallback', () => {
  test('resolveModelRuntime throws a clear error for an unregistered providerType', () => {
    assert.throws(
      () => resolveModelRuntime(unknownConnection(), 'branch-model'),
      /Unknown provider type "branch-only-provider"/,
    );
  });

  test('testConnection returns ok:false with a clear message and no network call', async () => {
    const result = await testConnection(unknownConnection(), 'irrelevant-key');
    assert.equal(result.ok, false);
    assert.match(result.errorMessage ?? '', /Unknown provider type "branch-only-provider"/);
  });

  test('fetchProviderModels throws a generalized error for an unregistered providerType', async () => {
    await assert.rejects(
      fetchProviderModels(unknownConnection(), 'irrelevant-key'),
      /Failed to fetch provider models/i,
    );
  });
});
