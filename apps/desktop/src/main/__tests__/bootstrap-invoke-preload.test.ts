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
// registering its IPC handlers. Two preload seams keep early calls safe:
//   1. invokeWhenReady parks every invoke on `app:bootstrapReady` until the
//      boot module's registration pass has run;
//   2. activeRuntimeHostRef parks a scoped call while the default Host still
//      reports connecting, releasing it on the next profiles:changed event.

const owner = {
  hostId: 'owner-host', targetEpoch: 'owner-epoch', profileId: 'local',
  profileName: 'Local', profileKind: 'local', profileAccess: 'owner', readiness: 'ready',
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

test('a still-starting default Host keeps scoped reads pending until it settles', async () => {
  let readiness: string = 'connecting';
  const { bridge, events } = await preloadHarness(async (channel) => {
    if (channel === 'app:bootstrapReady') return;
    if (channel === 'runtime-host:activeIdentity') {
      throw new Error('Desktop Runtime Host identity is unavailable');
    }
    if (channel === 'runtime-host-profiles:getSnapshot') {
      return {
        entries: [{ profileId: 'local', isDefault: true, readiness }],
        defaultProfileId: 'local',
      };
    }
    throw new Error('Unexpected channel: ' + channel);
  });

  let outcome: { resolved?: unknown; error?: unknown } = {};
  const call = bridge.runtimeHostProfiles
    .getDefaultHost()
    .then((value) => { outcome.resolved = value; }, (error) => { outcome.error = error; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(outcome, {}, 'connecting Host must keep the read pending');

  events.emit('runtime-host-profiles:changed', {}, {
    epoch: 'e1', profileId: 'local', profileName: 'Local', profileKind: 'local',
    profileAccess: 'owner', readiness: 'ready', hostId: 'owner-host', isDefault: true,
  });
  await call;
  // Cross-realm objects fail deepStrictEqual prototype checks; compare fields.
  const resolved = outcome.resolved as { profileId: string; hostId: string };
  assert.equal(resolved.profileId, 'local');
  assert.equal(resolved.hostId, 'owner-host');
});

test('a profiles:changed push landing inside the readiness probe still wakes the read', async () => {
  let identityCalls = 0;
  const snapshotGate = deferred<unknown>();
  let probeReached!: () => void;
  const probeInFlight = new Promise<void>((resolve) => { probeReached = resolve; });
  const { bridge, events } = await preloadHarness(async (channel) => {
    if (channel === 'app:bootstrapReady') return;
    if (channel === 'runtime-host:activeIdentity') {
      identityCalls += 1;
      if (identityCalls === 1) {
        throw new Error('Desktop Runtime Host identity is unavailable');
      }
      return { ...owner };
    }
    if (channel === 'runtime-host-profiles:getSnapshot') {
      probeReached();
      await snapshotGate.promise;
      return {
        entries: [{ profileId: 'local', isDefault: true, readiness: 'connecting' }],
        defaultProfileId: 'local',
      };
    }
    throw new Error('Unexpected channel: ' + channel);
  });

  let outcome: { resolved?: unknown; error?: unknown } = {};
  const call = bridge.runtimeHostProfiles
    .getDefaultHost()
    .then((value) => { outcome.resolved = value; }, (error) => { outcome.error = error; });
  // Hold the readiness probe open and land the transition push inside it. A
  // waiter registered only after the probe resolves would miss this event
  // and park the read forever.
  await probeInFlight;
  events.emit('runtime-host-profiles:changed', {}, {
    epoch: 'e1', profileId: 'local', profileName: 'Local', profileKind: 'local',
    profileAccess: 'owner', readiness: 'ready', hostId: 'owner-host', isDefault: true,
  });
  snapshotGate.resolve(undefined);
  await call;
  // Cross-realm objects fail deepStrictEqual prototype checks; compare fields.
  const resolved = outcome.resolved as { profileId: string; hostId: string };
  assert.equal(resolved.profileId, 'local');
  assert.equal(resolved.hostId, 'owner-host');
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

test('a settled-unavailable default Host releases the pending read as an error', async () => {
  let readiness: string = 'connecting';
  const { bridge, events } = await preloadHarness(async (channel) => {
    if (channel === 'app:bootstrapReady') return;
    if (channel === 'runtime-host:activeIdentity') {
      throw new Error('Desktop Runtime Host identity is unavailable');
    }
    if (channel === 'runtime-host-profiles:getSnapshot') {
      return {
        entries: [{ profileId: 'local', isDefault: true, readiness }],
        defaultProfileId: 'local',
      };
    }
    throw new Error('Unexpected channel: ' + channel);
  });

  let outcome: { resolved?: unknown; error?: unknown } = {};
  const call = bridge.runtimeHostProfiles
    .getDefaultHost()
    .then((value) => { outcome.resolved = value; }, (error) => { outcome.error = error; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(outcome, {}, 'connecting Host must keep the read pending');

  readiness = 'unavailable';
  events.emit('runtime-host-profiles:changed', {}, {
    epoch: 'e1', profileId: 'local', profileName: 'Local', profileKind: 'local',
    profileAccess: 'owner', readiness: 'unavailable', isDefault: true,
  });
  await call;
  assert.match(
    String(outcome.error),
    /identity is unavailable/,
    'settled Host must surface the identity error instead of hanging',
  );
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
