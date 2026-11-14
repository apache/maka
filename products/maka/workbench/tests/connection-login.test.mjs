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
  nsh: `export const signal = initial => { let value = initial; const read = () => value; read.set = next => { value = next; }; return read; }; export const computed = fn => fn; export const cleanup = () => {}; export const browser = { opened: [], available: true }; export const openUrl = async url => { browser.opened.push(url); return {opened: browser.available}; }; export const Clipboard = { writeText: async () => {} };`,
  locale: `export const tr = (key, values) => values ? key.replace(/\\{(\\w+)\\}/g, (_, name) => values[name]) : key;`,
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    let key = specifier;
    if (context.parentURL?.startsWith(appRoot.href)) {
      if (specifier === './locale') key = 'locale';
    }
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
const { createSettingsOperations } = await import(new URL('settingsOperations.ts', appRoot));
const { createModelSettings } = await import(new URL('settings.ts', appRoot));
hooks.deregister();

function connectionEditor() {
  const provider = {
    packageId: 'maka.codex',
    entryId: 'maka.codex',
    scope: 'profile',
    name: 'chatgpt',
  };
  const configuration = { baseUrl: 'https://chatgpt.com/backend-api/codex' };
  const descriptor = {
    label: 'ChatGPT Subscription',
    anonymous: false,
    discovery: true,
    configurationSchema: { properties: {} },
    configurationDefaults: configuration,
    authentication: [{ id: 'device', interactive: true, label: 'Sign in with ChatGPT' }],
  };
  const status = () => ({
    locator: { scope: 'connection', connectionId: 'connection', kind: 'provider' },
    configured: false,
    credentialId: null,
    revision: null,
    updatedAt: null,
  });
  const original = {
    kind: 'ready',
    target: { connectionId: 'connection', revision: 1, slug: 'chatgpt', provider, configuration },
    name: 'ChatGPT Subscription',
    enabled: true,
    editing: { enabledModelIds: [], modelOverrides: null, requestBodyOverlay: null },
  };
  const api = {
    pendingSettings: async () => [],
    async query(_, method) {
      if (method === 'credentialStatus') return { kind: 'status', status: status() };
      if (method === 'connections')
        return {
          kind: 'page',
          connections: [],
          revision: 1,
          next: null,
          defaultTarget: null,
        };
      if (method === 'models')
        return {
          kind: 'ready',
          revision: 1,
          choices: [],
          defaultModel: { kind: 'none' },
          next: null,
        };
      throw new Error(`unexpected query ${method}`);
    },
  };
  const operations = createSettingsOperations(api);
  operations.pendingKnown.set(true);
  const owner = createModelSettings(api, operations, () => true, undefined, {
    page: 'connection',
    connections: [],
    providers: [],
    connectionQuery: '',
    providerQuery: '',
    modelQuery: '',
    revision: 1,
    defaultTarget: null,
    next: null,
    providerNext: null,
    editor: {
      instance: 1,
      baseline: original,
      provider: {
        identity: provider,
        descriptor,
      },
      name: original.name,
      slug: 'chatgpt',
      baseUrl: original.target.configuration.baseUrl,
      enabled: true,
      serverSideCompaction: false,
      overlay: 'null',
      apiKey: '',
    },
    model: null,
    credential: status(),
    discovery: 'idle',
    confirmation: null,
    initialModel: null,
  });

  return { owner };
}

test('leaving a connection runs the exit at once when clean and only after discarding edits', async () => {
  const { owner } = connectionEditor();
  const ran = [];
  owner.leave(() => ran.push('clean'));
  owner.edit('name', 'A personal name');
  owner.leave(() => ran.push('kept'));
  assert.equal(owner.discardTarget(), 'connection');
  owner.keepEditing();
  assert.equal(owner.editor().name, 'A personal name');
  owner.leave(() => ran.push('discarded'));
  owner.discardEdits(owner.action());
  assert.deepEqual(ran, ['clean', 'discarded']);
  assert.equal(owner.page(), 'connections');
});
