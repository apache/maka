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

const owner = {
  hostId: 'owner-host', targetEpoch: 'owner-epoch', profileId: 'local',
  profileName: 'Local', profileKind: 'local', profileAccess: 'owner', readiness: 'ready',
};

test('observation readiness includes its active seed even when the invoke reply overtakes event IPC', async () => {
  // Deliberately never deliver event IPC: only the invoke response arrives.
  const { bridge } = await preloadHarness(async (channel) => {
    if (channel === 'sessions:observe') return {
      kind: 'ready',
      value: [{
        type: 'text_delta', id: 'seed-1', turnId: 'turn-1', messageId: 'message-1',
        ts: 1, startOffset: 0, text: 'All output accumulated while away',
      }],
    };
    throw new Error('Unexpected channel: ' + channel);
  });
  const order: string[] = [];
  let unsubscribe = () => {};
  await new Promise<void>((resolve, reject) => {
    unsubscribe = bridge.sessions.subscribeEvents(
      JSON.stringify([owner.hostId, 'session-1']),
      (event) => { if (event.type === 'text_delta') order.push(event.text); },
      () => { order.push('ready'); resolve(); },
      undefined,
      reject,
    );
  });
  assert.deepEqual(order, ['All output accumulated while away', 'ready']);
  unsubscribe();
});

test('cancelled Session observation removes preload listeners without publishing readiness or errors', async () => {
  const started = deferred<void>();
  const observation = deferred<{ kind: 'cancelled' }>();
  const { bridge, events } = await preloadHarness(async (channel) => {
    if (channel === 'sessions:observe') {
      started.resolve();
      return observation.promise;
    }
    throw new Error('Unexpected channel: ' + channel);
  });
  const callbacks: string[] = [];
  const unsubscribe = bridge.sessions.subscribeEvents(
    JSON.stringify([owner.hostId, 'session-1']),
    () => callbacks.push('event'),
    () => callbacks.push('ready'),
    () => callbacks.push('seed'),
    () => callbacks.push('error'),
  );
  try {
    await started.promise;
    assert.equal(events.listenerCount('sessions:event:session-1'), 1);
    assert.equal(events.listenerCount('sessions:observation-seed'), 1);
    observation.resolve({ kind: 'cancelled' });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(events.listenerCount('sessions:event:session-1'), 0);
    assert.equal(events.listenerCount('sessions:observation-seed'), 0);
    events.emit('sessions:event:session-1', {}, owner, {
      type: 'text_delta', id: 'late-1', turnId: 'turn-1', messageId: 'message-1',
      ts: 1, startOffset: 0, text: 'Late output',
    });
    events.emit('sessions:observation-seed', {}, owner, { sessionId: 'session-1', phase: 'ready' });
    assert.deepEqual(callbacks, []);
  } finally {
    observation.resolve({ kind: 'cancelled' });
    unsubscribe();
  }
});

test('cancelled transcript open rejects and removes its preload listener', async () => {
  const started = deferred<string>();
  const transcript = deferred<{ kind: 'cancelled' }>();
  const { bridge, events } = await preloadHarness(async (channel, ...args) => {
    if (channel === 'session-local:transcript') return null;
    if (channel === 'sessions:transcript:open') {
      started.resolve(`sessions:transcript:${args[2]}`);
      return transcript.promise;
    }
    if (channel === 'sessions:transcript:close') return;
    throw new Error('Unexpected channel: ' + channel);
  });
  let cancel = () => {};
  const opening = bridge.transcripts.open(
    JSON.stringify([owner.hostId, 'session-1']),
    () => assert.fail('A cancelled transcript must not deliver a batch'),
    (requestCancellation) => { cancel = requestCancellation; },
  );
  try {
    const channel = await started.promise;
    assert.equal(events.listenerCount(channel), 1);
    const rejection = assert.rejects(opening, /Desktop transcript open was cancelled/);
    transcript.resolve({ kind: 'cancelled' });
    await rejection;
    assert.equal(events.listenerCount(channel), 0);
  } finally {
    transcript.resolve({ kind: 'cancelled' });
    cancel();
    await opening.catch(() => undefined);
  }
});

async function preloadHarness(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>) {
  const events = new EventEmitter();
  const ipcRenderer = {
    on: events.on.bind(events), off: events.off.bind(events), send() {},
    async invoke(channel: string, ...args: unknown[]) {
      if (channel === 'runtime-host:activeIdentity') return owner;
      if (channel === 'runtime-host:identities') return [owner];
      if (channel === 'sessions:unobserve') return;
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
  return { bridge, events };
}
