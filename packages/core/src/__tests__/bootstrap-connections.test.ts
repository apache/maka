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
  it('seeds opencode-free as the default when no env provider key is present', () => {
    const seeds = resolveBootstrapConnections({});
    const free = seeds.find((s) => s.slug === 'opencode-free');
    assert.ok(free, 'opencode-free must always be seeded');
    assert.equal(free?.providerType, 'opencode-free');
    assert.equal(free?.defaultModel, 'big-pickle');
    assert.equal(seeds.filter((s) => s.isDefault).length, 1, 'exactly one default');
    assert.equal(seeds.find((s) => s.isDefault)?.slug, 'opencode-free');
  });

  it('defaults to the Anthropic env connection when ANTHROPIC_API_KEY is set, keeping opencode-free seeded', () => {
    const seeds = resolveBootstrapConnections({ ANTHROPIC_API_KEY: 'sk-x' });
    assert.ok(
      seeds.some((s) => s.slug === 'opencode-free'),
      'opencode-free stays seeded as a fallback',
    );
    assert.ok(!seeds.find((s) => s.slug === 'opencode-free')?.isDefault);
    assert.equal(seeds.find((s) => s.isDefault)?.slug, 'env-anthropic');
    assert.equal(seeds.find((s) => s.slug === 'env-anthropic')?.providerType, 'anthropic');
  });

  it('does not seed the OpenAI env connection when Anthropic is already present', () => {
    const seeds = resolveBootstrapConnections({
      ANTHROPIC_API_KEY: 'sk-x',
      OPENAI_API_KEY: 'sk-y',
    });
    assert.ok(!seeds.some((s) => s.slug === 'env-openai'));
  });

  it('defaults to the OpenAI env connection when only OPENAI_API_KEY is set', () => {
    const seeds = resolveBootstrapConnections({ OPENAI_API_KEY: 'sk-y' });
    assert.ok(seeds.some((s) => s.slug === 'opencode-free'));
    assert.equal(seeds.find((s) => s.isDefault)?.slug, 'env-openai');
  });
});
