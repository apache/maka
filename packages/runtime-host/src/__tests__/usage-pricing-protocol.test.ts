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

import { RuntimeHostProtocolError } from '../protocol/errors.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  comparePricingModelKeys,
  PRICING_MODEL_KEY_MAX_CHARS,
} from '@maka/core/usage-stats/pricing';
import type { PricingConfig, UsageBucket } from '@maka/core/usage-stats/types';
import {
  resolveRootControlNamespace,
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import { acquireOperationalStateDatabase } from '@maka/storage';
import { openInteractiveUsageStoresForWrite } from '@maka/storage/usage-stores';
import {
  decodeClientFrame,
  decodeHostFrame,
  decodeUsageQueryInput,
  encodePricingQueryResult,
  encodeProtocolMessage,
  PRICING_PAGE_MAX_BYTES,
  PRICING_PAGE_MAX_ITEMS,
  RUNTIME_HOST_MAX_MESSAGE_BYTES,
  USAGE_PAGE_MAX_BYTES,
  USAGE_PAGE_MAX_ITEMS,
  USAGE_PROJECTION_TEXT_MAX_BYTES,
  type EffectivePricingEntry,
  type LlmUsageLogProjection,
  type ToolUsageLogProjection,
} from '../protocol/index.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { HostUsagePricingCoordinator } from '../server/usage-pricing-coordinator.js';
import { RuntimePolicyActivationGate } from '../server/runtime-policy-activation-gate.js';

const CONNECTION_CONTEXT: ConnectionContext = {
  hostEpoch: 'usage-pricing-protocol-test',
  connectionId: 'usage-pricing-protocol-test-connection',
  principal: 'local_os_user',
  acquireResidency: () => ({ release() {} }),
};

describe('Usage/Pricing protocol', () => {
  test('decodes exact bounded usage queries', () => {
    assert.deepEqual(
      decodeUsageQueryInput({
        kind: 'logs',
        source: 'llm',
        query: { range: 'all' },
      }),
      {
        kind: 'logs',
        source: 'llm',
        query: { range: 'all' },
        offset: 0,
        limit: USAGE_PAGE_MAX_ITEMS,
      },
    );
    assert.deepEqual(
      decodeUsageQueryInput({
        kind: 'buckets',
        query: {
          range: { from: 1, to: 2 },
          connectionSlug: 'primary',
          providerId: 'provider',
          modelId: 'model',
          sessionId: 'session-1',
          status: 'success',
        },
        groupBy: 'model',
        offset: 2,
        limit: 3,
      }),
      {
        kind: 'buckets',
        query: {
          range: { from: 1, to: 2 },
          connectionSlug: 'primary',
          providerId: 'provider',
          modelId: 'model',
          sessionId: 'session-1',
          status: 'success',
        },
        groupBy: 'model',
        offset: 2,
        limit: 3,
      },
    );
    assert.deepEqual(
      decodeUsageQueryInput({
        kind: 'buckets',
        query: { range: 'all', toolName: 'Read', status: 'error' },
        groupBy: 'tool',
      }),
      {
        kind: 'buckets',
        query: { range: 'all', toolName: 'Read', status: 'error' },
        groupBy: 'tool',
        offset: 0,
        limit: USAGE_PAGE_MAX_ITEMS,
      },
    );
    assert.deepEqual(
      decodeUsageQueryInput({
        kind: 'logs',
        source: 'tool',
        query: { range: 'all', toolName: 'Read', status: 'success' },
      }),
      {
        kind: 'logs',
        source: 'tool',
        query: { range: 'all', toolName: 'Read', status: 'success' },
        offset: 0,
        limit: USAGE_PAGE_MAX_ITEMS,
      },
    );

    for (const input of [
      { kind: 'summary', query: { range: 'all' }, offset: 0 },
      { kind: 'summary', query: { range: 'all', toolName: 'Read' } },
      { kind: 'logs', query: { range: 'all' } },
      { kind: 'logs', source: 'llm', query: { range: 'all', toolName: 'Read' } },
      { kind: 'logs', source: 'tool', query: { range: 'all', providerId: 'provider' } },
      { kind: 'logs', source: 'tool', query: { range: 'all', modelId: 'model' } },
      { kind: 'logs', source: 'llm', query: { range: 'all', unknown: true } },
      { kind: 'logs', source: 'llm', query: { range: { from: 2, to: 1 } } },
      { kind: 'logs', source: 'llm', query: { range: 'all' }, offset: -1 },
      { kind: 'logs', source: 'llm', query: { range: 'all' }, offset: 0.5 },
      { kind: 'logs', source: 'llm', query: { range: 'all' }, limit: 0 },
      { kind: 'logs', source: 'llm', query: { range: 'all' }, limit: 1.5 },
      {
        kind: 'logs',
        source: 'llm',
        query: { range: 'all' },
        limit: USAGE_PAGE_MAX_ITEMS + 1,
      },
      {
        kind: 'buckets',
        query: { range: 'all', toolName: 'Read' },
        groupBy: 'model',
      },
      {
        kind: 'buckets',
        query: { range: 'all', connectionSlug: 'primary' },
        groupBy: 'tool',
      },
      { kind: 'buckets', query: { range: 'all' }, groupBy: 'week' },
      { kind: 'export', query: { range: 'all' } },
    ]) {
      assert.throws(() => usageRequest(input), invalidFrame);
    }
  });

  test('enforces exact usage results and both page bounds', () => {
    assert.doesNotThrow(() =>
      usageResponse({ kind: 'summary', summary: validSummary(), provenance: validProvenance() }),
    );
    assert.doesNotThrow(() =>
      usageResponse({
        kind: 'buckets',
        buckets: [validBucket()],
        offset: 0,
        total: 2,
        nextOffset: 1,
        provenance: validProvenance(),
      }),
    );
    assert.doesNotThrow(() =>
      usageResponse({
        kind: 'logs',
        source: 'llm',
        rows: [validLog(), { ...validLog(1), callKind: 'goal_evaluation' }],
        offset: 0,
        total: 2,
        nextOffset: null,
        provenance: validProvenance(),
      }),
    );
    assert.doesNotThrow(() =>
      usageResponse({
        kind: 'logs',
        source: 'tool',
        rows: [validToolLog()],
        offset: 0,
        total: 1,
        nextOffset: null,
      }),
    );

    const tooMany = Array.from({ length: USAGE_PAGE_MAX_ITEMS + 1 }, () => validBucket());
    const byteHeavy = Array.from({ length: 50 }, (_, index) => ({
      ...validLog(index),
      errorClass: '\\'.repeat(USAGE_PROJECTION_TEXT_MAX_BYTES),
    }));
    const oversized = {
      kind: 'logs',
      source: 'llm',
      rows: byteHeavy,
      offset: 0,
      total: 50,
      nextOffset: null,
      provenance: validProvenance(),
    };
    assert.ok(Buffer.byteLength(JSON.stringify(oversized), 'utf8') > USAGE_PAGE_MAX_BYTES);

    for (const result of [
      {
        kind: 'buckets',
        buckets: tooMany,
        offset: 0,
        total: tooMany.length,
        nextOffset: null,
        provenance: validProvenance(),
      },
      oversized,
      {
        kind: 'logs',
        source: 'llm',
        rows: [{ ...validLog(), errorClass: 'x'.repeat(USAGE_PROJECTION_TEXT_MAX_BYTES + 1) }],
        offset: 0,
        total: 1,
        nextOffset: null,
        provenance: validProvenance(),
      },
      {
        kind: 'logs',
        source: 'llm',
        rows: [{ ...validLog(), systemPromptHash: 'not-on-the-wire' }],
        offset: 0,
        total: 1,
        nextOffset: null,
        provenance: validProvenance(),
      },
      {
        kind: 'summary',
        summary: { ...validSummary(), totalRequests: 0.5 },
        provenance: validProvenance(),
      },
      {
        kind: 'buckets',
        buckets: [{ ...validBucket(), requests: 0.5 }],
        offset: 0,
        total: 1,
        nextOffset: null,
      },
      {
        kind: 'logs',
        source: 'llm',
        rows: [{ ...validLog(), inputTokens: 0.5 }],
        offset: 0,
        total: 1,
        nextOffset: null,
      },
      {
        kind: 'logs',
        source: 'llm',
        rows: [{ ...validLog(), callKind: 'unknown' }],
        offset: 0,
        total: 1,
        nextOffset: null,
      },
      {
        kind: 'logs',
        source: 'tool',
        rows: [{ ...validToolLog(), source: 'llm' }],
        offset: 0,
        total: 1,
        nextOffset: null,
      },
      { kind: 'buckets', buckets: [validBucket()], offset: 0, total: 1, nextOffset: 2 },
      { kind: 'buckets', buckets: [], offset: 0, total: 1, nextOffset: 0 },
      { kind: 'buckets', buckets: [validBucket()], offset: 1, total: 3, nextOffset: 3 },
      { kind: 'buckets', buckets: [validBucket()], offset: 0, total: 2, nextOffset: null },
      { kind: 'buckets', buckets: [validBucket()], offset: 1, total: 1, nextOffset: null },
    ]) {
      assert.throws(() => usageResponse(result), invalidFrame);
    }
  });

  test('keeps long usage identities distinct through the real coordinator and protocol', async () => {
    const base = await mkdtemp(join(tmpdir(), 'maka-usage-identity-projection-'));
    const capability = await resolveStorageRoot({
      path: join(base, 'interactive-root'),
      kind: 'interactive',
    });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner, 'test must acquire the real Interactive write lease');
    const stores = await openInteractiveUsageStoresForWrite(owner.lease);

    try {
      const longCommon = '界'.repeat(400);
      const identities = [
        `identity\u0000${longCommon}-alpha`,
        `identity\u0001${longCommon}-omega`,
        'short\u0000identity',
        'short\u0001identity',
        `${'x'.repeat(1_100)}\ud800`,
        `${'x'.repeat(1_100)}\ud801`,
      ] as const;
      await Promise.all(
        identities.flatMap((identity, index) => [
          stores.telemetry.recordLlmCall(longUsageRecord(identity, index + 1)),
          stores.telemetry.recordToolInvocation(longToolRecord(identity, index + 11)),
        ]),
      );
      const coordinator = new HostUsagePricingCoordinator(
        stores,
        () => {},
        new RuntimePolicyActivationGate(),
      );

      const llmRows = await queryUsageRows(coordinator, 'llm');
      const toolRows = await queryUsageRows(coordinator, 'tool');
      const buckets = await queryUsageBuckets(coordinator);

      for (const field of [
        'id',
        'callId',
        'connectionSlug',
        'providerId',
        'modelId',
        'sessionId',
        'turnId',
      ] as const) {
        assertDistinctBoundedIdentities(llmRows.map((row) => row[field]));
      }
      for (const field of [
        'id',
        'toolCallId',
        'toolName',
        'providerId',
        'modelId',
        'sessionId',
        'turnId',
      ] as const) {
        assertDistinctBoundedIdentities(toolRows.map((row) => row[field]));
      }
      assertDistinctBoundedIdentities(buckets.map((bucket) => bucket.key));
      assert.equal(new Set(buckets.map((bucket) => bucket.label)).size, 3);
      assert.deepEqual(await queryUsageRows(coordinator, 'llm'), llmRows);
      assert.deepEqual(await queryUsageRows(coordinator, 'tool'), toolRows);
      assert.deepEqual(await queryUsageBuckets(coordinator), buckets);
    } finally {
      await stores.close().catch(() => undefined);
      await owner.close();
      await rm(join(resolveRootControlNamespace(), capability.rootId), {
        recursive: true,
        force: true,
      });
      await rm(base, { recursive: true, force: true });
    }
  });

  test('a Session summary neither repairs nor reports another Session pending projection', async () => {
    const base = await mkdtemp(join(tmpdir(), 'maka-session-usage-scope-'));
    const capability = await resolveStorageRoot({
      path: join(base, 'interactive-root'),
      kind: 'interactive',
    });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    const stores = await openInteractiveUsageStoresForWrite(owner.lease);
    try {
      const lease = acquireOperationalStateDatabase(join(base, 'interactive-root'));
      try {
        lease.transaction('write', () => {
          lease.database
            .prepare(`
              INSERT INTO core_agent_runs(session_id, run_id, created_at, record_json)
              VALUES ('session-b', 'run-b', 0, '{}')
            `)
            .run();
          lease.database
            .prepare(`
              UPDATE core_agent_runs SET latest_model_call_sequence = 0
              WHERE session_id = 'session-b' AND run_id = 'run-b'
            `)
            .run();
          lease.database
            .prepare(`
              INSERT INTO core_agent_run_events(
                session_id, run_id, sequence, event_id, event_type, event_ts, record_json
              ) VALUES (
                'session-b', 'run-b', 0, 'corrupt-model-call',
                'model_call_attempt_recorded', 0, '{}'
              )
            `)
            .run();
        });
      } finally {
        lease.close();
      }
      const coordinator = new HostUsagePricingCoordinator(
        stores,
        () => {},
        new RuntimePolicyActivationGate(),
        () => {},
      );

      const outcome = await coordinator.handlers['usage.query'](
        { kind: 'summary', query: { range: 'all', sessionId: 'session-a' } },
        CONNECTION_CONTEXT,
      );

      assert.equal(outcome.ok, true);
      if (!outcome.ok || outcome.result.kind !== 'summary') return;
      assert.equal(outcome.result.provenance.pendingRepairs, 0);
      assert.equal(outcome.result.provenance.unreadableRecords, 0);
      const global = await stores.modelCalls.catchUpModelCallProjection();
      assert.equal(global.unreadableEvents, 1);
    } finally {
      await stores.close().catch(() => undefined);
      await owner.close();
      await rm(join(resolveRootControlNamespace(), capability.rootId), {
        recursive: true,
        force: true,
      });
      await rm(base, { recursive: true, force: true });
    }
  });

  test('decodes revision-pinned numeric-offset pricing pages and revision-CAS mutation', () => {
    assert.doesNotThrow(() => pricingRequest('pricing.query', { kind: 'start' }));
    assert.doesNotThrow(() =>
      pricingRequest('pricing.query', { kind: 'continue', revision: 3, offset: 17 }),
    );
    for (const input of [
      {},
      { kind: 'start', offset: 0 },
      { kind: 'continue', revision: -1, offset: 1 },
      { kind: 'continue', revision: 0.5, offset: 1 },
      { kind: 'continue', revision: 0, offset: -1 },
      { kind: 'continue', revision: 0, offset: 0.5 },
    ]) {
      assert.throws(() => pricingRequest('pricing.query', input), invalidFrame);
    }

    assert.doesNotThrow(() =>
      pricingRequest('pricing.mutate', {
        expectedRevision: 0,
        mutation: { kind: 'upsert', pricing: pricing('provider:model') },
      }),
    );
    assert.doesNotThrow(() =>
      pricingRequest('pricing.mutate', {
        expectedRevision: 1,
        mutation: { kind: 'delete', modelKey: 'provider:model' },
      }),
    );
    for (const input of [
      { expectedRevision: -1, mutation: { kind: 'delete', modelKey: 'model' } },
      { expectedRevision: 0.5, mutation: { kind: 'delete', modelKey: 'model' } },
      { expectedRevision: 0, mutation: { kind: 'delete', modelKey: '', ticket: 'x' } },
      {
        expectedRevision: 0,
        mutation: { kind: 'upsert', pricing: pricing(' provider:model ') },
      },
      {
        expectedRevision: 0,
        mutation: { kind: 'upsert', pricing: { ...pricing('model'), extra: true } },
      },
      { expectedRevision: 0, mutation: { kind: 'reset' } },
    ]) {
      assert.throws(() => pricingRequest('pricing.mutate', input), invalidFrame);
    }

    assert.deepEqual(
      encodePricingQueryResult({
        kind: 'page',
        revision: 3,
        offset: 0,
        entries: [customPricingEntry('m')],
        nextOffset: 1,
      }),
      {
        kind: 'page',
        revision: 3,
        offset: 0,
        entries: [customPricingEntry('m')],
        nextOffset: 1,
      },
    );
    assert.deepEqual(
      encodePricingQueryResult({
        kind: 'revision_changed',
        expectedRevision: 2,
        actualRevision: 3,
      }),
      { kind: 'revision_changed', expectedRevision: 2, actualRevision: 3 },
    );
    assert.throws(
      () =>
        pricingResponse('pricing.query', {
          kind: 'page',
          revision: 0,
          offset: 0,
          overrides: [pricing('m')],
          nextOffset: null,
        }),
      invalidFrame,
    );
    assert.throws(
      () =>
        encodePricingQueryResult({
          kind: 'page',
          revision: 0,
          offset: 0,
          entries: Array.from({ length: PRICING_PAGE_MAX_ITEMS + 1 }, (_, index) =>
            customPricingEntry(`model-${index}`),
          ),
          nextOffset: null,
        }),
      invalidFrame,
    );
    for (const result of [
      {
        kind: 'page',
        revision: 1,
        offset: 2,
        entries: [],
        nextOffset: 2,
      },
      {
        kind: 'page',
        revision: 1,
        offset: 2,
        entries: [customPricingEntry('m')],
        nextOffset: 4,
      },
      {
        kind: 'page',
        revision: 1,
        offset: 0,
        entries: [customPricingEntry('z'), customPricingEntry('a')],
        nextOffset: null,
      },
      {
        kind: 'revision_changed',
        expectedRevision: 3,
        actualRevision: 3,
      },
    ]) {
      assert.throws(() => pricingResponse('pricing.query', result), invalidFrame);
    }
    for (const entry of [
      { pricing: pricing('m'), source: 'builtin', resetEffect: 'restore_builtin' },
      { pricing: pricing('m'), source: 'custom' },
      { pricing: pricing('m'), source: 'custom', resetEffect: 'invalid' },
      { pricing: pricing('m'), source: 'unknown' },
    ]) {
      assert.throws(
        () =>
          pricingResponse('pricing.query', {
            kind: 'page',
            revision: 1,
            offset: 0,
            entries: [entry],
            nextOffset: null,
          }),
        invalidFrame,
      );
    }
    for (const result of [
      { kind: 'committed', revision: 1 },
      { kind: 'unchanged', revision: 1 },
      { kind: 'revision_conflict', expectedRevision: 0, actualRevision: 1 },
    ]) {
      assert.doesNotThrow(() => pricingResponse('pricing.mutate', result));
    }
    assert.throws(
      () =>
        pricingResponse('pricing.mutate', {
          kind: 'revision_conflict',
          expectedRevision: 7,
          actualRevision: 7,
        }),
      invalidFrame,
    );
  });

  test('uses exact-string pricing order without merging Unicode normalization forms', () => {
    const decomposed = 'e\u0301';
    const composed = '\u00e9';
    const page = encodePricingQueryResult({
      kind: 'page',
      revision: 2,
      offset: 0,
      entries: [customPricingEntry(decomposed), customPricingEntry(composed)],
      nextOffset: null,
    });
    assert.equal(page.kind, 'page');
    if (page.kind !== 'page') throw new Error('Expected a pricing page');
    assert.deepEqual(
      page.entries.map((item) => item.pricing.modelKey),
      [decomposed, composed],
    );
    assert.notEqual(page.entries[0]?.pricing.modelKey, page.entries[1]?.pricing.modelKey);
    assert.throws(
      () =>
        encodePricingQueryResult({
          kind: 'page',
          revision: 2,
          offset: 0,
          entries: [customPricingEntry(composed), customPricingEntry(decomposed)],
          nextOffset: null,
        }),
      invalidFrame,
    );
  });

  test('bounds a page of maximum-length CJK pricing items below the message limit', () => {
    const cjkEntries = Array.from({ length: PRICING_PAGE_MAX_ITEMS }, (_, index) =>
      customPricingConfigEntry(maximumCjkPricing(index)),
    ).sort((left, right) => comparePricingModelKeys(left.pricing.modelKey, right.pricing.modelKey));
    const maximumPage = encodePricingQueryResult({
      kind: 'page',
      revision: Number.MAX_SAFE_INTEGER,
      offset: 0,
      entries: cjkEntries.slice(0, 77),
      nextOffset: 77,
    });
    assert.equal(maximumPage.kind, 'page');
    if (maximumPage.kind !== 'page') throw new Error('Expected a pricing page');
    assert.equal(maximumPage.entries[0]?.pricing.modelKey.length, PRICING_MODEL_KEY_MAX_CHARS);
    assert.ok(Buffer.byteLength(maximumPage.entries[0]!.pricing.modelKey, 'utf8') > 128);
    const pageBytes = Buffer.byteLength(JSON.stringify(maximumPage), 'utf8');
    assert.ok(pageBytes <= PRICING_PAGE_MAX_BYTES);
    assert.ok(
      encodeProtocolMessage({
        requestId: 'maximum-cjk-pricing-page',
        operation: 'pricing.query',
        ok: true,
        result: maximumPage,
      }).byteLength <= RUNTIME_HOST_MAX_MESSAGE_BYTES,
    );
    assert.throws(
      () =>
        encodePricingQueryResult({
          kind: 'page',
          revision: Number.MAX_SAFE_INTEGER,
          offset: 0,
          entries: cjkEntries.slice(0, 78),
          nextOffset: 78,
        }),
      invalidFrame,
    );
  });
});

