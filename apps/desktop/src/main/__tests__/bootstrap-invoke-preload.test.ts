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
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { deferred } from '@maka/core/test-only/async-primitives';
import { build } from 'esbuild';
import type { MakaBridge } from '../../preload/bridge-contract.js';

// The renderer mounts before the Runtime Host module graph finishes
// registering its IPC handlers. The preload seams keep early calls safe:
//   1. invokeWhenReady parks persistent calls on `app:bootstrapReady` until
//      the boot module's registration pass has run;
//   2. scoped calls additionally wait for the target router's stable gate;
//   3. the default Host's scope is known while it is still connecting, so a
//      default-scope call goes straight to that gate.

const owner = {
  hostId: 'owner-host', epoch: 'owner-epoch', profileId: 'local',
  profileName: 'Local', profileKind: 'local', profileAccess: 'owner', readiness: 'ready',
  isDefault: true,
};

test('invokes wait for the boot registration pass before dispatching', async () => {
  const bootGate = deferred<unknown>();
  const seen: string[] = [];
  const { bridge } = await preloadHarness(async (channel) => {
    if (channel === 'app:bootstrapReady') return bootGate.promise;
    seen.push(channel);
    if (channel === 'app:checkForUpdates') return { status: 'idle' };
    throw new Error('Unexpected channel: ' + channel);
  });

  let settled = false;
  const call = bridge.app.checkForUpdates().then((value) => {
    settled = true;
    return value;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'call must park behind the registration pass');
  assert.deepEqual(seen, []);

  bootGate.resolve(undefined);
  assert.deepEqual(await call, { status: 'idle' });
  assert.deepEqual(seen, ['app:checkForUpdates']);
});

test('the gate falls open when the bootstrap channel itself is absent', async () => {
  const { bridge } = await preloadHarness(async (channel) => {
    if (channel === 'app:bootstrapReady') {
      throw new Error("No handler registered for 'app:bootstrapReady'");
    }
    if (channel === 'app:checkForUpdates') return { status: 'idle' };
    throw new Error('Unexpected channel: ' + channel);
  });
  assert.deepEqual(await bridge.app.checkForUpdates(), { status: 'idle' });
});

test('scoped Runtime Host calls wait for target IPC registration after first paint', async () => {
  const targetGate = deferred<unknown>();
  const seen: string[] = [];
  const { bridge } = await preloadHarness(async (channel) => {
    seen.push(channel);
    if (channel === 'app:bootstrapReady') return;
    if (channel === 'runtime-host:identities') return [owner];
    if (channel === 'runtime-host:awaitReady') return targetGate.promise;
    if (channel === 'projects:getSnapshot') return { projects: [] };
    throw new Error('Unexpected channel: ' + channel);
  });

  const call = bridge.projects.getSnapshot(undefined, { profileId: 'local', hostId: owner.hostId });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ['app:bootstrapReady', 'runtime-host:identities', 'runtime-host:awaitReady']);

  targetGate.resolve(undefined);
  assert.deepEqual(await call, { projects: [] });
  assert.deepEqual(
    await bridge.projects.getSnapshot(undefined, { profileId: 'local', hostId: owner.hostId }),
    { projects: [] },
  );
  assert.deepEqual(seen, [
    'app:bootstrapReady',
    'runtime-host:identities',
    'runtime-host:awaitReady',
    'projects:getSnapshot',
    'runtime-host:identities',
    'projects:getSnapshot',
  ]);
});

test('offline session-local transcript reads bypass Runtime Host readiness', async () => {
  const seen: string[] = [];
  const { bridge } = await preloadHarness(async (channel) => {
    seen.push(channel);
    if (channel === 'app:bootstrapReady') return;
    if (channel === 'runtime-host:identities') return [owner];
    if (channel === 'runtime-host:awaitReady') {
      throw new Error('The cached transcript must not wait for Runtime Host readiness');
    }
    if (channel === 'session-local:transcript') return { batches: [] };
    throw new Error('Unexpected channel: ' + channel);
  });

  assert.deepEqual(
    await bridge.sessionLocal.readTranscript(JSON.stringify([owner.hostId, 'session-1'])),
    { batches: [] },
  );
  assert.deepEqual(seen, [
    'app:bootstrapReady',
    'runtime-host:identities',
    'session-local:transcript',
  ]);
});

