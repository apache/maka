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
import { resolveBootstrapConnections } from '../bootstrap-connections.js';

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
      assert.equal(free?.defaultModel, 'big-pickle');
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
});
