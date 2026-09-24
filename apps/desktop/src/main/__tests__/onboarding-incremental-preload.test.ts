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
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import type { MakaBridge } from '../../preload/bridge-contract.js';
import type { OnboardingSnapshot } from '../onboarding-service.js';
import { desktopSessionKey } from '../../shared/runtime-host-identity.js';
import { createOnboardingSnapshotPoller } from '../../renderer/use-onboarding-snapshot.js';

const owners = [
  { hostId: 'local-host', targetEpoch: 'local-epoch', profileId: 'local', profileName: 'Local', profileKind: 'local', profileAccess: 'owner', readiness: 'ready' },
  { hostId: 'remote-host', targetEpoch: 'remote-epoch', profileId: 'remote', profileName: 'Remote', profileKind: 'remote', profileAccess: 'owner', readiness: 'ready' },
] as const;
const guest = { hostId: 'guest-host', targetEpoch: 'guest-epoch', profileId: 'guest', profileName: 'Guest', profileKind: 'remote', profileAccess: 'session_guest', readiness: 'ready' };

function hostSnapshot(hostId: string): OnboardingSnapshot {
  const id = hostId === 'local-host' ? 'local-task' : 'remote-task';
  return {
    state: { kind: 'needs_connection' }, milestones: [],
    sessions: [{
      id, revision: 1, activityAt: 1, name: id,
      isFlagged: false, isArchived: false, labels: [], hasUnread: false,
      status: 'active', backend: 'plugin-executor', llmConnectionSlug: '',
      model: '', connectionLocked: false, permissionMode: 'ask',
    } as OnboardingSnapshot['sessions'][number]],
    connections: [], defaultSlug: null, chatModelChoices: [],
    sessionSendOutcomes: { [id]: { kind: 'ready' } },
  };
}

