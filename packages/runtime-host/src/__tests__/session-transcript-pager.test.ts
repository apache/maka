import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoredMessage } from '@maka/core/session';
import {
  createSessionTranscriptBootstrap,
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
        return { throughSequence: null, messages: [], hasMore: false };
      }
      const candidates = durable
        .map((message, sequence) => {
          const data = JSON.stringify(message);
          return { sequence, data, encodedBytes: Buffer.byteLength(data, 'utf8') };
        })
        .filter(
          ({ sequence }) =>
            sequence <= throughSequence &&
            (request.direction === 'older'
              ? sequence < (request.cursor ?? throughSequence + 1)
              : sequence > (request.cursor ?? -1)),
        )
        .sort((left, right) =>
          request.direction === 'older'
            ? right.sequence - left.sequence
            : left.sequence - right.sequence,
        );
      const selected = [] as typeof candidates;
      let rawBytes = 0;
      for (const candidate of candidates) {
        if (selected.length >= request.maxMessages) break;
        if (selected.length > 0 && rawBytes + candidate.encodedBytes > request.maxBytes) break;
        selected.push(candidate);
        rawBytes += candidate.encodedBytes;
      }
      if (request.direction === 'older') selected.reverse();
      return {
        throughSequence,
        messages: selected,
        hasMore: selected.length < candidates.length,
      };
    },
    readActiveOverlay: async () => overlay,
  };
}
