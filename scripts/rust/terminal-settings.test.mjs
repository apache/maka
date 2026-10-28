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

const cell = (initial) => {
  let value = initial;
  const read = () => value;
  read.set = (next) => {
    value = next;
  };
  return read;
};
const fixtures = { query: null, login: null };
globalThis.__terminalSettingsFixtures = fixtures;
const modules = {
  nsh: 'export const signal = (initial) => { let value = initial; const read = () => value; read.set = next => { value = next; }; return read; }; export const computed = f => f; export const cleanup = () => {};',
  './host':
    'export const host = { query: (...args) => globalThis.__terminalSettingsFixtures.query(...args) };',
  './text':
    'export const message = (key, values) => values ? key.replace(/\\{(\\w+)\\}/g, (_, key) => values[key]) : key; export class UiError extends Error { constructor(key, values) { super(message(key, values)); } }',
  './settingsOperations':
    'export const credentialBasis = status => status?.configured ? { locator: status.locator, credentialId: status.credentialId, revision: status.revision } : null; export const settingsRejection = result => new Error(result.kind);',
  './connectionLoginState.ts':
    'export const createConnectionLogin = (_, owner) => { globalThis.__terminalSettingsFixtures.login = owner; return {}; };',
};
const settingsUrl = new URL('../../products/maka/workbench/app/settings.ts', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === settingsUrl && specifier in modules)
      return {
        url: `data:text/javascript,${encodeURIComponent(modules[specifier])}`,
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
const { createModelSettings } = await import(settingsUrl);
hooks.deregister();

function setup({ apiKey = '', original = null, fetchResult = 'ready', beforeFetch } = {}) {
  let active = false;
  const calls = [];
  let detail = original;
  const provider = {
    identity: { name: 'provider' },
    descriptor: {
      anonymous: true,
      discovery: true,
      configurationDefaults: { baseUrl: 'https://model.test' },
      authentication: [],
    },
  };
  const fresh = (revision) => ({
    kind: 'ready',
    target: {
      connectionId: 'connection',
      revision,
      slug: 'provider',
      provider: provider.identity,
      configuration: { baseUrl: 'https://model.test' },
    },
    name: 'Provider',
    enabled: true,
    editing: { enabledModelIds: [], modelOverrides: null, requestBodyOverlay: null },
  });
  const state = {
    busy: cell(false),
    error: cell(''),
    notice: cell(''),
    pending: cell([]),
    pendingKnown: cell(true),
    report(reason) {
      state.error.set(reason.message);
    },
    async run(operation) {
      if (state.busy()) return;
      state.busy.set(true);
      state.error.set('');
      state.notice.set('');
      try {
        await operation();
      } catch (reason) {
        state.report(reason);
      } finally {
        state.busy.set(false);
      }
    },
    async mutate(endpoint, method, input, secret) {
      calls.push({ endpoint, method, input, secret });
      if (method === 'create' || method === 'update') {
        detail = fresh((detail?.target.revision ?? 0) + 1);
        if (input.changes?.modelOverrides)
          detail.editing.modelOverrides = input.changes.modelOverrides;
        return { kind: 'committed', connection: detail.target };
      }
      if (method === 'saveCredential') {
        detail = { ...detail, target: { ...detail.target, revision: detail.target.revision + 1 } };
        return { kind: 'saved' };
      }
      if (method === 'discoverModels') {
        if (beforeFetch) await beforeFetch();
        assert.equal(state.busy(), true);
        assert.equal(input.revision, detail.target.revision);
        if (fetchResult instanceof Error) throw fetchResult;
        if (fetchResult !== 'ready') return { kind: fetchResult };
        detail = {
          ...detail,
          target: { ...detail.target, revision: detail.target.revision + 1 },
          editing: { ...detail.editing, enabledModelIds: ['model'] },
        };
        return { kind: 'ready', connection: detail.target };
      }
      throw new Error(`Unexpected mutation ${method}`);
    },
  };
  fixtures.query = async (endpoint, method, input) => {
    if (method === 'connection') {
      if (input.revision !== detail.target.revision)
        return { kind: 'stale', actual: detail.target };
      return detail;
    }
    if (method === 'credentialStatus')
      return { kind: 'status', status: { configured: true, credentialId: 'key', revision: 1 } };
    if (method === 'connections')
      return { kind: 'ready', revision: 1, connections: [], next: null, defaultTarget: null };
    if (method === 'resolveModel') return { kind: 'missing' };
    throw new Error(`Unexpected query ${endpoint}.${method}`);
  };
  const owner = createModelSettings(
    () => {},
    state,
    () => active,
  );
  active = true;
  owner.revision.set(1);
  owner.editor.set({
    instance: 1,
    baseline: original,
    provider,
    name: 'Provider',
    slug: 'provider',
    baseUrl: 'https://model.test',
    enabled: true,
    overlay: 'null',
    apiKey,
  });
  owner.page.set('connection');
  owner.credential.set({ configured: true, credentialId: 'key', revision: 1 });
  return { owner, state, calls, fresh };
}

test('saving a new connection and credential fetches once using the committed credential revision', async () => {
  const { owner, state, calls } = setup({ apiKey: 'secret' });
  await owner.saveConnection(owner.action());
  assert.deepEqual(
    calls.map(({ method }) => method),
    ['create', 'saveCredential', 'discoverModels'],
  );
  assert.equal(owner.editor().baseline.target.revision, 3);
  assert.deepEqual(owner.editor().baseline.editing.enabledModelIds, ['model']);
  assert.equal(owner.editor().apiKey, '');
  assert.equal(owner.discovery(), 'ready');
  assert.equal(state.error(), '');
  await owner.saveConnection(owner.action());
  assert.deepEqual(
    calls.map(({ method }) => method),
    ['create', 'saveCredential', 'discoverModels'],
  );
});

test('automatic discovery shows loading and blocks a concurrent manual fetch', async () => {
  let started;
  let release;
  const waiting = new Promise((resolve) => {
    started = resolve;
  });
  const response = new Promise((resolve) => {
    release = resolve;
  });
  const { owner, calls } = setup({
    beforeFetch() {
      started();
      return response;
    },
  });
  const saving = owner.saveConnection(owner.action());
  await waiting;
  assert.equal(owner.discovery(), 'fetching');
  assert.equal(owner.busy(), true);
  await owner.discover(owner.action());
  release();
  await saving;
  assert.deepEqual(
    calls.map(({ method }) => method),
    ['create', 'discoverModels'],
  );
  assert.equal(owner.discovery(), 'ready');
  assert.equal(owner.busy(), false);
});

test('fetch failure retains the saved connection and exposes manual retry without another create', async () => {
  const { owner, state, calls } = setup({ fetchResult: new Error('Network offline') });
  await owner.saveConnection(owner.action());
  assert.equal(owner.editor().baseline.target.revision, 1);
  assert.equal(owner.dirty(), false);
  assert.equal(owner.discovery(), 'failed');
  assert.equal(state.notice(), 'Connection saved.');
  assert.equal(state.error(), 'Network offline');
  await owner.discover(owner.action());
  assert.deepEqual(
    calls.map(({ method }) => method),
    ['create', 'discoverModels', 'discoverModels'],
  );
  assert.equal(owner.editor().baseline.target.connectionId, 'connection');
});

test('all model limits and tools save together, blank limits restore defaults and unrelated overrides survive', async () => {
  const fixture = setup();
  const original = fixture.fresh(7);
  original.editing = {
    enabledModelIds: ['model'],
    requestBodyOverlay: null,
    modelOverrides: {
      model: { contextWindow: 100000, inputLimit: 90000, vision: true, applyPatch: true },
    },
  };
  fixture.owner.editor.set({ ...fixture.owner.editor(), baseline: original });
  fixture.owner.editModel({ ...fixture.owner.action(), id: 'model' });
  fixture.owner.changeModel({
    limits: {
      contextWindow: '200000',
      inputLimit: '',
      maxOutputTokens: '4000',
      compactionThreshold: '150000',
    },
    codeMode: false,
    applyPatch: false,
  });
  await fixture.owner.saveModel(fixture.owner.modelAction());
  assert.deepEqual(fixture.calls[0].input.expected, { connectionId: 'connection', revision: 7 });
  assert.deepEqual(fixture.calls[0].input.changes.modelOverrides, {
    model: {
      contextWindow: 200000,
      maxOutputTokens: 4000,
      compactionThreshold: 150000,
      vision: true,
      codeMode: false,
      applyPatch: false,
    },
  });
  assert.equal(fixture.state.notice(), 'Model saved.');
  assert.equal(fixture.owner.page(), 'models');
});

test('invalid token input remains editable and cannot write a model mutation', async () => {
  const { owner, state, calls, fresh } = setup();
  owner.editor.set({ ...owner.editor(), baseline: fresh(1) });
  owner.editModel({ ...owner.action(), id: null });
  owner.changeModel({
    id: 'new-model',
    limits: { contextWindow: '1.5', inputLimit: '', maxOutputTokens: '', compactionThreshold: '' },
  });
  await owner.saveModel(owner.modelAction());
  assert.equal(state.error(), 'Context window (tokens) must be a positive whole number of tokens.');
  assert.equal(calls.length, 0);
  assert.equal(owner.model().limits.contextWindow, '1.5');
  assert.equal(owner.page(), 'model');
});
