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
import { test } from 'node:test';
import { EMPTY_USAGE_PROVENANCE } from '@maka/core/usage-ledger-merge';
import type { UsageScreen, UsageStats, UsageScreenQuery } from '@maka/core/settings';
import type { UsageQueryInput, UsageQueryResult } from '@maka/runtime-host/protocol';
import type { IpcHandler } from '../ipc-reconnect-policy.js';
import type { DesktopRuntimeHostClient } from '../runtime-host-client.js';
import { registerRuntimeHostUsageIpc } from '../runtime-host-usage-ipc-main.js';

const query: UsageScreenQuery = { range: { from: 0, to: 100 }, search: '', status: 'all' };
function screen(): UsageScreen {
  return {
    activityTotal: 151,
    revision: 'revision',
    queryIdentity: 'query',
    query,
    nextCursor: 'next',
    summary: {
      totalRequests: 151,
      totalCostUsd: 2,
      totalTokens: 30,
      inputTokens: 10,
      outputTokens: 20,
      cacheTokens: 0,
      cacheMiss: 10,
      cacheRead: 0,
      cacheCreation: 0,
      reasoning: 0,
    },
    logs: [
      {
        id: 'one',
        ts: 1,
        kind: 'model',
        provider: 'openai',
        model: 'gpt-5',
        inputTokens: 10,
        outputTokens: 20,
        costUsd: 2,
        status: 'success',
        sessionId: 'session',
        sessionName: 'Host title',
      },
    ],
    byProvider: [{ provider: 'configured-connection', requests: 151, tokens: 30, costUsd: 2 }],
    byModel: [{ model: 'gpt-5', requests: 151, tokens: 30, costUsd: 2 }],
    byTool: [],
    pricing: [],
    provenance: EMPTY_USAGE_PROVENANCE,
  };
}
function handlers(queryUsage: (input: UsageQueryInput) => Promise<UsageQueryResult>) {
  const handlers = new Map<string, IpcHandler>();
  registerRuntimeHostUsageIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    client: {
      queryUsage,
      loadPricingSnapshot: () => {
        throw new Error('Independent pricing read');
      },
    } as unknown as DesktopRuntimeHostClient,
    sendToRenderer: () => {},
  });
  return handlers;
}
const event = {} as Parameters<IpcHandler>[0];
test('one screen call atomically supplies totals, complete groups, pricing, and only the first activity page', async () => {
  const calls: UsageQueryInput[] = [];
  const fixture = screen();
  const h = handlers(async (input) => {
    calls.push(input);
    return { kind: 'screen', screen: fixture };
  });
  const stats = (await h.get('settings:usageStats')!(event, 'all', query)) as UsageStats;
  assert.deepEqual(calls, [{ kind: 'screen', query }]);
  assert.equal(stats.summary.totalRequests, 151);
  assert.equal(stats.logs.length, 1, 'does not drain activity');
  assert.deepEqual(
    stats.byProvider,
    fixture.byProvider,
    'groups come from full-range SQL, not the page',
  );
  assert.equal(stats.logs[0]?.sessionName, 'Host title');
  assert.equal(stats.navigation?.nextCursor, 'next');
  assert.equal(stats.navigation?.revision, fixture.revision);
});
test('initial All load fixes its time bound before dispatch', async () => {
  let sent: UsageQueryInput | undefined;
  const h = handlers(async (input) => {
    sent = input;
    return { kind: 'screen', screen: screen() };
  });
  const before = Date.now();
  await h.get('settings:usageStats')!(event, 'all');
  assert.ok(sent?.kind === 'screen');
  assert.equal(sent.query.range.from, 0);
  assert.ok(sent.query.range.to >= before && sent.query.range.to <= Date.now());
});
test('capacity failure is surfaced without retry, fallback, or partial reads', async () => {
  let calls = 0;
  const h = handlers(async () => {
    calls++;
    return { kind: 'screen_response_too_large', section: 'pricing' };
  });
  assert.deepEqual(await h.get('settings:usageStats')!(event, 'all'), {
    kind: 'screen_response_too_large',
    section: 'pricing',
  });
  assert.equal(calls, 1);
});
test('continuation forwards query and revision and preserves typed stale or capacity failures', async () => {
  const input = {
    kind: 'activity' as const,
    query,
    revision: 'revision',
    queryIdentity: 'query',
    cursor: 'next',
  };
  for (const result of [
    { kind: 'revision_changed' },
    { kind: 'screen_response_too_large', section: 'activity_page' },
  ] as const) {
    const h = handlers(async (actual) => {
      assert.deepEqual(actual, input);
      return result;
    });
    assert.deepEqual(await h.get('usage:activity')!(event, input), result);
  }
});
test('independent summary response cannot masquerade as a complete screen', async () => {
  const h = handlers(async () => ({
    kind: 'activity',
    page: { revision: 'r', queryIdentity: 'q', logs: [], nextCursor: null },
  }));
  await assert.rejects(h.get('settings:usageStats')!(event, 'all'), /invalid Usage projection/);
});
