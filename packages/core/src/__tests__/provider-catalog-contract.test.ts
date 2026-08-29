/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deriveConnectionSlug,
  validateConnectionBaseUrl,
  validateSlug,
} from '../llm-connections.js';
import { GENERATED_MODELS_DEV_METADATA } from '../model-metadata.generated.js';
import {
  CATALOG_PROVIDER_TYPES,
  PROVIDER_REGISTRY,
  isRetiredProvider,
} from '../provider-registry.js';
import { buildConnectionModelCatalogEntries } from '../model-catalog.js';
import { PROVIDER_AUTH_ACTIONS, deriveProviderAuthContract } from '../provider-auth.js';
import type { ProviderType } from '../llm-connections.js';

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

  it('delegates Alibaba Token Plan execution through one explicit Runtime profile', () => {
    const delegated = Object.entries(PROVIDER_REGISTRY).flatMap(([providerType, definition]) => {
      const adapter = definition.runtimeAdapter;
      return adapter.kind === 'openai-compatible' && adapter.runtimeProfile
        ? [{ providerType, runtimeProfile: adapter.runtimeProfile }]
        : [];
    });
    assert.deepEqual(delegated, [
      { providerType: 'alibaba-token-plan-cn', runtimeProfile: 'alibaba-token-plan' },
      { providerType: 'alibaba-token-plan', runtimeProfile: 'alibaba-token-plan' },
    ]);
  });
});

describe('retired provider contract', () => {
  // Retirement rests on a few lines nothing else reads. Each was separately
  // revertible with the whole suite green, which would let a retired provider
  // become sendable again by accident.
  const retired = (Object.keys(PROVIDER_REGISTRY) as ProviderType[]).filter((type) =>
    isRetiredProvider(type),
  );

  it('pins the entries this catalog retires', () => {
    assert.deepEqual(retired, ['claude-subscription']);
  });

  it('keeps a retired provider registered but unwired', () => {
    for (const type of retired) {
      assert.ok(
        PROVIDER_REGISTRY[type] !== undefined,
        `${type} must stay registered so a stored connection still decodes`,
      );
      assert.equal(
        PROVIDER_REGISTRY[type].runtimeAdapter.kind,
        'unavailable',
        `${type} is retired, so no Runtime adapter may claim it`,
      );
    }
  });

  it('keeps a retired provider out of the add-connection catalog', () => {
    for (const type of retired) {
      assert.equal(
        CATALOG_PROVIDER_TYPES.includes(type),
        false,
        `${type} must not be offerable as a new connection`,
      );
    }
  });

  it('offers no action on a retired connection', () => {
    // The storage layer admits model fetches and connection tests by reading
    // this contract, so every action being hidden is what refuses them there —
    // not a check each call site has to remember.
    for (const type of retired) {
      const contract = deriveProviderAuthContract({
        providerType: type,
        enabled: true,
        hasSecret: true,
      });
      for (const action of PROVIDER_AUTH_ACTIONS) {
        assert.equal(
          contract.actionAvailability[action],
          'hidden',
          `${type} must not offer ${action}`,
        );
      }
    }
  });

  it('reports every model of a retired connection as removed and unselectable', () => {
    // The adapter blocks the send; without this the pickers would keep offering
    // models that can no longer answer.
    for (const type of retired) {
      const entries = buildConnectionModelCatalogEntries({
        connection: {
          slug: `${type}-stored`,
          providerType: type,
          defaultModel: PROVIDER_REGISTRY[type].fallbackModels[0] ?? '',
          models: undefined,
          modelSource: 'fallback',
          modelsFetchedAt: undefined,
        },
        // The caller would pass `true` for a live connection; retirement must
        // win over it rather than depend on the caller getting it right.
        providerAvailable: true,
        authOk: true,
      });
      assert.ok(entries.length > 0, `${type} should still list its stored models`);
      for (const entry of entries) {
        assert.equal(entry.unavailableReason, 'provider_removed');
        assert.equal(entry.canUseAsChatDefault, false);
      }
    }
  });
});

// A deprecated id in `fallbackModels` is offered as a usable choice: the
// catalog marks the list available and default-capable, and `fallbackModels[0]`
// is the new-connection default and the connection-test probe. (For the eight
// providers with a `CURATED_CATALOG_FALLBACK_MODELS` entry that curated list
// replaces this one in the catalog, so theirs reaches CLI onboarding and the
// probe candidates instead.) `toolCallingModelIds` filters on tool-calling
// capability only, so a derivation that needs it drops deprecated ids at its
// own call site, and `openai` writes its list by hand. Removal is from the
// offer only — an id a user already chose still sends, and live discovery
// still returns whatever the endpoint serves (#3355).
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

describe('provider catalog contract — fallback lifecycle', () => {
  it('keeps deprecated snapshot models out of fallback lists', () => {
    const regressed = [];
    for (const type of CATALOG_PROVIDER_TYPES) {
      const snapshot = snapshotFor(type);
      if (snapshot === undefined) continue;
      const deprecated = (PROVIDER_REGISTRY[type].fallbackModels ?? []).filter(
        (id) => snapshot[id]?.lifecycle === 'deprecated',
      );
      if (deprecated.length > 0) {
        regressed.push(`${type}: ${deprecated.join(', ')}`);
      }
    }
    assert.deepEqual(regressed, []);
  });
});
