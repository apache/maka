import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  appendPromptAcceptanceDecision,
  calibratePromptAcceptanceBaseline,
  decidePromptAcceptance,
  promptAcceptanceNoiseBand,
  promptAcceptanceStateFromWal,
  selectAddressablePromptTasks,
  selectStablePromptTasks,
  summarizePromptAcceptancePartition,
} from '../prompt-acceptance-policy.js';
import type {
  FixedPromptTaskCompletedEvent,
  FixedPromptTaskWalEvent,
} from '../fixed-prompt-controller.js';
import { readFixedPromptWal } from '../fixed-prompt-controller.js';
import { tokenSummary } from './helpers/cell-output-fixtures.js';

describe('prompt acceptance policy', () => {
  test('calibrates baseline means but applies no default pass-rate margin', () => {
    const baseline = calibratePromptAcceptanceBaseline({
      heldInTaskIds: ['in-a', 'in-b', 'in-c', 'in-d'],
      heldOutTaskIds: ['out-a', 'out-b'],
      baselineRuns: [
        {
          heldInEvents: [
            completed('in-a', true),
            completed('in-b', true),
            completed('in-c', false),
            completed('in-d', false),
          ],
          heldOutEvents: [completed('out-a', true), completed('out-b', false)],
        },
        {
          heldInEvents: [
            completed('in-a', true),
            completed('in-b', true),
            completed('in-c', true),
            completed('in-d', false),
          ],
          heldOutEvents: [completed('out-a', true), completed('out-b', true)],
        },
      ],
    });

    assert.equal(baseline.heldIn.meanPassEligibleRate, 0.625);
    assert.equal(baseline.heldIn.observedSpread, 0.125);
    assert.equal(baseline.heldIn.referencePassEligibleRate, 0.625);
    assert.equal(baseline.heldOut.originalPassEligibleRate, 0.75);
    assert.equal(baseline.heldOut.observedSpread, 0.25);
    assert.equal(baseline.heldIn.noiseBand, 0);
    assert.equal(baseline.heldOut.noiseBand, 0);
    assert.equal(
      promptAcceptanceNoiseBand({
        sampleSize: 4,
        passRate: 0.625,
        baselineRunCount: 2,
        observedSpread: 0.125,
      }),
      0,
    );
  });

  test('rejects incomplete baseline calibration runs', () => {
    assert.throws(
      () =>
        calibratePromptAcceptanceBaseline({
          heldInTaskIds: ['in-a', 'in-b'],
          heldOutTaskIds: ['out-a', 'out-b'],
          baselineRuns: [
            {
              heldInEvents: [completed('in-a', true), plumbingFailed('in-b')],
              heldOutEvents: [completed('out-a', true)],
            },
          ],
        }),
      /baseline held-in run 1 is incomplete/,
    );

    assert.throws(
      () =>
        calibratePromptAcceptanceBaseline({
          heldInTaskIds: ['in-a', 'in-b'],
          heldOutTaskIds: ['out-a', 'out-b'],
          baselineRuns: [
            {
              heldInEvents: [completed('in-a', true), completed('in-b', false)],
              heldOutEvents: [completed('out-a', true)],
            },
          ],
        }),
      /baseline held-out run 1 is incomplete/,
    );

    assert.throws(
      () =>
        calibratePromptAcceptanceBaseline({
          heldInTaskIds: ['in-a', 'in-b'],
          heldOutTaskIds: ['out-a'],
          baselineRuns: [
            {
              heldInEvents: [completed('in-a', true), infraFailed('in-b')],
              heldOutEvents: [completed('out-a', true)],
            },
          ],
        }),
      /baseline held-in run 1 is incomplete/,
    );

    assert.throws(
      () =>
        calibratePromptAcceptanceBaseline({
          heldInTaskIds: ['in-a', 'in-b'],
          heldOutTaskIds: ['out-a'],
          baselineRuns: [
            {
              heldInEvents: [
                completed('in-a', true),
                completed('in-b', false, { scored: false, errorClass: 'max_tokens' }),
              ],
              heldOutEvents: [completed('out-a', true)],
            },
          ],
        }),
      /baseline held-in run 1 is incomplete/,
    );
  });

  test('selects stable fast tasks from baseline runs', () => {
    const result = selectStablePromptTasks({
      taskIds: ['stable-fast', 'flaky', 'infra', 'slow'],
      baselineRuns: [
        [
          completed('stable-fast', false, { durationMs: 100 }),
          completed('flaky', true, { durationMs: 100 }),
          completed('infra', true, { durationMs: 100 }),
          completed('slow', false, { durationMs: 1_000 }),
        ],
        [
          completed('stable-fast', false, { durationMs: 120 }),
          completed('flaky', false, { durationMs: 100 }),
          infraFailed('infra'),
          completed('slow', false, { durationMs: 1_200 }),
        ],
        [
          completed('stable-fast', false, { durationMs: 110 }),
          completed('flaky', true, { durationMs: 100 }),
          completed('infra', true, { durationMs: 100 }),
          completed('slow', false, { durationMs: 1_100 }),
        ],
      ],
      maxPassRateSpread: 0,
      maxDurationMs: 500,
    });

    assert.deepEqual(result, {
      selectedTaskIds: ['stable-fast'],
      rejectedTaskIds: [
        { taskId: 'flaky', reason: 'unstable_outcome' },
        { taskId: 'infra', reason: 'incomplete' },
        { taskId: 'slow', reason: 'too_slow' },
      ],
    });
  });

  test('rejects stable task selection without baseline evidence', () => {
    const result = selectStablePromptTasks({
      taskIds: ['task-a', 'task-b'],
      baselineRuns: [],
    });

    assert.deepEqual(result, {
      selectedTaskIds: [],
      rejectedTaskIds: [
        { taskId: 'task-a', reason: 'incomplete' },
        { taskId: 'task-b', reason: 'incomplete' },
      ],
    });
  });

  test('classifies capability-limit and high-flip tasks from kept-prompt history', () => {
    const keptPromptEvents = [
      completed('stable', true, {
        id: 'stable-0',
        roundId: 'round-0',
        promptHash: 'prompt-0',
        ts: 1,
      }),
      completed('capability', false, {
        id: 'capability-0',
        roundId: 'round-0',
        promptHash: 'prompt-0',
        ts: 2,
      }),
      completed('flaky', true, {
        id: 'flaky-0',
        roundId: 'round-0',
        promptHash: 'prompt-0',
        ts: 3,
      }),
      completed('stable', true, {
        id: 'stable-1',
        roundId: 'round-1',
        promptHash: 'prompt-1',
        ts: 4,
      }),
      completed('capability', false, {
        id: 'capability-1',
        roundId: 'round-1',
        promptHash: 'prompt-1',
        ts: 5,
      }),
      completed('flaky', false, {
        id: 'flaky-1',
        roundId: 'round-1',
        promptHash: 'prompt-1',
        ts: 6,
      }),
      completed('stable', false, {
        id: 'stable-2',
        roundId: 'round-2',
        promptHash: 'prompt-2',
        ts: 7,
      }),
      completed('capability', false, {
        id: 'capability-2',
        roundId: 'round-2',
        promptHash: 'prompt-2',
        ts: 8,
      }),
      completed('flaky', true, {
        id: 'flaky-2',
        roundId: 'round-2',
        promptHash: 'prompt-2',
        ts: 9,
      }),
    ];

    const result = selectAddressablePromptTasks({
      taskIds: ['stable', 'capability', 'flaky'],
      keptPromptEvents,
    });

    assert.deepEqual(result, {
      selectedTaskIds: ['stable'],
      taskStats: [
        {
          taskId: 'stable',
          observations: 3,
          keptPrompts: 3,
          passes: 2,
          flips: 1,
          flipRate: 0.5,
          addressable: true,
        },
        {
          taskId: 'capability',
          observations: 3,
          keptPrompts: 3,
          passes: 0,
          flips: 0,
          flipRate: 0,
          addressable: false,
          rejectionReason: 'capability_limit',
        },
        {
          taskId: 'flaky',
          observations: 3,
          keptPrompts: 3,
          passes: 2,
          flips: 2,
          flipRate: 1,
          addressable: false,
          rejectionReason: 'flaky',
        },
      ],
    });
  });

  test('does not infer multiple retained prompts from legacy events without prompt hashes', () => {
    const result = selectAddressablePromptTasks({
      taskIds: ['legacy-failure'],
      keptPromptEvents: [
        completed('legacy-failure', false, { id: 'legacy-0', roundId: 'baseline-0', ts: 1 }),
        completed('legacy-failure', false, { id: 'legacy-1', roundId: 'baseline-1', ts: 2 }),
      ],
    });

    assert.deepEqual(result.selectedTaskIds, ['legacy-failure']);
    assert.equal(result.taskStats[0]?.keptPrompts, 1);
    assert.equal(result.taskStats[0]?.rejectionReason, undefined);
  });

  test('keeps candidates that improve held-in beyond noise without falling below the held-out original floor', () => {
    const heldInTaskIds = ['in-a', 'in-b', 'in-c', 'in-d'];
    const heldOutTaskIds = ['out-a', 'out-b'];

    const decision = decidePromptAcceptance({
      runId: 'run-1',
      roundId: 'round-2',
      candidateCommitSha: 'candidate-2',
      previousLastKeptCommitSha: 'kept-1',
      originalCommitSha: 'original-0',
      heldInTaskIds,
      heldOutTaskIds,
      previousHeldInReferencePassEligibleRate: 0.25,
      originalHeldOutPassEligibleRate: 1,
      heldInPassRateNoiseBand: 0.05,
      heldOutPassRateNoiseBand: 0.05,
      rewardHackScan: { decision: 'clean' },
      originalEvents: [completed('out-a', true), completed('out-b', true)],
      lastKeptEvents: [
        completed('in-a', true),
        completed('in-b', false),
        completed('in-c', false),
        completed('in-d', false),
      ],
      candidateEvents: [
        completed('in-a', true),
        completed('in-b', true),
        completed('in-c', true),
        completed('in-d', false),
        completed('out-a', true),
        completed('out-b', true),
      ],
    });

    assert.equal(decision.decision, 'keep');
    assert.equal(decision.reason, 'held_in_improved');
    assert.equal(decision.lastKeptCommitSha, 'candidate-2');
    assert.equal(decision.heldInReferencePassEligibleRate, 0.7);
    assert.equal(decision.metrics.lastKept.heldIn.passEligibleRate, 0.25);
    assert.equal(decision.metrics.candidate.heldIn.passEligibleRate, 0.75);
    assert.equal(decision.metrics.original.heldOut.passEligibleRate, 1);
    assert.equal(decision.metrics.candidate.heldOut.passEligibleRate, 1);
  });

  test('requires a reference-clearing candidate to beat the budget-matched sampling baseline', () => {
    const decision = decidePromptAcceptance({
      ...baseDecisionInput(),
      previousHeldInReferencePassEligibleRate: 0.25,
      lastKeptEvents: [completed('in-a', false), completed('in-b', false)],
      candidateEvents: [
        completed('in-a', true),
        completed('in-b', false),
        completed('out-a', true),
      ],
      samplingBaselineEvents: [completed('in-a', true), completed('in-b', false)],
      samplingPromptHash: 'prompt-kept-1',
    });

    assert.equal(decision.decision, 'discard');
    assert.equal(decision.reason, 'sampling_baseline_not_beaten');
    assert.equal(decision.samplingPromptHash, 'prompt-kept-1');
    assert.equal(decision.metrics.samplingBaseline?.heldIn.passEligibleRate, 0.5);
  });

  test('fails closed when the sampling baseline is incomplete', () => {
    const decision = decidePromptAcceptance({
      ...baseDecisionInput(),
      previousHeldInReferencePassEligibleRate: 0.25,
      lastKeptEvents: [completed('in-a', false), completed('in-b', false)],
      candidateEvents: [completed('in-a', true), completed('in-b', true), completed('out-a', true)],
      samplingBaselineEvents: [completed('in-a', true)],
    });

    assert.equal(decision.decision, 'discard');
    assert.equal(decision.reason, 'sampling_baseline_incomplete');
  });

  test('keeps against the monotonic held-in reference instead of a lucky last-kept run', () => {
    const decision = decidePromptAcceptance({
      ...baseDecisionInput(),
      heldInTaskIds: ['in-a', 'in-b', 'in-c', 'in-d'],
      previousHeldInReferencePassEligibleRate: 0.5,
      originalHeldOutPassEligibleRate: 1,
      heldInPassRateNoiseBand: 0.05,
      heldOutPassRateNoiseBand: 0.05,
      lastKeptEvents: [
        completed('in-a', true),
        completed('in-b', true),
        completed('in-c', true),
        completed('in-d', true),
      ],
      candidateEvents: [
        completed('in-a', true),
        completed('in-b', true),
        completed('in-c', true),
        completed('in-d', false),
        completed('out-a', true),
      ],
    });

    assert.equal(decision.decision, 'keep');
    assert.equal(decision.reason, 'held_in_improved');
    assert.equal(decision.heldInReferencePassEligibleRate, 0.7);
  });

  test('uses separate held-in and held-out pass-rate noise bands', () => {
    const decision = decidePromptAcceptance({
      ...baseDecisionInput(),
      heldOutTaskIds: ['out-a', 'out-b', 'out-c', 'out-d'],
      previousHeldInReferencePassEligibleRate: 0.25,
      originalHeldOutPassEligibleRate: 1,
      heldInPassRateNoiseBand: 0.05,
      heldOutPassRateNoiseBand: 0.3,
      originalEvents: [
        completed('out-a', true),
        completed('out-b', true),
        completed('out-c', true),
        completed('out-d', true),
      ],
      candidateEvents: [
        completed('in-a', true),
        completed('in-b', true),
        completed('out-a', true),
        completed('out-b', true),
        completed('out-c', true),
        completed('out-d', false),
      ],
    });

    assert.equal(decision.decision, 'keep');
    assert.equal(decision.reason, 'held_in_improved');
  });

  test('keeps held-in improvements when no held-out floor is configured', () => {
    const decision = decidePromptAcceptance({
      ...baseDecisionInput(),
      heldOutTaskIds: [],
      originalEvents: [],
      previousHeldInReferencePassEligibleRate: 0.5,
      originalHeldOutPassEligibleRate: null,
      heldInPassRateNoiseBand: 0.05,
      heldOutPassRateNoiseBand: 0.05,
      lastKeptEvents: [completed('in-a', true), completed('in-b', false)],
      candidateEvents: [completed('in-a', true), completed('in-b', true)],
    });

    assert.equal(decision.decision, 'keep');
    assert.equal(decision.reason, 'held_in_improved');
    assert.equal(decision.metrics.original.heldOut.coverageRate, null);
    assert.equal(decision.metrics.candidate.heldOut.coverageRate, null);
  });

  test('summarizes pass over eligible separately from coverage', () => {
    const summary = summarizePromptAcceptancePartition(
      [
        completed('task-a', true),
        completed('task-b', false),
        completed('task-c', true, { scored: false }),
        infraFailed('task-d'),
      ],
      ['task-a', 'task-b', 'task-c', 'task-d'],
    );

    assert.deepEqual(summary, {
      taskCount: 4,
      observed: 4,
      eligible: 3,
      scored: 2,
      passed: 2,
      passEligibleRate: 2 / 3,
      coverageRate: 2 / 3,
      unscoredTaskIds: ['task-c'],
      infraFailedTaskIds: ['task-d'],
      plumbingFailedTaskIds: [],
      missingTaskIds: [],
    });
  });

  test('counts a graded budget exhaustion as evidence and an ungraded one as lost coverage', () => {
    // A timeout the verifier graded is a score, so it belongs in both rates. An
    // ungraded one is the case the partition already handled: eligible, but
    // nothing to score, so it drags coverage down and blocks calibration.
    const summary = summarizePromptAcceptancePartition(
      [
        budgetExhausted('task-a', { passed: true, scored: true }),
        budgetExhausted('task-b', { passed: false, scored: true }),
        budgetExhausted('task-c'),
      ],
      ['task-a', 'task-b', 'task-c'],
    );

    assert.equal(summary.eligible, 3);
    assert.equal(summary.scored, 2);
    assert.equal(summary.passed, 1);
    assert.equal(summary.passEligibleRate, 1 / 3);
    assert.equal(summary.coverageRate, 2 / 3);
    assert.deepEqual(summary.unscoredTaskIds, ['task-c']);
  });

  test('discards flat held-in changes without requiring a positive noise margin', () => {
    const decision = decidePromptAcceptance({
      ...baseDecisionInput(),
      previousHeldInReferencePassEligibleRate: 0.5,
      heldInPassRateNoiseBand: 0.1,
      lastKeptEvents: [completed('in-a', true), completed('in-b', false)],
      candidateEvents: [
        completed('in-a', true),
        completed('in-b', false),
        completed('out-a', true),
      ],
    });

    assert.equal(decision.decision, 'discard');
    assert.equal(decision.reason, 'held_in_within_noise');
    assert.equal(decision.lastKeptCommitSha, 'kept-1');
  });

  test('discards held-in regressions', () => {
    const decision = decidePromptAcceptance({
      ...baseDecisionInput(),
      previousHeldInReferencePassEligibleRate: 1,
      heldInPassRateNoiseBand: 0.05,
      lastKeptEvents: [completed('in-a', true), completed('in-b', true)],
      candidateEvents: [
        completed('in-a', true),
        completed('in-b', false),
        completed('out-a', true),
      ],
    });

    assert.equal(decision.decision, 'discard');
    assert.equal(decision.reason, 'held_in_regressed');
  });

  test('discards candidate coverage degradation, including infra failures', () => {
    const decision = decidePromptAcceptance({
      ...baseDecisionInput(),
      lastKeptEvents: [completed('in-a', true), infraFailed('in-b')],
      candidateEvents: [completed('in-a', true), infraFailed('in-b'), completed('out-a', true)],
    });

    assert.equal(decision.decision, 'discard');
    assert.equal(decision.reason, 'coverage_regressed');
    assert.deepEqual(decision.metrics.candidate.heldIn.infraFailedTaskIds, ['in-b']);
  });

  test('keeps held-in improvements even when eligible tasks are unscored', () => {
    const decision = decidePromptAcceptance({
      ...baseDecisionInput(),
      heldInTaskIds: ['in-a', 'in-b', 'in-c'],
      previousHeldInReferencePassEligibleRate: 0.5,
      lastKeptEvents: [completed('in-a', true), completed('in-b', false), completed('in-c', false)],
      candidateEvents: [
        completed('in-a', true),
        completed('in-b', true),
        completed('in-c', false, { scored: false, errorClass: 'max_tokens' }),
        completed('out-a', true),
      ],
    });

    assert.equal(decision.decision, 'keep');
    assert.equal(decision.reason, 'held_in_improved');
    assert.equal(decision.metrics.candidate.heldIn.coverageRate, 2 / 3);
    assert.deepEqual(decision.metrics.candidate.heldIn.unscoredTaskIds, ['in-c']);
  });

  test('discards when a configured held-out floor is missing its original reference', () => {
    const decision = decidePromptAcceptance({
      ...baseDecisionInput(),
      heldOutTaskIds: ['out-a'],
      originalEvents: [],
      candidateEvents: [completed('in-a', true), completed('in-b', true), completed('out-a', true)],
    });

    assert.equal(decision.decision, 'discard');
    assert.equal(decision.reason, 'coverage_regressed');
    assert.deepEqual(decision.metrics.original.heldOut.missingTaskIds, ['out-a']);
  });

  test('discards candidates with missing task results', () => {
    const decision = decidePromptAcceptance({
      ...baseDecisionInput(),
      candidateEvents: [completed('in-a', true), completed('out-a', true)],
    });

    assert.equal(decision.decision, 'discard');
    assert.equal(decision.reason, 'coverage_regressed');
    assert.deepEqual(decision.metrics.candidate.heldIn.missingTaskIds, ['in-b']);
  });

  test('discards candidates with plumbing failures', () => {
    const decision = decidePromptAcceptance({
      ...baseDecisionInput(),
      candidateEvents: [completed('in-a', true), plumbingFailed('in-b'), completed('out-a', true)],
    });

    assert.equal(decision.decision, 'discard');
    assert.equal(decision.reason, 'coverage_regressed');
    assert.deepEqual(decision.metrics.candidate.heldIn.plumbingFailedTaskIds, ['in-b']);
  });

  test('discards metric-improving candidates with reward-hack quarantine evidence', async () => {
    await withDir(async (dir) => {
      const rewardHackScan = {
        decision: 'quarantine' as const,
        reason: 'verifier_pattern',
        matchedPatterns: ['EXPECTED_SECRET'],
      };
      const decision = decidePromptAcceptance({
        ...baseDecisionInput(),
        rewardHackScan,
      });

      assert.equal(decision.decision, 'discard');
      assert.equal(decision.reason, 'reward_hack_quarantined');
      assert.equal(decision.lastKeptCommitSha, 'kept-1');
      assert.deepEqual(decision.rewardHackScan, rewardHackScan);

      await appendPromptAcceptanceDecision({
        resultsJsonlPath: join(dir, 'results.jsonl'),
        id: 'decision-1',
        ts: 100,
        result: decision,
      });
      const [event] = await readFixedPromptWal(join(dir, 'results.jsonl'));
      assert.equal(event?.type, 'prompt_candidate_decided');
      assert.equal(event?.reason, 'reward_hack_quarantined');
      assert.deepEqual(event?.rewardHackScan, rewardHackScan);
    });
  });

  test('treats missing reward-hack scan evidence as report-only clean metadata', async () => {
    await withDir(async (dir) => {
      const input = baseDecisionInput();
      delete (input as { rewardHackScan?: unknown }).rewardHackScan;

      const decision = decidePromptAcceptance(input);

      assert.equal(decision.decision, 'keep');
      assert.equal(decision.reason, 'held_in_improved');
      assert.deepEqual(decision.rewardHackScan, {
        decision: 'clean',
      });

      await appendPromptAcceptanceDecision({
        resultsJsonlPath: join(dir, 'results.jsonl'),
        id: 'decision-1',
        ts: 100,
        result: decision,
      });
      const [event] = await readFixedPromptWal(join(dir, 'results.jsonl'));
      assert.equal(event?.type, 'prompt_candidate_decided');
      assert.deepEqual(event?.rewardHackScan, {
        decision: 'clean',
      });
    });
  });

  test('discards candidates that fall below the held-out original floor', () => {
    const decision = decidePromptAcceptance({
      ...baseDecisionInput(),
      heldOutTaskIds: ['out-a', 'out-b'],
      originalEvents: [completed('out-a', true), completed('out-b', true)],
      lastKeptEvents: [completed('in-a', true), completed('in-b', false)],
      candidateEvents: [
        completed('in-a', true),
        completed('in-b', true),
        completed('out-a', true),
        completed('out-b', false),
      ],
    });

    assert.equal(decision.decision, 'discard');
    assert.equal(decision.reason, 'held_out_regressed');
  });

  test('uses the calibrated held-out original mean instead of one original run', () => {
    const decision = decidePromptAcceptance({
      ...baseDecisionInput(),
      heldOutTaskIds: ['out-a', 'out-b'],
      originalHeldOutPassEligibleRate: 0.75,
      heldOutPassRateNoiseBand: 0.1,
      originalEvents: [completed('out-a', true), completed('out-b', false)],
      candidateEvents: [
        completed('in-a', true),
        completed('in-b', true),
        completed('out-a', true),
        completed('out-b', false),
      ],
    });

    assert.equal(decision.decision, 'discard');
    assert.equal(decision.reason, 'held_out_regressed');
  });

  test('records KEEP and DISCARD decisions in the WAL and resumes last kept commit', async () => {
    await withDir(async (dir) => {
      const resultsJsonlPath = join(dir, 'results.jsonl');
      const keep = decidePromptAcceptance(baseDecisionInput());
      await appendPromptAcceptanceDecision({
        resultsJsonlPath,
        id: 'decision-1',
        ts: 100,
        result: keep,
      });

      const discard = decidePromptAcceptance({
        ...baseDecisionInput(),
        roundId: 'round-3',
        candidateCommitSha: 'candidate-3',
        previousLastKeptCommitSha: keep.lastKeptCommitSha,
        previousHeldInReferencePassEligibleRate: keep.heldInReferencePassEligibleRate,
        candidateEvents: [
          completed('in-a', true),
          completed('in-b', false),
          completed('out-a', true),
        ],
      });
      await appendPromptAcceptanceDecision({
        resultsJsonlPath,
        id: 'decision-2',
        ts: 101,
        result: discard,
      });

      const events = await readFixedPromptWal(resultsJsonlPath);
      assert.equal(events.length, 2);
      assert.deepEqual(
        events.map((event) => event.type),
        ['prompt_candidate_decided', 'prompt_candidate_decided'],
      );
      assert.deepEqual(promptAcceptanceStateFromWal(events, 'original-0'), {
        lastKeptCommitSha: 'candidate-2',
        heldInReferencePassEligibleRate: 0.95,
        decisions: [
          { roundId: 'round-2', decision: 'keep', candidateCommitSha: 'candidate-2' },
          { roundId: 'round-3', decision: 'discard', candidateCommitSha: 'candidate-3' },
        ],
      });
    });
  });
});

