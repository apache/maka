/**
 * resolveBootstrapConnections — zero-credential default seed decision.
 *
 * A fresh Maka install must be usable out of the box. The bootstrap seeds an
 * `opencode-free` connection (no secret, anonymous OpenCode Zen free models)
 * so a user with no provider keys can send a message immediately. Env-keyed
 * providers (ANTHROPIC_API_KEY / OPENAI_API_KEY) layer on top and take the
 * default, mirroring the pre-existing env-bootstrap behavior; opencode-free
 * stays seeded as a fallback.
 *
 * Pure & sync — the caller (app-lifecycle) performs the connectionStore
 * writes and emits the change event. This module only decides what to seed
 * and which one is the default, so the decision is testable without Electron.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  OPENCODE_FREE_BOOTSTRAP_VERSION,
  OPENCODE_FREE_DEFAULT_ENABLED_MODELS,
  OPENCODE_FREE_DEFAULT_MODEL,
  OPENCODE_FREE_LEGACY_DEFAULT_MODEL,
  resolveBootstrapConnections,
  resolveOpenCodeFreeBootstrapMigration,
} from '../bootstrap-connections.js';
import type { LlmConnection } from '../llm-connections.js';

describe('resolveBootstrapConnections — zero-credential default seed', () => {
  it('selects one default while keeping the credential-free fallback', () => {
    const cases = [
      [{}, 'opencode-free', false],
      [{ ANTHROPIC_API_KEY: 'sk-x' }, 'env-anthropic', false],
      [{ OPENAI_API_KEY: 'sk-y' }, 'env-openai', false],
      [{ ANTHROPIC_API_KEY: 'sk-x', OPENAI_API_KEY: 'sk-y' }, 'env-anthropic', true],
    ] as const;

    for (const [env, defaultSlug, excludesOpenAi] of cases) {
      const seeds = resolveBootstrapConnections(env);
      const free = seeds.find((seed) => seed.slug === 'opencode-free');
      assert.equal(free?.defaultModel, OPENCODE_FREE_DEFAULT_MODEL);
      assert.deepEqual(free?.enabledModelIds, [...OPENCODE_FREE_DEFAULT_ENABLED_MODELS]);
      assert.deepEqual(free?.extras, {
        makaBootstrap: { id: 'opencode-free', version: OPENCODE_FREE_BOOTSTRAP_VERSION },
      });
      assert.deepEqual(
        seeds.filter((seed) => seed.isDefault).map((seed) => seed.slug),
        [defaultSlug],
      );
      assert.equal(
        seeds.some((seed) => seed.slug === 'env-openai'),
        !excludesOpenAi && 'OPENAI_API_KEY' in env,
      );
    }
  });

  it('migrates only the untouched historical OpenCode Free seed shapes', () => {
    const currentPatch = {
      defaultModel: OPENCODE_FREE_DEFAULT_MODEL,
      enabledModelIds: [...OPENCODE_FREE_DEFAULT_ENABLED_MODELS],
      extras: {
        makaBootstrap: { id: 'opencode-free', version: OPENCODE_FREE_BOOTSTRAP_VERSION },
      },
    };

    const legacyV1: LlmConnection = {
      slug: 'opencode-free',
      name: 'OpenCode Free',
      providerType: 'opencode-free',
      defaultModel: OPENCODE_FREE_LEGACY_DEFAULT_MODEL,
      enabledModelIds: [OPENCODE_FREE_LEGACY_DEFAULT_MODEL],
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    assert.deepEqual(resolveOpenCodeFreeBootstrapMigration(legacyV1), currentPatch);

    const legacyV2: LlmConnection = {
      slug: 'opencode-free',
      name: 'OpenCode Free',
      providerType: 'opencode-free',
      defaultModel: OPENCODE_FREE_DEFAULT_MODEL,
      enabledModelIds: [OPENCODE_FREE_DEFAULT_MODEL],
      enabled: true,
      extras: { makaBootstrap: { id: 'opencode-free', version: 2 } },
      createdAt: 1,
      updatedAt: 1,
    };
    assert.deepEqual(resolveOpenCodeFreeBootstrapMigration(legacyV2), currentPatch);

    // Already at the current bootstrap shape — no further migration.
    assert.equal(
      resolveOpenCodeFreeBootstrapMigration({
        ...legacyV2,
        ...currentPatch,
      }),
      undefined,
    );

    for (const customized of [
      { ...legacyV1, name: 'My free connection' },
      { ...legacyV1, baseUrl: 'https://custom.example/v1' },
      { ...legacyV1, enabledModelIds: [OPENCODE_FREE_LEGACY_DEFAULT_MODEL, 'custom-free'] },
      { ...legacyV1, models: [{ id: OPENCODE_FREE_LEGACY_DEFAULT_MODEL }] },
      { ...legacyV1, extras: { owner: 'user' } },
      {
        ...legacyV2,
        enabledModelIds: [OPENCODE_FREE_DEFAULT_MODEL, 'mimo-v2.5-free'],
      },
      {
        ...legacyV2,
        extras: { makaBootstrap: { id: 'opencode-free', version: 2 }, owner: 'user' },
      },
    ]) {
      assert.equal(resolveOpenCodeFreeBootstrapMigration(customized), undefined);
    }
  });
});
