import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { ResultRecord } from '../contracts.js';
import { readResults, summarizeMatrix, writeResults } from '../results.js';

function record(
  taskId: string,
  configId: string,
  passed: boolean,
  extra: Partial<ResultRecord> = {},
): ResultRecord {
  return {
    taskId,
    configId,
    sessionId: `s-${taskId}-${configId}`,
    runId: `r-${taskId}-${configId}`,
    status: 'completed',
    passed,
    exitCode: passed ? 0 : 1,
    steps: 3,
    durationMs: 100,
    startedAt: 0,
    finishedAt: 100,
    ...extra,
  };
}

describe('results JSONL', () => {
  test('round-trips records through JSONL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-headless-res-'));
    try {
      const path = join(dir, 'nested', 'results.jsonl');
      const records = [record('t1', 'a', true), record('t1', 'b', false)];
      await writeResults(path, records);
      assert.deepEqual(await readResults(path), records);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('summarizeMatrix', () => {
  test('uses official denominator fields and excludes setup failures', () => {
    const summary = summarizeMatrix([
      record('pass', 'a', true, { scored: true, eligible: true }),
      record('fail', 'a', false, {
        scored: true,
        eligible: true,
        errorClass: 'verification_failed',
      }),
      record('runner-error', 'a', false, {
        status: 'failed',
        runnerCompleted: false,
        scored: false,
        eligible: true,
        error: 'backend exploded',
        errorClass: 'agent_failed',
      }),
      record('bad-setup', 'a', false, {
        status: 'failed',
        runnerCompleted: false,
        scored: false,
        eligible: false,
        excludedReason: 'invalid_setup',
        error: 'bad fixture',
        errorClass: 'invalid_setup',
      }),
    ]);

    assert.equal(summary.total, 4);
    assert.equal(summary.eligible, 3);
    assert.equal(summary.scored, 2);
    assert.equal(summary.pass, 1);
    assert.equal(summary.fail, 1);
    assert.equal(summary.error, 1);
    assert.equal(summary.excluded, 1);
    assert.equal(summary.officialPassRate, 0.5);
    assert.equal(summary.coverageRate, 2 / 3);
  });

  test('aggregates structured error classes and taxonomy counts', () => {
    const summary = summarizeMatrix([
      record('a', 'cfg', false, {
        scored: true,
        eligible: true,
        errorClass: 'verification_failed',
      }),
      record('b', 'cfg', false, {
        status: 'failed',
        scored: false,
        eligible: true,
        error: 'verification timed out',
        errorClass: 'verification_error',
        exitCode: null,
      }),
      record('c', 'cfg', false, {
        status: 'failed',
        scored: false,
        eligible: false,
        excludedReason: 'unsupported_adapter',
        error: 'adapter is not implemented',
        errorClass: 'unsupported_adapter',
        exitCode: null,
      }),
    ]);

    assert.deepEqual(summary.byErrorClass, {
      verification_failed: 1,
      verification_error: 1,
      unsupported_adapter: 1,
    });
    assert.equal(summary.byTaxonomy.verification_failed, 1);
    assert.equal(summary.byTaxonomy.verification_error, 1);
    assert.equal(summary.byTaxonomy.unsupported_adapter, 1);
    assert.equal(summary.error, 1);
  });
});