function validProvenance() {
  return {
    coverage: {
      attempts: 1,
      pricedAttempts: 1,
      unpricedAttempts: 0,
      usageReportedAttempts: 1,
      usagePartialAttempts: 0,
      usageMissingAttempts: 0,
    },
    legacyRecords: 0,
    unreadableRecords: 0,
    pendingRepairs: 0,
  };
}

function validSummary() {
  return {
    range: { from: 0, to: 1 },
    totalRequests: 1,
    totalCostUsd: 0.01,
    totalTokens: {
      input: 1,
      output: 2,
      cacheMiss: 1,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: 3,
    },
    cacheHitRequests: 0,
    cacheCreateRequests: 0,
    errorRequests: 0,
  };
}

function validBucket() {
  return {
    key: 'provider',
    label: 'provider',
    requests: 1,
    inputTokens: 1,
    outputTokens: 2,
    cacheMissTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheMissInputSource: 'explicit',
    reasoningTokens: 0,
    totalTokens: 3,
    costUsd: 0.01,
    avgLatencyMs: 10,
    errorRate: 0,
  };
}

function validLog(index = 0) {
  return {
    source: 'llm',
    id: `usage-${index}`,
    ts: index + 1,
    providerId: 'provider',
    modelId: 'model',
    inputTokens: 1,
    outputTokens: 2,
    cacheMissTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheMissInputSource: 'explicit',
    reasoningTokens: 0,
    totalTokens: 3,
    costUsd: 0.01,
    latencyMs: 10,
    status: 'success',
  };
}

