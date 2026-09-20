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

// Diagnostic only. Real IPC handler, matcher, subscription assembler and Host
// pager; synthetic transcript storage and transport. No database/UI latency.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.argv[2]) throw new Error('Pass the temporary bundle directory');
const out = resolve(process.argv[2]);
const {
  ClientSessionSubscription,
  runThreadSearch,
  decodeStoredMessage,
  createDefaultRuntimePolicy,
  registerRuntimeHostSearchIpc,
  createSessionTranscriptBootstrap,
  readSessionTranscriptPage,
} = await import(pathToFileURL(join(out, 'source.mjs')).href);
const QUERY = 'needleunique';
const SESSION = 'history-search-diagnosis';

function catalogSession(name) {
  return {
    id: SESSION,
    revision: 1,
    workspace: { target: { kind: 'host_path', path: '/fixture' }, hostCwd: '/fixture' },
    createdAt: 1,
    activityAt: 1,
    lastMessageAt: 1,
    name,
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionId: 'fixture',
    llmConnectionSlug: 'fixture',
    connectionLocked: true,
    model: 'fixture',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
  };
}

function fixture(total, hitIndex, stride = 1, hitCount = 1) {
  const rows = Array.from({ length: total }, (_, index) => {
    const bytes = Buffer.from(
      JSON.stringify({
        type: 'user',
        id: `message-${index}`,
        turnId: `turn-${index}`,
        ts: index + 1,
        text:
          hitIndex >= 0 && index >= hitIndex && index < hitIndex + hitCount
            ? QUERY
            : 'ordinary output '.repeat(8),
      }),
    );
    return { sequence: index * stride, bytes };
  });
  const throughSequence = rows.at(-1)?.sequence ?? null;
  const reader = {
    async readDurablePage(sessionId, request) {
      assert.equal(sessionId, SESSION);
      const older = request.direction === 'older';
      const position = request.position ?? (older ? throughSequence : 0);
      let index = older ? Math.floor(position / stride) : Math.ceil(position / stride);
      const fragments = [];
      let rawBytes = 0;
      let next = null;
      while (index >= 0 && index < rows.length) {
        const { sequence, bytes } = rows[index];
        assert.ok(sequence <= request.throughSequence);
        const edge =
          sequence === request.position && request.byteOffset !== undefined
            ? request.byteOffset
            : older
              ? bytes.length
              : 0;
        const remaining = older ? edge : bytes.length - edge;
        if (
          fragments.length === request.maxMessages ||
          rawBytes === request.maxBytes ||
          (fragments.length > 0 && rawBytes + remaining > request.maxBytes)
        ) {
          next = { position: sequence, byteOffset: null };
          break;
        }
        const size = Math.min(remaining, request.maxBytes - rawBytes);
        const byteOffset = older ? edge - size : edge;
        fragments.push({
          sequence,
          byteOffset,
          totalBytes: bytes.length,
          payloadDigest: null,
          data: bytes.subarray(byteOffset, byteOffset + size),
        });
        rawBytes += size;
        if (size < remaining) {
          next = { position: sequence, byteOffset: older ? byteOffset : byteOffset + size };
          break;
        }
        index += older ? -1 : 1;
      }
      return {
        throughSequence: request.throughSequence,
        fragments,
        rawBytes,
        next,
        endsAtTurnBoundary: next?.byteOffset == null,
      };
    },
  };
  return { reader, throughSequence };
}

