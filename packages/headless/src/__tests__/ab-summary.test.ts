import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { summarizeAbComparison } from '../ab-summary.js';
import {
  budgetExhausted,
  completed,
  contextBudgetSummary,
  continuationSummary,
  taskToolSummary,
  withTrace,
  withUsage,
} from './helpers/ab-summary-fixtures.js';

describe('summarizeAbComparison', () => {
  test('summarizes fixed A/B as task-level deltas without RSI acceptance semantics', () => {
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'maka-baseline',
      candidateArmId: 'candidate',
      evaluationTaskIds: ['t1', 't2'],
      baselineRuns: [
        [completed('t1', false), completed('t2', false)],
        [completed('t1', false), completed('t2', true)],
      ],
      candidateRuns: [
        [completed('t1', true), completed('t2', true)],
        [completed('t1', true), completed('t2', true)],
      ],
      budgetMs: 600_000,
    });

    assert.equal(result.decision, 'not_cleared');
    assert.equal(result.reason, 'non_inferiority_confidence_interval_crosses_margin');
    assert.equal(result.taskCount, 2);
    assert.equal(result.reps, 2);
    assert.equal(result.baseline.passRate, 0.25);
    assert.equal(result.candidate.passRate, 1);
    assert.equal(result.taskLevel.wins, 2);
    assert.equal(result.taskLevel.losses, 0);
    assert.equal(result.taskLevel.ties, 0);
    assert.deepEqual(result.taskLevel.missingTaskIds, []);
    assert.equal(result.taskLevel.meanPassRateDelta, 0.75);
    assert.equal(result.baseline.budgetExhausted, 0);
    assert.equal(result.candidate.budgetExhausted, 0);
  });

  test('counts task budget exhaustion separately from infra while treating it as a budgeted non-pass', () => {
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'maka-baseline',
      candidateArmId: 'candidate',
      evaluationTaskIds: ['long-task'],
      baselineRuns: [[completed('long-task', true)]],
      candidateRuns: [
        [
          {
            ...budgetExhausted('long-task'),
            tokenSummary: {
              input: 100,
              cachedInput: 0,
              cacheHitInput: 0,
              cacheMissInput: 100,
              cacheWriteInput: 0,
              output: 20,
              reasoning: 0,
              total: 120,
              costUsd: 0.42,
              pricingSource: 'runtime',
            },
          },
        ],
      ],
      budgetMs: 600_000,
    });

    assert.equal(result.decision, 'diagnostic');
    assert.equal(result.reason, 'single_rep_diagnostic_only');
    assert.equal(result.candidate.passRate, 0);
    assert.equal(result.candidate.budgetExhausted, 1);
    assert.equal(result.candidate.infraFailed, 0);
    assert.equal(result.candidate.totalCostUsd, 0.42);
    assert.equal(result.candidate.tokenCostSummary.total, 120);
    assert.equal(result.taskLevel.losses, 1);
  });

  test('classifies a scored completed benchmark deadline as budget exhausted', () => {
    const deadlineFailure = {
      ...completed('long-task', false),
      status: 'failed' as const,
      errorClass: 'budget_exhausted',
      deadlineSettlement: { source: 'benchmark.deadline' as const, mode: 'immediate' as const },
    };
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'maka-baseline',
      candidateArmId: 'candidate',
      evaluationTaskIds: ['long-task'],
      baselineRuns: [[deadlineFailure]],
      candidateRuns: [[completed('long-task', true)]],
    });

    assert.equal(result.baseline.valid, 1);
    assert.equal(result.baseline.budgetExhausted, 1);
    assert.equal(result.baseline.passRate, 0);
  });

  test('uses one shared paired denominator for non-budget conditional outcomes', () => {
    const baselineBudget = {
      ...completed('baseline-budget', false),
      status: 'failed' as const,
      errorClass: 'budget_exhausted',
    };
    const candidateBudget = {
      ...completed('candidate-budget', false),
      status: 'failed' as const,
      errorClass: 'budget_exhausted',
    };
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'baseline',
      candidateArmId: 'candidate',
      evaluationTaskIds: ['quality', 'baseline-budget', 'candidate-budget'],
      baselineRuns: [
        [completed('quality', true), baselineBudget, completed('candidate-budget', false)],
      ],
      candidateRuns: [
        [completed('quality', false), completed('baseline-budget', true), candidateBudget],
      ],
    });
    const paired = result.pairedAttempts;

    assert.equal(paired.evaluatedPairs, 3);
    assert.equal(paired.nonBudgetEvaluatedPairs, 1);
    assert.equal(paired.baselineNonBudgetPassed, 1);
    assert.equal(paired.candidateNonBudgetPassed, 0);
    assert.deepEqual(paired.budgetExcludedPairIds, ['baseline-budget#r0', 'candidate-budget#r0']);
  });

  test('counts an unattested timeout as an observed budget failure with an attestation warning', () => {
    const unverifiedTimeout = {
      ...budgetExhausted('long-task'),
      eligible: false,
      evidenceErrorClass: 'missing_execution_identity' as const,
    };
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'maka-baseline',
      candidateArmId: 'candidate',
      evaluationTaskIds: ['long-task'],
      baselineRuns: [[unverifiedTimeout]],
      candidateRuns: [[unverifiedTimeout]],
      budgetMs: 600_000,
    });

    assert.equal(result.baseline.budgetExhausted, 1);
    assert.equal(result.baseline.plumbingFailed, 0);
    assert.equal(result.baseline.valid, 1);
    assert.equal(result.baseline.passRate, 0);
    assert.equal(result.baseline.coverageRate, 1);
    assert.equal(result.baseline.attestationWarnings, 1);
    assert.equal(result.candidate.valid, 1);
    assert.equal(result.candidate.coverageRate, 1);
    assert.equal(result.pairedAttempts.observedPairs, 1);
    assert.deepEqual(result.pairedAttempts.missingPairIds, []);
    assert.equal(result.decision, 'diagnostic');
    assert.equal(result.reason, 'single_rep_diagnostic_only');
  });

  test('excludes a provider timeout without reporting the observed pair as missing', () => {
    const providerTimeout = {
      ...budgetExhausted('task-a'),
      eligible: false,
      evidenceErrorClass: 'rate_limit' as const,
      evidenceError: 'provider rate limited the request',
    };
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'baseline',
      candidateArmId: 'candidate',
      evaluationTaskIds: ['task-a'],
      baselineRuns: [[providerTimeout]],
      candidateRuns: [[completed('task-a', true)]],
    });

    assert.equal(result.baseline.infraFailed, 1);
    assert.equal(result.baseline.plumbingFailed, 0);
    assert.equal(result.baseline.budgetExhausted, 0);
    assert.equal(result.baseline.missing, 0);
    assert.equal(result.pairedAttempts.observedPairs, 1);
    assert.equal(result.pairedAttempts.evaluatedPairs, 0);
    assert.deepEqual(result.pairedAttempts.missingPairIds, []);
    assert.deepEqual(result.pairedAttempts.excludedPairIds, ['task-a#r0']);
    assert.deepEqual(result.taskLevel.missingTaskIds, []);
    assert.deepEqual(result.taskLevel.excludedTaskIds, ['task-a']);
    assert.deepEqual(result.pairedAttempts.infraOrPlumbingDiscordantPairIds, ['task-a#r0']);
    assert.equal(result.decision, 'diagnostic');
    assert.equal(result.reason, 'single_rep_diagnostic_only');
  });

  test('allows an isolated provider exclusion at the effective coverage threshold', () => {
    const taskIds = Array.from({ length: 10 }, (_, index) => `task-${index}`);
    const providerTimeout = {
      ...budgetExhausted(taskIds[0]!),
      eligible: false,
      evidenceErrorClass: 'provider_unavailable' as const,
    };
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'baseline',
      candidateArmId: 'candidate',
      evaluationTaskIds: taskIds,
      baselineRuns: [
        [providerTimeout, ...taskIds.slice(1).map((taskId) => completed(taskId, true))],
      ],
      candidateRuns: [[...taskIds.map((taskId) => completed(taskId, true))]],
    });

    assert.equal(result.baseline.coverageRate, 0.9);
    assert.equal(result.decision, 'diagnostic');
    assert.equal(result.reason, 'single_rep_diagnostic_only');
  });

  test('uses evaluated pairs for both the formal point estimate and confidence bound', () => {
    const taskIds = Array.from({ length: 10 }, (_, index) => `task-${index}`);
    const baselineRuns = [0, 1].map((rep) =>
      taskIds.map((taskId, index) => completed(taskId, rep === 0 && index < 3)),
    );
    const candidateRuns = [0, 1].map((rep) =>
      taskIds.map((taskId, index) => {
        if (rep === 0 && index < 2) {
          return {
            ...completed(taskId, false),
            status: 'failed' as const,
            scored: false,
            eligible: false,
            errorClass: 'network',
          };
        }
        return completed(taskId, false);
      }),
    );
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'baseline',
      candidateArmId: 'candidate',
      evaluationTaskIds: taskIds,
      baselineRuns,
      candidateRuns,
    });

    assert.equal(result.candidate.coverageRate, 0.9);
    assert.equal(result.pairedAttempts.evaluatedPairs, 18);
    assert.equal(result.pairedAttempts.losses, 1);
    assert.equal(result.passRateDelta, -0.055555555556);
    assert.equal(result.decision, 'not_cleared');
    assert.equal(result.reason, 'non_inferiority_confidence_interval_crosses_margin');
  });

  test('classifies an unscored completed infra result as an infra exclusion', () => {
    const infraResult = {
      ...completed('task-a', false),
      scored: false,
      eligible: false,
      errorClass: 'infra_failed',
    };
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'baseline',
      candidateArmId: 'candidate',
      evaluationTaskIds: ['task-a'],
      baselineRuns: [[infraResult]],
      candidateRuns: [[completed('task-a', true)]],
    });

    assert.equal(result.baseline.completed, 0);
    assert.equal(result.baseline.infraFailed, 1);
    assert.equal(result.baseline.missing, 0);
    assert.deepEqual(result.pairedAttempts.excludedPairIds, ['task-a#r0']);
  });

  test('fails closed on an unscored completed provider error class', () => {
    const providerFailure = {
      ...completed('task-a', false),
      status: 'failed' as const,
      scored: false,
      eligible: false,
      errorClass: 'network',
    };
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'baseline',
      candidateArmId: 'candidate',
      evaluationTaskIds: ['task-a'],
      baselineRuns: [[providerFailure]],
      candidateRuns: [[completed('task-a', true)]],
    });

    assert.equal(result.baseline.valid, 0);
    assert.equal(result.baseline.infraFailed, 1);
    assert.deepEqual(result.pairedAttempts.excludedPairIds, ['task-a#r0']);
  });

  test('applies the effective coverage gate to evaluable pairs', () => {
    const taskIds = Array.from({ length: 10 }, (_, index) => `t${index}`);
    const excluded = (taskId: string) => ({
      ...completed(taskId, false),
      scored: false,
      eligible: false,
      errorClass: 'network' as const,
    });
    const baselineRun = taskIds.map((taskId, index) =>
      index === 0 ? excluded(taskId) : completed(taskId, true),
    );
    const candidateRun = taskIds.map((taskId, index) =>
      index === 1 ? excluded(taskId) : completed(taskId, true),
    );
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'baseline',
      candidateArmId: 'candidate',
      evaluationTaskIds: taskIds,
      baselineRuns: [baselineRun, baselineRun],
      candidateRuns: [candidateRun, candidateRun],
    });

    assert.equal(result.baseline.coverageRate, 0.9);
    assert.equal(result.candidate.coverageRate, 0.9);
    assert.equal(result.pairedAttempts.evaluatedPairs, 16);
    assert.equal(result.decision, 'not_cleared');
    assert.equal(result.reason, 'low_effective_coverage');
  });

  test('derives task-level outcomes from matching evaluable pairs', () => {
    const excluded = {
      ...completed('task', false),
      scored: false,
      eligible: false,
      errorClass: 'network' as const,
    };
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'baseline',
      candidateArmId: 'candidate',
      evaluationTaskIds: ['task'],
      baselineRuns: [[completed('task', false)], [excluded]],
      candidateRuns: [[completed('task', false)], [completed('task', true)]],
    });

    assert.equal(result.taskLevel.tasks[0]?.passRateDelta, 0);
    assert.equal(result.taskLevel.tasks[0]?.outcome, 'tie');
  });

  test('includes timeout task-tool evidence in the arm summary', () => {
    const timeout = {
      ...budgetExhausted('task'),
      taskToolSummary: taskToolSummary({ todoWriteCalls: 7 }),
    };
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'baseline',
      candidateArmId: 'candidate',
      evaluationTaskIds: ['task'],
      baselineRuns: [[completed('task', false)]],
      candidateRuns: [[timeout]],
    });

    assert.equal(result.candidate.taskTools?.activatedAttempts, 1);
    assert.equal(result.candidate.taskTools?.todoWriteCalls, 7);
  });

  test('invalidates an explicit execution identity mismatch without reporting missing data', () => {
    const identityMismatch = {
      ...budgetExhausted('task-a'),
      eligible: false,
      evidenceErrorClass: 'execution_identity_mismatch' as const,
    };
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'baseline',
      candidateArmId: 'candidate',
      evaluationTaskIds: ['task-a'],
      baselineRuns: [[identityMismatch]],
      candidateRuns: [[completed('task-a', true)]],
    });

    assert.equal(result.baseline.plumbingFailed, 1);
    assert.equal(result.baseline.attestationWarnings, 0);
    assert.equal(result.baseline.missing, 0);
    assert.deepEqual(result.pairedAttempts.missingPairIds, []);
    assert.deepEqual(result.pairedAttempts.excludedPairIds, ['task-a#r0']);
    assert.equal(result.decision, 'invalid');
    assert.equal(result.reason, 'plumbing_failure_observed');
  });

  test('fails closed on a legacy completed execution identity mismatch', () => {
    const identityMismatch = {
      ...completed('task-a', false),
      status: 'failed' as const,
      scored: false,
      eligible: false,
      errorClass: 'execution_identity_mismatch',
    };
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'baseline',
      candidateArmId: 'candidate',
      evaluationTaskIds: ['task-a'],
      baselineRuns: [[identityMismatch]],
      candidateRuns: [[completed('task-a', true)]],
    });

    assert.equal(result.baseline.valid, 0);
    assert.equal(result.baseline.plumbingFailed, 1);
    assert.equal(result.decision, 'invalid');
    assert.equal(result.reason, 'plumbing_failure_observed');
  });

  test('counts an observed verifier failure even when a legacy event marked it ineligible', () => {
    const ineligibleCompleted = { ...completed('task-a', false), eligible: false };
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'maka-baseline',
      candidateArmId: 'candidate',
      evaluationTaskIds: ['task-a'],
      baselineRuns: [[ineligibleCompleted]],
      candidateRuns: [[ineligibleCompleted]],
      budgetMs: 600_000,
    });

    assert.equal(result.baseline.valid, 1);
    assert.equal(result.baseline.passRate, 0);
    assert.equal(result.baseline.coverageRate, 1);
    assert.equal(result.candidate.valid, 1);
    assert.equal(result.candidate.coverageRate, 1);
    assert.equal(result.pairedAttempts.observedPairs, 1);
  });

  test('counts a legacy ineligible step-cap event as a failed A/B outcome', () => {
    const stepCapFailure = {
      ...completed('task-a', false),
      status: 'failed' as const,
      scored: false,
      eligible: false,
      errorClass: 'tool_step_cap_reached',
    };
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'maka-baseline',
      candidateArmId: 'candidate',
      evaluationTaskIds: ['task-a'],
      baselineRuns: [[stepCapFailure]],
      candidateRuns: [[stepCapFailure]],
      budgetMs: 600_000,
    });

    assert.equal(result.baseline.valid, 1);
    assert.equal(result.baseline.passRate, 0);
    assert.equal(result.baseline.completed, 0);
    assert.equal(result.baseline.budgetExhausted, 1);
    assert.equal(result.candidate.valid, 1);
    assert.equal(result.candidate.passRate, 0);
    assert.equal(result.taskLevel.tasks[0]?.baseline.completed, 0);
    assert.equal(result.taskLevel.tasks[0]?.baseline.budgetExhausted, 1);
    assert.equal(result.pairedAttempts.observedPairs, 1);
    assert.equal(result.pairedAttempts.ties, 1);
  });

  test('summarizes context budget activation in the A/B report', () => {
    const baselineInactive = contextBudgetSummary({ prunedToolResults: 0 });
    const candidateActive = contextBudgetSummary({
      prunedToolResults: 2,
      activePrunedToolResults: 3,
      activeEstimatedTokensSaved: 450,
      activeArchiveFailures: 1,
      archivePlaceholders: 2,
      archivePlaceholderReasonCounts: { active_prune: 2 },
      retrievedArchiveToolResults: 1,
      retrievedArchiveEstimatedTokens: 120,
      archiveRetrievalSkipped: 3,
      archiveRetrievalSkippedReasonCounts: { max_bytes: 2, max_results: 1 },
      archiveRetrievalFailures: 1,
      archiveRetrievalFailureReasonCounts: { not_found: 1 },
    });
    const candidateInactive = contextBudgetSummary({ prunedToolResults: 0 });
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'prune-off',
      candidateArmId: 'prune-on',
      evaluationTaskIds: ['t1', 't2'],
      baselineRuns: [
        [
          {
            ...completed('t1', true),
            contextBudgetPolicy: { enabled: false },
            contextBudgetSummary: baselineInactive,
          },
          {
            ...completed('t2', true),
            contextBudgetPolicy: { enabled: false },
            contextBudgetSummary: baselineInactive,
          },
        ],
      ],
      candidateRuns: [
        [
          {
            ...completed('t1', true),
            contextBudgetPolicy: {
              enabled: true,
              name: 'harbor-cell-context-budget',
              staleToolResultPrune: {
                enabled: true,
                maxResultEstimatedTokens: 2048,
                minRecentTurnsFull: 2,
              },
              minRecentTurns: 2,
            },
            contextBudgetSummary: candidateActive,
          },
          {
            ...completed('t2', true),
            contextBudgetPolicy: {
              enabled: true,
              name: 'harbor-cell-context-budget',
              staleToolResultPrune: {
                enabled: true,
                maxResultEstimatedTokens: 2048,
                minRecentTurnsFull: 2,
              },
              minRecentTurns: 2,
            },
            contextBudgetSummary: candidateInactive,
          },
        ],
      ],
    });

    assert.equal(result.baseline.contextBudgetPolicy?.enabledAttempts, 0);
    assert.equal(result.candidate.contextBudgetPolicy?.enabledAttempts, 2);
    assert.deepEqual(result.candidate.contextBudget, {
      diagnosticAttempts: 2,
      activatedAttempts: 1,
      activatedAttemptIds: ['event-t1-pass'],
      diagnosticEvents: 2,
      prunedToolResults: 2,
      activePrunedToolResults: 3,
      activeEstimatedTokensSaved: 450,
      activeArchiveFailures: 1,
      archivePlaceholders: 2,
      archivePlaceholderReasonCounts: { active_prune: 2 },
      archiveWriteFailures: 0,
      retrievedArchiveToolResults: 1,
      retrievedArchiveEstimatedTokens: 120,
      archiveRetrievalSkipped: 3,
      archiveRetrievalSkippedReasonCounts: { max_bytes: 2, max_results: 1 },
      archiveRetrievalFailures: 1,
      archiveRetrievalFailureReasonCounts: { not_found: 1 },
    });
    assert.deepEqual(result.candidate.activePruneSubset, {
      taskCount: 1,
      attempts: 1,
      observed: 1,
      valid: 1,
      passed: 1,
      passRate: 1,
      completed: 1,
      budgetExhausted: 0,
      infraFailed: 0,
      plumbingFailed: 0,
      attestationWarnings: 0,
      missing: 0,
      coverageRate: 1,
      totalCostUsd: 0.01,
      meanDurationMs: 100,
      tokenCostSummary: {
        input: 1,
        cachedInput: 0,
        cacheHitInput: 0,
        cacheMissInput: 1,
        cacheWriteInput: 0,
        output: 1,
        reasoning: 0,
        total: 2,
        costUsd: 0.01,
        meanDurationMs: 100,
      },
      contextBudget: {
        diagnosticAttempts: 1,
        activatedAttempts: 1,
        activatedAttemptIds: ['event-t1-pass'],
        diagnosticEvents: 1,
        prunedToolResults: 2,
        activePrunedToolResults: 3,
        activeEstimatedTokensSaved: 450,
        activeArchiveFailures: 1,
        archivePlaceholders: 2,
        archivePlaceholderReasonCounts: { active_prune: 2 },
        archiveWriteFailures: 0,
        retrievedArchiveToolResults: 1,
        retrievedArchiveEstimatedTokens: 120,
        archiveRetrievalSkipped: 3,
        archiveRetrievalSkippedReasonCounts: { max_bytes: 2, max_results: 1 },
        archiveRetrievalFailures: 1,
        archiveRetrievalFailureReasonCounts: { not_found: 1 },
      },
    });
    assert.deepEqual(result.baseline.activePruneSubset, {
      taskCount: 1,
      attempts: 1,
      observed: 1,
      valid: 1,
      passed: 1,
      passRate: 1,
      completed: 1,
      budgetExhausted: 0,
      infraFailed: 0,
      plumbingFailed: 0,
      attestationWarnings: 0,
      missing: 0,
      coverageRate: 1,
      totalCostUsd: 0.01,
      meanDurationMs: 100,
      tokenCostSummary: {
        input: 1,
        cachedInput: 0,
        cacheHitInput: 0,
        cacheMissInput: 1,
        cacheWriteInput: 0,
        output: 1,
        reasoning: 0,
        total: 2,
        costUsd: 0.01,
        meanDurationMs: 100,
      },
      contextBudget: {
        diagnosticAttempts: 1,
        activatedAttempts: 0,
        activatedAttemptIds: [],
        diagnosticEvents: 1,
        prunedToolResults: 0,
        activePrunedToolResults: 0,
        activeEstimatedTokensSaved: 0,
        activeArchiveFailures: 0,
        archivePlaceholders: 0,
        archivePlaceholderReasonCounts: {},
        archiveWriteFailures: 0,
        retrievedArchiveToolResults: 0,
        retrievedArchiveEstimatedTokens: 0,
        archiveRetrievalSkipped: 0,
        archiveRetrievalSkippedReasonCounts: {},
        archiveRetrievalFailures: 0,
        archiveRetrievalFailureReasonCounts: {},
      },
    });
  });

  test('renders active prune subset pair coverage and full token cost', () => {
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'prune-off',
      candidateArmId: 'prune-on',
      evaluationTaskIds: ['t1'],
      baselineRuns: [[]],
      candidateRuns: [
        [
          {
            ...withUsage(completed('t1', true), {
              input: 10,
              cacheHitInput: 3,
              cacheMissInput: 4,
              cacheWriteInput: 2,
              output: 5,
              reasoning: 1,
              total: 16,
              costUsd: 0.02,
              durationMs: 250,
            }),
            contextBudgetSummary: contextBudgetSummary({ activePrunedToolResults: 1 }),
          },
        ],
      ],
    });
  });

  test('classifies step-cap consistently inside the active-prune subset', () => {
    const stepCapFailure = {
      ...completed('t1', false),
      status: 'failed' as const,
      scored: false,
      eligible: true,
      errorClass: 'tool_step_cap_reached',
    };
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'baseline',
      candidateArmId: 'candidate',
      evaluationTaskIds: ['t1'],
      baselineRuns: [[stepCapFailure]],
      candidateRuns: [
        [
          {
            ...stepCapFailure,
            contextBudgetSummary: contextBudgetSummary({ activePrunedToolResults: 1 }),
          },
        ],
      ],
    });

    assert.equal(result.candidate.activePruneSubset?.completed, 0);
    assert.equal(result.candidate.activePruneSubset?.budgetExhausted, 1);
    assert.equal(result.candidate.activePruneSubset?.meanDurationMs, null);
  });

  test('summarizes A/B token cost usage for prune benefit review', () => {
    const taskIds = Array.from({ length: 1000 }, (_, index) => `t${index}`);
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'prune-off',
      candidateArmId: 'prune-on',
      evaluationTaskIds: taskIds,
      baselineRuns: [
        taskIds.map((taskId) =>
          withUsage(completed(taskId, true), {
            input: 100,
            cacheHitInput: 20,
            cacheMissInput: 70,
            cacheWriteInput: 10,
            output: 30,
            reasoning: 5,
            total: 135,
            costUsd: 3,
            durationMs: 1000,
          }),
        ),
      ],
      candidateRuns: [
        taskIds.map((taskId) =>
          withUsage(completed(taskId, true), {
            input: 60,
            cacheHitInput: 15,
            cacheMissInput: 40,
            cacheWriteInput: 5,
            output: 25,
            reasoning: 5,
            total: 90,
            costUsd: 2,
            durationMs: 800,
          }),
        ),
      ],
    });

    assert.equal(result.decision, 'diagnostic');
    assert.deepEqual(result.baseline.tokenCostSummary, {
      input: 100_000,
      cachedInput: 20_000,
      cacheHitInput: 20_000,
      cacheMissInput: 70_000,
      cacheWriteInput: 10_000,
      output: 30_000,
      reasoning: 5000,
      total: 135_000,
      costUsd: 3000,
      meanDurationMs: 1000,
    });
    assert.deepEqual(result.candidate.tokenCostSummary, {
      input: 60_000,
      cachedInput: 15_000,
      cacheHitInput: 15_000,
      cacheMissInput: 40_000,
      cacheWriteInput: 5000,
      output: 25_000,
      reasoning: 5000,
      total: 90_000,
      costUsd: 2000,
      meanDurationMs: 800,
    });
  });

  test('summarizes continuation cap diagnostics for A/B validity review', () => {
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'prune-off',
      candidateArmId: 'prune-on',
      evaluationTaskIds: ['t1', 't2'],
      budgetMs: 600_000,
      baselineRuns: [
        [
          {
            ...completed('t1', true),
            continuationSummary: continuationSummary({
              turnsUsed: 2,
              continuedTurns: 1,
              stepCapHits: 1,
              totalRuntimeSteps: 42,
              turns: [
                { turnIndex: 0, status: 'failed', stepCapHit: true, runtimeSteps: 42 },
                { turnIndex: 1, status: 'completed', stepCapHit: false, runtimeSteps: 0 },
              ],
            }),
          },
          {
            ...completed('t2', false),
            continuationSummary: continuationSummary({
              capExhausted: true,
              turnsUsed: 3,
              continuedTurns: 2,
              stepCapHits: 3,
              totalRuntimeSteps: 60,
              turns: [
                { turnIndex: 0, status: 'failed', stepCapHit: true, runtimeSteps: 20 },
                { turnIndex: 1, status: 'failed', stepCapHit: true, runtimeSteps: 20 },
                { turnIndex: 2, status: 'failed', stepCapHit: true, runtimeSteps: 20 },
              ],
            }),
          },
        ],
      ],
      candidateRuns: [
        [
          {
            ...completed('t1', true),
            continuationSummary: continuationSummary({ turnsUsed: 1, totalRuntimeSteps: 20 }),
          },
          {
            ...completed('t2', true),
            continuationSummary: continuationSummary({
              turnsUsed: 2,
              continuedTurns: 1,
              stepCapHits: 1,
              totalRuntimeSteps: 44,
              turns: [
                { turnIndex: 0, status: 'failed', stepCapHit: true, runtimeSteps: 44 },
                { turnIndex: 1, status: 'completed', stepCapHit: false, runtimeSteps: 0 },
              ],
            }),
          },
        ],
      ],
    });

    assert.deepEqual(result.baseline.continuation, {
      attempts: 2,
      enabledAttempts: 2,
      wallTimeoutMs: 600_000,
      turnsUsed: 5,
      continuedTurns: 3,
      stepCapHits: 4,
      capExhaustedAttempts: 1,
      totalRuntimeSteps: 102,
      perTurnStepCapHits: [true, false, true, true, true],
      maxTurns: 3,
      maxTotalRuntimeSteps: 150,
    });
    assert.deepEqual(result.candidate.continuation, {
      attempts: 2,
      enabledAttempts: 2,
      wallTimeoutMs: 600_000,
      turnsUsed: 3,
      continuedTurns: 1,
      stepCapHits: 1,
      capExhaustedAttempts: 0,
      totalRuntimeSteps: 64,
      perTurnStepCapHits: [false, true, false],
      maxTurns: 3,
      maxTotalRuntimeSteps: 150,
    });
  });

  test('summarizes task experiment tool usage for A/B baseline review', () => {
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'task-tools-off',
      candidateArmId: 'task-tools-on',
      evaluationTaskIds: ['t1', 't2'],
      baselineRuns: [[completed('t1', true), completed('t2', true)]],
      candidateRuns: [
        [
          {
            ...completed('t1', true),
            taskToolSummary: taskToolSummary({
              todoWriteCalls: 5,
            }),
          },
          {
            ...completed('t2', true),
            taskToolSummary: taskToolSummary({
              todoWriteCalls: 3,
            }),
          },
        ],
      ],
    });

    assert.equal(result.baseline.taskTools, undefined);
    assert.deepEqual(result.candidate.taskTools, {
      attempts: 2,
      activatedAttempts: 2,
      activatedAttemptIds: ['event-t1-pass', 'event-t2-pass'],
      todoWriteCalls: 8,
    });
  });

  test('uses observed cell attempts as the task tool activation denominator', () => {
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'task-tools-off',
      candidateArmId: 'task-tools-on',
      evaluationTaskIds: ['t1', 't2'],
      baselineRuns: [[completed('t1', true), completed('t2', true)]],
      candidateRuns: [
        [
          {
            ...completed('t1', true),
            taskToolSummary: taskToolSummary({
              todoWriteCalls: 1,
            }),
          },
          completed('t2', true),
        ],
      ],
    });

    assert.deepEqual(result.candidate.taskTools, {
      attempts: 2,
      activatedAttempts: 1,
      activatedAttemptIds: ['event-t1-pass'],
      todoWriteCalls: 1,
    });
  });

  test('counts budget-exhausted attempts in the task tool activation denominator', () => {
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'task-tools-off',
      candidateArmId: 'task-tools-on',
      evaluationTaskIds: ['t1', 't2'],
      baselineRuns: [[completed('t1', true), completed('t2', true)]],
      candidateRuns: [
        [
          {
            ...completed('t1', true),
            taskToolSummary: taskToolSummary({
              todoWriteCalls: 1,
            }),
          },
          budgetExhausted('t2'),
        ],
      ],
    });

    assert.deepEqual(result.candidate.taskTools, {
      attempts: 2,
      activatedAttempts: 1,
      activatedAttemptIds: ['event-t1-pass'],
      todoWriteCalls: 1,
    });
  });

  test('summarizes enabled task tools with zero activation', () => {
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'task-tools-off',
      candidateArmId: 'task-tools-on',
      evaluationTaskIds: ['t1', 't2'],
      baselineRuns: [[completed('t1', true), completed('t2', true)]],
      candidateRuns: [
        [
          {
            ...completed('t1', true),
            taskToolSummary: taskToolSummary({ todoWriteCalls: 0 }),
          },
          {
            ...completed('t2', true),
            taskToolSummary: taskToolSummary({ todoWriteCalls: 0 }),
          },
        ],
      ],
    });

    assert.deepEqual(result.candidate.taskTools, {
      attempts: 2,
      activatedAttempts: 0,
      activatedAttemptIds: [],
      todoWriteCalls: 0,
    });
  });

  test('records activated attempts and investigation refs for follow-up', () => {
    const activatedSummary = contextBudgetSummary({
      activePrunedToolResults: 1,
      activeEstimatedTokensSaved: 50,
    });
    const staleOnlySummary = contextBudgetSummary({ prunedToolResults: 1, archivePlaceholders: 1 });
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'prune-off',
      candidateArmId: 'active-prune-on',
      evaluationTaskIds: ['b-loss', 'activated', 'stale-only', 'budget'],
      baselineRuns: [
        [
          withTrace(completed('b-loss', true), 'A', 'b-loss'),
          withTrace(completed('activated', true), 'A', 'activated'),
          withTrace(completed('stale-only', true), 'A', 'stale-only'),
          withTrace(completed('budget', true), 'A', 'budget'),
        ],
      ],
      candidateRuns: [
        [
          withTrace(completed('b-loss', false), 'B', 'b-loss'),
          {
            ...withTrace(completed('activated', true), 'B', 'activated'),
            id: 'event-B-activated-r0',
            contextBudgetSummary: activatedSummary,
          },
          {
            ...withTrace(completed('stale-only', true), 'B', 'stale-only'),
            id: 'event-B-stale-only-r0',
            contextBudgetSummary: staleOnlySummary,
          },
          {
            ...budgetExhausted('budget'),
            id: 'event-B-budget-r0',
            roundId: 'ab-prune-on-r0-budget',
          },
        ],
      ],
    });

    assert.deepEqual(result.candidate.contextBudget?.activatedAttemptIds, ['event-B-activated-r0']);
    assert.deepEqual(result.candidate.activePruneSubset?.contextBudget?.activatedAttemptIds, [
      'event-B-activated-r0',
    ]);
    assert.equal(result.investigationRefs.activatedAttempts[0]?.taskId, 'activated');
    assert.equal(
      result.investigationRefs.activatedAttempts.some((ref) => ref.taskId === 'stale-only'),
      false,
    );
    assert.equal(result.investigationRefs.activatedAttempts[0]?.rep, 0);
    assert.equal(
      result.investigationRefs.activatedAttempts[0]?.runtimeEventsPath,
      '/logs/B/activated/runtime-events.jsonl',
    );
    assert.equal(
      result.investigationRefs.activatedAttempts[0]?.traceEventsPath,
      '/traces/B/activated/events.jsonl',
    );
    assert.equal(result.investigationRefs.candidateLosses[0]?.pairId, 'b-loss#r0');
    assert.equal(
      result.investigationRefs.candidateLosses[0]?.candidate?.runtimeEventsPath,
      '/logs/B/b-loss/runtime-events.jsonl',
    );
    assert.equal(result.investigationRefs.budgetDiscordantPairs[0]?.pairId, 'budget#r0');
    assert.equal(
      result.investigationRefs.budgetDiscordantPairs[0]?.candidate?.runtimeEventsUnavailableReason,
      'budget_exhausted_before_cell_output',
    );
  });

  test('keeps sign test auxiliary while using non-inferiority as the decision', () => {
    const taskIds = Array.from({ length: 16 }, (_, index) => `t${index}`);
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'maka-baseline',
      candidateArmId: 'candidate',
      evaluationTaskIds: taskIds,
      baselineRuns: repeatedRuns(taskIds.map((taskId, index) => completed(taskId, index >= 9))),
      candidateRuns: repeatedRuns(taskIds.map((taskId, index) => completed(taskId, index < 9))),
    });

    assert.equal(result.taskLevel.wins, 9);
    assert.equal(result.taskLevel.losses, 7);
    assert.equal(
      result.taskLevel.signTestPValue !== null && result.taskLevel.signTestPValue > 0.05,
      true,
    );
    assert.equal(result.decision, 'not_cleared');
    assert.equal(result.reason, 'non_inferiority_confidence_interval_crosses_margin');
    assert.equal(
      result.nonInferiority.lowerBound !== null && result.nonInferiority.lowerBound < -0.1,
      true,
    );
  });

  test('keeps an exact task-level sign test as an auxiliary metric', () => {
    const taskIds = Array.from({ length: 16 }, (_, index) => `t${index}`);
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'maka-baseline',
      candidateArmId: 'candidate',
      evaluationTaskIds: taskIds,
      baselineRuns: repeatedRuns(taskIds.map((taskId, index) => completed(taskId, index >= 13))),
      candidateRuns: repeatedRuns(taskIds.map((taskId, index) => completed(taskId, index < 13))),
    });

    assert.equal(result.taskLevel.wins, 13);
    assert.equal(result.taskLevel.losses, 3);
    assert.equal(
      result.taskLevel.signTestPValue !== null && result.taskLevel.signTestPValue <= 0.05,
      true,
    );
    assert.equal(result.decision, 'non_inferior');
    assert.equal(result.reason, 'non_inferiority_lower_bound_within_margin');
  });

  test('keeps every single-rep comparison diagnostic even when the sample is large', () => {
    const taskIds = Array.from({ length: 1000 }, (_, index) => `diagnostic-${index}`);
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'off',
      candidateArmId: 'on',
      evaluationTaskIds: taskIds,
      baselineRuns: [taskIds.map((taskId) => completed(taskId, true))],
      candidateRuns: [taskIds.map((taskId) => completed(taskId, true))],
    });

    assert.equal(result.decision, 'diagnostic');
    assert.equal(result.reason, 'single_rep_diagnostic_only');
  });

  test('requires a 10pp non-inferiority confidence bound for prune comparisons', () => {
    const underpoweredNinePointLoss = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'prune-off',
      candidateArmId: 'prune-on',
      evaluationTaskIds: Array.from({ length: 100 }, (_, index) => `t${index}`),
      baselineRuns: repeatedRuns(
        Array.from({ length: 100 }, (_, index) => completed(`t${index}`, index < 100)),
      ),
      candidateRuns: repeatedRuns(
        Array.from({ length: 100 }, (_, index) => completed(`t${index}`, index < 91)),
      ),
    });
    assert.equal(underpoweredNinePointLoss.nonInferiorityMargin, 0.1);
    assert.equal(underpoweredNinePointLoss.passRateDelta, -0.09);
    assert.equal(underpoweredNinePointLoss.decision, 'not_cleared');
    assert.equal(
      underpoweredNinePointLoss.reason,
      'non_inferiority_confidence_interval_crosses_margin',
    );
    assert.equal(
      underpoweredNinePointLoss.nonInferiority.lowerBound !== null &&
        underpoweredNinePointLoss.nonInferiority.lowerBound < -0.1,
      true,
    );
    const poweredFivePointLoss = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'prune-off',
      candidateArmId: 'prune-on',
      evaluationTaskIds: Array.from({ length: 1000 }, (_, index) => `t${index}`),
      baselineRuns: repeatedRuns(
        Array.from({ length: 1000 }, (_, index) => completed(`t${index}`, index < 1000)),
      ),
      candidateRuns: repeatedRuns(
        Array.from({ length: 1000 }, (_, index) => completed(`t${index}`, index < 950)),
      ),
    });
    assert.equal(poweredFivePointLoss.passRateDelta, -0.05);
    assert.equal(
      poweredFivePointLoss.nonInferiority.lowerBound !== null &&
        poweredFivePointLoss.nonInferiority.lowerBound >= -0.1,
      true,
    );
    assert.equal(poweredFivePointLoss.decision, 'non_inferior');
    assert.equal(poweredFivePointLoss.reason, 'non_inferiority_lower_bound_within_margin');

    const elevenPointLoss = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'prune-off',
      candidateArmId: 'prune-on',
      evaluationTaskIds: Array.from({ length: 100 }, (_, index) => `t${index}`),
      baselineRuns: repeatedRuns(
        Array.from({ length: 100 }, (_, index) => completed(`t${index}`, index < 100)),
      ),
      candidateRuns: repeatedRuns(
        Array.from({ length: 100 }, (_, index) => completed(`t${index}`, index < 89)),
      ),
    });
    assert.equal(elevenPointLoss.passRateDelta, -0.11);
    assert.equal(elevenPointLoss.decision, 'inferior');
    assert.equal(elevenPointLoss.reason, 'pass_rate_delta_below_non_inferiority_margin');
  });

  test('uses a 95% simultaneous paired Wilson lower bound for non-inferiority boundary cases', () => {
    const onePairTie = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'prune-off',
      candidateArmId: 'prune-on',
      evaluationTaskIds: ['single'],
      baselineRuns: repeatedRuns([completed('single', true)]),
      candidateRuns: repeatedRuns([completed('single', true)]),
    });
    assert.equal(onePairTie.passRateDelta, 0);
    assert.equal(onePairTie.nonInferiority.method, 'paired_bonferroni_wilson');
    assert.equal(onePairTie.nonInferiority.lowerBound, -0.657619772493);
    assert.equal(
      onePairTie.nonInferiority.lowerBound !== null && onePairTie.nonInferiority.lowerBound < -0.1,
      true,
    );
    assert.equal(onePairTie.decision, 'not_cleared');
    assert.equal(onePairTie.reason, 'non_inferiority_confidence_interval_crosses_margin');

    const tieTaskIds = Array.from({ length: 10 }, (_, index) => `tie-${index}`);
    const allTieSmallSample = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'prune-off',
      candidateArmId: 'prune-on',
      evaluationTaskIds: tieTaskIds,
      baselineRuns: repeatedRuns(tieTaskIds.map((taskId) => completed(taskId, true))),
      candidateRuns: repeatedRuns(tieTaskIds.map((taskId) => completed(taskId, true))),
    });
    assert.equal(allTieSmallSample.passRateDelta, 0);
    assert.equal(allTieSmallSample.nonInferiority.method, 'paired_bonferroni_wilson');
    assert.equal(
      allTieSmallSample.nonInferiority.lowerBound !== null &&
        allTieSmallSample.nonInferiority.lowerBound < -0.1,
      true,
    );
    assert.equal(allTieSmallSample.decision, 'not_cleared');

    const poweredTaskIds = Array.from({ length: 1000 }, (_, index) => `powered-${index}`);
    const powered = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'prune-off',
      candidateArmId: 'prune-on',
      evaluationTaskIds: poweredTaskIds,
      baselineRuns: repeatedRuns(poweredTaskIds.map((taskId) => completed(taskId, true))),
      candidateRuns: repeatedRuns(
        poweredTaskIds.map((taskId, index) => completed(taskId, index < 950)),
      ),
    });

    assert.equal(powered.passRateDelta, -0.05);
    assert.equal(powered.pairedAttempts.losses, 100);
    assert.equal(powered.pairedAttempts.ties, 1900);
    assert.equal(powered.nonInferiority.method, 'paired_bonferroni_wilson');
    assert.equal(
      powered.nonInferiority.lowerBound !== null && powered.nonInferiority.lowerBound >= -0.1,
      true,
    );
    assert.equal(powered.decision, 'non_inferior');
    assert.equal(powered.reason, 'non_inferiority_lower_bound_within_margin');

    const smallTaskIds = Array.from({ length: 20 }, (_, index) => `small-${index}`);
    const underpowered = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'prune-off',
      candidateArmId: 'prune-on',
      evaluationTaskIds: smallTaskIds,
      baselineRuns: repeatedRuns(
        smallTaskIds.map((taskId, index) => completed(taskId, index >= 9)),
      ),
      candidateRuns: repeatedRuns(
        smallTaskIds.map((taskId, index) => completed(taskId, index >= 9 && index < 19)),
      ),
    });
    assert.equal(underpowered.passRateDelta, -0.05);
    assert.equal(underpowered.nonInferiority.method, 'paired_bonferroni_wilson');
    assert.equal(
      underpowered.nonInferiority.lowerBound !== null &&
        underpowered.nonInferiority.lowerBound < -0.1,
      true,
    );
    assert.equal(underpowered.decision, 'not_cleared');
    assert.equal(underpowered.reason, 'non_inferiority_confidence_interval_crosses_margin');

    const inferiorTaskIds = Array.from({ length: 100 }, (_, index) => `inferior-${index}`);
    const inferior = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'prune-off',
      candidateArmId: 'prune-on',
      evaluationTaskIds: inferiorTaskIds,
      baselineRuns: repeatedRuns(
        inferiorTaskIds.map((taskId, index) => completed(taskId, index >= 44)),
      ),
      candidateRuns: repeatedRuns(
        inferiorTaskIds.map((taskId, index) => completed(taskId, index >= 44 && index < 89)),
      ),
    });
    assert.equal(inferior.passRateDelta, -0.11);
    assert.equal(inferior.nonInferiority.method, 'paired_bonferroni_wilson');
    assert.equal(inferior.decision, 'inferior');
    assert.equal(inferior.reason, 'pass_rate_delta_below_non_inferiority_margin');
  });

  test('counts baseline timeout and candidate pass as an effective B advantage', () => {
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'maka-baseline',
      candidateArmId: 'candidate',
      evaluationTaskIds: ['t1'],
      baselineRuns: [[budgetExhausted('t1')]],
      candidateRuns: [[completed('t1', true)]],
    });

    assert.equal(result.baseline.budgetExhausted, 1);
    assert.equal(result.candidate.passed, 1);
    assert.equal(result.pairedAttempts.wins, 1);
    assert.deepEqual(result.pairedAttempts.budgetDiscordantPairIds, ['t1#r0']);
    assert.equal(result.decision, 'diagnostic');
    assert.equal(result.reason, 'single_rep_diagnostic_only');
  });

  test('counts baseline pass and candidate timeout as an effective B loss', () => {
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'maka-baseline',
      candidateArmId: 'candidate',
      evaluationTaskIds: ['t1'],
      baselineRuns: [[completed('t1', true)]],
      candidateRuns: [[budgetExhausted('t1')]],
    });

    assert.equal(result.baseline.passed, 1);
    assert.equal(result.candidate.budgetExhausted, 1);
    assert.equal(result.pairedAttempts.losses, 1);
    assert.deepEqual(result.pairedAttempts.budgetDiscordantPairIds, ['t1#r0']);
    assert.equal(result.decision, 'diagnostic');
    assert.equal(result.reason, 'single_rep_diagnostic_only');
  });

  test('reports an asymmetric step-cap failure as budget discordance', () => {
    const stepCapFailure = {
      ...completed('t1', false),
      status: 'failed' as const,
      scored: false,
      eligible: true,
      errorClass: 'tool_step_cap_reached',
    };
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'baseline',
      candidateArmId: 'candidate',
      evaluationTaskIds: ['t1'],
      baselineRuns: [[stepCapFailure]],
      candidateRuns: [[completed('t1', true)]],
    });

    assert.equal(result.pairedAttempts.wins, 1);
    assert.deepEqual(result.pairedAttempts.budgetDiscordantPairIds, ['t1#r0']);
    assert.equal(result.decision, 'diagnostic');
    assert.equal(result.reason, 'single_rep_diagnostic_only');
  });

  test('reports budget-discordant refs without invalidating the comparison', () => {
    const taskIds = Array.from({ length: 100 }, (_, index) => `t${index}`);
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'prune-off',
      candidateArmId: 'prune-on',
      evaluationTaskIds: taskIds,
      baselineRuns: [
        [budgetExhausted('t0'), ...taskIds.slice(1).map((taskId) => completed(taskId, true))],
      ],
      candidateRuns: [taskIds.map((taskId) => completed(taskId, true))],
    });

    assert.deepEqual(result.pairedAttempts.budgetDiscordantPairIds, ['t0#r0']);
    assert.equal(result.investigationRefs.budgetDiscordantPairs[0]?.pairId, 't0#r0');
    assert.equal(result.decision, 'diagnostic');
    assert.equal(result.reason, 'single_rep_diagnostic_only');
  });
});

function repeatedRuns<T>(events: readonly T[]): readonly (readonly T[])[] {
  return [events, events];
}
