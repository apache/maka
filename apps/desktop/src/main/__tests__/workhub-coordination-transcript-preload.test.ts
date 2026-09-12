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
import type { WorkHubTranscriptSnapshot } from '../../renderer/features/workhub/index.js';
import { desktopSessionKey } from '../../shared/runtime-host-identity.js';
import { encodeDesktopTranscriptPage, encodeDesktopTranscriptSnapshot } from '../desktop-transcript-ipc.js';
import type { AttachmentRef } from '@maka/core/events';
import { MESSAGE_QUEUE_MAX_ENTRIES } from '@maka/runtime-host/protocol';

test('WorkHub upload references round-trip through idle answers, both queue modes and attachment reads', async (t) => {
  const owner = {
    hostId: 'upload-host', targetEpoch: 'upload-epoch', profileId: 'local',
    profileName: 'Local', profileKind: 'local', profileAccess: 'owner', readiness: 'ready',
  };
  const nativeSessionId = 'maka_workhub_coordination';
  const sessionId = desktopSessionKey({ hostId: owner.hostId, sessionId: nativeSessionId });
  const uploaded: AttachmentRef = {
    kind: 'doc', name: 'brief.txt', mimeType: 'text/plain', bytes: 5,
    ref: { kind: 'session_file', sessionId: nativeSessionId, relativePath: 'brief.txt' },
  };
  const sent: Array<{ channel: string; attachments: AttachmentRef[] }> = [];
  let bridge!: MakaBridge;
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../../../src/preload/preload.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['electron'],
  });
  const require = createRequire(import.meta.url);
  runInNewContext(bundle.outputFiles[0]!.text, {
    require: (id: string) => id === 'electron' ? {
      contextBridge: { exposeInMainWorld(name: string, value: MakaBridge) { if (name === 'maka') bridge = value; } },
      ipcRenderer: {
        on() {}, off() {}, send() {},
        async invoke(channel: string, ...args: unknown[]) {
          if (channel === 'runtime-host:activeIdentity') return owner;
          if (channel === 'runtime-host:identities') return [owner];
          assert.equal((args[0] as typeof owner).hostId, owner.hostId);
          if (channel === 'workhub:prepareAttachments') {
            assert.deepEqual(structuredClone(args[1]), [{ name: 'brief.txt', mimeType: 'text/plain', base64: 'aGVsbG8=' }]);
            return [uploaded];
          }
          if (channel === 'workhub:answer') {
            const input = args[1] as { attachments: AttachmentRef[]; turnId: string };
            sent.push({ channel, attachments: input.attachments });
            return { kind: 'admitted', turnId: input.turnId };
          }
          assert.equal(args[1], nativeSessionId);
          if (channel === 'sessions:submitMessage') {
            const command = args[3] as { retainedAttachments: AttachmentRef[] };
            sent.push({ channel, attachments: command.retainedAttachments });
            return { ok: true, disposition: args[2] === 'current_turn' ? 'steering' : 'followup', attachments: [uploaded] };
          }
          if (channel === 'attachments:readBytes') return { ok: true, base64: 'aGVsbG8=' };
          throw new Error(`Unexpected channel: ${channel}`);
        },
      },
    } : require(id),
    process: { env: {} }, Buffer, console, setTimeout, clearTimeout, TextEncoder, TextDecoder,
    Uint8Array, btoa, crypto: globalThis.crypto,
  });
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { search: '?surface=workhub' } } });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const services = createDesktopWorkHubServices(bridge);
  const attachments = await services.prepareAttachments(sessionId, [
    { file: new File(['hello'], 'brief.txt', { type: 'text/plain' }) },
  ]);
  assert.equal(attachments[0]!.ref.kind, 'session_file');
  assert.equal(attachments[0]!.ref.kind === 'session_file' && attachments[0]!.ref.sessionId, sessionId);
  assert.equal((await services.answer(sessionId, { turnId: 'idle-answer', text: 'read this', attachments })).kind, 'admitted');
  for (const placement of ['next_turn', 'current_turn'] as const) {
    assert.equal(await services.enqueueMessage(sessionId, `message-${placement}`, 'read this', attachments, placement), 'admitted');
  }
  assert.deepEqual(structuredClone(sent.map(({ attachments }) => attachments)), [[uploaded], [uploaded], [uploaded]]);
  assert.equal((await services.readAttachmentBytes(sessionId, 'brief.txt')).ok, true);
  const foreign = [{ ...uploaded, ref: { ...uploaded.ref, kind: 'session_file' as const, sessionId: desktopSessionKey({ hostId: 'foreign-host', sessionId: nativeSessionId }), relativePath: 'brief.txt' } }];
  await assert.rejects(services.answer(sessionId, { turnId: 'foreign', text: 'read this', attachments: foreign }), /another Host or Session/);
  await assert.rejects(services.enqueueMessage(sessionId, 'foreign', 'read this', foreign, 'next_turn'), /another Host or Session/);
});

