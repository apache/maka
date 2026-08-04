/**
 * opencode-free provider — first-class free anonymous default.
 *
 * Maka must be usable out of the box with zero credentials. opencode-free is a
 * first-class provider that exposes OpenCode Zen's free, anonymous, IP-limited
 * models over the same `https://opencode.ai/zen/v1` endpoint, with no API key
 * (the runtime passes an empty key and @ai-sdk/openai-compatible omits the
 * Authorization header, so the OpenCode server treats the request as
 * anonymous). It reuses the opencode (Zen) model metadata — same endpoint,
 * same model ids — without duplicating snapshot entries.
 *
 * This contract pins the observable shape that makes "open Maka, send a
 * message, pay nothing" work: the provider is registered, needs no secret,
 * ships only active tool-capable free models, resolves their metadata via the
 * opencode snapshot, and leads the recommended providers.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PROVIDER_REGISTRY,
  RECOMMENDED_PROVIDER_TYPES,
  isWiredOAuthProvider,
} from '../provider-registry.js';
import { providerAuthRequiresSecret } from '../llm-connections.js';
import { lookupModelMetadata } from '../model-metadata.js';

describe('opencode-free provider — first-class free anonymous default', () => {
  it('is registered as a ready anonymous overseas provider on the Zen endpoint', () => {
    const def = PROVIDER_REGISTRY['opencode-free'];
    assert.ok(def, 'opencode-free must be registered');
    assert.equal(def.authKind, 'none');
    assert.equal(def.baseUrl, 'https://opencode.ai/zen/v1');
    assert.equal(def.status, 'ready');
    assert.equal(def.category, 'overseas');
    assert.equal(def.protocol, 'openai');
  });

  it('does not require a secret and is not an OAuth provider', () => {
    assert.equal(providerAuthRequiresSecret('opencode-free'), false);
    assert.equal(isWiredOAuthProvider('opencode-free'), false);
  });

  it('ships only active, tool-capable free models as its default catalog', () => {
    const def = PROVIDER_REGISTRY['opencode-free'];
    assert.ok(def.fallbackModels.length > 0, 'opencode-free must ship a non-empty free model set');
    for (const id of def.fallbackModels) {
      const meta = lookupModelMetadata('opencode-free', id);
      assert.equal(
        meta.capabilities?.functionCalling,
        true,
        `${id} must be tool-capable (free agents need function calling)`,
      );
      assert.equal(meta.lifecycle, 'active', `${id} must be an active (non-deprecated) free model`);
    }
  });

  it('reuses the opencode Zen model metadata without duplicating entries', () => {
    // big-pickle is an active free model that lives under the opencode (Zen)
    // snapshot. opencode-free must resolve it through modelsDevId: 'opencode',
    // not by carrying its own copy.
    const viaFree = lookupModelMetadata('opencode-free', 'big-pickle');
    const viaZen = lookupModelMetadata('opencode', 'big-pickle');
    assert.deepEqual(viaFree, viaZen);
  });

  it('leads the recommended providers so Maka is usable out of the box', () => {
    assert.equal(RECOMMENDED_PROVIDER_TYPES[0], 'opencode-free');
  });
});
