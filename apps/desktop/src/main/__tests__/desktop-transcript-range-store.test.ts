import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoredMessage } from '@maka/core/session';
import { SESSION_CONTINUITY_SCHEMA_VERSION } from '@maka/runtime-host/protocol';
import {
  encodeDesktopTranscriptChange,
  encodeDesktopTranscriptSnapshot,
} from '../desktop-transcript-ipc.js';
import { DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES } from '../../preload/transcript-contract.js';
import {
  createDesktopTranscriptRangeController,
  DesktopTranscriptRangeStore,
} from '../../renderer/desktop-transcript-range-store.js';
import {
  mergeSettledMessages,
  readSettledMessages,
} from '../../renderer/session-message-settlement.js';
import { DesktopTranscriptReplica } from '../desktop-transcript-replica.js';
import { runtimeHostSessionFixture } from './runtime-host-session-test-fixture.js';

test('merges a settled tail without dropping earlier messages', () => {
  const earlier = assistantMessage('earlier', 'assistant-earlier');
  const current = assistantMessage('partial', 'assistant-current');
  const settled = assistantMessage('complete', current.id);
  const latest = assistantMessage('latest', 'assistant-latest');

  assert.deepEqual(mergeSettledMessages([earlier, current], [settled, latest]), [
    earlier,
    settled,
    latest,
  ]);
});

