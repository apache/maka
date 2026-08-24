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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MODEL_CALL_DIAGNOSTIC_FIELD_MAX_LENGTH,
  MODEL_CALL_ATTEMPT_SCHEMA_VERSION,
  decodeModelCallAttempt,
  groupModelCallAttempts,
  settledAttempt,
  sumModelCallCostUsd,
  summarizeModelCallCoverage,
  type ModelCallAttempt,
} from '../model-call-attempt.js';

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
    startedAt: 1_000,
    completedAt: 1_250,
    latencyMs: 250,
    status: 'completed',
    usageBasis: 'reported',
    inputTokens: 100,
    outputTokens: 20,
    costBasis: 'priced',
    costUsd: 0.004,
    ...overrides,
  };
}

describe('ModelCallAttempt codec', () => {
  test('accepts bounded provider failure diagnostics on history compaction calls', () => {
    const decoded = decodeModelCallAttempt(
      attempt({
        callKind: 'history_compact',
        historyCompactRoute: 'provider_native',
        status: 'failed',
        errorClass: 'RateLimit',
        httpStatus: 429,
        providerCode: 'rate_limit_exceeded',
        providerRequestId: 'req-123',
        retryable: true,
      }),
    );

    assert.equal(decoded.historyCompactRoute, 'provider_native');
    assert.equal(decoded.httpStatus, 429);
    assert.equal(decoded.providerRequestId, 'req-123');
  });

  test('rejects invalid or unbounded provider failure diagnostics', () => {
    assert.throws(() => decodeModelCallAttempt(attempt({ httpStatus: 99, status: 'failed' })));
    assert.throws(() =>
      decodeModelCallAttempt(
        attempt({
          status: 'failed',
          providerCode: 'x'.repeat(MODEL_CALL_DIAGNOSTIC_FIELD_MAX_LENGTH + 1),
        }),
      ),
    );
    assert.throws(
      () => decodeModelCallAttempt(attempt({ historyCompactRoute: 'text_summary' })),
      /non-compaction call carries historyCompactRoute/,
    );
  });

  test('rejects an unpriced attempt that carries a cost', () => {
    assert.throws(
      () => decodeModelCallAttempt(attempt({ costBasis: 'unpriced', costUsd: 0 })),
      /unpriced record carries a cost/,
    );
  });

  test('rejects a priced attempt that carries no cost', () => {
    // Otherwise coverage counts it as priced while the sum skips it, and
    // "every call priced, total $0" reads as genuinely free.
    assert.throws(
      () => decodeModelCallAttempt(attempt({ costBasis: 'priced', costUsd: undefined })),
      /priced record carries no cost/,
    );
  });

  test('rejects missing usage that still carries tokens', () => {
    assert.throws(
      () => decodeModelCallAttempt(attempt({ usageBasis: 'missing' })),
      /missing usage but carries tokens/,
    );
  });

  test('rejects completedAt before startedAt', () => {
    assert.throws(
      () => decodeModelCallAttempt(attempt({ startedAt: 2_000, completedAt: 1_000 })),
      /completedAt precedes startedAt/,
    );
  });

  test('rejects unknown fields, wrong schema version, and bad enums', () => {
    assert.throws(() => decodeModelCallAttempt({ ...attempt(), unexpected: true } as unknown));
    assert.throws(() => decodeModelCallAttempt(attempt({ schemaVersion: 2 as never })));
    assert.throws(() => decodeModelCallAttempt(attempt({ callKind: 'tool' as never })));
    assert.throws(() => decodeModelCallAttempt(attempt({ usageBasis: 'guessed' as never })));
    assert.throws(() => decodeModelCallAttempt(attempt({ costBasis: 'free' as never })));
  });

  test('rejects empty identity and non-integer ordinals', () => {
    assert.throws(() => decodeModelCallAttempt(attempt({ logicalCallId: '' })));
    assert.throws(() => decodeModelCallAttempt(attempt({ attemptId: '' })));
    assert.throws(() => decodeModelCallAttempt(attempt({ step: 1.5 })));
    assert.throws(() => decodeModelCallAttempt(attempt({ attempt: -1 })));
  });

  test('rejects empty attribution keys', () => {
    for (const field of ['traceId', 'sessionId', 'runId', 'turnId', 'providerId', 'modelId']) {
      assert.throws(
        () => decodeModelCallAttempt(attempt({ [field]: '' } as Partial<ModelCallAttempt>)),
        `expected empty ${field} to be rejected`,
      );
    }
  });

  test('rejects negative and non-finite amounts', () => {
    for (const costUsd of [-1, Number.NaN]) {
      assert.throws(() => decodeModelCallAttempt(attempt({ costUsd })));
    }
    for (const inputTokens of [-1, Number.NaN]) {
      assert.throws(() => decodeModelCallAttempt(attempt({ inputTokens })));
    }
    assert.throws(() => decodeModelCallAttempt(attempt({ latencyMs: -1 })));
    assert.throws(() => decodeModelCallAttempt(attempt({ pricingRevision: -1 })));
  });

  test('validates optional pricing rates when present', () => {
    const decoded = decodeModelCallAttempt(
      attempt({
        pricingRevision: 7,
        pricingRates: { modelKey: 'claude-opus-5', inputUsdPer1M: 15, outputUsdPer1M: 75 },
      }),
    );
    assert.equal(decoded.pricingRevision, 7);
    // Incomplete, negative, or unrecognized rate shapes make a recorded amount
    // unexplainable, which defeats storing the basis at all.
    assert.throws(() =>
      decodeModelCallAttempt(attempt({ pricingRates: { modelKey: 'x' } as never })),
    );
    assert.throws(() =>
      decodeModelCallAttempt(
        attempt({
          pricingRates: { modelKey: 'x', inputUsdPer1M: -1, outputUsdPer1M: 75 } as never,
        }),
      ),
    );
    assert.throws(() =>
      decodeModelCallAttempt(
        attempt({
          pricingRates: {
            modelKey: 'x',
            inputUsdPer1M: 15,
            outputUsdPer1M: 75,
            surcharge: 3,
          } as never,
        }),
      ),
    );
  });
});

