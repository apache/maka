import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deriveConnectionSlug,
  validateConnectionBaseUrl,
  validateSlug,
} from '../llm-connections.js';
import { GENERATED_MODELS_DEV_METADATA } from '../model-metadata.generated.js';
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

// Discovery keeps only the fallback set, and the catalog marks whatever it
// returns available and default-capable, so a deprecated id in `fallbackModels`
// is offered as a usable choice. Six providers still carry such ids on main —
// `openai` writes its list by hand, the rest build it through
// `toolCallingModelIds`, which does not filter lifecycle. Converging all of
// them changes which models users are offered and is tracked in #3355; this
// list is the recorded boundary, so a provider that regresses into it fails
// here rather than passing unnoticed.
// Not every catalog provider has a models.dev snapshot (custom and
// compatible-endpoint types have none), so the lookup is widened rather than
// keyed on the registry's own union.
const snapshotFor = (type: string) =>
  (
    GENERATED_MODELS_DEV_METADATA as Record<
      string,
      Record<string, { lifecycle?: string }> | undefined
    >
  )[type];

const PROVIDERS_WITH_DEPRECATED_FALLBACKS = new Set([
  'openai',
  'xiaomi',
  'mistral',
  'togetherai',
  'nvidia',
  'deepinfra',
]);

describe('provider catalog contract — fallback lifecycle', () => {
  it('keeps deprecated snapshot models out of fallback lists', () => {
    const regressed = [];
    for (const type of CATALOG_PROVIDER_TYPES) {
      const snapshot = snapshotFor(type);
      if (snapshot === undefined) continue;
      const deprecated = (PROVIDER_REGISTRY[type].fallbackModels ?? []).filter(
        (id) => snapshot[id]?.lifecycle === 'deprecated',
      );
      if (deprecated.length > 0 && !PROVIDERS_WITH_DEPRECATED_FALLBACKS.has(type)) {
        regressed.push(`${type}: ${deprecated.join(', ')}`);
      }
    }
    assert.deepEqual(regressed, []);
  });

  it('holds the recorded boundary to exactly the providers that predate it', () => {
    const offenders = CATALOG_PROVIDER_TYPES.filter((type) => {
      const snapshot = snapshotFor(type);
      return (
        snapshot !== undefined &&
        (PROVIDER_REGISTRY[type].fallbackModels ?? []).some(
          (id) => snapshot[id]?.lifecycle === 'deprecated',
        )
      );
    });
    // Fails when a listed provider is cleaned up and the entry is left behind,
    // so the boundary shrinks as the tracked work lands instead of going stale.
    assert.deepEqual([...offenders].sort(), [...PROVIDERS_WITH_DEPRECATED_FALLBACKS].sort());
  });
});
