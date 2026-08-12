import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoredMessage } from '@maka/core/session';
import {
  createSessionTranscriptBootstrap,
  prepareSessionTranscriptOverlay,
  readSessionTranscriptPage,
  TranscriptPageRequestError,
  updateSubscriberTranscriptHighWater,
} from '../server/session-transcript-pager.js';
import type { SessionTranscriptReader } from '../server/session-transcript-reader.js';

test('reads newly durable messages forward from an announced watermark', async () => {
  const durable = [userMessage(0), userMessage(1)];
  const reader = transcriptReader(durable);
  const { bootstrap, state } = await createSessionTranscriptBootstrap({
    reader,
    sessionId: 'session-1',
    subscriptionId: 'subscription-1',
    rootTurn: null,
    activeAssistantStreams: [],
    maxBytes: 1024,
  });
  assert.equal(bootstrap.throughSequence, 1);

  durable.push(userMessage(2), userMessage(3));
  assert.equal(updateSubscriberTranscriptHighWater(state, 3), true);
  const page = await readSessionTranscriptPage({
    reader,
    state,
    request: {
      subscriptionId: 'subscription-1',
      source: 'durable',
      direction: 'newer',
      throughSequence: 3,
      cursor: null,
      anchorSequence: 1,
      maxBytes: 1024,
    },
  });
  assert.deepEqual(
    page.fragments.map((fragment) =>
      fragment.kind === 'durable' ? fragment.sequence : fragment.messageIndex,
    ),
    [2, 3],
  );
  assert.equal(page.nextCursor, null);
});

