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

const makeDeploymentRef = (revision) => ({
  stateDomain: 'domain-1',
  deployment: 'deploy-1',
  revision,
});

const target = {
  source: {
    stateDomain: 'domain-1',
    deployment: 'deploy-1',
    namespace: ['agent'],
  },
  path: ['external'],
};

const makeRuntimes = (antigravityEnabled) => [
  { id: 'antigravity', name: 'Antigravity', enabled: antigravityEnabled, usageLimits: true },
  { id: 'codex', name: 'Codex', enabled: false, usageLimits: false },
];

const readyStatus = (antigravityEnabled, count = 5) => ({
  target,
  configured: true,
  runtimes: makeRuntimes(antigravityEnabled),
  state: {
    kind: 'ready',
    runtimes: antigravityEnabled
      ? [
          {
            id: 'antigravity',
            name: 'Antigravity',
            installation: { kind: 'available' },
            authentication: { kind: 'authenticated', source: 'agy' },
            models: { kind: 'ready', count },
          },
        ]
      : [],
  },
});

function createOperations(onMutate) {
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
    mutate: onMutate ?? (async () => ({ status: 'committed' })),
  };
}

test('disabling a runtime during a slow status probe keeps controls visible with committed state', async () => {
  let revision = 3;
  let antigravityEnabled = true;
  const pendingStatuses = [];

  const host = {
    async query(endpoint, method, input) {
      if (endpoint === 'management' && method === 'read') {
        return { source: { reference: makeDeploymentRef(revision) } };
      }
      if (endpoint === 'agent' && method === 'externalAgents') {
        if (input.inspect) {
          return {
            target,
            configured: true,
            runtimes: makeRuntimes(antigravityEnabled),
            state: { kind: 'enabled' },
          };
        }
        return await new Promise((resolve) => pendingStatuses.push(resolve));
      }
      throw new Error(`Unexpected query ${endpoint}.${method}`);
    },
    refresh: async () => {},
  };

  const operations = createOperations(async () => {
    revision = 4;
    antigravityEnabled = false;
    return { status: 'committed' };
  });

  const owner = createExternalAgentSettings(host, operations, () => true);
  owner.activate();
  await flush();

  // First stage is already rendered and interactive while slow status probe is in flight.
  assert.equal(owner.loading(), false);
  assert.equal(owner.checking(), true);
  assert.equal(owner.disabled(), false);
  assert.equal(owner.runtimes().find((r) => r.id === 'antigravity')?.enabled, true);

  // User disables Antigravity before the initial status probe resolves.
  await owner.disable({ ...owner.action(), runtime: 'antigravity' });
  await flush();

  assert.equal(owner.loading(), false);
  assert.equal(owner.checking(), false);
  assert.equal(owner.failure(), null);
  assert.equal(owner.runtimes().length, 2);
  assert.equal(owner.runtimes().find((r) => r.id === 'antigravity')?.enabled, false);

  // Late arrival of the pre-save status probe must not overwrite or hide the committed state.
  pendingStatuses.shift()(readyStatus(true, 7));
  await flush();

  assert.equal(owner.runtimes().length, 2);
  assert.equal(owner.runtimes().find((r) => r.id === 'antigravity')?.enabled, false);
  assert.equal(owner.status('antigravity'), undefined);
});

test('re-inspects instead of splicing status from a newer deployment revision onto an older basis', async () => {
  let revision = 3;
  let antigravityEnabled = true;
  let releaseStatus;

  const host = {
    async query(endpoint, method, input) {
      if (endpoint === 'management' && method === 'read') {
        return { source: { reference: makeDeploymentRef(revision) } };
      }
      if (endpoint === 'agent' && method === 'externalAgents') {
        if (input.inspect) {
          return {
            target,
            configured: true,
            runtimes: makeRuntimes(antigravityEnabled),
            state: { kind: 'enabled' },
          };
        }
        return await new Promise((resolve) => {
          releaseStatus = resolve;
        });
      }
      throw new Error(`Unexpected query ${endpoint}.${method}`);
    },
    refresh: async () => {},
  };

  const owner = createExternalAgentSettings(host, createOperations(), () => true);
  owner.activate();
  await flush();
  assert.equal(owner.runtimes().find((r) => r.id === 'antigravity')?.enabled, true);

  // Another client disables Antigravity while the status probe is running.
  revision = 4;
  antigravityEnabled = false;
  releaseStatus(readyStatus(false, 0));
  await flush();
  await flush();

  assert.equal(owner.checking(), false);
  assert.equal(owner.failure(), null);
  assert.equal(owner.runtimes().find((r) => r.id === 'antigravity')?.enabled, false);
  assert.equal(owner.status('antigravity'), undefined);
});

test('retains cached runtimes across deactivate and propagates force refresh to status and usage limits', async () => {
  const externalCalls = [];
  const usageCalls = [];
  let cachedUsagePercent = 30;
  let liveUsagePercent = 30;

  const host = {
    async query(endpoint, method, input) {
      if (endpoint === 'management' && method === 'read') {
        return { source: { reference: makeDeploymentRef(3) } };
      }
      if (endpoint === 'agent' && method === 'externalAgents') {
        externalCalls.push(input);
        if (input.inspect) {
          return {
            target,
            configured: true,
            runtimes: makeRuntimes(true),
            state: { kind: 'enabled' },
          };
        }
        return readyStatus(true, input.refresh ? 9 : 4);
      }
      if (endpoint === 'agent' && method === 'externalUsageLimits') {
        usageCalls.push(input);
        if (input.refresh) cachedUsagePercent = liveUsagePercent;
        return {
          kind: 'ready',
          limits: [
            {
              kind: 'window',
              period: { kind: 'duration', seconds: 18000 },
              usedPercent: cachedUsagePercent,
            },
          ],
        };
      }
      throw new Error(`Unexpected query ${endpoint}.${method}`);
    },
    refresh: async () => {},
  };

  const observedUsage = [];
  const stopWatch = watchUsageLimits(host, { kind: 'external', runtime: 'antigravity' }, (obs) => {
    observedUsage.push(obs);
  });

  let isActive = true;
  const owner = createExternalAgentSettings(host, createOperations(), () => isActive);
  owner.activate();
  await flush();
  await flush();

  assert.equal(owner.status('antigravity')?.models.count, 4);
  assert.equal(observedUsage.at(-1)?.reading.result.limits[0].usedPercent, 30);

  // Deactivate preserves cached view state for SWR while clearing pending confirmation.
  owner.requestEnable({ ...owner.action(), runtime: 'codex' });
  assert.ok(owner.confirmation());
  isActive = false;
  owner.deactivate();
  assert.equal(owner.confirmation(), null);
  assert.equal(owner.runtimes().length, 2);
  assert.equal(owner.status('antigravity')?.models.count, 4);

  // Re-activate keeps showing cached rows immediately; explicit reload forces both status and usage refresh.
  isActive = true;
  owner.activate();
  await flush();
  await flush();

  liveUsagePercent = 80;
  owner.reload(owner.action());
  await flush();
  await flush();

  assert.deepEqual(externalCalls.at(-1), { refresh: true });
  assert.deepEqual(usageCalls.at(-1), { runtime: 'antigravity', refresh: true });
  assert.equal(owner.status('antigravity')?.models.count, 9);
  assert.equal(observedUsage.at(-1)?.reading.result.limits[0].usedPercent, 80);
  stopWatch();
});