test('WorkHub projects the exact delegated Turn status and bounded assistant result', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { search: '?surface=workhub' } } });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const sessionId = desktopSessionKey({ hostId: 'owner-host', sessionId: 'target-session' });
  const result: StoredMessage = {
    type: 'assistant', id: 'answer', turnId: 'owned-turn', ts: 3,
    modelId: 'model', text: 'The delegated task finished with this exact result.',
  };
  const services = createDesktopWorkHubServices({
    attachments: {},
    sessions: {
      async list() {
        return [{
          id: sessionId, name: 'Target task', isFlagged: false, isArchived: false,
          labels: [], hasUnread: false, status: 'active', runningTurnIds: [], revision: 1,
        }];
      },
      async listTurns() {
        return [{ turnId: 'owned-turn', firstSequence: 1, status: 'completed', statusSource: 'recorded' }];
      },
      async queryMessageExecutions() {
        return { resolutions: [{ messageId: 'delegated-message', state: 'owned', turnId: 'owned-turn', runId: 'run' }] };
      },
    },
    transcripts: {
      async open(_sessionId: string, onBatch: (batch: DesktopTranscriptBatch) => void) {
        const snapshot = {
          sessionId: 'target-session', generation: 'generation-1', hostEpoch: 'epoch-1',
          durableThrough: 1, overlay: [], hasOlder: false, hasNewer: false,
        };
        for (const batch of encodeDesktopTranscriptSnapshot({
          ...snapshot, durable: [{ sequence: 1, message: result }],
        })) onBatch({ ...batch, deliverySequence: 1 });
        return {
          ...snapshot, readThroughMessageId: result.id,
          loadBefore: async () => undefined, loadAfter: async () => undefined,
          loadAround: async () => undefined, close: async () => undefined,
        };
      },
    },
  } as unknown as Parameters<typeof createDesktopWorkHubServices>[0]);

  assert.deepEqual(await services.delegationFeedback([{
    id: 'delegation-record', targetSessionId: sessionId,
    targetMessageId: 'delegated-message', targetTurnId: 'initial-turn',
  }]), [{
    id: 'delegation-record', state: 'completed',
    resultPreview: 'The delegated task finished with this exact result.',
  }]);
});

test('delegation feedback does not advance the target Session read marker', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { search: '?surface=workhub' } } });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const sessionId = desktopSessionKey({ hostId: 'owner-host', sessionId: 'target-session' });
  const result: StoredMessage = {
    type: 'assistant', id: 'answer', turnId: 'owned-turn', ts: 3,
    modelId: 'model', text: 'The delegated task finished with this exact result.',
  };
  const later: StoredMessage = {
    type: 'user', id: 'later', turnId: 'next-turn', ts: 4, text: 'A later turn nobody has read.',
  };
  const acknowledged: number[] = [];
  const services = createDesktopWorkHubServices({
    attachments: {},
    sessions: {
      async list() {
        return [{
          id: sessionId, name: 'Target task', isFlagged: false, isArchived: false,
          labels: [], hasUnread: true, status: 'active', runningTurnIds: [], revision: 1,
        }];
      },
      async listTurns() {
        return [{ turnId: 'owned-turn', firstSequence: 1, status: 'completed', statusSource: 'recorded' }];
      },
      async queryMessageExecutions() {
        return { resolutions: [{ messageId: 'delegated-message', state: 'owned', turnId: 'owned-turn', runId: 'run' }] };
      },
    },
    transcripts: {
      async open(_sessionId: string, onBatch: (batch: DesktopTranscriptBatch) => void) {
        // The real open answers over IPC, so its first batches reach a consumer
        // that is already listening.
        await Promise.resolve();
        const snapshot = {
          sessionId: 'target-session', generation: 'generation-1', hostEpoch: 'epoch-1',
          durableThrough: 2, overlay: [], hasOlder: false, hasNewer: false,
        };
        for (const batch of encodeDesktopTranscriptSnapshot({
          ...snapshot,
          durable: [{ sequence: 1, message: result }, { sequence: 2, message: later }],
        })) onBatch({ ...batch, deliverySequence: 1 });
        return {
          ...snapshot, readThroughMessageId: later.id,
          async acknowledgeTail(through: number) { acknowledged.push(through); },
          loadBefore: async () => undefined, loadAfter: async () => undefined,
          loadAround: async () => undefined, close: async () => undefined,
        };
      },
    },
  } as unknown as Parameters<typeof createDesktopWorkHubServices>[0]);

  assert.equal((await services.delegationFeedback([{
    id: 'delegation-record', targetSessionId: sessionId,
    targetMessageId: 'delegated-message', targetTurnId: 'initial-turn',
  }]))[0]?.resultPreview, result.text);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(acknowledged, [], 'a result projection is not a reader of the target Session');
});

