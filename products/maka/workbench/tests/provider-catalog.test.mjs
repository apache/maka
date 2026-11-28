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
import { registerHooks } from 'node:module';
import test from 'node:test';

const appRoot = new URL('../app/', import.meta.url);
const native = {
  nsh: `export const signal = initial => { let value = initial; const read = () => value; read.set = next => { value = next; }; return read; }; export const computed = fn => fn; export const cleanup = () => {}; export const openUrl = async () => ({ opened: true }); export const Clipboard = { writeText: async () => {} };`,
  locale: `export const tr = (key, values) => values ? key.replace(/\\{(\\w+)\\}/g, (_, name) => values[name]) : key; export const currentLocale = () => 'en';`,
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    let key = specifier;
    if (context.parentURL?.startsWith(appRoot.href) && specifier === './locale') key = 'locale';
    if (key in native)
      return { url: `data:text/javascript,${encodeURIComponent(native[key])}`, shortCircuit: true };
    if (
      context.parentURL?.startsWith(appRoot.href) &&
      specifier.startsWith('.') &&
      !/\.\w+$/.test(specifier)
    )
      return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
const { classifyProviderGroup, groupProviders, providerIdentityKey, recommendedProviders } =
  await import(new URL('providerCatalog.ts', appRoot));
const { createSettingsOperations } = await import(new URL('settingsOperations.ts', appRoot));
const { createModelSettings } = await import(new URL('settings.ts', appRoot));
hooks.deregister();

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

const providerSummary = (
  name,
  label,
  {
    packageId = 'maka.providers',
    entryId = packageId,
    scope = 'profile',
    customEndpoint = false,
    interactive = false,
  } = {},
) => ({
  identity: { packageId, entryId, scope, name },
  label,
  customEndpoint,
  authentication: [{ label: interactive ? `Sign in with ${label}` : 'API key', interactive }],
});

const SAMPLE_PROVIDERS = [
  providerSummary('chatgpt', 'ChatGPT Subscription', {
    packageId: 'maka.codex',
    interactive: true,
  }),
  providerSummary('openai', 'OpenAI'),
  providerSummary('anthropic', 'Anthropic'),
  providerSummary('google', 'Google Gemini'),
  providerSummary('deepseek', 'DeepSeek'),
  providerSummary('openrouter', 'OpenRouter'),
  providerSummary('kimi-coding-plan', 'Kimi Coding Plan'),
  providerSummary('mistral', 'Mistral'),
  providerSummary('togetherai', 'Together AI'),
  providerSummary('openai-compatible', 'Chat Completions', { customEndpoint: true }),
  providerSummary('ollama', 'Ollama'),
  providerSummary('lm-studio', 'LM Studio'),
  providerSummary('acme-sso', 'Acme SSO', { packageId: 'acme.plugin', interactive: true }),
  providerSummary('acme-relay', 'Acme Relay', { packageId: 'acme.plugin', customEndpoint: true }),
  providerSummary('acme-api', 'Acme API', { packageId: 'acme.plugin' }),
];

test('mental-model grouping classifies built-ins, preserves third-party fallbacks, and emits unique providers', () => {
  const groups = groupProviders(SAMPLE_PROVIDERS, 'en');
  assert.deepEqual(
    groups.map((g) => g.id),
    ['recommended', 'account', 'plans', 'api', 'aggregators', 'local', 'custom'],
  );
  assert.deepEqual(
    groups.find((g) => g.id === 'recommended')?.providers.map((p) => p.identity.name),
    ['chatgpt', 'openai', 'anthropic', 'google', 'deepseek', 'openrouter'],
  );
  assert.deepEqual(
    groups.find((g) => g.id === 'account')?.providers.map((p) => p.identity.name),
    ['acme-sso'],
  );
  assert.deepEqual(
    groups.find((g) => g.id === 'plans')?.providers.map((p) => p.identity.name),
    ['kimi-coding-plan'],
  );
  assert.deepEqual(
    groups.find((g) => g.id === 'api')?.providers.map((p) => p.identity.name),
    ['acme-api', 'mistral'],
  );
  assert.deepEqual(
    groups.find((g) => g.id === 'aggregators')?.providers.map((p) => p.identity.name),
    ['openai-compatible', 'togetherai'],
  );
  assert.deepEqual(
    groups.find((g) => g.id === 'local')?.providers.map((p) => p.identity.name),
    ['lm-studio', 'ollama'],
  );
  assert.deepEqual(
    groups.find((g) => g.id === 'custom')?.providers.map((p) => p.identity.name),
    ['acme-relay'],
  );

  // Every provider appears once with no duplicate keys across groups.
  const keys = groups.flatMap((g) => g.providers.map(providerIdentityKey));
  assert.equal(keys.length, SAMPLE_PROVIDERS.length);
  assert.equal(new Set(keys).size, SAMPLE_PROVIDERS.length);

  // Empty groups are omitted automatically.
  const onlyLocal = groupProviders([providerSummary('ollama', 'Ollama')], 'en');
  assert.deepEqual(
    onlyLocal.map((g) => g.id),
    ['local'],
  );
  assert.equal(
    classifyProviderGroup(
      providerSummary('openai', 'Third-Party OpenAI', { packageId: 'other.pkg' }),
    ),
    'api',
  );
});

test('recommendedProviders returns curated shortlist order for built-in providers only', () => {
  const reversed = [...SAMPLE_PROVIDERS].reverse();
  assert.deepEqual(
    recommendedProviders(reversed, 'en').map((p) => p.identity.name),
    ['chatgpt', 'openai', 'anthropic', 'google', 'deepseek', 'openrouter'],
  );
});

test('empty connections loads shortlist silently and honors origin-aware Back navigation', async () => {
  let failProviders = false;
  const host = {
    pendingSettings: async () => [],
    async query(_, method, input) {
      if (method === 'connections') {
        return { kind: 'page', connections: [], revision: 1, next: null, defaultTarget: null };
      }
      if (method === 'models') {
        return {
          kind: 'ready',
          revision: 1,
          choices: [],
          defaultModel: { kind: 'none' },
          next: null,
        };
      }
      if (method === 'providers') {
        if (failProviders) throw new Error('Provider registry offline');
        if (input.offset === 0) {
          return { providers: SAMPLE_PROVIDERS.slice(0, 4), next: 4 };
        }
        return { providers: SAMPLE_PROVIDERS.slice(4), next: null };
      }
      if (method === 'provider') {
        const match = SAMPLE_PROVIDERS.find((p) => p.identity.name === input.name);
        return {
          identity: match.identity,
          descriptor: {
            label: match.label,
            anonymous: false,
            customEndpoint: match.customEndpoint,
            discovery: true,
            configurationSchema: { properties: {} },
            configurationDefaults: { baseUrl: 'https://api.example.com/v1' },
            authentication: [{ id: 'api-key', interactive: false, label: 'API key' }],
          },
        };
      }
      throw new Error(`Unexpected query ${method}`);
    },
  };

  const operations = createSettingsOperations(host);
  operations.pendingKnown.set(true);
  const owner = createModelSettings(host, operations, () => true);
  await settled();

  // Shortlist automatically paged all providers while staying on connections.
  assert.equal(owner.page(), 'connections');
  assert.equal(owner.providers().length, SAMPLE_PROVIDERS.length);
  assert.equal(operations.error(), '');

  // Entering ConnectionForm straight from Connections shortlist returns to Connections on Back.
  const openai = SAMPLE_PROVIDERS.find((p) => p.identity.name === 'openai').identity;
  await owner.chooseProvider(openai);
  assert.equal(owner.page(), 'connection');
  assert.equal(owner.editor()?.origin, 'connections');
  assert.equal(owner.back(), false);
  assert.equal(owner.page(), 'connections');

  // Dirty draft from Connections shortlist still returns to Connections after discarding.
  await owner.chooseProvider(openai);
  owner.edit('apiKey', 'sk-test');
  assert.equal(owner.back(), false);
  assert.equal(owner.discardTarget(), 'connection');
  owner.discardEdits(owner.action());
  assert.equal(owner.page(), 'connections');

  // Entering ConnectionForm via ProviderPicker returns to ProviderPicker and keeps the query.
  owner.newConnection();
  await settled();
  assert.equal(owner.page(), 'providers');
  owner.searchProviders('mistral');
  const mistral = SAMPLE_PROVIDERS.find((p) => p.identity.name === 'mistral').identity;
  await owner.chooseProvider(mistral);
  assert.equal(owner.page(), 'connection');
  assert.equal(owner.editor()?.origin, 'providers');
  assert.equal(owner.back(), false);
  assert.equal(owner.page(), 'providers');
  assert.equal(owner.providerQuery(), 'mistral');

  // Backing out of a providers-origin draft when providers were cleared reloads the catalog.
  await owner.chooseProvider(mistral);
  owner.providers.set([]);
  assert.equal(owner.back(), false);
  await settled();
  assert.equal(owner.page(), 'providers');
  assert.equal(owner.providers().length, SAMPLE_PROVIDERS.length);

  // A provider-list failure during empty-state shortlist preload stays quiet on Connections.
  failProviders = true;
  owner.providers.set([]);
  owner.back();
  await settled();
  assert.equal(owner.page(), 'connections');
  assert.equal(owner.connectionsFailed(), false);
  assert.equal(operations.error(), '');
});
