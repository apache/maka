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
  nsh: `export const signal = initial => { let value = initial; const read = () => value; read.set = next => { value = next; }; return read; }; export const computed = fn => fn; export const cleanup = () => {}; export const batch = fn => fn(); export const effect = fn => fn(); export const untracked = fn => fn();`,
  locale: `export const tr = (key, values) => values ? key.replace(/\\{(\\w+)\\}/g, (_, name) => values[name]) : key; export const currentLocale = () => 'en'; export const applyLanguagePreference = () => {}; export const localizedPresentation = (presentation) => presentation;`,
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
const { createSettingsOperations } = await import(new URL('settingsOperations.ts', appRoot));
const { createGeneralSettings } = await import(new URL('generalSettingsState.ts', appRoot));
const { createMcpSettings } = await import(new URL('mcpSettingsState.ts', appRoot));
const { createPluginSettings } = await import(new URL('pluginSettingsState.ts', appRoot));
const { createNetworkSettings } = await import(new URL('networkSettingsState.ts', appRoot));
hooks.deregister();

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const operationsFor = (host) => {
  const operations = createSettingsOperations({ pendingSettings: async () => [], ...host });
  operations.pendingKnown.set(true);
  return operations;
};
const exits = () => {
  const ran = [];
  return { ran, to: (name) => () => ran.push(name) };
};

async function general({ instructions = 'Be brief.' } = {}) {
  const host = {
    async query(_, method) {
      if (method === 'assistantPreferences')
        return {
          revision: 1,
          language: 'auto',
          displayName: 'Ada',
          workspaceInstructions: true,
          incognitoActive: false,
          compactionPrompt: 'Summarize the work.',
          defaultCompactionPrompt: 'Summarize the work.',
          shell: { preference: 'auto', executable: '', titles: true },
          predictions: {
            enabled: true,
            ordinarySessionsOnly: false,
            liveSamplePercent: 100,
            catchUpSamplePercent: 50,
            prompt: null,
          },
          defaultPredictionPrompt: 'Predict the next message.',
        };
      if (method === 'globalInstructions')
        return {
          kind: 'available',
          source: 'user',
          revision: instructions === null ? null : 'r1',
          path: '/home/.maka/AGENTS.md',
          exists: instructions !== null,
          content: instructions ?? '',
        };
      throw new Error(`unexpected query ${method}`);
    },
  };
  const owner = createGeneralSettings(host, operationsFor(host), () => true);
  owner.activate();
  await settled();
  return owner;
}

test('general settings ask before leaving an edited preference and keep or drop the draft', async () => {
  const owner = await general();
  const exit = exits();
  owner.open({ request: owner.action(), kind: 'compaction' });
  owner.leave(exit.to('clean'));
  assert.deepEqual(exit.ran, ['clean']);
  assert.equal(owner.discarding.asking(), false);

  owner.editPrompt(owner.action(), 'Keep the decisions.');
  assert.equal(owner.back(), false);
  assert.equal(owner.discarding.asking(), true);
  owner.discarding.keep();
  assert.equal(owner.editor().prompt, 'Keep the decisions.');

  owner.leave(exit.to('kept'));
  owner.discarding.keep();
  owner.leave(exit.to('discarded'));
  assert.deepEqual(exit.ran, ['clean']);
  owner.discarding.discard();
  assert.deepEqual(exit.ran, ['clean', 'discarded']);
  assert.equal(owner.editor(), null);
});

test('general settings Back with the prompt open keeps editing, and Cancel drops the draft without asking', async () => {
  const owner = await general();
  owner.open({ request: owner.action(), kind: 'personalization' });
  owner.editName(owner.action(), 'Grace');
  owner.back();
  assert.equal(owner.back(), false);
  assert.equal(owner.discarding.asking(), false);
  assert.equal(owner.editor().displayName, 'Grace');
  owner.cancel(owner.action());
  assert.equal(owner.editor(), null);
  assert.equal(owner.discarding.asking(), false);
});

test('an untouched missing AGENTS.md can be saved but leaving it does not ask', async () => {
  const owner = await general({ instructions: null });
  const exit = exits();
  owner.openGlobal(owner.action());
  await settled();
  assert.equal(owner.dirty(), true);
  owner.leave(exit.to('untouched'));
  assert.deepEqual(exit.ran, ['untouched']);

  owner.editGlobal(owner.action(), 'Prefer small changes.');
  owner.leave(exit.to('edited'));
  assert.deepEqual(exit.ran, ['untouched']);
  assert.equal(owner.discarding.asking(), true);
});

async function mcp() {
  const location = { location: 'user:agents', revision: 'r1', path: '/home/.agents/mcp.json' };
  const host = {
    async query() {
      return {
        locations: [
          {
            ...location,
            servers: [{ name: 'docs', configuration: { url: 'https://example.invalid/mcp' } }],
          },
        ],
      };
    },
  };
  const owner = createMcpSettings(host, operationsFor(host), {
    workspace: () => null,
    busy: () => false,
  });
  owner.activate();
  owner.refresh();
  await settled();
  return owner;
}

