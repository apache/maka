import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { MODEL_CALL_ATTEMPT_SCHEMA_VERSION, type ModelCallAttempt } from '../model-call-attempt.js';
import { mergeUsageBuckets, mergeUsageLogs, mergeUsageSummary } from '../usage-ledger-merge.js';
import type { UsageBucket, UsageLogRow, UsageSummaryV2 } from '../usage-stats/types.js';

// A realistic epoch-ms clock: a small NOW would push relative ranges negative
// and silently fall outside the `all` range, which starts at 0.
const NOW = 1_750_000_000_000;

function attempt(overrides: Partial<ModelCallAttempt> = {}): ModelCallAttempt {
  return {
    schemaVersion: MODEL_CALL_ATTEMPT_SCHEMA_VERSION,
    logicalCallId: 'call-1',
    attemptId: 'attempt-1',
    traceId: 'trace-1',
    sessionId: 'session-1',
    runId: 'run-1',
    turnId: 'turn-1',
    step: 0,
    attempt: 0,
    callKind: 'main',
    providerId: 'anthropic',
    modelId: 'claude-opus-5',
    startedAt: NOW - 1_000,
    completedAt: NOW - 500,
    latencyMs: 500,
    status: 'completed',
    usageBasis: 'reported',
    inputTokens: 100,
    outputTokens: 20,
    costBasis: 'priced',
    costUsd: 0.004,
    ...overrides,
  };
}

function legacySummary(overrides: Partial<UsageSummaryV2> = {}): UsageSummaryV2 {
  return {
    range: { from: 0, to: NOW },
    totalRequests: 2,
    totalCostUsd: 0.01,
    totalTokens: {
      input: 300,
      output: 60,
      cacheMiss: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: 360,
    },
    cacheHitRequests: 0,
    cacheCreateRequests: 0,
    errorRequests: 1,
    ...overrides,
  };
}

function legacyLog(id: string, ts: number): UsageLogRow {
  return {
    id,
    ts,
    providerId: 'anthropic',
    modelId: 'claude-opus-5',
    inputTokens: 10,
    outputTokens: 5,
    cacheMissTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 15,
    costUsd: 0.001,
    latencyMs: 100,
    status: 'success',
  };
}

function legacyBucket(overrides: Partial<UsageBucket> = {}): UsageBucket {
  return {
    key: 'anthropic:claude-opus-5',
    label: 'anthropic:claude-opus-5',
    requests: 2,
    inputTokens: 300,
    outputTokens: 60,
    cacheMissTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 360,
    costUsd: 0.01,
    avgLatencyMs: 200,
    errorRate: 0.5,
    ...overrides,
  };
}