test('WorkHub proves a long historical Turn tail before caching its final result', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { search: '?surface=workhub' } } });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const sessionId = desktopSessionKey({ hostId: 'owner-host', sessionId: 'target-session' });
  const intermediate: StoredMessage = {
    type: 'assistant', id: 'intermediate', turnId: 'owned-turn', ts: 1,
    modelId: 'model', text: 'Intermediate answer that must not be cached.',
  };
  const final: StoredMessage = {
    type: 'assistant', id: 'final', turnId: 'owned-turn', ts: 2,
    modelId: 'model', text: 'Final answer after the historical Turn boundary.',
  };
  const next: StoredMessage = {
    type: 'user', id: 'next', turnId: 'next-turn', ts: 3, text: 'Later turn',
  };
  let deliverySequence = 0;
  let opens = 0;
  let loadAfters = 0;
  const services = createDesktopWorkHubServices({
    attachments: {},
    sessions: {
      async list() {
        return [{
          id: sessionId, name: 'Target task', isFlagged: false, isArchived: false,
          labels: [], hasUnread: false, status: 'active', runningTurnIds: [], revision: 1,
        }];
      },
      async listTurns() {
        return [{ turnId: 'owned-turn', firstSequence: 1, status: 'completed', statusSource: 'recorded' }];
      },
      async queryMessageExecutions() {
        return { resolutions: [{ messageId: 'delegated-message', state: 'owned', turnId: 'owned-turn', runId: 'run' }] };
      },
    },
    transcripts: {
      async open(_sessionId: string, onBatch: (batch: DesktopTranscriptBatch) => void) {
        opens += 1;
        const emit = (
          navigation: number | undefined,
          durable: Array<{ sequence: number; message: StoredMessage }>,
          hasOlder: boolean,
          hasNewer: boolean,
        ) => {
          for (const batch of encodeDesktopTranscriptSnapshot({
            sessionId: 'target-session', generation: 'generation-1', hostEpoch: 'epoch-1',
            durableThrough: 4, overlay: [], hasOlder, hasNewer, durable,
          }, navigation)) onBatch({ ...batch, deliverySequence: ++deliverySequence });
        };
        emit(undefined, [{ sequence: 4, message: { ...next, id: 'tail', ts: 4 } }], true, false);
        return {
          sessionId: 'target-session', generation: 'generation-1', hostEpoch: 'epoch-1',
          durableThrough: 4, hasOlder: true, hasNewer: false, readThroughMessageId: 'tail',
          loadBefore: async () => undefined,
          async loadAround(_sequence: number | null, _maxBytes: number | undefined, navigation: number) {
            emit(navigation, [{ sequence: 1, message: intermediate }], false, true);
          },
          async loadAfter(anchor: number | null, _maxBytes: number | undefined, navigation: number) {
            loadAfters += 1;
            assert.equal(anchor, 1);
            // An extension splices onto the window; only a navigation replaces it.
            for (const batch of encodeDesktopTranscriptPage({
              sessionId: 'target-session', generation: 'generation-1', hostEpoch: 'epoch-1',
              navigation,
            }, {
              durableThrough: 4, hasNewer: true,
              durable: [
                { sequence: 2, message: final },
                { sequence: 3, message: next },
              ],
            }, { direction: 'newer', anchor })) onBatch({ ...batch, deliverySequence: ++deliverySequence });
          },
          close: async () => undefined,
        };
      },
    },
  } as unknown as Parameters<typeof createDesktopWorkHubServices>[0]);
  const reference = {
    id: 'delegation-record', targetSessionId: sessionId,
    targetMessageId: 'delegated-message', targetTurnId: 'initial-turn',
  };

  assert.equal((await services.delegationFeedback([reference]))[0]?.resultPreview, final.text);
  assert.equal((await services.delegationFeedback([reference]))[0]?.resultPreview, final.text);
  assert.equal(opens, 1);
  assert.equal(loadAfters, 1);
});

