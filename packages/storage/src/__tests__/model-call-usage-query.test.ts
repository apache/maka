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
import { describe, test } from 'node:test';
import type { ModelCallAttempt } from '@maka/core/model-call-attempt';
import {
  type ModelCallLedger,
  NO_RUN_TURN_ID,
  type UsageUnknownModelCallRecord,
} from '../model-call-ledger.js';
import {
  appendAuthorityEvent,
  modelCallAttempt as attempt,
  MODEL_CALL_NOW as NOW,
  withLedger,
  withProjectedAttempts,
} from './fixtures/model-call-attempt.js';

const ALL = { range: 'all' } as const;

/**
 * Seeds rows the way production writes them: run-owned attempts through the
 * AgentRun authority's projection, calls no run owns through the usage-unknown
 * seam. Ownership follows the writer, so a test cannot fake a no-run row by
 * projecting a sentinel turn value.
 */
async function withRecordedAttempts(
  projected: readonly ModelCallAttempt[],
  noRun: readonly UsageUnknownModelCallRecord[],
  run: (ledger: ModelCallLedger) => Promise<void>,
): Promise<void> {
  await withLedger(async (ledger, root) => {
    projected.forEach((value, index) => {
      appendAuthorityEvent(root, index, value, value.sessionId, value.runId);
    });
    await ledger.catchUpProjection();
    for (const record of noRun) await ledger.recordUsageUnknownAttempt(record);
    await run(ledger);
  });
}

/** A failed auxiliary Host call, as the usage-unknown seam records it. */
function usageUnknownAttempt(
  overrides: Partial<UsageUnknownModelCallRecord> = {},
): UsageUnknownModelCallRecord {
  return {
    attemptId: 'auxiliary-failure',
    completedAt: NOW - 100,
    sessionId: 'session-1',
    logicalCallId: 'auxiliary-failure',
    turnId: NO_RUN_TURN_ID,
    callKind: 'goal_evaluation',
    providerId: 'openai',
    modelId: 'gpt-5',
    latencyMs: 5,
    status: 'failed',
    ...overrides,
  };
}