describe('usage ledger merge', () => {
  test('sums both sources and reports how much came from the frozen table', () => {
    const merged = mergeUsageSummary(
      legacySummary(),
      { attempts: [attempt({ attemptId: 'a' })], unreadableRecords: 0, pendingRepairs: 0 },
      { range: 'all' },
      NOW,
    );

    assert.equal(merged.totalRequests, 3);
    assert.equal(merged.totalCostUsd, 0.01 + 0.004);
    assert.equal(merged.totalTokens.input, 400);
    assert.equal(merged.totalTokens.total, 480);
    assert.equal(merged.errorRequests, 1);
    // The legacy half cannot be qualified the way canonical spend can, so it is
    // counted separately rather than folded into the coverage breakdown.
    assert.equal(merged.provenance.legacyRecords, 2);
    assert.equal(merged.provenance.coverage.attempts, 1);
    assert.equal(merged.provenance.coverage.pricedAttempts, 1);
  });

  test('unpriced canonical spend stays out of the total and is reported instead', () => {
    const merged = mergeUsageSummary(
      legacySummary({ totalRequests: 0, totalCostUsd: 0, errorRequests: 0 }),
      {
        attempts: [attempt({ attemptId: 'a', costBasis: 'unpriced', costUsd: undefined })],
        unreadableRecords: 0,
        pendingRepairs: 0,
      },
      { range: 'all' },
      NOW,
    );

    assert.equal(merged.totalCostUsd, 0);
    assert.equal(merged.totalRequests, 1);
    assert.equal(merged.provenance.coverage.unpricedAttempts, 1);
    assert.equal(merged.provenance.coverage.pricedAttempts, 0);
  });

  test('records that could not be decoded are reported, not silently dropped', () => {
    const merged = mergeUsageSummary(
      legacySummary(),
      { attempts: [], unreadableRecords: 3, pendingRepairs: 0 },
      { range: 'all' },
      NOW,
    );

    assert.equal(merged.provenance.unreadableRecords, 3);
  });

  test('buckets sharing a key combine, re-weighting the per-request means', () => {
    const merged = mergeUsageBuckets(
      [legacyBucket()],
      {
        attempts: [
          attempt({ attemptId: 'a', latencyMs: 800, status: 'completed' }),
          attempt({ attemptId: 'b', latencyMs: 800, status: 'failed' }),
        ],
        unreadableRecords: 0,
        pendingRepairs: 0,
      },
      { range: 'all' },
      'model',
      NOW,
    );

    assert.equal(merged.buckets.length, 1);
    const bucket = merged.buckets[0];
    assert.equal(bucket?.requests, 4);
    assert.equal(bucket?.costUsd, 0.01 + 0.004 + 0.004);
    // Averaging the two averages would give 500; the weighted mean over four
    // requests is (200*2 + 800*2) / 4.
    assert.equal(bucket?.avgLatencyMs, 500);
    // One legacy error out of two, one canonical error out of two.
    assert.equal(bucket?.errorRate, 0.5);
  });

  test('buckets with no counterpart in the other source pass through intact', () => {
    const merged = mergeUsageBuckets(
      [legacyBucket({ key: 'openai:gpt-5', label: 'openai:gpt-5' })],
      { attempts: [attempt({ attemptId: 'a' })], unreadableRecords: 0, pendingRepairs: 0 },
      { range: 'all' },
      'model',
      NOW,
    );

    assert.deepEqual(merged.buckets.map((bucket) => bucket.key).sort(), [
      'anthropic:claude-opus-5',
      'openai:gpt-5',
    ]);
  });

  test('log pages interleave both sources newest first and page across the boundary', () => {
    const legacyRows = [legacyLog('legacy-new', NOW - 100), legacyLog('legacy-old', NOW - 900)];
    const canonical = {
      attempts: [
        attempt({ attemptId: 'canonical-mid', logicalCallId: 'c-mid', completedAt: NOW - 400 }),
        attempt({
          attemptId: 'canonical-oldest',
          logicalCallId: 'c-old',
          completedAt: NOW - 1_200,
        }),
      ],
      unreadableRecords: 0,
      pendingRepairs: 0,
    };

    const first = mergeUsageLogs(
      { rows: legacyRows, total: 2 },
      canonical,
      { range: 'all' },
      NOW,
      0,
      2,
    );
    assert.deepEqual(
      first.rows.map((row) => row.id),
      ['legacy-new', 'canonical-mid'],
    );
    assert.equal(first.total, 4);

    const second = mergeUsageLogs(
      { rows: legacyRows, total: 2 },
      canonical,
      { range: 'all' },
      NOW,
      2,
      2,
    );
    assert.deepEqual(
      second.rows.map((row) => row.id),
      ['legacy-old', 'canonical-oldest'],
    );
    assert.equal(second.total, 4);
  });

  test('a page beyond both sources is empty rather than throwing', () => {
    const merged = mergeUsageLogs(
      { rows: [], total: 0 },
      { attempts: [], unreadableRecords: 0, pendingRepairs: 0 },
      { range: 'all' },
      NOW,
      0,
      10,
    );

    assert.deepEqual(merged.rows, []);
    assert.equal(merged.total, 0);
  });
});
