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
import { deferred, waitFor } from '@maka/core/test-only/async-primitives';
import type { StoredMessage } from '@maka/core/session';
import type { MakaBridge } from '../../preload/bridge-contract.js';
import type { DesktopTranscriptBatch, DesktopTranscriptRangeRequest } from '../../preload/transcript-contract.js';
import { createDesktopWorkHubServices } from '../../renderer/platform/desktop/create-workhub-services.js';
import { desktopSessionKey } from '../../shared/runtime-host-identity.js';
import { encodeDesktopTranscriptSnapshot } from '../desktop-transcript-ipc.js';

// Keep the real preload's navigation defaults and filtering in this consumer
// regression; the IPC stub models the observer's authoritative reset reply.
test('WorkHub tail navigation converges through the preload with a fragmented sparse tail', { timeout: 5_000 }, async (t) => {
  const owner = {
    hostId: 'owner-host', targetEpoch: 'owner-epoch', profileId: 'local',
    profileName: 'Local', profileKind: 'local', profileAccess: 'owner', readiness: 'ready',
  };
  const sessionId = desktopSessionKey({ hostId: owner.hostId, sessionId: 'coordination' });
  const snapshot = {
    sessionId: 'coordination', generation: 'generation-1', hostEpoch: 'epoch-1',
    durableThrough: 8, overlay: [], hasOlder: true, hasNewer: false,
  };
  const message: StoredMessage = {
    type: 'user', id: 'latest-message', turnId: 'latest-turn', ts: 7,
    text: 'Latest coordination record '.repeat(8_000),
  };
  const requests: DesktopTranscriptRangeRequest[] = [];
  const projections: string[][] = [];
  const partialProjectionCounts: number[] = [];
  let bridge: MakaBridge | undefined;
  let consumerId: string;
  let deliverySequence = 0;
  let deliverDirect: ((batch: DesktopTranscriptBatch) => void) | undefined;
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let finishResponse!: () => void;
  const responseDelivered = new Promise<void>((resolve) => { finishResponse = resolve; });
  const deliver = (batch: Omit<DesktopTranscriptBatch, 'deliverySequence'>) => {
    listeners.get(`sessions:transcript:${consumerId}`)?.({}, owner, {
      ...batch, deliverySequence: ++deliverySequence,
    });
  };
  const ipcRenderer = {
    on(channel: string, listener: (...args: unknown[]) => void) { listeners.set(channel, listener); },
    off(channel: string) { listeners.delete(channel); },
    send() {},
    async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      if (channel === 'runtime-host:activeIdentity') return owner;
      if (channel === 'runtime-host:identities') return [owner];
      if (channel === 'session-local:transcript') return null;
      if (channel === 'sessions:transcript:open') {
        consumerId = args[2] as string;
        for (const batch of encodeDesktopTranscriptSnapshot({ ...snapshot, navigationVersion: 0, durable: [] })) {
          deliver(batch);
        }
        return { ...snapshot, readThroughMessageId: null };
      }
      if (channel === 'sessions:transcript:load-around') {
        const request = args[1] as DesktopTranscriptRangeRequest;
        requests.push(request);
        // Bound a regressed request loop so the test reports its cause.
        if (requests.length >= 3) return new Promise(() => {});
        await new Promise<void>((resolve) => setImmediate(resolve));
        try {
          for (const batch of encodeDesktopTranscriptSnapshot({
            ...snapshot, navigationVersion: request.navigationVersion,
            durable: [{ sequence: 7, message }],
          })) {
            deliver(batch);
            if (!batch.ready) {
              partialProjectionCounts.push(projections.length);
              // A rejected ready/reset must not publish a partial valid snapshot
              // or clear the load guard, even if a caller bypasses preload filtering.
              deliverDirect?.({
                ...batch, navigationVersion: 0, fragments: [], ready: true,
                deliverySequence: ++deliverySequence,
              });
              deliverDirect?.({
                ...batch, generation: 'unrelated-generation', reset: false, fragments: [], ready: true,
                deliverySequence: ++deliverySequence,
              });
              partialProjectionCounts.push(projections.length);
            }
          }
        } finally {
          finishResponse();
        }
        return;
      }
      if (channel === 'sessions:transcript:ack' || channel === 'sessions:transcript:close') return;
      throw new Error(`Unexpected channel: ${channel}`);
    },
  };
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../../../src/preload/preload.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['electron'],
  });
  const require = createRequire(import.meta.url);
  runInNewContext(bundle.outputFiles[0]!.text, {
    require: (id: string) => id === 'electron' ? {
      ipcRenderer,
      contextBridge: { exposeInMainWorld(name: string, value: MakaBridge) {
        if (name === 'maka') bridge = value;
      } },
    } : require(id),
    process: { env: {} }, Buffer, console, setTimeout, clearTimeout, TextEncoder, TextDecoder,
    Uint8Array, crypto: globalThis.crypto,
  });
  assert.ok(bridge);
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { search: '?surface=workhub' } } });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const services = createDesktopWorkHubServices({
    ...bridge,
    transcripts: {
      ...bridge.transcripts,
      open(requestedSessionId, handler, registerCancellation) {
        deliverDirect = handler;
        return bridge!.transcripts.open(requestedSessionId, handler, registerCancellation);
      },
    },
  });
  const handle = await services.openTranscript(
    sessionId,
    (snapshot) => projections.push(snapshot.messages.map((message) => message.id)),
    new AbortController().signal,
    (error) => { throw error; },
  );
  try {
    await waitFor(() => projections.length === 1, { timeoutMs: 5_000 });
    await handle.loadLatest();
    await responseDelivered;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.navigationVersion, 1);
    assert.equal(requests[0]!.intent, 'followTail');
    assert.equal(requests[0]!.anchorSequence, null);
    assert.deepEqual(partialProjectionCounts, [1, 1]);
    assert.deepEqual(projections, [[], ['latest-message']]);
  } finally {
    await handle.close();
  }
});


