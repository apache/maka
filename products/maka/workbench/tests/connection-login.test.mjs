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

const boundary = { pending: [], event: null };
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
const { createConnectionLogin } = await import(new URL('connectionLoginState.ts', appRoot));
const { createSettingsOperations } = await import(new URL('settingsOperations.ts', appRoot));
const { createModelSettings } = await import(new URL('settings.ts', appRoot));
const { browser } = await import('nsh');
hooks.deregister();

const host = {
  pendingSettings: async () => {
    return boundary.pending;
  },
  beginSetting: async () => ({ next: async () => boundary.event, cancel() {} }),
};
const action = { editor: 1, input: { expected: { connectionId: 'connection', revision: 1 } } };
function setup({
  cleanupError = null,
  result = { kind: 'saved', connection: { connectionId: 'connection' } },
  fetchError = null,
} = {}) {
  boundary.pending = [];
  boundary.event = {
    kind: 'final',
    cleanupError,
    reply: { receipt: { kind: 'recorded', outcome: { kind: 'returned', value: result } } },
  };
  const operations = createSettingsOperations(host);
  operations.pendingKnown.set(true);
  const events = [];
  let login;
  login = createConnectionLogin(host, operations, {
    accepts: () => true,
    async saved(_, value) {
      events.push(`adopt:${value.connection.connectionId}`);
    },
    async discover() {
      assert.equal(login.state().kind, 'models');
      assert.equal(operations.busy(), true);
      events.push('fetch');
      if (fetchError) throw fetchError;
    },
  });
  return { login, operations, events };
}

test('saved login with cleanup failure preserves the cleanup diagnostic and never starts a failing discovery', async () => {
  const { login, operations, events } = setup({
    cleanupError: 'cleanup failed',
    fetchError: new Error('discovery failed'),
  });
  await login.start(action);
  assert.deepEqual(events, ['adopt:connection']);
  assert.equal(
    operations.error(),
    'Sign-in was saved. Its original request could not finish its resource cleanup.',
  );
  assert.equal(login.state(), null);
  assert.equal(operations.busy(), false);
});

test('a failed login and cleanup report both boundaries without discovery or saved adoption', async () => {
  const { login, operations, events } = setup({
    cleanupError: 'cleanup failed',
    result: { kind: 'failed', reason: 'expired' },
  });
  await login.start(action);
  assert.deepEqual(events, []);
  assert.equal(
    operations.error(),
    'The sign-in code expired. Start a new sign-in to try again. Its original request could not finish its resource cleanup.',
  );
  assert.equal(operations.notice(), '');
});

