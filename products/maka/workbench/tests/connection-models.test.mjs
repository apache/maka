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
  nsh: `export const signal = initial => { let value = initial; const read = () => value; read.set = next => { value = next; }; return read; }; export const computed = fn => fn; export const cleanup = () => {}; export const batch = fn => fn(); export const effect = fn => fn(); export const untracked = fn => fn(); export const Clipboard = { writeText: async () => {} }; export const openUrl = async () => {};`,
  locale: `export const tr = (key, values) => values ? key.replace(/\\{(\\w+)\\}/g, (_, name) => values[name]) : key; export const currentLocale = () => 'en'; export const applyLanguagePreference = () => {}; export const localizedPresentation = (presentation) => presentation;`,
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    let key = specifier;
    if (context.parentURL?.startsWith(appRoot.href) && specifier === './locale') key = 'locale';
    if (key in native)
      return { url: `data:text/javascript,${encodeURIComponent(native[key])}`, shortCircuit: true };
    if (
      specifier.endsWith('.js') &&
      (specifier.includes('/packages/plugin-sdk/src/') ||
        context.parentURL?.includes('/packages/plugin-sdk/src/'))
    )
      return next(`${specifier.slice(0, -3)}.ts`, context);
    if (
      context.parentURL?.startsWith(appRoot.href) &&
      specifier.startsWith('.') &&
      !/\.\w+$/.test(specifier)
    )
      return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
const { createSettingsOperations } = await import(new URL('settingsOperations.ts', appRoot));
const { createModelSettings } = await import(new URL('settings.ts', appRoot));
hooks.deregister();

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

async function openFixtureConnection({
  discoveredModelIds = ['gpt-4.1', 'gpt-4.1-mini', 'o4-mini', 'gpt-5'],
  enabledModelIds = ['gpt-4.1', 'manual-plain', 'manual-named'],
  modelOverrides = { 'manual-named': { displayName: 'Manual Named' } },
} = {}) {
  const provider = {
    entryId: 'maka.openai',
    name: 'openai',
    packageId: 'maka.openai',
    scope: 'profile',
  };
  const definition = {
    identity: provider,
    descriptor: {
      label: 'OpenAI',
      anonymous: false,
      customEndpoint: true,
      discovery: true,
      configurationDefaults: { baseUrl: 'https://api.openai.com/v1' },
      authentication: [{ id: 'api-key', interactive: false, label: 'API key' }],
    },
  };
  let revision = 1;
  let state = {
    name: 'OpenAI',
    enabled: true,
    configuration: { ...definition.descriptor.configurationDefaults },
    discoveredModelIds: [...discoveredModelIds],
    enabledModelIds: [...enabledModelIds],
    modelOverrides: structuredClone(modelOverrides),
    requestBodyOverlay: null,
  };
  const updates = [];
  const host = {
    pendingSettings: async () => [],
    async query(_endpoint, method) {
      if (method === 'connections')
        return {
          kind: 'page',
          revision,
          next: null,
          defaultTarget: { connectionId: 'openai', modelId: 'gpt-4.1' },
          connections: [
            {
              basis: { connectionId: 'openai', revision },
              name: state.name,
              slug: 'openai',
              provider,
              enabled: state.enabled,
              enabledModelCount: state.enabledModelIds.length,
              editable: true,
            },
          ],
        };
      if (method === 'models')
        return { kind: 'ready', revision, next: null, choices: [], defaultModel: null };
      if (method === 'provider') return definition;
      if (method === 'connection')
        return {
          kind: 'ready',
          name: state.name,
          enabled: state.enabled,
          target: {
            connectionId: 'openai',
            revision,
            slug: 'openai',
            provider,
            configuration: structuredClone(state.configuration),
          },
          editing: {
            discoveredModelIds: [...state.discoveredModelIds],
            enabledModelIds: [...state.enabledModelIds],
            modelOverrides: structuredClone(state.modelOverrides),
            requestBodyOverlay: state.requestBodyOverlay,
          },
        };
      if (method === 'credentialStatus')
        return {
          kind: 'status',
          status: {
            locator: { scope: 'connection', connectionId: 'openai', kind: 'provider' },
            configured: true,
            credentialId: 'cred-1',
            revision: 1,
            updatedAt: null,
          },
        };
      throw new Error(`unexpected query ${method}`);
    },
    async settingsMutation(endpoint, method, input) {
      if (endpoint === 'settings' && method === 'update') {
        updates.push(structuredClone(input));
        revision += 1;
        if (input.changes.name !== undefined) state.name = input.changes.name;
        if (input.changes.enabled !== undefined) state.enabled = input.changes.enabled;
        if (input.changes.configuration !== undefined)
          state.configuration = structuredClone(input.changes.configuration);
        if (input.changes.enabledModelIds !== undefined)
          state.enabledModelIds = [...input.changes.enabledModelIds];
        if (input.changes.modelOverrides !== undefined)
          state.modelOverrides = structuredClone(input.changes.modelOverrides);
        if (input.changes.requestBodyOverlay !== undefined)
          state.requestBodyOverlay = input.changes.requestBodyOverlay;
        return {
          reply: {
            receipt: {
              kind: 'recorded',
              outcome: {
                kind: 'returned',
                result: {
                  kind: 'success',
                  value: { kind: 'committed', connection: { connectionId: 'openai', revision } },
                },
              },
            },
          },
        };
      }
      throw new Error(`unexpected mutation ${endpoint}.${method}`);
    },
  };
  const operations = createSettingsOperations(host);
  operations.pendingKnown.set(true);
  const owner = createModelSettings(host, operations, () => true);
  await settled();
  await owner.openConnection({ connectionId: 'openai', revision });
  return { owner, operations, updates, state: () => state };
}