function baseDecisionInput() {
  return {
    runId: 'run-1',
    roundId: 'round-2',
    candidateCommitSha: 'candidate-2',
    previousLastKeptCommitSha: 'kept-1',
    originalCommitSha: 'original-0',
    heldInTaskIds: ['in-a', 'in-b'],
    heldOutTaskIds: ['out-a'],
    previousHeldInReferencePassEligibleRate: 0.5,
    originalHeldOutPassEligibleRate: 1,
    heldInPassRateNoiseBand: 0.05,
    heldOutPassRateNoiseBand: 0.05,
    rewardHackScan: { decision: 'clean' as const },
    originalEvents: [completed('out-a', true)],
    lastKeptEvents: [completed('in-a', true), completed('in-b', false)],
    candidateEvents: [completed('in-a', true), completed('in-b', true), completed('out-a', true)],
  };
}

function completed(
  taskId: string,
  passed: boolean,
  overrides: Partial<FixedPromptTaskCompletedEvent> = {},
): FixedPromptTaskWalEvent {
  return {
    schemaVersion: 1,
    type: 'task_completed',
    id: `event-${taskId}`,
    ts: 1,
    runId: 'run-1',
    roundId: 'round-1',
    taskId,
    status: 'completed',
    passed,
    scored: true,
    eligible: true,
    tokenSummary: tokenSummary({ input: 1, output: 1, reasoning: 0, total: 2, costUsd: 0.01 }),
    steps: 1,
    durationMs: 10,
    runtimeEventsPath: `/logs/${taskId}.jsonl`,
    harbor: { reward: passed ? 1 : 0 },
    ...overrides,
  };
}