function connectionEditor({ wrongProvider = false, failDiscovery = false, existing = true } = {}) {
  const provider = {
    entryId: 'maka.codex',
    name: 'chatgpt',
    packageId: 'maka.codex',
    scope: 'profile',
  };
  const receiptProvider = {
    packageId: 'maka.codex',
    entryId: 'maka.codex',
    scope: 'profile',
    name: wrongProvider ? 'other' : 'chatgpt',
  };
  let version = existing ? 1 : 0;
  let configured = false;
  const locator = { scope: 'connection', connectionId: 'connection', kind: 'provider' };
  const status = () => ({
    locator,
    configured,
    credentialId: configured ? 'credential' : null,
    revision: configured ? 1 : null,
    updatedAt: null,
  });
  const detail = () => ({
    kind: 'ready',
    target: {
      connectionId: 'connection',
      revision: version,
      slug: 'chatgpt',
      provider,
      configuration: { baseUrl: 'https://chatgpt.com/backend-api/codex' },
    },
    name: 'ChatGPT Subscription',
    enabled: true,
    editing: { enabledModelIds: [], modelOverrides: null, requestBodyOverlay: null },
  });
  const calls = [];
  const original = detail();
  const api = {
    pendingSettings: async () => [],
    async query(endpoint, method, input) {
      if (method === 'connection')
        return input.revision === version
          ? detail()
          : { kind: 'stale', actual: { connectionId: 'connection', revision: version } };
      if (method === 'providers') return { providers: [], next: null };
      if (method === 'provider')
        return {
          identity: provider,
          descriptor: {
            label: 'ChatGPT Subscription',
            anonymous: false,
            discovery: true,
            configurationDefaults: original.target.configuration,
            authentication: [{ id: 'device', interactive: true, label: 'Sign in with ChatGPT' }],
          },
        };
      if (method === 'credentialStatus') return { kind: 'status', status: status() };
      if (method === 'connections')
        return {
          kind: 'page',
          connections: [],
          revision: version,
          next: null,
          defaultTarget: null,
        };
      throw new Error(`unexpected query ${endpoint}.${method}`);
    },
    async beginSetting(endpoint, method, input) {
      calls.push({ endpoint, method, input });
      assert.equal(input.expected.revision, version);
      version++;
      configured = true;
      return {
        next: async () => ({
          kind: 'final',
          cleanupError: null,
          reply: {
            receipt: {
              kind: 'recorded',
              outcome: {
                kind: 'returned',
                value: {
                  kind: 'saved',
                  connection: {
                    connectionId: 'connection',
                    slug: 'chatgpt',
                    provider: receiptProvider,
                  },
                },
              },
            },
          },
        }),
        cancel() {},
      };
    },
    async settingsMutation(endpoint, method, input) {
      calls.push({ endpoint, method, input });
      if (method === 'create') {
        version++;
        return {
          reply: {
            receipt: {
              kind: 'recorded',
              outcome: {
                kind: 'returned',
                value: {
                  kind: 'committed',
                  connection: { connectionId: 'connection', revision: version },
                },
              },
            },
          },
        };
      }
      assert.equal(input.revision, version, 'model discovery must use the post-login basis');
      return {
        reply: {
          receipt: {
            kind: 'recorded',
            outcome: {
              kind: 'returned',
              value: failDiscovery
                ? { kind: 'failed' }
                : { kind: 'ready', connection: { connectionId: 'connection', revision: version } },
            },
          },
        },
      };
    },
  };
  const operations = createSettingsOperations(api);
  operations.pendingKnown.set(true);
  const owner = createModelSettings(
    api,
    () => {},
    operations,
    () => true,
    undefined,
    {
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
          descriptor: {
            label: 'ChatGPT Subscription',
            anonymous: false,
            discovery: true,
            authentication: [{ id: 'device', interactive: true, label: 'Sign in with ChatGPT' }],
          },
        },
        name: original.name,
        slug: 'chatgpt',
        baseUrl: original.target.configuration.baseUrl,
        enabled: true,
        overlay: 'null',
        apiKey: '',
      },
      model: null,
      credential: status(),
      discovery: 'idle',
      confirmation: null,
      initialModel: null,
    },
  );
  return {
    owner,
    operations,
    calls,
    provider,
    changeElsewhere() {
      version++;
      configured = true;
    },
  };
}

test('connection login accepts reordered provider fields and refreshes both connection and credential bases', async () => {
  const { owner, operations, calls } = connectionEditor();
  await owner.login.start(owner.loginAction('device'));
  assert.equal(operations.error(), '');
  assert.equal(owner.credential().configured, true);
  assert.equal(owner.action().revision, 2);
  assert.equal(owner.loginAction('device').input.expectedCredential.credentialId, 'credential');
  assert.deepEqual(
    calls.map((call) => call.method),
    ['loginCredential', 'discoverModels'],
  );
  await owner.login.start(owner.loginAction('device'));
  assert.equal(operations.error(), '');
  assert.equal(
    owner.action().revision,
    3,
    'another intentional sign-in must not retain the first basis',
  );
});