// Exercise the production adapter with the same cached handle shape returned by
// preload, and both orderings of initial read failure versus observation readiness.
for (const initial of ['failure-before-ready', 'failure-after-ready', 'cached'] as const) {
  test(`WorkHub read reconnects through observation readiness: ${initial}`, async (t) => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { search: '?surface=workhub' } } });
    t.after(() => {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    });
    const sessionId = desktopSessionKey({ hostId: 'owner-host', sessionId: 'coordination' });
    let openCount = 0;
    let closedCount = 0;
    let onReady!: () => void;
    let onPhase!: (phase: 'pending' | 'ready') => void;
    let latest: readonly StoredMessage[] = [];
    const opening = deferred<void>();
    const errors: unknown[] = [];
    const services = createDesktopWorkHubServices({
      attachments: {},
      sessions: {
        subscribeEvents(_sessionId, _onEvent, ready, phase) {
          onReady = ready!;
          onPhase = phase!;
          return () => {};
        },
      } satisfies Pick<MakaBridge['sessions'], 'subscribeEvents'>,
      transcripts: {
        async open(_sessionId, onBatch) {
          const attempt = ++openCount;
          if (attempt === 1 && initial !== 'cached') {
            await opening.promise;
            throw new Error('transient initial open failure');
          }
          const cached = attempt === 1;
          const snapshot = {
            sessionId: 'coordination', generation: cached ? 'cached:epoch-1' : `live-${attempt}`,
            hostEpoch: 'epoch-1', durableThrough: 1, overlay: [], hasOlder: false, hasNewer: false,
          };
          const deliver = (navigationVersion = 0) => {
            for (const batch of encodeDesktopTranscriptSnapshot({
              ...snapshot, navigationVersion,
              durable: [{ sequence: 1, message: { type: 'user', id: cached ? 'cached-message' : 'live-message', turnId: 'turn-1', ts: 1, text: cached ? 'Cached history' : 'Live history' } }],
            })) onBatch({ ...batch, deliverySequence: 1 });
          };
          deliver();
          const unavailable = async () => { throw new Error('Reconnect the Host to load uncached history'); };
          return {
            ...snapshot, readThroughMessageId: null,
            loadBefore: unavailable, loadAfter: unavailable,
            loadAround: cached ? unavailable : async (_sequence, _maxBytes, navigation) => deliver(navigation?.navigationVersion),
            close: async () => { closedCount++; },
          };
        },
      } satisfies Pick<MakaBridge['transcripts'], 'open'>,
    } as unknown as Parameters<typeof createDesktopWorkHubServices>[0]);
    const handle = await services.openTranscript(sessionId, (snapshot) => { latest = snapshot.messages; }, new AbortController().signal, (error) => errors.push(error));
    const unsubscribe = services.observe(sessionId, () => {}, (error) => errors.push(error), handle.observationChanged);
    try {
      if (initial === 'failure-after-ready') onReady();
      opening.resolve();
      if (initial !== 'cached') await waitFor(() => errors.length > 0, { timeoutMs: 5_000 });
      else assert.deepEqual(latest.map(({ id }) => id), ['cached-message']);
      onPhase('pending');
      onPhase('ready');
      await waitFor(() => latest.some(({ id }) => id === 'live-message'), { timeoutMs: 5_000 });
      assert.equal(openCount, 2);
      assert.equal(closedCount, initial === 'cached' ? 1 : 0);
      assert.equal(errors.length, initial === 'cached' ? 0 : 1);
    } finally {
      unsubscribe();
      await handle.close();
    }
  });
}