test('a connecting default Host hands out its scope and the call waits at the target gate', async () => {
  const targetGate = deferred<unknown>();
  const seen: string[] = [];
  const { bridge } = await preloadHarness(async (channel, scope) => {
    seen.push(channel);
    if (channel === 'app:bootstrapReady') return;
    if (channel === 'runtime-host:identities') return [{ ...owner, readiness: 'connecting' }];
    if (channel === 'runtime-host:awaitReady') {
      assert.deepEqual(
        { ...(scope as object) },
        { hostId: owner.hostId, targetEpoch: owner.epoch },
      );
      return targetGate.promise;
    }
    if (channel === 'projects:getSnapshot') return { projects: [] };
    throw new Error('Unexpected channel: ' + channel);
  });

  const call = bridge.projects.getSnapshot();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ['app:bootstrapReady', 'runtime-host:identities', 'runtime-host:awaitReady']);

  targetGate.resolve(undefined);
  assert.deepEqual(await call, { projects: [] });
  assert.deepEqual(seen.at(-1), 'projects:getSnapshot');
});

test('module-level sends queue behind the gate until listeners exist', async () => {
  const bootGate = deferred<unknown>();
  const { sent } = await preloadHarness(async (channel) => {
    if (channel === 'app:bootstrapReady') return bootGate.promise;
    throw new Error('Unexpected channel: ' + channel);
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [], 'document-ready must not fire before registration');

  bootGate.resolve(undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, ['browser:document-ready']);
});

test('the default Host follows profile pushes and fails fast once unavailable', async () => {
  let readiness = 'unavailable';
  const { bridge, events } = await preloadHarness(async (channel) => {
    if (channel === 'app:bootstrapReady') return;
    if (channel === 'runtime-host:identities') return [{ ...owner, readiness }];
    throw new Error('Unexpected channel: ' + channel);
  });

  await assert.rejects(bridge.runtimeHostProfiles.getDefaultHost(), /identity is unavailable/);

  readiness = 'connecting';
  events.emit('runtime-host-profiles:changed', {}, { ...owner, epoch: 'retry-epoch', readiness });
  // Cross-realm objects fail deepStrictEqual prototype checks; compare fields.
  const host = await bridge.runtimeHostProfiles.getDefaultHost();
  assert.equal(host.profileId, 'local');
  assert.equal(host.hostId, owner.hostId);

  readiness = 'unavailable';
  events.emit('runtime-host-profiles:changed', {}, { ...owner, epoch: 'retry-epoch', readiness });
  await assert.rejects(bridge.runtimeHostProfiles.getDefaultHost(), /identity is unavailable/);
});

async function preloadHarness(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
) {
  const events = new EventEmitter();
  const sent: string[] = [];
  const ipcRenderer = {
    on: events.on.bind(events), off: events.off.bind(events),
    send(channel: string) { sent.push(channel); },
    invoke(channel: string, ...args: unknown[]) {
      return invoke(channel, ...args);
    },
  };
  let bridge: MakaBridge | undefined;
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../../../src/preload/preload.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['electron'],
  });
  const require = createRequire(import.meta.url);
  runInNewContext(bundle.outputFiles[0]!.text, {
    require: (id: string) => id === 'electron' ? {
      ipcRenderer,
      contextBridge: { exposeInMainWorld: (name: string, value: MakaBridge) => {
        if (name === 'maka') bridge = value;
      } },
    } : require(id),
    process: { env: {} }, Buffer, console, setTimeout, clearTimeout, TextEncoder, TextDecoder,
    crypto: globalThis.crypto,
  });
  assert.ok(bridge);
  return { bridge, events, sent };
}
