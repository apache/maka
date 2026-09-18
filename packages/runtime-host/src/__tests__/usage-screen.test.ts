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
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { UsageScreen, UsageScreenQuery } from '@maka/core/settings';
import { EMPTY_USAGE_PROVENANCE } from '@maka/core/usage-ledger-merge';
import {
  resolveStorageRoot,
  resolveRootControlNamespace,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import { openInteractiveUsageStoresForWrite } from '@maka/storage/usage-stores';
import { createSessionStore } from '@maka/storage/session-store';
import { acquireOperationalStateDatabase } from '@maka/storage/operational-state-store';
import {
  decodeUsageScreenResult,
  decodeUsageScreenRequest,
  assertUsageScreenResult,
  usageScreenCapacity,
  USAGE_SCREEN_SECTION_MAX_BYTES,
} from '../protocol/usage-screen.js';
import {
  encodeProtocolMessage,
  decodeHostFrame,
  RUNTIME_HOST_MAX_MESSAGE_BYTES,
} from '../protocol/index.js';
import { HostUsagePricingCoordinator } from '../server/usage-pricing-coordinator.js';
import { RuntimePolicyActivationGate } from '../server/runtime-policy-activation-gate.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
const query: UsageScreenQuery = { range: { from: 0, to: 1000 }, search: '', status: 'all' };
function screen(): UsageScreen {
  return {
    activityTotal: 151,
    revision: 'r',
    queryIdentity: 'q',
    query,
    nextCursor: null,
    summary: {
      totalRequests: 0,
      totalCostUsd: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      cacheMiss: 0,
      cacheRead: 0,
      cacheCreation: 0,
      reasoning: 0,
    },
    logs: [],
    byProvider: [],
    byModel: [],
    byTool: [],
    pricing: [],
    provenance: structuredClone(EMPTY_USAGE_PROVENANCE),
  };
}
const row = () => ({
  id: 'one',
  ts: 1,
  kind: 'model' as const,
  provider: 'provider',
  model: 'model',
  inputTokens: 1,
  outputTokens: 2,
  status: 'success' as const,
});
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

test('strict screen codecs reject malformed requests, unknown fields, wrong-query results and non-progressing pages', () => {
  assert.deepEqual(decodeUsageScreenRequest({ kind: 'screen', query }), { kind: 'screen', query });
  for (const input of [
    { kind: 'screen', query: { ...query, extra: true } },
    { kind: 'screen', query: { ...query, range: { from: 2, to: 1 } } },
    { kind: 'screen', query: { ...query, search: '界'.repeat(400) } },
    { kind: 'activity', query, revision: 'r', queryIdentity: 'q', cursor: '' },
  ])
    assert.throws(() => decodeUsageScreenRequest(input));
  for (const result of [
    { kind: 'screen', screen: { ...screen(), extra: true } },
    { kind: 'screen', screen: { ...screen(), activityTotal: -1 } },
    { kind: 'screen', screen: { ...screen(), logs: [{ ...row(), status: 'failed' }] } },
    { kind: 'activity', page: { revision: 'r', queryIdentity: 'q', logs: [], nextCursor: 'next' } },
    { kind: 'revision_changed', logs: [row()] },
    { kind: 'screen_response_too_large', section: 'pricing', screen: screen() },
  ])
    assert.throws(() => decodeUsageScreenResult(result));
  assert.throws(() =>
    assertUsageScreenResult(
      { kind: 'screen', query },
      { kind: 'screen', screen: { ...screen(), query: { ...query, search: 'different' } } },
    ),
  );
  assert.throws(() =>
    assertUsageScreenResult(
      { kind: 'activity', query, revision: 'r', queryIdentity: 'q', cursor: 'next' },
      {
        kind: 'activity',
        page: { revision: 'r', queryIdentity: 'q', logs: [row()], nextCursor: 'next' },
      },
    ),
  );
});

test('each complete section accepts its item limit and fails one above without partial output', () => {
  for (const [key, section, limit, item] of [
    [
      'byProvider',
      'provider_breakdown',
      100,
      { provider: 'p', requests: 1, tokens: 1, costUsd: 0 },
    ],
    ['byModel', 'model_breakdown', 100, { model: 'm', requests: 1, tokens: 1, costUsd: 0 }],
    [
      'byTool',
      'tool_breakdown',
      100,
      { tool: 't', calls: 1, success: 1, errors: 0, avgDurationMs: 1 },
    ],
    [
      'pricing',
      'pricing',
      128,
      { provider: 'p', model: 'm', inputPerMTokUsd: 0, outputPerMTokUsd: 0 },
    ],
    ['logs', 'activity_page', 100, row()],
  ] as const) {
    const value = { ...screen(), [key]: Array.from({ length: limit }, () => ({ ...item })) };
    assert.equal(usageScreenCapacity({ kind: 'screen', screen: value }), undefined);
    assert.doesNotThrow(() => decodeUsageScreenResult({ kind: 'screen', screen: value }));
    const over = { ...value, [key]: [...value[key], item] };
    const failure = usageScreenCapacity({ kind: 'screen', screen: over });
    assert.deepEqual(failure, { kind: 'screen_response_too_large', section });
    assert.deepEqual(decodeUsageScreenResult(failure), failure);
    assert.throws(() => decodeUsageScreenResult({ kind: 'screen', screen: over }));
  }
});

test('UTF-8 and JSON-escaped section bytes include exact boundary and one byte above', () => {
  for (const [key, section, field, item] of [
    [
      'byProvider',
      'provider_breakdown',
      'provider',
      { provider: '', requests: 1, tokens: 1, costUsd: 0 },
    ],
    ['byModel', 'model_breakdown', 'model', { model: '', requests: 1, tokens: 1, costUsd: 0 }],
    [
      'byTool',
      'tool_breakdown',
      'tool',
      { tool: '', calls: 1, success: 1, errors: 0, avgDurationMs: 1 },
    ],
    [
      'pricing',
      'pricing',
      'model',
      { provider: '', model: '', inputPerMTokUsd: 0, outputPerMTokUsd: 0 },
    ],
  ] as const) {
    const items: Array<Record<string, string | number>> = Array.from({ length: 90 }, () => ({
      ...item,
      [field]: '界"\\',
    }));
    // Adjust ASCII padding so escaped JSON, rather than JS string length, is exact.
    let remaining = USAGE_SCREEN_SECTION_MAX_BYTES - bytes(items);
    for (const item of items) {
      const length = Math.min(600, remaining);
      item[field] = String(item[field]) + 'x'.repeat(length);
      remaining -= length;
    }
    assert.equal(remaining, 0);
    assert.equal(bytes(items), USAGE_SCREEN_SECTION_MAX_BYTES);
    const value = { ...screen(), [key]: items } as UsageScreen;
    assert.equal(usageScreenCapacity({ kind: 'screen', screen: value }), undefined);
    assert.doesNotThrow(() => decodeUsageScreenResult({ kind: 'screen', screen: value }));
    items[0]![field] = String(items[0]![field]) + 'x';
    assert.deepEqual(usageScreenCapacity({ kind: 'screen', screen: value }), {
      kind: 'screen_response_too_large',
      section,
    });
    items[0]![field] = String(items[0]![field]).slice(0, -1).replace('x', '界');
    assert.ok(bytes(items) > USAGE_SCREEN_SECTION_MAX_BYTES);
    items[0]![field] = String(items[0]![field]).replace('x', '"');
    assert.ok(bytes(items) > USAGE_SCREEN_SECTION_MAX_BYTES);
  }
});

test('activity byte budget includes cursor metadata and complete screen fits a worst-case legal envelope', () => {
  const value = screen();
  value.logs = Array.from({ length: 50 }, () => ({ ...row(), model: 'x'.repeat(700) }));
  value.nextCursor = 'cursor';
  let page = {
    revision: value.revision,
    queryIdentity: value.queryIdentity,
    logs: value.logs,
    nextCursor: value.nextCursor,
  };
  let remaining = USAGE_SCREEN_SECTION_MAX_BYTES - bytes(page);
  for (const row of value.logs) {
    const add = Math.min(1024 - row.model.length, remaining);
    row.model += 'x'.repeat(add);
    remaining -= add;
  }
  assert.equal(remaining, 0);
  assert.equal(bytes(page), USAGE_SCREEN_SECTION_MAX_BYTES);
  assert.equal(usageScreenCapacity({ kind: 'screen', screen: value }), undefined);
  const encoded = encodeProtocolMessage({
    requestId: '\u0000'.repeat(128),
    operation: 'usage.query',
    ok: true,
    result: { kind: 'screen', screen: value },
  });
  assert.ok(encoded.byteLength < RUNTIME_HOST_MAX_MESSAGE_BYTES);
  assert.doesNotThrow(() => decodeHostFrame(JSON.parse(encoded.toString())));
  value.nextCursor += 'x';
  assert.deepEqual(usageScreenCapacity({ kind: 'screen', screen: value }), {
    kind: 'screen_response_too_large',
    section: 'activity_page',
  });
  // Valid sections cannot collectively reach 640 KiB: five 48 KiB sections plus
  // bounded scalar metadata are smaller. The total guard still rejects corrupt
  // oversized metadata, independently of a future section-limit increase.
  const huge = { ...screen(), query: { ...query, search: 'x'.repeat(640 * 1024) } };
  assert.deepEqual(usageScreenCapacity({ kind: 'screen', screen: huge }), {
    kind: 'screen_response_too_large',
    section: 'screen',
  });
});

test('real Host returns bounded failures, stays usable, and fences a replacement coordinator', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-screen-host-'));
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const stores = await openInteractiveUsageStoresForWrite(owner.lease);
  const lease = acquireOperationalStateDatabase(root);
  const coordinator = () =>
    new HostUsagePricingCoordinator(
      stores,
      () => {
        throw new Error('unexpected drain');
      },
      new RuntimePolicyActivationGate(),
    );
  const context = {
    hostEpoch: 'test',
    connectionId: 'test',
    principal: 'local_os_user',
    acquireResidency: () => ({ release() {} }),
  } satisfies ConnectionContext;
  const host = coordinator();
  try {
    for (let i = 0; i < 101; i++) {
      lease.database
        .prepare('INSERT INTO usage_tool_invocations VALUES (?, ?, 1, ?)')
        .run(
          String(i),
          String(i),
          JSON.stringify({ toolName: `tool-${i}`, status: 'success', durationMs: 1 }),
        );
    }
    const failed = await host.handlers['usage.query']({ kind: 'screen', query }, context);
    assert.deepEqual(failed, {
      ok: true,
      result: { kind: 'screen_response_too_large', section: 'tool_breakdown' },
    });
    assert.ok(
      encodeProtocolMessage({ requestId: 'failure', operation: 'usage.query', ...failed })
        .byteLength < 256,
    );
    lease.database.exec(
      "UPDATE usage_tool_invocations SET record_json = json_set(record_json, '$.toolName', 'tool')",
    );
    const loaded = await host.handlers['usage.query']({ kind: 'screen', query }, context);
    assert.ok(loaded.ok && loaded.result.kind === 'screen');
    assert.doesNotThrow(() => decodeUsageScreenResult(loaded.result));
    const value = loaded.result.screen;
    assert.ok(value.nextCursor);
    const input = {
      kind: 'activity' as const,
      query,
      revision: value.revision,
      queryIdentity: value.queryIdentity,
      cursor: value.nextCursor,
    };
    const page = await host.handlers['usage.query'](input, context);
    assert.ok(page.ok && page.result.kind === 'activity');
    assert.deepEqual(await coordinator().handlers['usage.query'](input, context), {
      ok: true,
      result: { kind: 'revision_changed' },
    });
  } finally {
    lease.close();
    await stores.close();
    await owner.close();
    await rm(join(resolveRootControlNamespace(), capability.rootId), {
      recursive: true,
      force: true,
    });
    await rm(root, { recursive: true, force: true });
  }
});

