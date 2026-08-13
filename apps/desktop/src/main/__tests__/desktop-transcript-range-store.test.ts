import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoredMessage } from '@maka/core/session';
import {
  encodeDesktopTranscriptChange,
  encodeDesktopTranscriptSnapshot,
} from '../desktop-transcript-ipc.js';
import { DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES } from '../../preload/transcript-contract.js';
import {
  createDesktopTranscriptRangeController,
  DesktopTranscriptRangeStore,
} from '../../renderer/desktop-transcript-range-store.js';
import { mergeSettledMessages } from '../../renderer/session-message-settlement.js';
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

test('moves a fragmented overlay record to durable storage without duplicating it', () => {
  const message = assistantMessage('x'.repeat(DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES * 2));
  const identity = {
    sessionId: 'session-1',
    generation: 'generation-1',
    hostEpoch: 'host-1',
  };
  const store = new DesktopTranscriptRangeStore();
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

test('drops stale transcript batches after a generation reset', () => {
  const store = new DesktopTranscriptRangeStore();
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
  const latestPage = page('older');
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
        : { messages: messages.slice(4), nextCursor: 'older' },
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

test('reopens a failed transcript range with a fresh generation', async () => {
  const store = new DesktopTranscriptRangeStore();
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

test('cancels a transcript open that is still waiting for a Host', async () => {
  const store = new DesktopTranscriptRangeStore();
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

function continuitySnapshot() {
  return {
    schemaVersion: 3 as const,
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