test('cancels settlement while transcript open is pending', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let cancelled = false;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      maka: {
        transcripts: {
          open: async (
            _sessionId: string,
            _handler: unknown,
            registerCancellation: (cancel: () => void) => void,
          ) => new Promise<never>((_resolve, reject) => {
            registerCancellation(() => {
              cancelled = true;
              reject(new Error('open cancelled'));
            });
          }),
        },
      },
    },
  });
  const controller = new AbortController();
  try {
    const settling = readSettledMessages(JSON.stringify(['host-1', 'session-1']), {
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(settling, /settlement was cancelled/);
    assert.equal(cancelled, true);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('moves a fragmented overlay record to durable storage without duplicating it', () => {
  const message = assistantMessage('x'.repeat(DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES * 2));
  const identity = {
    sessionId: 'session-1',
    generation: 'generation-1',
    hostEpoch: 'host-1',
  };
  const store = transcriptStore();
  const snapshot = [...encodeDesktopTranscriptSnapshot({
    ...identity,
    durableThrough: null,
    durable: [],
    overlay: [message],
    hasOlder: false,
    hasNewer: false,
  })];

  assert.ok(snapshot.length > 1);
  for (const [index, batch] of snapshot.entries()) {
    assert.ok(
      batch.fragments.reduce(
        (total, fragment) => total + fragment.data.byteLength,
        0,
      ) <= DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES,
    );
    assert.equal(store.accept(batch), index === snapshot.length - 1);
  }
  assert.deepEqual(store.snapshot().messages, [message]);
  assert.equal(store.hasDurableMessage(message.id), false);

  const change = [...encodeDesktopTranscriptChange(identity, {
    durableThrough: 4,
    durableUpserts: [{ sequence: 4, message }],
    evictedDurableSequences: [],
    completedOverlayMessageIds: [message.id],
    hasOlder: true,
    hasNewer: false,
  })];
  for (const batch of change) store.accept(batch);
  assert.deepEqual(store.snapshot().messages, [message]);
  assert.equal(store.hasDurableMessage(message.id), true);

  for (const batch of change) assert.equal(store.accept(batch), false);
  assert.deepEqual(store.snapshot().messages, [message]);
});

test('retains the newest observed durable prompt across eviction', () => {
  const identity = {
    sessionId: 'session-1',
    generation: 'generation-1',
    hostEpoch: 'host-1',
  };
  const store = transcriptStore();
  for (const batch of encodeDesktopTranscriptSnapshot({
    ...identity,
    durableThrough: 3,
    durable: [
      { sequence: 1, message: userMessage('older', 'user-1') },
      { sequence: 2, message: assistantMessage('answer') },
      { sequence: 3, message: userMessage('newer', 'user-3') },
    ],
    overlay: [],
    hasOlder: false,
    hasNewer: false,
  })) store.accept(batch);
  assert.equal(store.newestDurableUserSequence(), 3);

  for (const batch of encodeDesktopTranscriptChange(identity, {
    durableThrough: 4,
    durableUpserts: [{ sequence: 4, message: assistantMessage('latest') }],
    evictedDurableSequences: [3],
    completedOverlayMessageIds: [],
    hasOlder: false,
    hasNewer: false,
  })) store.accept(batch);
  assert.equal(store.newestDurableUserSequence(), 3);
});

test('drops stale transcript batches after a generation reset', () => {
  const store = transcriptStore();
  const oldBatches = [...encodeDesktopTranscriptSnapshot({
    sessionId: 'session-1',
    generation: 'old',
    hostEpoch: 'host-1',
    durableThrough: 1,
    durable: [{ sequence: 1, message: assistantMessage('old') }],
    overlay: [],
    hasOlder: false,
    hasNewer: false,
  })];
  const nextMessage = assistantMessage('new');
  const nextBatches = [...encodeDesktopTranscriptSnapshot({
    sessionId: 'session-1',
    generation: 'next',
    hostEpoch: 'host-2',
    durableThrough: 2,
    durable: [{ sequence: 2, message: nextMessage }],
    overlay: [],
    hasOlder: true,
    hasNewer: false,
  })];

  for (const batch of oldBatches) store.accept(batch);
  for (const batch of nextBatches) store.accept(batch);
  const staleChange = [...encodeDesktopTranscriptChange(
    { sessionId: 'session-1', generation: 'old', hostEpoch: 'host-1' },
    {
      durableThrough: 3,
      durableUpserts: [{ sequence: 3, message: assistantMessage('stale') }],
      evictedDurableSequences: [],
      completedOverlayMessageIds: [],
      hasOlder: false,
      hasNewer: false,
    },
  )];
  for (const batch of staleChange) assert.equal(store.accept(batch), false);
  assert.deepEqual(store.snapshot().messages, [nextMessage]);
});

test('keeps a bounded contiguous window while moving between history and the tail', async () => {
  const messages = [0, 1, 2, 3, 4].map((sequence) => ({
    identity: sequence,
    message: assistantMessage(String(sequence), `assistant-${sequence}`),
  }));
  const page = (nextCursor: string | null) => ({
    kind: 'page' as const,
    sessionId: 'session-1',
    source: 'durable' as const,
    direction: 'older' as const,
    throughSequence: 4,
    rawBytes: 1,
    fragments: [],
    nextCursor,
  });
  const bootstrapPage = page('older');
  const olderPage = page('older');
  const latestPage = page(null);
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    transcriptBootstrap: {
      throughSequence: 4,
      overlayMessageCount: 0,
      durable: bootstrapPage,
      overlay: { ...page(null), source: 'overlay' },
    },
    loadTranscriptOverlay: async () => [],
    decodeTranscriptPage: async (candidate) => candidate === bootstrapPage
      ? { messages: messages.slice(3), nextCursor: 'older' }
      : candidate === olderPage
        ? { messages: messages.slice(2, 4), nextCursor: 'older' }
        : { messages: messages.slice(4), nextCursor: null },
    loadTranscriptPage: async (input) => input.anchorSequence === 4 ? olderPage : latestPage,
    async close() {},
  });
  const maxResidentBytes = Buffer.byteLength(JSON.stringify(messages[0]!.message), 'utf8') + 1;
  const replica = await DesktopTranscriptReplica.prepare(handle, {
    maxResidentBytes,
  });

  assert.deepEqual(replica.snapshot().durable.map(({ sequence }) => sequence), [4]);
  await replica.loadBefore(4, 128 * 1024);
  assert.deepEqual(replica.snapshot().durable.map(({ sequence }) => sequence), [2]);
  assert.equal(replica.snapshot().hasNewer, true);

  await replica.loadAround(4, 128 * 1024);
  assert.deepEqual(replica.snapshot().durable.map(({ sequence }) => sequence), [4]);
  assert.equal(replica.snapshot().hasNewer, false);
  assert.ok(replica.residentBytes <= maxResidentBytes);
});

test('loads a history target with newer messages available below it', async () => {
  const messages = [0, 1, 2, 3, 4].map((sequence) => ({
    identity: sequence,
    message: assistantMessage(String(sequence), `assistant-${sequence}`),
  }));
  const bootstrapPage = transcriptPage('older', null, 4);
  const aroundPage = transcriptPage('newer', 'newer', 4);
  let aroundInput: { direction: string; anchorSequence: number | null } | undefined;
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    transcriptBootstrap: {
      throughSequence: 4,
      overlayMessageCount: 0,
      durable: bootstrapPage,
      overlay: { ...transcriptPage('older', null, 4), source: 'overlay' },
    },
    loadTranscriptOverlay: async () => [],
    decodeTranscriptPage: async (page) => page === bootstrapPage
      ? { messages: messages.slice(4), nextCursor: null }
      : { messages: messages.slice(0, 3), nextCursor: 'newer' },
    loadTranscriptPage: async (input) => {
      aroundInput = input;
      return aroundPage;
    },
    async close() {},
  });
  const replica = await DesktopTranscriptReplica.prepare(handle, {
    maxResidentBytes: 128 * 1024,
  });

  await replica.loadAround(0, 128 * 1024);

  assert.equal(aroundInput?.direction, 'newer');
  assert.equal(aroundInput?.anchorSequence, null);
  assert.deepEqual(replica.snapshot().durable.map(({ sequence }) => sequence), [0, 1, 2]);
  assert.equal(replica.snapshot().hasOlder, false);
  assert.equal(replica.snapshot().hasNewer, true);
});