test('multiple model toggles and batch enable/disable stage locally and commit in one settings.update preserving unchecked manual models', async () => {
  const { owner, updates, state } = await openFixtureConnection();
  assert.equal(owner.modelCount(), 6);
  assert.equal(owner.enabledModelCount(), 3);
  assert.equal(owner.dirty(), false);
  assert.equal(owner.modelsDirty(), false);

  // Toggle multiple models rapidly without triggering any settings.update mutation.
  owner.setModelEnabled({ ...owner.action(), id: 'gpt-4.1-mini', enabled: true });
  owner.setModelEnabled({ ...owner.action(), id: 'manual-plain', enabled: false });
  owner.setModelEnabled({ ...owner.action(), id: 'manual-named', enabled: false });
  assert.equal(updates.length, 0);
  assert.equal(owner.busy(), false);
  assert.equal(owner.modelsDirty(), true);
  assert.equal(owner.connectionFieldsDirty(), false);
  assert.equal(owner.dirty(), true);
  // Manual model without overrides remains listed in the catalog while unchecked in draft.
  assert.equal(owner.modelCount(), 6);
  assert.equal(owner.enabledModelCount(), 2);
  assert.ok(owner.filteredModels().includes('manual-plain'));

  // Batch enable matching models only affects the provided IDs.
  owner.setModelsEnabled({
    ...owner.action(),
    ids: ['o4-mini', 'gpt-5'],
    enabled: true,
  });
  assert.equal(owner.enabledModelCount(), 4);
  assert.equal(updates.length, 0);

  // Single Save commits all staged changes in one mutation and preserves unchecked manual-plain.
  await owner.saveConnection(owner.action());
  assert.equal(updates.length, 1);
  assert.deepEqual(
    new Set(updates[0].changes.enabledModelIds),
    new Set(['gpt-4.1', 'gpt-4.1-mini', 'o4-mini', 'gpt-5']),
  );
  assert.deepEqual(updates[0].changes.modelOverrides, {
    'manual-named': { displayName: 'Manual Named' },
    'manual-plain': {},
  });
  assert.equal(owner.dirty(), false);
  assert.equal(owner.modelsDirty(), false);
  assert.equal(owner.modelCount(), 6);
  assert.equal(owner.enabledModelCount(), 4);
  assert.deepEqual(
    new Set(state().enabledModelIds),
    new Set(['gpt-4.1', 'gpt-4.1-mini', 'o4-mini', 'gpt-5']),
  );
});

