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
import { acquireOperationalStateDatabase } from '@maka/storage/operational-state-store';
import { openInteractiveUsageStoresForWrite } from '@maka/storage/usage-stores';
import {
  decodeClientFrame,
  decodeHostFrame,
  decodeUsageSnapshotReleaseInput,
  decodeUsageSnapshotReleaseResult,
  decodeUsageQueryInput,
  decodeUsageQueryResult,
  encodePricingQueryResult,
  encodeProtocolMessage,
  PRICING_PAGE_MAX_BYTES,
  PRICING_PAGE_MAX_ITEMS,
  REMOTE_OWNER_OPERATION_GRANTS,
  RUNTIME_HOST_MAX_MESSAGE_BYTES,
  USAGE_PAGE_MAX_BYTES,
  USAGE_PAGE_MAX_ITEMS,
  USAGE_PROJECTION_TEXT_MAX_BYTES,
  USAGE_SNAPSHOT_ACTIVITY_MAX_ITEMS,
  type EffectivePricingEntry,
  type LlmUsageLogProjection,
  type ToolUsageLogProjection,
  type UsageQueryResult,
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
  test('decodes the exact Usage snapshot release input and output', () => {
    assert.equal(REMOTE_OWNER_OPERATION_GRANTS.includes('usage.snapshot.release'), true);
    assert.deepEqual(decodeUsageSnapshotReleaseInput({ revision: 'snapshot-revision-1' }), {
      revision: 'snapshot-revision-1',
    });
    assert.deepEqual(decodeUsageSnapshotReleaseResult({ released: true }), { released: true });
    assert.deepEqual(
      decodeClientFrame({
        requestId: 'usage-release-request',
        operation: 'usage.snapshot.release',
        input: { revision: 'snapshot-revision-1' },
      }),
      {
        requestId: 'usage-release-request',
        operation: 'usage.snapshot.release',
        input: { revision: 'snapshot-revision-1' },
      },
    );

    for (const input of [{}, { revision: '' }, { revision: 'snapshot-revision-1', extra: true }]) {
      assert.throws(() => decodeUsageSnapshotReleaseInput(input), invalidFrame);
    }
    for (const result of [{}, { released: false }, { released: true, extra: true }]) {
      assert.throws(() => decodeUsageSnapshotReleaseResult(result), invalidFrame);
    }
  });

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
    for (const result of [
      {
        kind: 'snapshot_started',
        revision: 'snapshot-revision-1',
        summary: validSummary(),
        provenance: validProvenance(),
        extra: true,
      },
      {
        kind: 'snapshot_logs',
        revision: 'snapshot-revision-1',
        source: 'llm',
        rows: [validLog()],
        offset: 0,
        total: 2,
        nextOffset: 0,
        truncated: false,
      },
      {
        kind: 'snapshot_logs',
        revision: 'snapshot-revision-1',
        source: 'llm',
        rows: [validLog()],
        offset: 0,
        total: 1,
        nextOffset: null,
        truncated: 'no',
      },
      {
        kind: 'snapshot_pricing',
        revision: 'snapshot-revision-1',
        entries: Array.from({ length: PRICING_PAGE_MAX_ITEMS + 1 }, (_, index) =>
          customPricingEntry(`provider:model-${index}`),
        ),
        offset: 0,
        total: PRICING_PAGE_MAX_ITEMS + 1,
        nextOffset: null,
      },
      { kind: 'revision_changed', expectedRevision: '' },
    ]) {
      assert.throws(() => usageResponse(result), invalidFrame);
    }
  });

  test('rejects Usage snapshot totals above the activity maximum', () => {
    assert.throws(
      () =>
        decodeUsageQueryResult({
          kind: 'snapshot_logs',
          revision: 'snapshot-revision-1',
          source: 'llm',
          rows: [validLog()],
          offset: 0,
          total: USAGE_SNAPSHOT_ACTIVITY_MAX_ITEMS + 1,
          nextOffset: 1,
          truncated: true,
        }),
      invalidFrame,
    );
  });

  test('decodes revision-pinned Usage snapshot start, log, and pricing pages', () => {
    assert.doesNotThrow(() => usageRequest({ kind: 'snapshot_start', range: { from: 1, to: 2 } }));
    assert.doesNotThrow(() =>
      usageRequest({
        kind: 'snapshot_logs',
        revision: 'snapshot-revision-1',
        source: 'llm',
        offset: 0,
        limit: 3,
      }),
    );
    assert.doesNotThrow(() =>
      usageRequest({
        kind: 'snapshot_pricing',
        revision: 'snapshot-revision-1',
        offset: 0,
        limit: 3,
      }),
    );

    assert.doesNotThrow(() =>
      usageResponse({
        kind: 'snapshot_started',
        revision: 'snapshot-revision-1',
        summary: validSummary(),
        provenance: validProvenance(),
      }),
    );
    assert.doesNotThrow(() =>
      usageResponse({
        kind: 'snapshot_logs',
        revision: 'snapshot-revision-1',
        source: 'llm',
        rows: [validLog()],
        offset: 0,
        total: 1,
        nextOffset: null,
        truncated: false,
      }),
    );
    assert.doesNotThrow(() =>
      usageResponse({
        kind: 'snapshot_pricing',
        revision: 'snapshot-revision-1',
        entries: [customPricingEntry('provider:model')],
        offset: 0,
        total: 1,
        nextOffset: null,
      }),
    );
    assert.doesNotThrow(() =>
      usageResponse({ kind: 'revision_changed', expectedRevision: 'snapshot-revision-1' }),
    );

    for (const input of [
      { kind: 'snapshot_start', range: 'all', revision: 'unexpected' },
      { kind: 'snapshot_logs', revision: '', source: 'llm', offset: 0, limit: 1 },
      {
        kind: 'snapshot_logs',
        revision: 'x'.repeat(129),
        source: 'llm',
        offset: 0,
        limit: 1,
      },
      {
        kind: 'snapshot_logs',
        revision: 'snapshot-revision-1',
        source: 'model',
        offset: 0,
        limit: 1,
      },
      {
        kind: 'snapshot_pricing',
        revision: 'snapshot-revision-1',
        offset: 0,
        limit: PRICING_PAGE_MAX_ITEMS + 1,
      },
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
    // The Host-resolved session title rides on both log kinds as bounded text.
    assert.doesNotThrow(() =>
      usageResponse({
        kind: 'logs',
        source: 'llm',
        rows: [{ ...validLog(), sessionId: 'session-1', sessionTitle: '重构任务列' }],
        offset: 0,
        total: 1,
        nextOffset: null,
        provenance: validProvenance(),
      }),
    );
    assert.doesNotThrow(() =>
      usageResponse({
        kind: 'logs',
        source: 'tool',
        rows: [{ ...validToolLog(), sessionId: 'session-1', sessionTitle: '重构任务列' }],
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
        rows: [{ ...validLog(), sessionTitle: 'x'.repeat(USAGE_PROJECTION_TEXT_MAX_BYTES + 1) }],
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

  test('a summary always carries its recorded time; only the tool split is optional', () => {
    // The epoch bump makes the duration basis a handshake requirement, so a
    // summary without one is not an older host — it is a malformed frame.
    assert.doesNotThrow(() =>
      usageResponse({
        kind: 'summary',
        summary: {
          ...validSummary(),
          totalDurationMs: 1_500,
          toolUsage: { requests: 3, durationMs: 450 },
        },
        provenance: validProvenance(),
      }),
    );
    assert.doesNotThrow(() =>
      usageResponse({
        kind: 'summary',
        summary: validSummary(),
        provenance: validProvenance(),
      }),
    );
    assert.throws(
      () =>
        usageResponse({
          kind: 'summary',
          summary: { ...validSummary(), totalDurationMs: undefined },
          provenance: validProvenance(),
        }),
      invalidFrame,
    );
    assert.throws(
      () =>
        usageResponse({
          kind: 'summary',
          summary: { ...validSummary(), toolUsage: { requests: 3 } },
          provenance: validProvenance(),
        }),
      invalidFrame,
    );
    assert.throws(
      () =>
        usageResponse({
          kind: 'summary',
          summary: { ...validSummary(), totalDurationMs: -1 },
          provenance: validProvenance(),
        }),
      invalidFrame,
    );
    // An unknown key is still an unknown key, optional or not.
    assert.throws(
      () =>
        usageResponse({
          kind: 'summary',
          summary: { ...validSummary(), totalWallClockMs: 1 },
          provenance: validProvenance(),
        }),
      invalidFrame,
    );
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
              INSERT INTO core_agent_runs(session_id, run_id, created_at)
              VALUES ('session-b', 'run-b', 0)
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

  test('leases Usage snapshots to connections with renewable idle and bounded hard lifetime', async () => {
    const base = await mkdtemp(join(tmpdir(), 'maka-usage-snapshot-'));
    const capability = await resolveStorageRoot({
      path: join(base, 'interactive-root'),
      kind: 'interactive',
    });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    const stores = await openInteractiveUsageStoresForWrite(owner.lease);
    let now = 1_000;
    let nextRevision = 0;
    try {
      await stores.telemetry.recordLlmCall(longUsageRecord('old-llm', 1));
      await stores.telemetry.recordToolInvocation(longToolRecord('old-tool', 1));
      await stores.pricing.upsert(0, pricing('snapshot:old'));
      const coordinator = new HostUsagePricingCoordinator(
        stores,
        () => {},
        new RuntimePolicyActivationGate(),
        () => {},
        async (sessionId) => `Title ${sessionId}`,
        {
          now: () => now,
          createRevision: () => `snapshot-${++nextRevision}`,
          ttlMs: 100,
          hardTtlMs: 250,
          capacity: 2,
          activityLimit: 1,
        },
      );

      const connectionA = connectionContext('connection-a');
      const connectionB = connectionContext('connection-b');
      const connectionC = connectionContext('connection-c');
      const first = await expectUsageSnapshotStart(coordinator, connectionA);
      assert.equal(first.revision, 'snapshot-1');
      assert.equal(first.summary.totalRequests, 1);

      await stores.telemetry.recordLlmCall(longUsageRecord('new-llm', 2));
      await stores.telemetry.recordToolInvocation(longToolRecord('new-tool', 2));
      await stores.pricing.upsert(1, pricing('snapshot:new'));

      assert.deepEqual(
        await queryUsageSnapshotLogs(coordinator, first.revision, 'llm', connectionB),
        { kind: 'revision_changed', expectedRevision: first.revision },
      );
      assert.deepEqual(
        await coordinator.handlers['usage.snapshot.release'](
          { revision: first.revision },
          connectionB,
        ),
        { ok: true, result: { released: true } },
      );
      const oldLlm = await expectUsageSnapshotLogs(coordinator, first.revision, 'llm', connectionA);
      const oldTool = await expectUsageSnapshotLogs(
        coordinator,
        first.revision,
        'tool',
        connectionA,
      );
      const oldPricing = await expectUsageSnapshotPricing(coordinator, first.revision, connectionA);
      assert.deepEqual(
        oldLlm.rows.map((row) => row.id),
        ['old-llm'],
      );
      assert.equal(oldLlm.rows[0]?.sessionTitle, 'Title old-llm');
      assert.deepEqual(
        oldTool.rows.map((row) => row.id),
        ['old-tool'],
      );
      assert.equal(oldTool.rows[0]?.sessionTitle, 'Title old-tool');
      assert.equal(oldLlm.total, 1);
      assert.equal(oldLlm.truncated, false);
      assert.ok(oldPricing.entries.some((entry) => entry.pricing.modelKey === 'snapshot:old'));
      assert.ok(!oldPricing.entries.some((entry) => entry.pricing.modelKey === 'snapshot:new'));

      const second = await expectUsageSnapshotStart(coordinator, connectionB);
      const newLlm = await expectUsageSnapshotLogs(
        coordinator,
        second.revision,
        'llm',
        connectionB,
      );
      assert.deepEqual(
        newLlm.rows.map((row) => row.id),
        ['new-llm'],
      );
      assert.equal(newLlm.total, 1, 'total describes retained rows');
      assert.equal(newLlm.truncated, true, 'truncation describes discarded authority rows');

      assert.deepEqual(
        await coordinator.handlers['usage.query'](
          { kind: 'snapshot_start', range: 'all' },
          connectionC,
        ),
        {
          ok: false,
          error: {
            code: 'operation_conflict',
            message: 'Usage snapshot capacity is occupied',
          },
        },
      );
      assert.equal(
        (await queryUsageSnapshotLogs(coordinator, second.revision, 'llm', connectionB)).kind,
        'snapshot_logs',
        'capacity pressure preserves every active lease',
      );

      now = 1_090;
      await expectUsageSnapshotLogs(coordinator, first.revision, 'llm', connectionA);
      now = 1_180;
      await expectUsageSnapshotLogs(coordinator, first.revision, 'llm', connectionA);
      now = 1_249;
      await expectUsageSnapshotLogs(coordinator, first.revision, 'llm', connectionA);
      now = 1_250;
      assert.deepEqual(
        await queryUsageSnapshotLogs(coordinator, first.revision, 'llm', connectionA),
        { kind: 'revision_changed', expectedRevision: first.revision },
      );

      assert.deepEqual(
        await coordinator.handlers['usage.snapshot.release'](
          { revision: first.revision },
          connectionA,
        ),
        { ok: true, result: { released: true } },
      );
      assert.deepEqual(
        await coordinator.handlers['usage.snapshot.release'](
          { revision: first.revision },
          connectionA,
        ),
        { ok: true, result: { released: true } },
      );
      const third = await expectUsageSnapshotStart(coordinator, connectionC);
      coordinator.releaseConnection(connectionC.connectionId);
      assert.deepEqual(
        await queryUsageSnapshotLogs(coordinator, third.revision, 'llm', connectionC),
        { kind: 'revision_changed', expectedRevision: third.revision },
      );
      await expectUsageSnapshotStart(coordinator, connectionA);
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

  test('bounds concurrent Session title reads while retaining every snapshot title', async () => {
    const base = await mkdtemp(join(tmpdir(), 'maka-usage-snapshot-titles-'));
    const capability = await resolveStorageRoot({
      path: join(base, 'interactive-root'),
      kind: 'interactive',
    });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    const stores = await openInteractiveUsageStoresForWrite(owner.lease);
    const sessionIds = Array.from({ length: 20 }, (_, index) => `session-${index}`);
    let inFlight = 0;
    let maxInFlight = 0;
    try {
      await Promise.all(
        sessionIds.map((sessionId, index) =>
          stores.telemetry.recordLlmCall(longUsageRecord(sessionId, index + 1)),
        ),
      );
      const coordinator = new HostUsagePricingCoordinator(
        stores,
        () => {},
        new RuntimePolicyActivationGate(),
        () => {},
        async (sessionId) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await Promise.resolve();
          inFlight -= 1;
          return `Title ${sessionId}`;
        },
      );

      const snapshot = await expectUsageSnapshotStart(coordinator);
      const logs = await expectUsageSnapshotLogs(coordinator, snapshot.revision, 'llm');

      assert.equal(logs.rows.length, sessionIds.length);
      for (const row of logs.rows) {
        assert.equal(row.sessionTitle, `Title ${row.sessionId}`);
      }
      assert.ok(
        maxInFlight <= 16,
        `Session title read concurrency ${maxInFlight} exceeded the limit`,
      );
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

  test('reserves capacity before overlapping snapshot title hydration', async () => {
    const base = await mkdtemp(join(tmpdir(), 'maka-usage-snapshot-reservations-'));
    const capability = await resolveStorageRoot({
      path: join(base, 'interactive-root'),
      kind: 'interactive',
    });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    const stores = await openInteractiveUsageStoresForWrite(owner.lease);
    const releaseTitles = deferred();
    const fourTitlesEntered = deferred();
    const inFlight: Promise<unknown>[] = [];
    let titleReads = 0;
    try {
      await stores.telemetry.recordLlmCall(longUsageRecord('barrier-session', 1));
      const coordinator = new HostUsagePricingCoordinator(
        stores,
        () => {},
        new RuntimePolicyActivationGate(),
        () => {},
        async (sessionId) => {
          assert.equal(sessionId, 'barrier-session');
          titleReads += 1;
          if (titleReads === 4) fourTitlesEntered.resolve();
          await releaseTitles.promise;
          return 'Barrier title';
        },
      );
      const contexts = Array.from({ length: 5 }, (_, index) =>
        connectionContext(`overlap-${index}`),
      );
      const firstStarts = contexts
        .slice(0, 4)
        .map((context) =>
          coordinator.handlers['usage.query']({ kind: 'snapshot_start', range: 'all' }, context),
        );
      inFlight.push(...firstStarts);
      await within(
        fourTitlesEntered.promise,
        1_000,
        'Four admitted snapshot starts did not reach title hydration',
      );

      const fifthStart = coordinator.handlers['usage.query'](
        { kind: 'snapshot_start', range: 'all' },
        contexts[4]!,
      );
      inFlight.push(fifthStart);
      let admissionFailure: unknown;
      try {
        const fifthBeforeRelease = await within(
          fifthStart,
          1_000,
          'Fifth snapshot start reached expensive work before capacity conflict',
        );
        assert.deepEqual(fifthBeforeRelease, {
          ok: false,
          error: {
            code: 'operation_conflict',
            message: 'Usage snapshot capacity is occupied',
          },
        });
        assert.equal(titleReads, 4, 'only admitted starts may hydrate Session titles');
      } catch (error) {
        admissionFailure = error;
      } finally {
        releaseTitles.resolve();
      }

      const firstOutcomes = await Promise.all(firstStarts);
      await fifthStart;
      if (admissionFailure) throw admissionFailure;
      for (const [index, outcome] of firstOutcomes.entries()) {
        assert.equal(outcome.ok, true);
        if (!outcome.ok || outcome.result.kind !== 'snapshot_started') {
          throw new Error('Admitted overlapping Usage snapshot did not start');
        }
        const logs = await expectUsageSnapshotLogs(
          coordinator,
          outcome.result.revision,
          'llm',
          contexts[index]!,
        );
        assert.equal(logs.rows[0]?.sessionTitle, 'Barrier title');
      }
      assert.equal(titleReads, 4);
    } finally {
      releaseTitles.resolve();
      await Promise.allSettled(inFlight);
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
    totalDurationMs: 1_200,
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

async function expectUsageSnapshotStart(
  coordinator: HostUsagePricingCoordinator,
  context: ConnectionContext = CONNECTION_CONTEXT,
): Promise<Extract<UsageQueryResult, { kind: 'snapshot_started' }>> {
  const outcome = await coordinator.handlers['usage.query'](
    { kind: 'snapshot_start', range: 'all' },
    context,
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok || outcome.result.kind !== 'snapshot_started') {
    throw new Error('Expected a started Usage snapshot');
  }
  return outcome.result;
}

async function queryUsageSnapshotLogs(
  coordinator: HostUsagePricingCoordinator,
  revision: string,
  source: 'llm' | 'tool',
  context: ConnectionContext = CONNECTION_CONTEXT,
): Promise<Extract<UsageQueryResult, { kind: 'snapshot_logs' | 'revision_changed' }>> {
  const outcome = await coordinator.handlers['usage.query'](
    { kind: 'snapshot_logs', revision, source, offset: 0, limit: USAGE_PAGE_MAX_ITEMS },
    context,
  );
  assert.equal(outcome.ok, true);
  if (
    !outcome.ok ||
    (outcome.result.kind !== 'snapshot_logs' && outcome.result.kind !== 'revision_changed')
  ) {
    throw new Error('Expected a Usage snapshot log page');
  }
  return outcome.result;
}

async function expectUsageSnapshotLogs(
  coordinator: HostUsagePricingCoordinator,
  revision: string,
  source: 'llm' | 'tool',
  context: ConnectionContext = CONNECTION_CONTEXT,
): Promise<Extract<UsageQueryResult, { kind: 'snapshot_logs' }>> {
  const result = await queryUsageSnapshotLogs(coordinator, revision, source, context);
  if (result.kind !== 'snapshot_logs') throw new Error('Expected a retained Usage snapshot');
  assert.equal(result.source, source);
  return result;
}

async function expectUsageSnapshotPricing(
  coordinator: HostUsagePricingCoordinator,
  revision: string,
  context: ConnectionContext = CONNECTION_CONTEXT,
): Promise<{ readonly entries: readonly EffectivePricingEntry[] }> {
  const entries: EffectivePricingEntry[] = [];
  let offset = 0;
  let total: number | undefined;
  do {
    const outcome = await coordinator.handlers['usage.query'](
      { kind: 'snapshot_pricing', revision, offset, limit: PRICING_PAGE_MAX_ITEMS },
      context,
    );
    assert.equal(outcome.ok, true);
    if (!outcome.ok || outcome.result.kind !== 'snapshot_pricing') {
      throw new Error('Expected a Usage snapshot pricing page');
    }
    assert.equal(outcome.result.revision, revision);
    assert.equal(outcome.result.offset, offset);
    total ??= outcome.result.total;
    assert.equal(outcome.result.total, total);
    entries.push(...outcome.result.entries);
    if (outcome.result.nextOffset === null) break;
    offset = outcome.result.nextOffset;
  } while (true);
  assert.equal(entries.length, total);
  return { entries };
}

function connectionContext(connectionId: string): ConnectionContext {
  return { ...CONNECTION_CONTEXT, connectionId };
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