test('rejects an overlay that exceeds its cache budget', async () => {
  const messages = [
    assistantMessage('x'.repeat(700), 'overlay-1'),
    assistantMessage('y'.repeat(700), 'overlay-2'),
  ];
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    loadTranscriptOverlay: async () => messages,
    async close() {},
  });

  await assert.rejects(
    DesktopTranscriptReplica.prepare(handle, {
      maxResidentBytes: 1_024,
      maxOverlayBytes: 1_024,
      maxMessageBytes: 1_024,
    }),
    /overlay exceeds the session cache limit/,
  );
});

test('keeps history resident when an active overlay uses its own cache budget', async () => {
  const overlay = assistantMessage('o'.repeat(700), 'overlay-1');
  const historical = assistantMessage('h'.repeat(700), 'history-1');
  const bootstrapPage = transcriptPage('older', 'older', 1);
  const olderPage = transcriptPage('older', null, 1);
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    transcriptBootstrap: {
      throughSequence: 1,
      overlayMessageCount: 1,
      durable: bootstrapPage,
      overlay: { ...transcriptPage('older', null, 1), source: 'overlay' },
    },
    loadTranscriptOverlay: async () => [overlay],
    decodeTranscriptPage: async (page) => page === olderPage
      ? { messages: [{ identity: 0, message: historical }], nextCursor: null }
      : { messages: [], nextCursor: 'older' },
    loadTranscriptPage: async () => olderPage,
    async close() {},
  });
  const replica = await DesktopTranscriptReplica.prepare(handle, {
    maxResidentBytes: 1_024,
    maxOverlayBytes: 1_024,
    maxMessageBytes: 1_024,
  });

  await replica.loadBefore(null, 128 * 1024);

  assert.deepEqual(replica.snapshot().durable.map(({ sequence }) => sequence), [0]);
  assert.equal(replica.snapshot().hasOlder, false);
});

test('transfers prepared transcript bytes into active replica accounting', async () => {
  const message = assistantMessage('prepared', 'overlay-1');
  const messageBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
  let accountedBytes = 0;
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    loadTranscriptOverlay: async (_maxMessageBytes, accountAssemblyBytes) => {
      accountAssemblyBytes?.(messageBytes);
      accountAssemblyBytes?.(-messageBytes);
      return [message];
    },
    async close() {},
  });

  const replica = await DesktopTranscriptReplica.prepare(handle, {
    accountPreparationBytes: (deltaBytes) => {
      accountedBytes += deltaBytes;
    },
  });
  assert.equal(accountedBytes, messageBytes);
  replica.adoptResidentAccounting();
  assert.equal(accountedBytes, 0);
  replica.close();
  assert.equal(accountedBytes, 0);
});

test('does not release resident bytes when preparation accounting rejects them', async () => {
  const message = assistantMessage('prepared', 'overlay-1');
  const deltas: number[] = [];
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    loadTranscriptOverlay: async () => [message],
    async close() {},
  });

  await assert.rejects(
    DesktopTranscriptReplica.prepare(handle, {
      accountPreparationBytes: (deltaBytes) => {
        deltas.push(deltaBytes);
        if (deltaBytes > 0) throw new RangeError('capacity reached');
      },
    }),
    /capacity reached/,
  );
  assert.deepEqual(deltas.filter((deltaBytes) => deltaBytes < 0), []);
});

