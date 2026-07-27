/**
 * Provider catalog contract — structural invariants over the registry.
 *
 * These invariants replace the per-provider add-flow E2E clones that used to
 * live in apps/desktop/e2e/providers.spec.ts. They are data-driven over
 * CATALOG_PROVIDER_TYPES, so adding a provider is covered automatically with
 * zero manual test updates. They assert *shape*, never snapshot values (no
 * "provider X's model is exactly Y"), so a legitimate model/endpoint refresh
 * does not churn this file.
 *
 * Brand-mark completeness (every catalog provider resolves to a real mark, not
 * the generic fallback) is asserted on the desktop side — core cannot import a
 * renderer module — in
 * apps/desktop/src/main/__tests__/icon-governance-contract.test.ts
 * ("renders a registered brand mark for every catalog provider").
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateConnectionBaseUrl } from '../llm-connections.js';
import {
  CATALOG_PROVIDER_TYPES,
  PROVIDER_REGISTRY,
  isWiredOAuthProvider,
  type ProviderCatalogGroup,
} from '../provider-registry.js';

// The catalog groups the catalog UI actually renders as tabs. A new group must
// be added here deliberately, which is the point: ProvidersPanel only knows how
// to render these buckets. 'recommended' is deliberately NOT a base group even
// though the ProviderCatalogGroup union carries it: the 推荐 tab is an overlay
// sourced from RECOMMENDED_PROVIDER_TYPES (ProvidersPanel.providersForCategory),
// while every other tab filters by catalogGroup — so a provider declaring
// catalogGroup: 'recommended' would appear in no tab at all. (Splitting the
// union type itself is a larger registry change, out of scope here.)
const CATALOG_TAB_GROUPS: ReadonlySet<ProviderCatalogGroup> = new Set([
  'plans',
  'api',
  'aggregators',
  'local',
]);

describe('provider OAuth wiring contract', () => {
  it('derives runnable account providers from the registry adapter boundary', () => {
    for (const type of [
      'claude-subscription',
      'openai-codex',
      'github-copilot',
      'xai-oauth',
    ] as const) {
      assert.equal(isWiredOAuthProvider(type), true, `${type} must be wired`);
    }
    assert.equal(isWiredOAuthProvider('gemini-cli'), false);
  });
});

describe('provider catalog contract — structural invariants over CATALOG_PROVIDER_TYPES', () => {
  it('gives every catalog provider a non-empty label and description', () => {
    for (const type of CATALOG_PROVIDER_TYPES) {
      const def = PROVIDER_REGISTRY[type];
      assert.ok(def.label.trim().length > 0, `${type} must carry a non-empty label`);
      assert.ok(def.description.trim().length > 0, `${type} must carry a non-empty description`);
    }
  });

  it('assigns every catalog provider a catalog group that renders as a tab', () => {
    for (const type of CATALOG_PROVIDER_TYPES) {
      const group = PROVIDER_REGISTRY[type].catalogGroup;
      assert.ok(
        group !== undefined && CATALOG_TAB_GROUPS.has(group),
        `${type} catalogGroup ${String(group)} must be one of ${[...CATALOG_TAB_GROUPS].join(', ')}`,
      );
    }
  });

  it('exposes an endpoint source that passes the production baseUrl gate', () => {
    // A provider must be able to name where its base URL comes from:
    //   - a concrete baseUrl, or
    //   - a baseUrlTemplate whose placeholders resolve to a concrete URL
    //     (account-scoped endpoints), or
    //   - a custom relay connection where the user supplies the URL
    //     at connect time.
    // Concrete URLs are judged by validateConnectionBaseUrl — the same gate the
    // connection IPC applies — so a registry default can never be something
    // production would reject (a bare `new URL()` check would still admit
    // `javascript:` or `file:` schemes). The validator alone cannot decide
    // blank-vs-concrete, though: it deliberately returns null for blank input,
    // whose semantics there are "no override, fall back to the provider
    // default" — but here the registry value IS the default, so a whitespace
    // baseUrl means no usable endpoint. An explicit trim check routes blank
    // values away from the validator.
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

  it('ships a well-formed default model set for every catalog provider', () => {
    for (const type of CATALOG_PROVIDER_TYPES) {
      const def = PROVIDER_REGISTRY[type];
      for (const id of def.fallbackModels) {
        assert.ok(id.trim().length > 0, `${type} ships an empty fallback model id`);
      }
      assert.equal(
        new Set(def.fallbackModels).size,
        def.fallbackModels.length,
        `${type} ships duplicate fallback model ids`,
      );
      if (def.fallbackModels.length === 0) {
        // The add form derives its recommended default model from the shipped
        // snapshot (provider-add-form.tsx → buildCatalogRecommendedDefaultModel)
        // and connection readiness reports missing_model for an empty default
        // (connection-readiness.ts). An empty snapshot is therefore only
        // acceptable where the model catalog is inherently instance-specific —
        // a user-operated runtime or endpoint (category 'local' / 'custom')
        // whose models can only be discovered live from the user's own
        // instance. A hosted, keyed provider with an empty snapshot would
        // silently create never-ready connections with no recommended default.
        assert.ok(
          def.category === 'local' || def.category === 'custom',
          `${type} is a hosted provider (category ${def.category}) and must ship a non-empty default model snapshot`,
        );
        assert.notEqual(
          def.modelDiscovery.kind,
          'fallback',
          `${type} ships no default model snapshot, so it must declare live model discovery — ` +
            'static-fallback discovery would leave it with no model source at all',
        );
      }
    }
  });
});
