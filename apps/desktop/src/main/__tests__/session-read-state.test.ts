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

import { deferred } from '@maka/core/test-only/async-primitives';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SessionSummary } from '@maka/core/session';
import { createSessionListRefresher } from '../../renderer/session-read-state.js';

describe('renderer session read state', () => {
  it('coalesces concurrent refreshes into one in-flight request and one trailing request', async () => {
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
      currentSessions: () => currentSessions,
      commitSessions: (next) => {
        currentSessions = next;
      },
      onError: () => {},
    });

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
    const original = [session({ id: 's1', hasUnread: true, lastMessageAt: 250 })];
    const errors: unknown[] = [];
    let currentSessions = original;
    const refresher = createSessionListRefresher({
      captureRequestContext: () => undefined,
      listSessions: async () => {
        throw new Error('list failed');
      },
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
