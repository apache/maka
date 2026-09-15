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
  const invoked = deferred<string>();
  const { bridge, events } = await preloadHarness(async (channel, ...args) => {
    if (channel === 'sessions:observe') { invoked.resolve(args[2] as string); return { kind: 'ready' }; }
    throw new Error('Unexpected channel: ' + channel);
  });
  const order: string[] = [];
  const unsubscribe = bridge.sessions.subscribeEvents(
      JSON.stringify([owner.hostId, 'session-1']),
      (event) => { if (event.type === 'text_delta') order.push(event.text); },
      (phase) => { order.push(phase); },
      (error) => { throw error; },
      (projection) => { order.push(projection?.rootTurn?.turnId ?? 'idle'); },
    );
  const observerId = await invoked.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, [], 'registration acknowledgement must not publish readiness');
  events.emit('sessions:event:session-1', {}, owner, {
    type: 'host_observation_seed',
    observerIds: [observerId],
    execution: { type: 'host_execution', available: true, rootTurn: { turnId: 'turn-1' } },
    events: [{
      type: 'text_delta', id: 'seed-1', turnId: 'turn-1', messageId: 'message-1',
      ts: 1, startOffset: 0, text: 'All output accumulated while away',
    }],
  });
  assert.deepEqual(order, ['turn-1', 'All output accumulated while away', 'ready']);
  unsubscribe();
});

test('execution and observation failures stay separate from Runtime events', async () => {
  const invoked = deferred<void>();
  const { bridge, events } = await preloadHarness(async (channel) => {
    if (channel === 'sessions:observe') { invoked.resolve(); return { kind: 'ready' }; }
    throw new Error('Unexpected channel: ' + channel);
  });
  const sessionId = JSON.stringify([owner.hostId, 'session-1']);
  const projections: Array<Parameters<NonNullable<Parameters<MakaBridge['sessions']['subscribeEvents']>[4]>>[0]> = [];
  const failures: unknown[] = [];
  const unsubscribe = bridge.sessions.subscribeEvents(sessionId,
    () => assert.fail('Observation data must never enter the Runtime event reducer'),
    undefined, (error) => failures.push(error), (value) => projections.push(value));
  await invoked.promise;
  try {
    events.emit('sessions:event:session-1', {}, owner, {
      type: 'host_execution', available: true,
      rootTurn: { sessionId: 'session-1', turnId: 'new-turn', runId: 'run-1', status: 'running' },
    });
    assert.equal(projections.at(-1)?.rootTurn?.sessionId, sessionId);
    events.emit('sessions:event:session-1', {}, owner, { type: 'host_observation_pending' });
    assert.equal(projections.at(-1)?.available, false);
    assert.equal(projections.at(-1)?.rootTurn?.turnId, 'new-turn');
    events.emit('sessions:event:session-1', {}, owner, { type: 'host_observation_error', message: 'connection lost' });
    assert.equal(failures.length, 1);
    events.emit('sessions:event:session-1', {}, owner, {
      type: 'host_execution', available: true, rootTurn: null,
    });
    assert.equal(projections.at(-1)?.rootTurn, null);
    assert.equal(projections.at(-1)?.available, true);
  } finally { unsubscribe(); }
});

