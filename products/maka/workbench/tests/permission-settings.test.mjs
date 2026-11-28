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

const modules = {
  nsh: 'export function signal(v){return Object.assign(()=>v,{set(n){v=n;}})}',
  './locale': 'export const tr=(key,args)=>args?key.replace("{permission}",args.permission):key',
};
const hook = registerHooks({
  resolve(specifier, context, next) {
    return Object.hasOwn(modules, specifier)
      ? {
          url: 'data:text/javascript,' + encodeURIComponent(modules[specifier]),
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});
const { createPermissionSettings, statusLabel } = await import('../app/permissionSettingsState.ts');
hook.deregister();
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(local = true) {
  const calls = [];
  const client = {
    desktopPermissionSettings: async () => {
      calls.push('desktop');
      return { supported: true, microphone: 'denied', accessibility: false };
    },
    hostPermissionSettings: async () => {
      calls.push('host');
      return { local, status: { supported: true, grants: [] } };
    },
    performPermissionSetting: async (...args) => {
      calls.push(args);
    },
  };
  return { owner: createPermissionSettings(client), calls, client };
}
test('opening and foreground refresh only read status, including after a request', async () => {
  const { owner, calls } = setup();
  owner.activate();
  await flush();
  await owner.refresh();
  assert.deepEqual(calls, ['desktop', 'host', 'desktop', 'host']);
  await owner.act('desktop', 'request', 'accessibility');
  assert.equal(owner.desktop().accessibility, false);
  assert.deepEqual(calls.slice(-3), [['desktop', 'request', 'accessibility'], 'desktop', 'host']);
  await owner.act('desktop', 'open', 'microphone');
  assert.equal(owner.desktop().microphone, 'denied');
  assert.deepEqual(calls.slice(-3), [['desktop', 'open', 'microphone'], 'desktop', 'host']);
  owner.deactivate();
  await owner.refresh();
  assert.equal(owner.desktop(), null);
});
test('remote Host offers no local actions', async () => {
  const { owner, calls } = setup(false);
  owner.activate();
  await flush();
  for (const action of ['open', 'reveal', 'request'])
    await owner.act('host', action, 'accessibility');
  assert.deepEqual(calls, ['desktop', 'host']);
});
test('file rows are settings-only and failed links name the manual path', async () => {
  assert.deepEqual(
    ['unknown', 'denied', 'granted', 'restricted', 'notDetermined', true, false].map(statusLabel),
    [
      'Unknown',
      'Denied',
      'Allowed',
      'Restricted',
      'Not requested',
      'Allowed',
      'permissionSetup.notEnabled',
    ],
  );
  const { owner, client } = setup();
  client.performPermissionSetting = async () => {
    throw Error('open failed');
  };
  owner.activate();
  await flush();
  await owner.act('desktop', 'open', 'disk');
  assert.match(owner.actionError(), /Privacy & Security → Full disk access/);
});
test('late observations cannot restore an old Host after leaving', async () => {
  const { owner, client } = setup();
  let resolve;
  client.hostPermissionSettings = () =>
    new Promise((done) => {
      resolve = done;
    });
  owner.activate();
  owner.deactivate();
  resolve({ local: true });
  await flush();
  assert.equal(owner.host(), null);
});

test('only the selected grant is polled until effective or dismissed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { owner, calls, client } = setup();
  let result = { effective: false, pendingHost: false };
  client.observePermissionSetting = async (subject, grant) => {
    calls.push(['observe', subject, grant]);
    return result;
  };
  client.desktopPermissionSettings = async () => ({
    supported: true,
    accessibility: false,
    canRestart: true,
  });
  owner.activate();
  await flush();
  t.mock.timers.tick(2500);
  assert.equal(owner.restartHint(), null);
  await owner.act('desktop', 'open', 'accessibility');
  calls.length = 0;
  t.mock.timers.tick(1250);
  await flush();
  assert.deepEqual(calls, [['observe', 'desktop', 'accessibility']]);
  assert.equal(owner.restartHint(), 'accessibility');
  await owner.act('desktop', 'restart', 'accessibility');
  assert.ok(calls.some((c) => Array.isArray(c) && c[1] === 'restart'));
  result = { effective: true, pendingHost: false };
  t.mock.timers.tick(1250);
  await flush();
  assert.equal(owner.restartHint(), null);
  calls.length = 0;
  t.mock.timers.tick(5000);
  assert.deepEqual(calls, []);
  await owner.act('desktop', 'open', 'screen_recording');
  owner.deactivate();
  calls.length = 0;
  t.mock.timers.tick(5000);
  await flush();
  assert.deepEqual(calls, []);
});

test('microphone and remote settings never start a local guide or offer a restart', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { owner, client, calls } = setup(false);
  client.observePermissionSetting = async () => assert.fail('unexpected preflight');
  owner.activate();
  await flush();
  await owner.act('desktop', 'open', 'microphone');
  calls.length = 0;
  await owner.act('host', 'open', 'screen_recording');
  await owner.act('host', 'restart', 'screen_recording');
  await owner.act('desktop', 'restart', 'microphone');
  t.mock.timers.tick(5000);
  await flush();
  assert.deepEqual(calls, []);
  assert.equal(owner.restartHint(), null);
  owner.deactivate();
});

test('an already granted Settings guide survives foreground refresh and observation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { owner, client, calls } = setup();
  client.desktopPermissionSettings = async () => ({ supported: true, accessibility: true });
  client.observePermissionSetting = async () => ({ effective: true, pendingHost: false });
  owner.activate();
  await flush();
  await owner.act('desktop', 'open', 'accessibility');
  await owner.refresh();
  t.mock.timers.tick(1250);
  await flush();
  assert.deepEqual(calls.filter(Array.isArray), [['desktop', 'open', 'accessibility']]);
  owner.deactivate();
});
test('a still ineffective request opens settings once using the current lease', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { owner, client, calls } = setup();
  client.observePermissionSetting = async () => ({ effective: false, pendingHost: false });
  owner.activate();
  await flush();
  await owner.act('desktop', 'request', 'accessibility');
  t.mock.timers.tick(1750);
  await flush();
  t.mock.timers.tick(1250);
  await flush();
  assert.deepEqual(calls.filter(Array.isArray), [
    ['desktop', 'request', 'accessibility'],
    ['desktop', 'guide', 'accessibility'],
  ]);
  owner.deactivate();
});

test('Host pending propagation keeps the guide until the resident Host observes the grant', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { owner, client, calls } = setup();
  let effective = false;
  client.hostPermissionSettings = async () => ({
    local: true,
    status: { grants: [{ grant: 'accessibility', effective }] },
  });
  client.observePermissionSetting = async () => ({ effective, pendingHost: !effective });
  owner.activate();
  await flush();
  await owner.act('host', 'open', 'accessibility');
  t.mock.timers.tick(1250);
  await flush();
  assert.deepEqual(calls.filter(Array.isArray), [['host', 'open', 'accessibility']]);
  effective = true;
  t.mock.timers.tick(1250);
  await flush();
  assert.deepEqual(calls.at(-1), ['host', 'end', 'accessibility']);
  owner.deactivate();
});

test('unsupported desktops never open macOS file permission settings', async () => {
  const { owner, client, calls } = setup();
  client.desktopPermissionSettings = async () => ({ supported: false });
  owner.activate();
  await flush();
  await owner.act('desktop', 'open', 'files');
  await owner.act('desktop', 'open', 'disk');
  assert.deepEqual(calls.filter(Array.isArray), []);
  owner.deactivate();
});