function validToolLog() {
  return {
    source: 'tool',
    id: 'tool-1',
    ts: 1,
    toolCallId: 'call-1',
    toolName: 'Read',
    durationMs: 10,
    status: 'success',
    resultSummary: { kind: 'text', itemCount: 1 },
    bytesIn: 2,
    bytesOut: 3,
    startedAt: 1,
  };
}

function longUsageRecord(identity: string, ts: number) {
  return {
    id: identity,
    sessionId: identity,
    turnId: identity,
    callId: identity,
    connectionSlug: identity,
    providerId: identity,
    modelId: identity,
    inputTokens: 1,
    outputTokens: 2,
    cacheHitInputTokens: 0,
    cacheMissInputTokens: 1,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 3,
    latencyMs: 10,
    costUsd: 0.01,
    startedAt: ts,
    date: '2026-07-29',
    ts,
    status: 'success' as const,
  };
}

function longToolRecord(identity: string, ts: number) {
  return {
    id: identity,
    sessionId: identity,
    turnId: identity,
    toolCallId: identity,
    toolName: identity,
    providerId: identity,
    modelId: identity,
    durationMs: 10,
    status: 'success' as const,
    bytesIn: 1,
    bytesOut: 2,
    startedAt: ts,
    date: '2026-07-29',
    ts,
  };
}