test('reopens a failed transcript range with a fresh generation', async () => {
  const store = transcriptStore();
  let attempts = 0;
  const controller = createDesktopTranscriptRangeController(store, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('open failed');
    for (const batch of encodeDesktopTranscriptSnapshot({
      sessionId: 'session-1',
      generation: 'reloaded',
      hostEpoch: 'host-2',
      durableThrough: null,
      durable: [],
      overlay: [],
      hasOlder: false,
      hasNewer: false,
    }))
      store.accept(batch);
    return {
      sessionId: 'session-1',
      generation: 'reloaded',
      hostEpoch: 'host-2',
      readThroughMessageId: null,
      async loadBefore() {},
      async loadAround() {},
      async close() {},
    };
  });

  await assert.rejects(() => controller.ready(), /open failed/);
  await controller.reload();
  assert.equal(store.range().generation, 'reloaded');
  await controller.close();
});

test('forwards a larger logical history range without changing batch size', async () => {
  const store = transcriptStore();
  for (const batch of encodeDesktopTranscriptSnapshot({
    sessionId: 'session-1',
    generation: 'generation-1',
    hostEpoch: 'host-1',
    durableThrough: 1,
    durable: [{ sequence: 1, message: assistantMessage('latest') }],
    overlay: [],
    hasOlder: true,
    hasNewer: false,
  })) store.accept(batch);
  let request: { anchorSequence: number | null; maxBytes?: number } | undefined;
  const controller = createDesktopTranscriptRangeController(store, async () => ({
    sessionId: 'session-1',
    generation: 'generation-1',
    hostEpoch: 'host-1',
    readThroughMessageId: 'assistant-1',
    async loadBefore(anchorSequence, maxBytes) {
      request = { anchorSequence, maxBytes };
    },
    async loadAround() {},
    async close() {},
  }));

  await controller.loadBefore(512 * 1024);

  assert.deepEqual(request, { anchorSequence: 1, maxBytes: 512 * 1024 });
  await controller.close();
});

test('waits for the required durable message on the current transcript generation', async () => {
  const store = transcriptStore();
  const identity = {
    sessionId: 'session-1',
    generation: 'generation-1',
    hostEpoch: 'host-1',
  };
  for (const batch of encodeDesktopTranscriptSnapshot({
    ...identity,
    durableThrough: null,
    durable: [],
    overlay: [],
    hasOlder: false,
    hasNewer: false,
  })) store.accept(batch);
  const waiting = store.waitForDurableMessage('assistant-1', 100);
  for (const batch of encodeDesktopTranscriptChange(identity, {
    durableThrough: 0,
    durableUpserts: [{ sequence: 0, message: assistantMessage('complete') }],
    evictedDurableSequences: [],
    completedOverlayMessageIds: [],
    hasOlder: false,
    hasNewer: false,
  })) store.accept(batch);

  assert.equal(await waiting, true);
});

test('cancels a transcript open that is still waiting for a Host', async () => {
  const store = transcriptStore();
  let openSignal: AbortSignal | undefined;
  const controller = createDesktopTranscriptRangeController(
    store,
    (signal) =>
      new Promise((_resolve, reject) => {
        openSignal = signal;
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      }),
  );

  await controller.close();
  assert.equal(openSignal?.aborted, true);
});

function assistantMessage(
  text: string,
  id = 'assistant-1',
): Extract<StoredMessage, { type: 'assistant' }> {
  return {
    type: 'assistant',
    id,
    turnId: 'turn-1',
    ts: 1,
    text,
    modelId: 'model-1',
  };
}

function transcriptStore(): DesktopTranscriptRangeStore {
  return new DesktopTranscriptRangeStore(JSON.stringify(['host-1', 'session-1']));
}

function userMessage(
  text: string,
  id: string,
): Extract<StoredMessage, { type: 'user' }> {
  return {
    type: 'user',
    id,
    turnId: id.replace('user-', 'turn-'),
    ts: 1,
    text,
  };
}

function transcriptPage(
  direction: 'older' | 'newer',
  nextCursor: string | null,
  throughSequence: number,
) {
  return {
    kind: 'page' as const,
    sessionId: 'session-1',
    source: 'durable' as const,
    direction,
    throughSequence,
    rawBytes: 1,
    fragments: [],
    nextCursor,
  };
}

function continuitySnapshot() {
  return {
    schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
    session: {
      sessionId: 'session-1',
      metadataRevision: 1,
      status: 'running' as const,
      createdAt: 1,
      lastUsedAt: 1,
      isArchived: false,
    },
    projectionRevision: 1,
    rootTurn: null,
    goal: null,
    queue: {
      hostEpoch: 'host-1',
      queueRevision: 0,
      steering: [],
      followup: [],
    },
    interactions: { pending: [] },
  };
}