test('Cancel discards staged model selection locally, and Back/leave guard protects unsaved model edits', async () => {
  const { owner, updates } = await openFixtureConnection();

  // Disable all stages locally; Cancel reverts immediately without network writes.
  owner.setModelsEnabled({ ...owner.action(), ids: owner.filteredModels(), enabled: false });
  assert.equal(owner.enabledModelCount(), 0);
  assert.equal(owner.modelsDirty(), true);
  owner.discardModelSelection(owner.action());
  assert.equal(owner.enabledModelCount(), 3);
  assert.equal(owner.modelsDirty(), false);
  assert.equal(owner.dirty(), false);
  assert.equal(updates.length, 0);

  // Enable all triggers Back and leave discard protection; Keep editing preserves staged toggles.
  owner.setModelsEnabled({ ...owner.action(), ids: owner.filteredModels(), enabled: true });
  assert.equal(owner.enabledModelCount(), 6);
  assert.equal(owner.back(), false);
  assert.equal(owner.discardTarget(), 'connection');
  owner.keepEditing();
  assert.equal(owner.discardTarget(), null);
  assert.equal(owner.enabledModelCount(), 6);

  const exited = [];
  owner.leave(() => exited.push('left'));
  assert.deepEqual(exited, []);
  assert.equal(owner.discardTarget(), 'connection');
  owner.discardEdits(owner.action());
  assert.deepEqual(exited, ['left']);
  assert.equal(owner.page(), 'connections');
  assert.equal(updates.length, 0);
});

test('toggling a model off and back on clears modelsDirty cleanly', async () => {
  const { owner } = await openFixtureConnection();
  owner.setModelEnabled({ ...owner.action(), id: 'gpt-4.1', enabled: false });
  assert.equal(owner.modelsDirty(), true);
  owner.setModelEnabled({ ...owner.action(), id: 'gpt-4.1', enabled: true });
  assert.equal(owner.modelsDirty(), false);
  assert.equal(owner.dirty(), false);
});

test('coupled connection-field edits and model toggles stay editable, commit in one settings.update, and discard together', async () => {
  const { owner, updates, state } = await openFixtureConnection();

  // Stage model toggle, then edit connection fields; model toggles remain editable.
  owner.setModelEnabled({ ...owner.action(), id: 'manual-plain', enabled: false });
  owner.edit('name', 'OpenAI Work');
  owner.toggleEnabled({ ...owner.action(), enabled: false });
  owner.setModelEnabled({ ...owner.action(), id: 'gpt-5', enabled: true });
  assert.equal(owner.connectionFieldsDirty(), true);
  assert.equal(owner.modelsDirty(), true);
  assert.equal(owner.enabledModelCount(), 3);
  assert.equal(updates.length, 0);

  // reloadConnection (Discard) reverts both connection fields and staged model selection.
  await owner.reloadConnection(owner.action());
  assert.equal(owner.dirty(), false);
  assert.equal(owner.editor().name, 'OpenAI');
  assert.equal(owner.editor().enabled, true);
  assert.equal(owner.enabledModelCount(), 3);
  assert.equal(owner.enabledModels().has('manual-plain'), true);
  assert.equal(owner.enabledModels().has('gpt-5'), false);

  // Stage connection field + model toggles again and commit atomically in one settings.update.
  owner.edit('name', 'OpenAI Primary');
  owner.setModelEnabled({ ...owner.action(), id: 'manual-plain', enabled: false });
  owner.setModelEnabled({ ...owner.action(), id: 'gpt-5', enabled: true });
  await owner.saveConnection(owner.action());
  assert.equal(updates.length, 1);
  assert.equal(updates[0].changes.name, 'OpenAI Primary');
  assert.deepEqual(
    new Set(updates[0].changes.enabledModelIds),
    new Set(['gpt-4.1', 'manual-named', 'gpt-5']),
  );
  assert.deepEqual(updates[0].changes.modelOverrides, {
    'manual-named': { displayName: 'Manual Named' },
    'manual-plain': {},
  });
  assert.equal(state().name, 'OpenAI Primary');
  assert.equal(owner.dirty(), false);
});