async function queryUsageRows(
  coordinator: HostUsagePricingCoordinator,
  source: 'llm',
): Promise<readonly LlmUsageLogProjection[]>;
async function queryUsageRows(
  coordinator: HostUsagePricingCoordinator,
  source: 'tool',
): Promise<readonly ToolUsageLogProjection[]>;
async function queryUsageRows(
  coordinator: HostUsagePricingCoordinator,
  source: 'llm' | 'tool',
): Promise<readonly (LlmUsageLogProjection | ToolUsageLogProjection)[]> {
  const outcome = await coordinator.handlers['usage.query'](
    { kind: 'logs', source, query: { range: 'all' } },
    CONNECTION_CONTEXT,
  );
  const frame = decodeHostFrame(
    JSON.parse(
      encodeProtocolMessage({
        requestId: `usage-${source}-identity-query`,
        operation: 'usage.query',
        ...outcome,
      }).toString('utf8'),
    ),
  );
  if (
    'kind' in frame ||
    frame.operation !== 'usage.query' ||
    !frame.ok ||
    frame.result.kind !== 'logs' ||
    frame.result.source !== source
  ) {
    throw new Error(`Expected ${source} usage rows`);
  }
  return frame.result.rows;
}

async function queryUsageBuckets(
  coordinator: HostUsagePricingCoordinator,
): Promise<readonly UsageBucket[]> {
  const outcome = await coordinator.handlers['usage.query'](
    { kind: 'buckets', query: { range: 'all' }, groupBy: 'provider' },
    CONNECTION_CONTEXT,
  );
  const frame = decodeHostFrame(
    JSON.parse(
      encodeProtocolMessage({
        requestId: 'usage-bucket-identity-query',
        operation: 'usage.query',
        ...outcome,
      }).toString('utf8'),
    ),
  );
  if (
    'kind' in frame ||
    frame.operation !== 'usage.query' ||
    !frame.ok ||
    frame.result.kind !== 'buckets'
  ) {
    throw new Error('Expected usage buckets');
  }
  return frame.result.buckets;
}