test('MCP server editor asks before leaving typed changes, not after opening options', async () => {
  const owner = await mcp();
  const exit = exits();
  owner.open(owner.rows()[0]);
  owner.change('advanced', true);
  owner.leave(exit.to('clean'));
  assert.deepEqual(exit.ran, ['clean']);

  owner.change('url', 'https://example.invalid/updated');
  assert.equal(owner.back(), false);
  owner.discarding.keep();
  assert.equal(owner.editor().url, 'https://example.invalid/updated');
  owner.leave(exit.to('kept'));
  owner.discarding.keep();
  owner.leave(exit.to('discarded'));
  owner.discarding.discard();
  assert.deepEqual(exit.ran, ['clean', 'discarded']);
  assert.equal(owner.editor(), null);
});

test('MCP Cancel drops a new server draft without asking', async () => {
  const owner = await mcp();
  owner.open(null);
  owner.change('name', 'local-docs');
  owner.cancel();
  assert.equal(owner.editor(), null);
  assert.equal(owner.discarding.asking(), false);
});

function plugins() {
  const source = { kind: 'profile', revision: 3 };
  const instance = { id: 'greeter' };
  const field = (key, value) => ({
    key,
    label: key,
    description: '',
    kind: 'text',
    present: value !== undefined,
    required: false,
    nullable: false,
    editable: true,
    options: [],
    ...(value === undefined ? {} : { value }),
  });
  const plugin = {
    instance,
    path: ['greeter'],
    package: { id: 'example.greeter', revision: '1' },
    structural: false,
    disabled: false,
    parentDisabled: false,
  };
  const host = {};
  const owner = createPluginSettings(
    host,
    operationsFor(host),
    () => true,
    {},
    { services: { management: [{}] }, operations: { pending: async () => [] } },
    {
      inventory: { source, instances: [plugin] },
      selected: plugin,
      fields: {
        source,
        instance,
        path: [],
        next: null,
        fields: [field('greeting', { kind: 'text', text: 'Hello' }), field('signature')],
      },
      editor: null,
      query: '',
      interfaceQuery: '',
    },
  );
  owner.activate();
  return owner;
}

test('a plugin setting asks before leaving a changed value, not the value it opened with', () => {
  const owner = plugins();
  const exit = exits();
  owner.edit({ request: owner.action(), key: 'signature' });
  owner.leave(exit.to('unset'));
  owner.back();
  owner.edit({ request: owner.action(), key: 'greeting' });
  owner.leave(exit.to('clean'));
  assert.deepEqual(exit.ran, ['unset', 'clean']);

  owner.change({ request: owner.action(), value: { kind: 'text', text: 'Hi' } });
  assert.equal(owner.back(), false);
  owner.discarding.keep();
  assert.deepEqual(owner.editor().value, { kind: 'text', text: 'Hi' });
  owner.leave(exit.to('kept'));
  owner.discarding.keep();
  owner.leave(exit.to('discarded'));
  owner.discarding.discard();
  assert.deepEqual(exit.ran, ['unset', 'clean', 'discarded']);
  assert.equal(owner.editor(), null);
});

test('plugin Cancel drops a changed value without asking', () => {
  const owner = plugins();
  owner.edit({ request: owner.action(), key: 'greeting' });
  owner.change({ request: owner.action(), value: { kind: 'text', text: 'Hi' } });
  owner.cancel();
  assert.equal(owner.editor(), null);
  assert.equal(owner.discarding.asking(), false);
});

async function network() {
  const host = {
    async query() {
      return {
        revision: 1,
        proxy: {
          enabled: false,
          protocol: 'http',
          host: '',
          port: 0,
          username: '',
          authEnabled: false,
          bypassList: [],
          autoBypassDomains: [],
        },
        credential: { configured: false },
      };
    },
  };
  const owner = createNetworkSettings(host, operationsFor(host), () => true);
  owner.activate();
  await settled();
  return owner;
}

test('network settings ask before leaving an unsaved proxy and Escape keeps editing', async () => {
  const owner = await network();
  const exit = exits();
  owner.leave(exit.to('clean'));
  assert.deepEqual(exit.ran, ['clean']);

  owner.edit('host', 'proxy.example.invalid');
  owner.leave(exit.to('kept'));
  assert.equal(owner.discarding.asking(), true);
  assert.equal(owner.back(), false);
  assert.equal(owner.discarding.asking(), false);
  assert.equal(owner.draft().proxy.host, 'proxy.example.invalid');
  owner.leave(exit.to('discarded'));
  owner.discarding.discard();
  assert.deepEqual(exit.ran, ['clean', 'discarded']);
  assert.equal(owner.dirty(), false);
});

test('the network Discard button reloads without asking', async () => {
  const owner = await network();
  owner.edit('host', 'proxy.example.invalid');
  owner.reload(owner.action());
  await settled();
  assert.equal(owner.dirty(), false);
  assert.equal(owner.discarding.asking(), false);
});
