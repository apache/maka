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
import type { StoredMessage } from '@maka/core/session';
import type { MakaBridge } from '../../preload/bridge-contract.js';
import type { DesktopTranscriptBatch, DesktopTranscriptRangeRequest } from '../../preload/transcript-contract.js';
import { createDesktopWorkHubCoordinationPort } from '../../renderer/workhub-coordination-port.js';
import { desktopSessionKey } from '../../shared/runtime-host-identity.js';
import { encodeDesktopTranscriptSnapshot } from '../desktop-transcript-ipc.js';

// Keep the real preload's navigation defaults and filtering in this consumer
// regression; the IPC stub models the observer's authoritative reset reply.
test('Coordination tail recovery converges through the preload with a fragmented sparse tail', { timeout: 5_000 }, async () => {
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
  const errors: unknown[] = [];
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
  const port = createDesktopWorkHubCoordinationPort({
    sessionId,
    transcripts: {
      open(requestedSessionId, handler, registerCancellation) {
        deliverDirect = handler;
        return bridge!.transcripts.open(requestedSessionId, handler, registerCancellation);
      },
    },
    record: async (input) => ({ turnId: input.turnId }),
    candidates: async () => assert.fail('unused'),
    act: async () => assert.fail('unused'),
  });
  const handle = await port.open(
    (turns) => projections.push(turns.map((turn) => turn.messageId)),
    (error) => errors.push(error),
  );
  try {
    await responseDelivered;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.navigationVersion, 1);
    assert.equal(requests[0]!.intent, 'followTail');
    assert.equal(requests[0]!.anchorSequence, null);
    assert.equal(requests[0]!.maxBytes, 512 * 1024);
    assert.deepEqual(partialProjectionCounts, [0, 0]);
    assert.deepEqual(projections, [['latest-message']]);
  } finally {
    await handle.close();
  }
});