async function harness() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  let failRemote = false;
  let heldRemote: Promise<OnboardingSnapshot> | null = null;
  const calls: Array<{ channel: string; hostId?: string }> = [];
  const ipcRenderer = {
    on(channel: string, listener: (...args: unknown[]) => void) {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
    },
    off(channel: string, listener: (...args: unknown[]) => void) {
      listeners.get(channel)?.delete(listener);
    },
    send() {},
    async invoke(channel: string, scope?: { hostId?: string }, sessionId?: string) {
      calls.push({ channel, hostId: scope?.hostId });
      switch (channel) {
        case 'runtime-host:activeIdentity': return owners[0];
        case 'runtime-host:identities': return [...owners, guest];
        case 'runtime-host:awaitReady': return { ready: true };
        case 'onboarding:getSnapshot':
          if (scope?.hostId === 'remote-host' && failRemote) throw new Error('remote offline');
          if (scope?.hostId === 'remote-host' && heldRemote) {
            const held = heldRemote;
            heldRemote = null;
            return held;
          }
          return hostSnapshot(scope!.hostId!);
        case 'onboarding:getSessionUpdate':
          assert.equal(sessionId, scope?.hostId === 'remote-host' ? 'remote-task' : 'local-task');
          return {
            kind: 'delta', outcome: { kind: 'blocked', reason: 'fake_backend', connectionLocked: false },
            state: { kind: 'needs_connection' }, milestones: [],
          };
        case 'session-local:catalog': return owners.map((owner) => ({
          scope: owner, sessions: hostSnapshot(owner.hostId).sessions, authoritative: true,
        }));
        case 'session-collaboration:mount:list': return [];
        default: throw new Error('Unexpected channel: ' + channel);
      }
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
  return {
    bridge,
    calls,
    failRemote: () => { failRemote = true; },
    holdRemote: (read: Promise<OnboardingSnapshot>) => { heldRemote = read; },
    emitRemoteSessionChange: () => {
      for (const listener of listeners.get('sessions:changed') ?? []) {
        listener({}, owners[1], { reason: 'updated', sessionId: 'remote-task', ts: 1 });
      }
    },
    replaceRemote: () => {
      for (const listener of listeners.get('runtime-host-profiles:changed') ?? []) {
        listener({}, {
          profileId: 'remote', profileName: 'Remote', profileKind: 'remote',
          profileAccess: 'owner', hostId: 'remote-host', epoch: 'replacement-epoch',
          readiness: 'ready', isDefault: false,
        });
      }
    },
  };
}

test('a remote Owner delta is scoped and a later failed full read keeps its last projection', async () => {
  const fixture = await harness();
  const localKey = desktopSessionKey({ hostId: 'local-host', sessionId: 'local-task' });
  const remoteKey = desktopSessionKey({ hostId: 'remote-host', sessionId: 'remote-task' });
  const first = await fixture.bridge.onboarding.getSnapshot();
  assert.deepEqual(first.sessionSendOutcomes[localKey], { kind: 'ready' });
  assert.deepEqual(first.sessionSendOutcomes[remoteKey], { kind: 'ready' });
  fixture.calls.length = 0;
  const update = await fixture.bridge.onboarding.getSessionUpdate(remoteKey);
  assert.equal(update?.kind, 'delta');
  if (update?.kind !== 'delta') return;
  assert.equal(update.defaultHost, undefined);
  assert.equal(update.sessionId, remoteKey);
  assert.deepEqual(fixture.calls.filter(({ channel }) => channel === 'onboarding:getSessionUpdate'), [
    { channel: 'onboarding:getSessionUpdate', hostId: 'remote-host' },
  ]);
  assert.equal(fixture.calls.some(({ channel }) => channel === 'onboarding:getSnapshot'), false);
  fixture.failRemote();
  const afterFailure = await fixture.bridge.onboarding.getSnapshot();
  assert.deepEqual(afterFailure.sessionSendOutcomes[remoteKey], update.outcome);
  assert.deepEqual(afterFailure.sessionSendOutcomes[localKey], { kind: 'ready' });
  fixture.replaceRemote();
  assert.equal((await fixture.bridge.onboarding.getSessionUpdate(remoteKey))?.kind, 'resync');
  const guestKey = desktopSessionKey({ hostId: 'guest-host', sessionId: 'guest-task' });
  assert.equal(await fixture.bridge.onboarding.getSessionUpdate(guestKey), null);
});

test('a Renderer Session event crosses preload to only its owning Host update', async () => {
  const fixture = await harness();
  let receiveUpdate!: () => void;
  const observed = new Promise<void>((resolve) => { receiveUpdate = resolve; });
  const poller = createOnboardingSnapshotPoller({
    getSnapshot: () => fixture.bridge.onboarding.getSnapshot(),
    getSessionUpdate: (id) => fixture.bridge.onboarding.getSessionUpdate(id),
  }, {
    onSnapshot: () => {},
    onSessionUpdate: (update) => {
      assert.equal(update.sessionId, desktopSessionKey({ hostId: 'remote-host', sessionId: 'remote-task' }));
      receiveUpdate();
    },
    onError: (message) => assert.fail(message),
  }, () => 'en');
  await poller.pull();
  const unsubscribe = fixture.bridge.sessions.subscribeChanges((event) => {
    if (event.sessionId) void poller.pullSession(event.sessionId);
    else void poller.pull();
  });
  try {
    fixture.calls.length = 0;
    fixture.emitRemoteSessionChange();
    await observed;
    assert.deepEqual(fixture.calls.filter(({ channel }) => channel.startsWith('onboarding:')), [
      { channel: 'onboarding:getSessionUpdate', hostId: 'remote-host' },
    ]);
  } finally {
    unsubscribe();
    poller.dispose();
  }
});

test('an older complete read cannot erase a newer targeted outcome', async () => {
  const fixture = await harness();
  const remoteKey = desktopSessionKey({ hostId: 'remote-host', sessionId: 'remote-task' });
  await fixture.bridge.onboarding.getSnapshot();
  let release!: (snapshot: OnboardingSnapshot) => void;
  fixture.holdRemote(new Promise((resolve) => { release = resolve; }));
  const oldRead = fixture.bridge.onboarding.getSnapshot();
  await new Promise((resolve) => setImmediate(resolve));
  const update = await fixture.bridge.onboarding.getSessionUpdate(remoteKey);
  assert.equal(update?.kind, 'delta');
  release(hostSnapshot('remote-host'));
  const latest = await oldRead;
  assert.equal(latest.sessionSendOutcomes[remoteKey]?.kind, 'blocked');
});