test('a genuinely different provider receipt remains rejected', async () => {
  const { owner, operations, calls } = connectionEditor({ wrongProvider: true });
  await owner.login.start(owner.loginAction('device'));
  assert.equal(
    operations.error(),
    'The sign-in receipt refers to another connection. Reload before continuing.',
  );
  assert.equal(owner.action().revision, 1);
  assert.deepEqual(
    calls.map((call) => call.method),
    ['loginCredential'],
  );
});

test('discovery failure keeps the completed login and refreshed editor usable', async () => {
  const { owner, operations } = connectionEditor({ failDiscovery: true });
  await owner.login.start(owner.loginAction('device'));
  assert.equal(owner.credential().configured, true);
  assert.equal(owner.action().revision, 2);
  assert.equal(owner.discovery(), 'failed');
  assert.match(operations.error(), /^Signed in, but models could not be loaded\./);
  assert.equal(owner.login.state(), null);
  assert.equal(owner.busy(), false);
});

test('reload advances an externally changed connection instead of querying the stale basis again', async () => {
  const { owner, operations, changeElsewhere } = connectionEditor();
  changeElsewhere();
  await owner.reloadConnection(owner.action());
  assert.equal(operations.error(), '');
  assert.equal(owner.action().revision, 2);
  assert.equal(owner.credential().configured, true);
  assert.equal(owner.dirty(), false);
});

test('save and sign in creates the connection before authorizing it, without an intermediate user action', async () => {
  const { owner, operations, calls, provider } = connectionEditor({ existing: false });
  owner.newConnection();
  await owner.chooseProvider(provider);
  assert.equal(owner.editor().baseline, null);
  await owner.signIn({ ...owner.action(), method: 'device' });
  assert.equal(operations.error(), '');
  assert.equal(owner.credential().configured, true);
  assert.deepEqual(
    calls.map((call) => call.method),
    ['create', 'loginCredential', 'discoverModels'],
  );
});

test('browser opening failure leaves the same device sign-in cancellable and cancellation is not an error', async () => {
  browser.opened = [];
  browser.available = false;
  const ready = Promise.withResolvers();
  const completion = Promise.withResolvers();
  let progress = true;
  const api = {
    pendingSettings: async () => [],
    async beginSetting() {
      return {
        cancel() {
          completion.resolve({
            kind: 'final',
            cleanupError: null,
            reply: {
              receipt: {
                kind: 'recorded',
                outcome: { kind: 'returned', value: { kind: 'failed', reason: 'cancelled' } },
              },
            },
          });
        },
        async next() {
          if (progress) {
            progress = false;
            return {
              kind: 'progress',
              value: { url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH' },
            };
          }
          ready.resolve();
          return completion.promise;
        },
      };
    },
  };
  const operations = createSettingsOperations(api);
  operations.pendingKnown.set(true);
  const login = createConnectionLogin(api, operations, {
    accepts: () => true,
    async saved() {
      assert.fail('cancelled sign-in must not be presented as saved');
    },
    async discover() {
      assert.fail('cancelled sign-in must not fetch models');
    },
  });
  try {
    const running = login.start(action);
    await ready.promise;
    assert.deepEqual(browser.opened, ['https://auth.openai.com/codex/device']);
    assert.equal(login.authorization().browser, 'failed');
    assert.equal(login.authorization().prompt.userCode, 'ABCD-EFGH');
    login.cancel(login.authorization().occurrence);
    await running;
    assert.equal(operations.error(), '');
    assert.equal(operations.notice(), 'Sign-in cancelled.');
    assert.equal(operations.busy(), false);
  } finally {
    browser.available = true;
  }
});

test('back navigation offers a way to keep unsaved connection edits', async () => {
  const { owner } = connectionEditor();
  owner.edit('name', 'A personal name');
  owner.back();
  assert.equal(owner.discardTarget(), 'connection');
  owner.keepEditing();
  assert.equal(owner.editor().name, 'A personal name');
  owner.back();
  owner.discardEdits(owner.action());
  assert.equal(owner.page(), 'connections');
});
