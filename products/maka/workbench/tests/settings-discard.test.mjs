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
const { createPresetSettings } = await import(new URL('presetSettingsState.ts', appRoot));
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

async function presets() {
  let saved = {
    id: 'role',
    revision: 1,
    name: 'Reviewer',
    description: 'Review code',
    instruction: 'Original',
    model: { connectionId: 'one', modelId: 'model' },
    thinkingLevel: 'high',
    enabled: true,
  };
  const writes = [];
  let outcome = null;
  const host = {
    async query(_, method) {
      if (method === 'presets') return [{ ...saved, availability: { kind: 'available' } }];
      if (method === 'preset')
        return { preset: structuredClone(saved), availability: { kind: 'available' } };
      if (method === 'model') return { kind: 'unavailable', message: 'Disconnected' };
      if (method === 'models')
        return { kind: 'ready', revision: 'catalog', next: null, choices: [] };
      throw Error(method);
    },
    async settingsMutation(endpoint, method, input) {
      writes.push({ endpoint, method, input });
      const result =
        outcome ??
        (input.expectedRevision && input.expectedRevision !== saved.revision
          ? { kind: 'conflict', actual: saved.revision }
          : method === 'deletePreset'
            ? { kind: 'deleted', id: saved.id }
            : {
                kind: 'saved',
                preset: (saved = { ...saved, ...input, revision: saved.revision + 1 }),
              });
      return {
        reply: {
          receipt: {
            kind: 'recorded',
            outcome: { kind: 'returned', result: { kind: 'success', value: result } },
          },
        },
      };
    },
  };
  const operations = operationsFor(host);
  const owner = createPresetSettings(host, operations);
  await owner.open('role');
  return {
    owner,
    operations,
    writes,
    host,
    remote: (patch) => {
      saved = { ...saved, ...patch, revision: saved.revision + 1 };
    },
    fail: (value) => {
      outcome = value;
    },
  };
}

test('preset editor preserves long Markdown, empty instruction and sends only edited fields', async () => {
  const { owner, writes } = await presets();
  const instruction = '# Role\n\n' + 'Keep full instructions.\n'.repeat(5000);
  owner.change('instruction', instruction);
  await owner.save();
  assert.deepEqual(writes[0].input, { id: 'role', expectedRevision: 1, instruction });
  await owner.open('role');
  owner.change('instruction', '');
  await owner.save();
  assert.deepEqual(writes[1].input, { id: 'role', expectedRevision: 2, instruction: '' });
});

test('concurrent conversation updates preserve settings draft and original revision until explicit discard', async () => {
  const { owner, operations, remote, writes } = await presets();
  owner.change('description', 'Local draft');
  remote({ name: 'Renamed in conversation' });
  owner.refresh();
  await owner.save();
  assert.match(operations.error(), /changed elsewhere/);
  assert.equal(owner.editor().values.description, 'Local draft');
  assert.equal(owner.editor().original.revision, 1);
  assert.equal(writes.length, 1);
  owner.back();
  assert.equal(owner.discarding.asking(), true);
  owner.discarding.discard();
  await settled();
  await owner.open('role');
  assert.equal(owner.editor().values.name, 'Renamed in conversation');
});

test('unavailable model can be disabled without resubmitting its model; choosing a model clears effort', async () => {
  const { owner, writes } = await presets();
  owner.change('enabled', false);
  await owner.save();
  assert.deepEqual(writes[0].input, { id: 'role', expectedRevision: 1, enabled: false });
  await owner.open('role');
  owner.choose({
    selection: { kind: 'model', connectionId: 'two', modelId: 'new' },
    thinkingLevels: [],
    sourceName: 'Two',
    label: 'New',
  });
  await owner.save();
  assert.deepEqual(writes[1].input, {
    id: 'role',
    expectedRevision: 2,
    model: { connectionId: 'two', modelId: 'new' },
    thinkingLevel: { kind: 'default' },
  });
});

test('preset draft survives UI reload and rejected original receipt recovery', async () => {
  const { owner, operations, host, writes } = await presets();
  owner.change('instruction', 'Unsaved');
  const restored = createPresetSettings(host, operations, owner.snapshot());
  await assert.rejects(restored.recovered({ kind: 'conflict', actual: 2 }), /changed elsewhere/);
  assert.equal(restored.editor().values.instruction, 'Unsaved');
  restored.back();
  assert.equal(restored.discarding.asking(), true);
  assert.equal(writes.length, 0);
  await restored.recovered({ kind: 'saved', preset: {} });
  assert.equal(restored.editor(), null);
});