test('real Host keeps Session titles in the screen revision across rename and pagination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-screen-titles-'));
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const stores = await openInteractiveUsageStoresForWrite(owner.lease);
  const sessions = createSessionStore(root);
  const lease = acquireOperationalStateDatabase(root);
  let titleReads = 0;
  const host = new HostUsagePricingCoordinator(
    stores,
    () => {
      throw new Error('unexpected drain');
    },
    new RuntimePolicyActivationGate(),
    undefined,
    async (id) => {
      titleReads++;
      return (await sessions.readHeaderSnapshot(id)).name;
    },
  );
  const context = {
    hostEpoch: 'test',
    connectionId: 'test',
    principal: 'local_os_user',
    acquireResidency: () => ({ release() {} }),
  } satisfies ConnectionContext;
  const load = () => host.handlers['usage.query']({ kind: 'screen', query }, context);
  const continueFrom = (value: UsageScreen) => {
    assert.ok(value.nextCursor);
    return host.handlers['usage.query'](
      {
        kind: 'activity',
        query,
        revision: value.revision,
        queryIdentity: value.queryIdentity,
        cursor: value.nextCursor,
      },
      context,
    );
  };
  try {
    const session = await sessions.create({
      cwd: root,
      llmConnectionSlug: 'test',
      model: 'model',
      permissionMode: 'ask',
      name: 'Before rename',
      labels: [],
    });
    for (let i = 0; i < 60; i++) {
      lease.database.prepare('INSERT INTO usage_tool_invocations VALUES (?, ?, ?, ?)').run(
        String(i),
        String(i),
        i + 1,
        JSON.stringify({
          sessionId: session.id,
          toolName: 'tool',
          status: 'success',
          durationMs: 1,
        }),
      );
    }
    const first = await load();
    assert.ok(first.ok && first.result.kind === 'screen');
    assert.equal(first.result.screen.logs.length, 50);
    assert.ok(first.result.screen.logs.every((row) => row.sessionName === 'Before rename'));
    // Flags are unrelated to the activity title and must not invalidate paging.
    await sessions.setFlagged(session.id, true);
    const unchanged = await continueFrom(first.result.screen);
    assert.ok(unchanged.ok && unchanged.result.kind === 'activity');
    assert.equal(unchanged.result.page.logs.length, 10);
    assert.ok(unchanged.result.page.logs.every((row) => row.sessionName === 'Before rename'));
    await sessions.rename(session.id, 'After rename');
    assert.deepEqual(await continueFrom(first.result.screen), {
      ok: true,
      result: { kind: 'revision_changed' },
    });
    const refreshed = await load();
    assert.ok(refreshed.ok && refreshed.result.kind === 'screen');
    assert.notEqual(refreshed.result.screen.revision, first.result.screen.revision);
    assert.ok(refreshed.result.screen.logs.every((row) => row.sessionName === 'After rename'));
    const next = await continueFrom(refreshed.result.screen);
    assert.ok(next.ok && next.result.kind === 'activity');
    assert.ok(next.result.page.logs.every((row) => row.sessionName === 'After rename'));
    assert.equal(titleReads, 0, 'screen pages must not resolve titles outside their snapshot');
  } finally {
    lease.close();
    await sessions.close?.();
    await stores.close();
    await owner.close();
    await rm(join(resolveRootControlNamespace(), capability.rootId), {
      recursive: true,
      force: true,
    });
    await rm(root, { recursive: true, force: true });
  }
});