test('WorkHub batches more than the message execution query limit per target Session', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { search: '?surface=workhub' } } });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const sessionId = desktopSessionKey({ hostId: 'owner-host', sessionId: 'target-session' });
  const querySizes: number[] = [];
  const services = createDesktopWorkHubServices({
    attachments: {},
    sessions: {
      async list() {
        return [{
          id: sessionId, name: 'Target task', isFlagged: false, isArchived: false,
          labels: [], hasUnread: false, status: 'active', runningTurnIds: [], revision: 1,
        }];
      },
      async listTurns() { return []; },
      async queryMessageExecutions(_sessionId: string, messageIds: string[]) {
        querySizes.push(messageIds.length);
        if (messageIds.length > MESSAGE_QUEUE_MAX_ENTRIES) throw new Error('query limit exceeded');
        return { resolutions: messageIds.map((messageId) => ({ messageId, state: 'pending' as const })) };
      },
    },
  } as unknown as Parameters<typeof createDesktopWorkHubServices>[0]);
  const references = Array.from({ length: MESSAGE_QUEUE_MAX_ENTRIES + 1 }, (_, index) => ({
    id: `delegation-${index}`, targetSessionId: sessionId,
    targetMessageId: `message-${index}`, targetTurnId: `turn-${index}`,
  }));

  assert.deepEqual((await services.delegationFeedback(references)).map(({ state }) => state),
    references.map(() => 'accepted'));
  assert.deepEqual(querySizes, [MESSAGE_QUEUE_MAX_ENTRIES, 1]);
});

test('WorkHub does not infer live running when the Session catalog is unavailable', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { search: '?surface=workhub' } } });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const sessionId = desktopSessionKey({ hostId: 'owner-host', sessionId: 'target-session' });
  const services = createDesktopWorkHubServices({
    attachments: {},
    sessions: {
      async list() { throw new Error('catalog unavailable'); },
      async listTurns() {
        return [{ turnId: 'owned-turn', firstSequence: 1, status: 'running', statusSource: 'recorded' }];
      },
      async queryMessageExecutions() {
        return { resolutions: [{ messageId: 'delegated-message', state: 'owned', turnId: 'owned-turn', runId: 'run' }] };
      },
    },
  } as unknown as Parameters<typeof createDesktopWorkHubServices>[0]);

  assert.equal((await services.delegationFeedback([{
    id: 'delegation-record', targetSessionId: sessionId,
    targetMessageId: 'delegated-message', targetTurnId: 'initial-turn',
  }]))[0]?.state, 'recovering');
});

