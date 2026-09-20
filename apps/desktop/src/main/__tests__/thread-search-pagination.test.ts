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
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { markPersisted } from '@maka/core/persisted-value';
import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';
import type { SearchError, SearchRequest, SearchResult } from '@maka/core/search';
import { decodeStoredMessage, type StoredMessage } from '@maka/core/session';
import { deferred } from '@maka/core/test-only/async-primitives';
import {
  SESSION_CONTINUITY_SCHEMA_VERSION,
  type SessionCatalogProjection,
  type SessionTranscriptPageInput,
} from '@maka/runtime-host/protocol';
import { ClientSessionSubscription } from '../../../../../packages/runtime-host/dist/client/session-subscription.js';
import {
  createSessionTranscriptBootstrap,
  readSessionTranscriptPage,
  updateSubscriberTranscriptHighWater,
} from '../../../../../packages/runtime-host/dist/server/session-transcript-pager.js';
import { transcriptReader } from '../../../../../packages/runtime-host/dist/__tests__/fixtures/session-transcript-reader.js';
import type { IpcHandler } from '../ipc-reconnect-policy.js';
import { registerRuntimeHostSearchIpc } from '../runtime-host-search-ipc-main.js';
import { runtimeHostSessionFixture } from './runtime-host-session-test-fixture.js';

test('stops reading history after the oldest message satisfies the result limit', async () => {
  const fixture = searchFixture(messages(20_000, [0]));
  const hits = await fixture.search(1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.target?.turnId, 'turn-0');
  assert.equal(hits[0]!.truncated, true);
  assert.equal(fixture.counts.closed, 1);
  assert.equal(fixture.counts.decoded, 256, 'a result in the first page must not decode the rest of history');
  assert.equal(fixture.requests.length, 1, 'the result budget must stop transcript pagination');
  assert.equal(fixture.requests[0]!.direction, 'newer');
  assert.equal(fixture.requests[0]!.anchorSequence, null);
});

test('a match at the end of a page preserves truncation without reading another page', async () => {
  const fixture = searchFixture(messages(600, [255, 256]));
  const hits = await fixture.search(1);
  assert.deepEqual(hits.map((hit) => hit.target?.turnId), ['turn-255']);
  assert.equal(hits[0]!.truncated, true);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.counts.decoded, 256);
  assert.equal(fixture.counts.closed, 1);
});

test('keeps the first ten matches in transcript order across pages with sparse identities', async () => {
  const matching = Array.from({ length: 10 }, (_, index) => 250 + index);
  const fixture = searchFixture(messages(600, matching), { sequenceStride: 8 });
  const hits = await fixture.search(10);
  assert.deepEqual(hits.map((hit) => hit.target?.turnId), matching.map((index) => `turn-${index}`));
  assert.deepEqual(hits.map((hit) => hit.target?.sequence), matching.map((index) => index * 8));
  assert.equal(hits[9]!.truncated, true);
  assert.equal(fixture.requests.length, 2);
  assert.ok(fixture.requests.every((request) => request.direction === 'newer'));
  assert.equal(fixture.counts.decoded, 512);
});

test('uses a complete small bootstrap and marks a last-message match as complete', async () => {
  const fixture = searchFixture(messages(2, [1]), { sequenceStride: 8 });
  const hits = await fixture.search(1);
  assert.equal(hits[0]!.target?.turnId, 'turn-1');
  assert.equal(hits[0]!.target?.sequence, 8);
  assert.equal(hits[0]!.truncated, undefined);
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.counts.decoded, 2);
  assert.equal(fixture.counts.closed, 1);
});

test('empty history closes the reader and a title match never opens it', async () => {
  const empty = searchFixture([]);
  assert.deepEqual(await empty.search(1), []);
  assert.equal(empty.counts.closed, 1);
  const title = searchFixture(messages(600, [0]), { title: 'needleunique title' });
  const hits = await title.search(1);
  assert.equal(hits[0]!.summary, '任务标题');
  assert.equal(title.counts.opened, 0);
});

for (const matching of [[], [599], [1]] as const) {
  test(`scans all remaining pages when matches are insufficient: ${JSON.stringify(matching)}`, async () => {
    const fixture = searchFixture(messages(600, matching));
    const hits = await fixture.search(10);
    assert.deepEqual(hits.map((hit) => hit.target?.turnId), matching.map((index) => `turn-${index}`));
    assert.ok(hits.every((hit) => hit.truncated === undefined));
    assert.equal(fixture.requests.length, 3);
    assert.equal(fixture.counts.decoded, 600);
    assert.equal(fixture.counts.closed, 1);
  });
}

test('finishes a fragmented message before matching and stops before the following page', async () => {
  const durable = messages(600, []);
  durable[0] = { type: 'user', id: 'message-0', turnId: 'turn-0', ts: 1,
    text: `${'x'.repeat(600 * 1024)}needleunique` };
  const fixture = searchFixture(durable);
  const hits = await fixture.search(1);
  assert.equal(hits[0]!.target?.turnId, 'turn-0');
  assert.equal(hits[0]!.truncated, true);
  assert.equal(fixture.counts.decoded, 1);
  assert.equal(fixture.requests.length, 2, 'the second request completes the first message only');
  assert.equal(fixture.counts.closed, 1);
});

test('cancellation stops pagination after an in-flight page and closes exactly once', async () => {
  const started = deferred<void>();
  const release = deferred<void>();
  const fixture = searchFixture(messages(600, [0]), {
    beforePage: async () => { started.resolve(); await release.promise; },
  });
  const pending = fixture.run(1);
  await started.promise;
  await fixture.cancel();
  assert.equal(fixture.counts.closed, 1);
  release.resolve();
  const outcome = await pending;
  assert.ok(!Array.isArray(outcome));
  assert.equal(outcome.reason, 'aborted');
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.counts.decoded, 0);
  assert.equal(fixture.counts.closed, 1);
});

