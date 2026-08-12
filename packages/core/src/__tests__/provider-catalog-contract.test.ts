import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deriveConnectionSlug,
  validateConnectionBaseUrl,
  validateSlug,
} from '../llm-connections.js';
import { CATALOG_PROVIDER_TYPES, PROVIDER_REGISTRY } from '../provider-registry.js';

describe('provider connection slug derivation contract', () => {
  it('continues through dense collisions until it finds an unused slug', () => {
    const base = deriveConnectionSlug('openai');
    const existing = [base, ...Array.from({ length: 98 }, (_, index) => `${base}-${index + 2}`)];
    const derived = deriveConnectionSlug('openai', existing);

    assert.equal(derived, 'openai-100');
    assert.ok(!existing.includes(derived));
    assert.equal(validateSlug(derived), null);
  });
});

describe('provider catalog contract — structural invariants over CATALOG_PROVIDER_TYPES', () => {
  it('exposes an endpoint source that passes the production baseUrl gate', () => {
    for (const type of CATALOG_PROVIDER_TYPES) {
      const def = PROVIDER_REGISTRY[type];
      if (def.baseUrl.trim() !== '') {
        assert.equal(
          validateConnectionBaseUrl(def.baseUrl),
          null,
          `${type} baseUrl ${def.baseUrl} must pass validateConnectionBaseUrl`,
        );
        continue;
      }
      if (def.baseUrlTemplate !== undefined) {
        const resolved = def.baseUrlTemplate.replace(/\$\{[^}]+\}/g, 'placeholder');
        assert.ok(
          resolved.trim() !== '',
          `${type} baseUrlTemplate must resolve to a non-blank URL once its placeholders are filled`,
        );
        assert.equal(
          validateConnectionBaseUrl(resolved),
          null,
          `${type} baseUrlTemplate ${def.baseUrlTemplate} must pass validateConnectionBaseUrl once its placeholders are filled`,
        );
        continue;
      }
      const isCustomConnection = def.category === 'custom';
      assert.ok(
        isCustomConnection,
        `${type} has no baseUrl, no baseUrlTemplate, and is not a custom connection — it cannot source an endpoint`,
      );
    }
  });
});