async function runScenario({
  label,
  total,
  hitIndex = 0,
  limit = 1,
  titleHit = false,
  abortAtPage,
  firstForwardPageOnly = false,
  stride = 1,
  hitCount = 1,
}) {
  const data = fixture(total, hitIndex, stride, hitCount);
  const counts = {
    opened: 0,
    closed: 0,
    pageRequests: 0,
    decodedMessages: 0,
    messageJsonParses: 0,
    scannedMessageFields: 0,
    bootstrapMessages: 0,
    rawBytes: 0,
    beforeFirstCandidate: null,
  };
  const requestedDirections = new Set();
  const handlers = new Map();
  const event = { sender: new EventEmitter() };
  const name = titleHit ? QUERY : 'History review';
  const openSession = async () => {
    counts.opened += 1;
    const { bootstrap, state } = await createSessionTranscriptBootstrap({
      reader: data.reader,
      sessionId: SESSION,
      subscriptionId: 'diagnosis-subscription',
      throughSequence: data.throughSequence,
      maxBytes: 16 * 1024,
      projection: 'owner',
    });
    counts.bootstrapMessages += bootstrap.durable.fragments.length;
    counts.rawBytes += bootstrap.durable.rawBytes;
    const handle = new ClientSessionSubscription(
      {
        hostEpoch: 'epoch',
        subscriptionId: state.subscriptionId,
        nextSequence: 1,
        activeAssistantStreams: [],
        transcript: bootstrap,
        snapshot: { session: { sessionId: SESSION }, projectionRevision: 1 },
      },
      async () => {
        counts.closed += 1;
      },
      async (request) => {
        counts.pageRequests += 1;
        requestedDirections.add(request.direction);
        if (counts.pageRequests === abortAtPage) {
          await handlers.get('search:thread:cancel')(event, 'diagnosis-request');
        }
        const page = await readSessionTranscriptPage({ reader: data.reader, state, request });
        assert.ok(page.rawBytes <= request.maxBytes);
        counts.rawBytes += page.rawBytes;
        return page;
      },
      async () => {},
    );
    const decode = (value) => {
      counts.decodedMessages += 1;
      const message = decodeStoredMessage(value);
      const text = message.text;
      Object.defineProperty(message, 'text', {
        enumerable: true,
        get() {
          counts.scannedMessageFields += 1;
          counts.beforeFirstCandidate ??= {
            decodedMessages: counts.decodedMessages,
            pageRequests: counts.pageRequests,
          };
          return text;
        },
      });
      return message;
    };
    return {
      handle,
      decode,
      transcriptBootstrap: handle.transcriptBootstrap,
      snapshot: handle.snapshot,
      loadTranscriptPage: (input) => handle.loadTranscriptPage(input),
      decodeTranscriptPage: (page, maxMessageBytes, accountAssemblyBytes) =>
        handle.decodeTranscriptPage(page, decode, maxMessageBytes, accountAssemblyBytes),
      loadTranscript: () => handle.loadTranscript(decode),
      close: () => handle.close(),
    };
  };
  registerRuntimeHostSearchIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    client: {
      listSessions: async () => [catalogSession(name)],
      openSession,
      queryRuntimePolicy: async () => ({ revision: 1, policy: createDefaultRuntimePolicy() }),
    },
  });

  // Count actual message JSON parses separately from schema decoding. Cursor
  // parsing also uses JSON.parse, so count only fixture message objects.
  const originalParse = JSON.parse;
  JSON.parse = function (...args) {
    const result = originalParse.apply(JSON, args);
    if (result?.type === 'user' && result.id?.startsWith('message-')) counts.messageJsonParses += 1;
    return result;
  };
  let result;
  let forwardHasMore;
  let pageOnlyTruncated;
  try {
    if (firstForwardPageOnly) {
      // Feasibility probe, NOT a full streaming-search implementation. Fetch
      // exactly the oldest page, then pass that page to the unchanged matcher.
      const session = await openSession();
      try {
        const page = await session.handle.loadTranscriptPage({
          direction: 'newer',
          throughSequence: data.throughSequence,
          cursor: null,
          anchorSequence: null,
          maxBytes: 512 * 1024,
        });
        const decoded = await session.handle.decodeTranscriptPage(page, session.decode);
        assert.equal(decoded.messages[0].identity, 0);
        forwardHasMore = decoded.nextCursor !== null;
        const response = await runThreadSearch(
          { source: 'thread', query: QUERY, limit },
          {
            listSessions: async () => [catalogSession(name)],
            getPrivacyContext: async () => ({ incognitoActive: false }),
            async *readMessagePages() {
              yield {
                messages: decoded.messages.map(({ identity, message }) => ({
                  sequence: identity,
                  message,
                })),
                hasMore: false,
              };
            },
          },
        );
        assert.ok(response.ok);
        pageOnlyTruncated = response.truncated;
        result = response.results;
      } finally {
        await session.close();
      }
    } else {
      result = await handlers.get('search:thread')(
        event,
        { source: 'thread', query: QUERY, limit },
        'diagnosis-request',
      );
    }
  } finally {
    JSON.parse = originalParse;
  }

  assert.equal(counts.closed, counts.opened);
  assert.equal(event.sender.listenerCount('destroyed'), 0);
  assert.equal(event.sender.listenerCount('render-process-gone'), 0);
  if (abortAtPage !== undefined) {
    assert.equal(result.reason, 'aborted');
    assert.equal(counts.pageRequests, abortAtPage);
    assert.equal(counts.decodedMessages, 0);
  } else {
    assert.ok(Array.isArray(result));
    assert.equal(result.length, titleHit ? 1 : hitIndex >= 0 ? Math.min(limit, hitCount) : 0);
    if (hitIndex >= 0 && !titleHit) {
      assert.equal(result[0].target.sequence, hitIndex * stride);
      assert.equal(result[0].target.turnId, `turn-${hitIndex}`);
    }
  }
  return {
    label,
    total,
    hitIndex,
    hitCount,
    limit,
    stride,
    ...counts,
    directions: [...requestedDirections],
    outcome: Array.isArray(result)
      ? {
          results: result.length,
          matchedTurnIds: result.map((hit) => hit.target.turnId ?? null),
          first: result[0] ?? null,
        }
      : result,
    ...(forwardHasMore === undefined ? {} : { forwardHasMore, pageOnlyTruncated }),
    ...(hitIndex < 0 ? {} : { matchingFixtureSequence: hitIndex * stride }),
  };
}