test('pending preset mutation blocks repeat save and recovery dispatches its original receipt', async () => {
  const { owner, operations, writes } = await presets();
  owner.change('name', 'Draft');
  operations.pending.set([{ id: 'pending' }]);
  await owner.save();
  assert.equal(writes.length, 0);
  const operation = { id: 'original', endpoint: 'agent', method: 'createPreset' };
  const recovered = [];
  const recovery = createSettingsOperations({
    pendingSettings: async () => [operation],
    recoverSetting: async (id) => {
      recovered.push(id);
      return {
        receipt: {
          kind: 'recorded',
          outcome: {
            kind: 'returned',
            result: { kind: 'success', value: { kind: 'conflict', actual: 2 } },
          },
        },
      };
    },
  });
  await recovery.recover((original, value) => {
    assert.equal(original.id, 'original');
    return owner.recovered(value);
  });
  assert.deepEqual(recovered, ['original']);
  assert.equal(owner.editor().values.name, 'Draft');
  assert.match(recovery.error(), /changed elsewhere/);
});

test('restored preset model details survive text edits and ignore obsolete reads', async () => {
  const { owner, operations, host } = await presets();
  const pending = [];
  const query = host.query;
  host.query = (_, method, input) =>
    method === 'model' ? new Promise((resolve) => pending.push(resolve)) : query(_, method, input);
  const restored = createPresetSettings(host, operations, owner.snapshot());
  const choice = {
    selection: { kind: 'model', connectionId: 'one', modelId: 'model' },
    thinkingLevels: ['high', 'low'],
    sourceName: 'One',
    label: 'Model',
  };
  restored.activate();
  restored.change('instruction', 'Edited while loading');
  pending.shift()({ kind: 'ready', choice });
  await settled();
  assert.deepEqual(restored.selectedModel(), choice);
  assert.equal(restored.editor().values.thinkingLevel, 'high');
  restored.activate();
  restored.deactivate();
  restored.activate();
  const obsolete = pending.shift();
  pending.shift()({ kind: 'ready', choice });
  await settled();
  obsolete({ kind: 'unavailable' });
  await settled();
  assert.deepEqual(restored.selectedModel(), choice);
  restored.activate();
  const replacement = {
    ...choice,
    selection: { ...choice.selection, modelId: 'other' },
  };
  restored.choose(replacement);
  pending.shift()({ kind: 'ready', choice });
  await settled();
  assert.deepEqual(restored.selectedModel(), replacement);
});

test('cancel and discard restore the preset list after UI reload', async () => {
  for (const action of ['cancel', 'discard']) {
    const { owner, operations, host } = await presets();
    owner.change('instruction', 'Restored draft');
    const restored = createPresetSettings(host, operations, owner.snapshot());
    restored.activate();
    await settled();
    if (action === 'cancel') restored.cancel();
    else {
      restored.back();
      restored.discarding.discard();
    }
    await settled();
    assert.equal(restored.editor(), null);
    assert.equal(restored.rows()?.[0].id, 'role');
  }
});

test('refresh models updates selected capabilities without replacing the draft', async () => {
  const { owner, host } = await presets();
  const choice = {
    selection: { kind: 'model', connectionId: 'one', modelId: 'model' },
    thinkingLevels: ['low'],
    sourceName: 'One',
    label: 'Model',
  };
  const query = host.query;
  host.query = async (_, method, input) =>
    method === 'model' ? { kind: 'ready', choice } : query(_, method, input);
  owner.change('instruction', 'Keep draft');
  owner.refreshModels();
  await settled();
  assert.deepEqual(owner.selectedModel(), choice);
  assert.equal(owner.editor().values.instruction, 'Keep draft');
  assert.equal(owner.editor().values.thinkingLevel, 'high');
});

test('obsolete model failures do not overwrite current settings errors', async () => {
  const { owner, host, operations } = await presets();
  const pending = [];
  const query = host.query;
  host.query = (_, method, input) =>
    ['models', 'model'].includes(method)
      ? new Promise((resolve, reject) => pending.push({ resolve, reject }))
      : query(_, method, input);
  owner.searchModels('old');
  owner.searchModels('new');
  pending[1].resolve({ kind: 'ready', revision: 'new', next: null, choices: [] });
  await settled();
  pending[0].reject(new Error('obsolete'));
  await settled();
  assert.equal(operations.error(), '');
  owner.refreshModels();
  owner.deactivate();
  for (const request of pending.slice(2)) request.reject(new Error('inactive'));
  await settled();
  assert.equal(operations.error(), '');
  owner.searchModels('current');
  pending.at(-1).reject(new Error('current failure'));
  await settled();
  assert.notEqual(operations.error(), '');
});