test('discards partial transcript matches on a later read failure while retaining its title', async () => {
  const fixture = searchFixture(messages(600, [0]), {
    title: 'needleunique title',
    beforePage: async (_request, index) => {
      if (index === 2) throw new Error('transcript unavailable');
    },
  });
  const hits = await fixture.search(10);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.summary, '任务标题');
  assert.equal(fixture.counts.decoded, 256);
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.counts.closed, 1);
});

test('keeps the opening watermark while new transcript messages arrive', async () => {
  const durable = messages(600, []);
  const fixture = searchFixture(durable, {
    beforePage: async (_request, index) => {
      if (index === 1) durable.push({ type: 'user', id: 'new', turnId: 'new', ts: 601, text: 'needleunique' });
    },
  });
  assert.deepEqual(await fixture.search(1), []);
  assert.equal(fixture.counts.decoded, 600);
  assert.ok(fixture.requests.every((request) => request.throughSequence === 599));
});

function messages(count: number, matching: readonly number[]): StoredMessage[] {
  const hits = new Set(matching);
  return Array.from({ length: count }, (_, index) => ({
    type: 'user', id: `message-${index}`, turnId: `turn-${index}`, ts: index + 1,
    text: hits.has(index) ? 'needleunique' : 'ordinary output '.repeat(8),
  }));
}

function searchFixture(durable: StoredMessage[], options: {
  sequenceStride?: number;
  title?: string;
  beforePage?: (request: SessionTranscriptPageInput, index: number) => Promise<void>;
} = {}) {
  const sessionId = 'history-session';
  const handlers = new Map<string, IpcHandler>();
  const sender = new EventEmitter();
  const event = { sender } as Parameters<IpcHandler>[0];
  const counts = { opened: 0, closed: 0, decoded: 0 };
  const requests: SessionTranscriptPageInput[] = [];
  const reader = transcriptReader(durable, options.sequenceStride);
  const catalog: SessionCatalogProjection = {
    id: sessionId, revision: 1,
    workspace: { target: { kind: 'host_path', path: '/fixture' }, hostCwd: '/fixture' },
    createdAt: 1, activityAt: 1, lastMessageAt: 1, name: options.title ?? 'History',
    isFlagged: false, isArchived: false, labels: [], labelsTruncated: false,
    hasUnread: false, status: 'active', backend: 'ai-sdk', llmConnectionId: 'fixture',
    llmConnectionSlug: 'fixture', connectionLocked: true, model: 'fixture',
    permissionMode: 'ask', collaborationMode: 'agent', orchestrationMode: 'default',
  };
  registerRuntimeHostSearchIpc({
    ipcMain: { handle: (channel, listener) => { handlers.set(channel, listener); } },
    client: {
      listSessions: async () => [catalog],
      queryRuntimePolicy: async () => ({ revision: 1, policy: createDefaultRuntimePolicy() }),
      openSession: async () => {
        counts.opened += 1;
        const throughSequence = await reader.readDurableHighWater(sessionId);
        const { bootstrap, state } = await createSessionTranscriptBootstrap({
          reader, sessionId, subscriptionId: 'search-subscription', throughSequence,
          maxBytes: 16 * 1024, projection: 'owner',
        });
        const subscription = new ClientSessionSubscription({
          hostEpoch: 'search-host', subscriptionId: state.subscriptionId, nextSequence: 1,
          activeAssistantStreams: [], transcript: bootstrap,
          snapshot: {
            schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
            session: { sessionId, metadataRevision: 1, status: 'active', createdAt: 1, isArchived: false },
            projectionRevision: 1, rootTurn: null, goal: null,
            queue: { hostEpoch: 'search-host', queueRevision: 0, steering: [], followup: [] },
            interactions: { pending: [] },
          },
        }, async () => { counts.closed += 1; }, async (request) => {
          requests.push(request);
          await options.beforePage?.(request, requests.length);
          updateSubscriberTranscriptHighWater(state, await reader.readDurableHighWater(sessionId));
          return readSessionTranscriptPage({ reader, state, request });
        }, async () => {});
        const decode = (value: unknown) => {
          counts.decoded += 1;
          return decodeStoredMessage(markPersisted<StoredMessage>(value));
        };
        return {
          ...runtimeHostSessionFixture({
            snapshot: subscription.snapshot, events: subscription, transcript: Promise.resolve([]),
            transcriptBootstrap: bootstrap,
            decodeTranscriptPage: (page, maxBytes, accountBytes) =>
              subscription.decodeTranscriptPage(page, decode, maxBytes, accountBytes),
            loadTranscriptPage: (request) => subscription.loadTranscriptPage(request),
            close: () => subscription.close(),
          }),
          loadTranscript: () => subscription.loadTranscript(decode),
        };
      },
    },
  });
  const run = async (limit: number): Promise<SearchResult[] | SearchError> => {
    const request: SearchRequest = { source: 'thread', query: 'needleunique', limit };
    const outcome: SearchResult[] | SearchError = await handlers.get('search:thread')!(event, request, 'query');
    assert.equal(sender.listenerCount('destroyed'), 0);
    assert.equal(sender.listenerCount('render-process-gone'), 0);
    return outcome;
  };
  return {
    counts, requests, run,
    cancel: () => handlers.get('search:thread:cancel')!(event, 'query'),
    async search(limit: number): Promise<SearchResult[]> {
      const outcome = await run(limit);
      assert.ok(Array.isArray(outcome));
      return outcome;
    },
  };
}
