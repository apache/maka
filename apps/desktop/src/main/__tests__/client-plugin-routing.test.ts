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
import { test } from 'node:test';
import { createClientPluginRouting } from '../../preload/client-plugin-routing.js';
import type { DesktopTargetScope } from '../../shared/runtime-host-identity.js';

test('desktop plugin routing unprojects Session ids, fences Host identity and pins streams across selection changes', async () => {
  let scope = { hostId: 'host-a', targetEpoch: 'epoch-a' };
  const calls: Array<{ channel: string; scope: DesktopTargetScope; input: any }> = [];
  const routing = createClientPluginRouting({
    activeScope: async () => scope,
    sessionRef: async (id) => {
      const [hostId, sessionId] = JSON.parse(id);
      return { scope: { hostId, targetEpoch: hostId === 'host-a' ? 'epoch-a' : 'epoch-b' }, sessionId };
    },
    async invoke<T>(channel: string, target: DesktopTargetScope, input?: unknown): Promise<T> {
      calls.push({ channel, scope: target, input });
      if (channel === 'client-plugins:snapshot') return { authorityEpoch: 1, revision: 'host-revision', plugins: [], failures: [] } as T;
      if (channel.endsWith(':open')) return { streamId: 'same-host-local-id' } as T;
      if (channel.endsWith(':next')) return { done: false, value: target.hostId } as T;
      if (channel.endsWith(':close')) return input as T;
      return { value: input } as T;
    },
  });
  const a = await routing.snapshot();
  assert.equal((await routing.snapshot()).revision, a.revision);
  const request = { authorityEpoch: 1, revision: a.revision, entryId: 'ui', extensionId: 'fixture', generation: 1, contentDigest: 'digest', clientDigest: 'client', method: 'fixture.echo', input: null, sessionId: JSON.stringify(['host-a', 'session-a']) };
  await routing.remoteCall(request);
  assert.equal(calls.at(-1)?.input.sessionId, 'session-a');
  assert.equal(calls.at(-1)?.input.revision, 'host-revision');
  const streamA = await routing.remoteStreamOpen(request);
  scope = { hostId: 'host-b', targetEpoch: 'epoch-b' };
  const b = await routing.snapshot();
  assert.notEqual(b.revision, a.revision);
  await routing.remoteCall(request);
  assert.equal(calls.at(-1)?.scope.hostId, 'host-a');
  await assert.rejects(() => routing.remoteCall({ ...request, sessionId: JSON.stringify(['host-b', 'session-b']) }), /different Runtime Hosts/);
  const streamB = await routing.remoteStreamOpen({ ...request, revision: b.revision, sessionId: JSON.stringify(['host-b', 'session-b']) });
  assert.notEqual(streamA.streamId, streamB.streamId);
  assert.deepEqual(await routing.remoteStreamNext(streamA), { done: false, value: 'host-a' });
  assert.deepEqual(await routing.remoteStreamNext(streamB), { done: false, value: 'host-b' });
  await routing.remoteStreamClose(streamA);
  assert.equal(calls.at(-1)?.scope.hostId, 'host-a');
  assert.deepEqual(calls.at(-1)?.input, { streamId: 'same-host-local-id' });
  const count = calls.length;
  await routing.remoteStreamClose(streamA);
  assert.equal(calls.length, count);
  assert.deepEqual(await routing.remoteStreamNext(streamA), { done: true });
});