describe('ModelCallAttempt projections', () => {
  test('groups retries under one logical call and derives the settled attempt', () => {
    const groups = groupModelCallAttempts([
      attempt({ attemptId: 'a-0', attempt: 0, status: 'failed', costUsd: 0.001 }),
      attempt({ attemptId: 'a-1', attempt: 1, status: 'completed', costUsd: 0.004 }),
      attempt({ attemptId: 'b-0', logicalCallId: 'call-2' }),
    ]);
    assert.equal(groups.length, 2);
    const retried = groups.find((g) => g.logicalCallId === 'call-1');
    assert.equal(retried?.attempts.length, 2);
    assert.equal(settledAttempt(retried!)?.attemptId, 'a-1');
  });

  test('coverage counts priced, unpriced, and usage bases separately', () => {
    const coverage = summarizeModelCallCoverage([
      attempt({ attemptId: 'a' }),
      attempt({ attemptId: 'b', costBasis: 'unpriced', costUsd: undefined }),
      attempt({
        attemptId: 'c',
        costBasis: 'unpriced',
        costUsd: undefined,
        usageBasis: 'missing',
        inputTokens: undefined,
        outputTokens: undefined,
      }),
      attempt({ attemptId: 'd', usageBasis: 'partial', outputTokens: undefined }),
    ]);
    assert.deepEqual(coverage, {
      attempts: 4,
      pricedAttempts: 2,
      unpricedAttempts: 2,
      usageReportedAttempts: 2,
      usagePartialAttempts: 1,
      usageMissingAttempts: 1,
    });
  });

  test('cost sum reports the qualifying coverage alongside the total', () => {
    const { costUsd, coverage } = sumModelCallCostUsd([
      attempt({ attemptId: 'a', costUsd: 0.004 }),
      attempt({ attemptId: 'b', costUsd: 0.006 }),
      attempt({ attemptId: 'c', costBasis: 'unpriced', costUsd: undefined }),
    ]);
    assert.equal(Math.round(costUsd * 1000) / 1000, 0.01);
    assert.equal(coverage.unpricedAttempts, 1);
  });

  test('a replayed attemptId is counted once through sum and coverage', () => {
    const stream = [
      attempt({ attemptId: 'a', logicalCallId: 'call-1', costUsd: 0.004 }),
      attempt({ attemptId: 'b', logicalCallId: 'call-2', costUsd: 0.006 }),
      attempt({ attemptId: 'a', logicalCallId: 'call-1', costUsd: 0.005 }),
    ];
    const { costUsd, coverage } = sumModelCallCostUsd(stream);
    assert.equal(Math.round(costUsd * 1000) / 1000, 0.011);
    assert.equal(coverage.attempts, 2);
    assert.equal(coverage.pricedAttempts, 2);
    assert.equal(summarizeModelCallCoverage(stream).attempts, 2);
    assert.equal(groupModelCallAttempts(stream).length, 2);
  });

  test('a genuinely free priced call is distinguishable from an unpriced one', () => {
    const free = attempt({ attemptId: 'free', costBasis: 'priced', costUsd: 0 });
    const unknown = attempt({ attemptId: 'unknown', costBasis: 'unpriced', costUsd: undefined });
    const { costUsd, coverage } = sumModelCallCostUsd([free, unknown]);
    assert.equal(costUsd, 0);
    assert.equal(coverage.pricedAttempts, 1);
    assert.equal(coverage.unpricedAttempts, 1);
  });
});