function infraFailed(taskId: string): FixedPromptTaskWalEvent {
  return {
    schemaVersion: 1,
    type: 'task_infra_failed',
    id: `event-${taskId}`,
    ts: 1,
    runId: 'run-1',
    roundId: 'round-1',
    taskId,
    status: 'infra_failed',
    passed: false,
    scored: false,
    eligible: false,
    errorClass: 'infra_error',
    error: 'container crashed',
  };
}

function budgetExhausted(
  taskId: string,
  outcome: { passed?: boolean; scored?: boolean } = {},
): FixedPromptTaskWalEvent {
  const scored = outcome.scored ?? false;
  return {
    schemaVersion: 1,
    type: 'task_budget_exhausted',
    id: `event-${taskId}`,
    ts: 1,
    runId: 'run-1',
    roundId: 'round-1',
    taskId,
    status: 'budget_exhausted',
    passed: outcome.passed ?? false,
    scored,
    eligible: true,
    errorClass: 'budget_exhausted',
    error: 'agent budget exhausted',
    expectedPromptHash: 'sha256:prompt',
    ...(scored ? { harbor: { reward: outcome.passed ? 1 : 0 } } : {}),
  };
}

function plumbingFailed(taskId: string): FixedPromptTaskWalEvent {
  return {
    schemaVersion: 1,
    type: 'task_plumbing_failed',
    id: `event-${taskId}`,
    ts: 1,
    runId: 'run-1',
    roundId: 'round-1',
    taskId,
    status: 'plumbing_failed',
    passed: false,
    scored: false,
    eligible: false,
    errorClass: 'prompt_hash_mismatch',
    error: 'prompt hash mismatch',
    promptHash: 'actual',
    expectedPromptHash: 'expected',
    tokenSummary: tokenSummary({ input: 1, output: 1, reasoning: 0, total: 2, costUsd: 0.01 }),
    steps: 1,
    durationMs: 10,
    runtimeEventsPath: `/logs/${taskId}.jsonl`,
    harbor: { reward: 0 },
  };
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'maka-prompt-acceptance-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
