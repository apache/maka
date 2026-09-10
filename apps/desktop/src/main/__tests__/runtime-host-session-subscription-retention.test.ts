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
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { deferred } from '@maka/core/test-only/async-primitives';
import { RuntimeHostSubscriptionError } from '@maka/runtime-host/client';
import { SESSION_CONTINUITY_SCHEMA_VERSION } from '@maka/runtime-host/protocol';
import { RuntimeHostSessionSubscriptionOwner } from '../runtime-host-session-subscription-owner.js';
import { runtimeHostSessionFixture } from './runtime-host-session-test-fixture.js';

test('active observations release previous subscription generations after refresh and recovery', () => {
  const moduleUrl = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  const subscriptionUrl = JSON.stringify(new URL(
    './session-subscription.js', import.meta.resolve('@maka/runtime-host/client'),
  ).href);
  // Isolate explicit GC and prototype instrumentation from other tests. Only
  // transport and renderer are fixtures; all subscription lifecycle classes are real.
  const result = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { EventEmitter } from 'node:events';
    import { setImmediate as tick } from 'node:timers/promises';
    import { RuntimeHostSessionSubscriptionOwner } from ${moduleUrl('../runtime-host-session-subscription-owner.js')};
    import { DesktopTranscriptReplica } from ${moduleUrl('../desktop-transcript-replica.js')};
    import { RuntimeHostSessionObserver } from ${moduleUrl('../runtime-host-session-observer.js')};
    import { DesktopRuntimeHostClient } from ${moduleUrl('../runtime-host-client.js')};
    import { ClientSessionSubscription, RuntimeHostSubscriptionError } from ${subscriptionUrl};

    const refs = { subscriptions: [], handles: [], replicas: [], owners: [] };
    const capture = (kind, value) => refs[kind].push(new WeakRef(value));
    async function assertLive(expected, ownerCount) {
      for (let i = 0; i < 6; i++) { await tick(); global.gc(); }
      for (const kind of ['subscriptions', 'handles', 'replicas']) {
        assert.deepEqual(refs[kind].flatMap((ref, i) => ref.deref() ? [i] : []), expected, kind);
      }
      assert.equal(refs.owners.filter(ref => ref.deref()).length, ownerCount);
    }
    const originalStart = RuntimeHostSessionSubscriptionOwner.prototype.start;
    RuntimeHostSessionSubscriptionOwner.prototype.start = function() {
      capture('owners', this);
      return originalStart.call(this);
    };
    const originalPrepare = DesktopTranscriptReplica.prepare;
    DesktopTranscriptReplica.prepare = async function(...args) {
      capture('handles', args[0]);
      const replica = await originalPrepare.apply(this, args);
      capture('replicas', replica);
      return replica;
    };
    const page = source => ({
      kind: 'page', sessionId: 'session-1', source, direction: 'older', throughSequence: null,
      fragments: [], nextCursor: null, rawBytes: 0, rangeBoundarySequence: null,
      protectedTurnSequence: null,
    });
    let generation = 0;
    const liveSubscriptions = new Map();
    const connection = {
      async openSessionSubscription() {
        const id = 'subscription-' + generation++;
        const result = {
          hostEpoch: 'host-1', subscriptionId: id, nextSequence: 0, activeAssistantStreams: [],
          snapshot: {
            schemaVersion: ${SESSION_CONTINUITY_SCHEMA_VERSION},
            session: { sessionId: 'session-1', metadataRevision: 1, status: 'running', createdAt: 1, isArchived: false },
            projectionRevision: 1,
            rootTurn: { sessionId: 'session-1', turnId: 'turn-1', runId: 'run-1', status: 'running' },
            goal: null, queue: { hostEpoch: 'host-1', queueRevision: 0, steering: [], followup: [] },
            interactions: { pending: [] },
          },
          transcript: { throughSequence: null, overlayMessageCount: 0, durable: page('durable'), overlay: page('overlay') },
        };
        const subscription = new ClientSessionSubscription(result, async () => {
          liveSubscriptions.delete(id);
          subscription.finish();
        }, async () => { throw Error('Unexpected transcript read'); });
        liveSubscriptions.set(id, subscription);
        capture('subscriptions', subscription);
        return subscription;
      },
      async request() {},
      async close() {},
    };
    const client = new DesktopRuntimeHostClient(connection);
    const observer = new RuntimeHostSessionObserver({ client, emitSessionsChanged() {} });
    const target = Object.assign(new EventEmitter(), { id: 1, send() {} });
    function sharedRefresh() {
      const owner = refs.owners[0].deref();
      const refresh = owner.refresh();
      assert.equal(owner.refresh(), refresh);
      return refresh;
    }
    function failCurrent() {
      const current = refs.subscriptions.at(-1).deref();
      // Match the real connection's failure ordering: remove map membership first.
      liveSubscriptions.delete(current.subscriptionId);
      current.fail(new RuntimeHostSubscriptionError('sequence_gap', 'retention test recovery'));
    }
    try {
      await observer.observe('session-1', 'observer-1', target);
      await assertLive([0], 1);
      for (let i = 0; i < 8; i++) {
        // Concurrent refresh callers must still share one replacement.
        await sharedRefresh();
      }
      assert.equal(generation, 9);
      await assertLive([8], 1);
      for (let i = 0; i < 8; i++) {
        failCurrent();
        await tick();
        await refs.owners[0].deref().waitUntilReady();
      }
      assert.equal(generation, 17);
      await assertLive([16], 1);
      assert.equal(liveSubscriptions.size, 1);
    } finally {
      await observer.close();
    }
    // Keep the closed observer, client and renderer alive while checking their
    // released objects, then exercise reuse of the same transport and target.
    await assertLive([], 0);
    for (let i = 0; i < 8; i++) {
      const reopened = new RuntimeHostSessionObserver({ client, emitSessionsChanged() {} });
      await reopened.observe('session-1', 'observer-1', target);
      await reopened.close();
    }
    await assertLive([], 0);
    assert.equal(liveSubscriptions.size, 0);
    assert.equal(target.listenerCount('destroyed'), 0);
    assert.ok(observer && client);
  `], { encoding: 'utf8', timeout: 30_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('an activated attempt still records retiring failures when its replacement preparation fails', { timeout: 5_000 }, async () => {
  const ended: ReturnType<typeof deferred<Error | undefined>>[] = [];
  const candidateStarted = deferred<void>();
  const candidateActivation = deferred<() => void>();
  const recovered: Error[] = [];
  const terminal: Error[] = [];
  const ptyUpdates: Array<[number, readonly string[]]> = [];
  let preparations = 0;
  let activations = 0;
  const owner = new RuntimeHostSessionSubscriptionOwner({
    client: {
      async openSession() {
        const end = deferred<Error | undefined>();
        const generation = ended.push(end);
        return {
          ...runtimeHostSessionFixture({
            snapshot: {
              schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
              session: { sessionId: 'session-1', metadataRevision: 1, status: 'running', createdAt: 1, isArchived: false },
              projectionRevision: 1, rootTurn: null, goal: null,
              queue: { hostEpoch: 'host-1', queueRevision: 0, steering: [], followup: [] },
              interactions: { pending: [] },
            },
            transcript: Promise.resolve([]),
            events: (async function* () {
              const error = await end.promise;
              if (error) throw error;
            })(),
            async close() { end.resolve(undefined); },
          }),
          async setPtyInterests(refs: readonly string[]) { ptyUpdates.push([generation, refs]); },
        };
      },
    },
    sessionId: 'session-1',
    now: Date.now,
    async prepareActivation() {
      if (++preparations === 2) {
        candidateStarted.resolve();
        return candidateActivation.promise;
      }
      return () => { activations++; };
    },
    acceptFrame() {},
    recoveryStarted() {},
    recoveryCompleted(error) { recovered.push(error); },
    recoveryFailed(_initial, error) { terminal.push(error); },
    terminalFailure(error) { terminal.push(error); },
  });
  try {
    owner.start();
    await owner.waitUntilReady();
    await owner.setPtyInterests(['pty-1']);
    const refresh = owner.refresh();
    assert.equal(owner.refresh(), refresh);
    await candidateStarted.promise;
    const retiredFailure = new RuntimeHostSubscriptionError('sequence_gap', 'retiring attempt failed');
    ended[0]!.resolve(retiredFailure);
    await tick();
    candidateActivation.reject(new Error('replacement preparation failed'));
    await refresh;
    assert.equal(ended.length, 3, 'recover the failed predecessor instead of resuming it');
    assert.equal(activations, 2, 'the failed candidate never activates');
    assert.deepEqual(recovered, [retiredFailure]);
    assert.deepEqual(terminal, []);
    assert.deepEqual(ptyUpdates, [[1, ['pty-1']], [2, ['pty-1']], [3, ['pty-1']]]);
  } finally {
    candidateActivation.resolve(() => undefined);
    await owner.close();
  }
});
