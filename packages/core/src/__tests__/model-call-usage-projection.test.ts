import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { MODEL_CALL_ATTEMPT_SCHEMA_VERSION, type ModelCallAttempt } from '../model-call-attempt.js';
import {
  projectModelCallUsageBuckets,
  projectModelCallUsageLogs,
  projectModelCallUsageSummary,
  selectModelCallAttempts,
  usageStatusForAttempt,
} from '../model-call-usage-projection.js';

// A realistic epoch-ms clock: a small NOW would push "40 days ago" negative and
// silently fall outside the `all` range, which starts at 0.
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

describe('model-call usage projection', () => {
  test('a log row keeps its cost basis, so free and unpriced stay distinguishable', () => {
    // The page-level coverage says how many rows were unpriced but not which
    // ones. Without a per-row basis a genuinely free call and a call whose
    // price could not be resolved both render as $0.
    const { rows } = projectModelCallUsageLogs(
      [
        attempt({ attemptId: 'free', logicalCallId: 'free', costBasis: 'priced', costUsd: 0 }),
        attempt({
          attemptId: 'unknown',
          logicalCallId: 'unknown',
          costBasis: 'unpriced',
          costUsd: undefined,
        }),
      ],
      { range: 'all' },
      NOW,
    );

    const free = rows.find((row) => row.id === 'free');
    const unknown = rows.find((row) => row.id === 'unknown');
    assert.equal(free?.costBasis, 'priced');
    assert.equal(free?.costUsd, 0);
    assert.equal(unknown?.costBasis, 'unpriced');
    assert.equal(unknown?.costUsd, undefined);
    assert.equal(Object.hasOwn(unknown ?? {}, 'costUsd'), false);
  });

  test('a total never counts unpriced spend as zero, and says so in coverage', () => {
    // The old per-send table had nowhere to record "we could not price this",
    // so it wrote 0 and unpriced spend looked free. The total here excludes it
    // and the coverage reports it instead.
    const summary = projectModelCallUsageSummary(
      [
        attempt({ attemptId: 'a', costUsd: 0.004 }),
        attempt({ attemptId: 'b', costBasis: 'unpriced', costUsd: undefined }),
      ],
      { range: 'all' },
      NOW,
    );
    assert.equal(Math.round(summary.totalCostUsd * 1000) / 1000, 0.004);
    assert.equal(summary.totalRequests, 2);
    assert.equal(summary.coverage.pricedAttempts, 1);
    assert.equal(summary.coverage.unpricedAttempts, 1);
  });

  test('a genuinely free call is still counted as priced', () => {
    const summary = projectModelCallUsageSummary(
      [attempt({ attemptId: 'free', costUsd: 0 })],
      { range: 'all' },
      NOW,
    );
    assert.equal(summary.totalCostUsd, 0);
    assert.equal(summary.coverage.pricedAttempts, 1);
    assert.equal(summary.coverage.unpricedAttempts, 0);
  });

  test('usage-missing records are reported separately from unpriced ones', () => {
    const summary = projectModelCallUsageSummary(
      [
        attempt({
          attemptId: 'no-usage',
          status: 'failed',
          usageBasis: 'missing',
          inputTokens: undefined,
          outputTokens: undefined,
          costBasis: 'unpriced',
          costUsd: undefined,
        }),
      ],
      { range: 'all' },
      NOW,
    );
    assert.equal(summary.coverage.usageMissingAttempts, 1);
    assert.equal(summary.coverage.unpricedAttempts, 1);
    assert.equal(summary.totalTokens.total, 0);
  });

  test('a replayed attemptId is counted once', () => {
    const row = attempt({ attemptId: 'dup' });
    const summary = projectModelCallUsageSummary([row, row], { range: 'all' }, NOW);
    assert.equal(summary.totalRequests, 1);
    assert.equal(Math.round(summary.totalCostUsd * 1000) / 1000, 0.004);
  });

  test('filters by range, provider, model, and status', () => {
    const rows = [
      attempt({ attemptId: 'recent' }),
      attempt({ attemptId: 'old', completedAt: NOW - 40 * 86_400_000 }),
      attempt({ attemptId: 'other-provider', providerId: 'openai', modelId: 'gpt-x' }),
      attempt({ attemptId: 'failed', status: 'failed' }),
    ];
    assert.equal(selectModelCallAttempts(rows, { range: '24h' }, NOW).rows.length, 3);
    assert.equal(
      selectModelCallAttempts(rows, { range: 'all', providerId: 'openai' }, NOW).rows.length,
      1,
    );
    assert.equal(
      selectModelCallAttempts(rows, { range: 'all', modelId: 'claude-opus-5' }, NOW).rows.length,
      3,
    );
    assert.equal(
      selectModelCallAttempts(rows, { range: 'all', status: 'error' }, NOW).rows.length,
      1,
    );
    assert.equal(
      selectModelCallAttempts(rows, { range: 'all', status: 'all' }, NOW).rows.length,
      4,
    );
  });

  test('interrupted counts as aborted, not as an error', () => {
    // Collapsing a cut-short call into `error` would inflate the error rate
    // with user cancellations.
    assert.equal(usageStatusForAttempt('completed'), 'success');
    assert.equal(usageStatusForAttempt('failed'), 'error');
    assert.equal(usageStatusForAttempt('aborted'), 'aborted');
    assert.equal(usageStatusForAttempt('interrupted'), 'aborted');

    const summary = projectModelCallUsageSummary(
      [attempt({ attemptId: 'cut', status: 'interrupted' })],
      { range: 'all' },
      NOW,
    );
    assert.equal(summary.errorRequests, 0);
  });

  test('buckets group by provider and model and exclude unpriced cost', () => {
    const rows = [
      attempt({ attemptId: 'a', providerId: 'anthropic', costUsd: 0.004 }),
      attempt({ attemptId: 'b', providerId: 'anthropic', costUsd: 0.006 }),
      attempt({
        attemptId: 'c',
        providerId: 'openai',
        modelId: 'gpt-x',
        costBasis: 'unpriced',
        costUsd: undefined,
      }),
    ];
    const byProvider = projectModelCallUsageBuckets(rows, { range: 'all' }, 'provider', NOW);
    assert.deepEqual(
      byProvider.map((b) => [b.key, b.requests]),
      [
        ['anthropic', 2],
        ['openai', 1],
      ],
    );
    assert.equal(Math.round((byProvider[0]?.costUsd ?? 0) * 1000) / 1000, 0.01);
    assert.equal(byProvider[1]?.costUsd, 0);

    const byModel = projectModelCallUsageBuckets(rows, { range: 'all' }, 'model', NOW);
    assert.equal(byModel.length, 2);
    assert.ok(byModel.some((b) => b.key === 'anthropic:claude-opus-5'));
  });

  test('logs page newest first and carry coverage for the whole match', () => {
    const rows = [
      attempt({ attemptId: 'older', completedAt: NOW - 3_000 }),
      attempt({ attemptId: 'newer', completedAt: NOW - 1_000 }),
      attempt({
        attemptId: 'unpriced',
        completedAt: NOW - 2_000,
        costBasis: 'unpriced',
        costUsd: undefined,
      }),
    ];
    const page = projectModelCallUsageLogs(rows, { range: 'all' }, NOW, 0, 2);
    assert.deepEqual(
      page.rows.map((r) => r.id),
      ['newer', 'unpriced'],
    );
    assert.equal(page.total, 3);
    // Coverage describes every matching record, not just the returned page.
    assert.equal(page.coverage.attempts, 3);
    assert.equal(page.coverage.unpricedAttempts, 1);
  });
});
