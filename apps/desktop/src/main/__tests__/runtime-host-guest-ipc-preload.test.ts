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
import { deferred } from '@maka/core/test-only/async-primitives';
import type { MakaBridge } from '../../preload/bridge-contract.js';

test('onboarding and workspace search never fan out Owner IPC to a ready Guest', async () => {
  const owner = {
    hostId: 'owner-host', targetEpoch: 'owner-epoch', profileId: 'local',
    profileName: 'Local', profileKind: 'local', profileAccess: 'owner', readiness: 'ready',
  };
  const guest = {
    hostId: 'guest-host', targetEpoch: 'guest-epoch', profileId: 'shared',
    profileName: 'Shared', profileKind: 'remote', profileAccess: 'session_guest', readiness: 'ready',
  };
  const calls: { channel: string; hostId?: string }[] = [];
  const pendingSearch = deferred<never>();
  const searchStarted = deferred<void>();
  let searchRequestId: unknown;
  let cancelRequestId: unknown;
  const ipcRenderer = {
    on() {}, off() {}, send() {},
    async invoke(channel: string, scope?: { hostId?: string }, payload?: unknown, requestId?: unknown) {
      calls.push({ channel, hostId: scope?.hostId });
      // A missing Guest handler must not hold up either aggregate.
      if (scope?.hostId === guest.hostId) throw new Error('Guest has no Owner handler');
      switch (channel) {
        case 'runtime-host:activeIdentity': return owner;
        case 'runtime-host:identities': return [owner, guest];
        case 'session-local:catalog': return [{ scope: owner, sessions: [], authoritative: true }];
        case 'onboarding:getSnapshot': return {
          state: { kind: 'ready_empty' }, milestones: [], sessions: [], connections: [],
          defaultSlug: null, chatModelChoices: [], sessionSendOutcomes: {},
        };
        case 'session-collaboration:mount:list': return [{
          mountId: 'shared', name: 'Shared', hostId: guest.hostId,
          session: {
            kind: 'shared_session', id: 'shared-session', revision: 1,
            createdAt: 1, activityAt: 1, name: 'Shared Session', status: 'active',
          },
        }];
        case 'sessions:list': return [];
        case 'search:thread':
          searchRequestId = requestId;
          searchStarted.resolve();
          return pendingSearch.promise;
        case 'search:thread:cancel':
          cancelRequestId = payload;
          return;
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
  const snapshot = await bridge.onboarding.getSnapshot();
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0]!.shared, true);
  assert.equal(snapshot.sessions[0]!.name, 'Shared Session');
  const search = bridge.search.thread({ query: 'hello', limit: 10, source: 'thread' }, 'search-owner');
  await searchStarted.promise;
  await bridge.search.cancelThread('search-owner');
  assert.equal((await search as { reason: string }).reason, 'aborted');
  assert.equal(searchRequestId, 'search-owner');
  assert.equal(cancelRequestId, searchRequestId);
  assert.equal(calls.some(call => call.hostId === guest.hostId), false);
  for (const channel of ['onboarding:getSnapshot', 'search:thread', 'search:thread:cancel']) {
    assert.equal(calls.filter(call => call.channel === channel && call.hostId === owner.hostId).length, 1);
  }
});