// Keep the real preload in this consumer regression; the IPC stub models the
// observer's authoritative reset reply to a latest command.
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
        for (const batch of encodeDesktopTranscriptSnapshot({ ...snapshot, durable: [] })) {
          deliver(batch);
        }
        return { kind: 'ready', value: { ...snapshot, readThroughMessageId: null } };
      }
      if (channel === 'sessions:transcript:load-latest') {
        const request = args[1] as DesktopTranscriptRangeRequest;
        requests.push(request);
        // Bound a regressed request loop so the test reports its cause.
        if (requests.length >= 3) return new Promise(() => {});
        await new Promise<void>((resolve) => setImmediate(resolve));
        try {
          for (const batch of encodeDesktopTranscriptSnapshot({
            ...snapshot,
            durable: [{ sequence: 7, message }],
          }, request.navigation)) {
            deliver(batch);
            if (!batch.ready) {
              partialProjectionCounts.push(projections.length);
              // A batch from another replica generation must not publish a
              // partial valid snapshot or clear the load guard.
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
    assert.equal(requests[0]!.navigation, 1);
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
        subscribeEvents(_sessionId, _onEvent, phase) {
          onReady = () => phase!('ready');
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
          const deliver = (navigation?: number) => {
            for (const batch of encodeDesktopTranscriptSnapshot({
              ...snapshot,
              durable: [{ sequence: 1, message: { type: 'user', id: cached ? 'cached-message' : 'live-message', turnId: 'turn-1', ts: 1, text: cached ? 'Cached history' : 'Live history' } }],
            }, navigation)) onBatch({ ...batch, deliverySequence: 1 });
          };
          deliver();
          const unavailable = async () => { throw new Error('Reconnect the Host to load uncached history'); };
          return {
            ...snapshot, readThroughMessageId: null,
            acknowledgeTail: async () => {},
            loadBefore: unavailable, loadAfter: unavailable, loadLatest: unavailable,
            loadAround: cached ? unavailable : async (_sequence, _maxBytes, navigation) => deliver(navigation),
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

test('WorkHub fills and trims its transcript window through the reader band', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { search: '?surface=workhub' } } });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const sessionId = desktopSessionKey({ hostId: 'owner-host', sessionId: 'coordination' });
  const identity = { sessionId: 'coordination', generation: 'generation-1', hostEpoch: 'epoch-1' };
  const row = (sequence: number, turnId: string): { sequence: number; message: StoredMessage } => ({
    sequence, message: { type: 'user', id: `message-${sequence}`, turnId, ts: sequence, text: `Record ${sequence}` },
  });
  let deliverySequence = 0;
  let newerReads = 0;
  let olderReads = 0;
  let snapshots: WorkHubTranscriptSnapshot[] = [];
  const services = createDesktopWorkHubServices({
    attachments: {},
    transcripts: {
      async open(_sessionId: string, onBatch: (batch: DesktopTranscriptBatch) => void) {
        for (const batch of encodeDesktopTranscriptSnapshot({
          ...identity, durableThrough: 4, overlay: [], hasOlder: true, hasNewer: true,
          durable: [row(2, 'turn-a'), row(3, 'turn-b')],
        })) onBatch({ ...batch, deliverySequence: ++deliverySequence });
        return {
          ...identity, durableThrough: 4, hasOlder: true, hasNewer: true, readThroughMessageId: 'message-3',
          acknowledgeTail: async () => {},
          loadBefore: async () => { olderReads += 1; },
          loadAround: async () => {},
          loadLatest: async () => {},
          async loadAfter(anchor: number | null, _maxBytes: number | undefined, navigation: number) {
            newerReads += 1;
            assert.equal(anchor, 3);
            for (const batch of encodeDesktopTranscriptPage(
              { ...identity, navigation },
              { durableThrough: 4, hasNewer: false, durable: [row(4, 'turn-c')] },
              { direction: 'newer', anchor },
            )) onBatch({ ...batch, deliverySequence: ++deliverySequence });
          },
          close: async () => undefined,
        };
      },
    } satisfies Pick<MakaBridge['transcripts'], 'open'>,
  } as unknown as Parameters<typeof createDesktopWorkHubServices>[0]);
  const handle = await services.openTranscript(
    sessionId,
    (snapshot) => { snapshots.push(snapshot); },
    new AbortController().signal,
    (error) => { throw error; },
  );
  const latest = () => snapshots.at(-1)!;
  try {
    await waitFor(() => latest()?.ready === true, { timeoutMs: 5_000 });
    assert.deepEqual(latest().messages.map(({ turnId }) => turnId), ['turn-a', 'turn-b']);
    assert.equal(await handle.prefetchHistory('newer'), true);
    assert.deepEqual(latest().messages.map(({ turnId }) => turnId), ['turn-a', 'turn-b', 'turn-c']);
    assert.equal(latest().hasNewer, false);
    assert.equal(await handle.prefetchHistory('newer'), false, 'a window at the tail has no newer edge to read');
    assert.equal(newerReads, 1);
    assert.equal(await handle.prefetchHistory('older'), true);
    assert.equal(await handle.prefetchHistory('older'), false, 'the same window answers an older read the same way');
    assert.equal(olderReads, 1);
    snapshots = [];
    handle.retain({ firstTurnId: 'turn-b', lastTurnId: 'turn-c' });
    assert.deepEqual(latest().messages.map(({ turnId }) => turnId), ['turn-b', 'turn-c']);
    assert.equal(latest().hasOlder, true, 'a trimmed edge becomes history again');
    // A trim moves the window, so the edge it re-opened is worth asking again.
    assert.equal(await handle.prefetchHistory('older'), true);
    assert.equal(olderReads, 2);
  } finally {
    await handle.close();
  }
});
