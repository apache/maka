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
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';
import type { MakaBridge } from '../../preload/bridge-contract.js';

async function loadBridge(changeDuringRead: 'guest' | 'owner') {
  const owner = {
    hostId: 'local-host', targetEpoch: 'local-epoch', profileId: 'local',
    profileName: 'Local', profileKind: 'local', profileAccess: 'owner', readiness: 'ready',
  };
  const guest = {
    hostId: 'shared-host', targetEpoch: 'shared-epoch', profileId: 'shared',
    profileName: 'Shared', profileKind: 'remote', profileAccess: 'session_guest',
    readiness: 'reconnecting',
  };
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const emit = (channel: string, value: unknown) => {
    for (const listener of listeners.get(channel) ?? []) listener({}, value);
  };
  let catalogReads = 0;
  let projectReads = 0;
  const scopedCalls: string[] = [];
  const ipcRenderer = {
    on(channel: string, listener: (...args: unknown[]) => void) {
      const handlers = listeners.get(channel) ?? new Set();
      handlers.add(listener);
      listeners.set(channel, handlers);
    },
    off(channel: string, listener: (...args: unknown[]) => void) {
      listeners.get(channel)?.delete(listener);
    },
    send() {},
    async invoke(channel: string, scope?: { hostId?: string }) {
      if (scope?.hostId) {
        scopedCalls.push(scope.hostId);
        assert.equal(scope.hostId, owner.hostId, 'Guest reconnects must not redirect Owner reads');
      }
      switch (channel) {
        case 'runtime-host:activeIdentity': return { ...owner };
        case 'runtime-host:identities': return [{ ...owner }, { ...guest }];
        case 'runtime-host-profiles:getSnapshot':
          catalogReads++;
          return {
            defaultProfileId: 'local',
            entries: [
              { profile: { id: 'local', name: 'Local', kind: 'local' },
                hostId: owner.hostId, enabled: true, readiness: 'ready' },
              { profile: { id: 'shared', name: 'Shared', kind: 'remote', access: 'session_guest' },
                hostId: guest.hostId, enabled: true, readiness: 'reconnecting' },
            ],
          };
        case 'projects:getSnapshot':
          projectReads++;
          if (changeDuringRead === 'guest') {
            for (let index = 0; index < 20; index++) {
              emit('runtime-host-profiles:changed', {
                ...guest, epoch: guest.targetEpoch, isDefault: false,
              });
            }
          } else if (projectReads === 1) {
            owner.targetEpoch = 'replacement-epoch';
            emit('runtime-host-profiles:changed', {
              ...owner, epoch: owner.targetEpoch, isDefault: true,
            });
          }
          return {
            projects: [],
            capabilities: { chooseClientDirectory: true, selectNoProject: true },
          };
        case 'app:info': return { projectId: null, projectGit: {} };
        case 'settings:get': return { projects: {}, chatDefaults: {} };
        case 'onboarding:getSnapshot': return {
          state: { kind: 'ready_empty' }, milestones: [], sessions: [], connections: [],
          defaultSlug: null, chatModelChoices: [], sessionSendOutcomes: {},
        };
        case 'session-local:catalog': return [{ scope: owner, sessions: [], authoritative: true }];
        case 'session-collaboration:mount:list':
        case 'sessions:list': return [];
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
  return { bridge, catalogReads: () => catalogReads, scopedCalls };
}

test('offline Guest notifications cannot starve the Local new-task catalog or redirect onboarding', async () => {
  const { bridge, catalogReads, scopedCalls } = await loadBridge('guest');
  let invalidations = 0;
  const unsubscribe = bridge.newTasks.subscribeChanges(() => invalidations++);
  try {
    const catalog = await bridge.newTasks.getCatalog();
    assert.equal(catalogReads(), 1, 'Guest state changes cannot invalidate an Owner catalog read');
    assert.equal(invalidations, 0);
    assert.equal(catalog.defaultProfileId, 'local');
    assert.equal(catalog.hosts.length, 1);
    assert.equal(catalog.hosts[0]?.profile.id, 'local');
    assert.equal(catalog.hosts[0]?.readiness, 'ready');
    const snapshot = await bridge.onboarding.getSnapshot();
    assert.equal(snapshot.state.kind, 'ready_empty');
    assert.ok(scopedCalls.length > 0);
    assert.ok(scopedCalls.every(hostId => hostId === 'local-host'));
  } finally {
    unsubscribe();
  }
});

test('an Owner replacement still invalidates the new-task catalog', async () => {
  const { bridge, catalogReads } = await loadBridge('owner');
  const catalog = await bridge.newTasks.getCatalog();
  assert.equal(catalogReads(), 2);
  assert.equal(catalog.hosts[0]?.readiness, 'ready');
});
