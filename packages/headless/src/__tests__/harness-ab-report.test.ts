import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { summarizeAbComparison } from '../ab-summary.js';
import type { FixedPromptTaskInfraFailedEvent } from '../fixed-prompt-controller.js';
import {
  assertHarnessAbReportCompleted,
  buildHarnessAbReport,
  renderHarnessAbReportCsv,
  renderHarnessAbReportMarkdown,
} from '../harness-ab-report.js';
import type { HarnessAbRunManifest } from '../harness-ab-manifest.js';
import { budgetExhausted, completed, withUsage } from './helpers/ab-summary-fixtures.js';

describe('harness A/B report', () => {
  test('derives both arm placements from the run manifest', () => {
    const summary = summarizeAbComparison({
      runId: 'deep-swe-container-placement',
      roundId: 'ab-summary',
      baselineArmId: 'maka',
      candidateArmId: 'codex',
      evaluationTaskIds: ['a'],
      baselineRuns: [[usage('a', true, 100, 20, 25, 0)]],
      candidateRuns: [[usage('a', true, 120, 30, 30, 0)]],
    });
    const manifest = {
      arms: [
        {
          id: 'maka',
          kind: 'harness',
          fingerprint: 'maka-fingerprint',
          metadata: { config: { execution: { placement: 'task-container' } } },
        },
        {
          id: 'codex',
          kind: 'harness',
          fingerprint: 'codex-fingerprint',
          metadata: { config: { execution: { placement: 'task-container' } } },
        },
      ],
    } as Pick<HarnessAbRunManifest, 'arms'>;

    const report = buildHarnessAbReport(summary, undefined, 'metered', manifest);

    assert.deepEqual(report.execution, {
      arms: [
        { armId: 'maka', placement: 'task-container' },
        { armId: 'codex', placement: 'task-container' },
      ],
    });
    assert.match(
      renderHarnessAbReportMarkdown(report),
      /Execution placement: maka=task-container; codex=task-container\./,
    );
    const partialManifest = {
      arms: [manifest.arms[0], { ...manifest.arms[1], metadata: { config: {} } }],
    } as Pick<HarnessAbRunManifest, 'arms'>;
    assert.throws(
      () => buildHarnessAbReport(summary, undefined, 'metered', partialManifest),
      /execution placement must be declared for both arms/,
    );
  });

  test('keeps effectiveness and economy as separate reproducible axes', () => {
    const summary = summarizeAbComparison({
      runId: 'glm-harness-ab',
      roundId: 'ab-summary',
      baselineArmId: 'maka',
      candidateArmId: 'opencode',
      evaluationTaskIds: ['a', 'b'],
      baselineRuns: [
        [usage('a', true, 100, 40, 20, 0.00018), usage('b', true, 100, 40, 20, 0.00018)],
      ],
      candidateRuns: [
        [usage('a', true, 150, 20, 30, 0.00032), usage('b', false, 150, 20, 30, 0.00032)],
      ],
    });

    const report = buildHarnessAbReport(summary);

    assert.equal(report.schemaVersion, 'maka.harness_ab.report.v3');
    assert.deepEqual(report.effectiveness, {
      metric: 'pass@1',
      pairedEvaluated: 2,
      baseline: { armId: 'maka', passed: 2, evaluated: 2, passRate: 1 },
      candidate: { armId: 'opencode', passed: 1, evaluated: 2, passRate: 0.5 },
      candidateMinusBaseline: -0.5,
      candidateWins: 0,
      baselineWins: 1,
      ties: 1,
    });
    assert.equal(report.economy.baseline.totalTokens, 240);
    assert.equal(report.economy.candidate.totalTokens, 360);
    assert.equal(report.economy.baseline.costUsd, 0.00036);
    assert.equal(report.economy.candidate.costUsd, 0.00064);
    assert.equal(report.economy.baseline.costPerPassUsd, 0.00018);
    assert.equal(report.economy.candidate.costPerPassUsd, 0.00064);
    assert.equal('score' in report, false);

    const csv = renderHarnessAbReportCsv(report);
    assert.match(
      csv,
      /^run_status,stop_reason,billing_mode,economy_basis,scheduled_cells,attempted_cells,model_scored_cells,infra_failed_cells,unscored_cells,missing_final_usage_cells,paired_evaluated,paired_metered,missing_usage_pairs,axis,metric,baseline_arm,baseline_value,candidate_arm,candidate_value,candidate_minus_baseline\n/,
    );
    assert.match(
      csv,
      /completed,,metered,cache-aware-api-equivalent-usd,4,4,4,0,0,0,2,2,0,effectiveness,pass_rate,maka,1,opencode,0.5,-0.5/,
    );
    assert.match(
      csv,
      /completed,,metered,cache-aware-api-equivalent-usd,4,4,4,0,0,0,2,2,0,economy,total_tokens,maka,240,opencode,360,120/,
    );

    const markdown = renderHarnessAbReportMarkdown(report);
    assert.match(markdown, /# maka vs opencode — Harness Comparison/);
    assert.match(markdown, /Pass@1/);
    assert.match(markdown, /Recorded cost/);
    assert.match(
      markdown,
      /Cell coverage: 4\/4 attempted; 4 model-scored; 0 unscored \(including 0 infra-failed\); 0 missing final usage\./,
    );
    assert.match(markdown, /No composite score/);
  });

  test('labels account-plan cost without presenting it as public API pricing', () => {
    const summary = summarizeAbComparison({
      runId: 'k3-maka-vs-kimi-code',
      roundId: 'ab-summary',
      baselineArmId: 'maka',
      candidateArmId: 'kimi-code',
      evaluationTaskIds: ['a'],
      baselineRuns: [[usage('a', true, 100, 20, 25, 0)]],
      candidateRuns: [[usage('a', true, 120, 30, 30, 0)]],
    });

    const report = buildHarnessAbReport(summary, undefined, 'account-plan');
    const markdown = renderHarnessAbReportMarkdown(report);

    assert.equal(report.billingMode, 'account-plan');
    assert.equal(report.economy.basis, 'account-plan-recorded-usd');
    assert.match(markdown, /# maka vs kimi-code — Harness Comparison/);
    assert.match(markdown, /Recorded cost is zero under the frozen account-plan billing profile/);
    assert.doesNotMatch(markdown, /public price snapshot/);
  });

  test('completes with explicit cell coverage when every cell is attempted but one fails in infrastructure', () => {
    const summary = summarizeAbComparison({
      runId: 'glm-harness-ab',
      roundId: 'ab-summary',
      baselineArmId: 'maka',
      candidateArmId: 'opencode',
      evaluationTaskIds: ['a', 'b'],
      baselineRuns: [[completed('a', true), completed('b', true)]],
      candidateRuns: [[completed('a', false), infraFailure('b')]],
    });

    const report = buildHarnessAbReport(summary);

    assert.equal(report.schemaVersion, 'maka.harness_ab.report.v3');
    assert.equal(report.runStatus, 'completed_with_gaps');
    assert.deepEqual(report.coverage, {
      scheduledCells: 4,
      attemptedCells: 4,
      modelScoredCells: 3,
      infraFailedCells: 1,
      unscoredCells: 1,
      missingFinalUsageCells: 0,
    });
    assert.throws(() => assertHarnessAbReportCompleted(report), /completed with gaps/);
    assert.match(
      renderHarnessAbReportCsv(report),
      /completed_with_gaps,,metered,cache-aware-api-equivalent-usd,4,4,3,1,1,0,1,1,0,effectiveness,pass_rate/,
    );
    assert.match(renderHarnessAbReportMarkdown(report), /Status: completed_with_gaps\./);
    assert.deepEqual(report.effectiveness.baseline, {
      armId: 'maka',
      passed: 1,
      evaluated: 1,
      passRate: 1,
    });
    assert.deepEqual(report.effectiveness.candidate, {
      armId: 'opencode',
      passed: 0,
      evaluated: 1,
      passRate: 0,
    });
    assert.equal(report.effectiveness.candidateMinusBaseline, -1);
  });

  test('reports a budget-exhausted cell with final usage as unscored', () => {
    const meteredTimeout = {
      ...budgetExhausted('a'),
      tokenSummary: usage('a', false, 100, 40, 20, 0.00018).tokenSummary,
      tokenSummarySource: 'final' as const,
    };
    const summary = summarizeAbComparison({
      runId: 'glm-harness-ab',
      roundId: 'ab-summary',
      baselineArmId: 'maka',
      candidateArmId: 'opencode',
      evaluationTaskIds: ['a'],
      baselineRuns: [[meteredTimeout]],
      candidateRuns: [[usage('a', true, 100, 40, 20, 0.00018)]],
    });

    const report = buildHarnessAbReport(summary);

    assert.equal(report.runStatus, 'completed_with_gaps');
    assert.deepEqual(report.coverage, {
      scheduledCells: 2,
      attemptedCells: 2,
      modelScoredCells: 1,
      infraFailedCells: 0,
      unscoredCells: 1,
      missingFinalUsageCells: 0,
    });
  });

  test('stays incomplete when scheduled cells were never attempted', () => {
    const summary = summarizeAbComparison({
      runId: 'glm-harness-ab',
      roundId: 'ab-summary',
      baselineArmId: 'maka',
      candidateArmId: 'opencode',
      evaluationTaskIds: ['a', 'b'],
      baselineRuns: [[usage('a', true, 100, 40, 20, 0.1)]],
      candidateRuns: [[usage('a', false, 120, 50, 30, 0.2)]],
    });

    const report = buildHarnessAbReport(summary);

    assert.equal(report.runStatus, 'incomplete');
    assert.deepEqual(report.coverage, {
      scheduledCells: 4,
      attemptedCells: 2,
      modelScoredCells: 2,
      infraFailedCells: 0,
      unscoredCells: 0,
      missingFinalUsageCells: 0,
    });
    assert.throws(() => assertHarnessAbReportCompleted(report), /2\/4 scheduled cells attempted/);
  });

  test('reports economy over the same evaluated pairs as effectiveness', () => {
    const summary = summarizeAbComparison({
      runId: 'glm-harness-ab',
      roundId: 'ab-summary',
      baselineArmId: 'maka',
      candidateArmId: 'opencode',
      evaluationTaskIds: ['a', 'b'],
      baselineRuns: [[usage('a', true, 100, 0, 0, 0.1), usage('b', true, 900, 0, 0, 0.9)]],
      candidateRuns: [[usage('a', true, 100, 0, 0, 0.1), providerBilling('b')]],
    });

    const report = buildHarnessAbReport(summary);

    assert.equal(report.effectiveness.pairedEvaluated, 1);
    assert.equal(report.economy.baseline.totalTokens, 100);
    assert.equal(report.economy.candidate.totalTokens, 100);
    assert.equal(report.economy.baseline.tokensPerMetered, 100);
    assert.equal(report.economy.candidate.tokensPerMetered, 100);
  });

  test('excludes a pair from economy when either evaluated arm is missing usage', () => {
    const summary = summarizeAbComparison({
      runId: 'glm-harness-ab',
      roundId: 'ab-summary',
      baselineArmId: 'maka',
      candidateArmId: 'opencode',
      evaluationTaskIds: ['a', 'b'],
      baselineRuns: [[usage('a', true, 100, 40, 20, 0.1), budgetExhausted('b')]],
      candidateRuns: [[usage('a', true, 120, 50, 30, 0.2), usage('b', true, 900, 0, 100, 0.9)]],
    });

    const report = buildHarnessAbReport(summary);
    const economy = report.economy as typeof report.economy & {
      pairedMetered: number;
      missingUsagePairs: number;
    };

    assert.equal(report.effectiveness.pairedEvaluated, 2);
    assert.equal(report.runStatus, 'completed_with_gaps');
    assert.equal(report.coverage.missingFinalUsageCells, 1);
    assert.equal(economy.pairedMetered, 1);
    assert.equal(economy.missingUsagePairs, 1);
    assert.equal(report.economy.baseline.totalTokens, 120);
    assert.equal(report.economy.candidate.totalTokens, 150);
    assert.equal(report.economy.baseline.costPerPassUsd, 0.1);
    assert.equal(report.economy.candidate.costPerPassUsd, 0.2);
    assert.match(renderHarnessAbReportMarkdown(report), /fully metered pairs: 1; missing usage: 1/);
    assert.throws(() => assertHarnessAbReportCompleted(report), /completed with gaps/);
  });

  test('keeps timeout usage checkpoints out of final metering without making execution incomplete', () => {
    const checkpointOnlyTimeout = {
      ...budgetExhausted('a'),
      tokenSummary: usage('checkpoint', false, 100, 40, 20, 0.1).tokenSummary,
      tokenSummarySource: 'checkpoint' as const,
    };
    const summary = summarizeAbComparison({
      runId: 'glm-harness-ab',
      roundId: 'ab-summary',
      baselineArmId: 'maka',
      candidateArmId: 'opencode',
      evaluationTaskIds: ['a'],
      baselineRuns: [[checkpointOnlyTimeout]],
      candidateRuns: [[usage('a', true, 120, 50, 30, 0.2)]],
    });

    const report = buildHarnessAbReport(summary);

    assert.equal(summary.pairedAttempts.fullyMeteredPairs, 0);
    assert.deepEqual(summary.pairedAttempts.missingUsagePairIds, ['a#r0']);
    assert.equal(report.runStatus, 'completed_with_gaps');
    assert.equal(report.coverage.missingFinalUsageCells, 1);
  });

  test('preserves an early stop in every report format and rejects completion', () => {
    const summary = summarizeAbComparison({
      runId: 'glm-harness-ab',
      roundId: 'ab-summary',
      baselineArmId: 'maka',
      candidateArmId: 'opencode',
      evaluationTaskIds: ['a'],
      baselineRuns: [[completed('a', true)]],
      candidateRuns: [[providerBilling('a')]],
    });
    const report = buildHarnessAbReport({
      ...summary,
      stopReason: 'systemic_provider_failure',
    });

    assert.equal(report.runStatus, 'stopped');
    assert.equal(report.stopReason, 'systemic_provider_failure');
    assert.match(
      renderHarnessAbReportCsv(report),
      /^run_status,stop_reason,billing_mode,economy_basis,scheduled_cells,attempted_cells,model_scored_cells,infra_failed_cells,unscored_cells,missing_final_usage_cells,paired_evaluated,paired_metered,missing_usage_pairs,axis,metric,/,
    );
    assert.match(
      renderHarnessAbReportCsv(report),
      /stopped,systemic_provider_failure,metered,cache-aware-api-equivalent-usd,2,2,1,1,1,0,0,0,0,effectiveness,pass_rate/,
    );
    assert.match(
      renderHarnessAbReportMarkdown(report),
      /Status: stopped \(systemic_provider_failure\)\./,
    );
    assert.throws(
      () => assertHarnessAbReportCompleted(report),
      /harness A\/B stopped: systemic_provider_failure/,
    );
  });

  test('renders advisory Oracle states and warnings without changing statistical inclusion', () => {
    const summary = summarizeAbComparison({
      runId: 'glm-harness-ab',
      roundId: 'ab-summary',
      baselineArmId: 'maka',
      candidateArmId: 'opencode',
      evaluationTaskIds: ['a', 'b'],
      baselineRuns: [[completed('a', true), completed('b', false)]],
      candidateRuns: [[completed('a', false), completed('b', true)]],
    });
    const report = buildHarnessAbReport(summary, {
      snapshotFingerprint: `sha256:${'a'.repeat(64)}`,
      annotations: [
        { taskId: 'a', state: 'passed', qualificationKey: `sha256:${'b'.repeat(64)}` },
        { taskId: 'b', state: 'missing', qualificationKey: `sha256:${'c'.repeat(64)}` },
      ],
      warnings: ['Oracle evidence missing for task b'],
    });

    assert.equal(report.effectiveness.pairedEvaluated, 2);
    assert.deepEqual(report.oracleEvidence?.stateCounts, { passed: 1, missing: 1 });
    assert.deepEqual(
      report.oracleEvidence?.annotations.map(({ taskId, state }) => ({ taskId, state })),
      [
        { taskId: 'a', state: 'passed' },
        { taskId: 'b', state: 'missing' },
      ],
    );
    assert.match(renderHarnessAbReportMarkdown(report), /Oracle evidence: passed 1, missing 1\./);
    assert.match(
      renderHarnessAbReportMarkdown(report),
      /Warning: Oracle evidence missing for task b/,
    );
  });
});

function usage(
  taskId: string,
  passed: boolean,
  input: number,
  cacheHitInput: number,
  output: number,
  costUsd: number,
) {
  return withUsage(completed(taskId, passed), {
    input,
    cacheHitInput,
    cacheMissInput: input - cacheHitInput,
    cacheWriteInput: 0,
    output,
    reasoning: 0,
    total: input + output,
    costUsd,
    durationMs: 100,
  });
}

function providerBilling(taskId: string): FixedPromptTaskInfraFailedEvent {
  return {
    schemaVersion: 1,
    type: 'task_infra_failed',
    id: `event-${taskId}`,
    ts: 0,
    runId: 'glm-harness-ab',
    roundId: 'round',
    taskId,
    status: 'infra_failed',
    passed: false,
    scored: false,
    eligible: false,
    errorClass: 'provider_billing',
    error: 'provider billing failure',
  };
}

function infraFailure(taskId: string): FixedPromptTaskInfraFailedEvent {
  return {
    ...providerBilling(taskId),
    errorClass: 'network',
    error: 'provider network failure',
  };
}