test('one ordered stream handles no-content roots, late acknowledgements, new subscribers and recovery', async (t) => {
  const acknowledgement = deferred<{ kind: 'ready' }>();
  const observerIds: string[] = [];
  const { bridge, events } = await preloadHarness(async (channel, ...args) => {
    if (channel === 'sessions:observe') {
      observerIds.push(args[2] as string);
      return acknowledgement.promise;
    }
    throw new Error('Unexpected channel: ' + channel);
  });
  const sessionId = JSON.stringify([owner.hostId, 'session-1']);
  const emit = (message: unknown) => events.emit('sessions:event:session-1', {}, owner, message);
  const execution = (turnId: string) => ({
    type: 'host_execution', available: true, rootTurn: { sessionId: 'session-1', turnId, status: 'running' },
  });
  const subscribe = (order: string[]) => bridge.sessions.subscribeEvents(
    sessionId, () => assert.fail('No Runtime events are needed for a running root'),
    (phase) => order.push(phase), (error) => { throw error; },
    (value) => order.push(`${value?.rootTurn?.turnId}:${value?.available}`),
  );
  const first: string[] = [];
  t.after(subscribe(first));
  await new Promise<void>((resolve) => setImmediate(resolve));
  emit({ type: 'host_observation_seed', observerIds: [observerIds[0]], execution: execution('turn-1'), events: [] });
  assert.deepEqual(first, ['turn-1:true', 'ready']);
  emit(execution('turn-2'));
  acknowledgement.resolve({ kind: 'ready' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(first, ['turn-1:true', 'ready', 'turn-2:true'], 'a late acknowledgement cannot replay older state');

  const second: string[] = [];
  t.after(subscribe(second));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(observerIds.length, 2);
  emit({ type: 'host_observation_seed', observerIds: [observerIds[1]], execution: execution('turn-2'), events: [] });
  assert.deepEqual(second, ['turn-2:true', 'ready']);
  assert.deepEqual(first, ['turn-1:true', 'ready', 'turn-2:true'], 'new subscriber seeding must not replay to existing subscribers');

  emit({ type: 'host_observation_pending' });
  assert.deepEqual(first.slice(-2), ['turn-2:false', 'pending']);
  assert.deepEqual(second.slice(-2), ['turn-2:false', 'pending']);
  emit({ type: 'host_observation_seed', observerIds, execution: execution('turn-3'), events: [] });
  assert.deepEqual(first.slice(-2), ['turn-3:true', 'ready']);
  assert.deepEqual(second.slice(-2), ['turn-3:true', 'ready']);
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
    () => callbacks.push('error'),
  );
  try {
    await started.promise;
    assert.equal(events.listenerCount('sessions:event:session-1'), 1);
    observation.resolve({ kind: 'cancelled' });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(events.listenerCount('sessions:event:session-1'), 0);
    events.emit('sessions:event:session-1', {}, owner, {
      type: 'text_delta', id: 'late-1', turnId: 'turn-1', messageId: 'message-1',
      ts: 1, startOffset: 0, text: 'Late output',
    });
    events.emit('sessions:event:session-1', {}, owner, {
      type: 'host_observation_seed', execution: { type: 'host_execution', available: true, rootTurn: null }, events: [],
    });
    assert.deepEqual(callbacks, []);
  } finally {
    observation.resolve({ kind: 'cancelled' });
    unsubscribe();
  }
});

test('unsubscribing while consuming a seed prevents remaining content and readiness', async () => {
  const invoked = deferred<string>();
  const { bridge, events } = await preloadHarness(async (channel, ...args) => {
    if (channel === 'sessions:observe') { invoked.resolve(args[2] as string); return { kind: 'ready' }; }
    throw new Error('Unexpected channel: ' + channel);
  });
  const text: string[] = [];
  const unsubscribe = bridge.sessions.subscribeEvents(
    JSON.stringify([owner.hostId, 'session-1']),
    (event) => { if (event.type === 'text_delta') text.push(event.text); unsubscribe(); },
    () => assert.fail('A disposed subscription cannot become ready'),
  );
  const observerId = await invoked.promise;
  events.emit('sessions:event:session-1', {}, owner, {
    type: 'host_observation_seed', observerIds: [observerId],
    execution: { type: 'host_execution', available: true, rootTurn: null },
    events: ['first', 'second'].map((value, index) => ({
      type: 'text_delta', id: `seed-${index}`, turnId: 'turn-1', messageId: `message-${index}`,
      ts: 1, startOffset: 0, text: value,
    })),
  });
  assert.deepEqual(text, ['first']);
  assert.equal(events.listenerCount('sessions:event:session-1'), 0);
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
