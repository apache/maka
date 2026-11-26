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
  nsh: `export const signal = initial => { let value = initial; const read = () => value; read.set = next => { value = next; }; return read; };
export const cleanup = () => {};
export const batch = fn => fn();`,
  locale: `export const tr = (key, values) => values ? key.replace(/\\{(\\w+)\\}/g, (_, name) => values[name]) : key;`,
};

const hooks = registerHooks({
  resolve(specifier, context, next) {
    let key = specifier;
    if (context.parentURL?.startsWith(appRoot.href) && specifier === './locale') key = 'locale';
    if (key in native) {
      return { url: `data:text/javascript,${encodeURIComponent(native[key])}`, shortCircuit: true };
    }
    if (
      specifier.endsWith('.js') &&
      (specifier.includes('/packages/plugin-sdk/src/') ||
        context.parentURL?.includes('/packages/plugin-sdk/src/'))
    ) {
      return next(`${specifier.slice(0, -3)}.ts`, context);
    }
    if (
      context.parentURL?.startsWith(appRoot.href) &&
      specifier.startsWith('.') &&
      !/\.\w+$/.test(specifier)
    ) {
      return next(`${specifier}.ts`, context);
    }
    if (specifier.includes('/plugins/shared/') && !/\.\w+$/.test(specifier)) {
      return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});

const { createExternalAgentSettings } = await import(
  new URL('externalAgentSettingsState.ts', appRoot)
);
const { watchUsageLimits } = await import(new URL('usageLimitsReading.ts', appRoot));
hooks.deregister();

const flush = () => new Promise((resolve) => setImmediate(resolve));

const deploymentRef = {
  stateDomain: 'domain-1',
  deployment: 'deploy-1',
  revision: 3,
};

const target = {
  source: {
    stateDomain: 'domain-1',
    deployment: 'deploy-1',
    namespace: ['agent'],
  },
  path: ['external'],
};

const runtimes = [
  { id: 'antigravity', name: 'Antigravity', enabled: true, usageLimits: true },
  { id: 'codex', name: 'Codex', enabled: false, usageLimits: false },
];

const readyStatus = (count = 5) => ({
  target,
  configured: true,
  runtimes,
  state: {
    kind: 'ready',
    runtimes: [
      {
        id: 'antigravity',
        name: 'Antigravity',
        installation: { kind: 'available' },
        authentication: { kind: 'authenticated', source: 'agy' },
        models: { kind: 'ready', count },
      },
    ],
  },
});

function createOperations() {
  const pendingKnown = () => true;
  const pending = () => [];
  const busy = () => false;
  const error = Object.assign(() => '', { set() {} });
  return {
    busy,
    pendingKnown,
    pending,
    error,
    report() {},
    run: (fn) => fn(),
    mutate: async () => ({ status: 'committed' }),
  };
}

test('renders runtimes immediately after inspect while status probe runs concurrently', async () => {
  const statusResolvers = [];
  const externalCalls = [];
  const host = {
    async query(endpoint, method, input) {
      if (endpoint === 'management' && method === 'read') {
        return { source: { reference: deploymentRef } };
      }
      if (endpoint === 'agent' && method === 'externalAgents') {
        externalCalls.push(input);
        if (input.inspect) {
          return { target, configured: true, runtimes, state: { kind: 'enabled' } };
        }
        return await new Promise((resolve) => statusResolvers.push(resolve));
      }
      throw new Error(`Unexpected query ${endpoint}.${method}`);
    },
    refresh: async () => {},
  };

  let isActive = true;
  const owner = createExternalAgentSettings(host, createOperations(), () => isActive);
  owner.activate();
  await flush();

  assert.equal(owner.loading(), false);
  assert.equal(owner.checking(), true);
  assert.equal(owner.disabled(), false);
  assert.equal(owner.runtimes().length, 2);
  assert.equal(owner.status('antigravity'), undefined);
  assert.deepEqual(externalCalls, [{ inspect: true }, {}]);

  statusResolvers.shift()(readyStatus(7));
  await flush();

  assert.equal(owner.checking(), false);
  assert.equal(owner.status('antigravity')?.models.kind, 'ready');
  assert.equal(owner.status('antigravity')?.models.count, 7);

  // Deactivate retains cached runtimes and status for SWR, while clearing confirmation state.
  owner.requestEnable({ ...owner.action(), runtime: 'codex' });
  assert.ok(owner.confirmation());
  isActive = false;
  owner.deactivate();

  assert.equal(owner.confirmation(), null);
  assert.equal(owner.runtimes().length, 2);
  assert.equal(owner.status('antigravity')?.models.count, 7);

  // Re-activating keeps showing cached data immediately while passively revalidating.
  isActive = true;
  owner.activate();
  await flush();

  assert.equal(owner.loading(), false);
  assert.equal(owner.runtimes().length, 2);
  assert.equal(owner.status('antigravity')?.models.count, 7);
  assert.deepEqual(externalCalls.at(-1), {});

  statusResolvers.shift()(readyStatus(9));
  await flush();
  assert.equal(owner.status('antigravity')?.models.count, 9);
});

test('explicit reload requests force refresh and invalidates external usage limits', async () => {
  const externalCalls = [];
  let usageCalls = 0;
  const host = {
    async query(endpoint, method, input) {
      if (endpoint === 'management' && method === 'read') {
        return { source: { reference: deploymentRef } };
      }
      if (endpoint === 'agent' && method === 'externalAgents') {
        externalCalls.push(input);
        if (input.inspect) {
          return { target, configured: true, runtimes, state: { kind: 'enabled' } };
        }
        return readyStatus(4);
      }
      if (endpoint === 'agent' && method === 'externalUsageLimits') {
        usageCalls += 1;
        return { kind: 'ready', limits: [] };
      }
      throw new Error(`Unexpected query ${endpoint}.${method}`);
    },
    refresh: async () => {},
  };

  const stopWatch = watchUsageLimits(host, { kind: 'external', runtime: 'antigravity' }, () => {});
  const owner = createExternalAgentSettings(host, createOperations(), () => true);
  owner.activate();
  await flush();
  await flush();

  assert.equal(usageCalls, 1);
  assert.deepEqual(externalCalls, [{ inspect: true }, {}]);

  owner.reload(owner.action());
  await flush();
  await flush();

  assert.deepEqual(externalCalls.at(-1), { refresh: true });
  assert.equal(usageCalls, 2);
  stopWatch();
});
