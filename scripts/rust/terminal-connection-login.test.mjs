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

const boundary = { pending: [], event: null, releases: 0 };
globalThis.__terminalLoginBoundary = boundary;
const appRoot = new URL('../../products/maka/workbench/app/', import.meta.url);
const native = {
  nsh: `export const signal = initial => { let value = initial; const read = () => value; read.set = next => { value = next; }; return read; }; export const cleanup = () => {}; export const Clipboard = { writeText: async () => {} };`,
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
hooks.deregister();

const host = {
  pendingSettings: async () => {
    boundary.releases += 1;
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
  boundary.releases = 0;
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
      assert.equal(login.state(), null);
      assert.equal(operations.busy(), true);
      assert.equal(boundary.releases, 2);
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
  assert.equal(operations.notice(), 'Sign-in saved in the Host credential vault.');
  assert.equal(
    operations.error(),
    'Sign-in was saved. Its original request could not finish its resource cleanup.',
  );
  assert.equal(login.state(), null);
  assert.equal(operations.busy(), false);
});

test('successful login releases its owner and checks the original journal before exactly one discovery', async () => {
  const { login, operations, events } = setup();
  await login.start(action);
  assert.deepEqual(events, ['adopt:connection', 'fetch']);
  assert.equal(operations.notice(), 'Sign-in saved in the Host credential vault.');
  assert.equal(operations.error(), '');
  assert.equal(boundary.releases, 3);
});

test('independent discovery failure reports its cause while retaining the saved login', async () => {
  const { login, operations, events } = setup({
    fetchError: new Error('discovery result unknown; recover the action'),
  });
  await login.start(action);
  assert.deepEqual(events, ['adopt:connection', 'fetch']);
  assert.equal(operations.notice(), 'Sign-in saved in the Host credential vault.');
  assert.equal(operations.error(), 'discovery result unknown; recover the action');
  assert.equal(login.state(), null);
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