test('rejects cursor tampering and cross-subscription replay', async () => {
  const reader = transcriptReader([userMessage(0, 'x'.repeat(2_000))]);
  const first = await createSessionTranscriptBootstrap({
    reader,
    sessionId: 'session-1',
    subscriptionId: 'subscription-1',
    rootTurn: null,
    activeAssistantStreams: [],
    maxBytes: 128,
  });
  const second = await createSessionTranscriptBootstrap({
    reader,
    sessionId: 'session-1',
    subscriptionId: 'subscription-2',
    rootTurn: null,
    activeAssistantStreams: [],
    maxBytes: 128,
  });
  const cursor = first.bootstrap.durable.nextCursor;
  assert.ok(cursor);
  if (!cursor) return;
  const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`;
  const request = {
    subscriptionId: 'subscription-1',
    source: 'durable' as const,
    direction: 'older' as const,
    throughSequence: 0,
    cursor,
    anchorSequence: null,
    maxBytes: 128,
  };

  await assert.rejects(
    readSessionTranscriptPage({
      reader,
      state: first.state,
      request: { ...request, cursor: tampered },
    }),
    TranscriptPageRequestError,
  );
  await assert.rejects(
    readSessionTranscriptPage({ reader, state: second.state, request }),
    TranscriptPageRequestError,
  );
});

test('keeps a durable continuation when overlay bytes reduce the bootstrap budget', async () => {
  const durable = [userMessage(0, 'a'.repeat(240)), userMessage(1, 'b'.repeat(240))];
  const reader = transcriptReader(durable, [userMessage(0, 'overlay'.repeat(40))]);
  const { bootstrap } = await createSessionTranscriptBootstrap({
    reader,
    sessionId: 'session-1',
    subscriptionId: 'subscription-1',
    rootTurn: null,
    activeAssistantStreams: [],
    maxBytes: Buffer.byteLength(JSON.stringify(durable[0]), 'utf8') * 2,
  });
  assert.ok(bootstrap.overlay.rawBytes > 0);
  assert.ok(bootstrap.durable.nextCursor);
});

test('shrinks the raw bootstrap until it fits its aggregate encoded budget', async () => {
  const durable = Array.from({ length: 100 }, (_, index) => userMessage(index, `message-${index}`));
  const { bootstrap } = await createSessionTranscriptBootstrap({
    reader: transcriptReader(durable),
    sessionId: 'session-1',
    subscriptionId: 'subscription-1',
    rootTurn: null,
    activeAssistantStreams: [],
    maxBytes: 16 * 1024,
    maxEncodedBytes: 4 * 1024,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(bootstrap), 'utf8') <= 4 * 1024);
  assert.ok(bootstrap.durable.nextCursor);
});

test('rejects an active overlay that exceeds its retained message bound', async () => {
  const overlay = Array.from({ length: 4_097 }, (_, index) => userMessage(index));
  await assert.rejects(
    prepareSessionTranscriptOverlay({
      reader: transcriptReader([], overlay),
      sessionId: 'session-1',
      rootTurn: null,
      activeAssistantStreams: [],
    }),
    /overlay exceeds its message limit/,
  );
});

function userMessage(index: number, text = `message-${index}`): StoredMessage {
  return {
    type: 'user',
    id: `message-${index}`,
    turnId: `turn-${index}`,
    ts: index + 1,
    text,
  };
}

function transcriptReader(
  durable: readonly StoredMessage[],
  overlay: readonly StoredMessage[] = [],
): SessionTranscriptReader {
  return {
    readDurableHighWater: async () => (durable.length === 0 ? null : durable.length - 1),
    readDurablePage: async (_sessionId, request) => {
      const throughSequence =
        request.throughSequence ?? (durable.length === 0 ? null : durable.length - 1);
      if (throughSequence === null) {
        return { throughSequence: null, fragments: [], rawBytes: 0, next: null };
      }
      const position = request.position ?? (request.direction === 'older' ? throughSequence : 0);
      const candidates = durable
        .map((message, sequence) => {
          const data = Buffer.from(JSON.stringify(message), 'utf8');
          return { sequence, data };
        })
        .filter(
          ({ sequence }) =>
            sequence <= throughSequence &&
            (request.direction === 'older' ? sequence <= position : sequence >= position),
        )
        .sort((left, right) =>
          request.direction === 'older'
            ? right.sequence - left.sequence
            : left.sequence - right.sequence,
        );
      const fragments = [] as Array<{
        sequence: number;
        byteOffset: number;
        totalBytes: number;
        data: Buffer;
      }>;
      let rawBytes = 0;
      let next: { position: number; byteOffset: number | null } | null = null;
      for (const candidate of candidates) {
        if (fragments.length >= request.maxMessages || rawBytes >= request.maxBytes) break;
        const continued = candidate.sequence === position && request.byteOffset !== undefined;
        const edge = continued
          ? request.byteOffset!
          : request.direction === 'older'
            ? candidate.data.byteLength
            : 0;
        const available = request.maxBytes - rawBytes;
        const byteOffset = request.direction === 'older' ? Math.max(0, edge - available) : edge;
        const end =
          request.direction === 'older'
            ? edge
            : Math.min(candidate.data.byteLength, edge + available);
        fragments.push({
          sequence: candidate.sequence,
          byteOffset,
          totalBytes: candidate.data.byteLength,
          data: candidate.data.subarray(byteOffset, end),
        });
        rawBytes += end - byteOffset;
        const complete =
          request.direction === 'older' ? byteOffset === 0 : end === candidate.data.byteLength;
        if (!complete) {
          next = {
            position: candidate.sequence,
            byteOffset: request.direction === 'older' ? byteOffset : end,
          };
          break;
        }
      }
      if (next === null && fragments.length > 0 && fragments.length < candidates.length) {
        next = {
          position: fragments.at(-1)!.sequence + (request.direction === 'older' ? -1 : 1),
          byteOffset: null,
        };
      }
      return {
        throughSequence,
        fragments,
        rawBytes,
        next,
      };
    },
    readDurableMessagesById: async (_sessionId, messageIds) =>
      durable.filter((message) => messageIds.includes(message.id)),
    readActiveOverlay: async () => overlay,
  };
}
