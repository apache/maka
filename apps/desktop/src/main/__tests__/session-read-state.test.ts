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
import { describe, it } from 'node:test';
import type { SessionSummary, StoredMessage } from '@maka/core/session';
import {
  applyLocalSessionRead,
  applySessionReadOverrides,
  createSessionListRefresher,
  rememberSessionReadBoundary,
  type SessionReadBoundaries,
} from '../../renderer/session-read-state.js';

describe('renderer session read state', () => {
  it('keeps a late stale list response from restoring unread on a locally read session', async () => {
    const readBoundaries: SessionReadBoundaries = {};
    const staleList = deferred<SessionSummary[]>();

    const listAfterLocalRead = staleList.promise.then((sessions) => applySessionReadOverrides(sessions, readBoundaries));
    rememberSessionReadBoundary(readBoundaries, 's1', [messageAt(200)]);
    staleList.resolve([session({ id: 's1', hasUnread: true, lastMessageAt: 200 })]);

    assert.equal((await listAfterLocalRead)[0]?.hasUnread, false);
  });

  it('allows a newer message to restore unread after the local read boundary', () => {
    const readBoundaries: SessionReadBoundaries = {};
    rememberSessionReadBoundary(readBoundaries, 's1', [messageAt(200)]);

    const [next] = applySessionReadOverrides([
      session({ id: 's1', hasUnread: true, lastMessageAt: 250 }),
    ], readBoundaries);

    assert.equal(next?.hasUnread, true);
  });

  it('keeps the same list reference when no read override applies', () => {
    const sessions = [session({ id: 's1', hasUnread: true, lastMessageAt: 250 })];

    const next = applySessionReadOverrides(sessions, {});

    assert.equal(next, sessions);
  });

  it('keeps newer unread when an older local read result arrives later', () => {
    const readBoundaries: SessionReadBoundaries = {};

    const [next] = applyLocalSessionRead(
      readBoundaries,
      [session({ id: 's1', hasUnread: true, lastMessageAt: 250 })],
      's1',
      [messageAt(200)],
    );

    assert.equal(next?.lastMessageAt, 250);
    assert.equal(next?.hasUnread, true);
  });

  it('clears unread when a local read reaches the current last message', () => {
    const readBoundaries: SessionReadBoundaries = {};

    const [next] = applyLocalSessionRead(
      readBoundaries,
      [session({ id: 's1', hasUnread: true, lastMessageAt: 200 })],
      's1',
      [messageAt(200)],
    );

    assert.equal(next?.lastMessageAt, 200);
    assert.equal(next?.hasUnread, false);
  });

  it('coalesces concurrent refreshes into one in-flight request and one trailing request', async () => {
    const readBoundaries: SessionReadBoundaries = {};
    const firstList = deferred<SessionSummary[]>();
    const trailingList = deferred<SessionSummary[]>();
    const listResults = [firstList.promise, trailingList.promise];
    let listCalls = 0;
    let currentSessions: SessionSummary[] = [];
    const refresher = createSessionListRefresher({
      captureRequestContext: () => undefined,
      listSessions: async () => {
        const result = listResults[listCalls];
        listCalls += 1;
        return result ?? [];
      },
      readBoundaries: () => readBoundaries,
      currentSessions: () => currentSessions,
      commitSessions: (next) => {
        currentSessions = next;
      },
      onError: () => {},
    });

    rememberSessionReadBoundary(readBoundaries, 's1', [messageAt(200)]);
    const firstRefresh = refresher.refresh();
    const secondRefresh = refresher.refresh();
    const thirdRefresh = refresher.refresh();
    assert.equal(listCalls, 1);

    firstList.resolve([session({ id: 's1', hasUnread: true, lastMessageAt: 200 })]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(listCalls, 2);

    trailingList.resolve([session({ id: 's1', hasUnread: true, lastMessageAt: 250 })]);
    await Promise.all([firstRefresh, secondRefresh, thirdRefresh]);

    assert.equal(listCalls, 2);
    assert.equal(currentSessions[0]?.lastMessageAt, 250);
    assert.equal(currentSessions[0]?.hasUnread, true);
  });

  it('keeps the current list when the latest list refresh fails', async () => {
    const readBoundaries: SessionReadBoundaries = {};
    const original = [session({ id: 's1', hasUnread: true, lastMessageAt: 250 })];
    const errors: unknown[] = [];
    let currentSessions = original;
    const refresher = createSessionListRefresher({
      captureRequestContext: () => undefined,
      listSessions: async () => {
        throw new Error('list failed');
      },
      readBoundaries: () => readBoundaries,
      currentSessions: () => currentSessions,
      commitSessions: (next) => {
        currentSessions = next;
      },
      onError: (error) => {
        errors.push(error);
      },
    });

    const result = await refresher.refresh();

    assert.equal(result, original);
    assert.equal(currentSessions, original);
    assert.equal(errors.length, 1);
  });

  it('commits the renderer context captured before the accepted authority read', async () => {
    const listed = deferred<SessionSummary[]>();
    let requestContext = 'before';
    let committedContext: string | undefined;
    const refresher = createSessionListRefresher({
      captureRequestContext: () => requestContext,
      listSessions: () => listed.promise,
      readBoundaries: () => ({}),
      currentSessions: () => [],
      commitSessions: (_sessions, context) => {
        committedContext = context;
      },
      onError: () => {},
    });

    const refresh = refresher.refresh();
    requestContext = 'after';
    listed.resolve([]);
    await refresh;

    assert.equal(committedContext, 'before');
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function session(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    id: overrides.id,
    name: overrides.name ?? 'Session',
    isFlagged: overrides.isFlagged ?? false,
    isArchived: overrides.isArchived ?? false,
    labels: overrides.labels ?? [],
    hasUnread: overrides.hasUnread ?? false,
    lastMessageAt: overrides.lastMessageAt,
    lastMessagePreview: overrides.lastMessagePreview,
    status: overrides.status ?? 'active',
    blockedReason: overrides.blockedReason,
    statusUpdatedAt: overrides.statusUpdatedAt,
    parentSessionId: overrides.parentSessionId,
    branchOfTurnId: overrides.branchOfTurnId,
    backend: overrides.backend ?? 'ai-sdk',
    llmConnectionSlug: overrides.llmConnectionSlug ?? 'default',
    connectionLocked: overrides.connectionLocked ?? false,
    model: overrides.model ?? 'default',
    permissionMode: overrides.permissionMode ?? 'ask',
  };
}

function messageAt(ts: number): StoredMessage {
  return {
    type: 'assistant',
    id: `m-${ts}`,
    turnId: `t-${ts}`,
    ts,
    text: 'ok',
    modelId: 'test-model',
  };
}