describe('Usage answers over the canonical ledger', () => {
  test('a total never counts unpriced spend as zero, and says so in coverage', async () => {
    // The frozen pre-cutover table had nowhere to record "we could not price
    // this", so it wrote 0 and unpriced spend looked free. The total here
    // excludes it and the coverage reports it instead.
    await withProjectedAttempts(
      [
        attempt({ attemptId: 'a', costUsd: 0.004 }),
        attempt({ attemptId: 'b', costBasis: 'unpriced', costUsd: undefined }),
      ],
      async (ledger) => {
        const { projection } = ledger.summary(ALL, NOW);
        assert.equal(Math.round(projection.totalCostUsd * 1000) / 1000, 0.004);
        assert.equal(projection.totalRequests, 2);
        assert.equal(projection.coverage.pricedAttempts, 1);
        assert.equal(projection.coverage.unpricedAttempts, 1);
      },
    );
  });

  test('a genuinely free call is counted as priced, and reads apart from an unpriced one', async () => {
    await withProjectedAttempts(
      [
        attempt({ attemptId: 'free', logicalCallId: 'free', costUsd: 0 }),
        attempt({
          attemptId: 'unknown',
          logicalCallId: 'unknown',
          costBasis: 'unpriced',
          costUsd: undefined,
        }),
      ],
      async (ledger) => {
        const { projection } = ledger.summary(ALL, NOW);
        assert.equal(projection.totalCostUsd, 0);
        assert.equal(projection.coverage.pricedAttempts, 1);
        assert.equal(projection.coverage.unpricedAttempts, 1);

        // The page-level coverage says how many rows were unpriced but not which
        // ones, so a log row has to carry its own basis.
        const rows = ledger.logs(ALL, NOW, 0, 10).projection.rows;
        const free = rows.find((row) => row.id === 'free');
        const unknown = rows.find((row) => row.id === 'unknown');
        assert.equal(free?.costBasis, 'priced');
        assert.equal(free?.costUsd, 0);
        assert.equal(unknown?.costBasis, 'unpriced');
        assert.equal(Object.hasOwn(unknown ?? {}, 'costUsd'), false);
      },
    );
  });

  test('usage-missing records are reported separately from unpriced ones', async () => {
    await withProjectedAttempts(
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
      async (ledger) => {
        const { projection } = ledger.summary(ALL, NOW);
        assert.equal(projection.coverage.usageMissingAttempts, 1);
        assert.equal(projection.coverage.unpricedAttempts, 1);
        assert.equal(projection.totalTokens.total, 0);
      },
    );
  });

  test('ledger coverage counts usage-unknown rows recorded outside any run', async () => {
    // A failed auxiliary call (#5691) is accounted the same honest way as a
    // run's own unsettled dispatch, and the ledger-wide coverage — what
    // `summary()`/`logs()` report to every client — must see both. Excluding
    // the no-run rows here would hide a real unknown-usage call from the
    // public provenance and let an incomplete total read as complete; keeping
    // a hosted run to its own rows is settlement's separate job.
    await withRecordedAttempts(
      [
        attempt({
          attemptId: 'run-dispatch',
          status: 'failed',
          usageBasis: 'missing',
          inputTokens: undefined,
          outputTokens: undefined,
          costBasis: 'unpriced',
          costUsd: undefined,
        }),
      ],
      [usageUnknownAttempt()],
      async (ledger) => {
        const { projection } = ledger.summary(ALL, NOW);
        assert.equal(projection.coverage.usageMissingAttempts, 2);
        assert.equal(projection.coverage.usageReportedAttempts, 0);
        assert.equal(projection.totalRequests, 2);
      },
    );
  });

  test('run settlement coverage guards every session in the window, not the auxiliary sentinel', async () => {
    // Settlement guards the window-wide totals, so it must count every
    // Session's unsettled dispatch in that window (#5890): the pre-window
    // session filter here would have let a delegated child's missing usage
    // settle as complete. The `no_run` sentinel — the failed auxiliary call
    // the usage-unknown seam recorded — belongs to no run and stays out.
    await withRecordedAttempts(
      [
        attempt({
          attemptId: 'other-session-dispatch',
          sessionId: 'session-2',
          status: 'failed',
          usageBasis: 'missing',
          inputTokens: undefined,
          outputTokens: undefined,
          costBasis: 'unpriced',
          costUsd: undefined,
        }),
        attempt({
          attemptId: 'run-reported',
          logicalCallId: 'call-2',
        }),
        attempt({
          attemptId: 'run-partial',
          logicalCallId: 'call-3',
          usageBasis: 'partial',
          outputTokens: undefined,
        }),
        attempt({
          attemptId: 'run-missing-dispatch',
          logicalCallId: 'call-4',
          status: 'failed',
          usageBasis: 'missing',
          inputTokens: undefined,
          outputTokens: undefined,
          costBasis: 'unpriced',
          costUsd: undefined,
        }),
      ],
      [usageUnknownAttempt()],
      async (ledger) => {
        // The run's own missing dispatch and the other session's (a delegated
        // child's) both count; the `no_run` sentinel does not.
        assert.deepEqual(ledger.runSettlementCoverage(NOW - 1_000, NOW), {
          usageMissingAttempts: 2,
          usagePartialAttempts: 1,
        });
      },
    );
  });

  test('run settlement coverage excludes the no-run sentinel, not an execution named like it', async () => {
    // The exclusion must key on how a row was recorded (`no_run`), never on
    // the turn value: a hosted execution whose id is the client-chosen
    // `auxiliary` owns rows under `turn_id = 'auxiliary'`, and with window
    // scoping (#5890) those must keep counting while the genuine sentinel row
    // next to them stays out — or this execution's missing-usage dispatch
    // disappears and `incompleteUsageReason` releases the environment with
    // unknown usage.
    await withRecordedAttempts(
      [
        attempt({
          attemptId: 'run-reported',
          sessionId: 'auxiliary',
          runId: 'run-auxiliary',
          turnId: 'auxiliary',
          logicalCallId: 'call-reported',
        }),
        attempt({
          attemptId: 'run-missing-dispatch',
          sessionId: 'auxiliary',
          runId: 'run-auxiliary',
          turnId: 'auxiliary',
          logicalCallId: 'call-missing',
          status: 'failed',
          usageBasis: 'missing',
          inputTokens: undefined,
          outputTokens: undefined,
          costBasis: 'unpriced',
          costUsd: undefined,
        }),
      ],
      [usageUnknownAttempt({ sessionId: 'auxiliary' })],
      async (ledger) => {
        // The run-owned missing dispatch is this execution's unsettled
        // obligation and counts inside the window; the failed auxiliary call
        // is nobody's (`no_run`) and stays excluded. Public coverage keeps
        // counting both.
        assert.deepEqual(ledger.runSettlementCoverage(NOW - 1_000, NOW), {
          usageMissingAttempts: 1,
          usagePartialAttempts: 0,
        });
        assert.equal(
          ledger.summary({ range: 'all' }, NOW).projection.coverage.usageMissingAttempts,
          2,
        );
      },
    );
  });

  test('run settlement coverage reads the window, not one session (#5890 review)', async () => {
    // Settlement guards the window-wide totals that #readUsage reads, so its
    // coverage must read the same window: a child Session's missing dispatch
    // inside the window is exactly the undercount that would otherwise settle
    // as complete, and a window-external row is nobody's obligation here.
    await withRecordedAttempts(
      [
        attempt({
          attemptId: 'outside-window-missing',
          completedAt: NOW - 5_000,
          status: 'failed',
          usageBasis: 'missing',
          inputTokens: undefined,
          outputTokens: undefined,
          costBasis: 'unpriced',
          costUsd: undefined,
        }),
        attempt({ attemptId: 'root-ok' }),
        attempt({
          attemptId: 'child-missing',
          sessionId: 'session-1-child',
          status: 'failed',
          usageBasis: 'missing',
          inputTokens: undefined,
          outputTokens: undefined,
          costBasis: 'unpriced',
          costUsd: undefined,
        }),
      ],
      [],
      async (ledger) => {
        assert.deepEqual(ledger.runSettlementCoverage(NOW - 1_000, NOW), {
          usageMissingAttempts: 1,
          usagePartialAttempts: 0,
        });
      },
    );
  });

  test('one malformed cache reading cannot inflate the cache total', async () => {
    await withProjectedAttempts(
      [
        attempt({ attemptId: 'malformed-cache', inputTokens: 100, cacheReadInputTokens: 200 }),
        attempt({ attemptId: 'cache-miss', inputTokens: 100, cacheReadInputTokens: 0 }),
      ],
      async (ledger) => {
        const { projection } = ledger.summary(ALL, NOW);
        assert.equal(projection.totalTokens.input, 200);
        assert.equal(projection.totalTokens.cacheRead, 100);
      },
    );
  });

  test('provider cache-only evidence survives without inventing an input total', async () => {
    await withProjectedAttempts(
      [
        attempt({
          attemptId: 'cache-only',
          usageBasis: 'partial',
          inputTokens: undefined,
          outputTokens: undefined,
          cacheReadInputTokens: 10,
        }),
      ],
      async (ledger) => {
        const summary = ledger.summary(ALL, NOW).projection;
        assert.equal(summary.totalTokens.input, 0);
        assert.equal(summary.totalTokens.cacheRead, 10);
        assert.equal(summary.cacheHitRequests, 1);
        assert.equal(summary.coverage.usagePartialAttempts, 1);

        const bucket = ledger.buckets(ALL, 'provider', NOW).projection.buckets[0];
        assert.equal(bucket?.inputTokens, 0);
        assert.equal(bucket?.cacheReadTokens, 10);

        const log = ledger.logs(ALL, NOW, 0, 10).projection.rows[0];
        assert.equal(log?.inputTokens, 0);
        assert.equal(log?.cacheReadTokens, 10);
      },
    );
  });

  test('the summary sums recorded call time over the rows it counts', async () => {
    await withProjectedAttempts(
      [
        attempt({ attemptId: 'a', logicalCallId: 'a', latencyMs: 1_200 }),
        attempt({ attemptId: 'b', logicalCallId: 'b', latencyMs: 300 }),
      ],
      async (ledger) => {
        const { projection } = ledger.summary(ALL, NOW);
        assert.equal(projection.totalDurationMs, 1_500);
        assert.equal(projection.totalRequests, 2);
      },
    );
  });

  test('filters by Session, window, provider, model, and status', async () => {
    await withProjectedAttempts(
      [
        attempt({ attemptId: 'recent' }),
        attempt({
          attemptId: 'old',
          startedAt: NOW - 40 * 86_400_000 - 1,
          completedAt: NOW - 40 * 86_400_000,
        }),
        attempt({ attemptId: 'other-provider', providerId: 'openai', modelId: 'gpt-x' }),
        attempt({ attemptId: 'failed', status: 'failed' }),
        attempt({ attemptId: 'other-session', sessionId: 'session-2', runId: 'run-2' }),
      ],
      async (ledger) => {
        const requests = (query: Parameters<typeof ledger.summary>[0]) =>
          ledger.summary(query, NOW).projection.totalRequests;
        assert.equal(requests({ range: '24h' }), 4);
        assert.equal(requests({ range: 'all', sessionId: 'session-1' }), 4);
        assert.equal(requests({ range: 'all', providerId: 'openai' }), 1);
        assert.equal(requests({ range: 'all', modelId: 'claude-opus-5' }), 4);
        assert.equal(requests({ range: 'all', status: 'error' }), 1);
        assert.equal(requests({ range: 'all', status: 'all' }), 5);
      },
    );
  });

  test('interrupted counts as aborted, not as an error', async () => {
    // Collapsing a cut-short call into `error` would inflate the error rate
    // with user cancellations.
    await withProjectedAttempts(
      [attempt({ attemptId: 'cut', status: 'interrupted' })],
      async (ledger) => {
        assert.equal(ledger.summary(ALL, NOW).projection.errorRequests, 0);
        assert.equal(
          ledger.summary({ range: 'all', status: 'aborted' }, NOW).projection.totalRequests,
          1,
        );
      },
    );
  });

  test('buckets group by provider and by model, excluding unpriced cost', async () => {
    await withProjectedAttempts(
      [
        attempt({ attemptId: 'a', costUsd: 0.004 }),
        attempt({ attemptId: 'b', costUsd: 0.006 }),
        attempt({
          attemptId: 'c',
          providerId: 'openai',
          modelId: 'gpt-x',
          costBasis: 'unpriced',
          costUsd: undefined,
        }),
      ],
      async (ledger) => {
        const byProvider = ledger.buckets(ALL, 'provider', NOW).projection.buckets;
        assert.deepEqual(
          byProvider.map((bucket) => [bucket.key, bucket.requests]),
          [
            ['anthropic', 2],
            ['openai', 1],
          ],
        );
        assert.equal(Math.round((byProvider[0]?.costUsd ?? 0) * 1000) / 1000, 0.01);
        assert.equal(byProvider[1]?.costUsd, 0);

        const byModel = ledger.buckets(ALL, 'model', NOW).projection.buckets;
        assert.equal(byModel.length, 2);
        assert.ok(byModel.some((bucket) => bucket.key === 'anthropic:claude-opus-5'));
      },
    );
  });

  test('time buckets are named by the same key both Usage sources derive', async () => {
    // SQLite decides only which rows group together; the key is still built by
    // `usageBucketKey`. If the two disagreed about where a day starts, one day
    // would silently split into two buckets rather than fail.
    const midnight = Date.parse('2025-03-04T00:00:00.000Z');
    await withProjectedAttempts(
      [
        attempt({ attemptId: 'first', startedAt: midnight - 1, completedAt: midnight }),
        attempt({ attemptId: 'last', startedAt: midnight, completedAt: midnight + 86_399_999 }),
        attempt({ attemptId: 'next-day', startedAt: midnight, completedAt: midnight + 86_400_000 }),
      ],
      async (ledger) => {
        const byDay = ledger.buckets({ range: 'all' }, 'day', NOW).projection.buckets;
        assert.deepEqual(
          [...byDay]
            .sort((left, right) => left.key.localeCompare(right.key))
            .map((b) => [b.key, b.requests]),
          [
            ['2025-03-04', 2],
            ['2025-03-05', 1],
          ],
        );
      },
    );
  });

  test('logs page newest first and carry coverage for the whole match', async () => {
    await withProjectedAttempts(
      [
        attempt({ attemptId: 'older', startedAt: NOW - 3_500, completedAt: NOW - 3_000 }),
        attempt({ attemptId: 'newer', startedAt: NOW - 1_500, completedAt: NOW - 1_000 }),
        attempt({
          attemptId: 'unpriced',
          startedAt: NOW - 2_500,
          completedAt: NOW - 2_000,
          costBasis: 'unpriced',
          costUsd: undefined,
        }),
      ],
      async (ledger) => {
        const page = ledger.logs(ALL, NOW, 0, 2).projection;
        assert.deepEqual(
          page.rows.map((row) => row.id),
          ['newer', 'unpriced'],
        );
        assert.equal(page.total, 3);
        // Coverage describes every matching record, not just the returned page.
        assert.equal(page.coverage.attempts, 3);
        assert.equal(page.coverage.unpricedAttempts, 1);
      },
    );
  });

  test('a replayed attemptId is one call, not two', async () => {
    await withProjectedAttempts(
      [attempt({ attemptId: 'dup' }), attempt({ attemptId: 'dup', costUsd: 0.004 })],
      async (ledger) => {
        const { projection } = ledger.summary(ALL, NOW);
        assert.equal(projection.totalRequests, 1);
        assert.equal(Math.round(projection.totalCostUsd * 1000) / 1000, 0.004);
      },
    );
  });
});