const results = [];
for (const total of [2, 256, 5000, 20000]) {
  results.push(await runScenario({ label: `first-hit-${total}`, total }));
}
results.push(await runScenario({ label: 'first-hit-limit-10', total: 20000, limit: 10 }));
results.push(
  await runScenario({ label: 'ten-early-hits-baseline', total: 20000, limit: 10, hitCount: 10 }),
);
results.push(
  await runScenario({
    label: 'ten-early-hits-feasibility',
    total: 20000,
    limit: 10,
    hitCount: 10,
    firstForwardPageOnly: true,
  }),
);
results.push(await runScenario({ label: 'last-hit', total: 20000, hitIndex: 19999 }));
results.push(await runScenario({ label: 'no-hit', total: 20000, hitIndex: -1 }));
results.push(await runScenario({ label: 'title-only', total: 20000, titleHit: true }));
results.push(await runScenario({ label: 'cancel-first-page', total: 20000, abortAtPage: 1 }));
results.push(
  await runScenario({ label: 'oldest-page-feasibility', total: 20000, firstForwardPageOnly: true }),
);
results.push(await runScenario({ label: 'page-edge-hit-baseline', total: 20000, hitIndex: 255 }));
results.push(
  await runScenario({
    label: 'page-edge-hit-feasibility',
    total: 20000,
    hitIndex: 255,
    firstForwardPageOnly: true,
  }),
);
results.push(
  await runScenario({ label: 'sparse-sequence-control', total: 3, hitIndex: 1, stride: 8 }),
);
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
console.table(
  results.map(
    ({
      label,
      decodedMessages,
      messageJsonParses,
      pageRequests,
      scannedMessageFields,
      rawBytes,
    }) => ({
      label,
      decodedMessages,
      messageJsonParses,
      pageRequests,
      scannedMessageFields,
      rawBytes,
    }),
  ),
);

const baseline = results.find((row) => row.label === 'first-hit-20000');
assert.equal(baseline.scannedMessageFields, 1);
const forward = results.find((row) => row.label === 'oldest-page-feasibility');
assert.equal(forward.pageRequests, 1);
assert.equal(forward.decodedMessages, 256);
assert.equal(forward.forwardHasMore, true);
assert.deepEqual(forward.outcome.first.target.turnId, baseline.outcome.first.target.turnId);
assert.deepEqual(
  results.find((row) => row.label === 'ten-early-hits-baseline').outcome.matchedTurnIds,
  results.find((row) => row.label === 'ten-early-hits-feasibility').outcome.matchedTurnIds,
);
if (process.argv.includes('--check-budget')) {
  // The result budget bounds work to the first page, independent of the
  // transcript's total length. No wall-clock threshold is involved.
  assert.equal(baseline.decodedMessages, 256);
  assert.equal(baseline.pageRequests, 1);
  assert.equal(
    results.find((row) => row.label === 'page-edge-hit-baseline').outcome.first.truncated,
    true,
  );
}