function assertDistinctBoundedIdentities(values: readonly (string | undefined)[]): void {
  assert.equal(values.length, 6);
  assert.ok(values.every((value): value is string => typeof value === 'string'));
  assert.equal(new Set(values).size, values.length);
  for (const value of values) {
    assert.ok(Buffer.byteLength(value, 'utf8') <= USAGE_PROJECTION_TEXT_MAX_BYTES);
    assert.equal(/[\u0000-\u001f\u007f-\u009f]/u.test(value), false);
  }
}

function pricing(modelKey: string) {
  return { modelKey, inputUsdPer1M: 1, outputUsdPer1M: 2 };
}

function customPricingEntry(
  modelKey: string,
  resetEffect: 'restore_builtin' | 'become_unpriced' = 'become_unpriced',
): EffectivePricingEntry {
  return customPricingConfigEntry(pricing(modelKey), resetEffect);
}

function customPricingConfigEntry(
  config: PricingConfig,
  resetEffect: 'restore_builtin' | 'become_unpriced' = 'become_unpriced',
): EffectivePricingEntry {
  return {
    pricing: config,
    source: 'custom',
    resetEffect,
  };
}

function maximumCjkPricing(index: number) {
  return {
    modelKey: String.fromCodePoint(0x4e00 + index).repeat(PRICING_MODEL_KEY_MAX_CHARS),
    inputUsdPer1M: Number.MAX_VALUE,
    outputUsdPer1M: Number.MAX_VALUE,
    cacheReadUsdPer1M: Number.MAX_VALUE,
    cacheWriteUsdPer1M: Number.MAX_VALUE,
  };
}

function usageRequest(input: unknown): void {
  decodeClientFrame({ requestId: 'usage-request', operation: 'usage.query', input });
}

function usageResponse(result: unknown): void {
  decodeHostFrame({
    requestId: 'usage-response',
    operation: 'usage.query',
    ok: true,
    result,
  });
}

function pricingRequest(operation: 'pricing.query' | 'pricing.mutate', input: unknown): void {
  decodeClientFrame({ requestId: 'pricing-request', operation, input });
}

function pricingResponse(operation: 'pricing.query' | 'pricing.mutate', result: unknown): void {
  decodeHostFrame({ requestId: 'pricing-response', operation, ok: true, result });
}

function invalidFrame(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
