import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { readFixedPromptWal } from '../fixed-prompt-controller.js';
import { promptAcceptanceNoiseBand } from '../prompt-acceptance-policy.js';
import {
  execFileAsync,
  evidenceRefsFor,
  fakeMetaAgent,
  makeTasks,
  runLoop,
  taskIndex,
  withHarness,
  type MetaAgentPromptInput,
} from './helpers/prompt-optimization-loop-harness.js';

describe('runPromptOptimizationLoop', () => {
  test('defaults the acceptance noise band to a 1.96 z-score', async () => {
    await withHarness(async (harness) => {
      const result = await runLoop(harness, {
        heldInTasks: makeTasks('hin', 4),
        heldOutTasks: makeTasks('hout', 2),
        rewardFor: (_roundId, taskId) => taskIndex(taskId) % 2,
        rounds: 1,
        baselineRuns: 1,
      });

      assert.equal(
        result.baseline.heldIn.noiseBand,
        promptAcceptanceNoiseBand({
          sampleSize: 4,
          passRate: 0.5,
          baselineRunCount: 1,
          zScore: 1.96,
        }),
      );
    });
  });

  test('runs a budget-matched sampling arm before each candidate and records its Pass@1 evidence', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 4);
      const heldOutTasks = makeTasks('hout', 2);
      const result = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor: (roundId, taskId) => {
          if (taskId.startsWith('hout-')) return 1;
          if (roundId.startsWith('baseline-')) return taskIndex(taskId) < 2 ? 1 : 0;
          if (roundId.startsWith('sampling-')) return taskIndex(taskId) < 2 ? 1 : 0;
          return taskIndex(taskId) < 4 ? 1 : 0;
        },
        rounds: 1,
        baselineRuns: 1,
      });

      assert.equal(result.decisions[0]?.decision, 'keep');
      assert.equal(result.decisions[0]?.metrics.samplingBaseline?.heldIn.taskCount, 4);
      assert.equal(result.decisions[0]?.metrics.samplingBaseline?.heldIn.passEligibleRate, 0.5);
      const events = await readFixedPromptWal(harness.resultsJsonlPath);
      const sampling = events.filter((event) => event.roundId === 'sampling-0');
      const candidate = events.filter((event) => event.roundId === 'round-0');
      assert.equal(sampling.filter((event) => event.type === 'task_completed').length, 4);
      const samplingAttempts = (
        await readFile(`${harness.resultsJsonlPath}.attempts.jsonl`, 'utf8')
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { roundId: string; type: string });
      assert.equal(samplingAttempts.length, 4);
      assert.ok(samplingAttempts.every((event) => event.type === 'task_attempt_started'));
      assert.ok(samplingAttempts.every((event) => event.roundId === 'sampling-0'));
      assert.equal(
        candidate.filter(
          (event) => event.type === 'task_completed' && event.taskId.startsWith('hin-'),
        ).length,
        4,
      );
      assert.ok(
        events.findIndex((event) => event.roundId === 'sampling-0') <
          events.findIndex((event) => event.type === 'prompt_candidate_committed'),
      );
      const replayTaskRuns: string[] = [];
      const replayed = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor: (roundId, taskId) => {
          if (taskId.startsWith('hout-')) return 1;
          if (roundId.startsWith('baseline-') || roundId.startsWith('sampling-')) {
            return taskIndex(taskId) < 2 ? 1 : 0;
          }
          return 1;
        },
        rounds: 1,
        baselineRuns: 1,
        onTaskRun: (roundId, taskId) => replayTaskRuns.push(`${roundId}:${taskId}`),
      });
      assert.deepEqual(replayed.decisions, result.decisions);
      assert.deepEqual(replayTaskRuns, []);
    });
  });

  test('stops after replaying a complete sampling arm when the budget is already exhausted', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      const rewardFor = (roundId: string, taskId: string): number => {
        if (taskId.startsWith('hout-')) return 1;
        if (roundId.startsWith('baseline-')) return taskIndex(taskId) < 10 ? 1 : 0;
        return 1;
      };
      const first = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 1,
        baselineRuns: 1,
        costCeilingUsd: 0.959,
      });
      assert.deepEqual(first.decisions, []);
      assert.equal(first.stopReason, 'cost_ceiling_exceeded');

      const resumedTaskRuns: string[] = [];
      const resumed = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 1,
        baselineRuns: 1,
        costCeilingUsd: 0.959,
        onTaskRun: (roundId, taskId) => resumedTaskRuns.push(`${roundId}:${taskId}`),
      });
      assert.deepEqual(resumed.decisions, []);
      assert.equal(resumed.stopReason, 'cost_ceiling_exceeded');
      assert.deepEqual(resumedTaskRuns, []);
    });
  });

  test('keeps an improving candidate, discards a regressing one, and reports a passing smoke', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      // baseline held-in 0.5; round-0 jumps to 1.0 (KEEP); round-1 collapses to
      // 0.0 (DISCARD). Held-out stays flat at 0.5 so it never gates.
      const rewardFor = (roundId: string, taskId: string): number => {
        const index = taskIndex(taskId);
        if (taskId.startsWith('hout-')) return index < 4 ? 1 : 0;
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        return roundId === 'round-0' ? 1 : 0;
      };

      const result = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 2,
        baselineRuns: 2,
      });

      assert.equal(result.decisions.length, 2);
      assert.equal(result.decisions[0]?.decision, 'keep');
      assert.equal(result.decisions[0]?.reason, 'held_in_improved');
      assert.equal(result.decisions[1]?.decision, 'discard');
      assert.equal(result.decisions[1]?.reason, 'held_in_regressed');
      assert.equal(result.keptCount, 1);
      assert.equal(result.stopReason, 'rounds_complete');

      // The kept lineage is round-0's candidate; round-1 was rolled back so HEAD
      // and the prompt return to the kept state.
      assert.equal(result.lastKeptCommitSha, result.decisions[0]?.candidateCommitSha);
      const head = (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: harness.repoDir })
      ).stdout.trim();
      assert.equal(head, result.lastKeptCommitSha);
      assert.equal(await readFile(harness.systemPromptPath, 'utf8'), 'candidate prompt round-0\n');

      assert.equal(result.smoke.status, 'pass');
      assert.deepEqual(result.smoke.decisions, { keep: 1, discard: 1 });
      assert.equal(result.smoke.observedRounds, 2);
      assert.equal(result.smoke.quarantineCount, 0);
      assert.equal(result.smoke.taskEvents.infraFailed, 0);
      assert.equal(result.smoke.taskEvents.plumbingFailed, 0);
    });
  });

  test('persists attribution and feeds held-in-only R2 feedback into the next prompt', async () => {
    await withHarness(async (harness) => {
      const promptInputs: MetaAgentPromptInput[] = [];
      const heldInTasks = makeTasks('hin', 2);
      const heldOutTasks = makeTasks('hout', 1);
      const rewardFor = (roundId: string, taskId: string): number => {
        if (taskId.startsWith('hout-')) return 1;
        if (roundId.startsWith('baseline-')) return taskIndex(taskId) === 0 ? 1 : 0;
        return roundId === 'round-0' ? 0 : taskIndex(taskId) === 0 ? 1 : 0;
      };

      await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 2,
        baselineRuns: 2,
        metaAgent: async (promptInput) => {
          promptInputs.push(promptInput);
          return {
            systemPrompt: `candidate prompt ${promptInput.roundId}\n`,
            summary: `tuned for ${promptInput.roundId}`,
            candidateRationale: {
              editedSurface: 'system_prompt',
              evidenceRefs: evidenceRefsFor(promptInput),
              hypothesis: 'avoid losing held-in scored artifacts',
              targetedFix: 'state artifact completion constraints plainly',
              predictedFixes: ['hin-1'],
              riskTasks: ['hin-0'],
              ...(evidenceRefsFor(promptInput).length === 0
                ? { failurePattern: 'coverage_regression' as const }
                : {}),
            },
          };
        },
      });

      assert.equal(promptInputs.length, 2);
      assert.ok(promptInputs[0]?.rsiAnalysis);
      assert.equal(promptInputs[0]?.promptAttribution, undefined);
      assert.ok(promptInputs[1]?.rsiAnalysis);
      assert.deepEqual(promptInputs[1]?.promptAttribution?.predictedFixes, [
        { taskId: 'hin-1', outcome: 'unchanged' },
      ]);
      assert.deepEqual(promptInputs[1]?.promptAttribution?.riskTasks, [
        { taskId: 'hin-0', outcome: 'regressed' },
      ]);
      assert.equal('decisionReason' in (promptInputs[1]?.promptAttribution ?? {}), false);
      assert.equal(JSON.stringify(promptInputs[1]?.promptAttribution).includes('hout-'), false);
      assert.equal(JSON.stringify(promptInputs[1]?.promptAttribution).includes('held_out'), false);

      const events = await readFixedPromptWal(harness.resultsJsonlPath);
      assert.equal(events.filter((event) => event.type === 'rsi_controller_attribution').length, 2);
      for (const decision of events.filter((event) => event.type === 'prompt_candidate_decided')) {
        const decisionIndex = events.indexOf(decision);
        const attributionIndex = events.findIndex(
          (event) =>
            event.type === 'rsi_controller_attribution' &&
            event.runId === decision.runId &&
            event.roundId === decision.roundId &&
            event.candidateCommitSha === decision.candidateCommitSha,
        );
        assert.ok(attributionIndex > decisionIndex);
      }
    });
  });

  test('feeds sanitized verifier failure summaries into prompt digests', async () => {
    await withHarness(async (harness) => {
      const promptInputs: MetaAgentPromptInput[] = [];
      const heldInTasks = makeTasks('hin', 2);
      const heldOutTasks = makeTasks('hout', 1);

      await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor: (_roundId, taskId) => (taskId === 'hin-0' ? 0 : 1),
        verifierFailureSummaryFor: (roundId, taskId) =>
          roundId === 'baseline-0' && taskId === 'hin-0'
            ? 'output_assertion_failed integer_output_off_by_one'
            : undefined,
        rounds: 1,
        baselineRuns: 1,
        metaAgent: async (promptInput) => {
          promptInputs.push(promptInput);
          return {
            systemPrompt: `candidate prompt ${promptInput.roundId}\n`,
            summary: `tuned for ${promptInput.roundId}`,
            candidateRationale: {
              editedSurface: 'system_prompt',
              evidenceRefs: evidenceRefsFor(promptInput),
              hypothesis: 'integer output selection can be made less ambiguous',
              targetedFix: 'prefer the task requested count when multiple totals appear',
              predictedFixes: ['hin-0'],
              riskTasks: ['hin-1'],
              ...(evidenceRefsFor(promptInput).length === 0
                ? { failurePattern: 'verification_failed' as const }
                : {}),
            },
          };
        },
      });

      assert.equal(promptInputs.length, 1);
      assert.equal(
        promptInputs[0]?.heldInDigests.find((digest) => digest.taskId === 'hin-0')?.summary,
        'output_assertion_failed integer_output_off_by_one',
      );
      assert.equal(JSON.stringify(promptInputs[0]).includes('79586'), false);
    });
  });

  test('matches attribution root cause against prompt-time analysis after coverage signal is fixed', async () => {
    await withHarness(async (harness) => {
      const promptInputs: MetaAgentPromptInput[] = [];
      const heldInTasks = makeTasks('hin', 2);
      const heldOutTasks = makeTasks('hout', 1);
      const rewardFor = (roundId: string, taskId: string): number => {
        if (taskId.startsWith('hout-')) return 1;
        if (roundId.startsWith('baseline-')) return 1;
        return roundId === 'round-0' && taskId === 'hin-0' ? 0 : 1;
      };

      await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 2,
        baselineRuns: 2,
        shouldFail: (roundId, taskId) => roundId === 'round-0' && taskId === 'hin-0',
        metaAgent: async (promptInput) => {
          promptInputs.push(promptInput);
          return {
            systemPrompt: `candidate prompt ${promptInput.roundId}\n`,
            summary: `tuned for ${promptInput.roundId}`,
            candidateRationale: {
              editedSurface: 'system_prompt',
              evidenceRefs: evidenceRefsFor(promptInput),
              hypothesis: 'restore coverage for held-in tasks',
              targetedFix: 'make artifact completion constraints explicit',
              predictedFixes: ['hin-0'],
              riskTasks: [],
              ...(evidenceRefsFor(promptInput).length === 0
                ? { failurePattern: 'coverage_regression' as const }
                : {}),
            },
          };
        },
      });

      const promptTimeCoverageSignal = promptInputs[1]?.rsiAnalysis?.signals.find(
        (signal) => signal.kind === 'coverage_regression',
      );
      assert.ok(promptTimeCoverageSignal);
      const events = await readFixedPromptWal(harness.resultsJsonlPath);
      const secondAttribution = events.find(
        (event) => event.type === 'rsi_controller_attribution' && event.roundId === 'round-1',
      );
      assert.equal(secondAttribution?.type, 'rsi_controller_attribution');
      if (secondAttribution?.type === 'rsi_controller_attribution') {
        assert.deepEqual(secondAttribution.evidenceRefs, [promptTimeCoverageSignal.id]);
        assert.deepEqual(secondAttribution.predictedFixes, [
          { taskId: 'hin-0', outcome: 'unchanged' },
        ]);
        assert.equal(secondAttribution.rootCauseSignalMatch, 'matched');
      }
    });
  });

  test('does not teach held-out coverage discard reasons to the next prompt', async () => {
    await withHarness(async (harness) => {
      const promptInputs: MetaAgentPromptInput[] = [];
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 2);
      const rewardFor = (roundId: string, taskId: string): number => {
        if (taskId.startsWith('hout-')) return 1;
        if (roundId.startsWith('baseline-')) return taskIndex(taskId) < 10 ? 1 : 0;
        return 1;
      };

      await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 2,
        baselineRuns: 2,
        shouldFail: (roundId, taskId) => roundId === 'round-0' && taskId === 'hout-1',
        metaAgent: async (promptInput) => {
          promptInputs.push(promptInput);
          return {
            systemPrompt: `candidate prompt ${promptInput.roundId}\n`,
            summary: `tuned for ${promptInput.roundId}`,
            candidateRationale: {
              editedSurface: 'system_prompt',
              evidenceRefs: evidenceRefsFor(promptInput),
              hypothesis: 'avoid losing held-in scored artifacts',
              targetedFix: 'state artifact completion constraints plainly',
              predictedFixes: ['hin-19'],
              riskTasks: [],
              ...(evidenceRefsFor(promptInput).length === 0
                ? { failurePattern: 'coverage_regression' as const }
                : {}),
            },
          };
        },
      });

      assert.equal(promptInputs.length, 2);
      const visible = JSON.stringify(promptInputs[1]?.promptAttribution);
      assert.equal('decisionReason' in (promptInputs[1]?.promptAttribution ?? {}), false);
      assert.equal(visible.includes('coverage_regressed'), false);
      assert.equal(visible.includes('held_out'), false);
      assert.equal(visible.includes('hout-'), false);
    });
  });

  test('discards every candidate when no change beats the noise band, leaving the original prompt', async () => {
    await withHarness(async (harness) => {
      const originalHead = (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: harness.repoDir })
      ).stdout.trim();
      const heldInTasks = makeTasks('hin', 2);
      const heldOutTasks = makeTasks('hout', 1);
      // Flat pass rates every round: held-in stays at 0.5, well within the wide
      // noise band of a two-task partition, so no candidate is ever kept.
      const rewardFor = (_roundId: string, taskId: string): number => {
        if (taskId.startsWith('hout-')) return 1;
        return taskIndex(taskId) === 0 ? 1 : 0;
      };

      const result = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 2,
        baselineRuns: 2,
      });

      assert.equal(result.keptCount, 0);
      assert.deepEqual(
        result.decisions.map((decision) => decision.decision),
        ['discard', 'discard'],
      );
      assert.equal(result.lastKeptCommitSha, originalHead);
      const head = (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: harness.repoDir })
      ).stdout.trim();
      assert.equal(head, originalHead);
      assert.equal(await readFile(harness.systemPromptPath, 'utf8'), 'original prompt\n');
      // Zero keeps is a passing structural smoke for v1.
      assert.equal(result.smoke.status, 'pass');
      assert.deepEqual(result.smoke.decisions, { keep: 0, discard: 2 });
    });
  });

  test('keeps the calibrated baseline reference after a discard before the first keep', async () => {
    await withHarness(async (harness) => {
      const rewardFor = (roundId: string, taskId: string): number => {
        if (taskId.startsWith('hout-')) return 1;
        const index = taskIndex(taskId);
        if (roundId === 'baseline-0') return index < 10 ? 1 : 0;
        if (roundId === 'baseline-1') return index < 14 ? 1 : 0;
        return index < 12 ? 1 : 0;
      };

      const result = await runLoop(harness, {
        heldInTasks: makeTasks('hin', 20),
        heldOutTasks: makeTasks('hout', 2),
        rewardFor,
        rounds: 2,
        baselineRuns: 2,
      });

      assert.equal(result.decisions[0]?.decision, 'discard');
      assert.equal(result.baseline.heldIn.referencePassEligibleRate, 0.6);
      assert.equal(
        result.decisions[1]?.previousHeldInReferencePassEligibleRate,
        result.baseline.heldIn.referencePassEligibleRate,
      );
    });
  });

  test('carries the banked reference after a keep instead of the raw kept sweep rate', async () => {
    await withHarness(async (harness) => {
      const rewardFor = (roundId: string, taskId: string): number => {
        const index = taskIndex(taskId);
        if (taskId.startsWith('hout-')) return index < 2 ? 1 : 0;
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        if (roundId === 'round-0') return index < 6 || index >= 10 ? 1 : 0;
        return index < 17 ? 1 : 0;
      };

      const result = await runLoop(harness, {
        heldInTasks: makeTasks('hin', 20),
        heldOutTasks: makeTasks('hout', 4),
        rewardFor,
        rounds: 2,
        baselineRuns: 2,
        zScore: 0.5,
      });

      assert.deepEqual(
        result.decisions.map((decision) => decision.decision),
        ['keep', 'keep'],
      );
      assert.equal(
        result.decisions[1]?.previousHeldInReferencePassEligibleRate,
        result.decisions[0]?.heldInReferencePassEligibleRate,
      );
      assert.notEqual(
        result.decisions[0]?.heldInReferencePassEligibleRate,
        result.decisions[0]?.metrics.candidate.heldIn.passEligibleRate,
      );
    });
  });

  test('skips the held-out sweep for a candidate that does not clear the held-in gate', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 2);
      const heldOutTasks = makeTasks('hout', 2);
      // Held-in flat at 0.5 (within the wide two-task noise band) every candidate
      // round, so no candidate clears the held-in gate.
      const rewardFor = (_roundId: string, taskId: string): number => {
        if (taskId.startsWith('hout-')) return 1;
        return taskIndex(taskId) === 0 ? 1 : 0;
      };

      const result = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 2,
        baselineRuns: 2,
      });

      assert.deepEqual(
        result.decisions.map((decision) => decision.decision),
        ['discard', 'discard'],
      );
      assert.equal(result.decisions[0]?.reason, 'held_in_within_noise');

      // #64 two-stage gate: a candidate that cannot KEEP on held-in must never
      // spend the held-out sweep — no held-out task event under any candidate round.
      const events = (await readFile(harness.resultsJsonlPath, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const isHeldOut = (e: { taskId?: unknown }) =>
        typeof e.taskId === 'string' && e.taskId.startsWith('hout-');
      const candidateHeldOut = events.filter(
        (e) => typeof e.roundId === 'string' && e.roundId.startsWith('round-') && isHeldOut(e),
      );
      assert.equal(candidateHeldOut.length, 0);
      // Held-out baseline events still exist (calibration runs held-out), proving
      // the check above is about candidate rounds, not broken held-out wiring.
      const baselineHeldOut = events.filter(
        (e) => typeof e.roundId === 'string' && e.roundId.startsWith('baseline-') && isHeldOut(e),
      );
      assert.ok(baselineHeldOut.length > 0);
    });
  });

  test('quarantines held-in tasks without verifier-only patterns instead of keeping them', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      const taskRuns: string[] = [];
      const rewardFor = (roundId: string, taskId: string): number => {
        const index = taskIndex(taskId);
        if (taskId.startsWith('hout-')) return index < 4 ? 1 : 0;
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        return 1;
      };

      const result = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 1,
        baselineRuns: 2,
        rewardHackVerifierPatternsByTaskId: Object.fromEntries(
          heldInTasks.map((task) => [task.id, []]),
        ),
        onTaskRun: (roundId, taskId) => taskRuns.push(`${roundId}:${taskId}`),
      });

      assert.equal(result.decisions[0]?.decision, 'discard');
      assert.equal(result.decisions[0]?.reason, 'reward_hack_quarantined');
      assert.deepEqual(result.decisions[0]?.rewardHackScan, {
        decision: 'quarantine',
        reason: 'no_verifier_patterns',
      });
      assert.ok(taskRuns.every((item) => !item.startsWith('round-0:hout-')));
    });
  });

  test('skips the held-out sweep for a reward-hack quarantined held-in trajectory', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      const taskRuns: string[] = [];
      const rewardFor = (roundId: string, taskId: string): number => {
        const index = taskIndex(taskId);
        if (taskId.startsWith('hout-')) return index < 4 ? 1 : 0;
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        return 1;
      };

      const result = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 1,
        baselineRuns: 2,
        rewardHackVerifierPatternsByTaskId: {
          ...Object.fromEntries(heldInTasks.map((task) => [task.id, ['ZZZ_NO_VERIFIER_MATCH']])),
          'hin-0': ['EXPECTED_SECRET'],
        },
        runtimeEventCommandFor: (roundId, taskId) =>
          roundId === 'round-0' && taskId === 'hin-0' ? 'echo EXPECTED_SECRET' : undefined,
        onTaskRun: (roundId, taskId) => taskRuns.push(`${roundId}:${taskId}`),
      });

      assert.equal(result.decisions[0]?.decision, 'discard');
      assert.equal(result.decisions[0]?.reason, 'reward_hack_quarantined');
      assert.deepEqual(result.decisions[0]?.rewardHackScan, {
        decision: 'quarantine',
        reason: 'verifier_pattern',
        matchedPatterns: ['EXPECTED_SECRET'],
      });
      assert.ok(taskRuns.every((item) => !item.startsWith('round-0:hout-')));
    });
  });

  test('stops before the held-out sweep when the budget is hit after held-in', async () => {
    await withHarness(async (harness) => {
      const originalHead = (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: harness.repoDir })
      ).stdout.trim();
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      // Held-in jumps 0.5 -> 1.0 in round-0, so it clears the gate and held-out
      // WOULD run; held-out stays flat at 0.5.
      const rewardFor = (roundId: string, taskId: string): number => {
        const index = taskIndex(taskId);
        if (taskId.startsWith('hout-')) return index < 4 ? 1 : 0;
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        return 1;
      };

      // baseline (2 sweeps) = 2*(20+8)*0.02 = 1.12; round-0 held-in adds 20*0.02 =
      // 0.40 -> 1.52, tripping a 1.5 ceiling BETWEEN held-in and held-out.
      const result = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 2,
        baselineRuns: 2,
        costCeilingUsd: 1.5,
      });

      assert.equal(result.stopReason, 'cost_ceiling_exceeded');
      assert.equal(result.decisions.length, 0); // round-0 broke before a decision
      assert.equal(result.keptCount, 0);
      assert.ok(result.totalCostUsd >= 1.5);

      // Held-out never ran for round-0, and the candidate commit was reverted.
      const events = (await readFile(harness.resultsJsonlPath, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const candidateHeldOut = events.filter(
        (e) =>
          typeof e.roundId === 'string' &&
          e.roundId.startsWith('round-') &&
          typeof e.taskId === 'string' &&
          e.taskId.startsWith('hout-'),
      );
      assert.equal(candidateHeldOut.length, 0);
      const head = (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: harness.repoDir })
      ).stdout.trim();
      assert.equal(head, originalHead);
      assert.equal(await readFile(harness.systemPromptPath, 'utf8'), 'original prompt\n');
    });
  });

  test('aborts baseline before held-out when the budget is exhausted after held-in', async () => {
    await withHarness(async (harness) => {
      const calls: string[] = [];
      await assert.rejects(
        runLoop(harness, {
          heldInTasks: makeTasks('hin', 2),
          heldOutTasks: makeTasks('hout', 2),
          rewardFor: () => 1,
          rounds: 1,
          baselineRuns: 1,
          costCeilingUsd: 0.03,
          onTaskRun: (roundId, taskId) => calls.push(`${roundId}:${taskId}`),
        }),
        /cost_ceiling_exceeded during baseline calibration \(completed 0 of 1 sweeps\); raise the budget or lower baselineRuns/,
      );
      assert.deepEqual(calls, ['baseline-0:hin-0', 'baseline-0:hin-1']);
    });
  });

  test('refuses to run when the held-out TSV would be visible inside the agent cwd', async () => {
    await withHarness(async (harness) => {
      await assert.rejects(
        runLoop(harness, {
          heldInTasks: makeTasks('hin', 2),
          heldOutTasks: makeTasks('hout', 1),
          rewardFor: () => 1,
          rounds: 1,
          baselineRuns: 1,
          // Place the held-out TSV inside the agent cwd; the driver must auto-isolate
          // it and the candidate round must reject before exposing held-out results.
          heldOutResultsTsvPath: join(harness.agentCwdPath, 'held-out.tsv'),
        }),
        /controller-only artifacts must stay outside agent cwd/,
      );
    });
  });

  test('rejects out-of-contract numeric inputs at the public API boundary', async () => {
    await withHarness(async (harness) => {
      const base = {
        heldInTasks: makeTasks('hin', 2),
        heldOutTasks: makeTasks('hout', 1),
        rewardFor: () => 1,
        rounds: 1,
        baselineRuns: 1,
      };
      // rounds 0 is baseline-only (trivially passes the smoke); 1.5 would run two
      // rounds; a NaN ceiling/ratio never trips its guard; minStable 0 disables
      // the stable-task protection. All must fail loud, not silently degrade.
      await assert.rejects(
        runLoop(harness, { ...base, rounds: 0 }),
        /rounds must be a positive integer/,
      );
      await assert.rejects(
        runLoop(harness, { ...base, rounds: 1.5 }),
        /rounds must be a positive integer/,
      );
      await assert.rejects(
        runLoop(harness, { ...base, costCeilingUsd: NaN }),
        /costCeilingUsd must be a finite positive number/,
      );
      await assert.rejects(
        runLoop(harness, { ...base, minStableHeldInTasks: 0 }),
        /minStableHeldInTasks must be a positive integer/,
      );
      await assert.rejects(
        runLoop(harness, { ...base, maxInfraFailureRate: 1.5 }),
        /maxInfraFailureRate must be a number in \(0, 1\]/,
      );
    });
  });

  test('rejects duplicate held-in task ids at the public API boundary', async () => {
    await withHarness(async (harness) => {
      await assert.rejects(
        runLoop(harness, {
          heldInTasks: [
            { id: 'dup-task', path: '/tasks/a' },
            { id: 'dup-task', path: '/tasks/b' },
          ],
          heldOutTasks: makeTasks('hout', 1),
          rewardFor: () => {
            throw new Error('harbor must not run when task ids are invalid');
          },
          rounds: 1,
          baselineRuns: 1,
        }),
        /held-in tasks contain duplicate id\(s\): dup-task/,
      );
    });
  });

  test('rejects held-in and held-out task id overlap at the public API boundary', async () => {
    await withHarness(async (harness) => {
      await assert.rejects(
        runLoop(harness, {
          heldInTasks: [{ id: 'shared-task', path: '/tasks/train' }],
          heldOutTasks: [{ id: 'shared-task', path: '/tasks/exam' }],
          rewardFor: () => {
            throw new Error('harbor must not run when task partitions overlap');
          },
          rounds: 1,
          baselineRuns: 1,
        }),
        /held-in and held-out tasks overlap: shared-task/,
      );
    });
  });

  test('stops the loop once the cumulative cost ceiling is reached', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      const rewardFor = (_roundId: string, taskId: string): number =>
        taskIndex(taskId) < (taskId.startsWith('hout-') ? 4 : 10) ? 1 : 0;
      // baseline (2 sweeps) costs 2 * 28 * 0.02 = 1.12; round-0 adds 0.56 -> 1.68,
      // tripping a 1.5 ceiling before round-1 runs.
      const result = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 3,
        baselineRuns: 2,
        costCeilingUsd: 1.5,
      });

      assert.equal(result.stopReason, 'cost_ceiling_exceeded');
      assert.equal(result.decisions.length, 0);
      assert.ok(result.totalCostUsd >= 1.5);
    });
  });

  test('reports a cost-ceiling smoke failure when the loop stops exactly at budget', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      const rewardFor = (roundId: string, taskId: string): number => {
        const index = taskIndex(taskId);
        if (taskId.startsWith('hout-')) return index < 4 ? 1 : 0;
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        return 1;
      };

      const result = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 3,
        baselineRuns: 2,
        costCeilingUsd: 1.68,
      });

      assert.equal(result.stopReason, 'cost_ceiling_exceeded');
      assert.equal(result.decisions.length, 0);
      assert.equal(result.smoke.totalCostUsd, 1.92);
      assert.ok(result.smoke.failures.includes('cost_ceiling_exceeded'));
    });
  });

  test('drops a held-in task that never completes in baseline and calibrates on the rest', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 3);
      const heldOutTasks = makeTasks('hout', 2);
      // hin-2 never completes in any sweep; every other task always does.
      const shouldFail = (_roundId: string, taskId: string): boolean => taskId === 'hin-2';
      const rewardFor = (_roundId: string, taskId: string): number => {
        if (taskId.startsWith('hout-')) return 1;
        return taskIndex(taskId) === 0 ? 1 : 0;
      };

      const result = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        shouldFail,
        rounds: 1,
        baselineRuns: 2,
      });

      // The unstable task is dropped; the run still calibrates and finishes.
      assert.deepEqual(result.droppedHeldInTaskIds, ['hin-2']);
      assert.deepEqual(result.droppedHeldOutTaskIds, []);
      assert.equal(result.baseline.heldIn.taskCount, 2);
      assert.equal(result.stopReason, 'rounds_complete');
      assert.equal(result.decisions.length, 1);
      assert.equal(result.smoke.status, 'pass');

      // The dropped task is never swept in the candidate round: only the two
      // stable held-in tasks appear under round-0.
      const wal = await readFile(harness.resultsJsonlPath, 'utf8');
      const roundHeldInTaskIds = wal
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { roundId?: string; type?: string; taskId?: string })
        .filter(
          (event) =>
            event.roundId === 'round-0' &&
            event.type === 'task_completed' &&
            (event.taskId ?? '').startsWith('hin-'),
        )
        .map((event) => event.taskId);
      assert.deepEqual([...new Set(roundHeldInTaskIds)].sort(), ['hin-0', 'hin-1']);
    });
  });

  test('runs flaky tasks but excludes them from proposal evidence and decisions', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 3);
      const heldOutTasks = makeTasks('hout', 2);
      const roundTaskIds: string[] = [];
      let proposalInput: MetaAgentPromptInput | undefined;
      const rewardFor = (roundId: string, taskId: string): number => {
        if (taskId === 'hin-0' || taskId === 'hout-0') return 1;
        if (taskId === 'hin-2' && roundId !== 'baseline-1') return 1;
        return roundId === 'round-0' ? 1 : 0;
      };

      const result = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 1,
        baselineRuns: 3,
        onTaskRun: (roundId, taskId) => {
          if (roundId === 'round-0' && taskId.startsWith('hin-')) roundTaskIds.push(taskId);
        },
        metaAgent: async (input) => {
          proposalInput = input;
          return {
            systemPrompt: 'addressability candidate\n',
            summary: 'use only addressable evidence',
            candidateRationale: {
              editedSurface: 'system_prompt',
              evidenceRefs: evidenceRefsFor(input),
              hypothesis: 'addressable evidence supports a bounded prompt improvement',
              targetedFix: 'clarify the general success criteria',
              predictedFixes: [],
              riskTasks: [],
              ...(evidenceRefsFor(input).length === 0
                ? { failurePattern: 'coverage_regression' as const }
                : {}),
            },
          };
        },
      });

      assert.ok(proposalInput);
      assert.deepEqual(
        proposalInput.heldInDigests.map((digest) => digest.taskId),
        ['hin-0', 'hin-1'],
      );
      assert.match(proposalInput.resultsTsv, /hin-0/);
      assert.match(proposalInput.resultsTsv, /hin-1/);
      assert.doesNotMatch(proposalInput.resultsTsv, /hin-2/);
      assert.deepEqual([...new Set(roundTaskIds)].sort(), ['hin-0', 'hin-1', 'hin-2']);
      assert.equal(result.baseline.heldIn.taskCount, 2);
      assert.equal(result.baseline.heldOut.taskCount, 2);
      assert.deepEqual(
        result.addressability.heldIn.taskStats.map((stat) => ({
          taskId: stat.taskId,
          addressable: stat.addressable,
          rejectionReason: stat.rejectionReason,
        })),
        [
          { taskId: 'hin-0', addressable: true, rejectionReason: undefined },
          { taskId: 'hin-1', addressable: true, rejectionReason: undefined },
          { taskId: 'hin-2', addressable: false, rejectionReason: 'flaky' },
        ],
      );
      assert.deepEqual(result.addressability.heldOut.selectedTaskIds, ['hout-0', 'hout-1']);
      assert.deepEqual(result.droppedHeldInTaskIds, []);
    });
  });

  test('re-banks the held-in reference when a capability-limit task shrinks the decision set', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 4);
      const proposalInputs: MetaAgentPromptInput[] = [];
      const roundOneTaskIds: string[] = [];
      const propose = fakeMetaAgent();
      const rewardFor = (roundId: string, taskId: string): number => {
        if (taskId.startsWith('hout-')) return 1;
        const index = taskIndex(taskId);
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        if (roundId === 'round-0') return index < 19 ? 1 : 0;
        return 1;
      };

      const first = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 1,
        baselineRuns: 2,
        metaAgent: async (input) => {
          proposalInputs.push(input);
          return propose(input);
        },
      });
      assert.equal(first.decisions[0]?.decision, 'keep');
      assert.equal(proposalInputs.length, 1);
      assert.match(proposalInputs[0]!.resultsTsv, /hin-19/);
      assert.deepEqual(
        first.addressability.heldIn.taskStats.find((stat) => stat.taskId === 'hin-19'),
        {
          taskId: 'hin-19',
          observations: 3,
          keptPrompts: 2,
          passes: 0,
          flips: 0,
          flipRate: 0,
          addressable: false,
          rejectionReason: 'capability_limit',
        },
      );
      assert.equal(
        first.heldInReferencePassEligibleRate,
        1 -
          promptAcceptanceNoiseBand({
            sampleSize: 19,
            passRate: 10 / 19,
            baselineRunCount: 2,
            zScore: 1.96,
          }),
      );
      proposalInputs.length = 0;

      const replayedFirst = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 1,
        baselineRuns: 2,
        metaAgent: async (input) => {
          proposalInputs.push(input);
          return propose(input);
        },
      });
      assert.deepEqual(replayedFirst.addressability, first.addressability);
      assert.equal(
        replayedFirst.heldInReferencePassEligibleRate,
        first.heldInReferencePassEligibleRate,
      );
      assert.equal(proposalInputs.length, 0);

      const result = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 2,
        baselineRuns: 2,
        metaAgent: async (input) => {
          proposalInputs.push(input);
          return propose(input);
        },
        onTaskRun: (roundId, taskId) => {
          if (roundId === 'round-1' && taskId.startsWith('hin-')) roundOneTaskIds.push(taskId);
        },
      });

      assert.equal(result.decisions[0]?.decision, 'keep');
      assert.equal(result.decisions[1]?.decision, 'discard');
      assert.equal(result.decisions[1]?.reason, 'held_in_within_noise');
      assert.equal(result.decisions[1]?.metrics.lastKept.heldIn.passEligibleRate, 1);
      assert.equal(
        result.decisions[1]?.previousHeldInReferencePassEligibleRate,
        1 - result.decisions[1]!.heldInPassRateNoiseBand,
      );
      assert.equal(
        result.heldInReferencePassEligibleRate,
        result.decisions[1]?.previousHeldInReferencePassEligibleRate,
      );
      assert.equal(proposalInputs.length, 1);
      assert.doesNotMatch(proposalInputs[0]!.resultsTsv, /hin-19/);
      assert.equal(
        proposalInputs[0]!.heldInDigests.some((digest) => digest.taskId === 'hin-19'),
        false,
      );
      assert.ok(roundOneTaskIds.includes('hin-19'));
      const terminalStat = result.addressability.heldIn.taskStats.find(
        (stat) => stat.taskId === 'hin-19',
      );
      assert.equal(terminalStat?.observations, 3);
      assert.equal(terminalStat?.keptPrompts, 2);
      assert.equal(terminalStat?.passes, 0);
      assert.equal(terminalStat?.rejectionReason, 'capability_limit');

      proposalInputs.length = 0;
      const replayed = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 2,
        baselineRuns: 2,
        metaAgent: async (input) => {
          proposalInputs.push(input);
          return propose(input);
        },
      });
      assert.equal(proposalInputs.length, 0);
      assert.deepEqual(replayed.decisions, result.decisions);
      assert.equal(
        replayed.heldInReferencePassEligibleRate,
        result.heldInReferencePassEligibleRate,
      );
      assert.deepEqual(replayed.addressability, result.addressability);
    });
  });

  test('reward-hack scanning includes capability-limited tasks outside the decision set', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 4);
      const roundOneTaskIds: string[] = [];
      const rewardFor = (roundId: string, taskId: string): number => {
        if (taskId.startsWith('hout-')) return 1;
        const index = taskIndex(taskId);
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        if (roundId === 'round-0') return index < 19 ? 1 : 0;
        return 1;
      };

      const result = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 2,
        baselineRuns: 2,
        rewardHackVerifierPatternsByTaskId: {
          ...Object.fromEntries(heldInTasks.map((task) => [task.id, ['ZZZ_NO_VERIFIER_MATCH']])),
          'hin-19': ['EXPECTED_SECRET'],
        },
        runtimeEventCommandFor: (roundId, taskId) =>
          roundId === 'round-1' && taskId === 'hin-19' ? 'echo EXPECTED_SECRET' : undefined,
        onTaskRun: (roundId, taskId) => {
          if (roundId === 'round-1' && taskId.startsWith('hin-')) roundOneTaskIds.push(taskId);
        },
      });

      assert.equal(result.decisions[0]?.decision, 'keep');
      assert.equal(result.decisions[1]?.decision, 'discard');
      assert.equal(result.decisions[1]?.reason, 'reward_hack_quarantined');
      assert.deepEqual(result.decisions[1]?.rewardHackScan, {
        decision: 'quarantine',
        reason: 'verifier_pattern',
        matchedPatterns: ['EXPECTED_SECRET'],
      });
      assert.ok(roundOneTaskIds.includes('hin-19'));
      assert.equal(result.decisions[1]?.metrics.candidate.heldIn.taskCount, 19);
    });
  });

  test('re-banks again when retained evidence expands the decision set', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 4);
      const proposalInputs: MetaAgentPromptInput[] = [];
      const propose = fakeMetaAgent();
      const rewardFor = (roundId: string, taskId: string): number => {
        if (taskId.startsWith('hout-')) return 1;
        const index = taskIndex(taskId);
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        if (roundId === 'round-0') return index > 0 && index < 18 ? 1 : 0;
        return 1;
      };

      const result = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 3,
        baselineRuns: 2,
        metaAgent: async (input) => {
          proposalInputs.push(input);
          return propose(input);
        },
      });

      assert.deepEqual(
        result.decisions.map((decision) => decision.decision),
        ['keep', 'keep', 'discard'],
      );
      assert.deepEqual(
        proposalInputs.map((input) => input.heldInDigests.length),
        [20, 18, 19],
      );
      assert.equal(
        proposalInputs[1]?.heldInDigests.some((digest) => digest.taskId === 'hin-18'),
        false,
      );
      assert.equal(
        proposalInputs[1]?.heldInDigests.some((digest) => digest.taskId === 'hin-19'),
        false,
      );
      assert.equal(
        proposalInputs[2]?.heldInDigests.some((digest) => digest.taskId === 'hin-18'),
        true,
      );
      assert.equal(
        proposalInputs[2]?.heldInDigests.some((digest) => digest.taskId === 'hin-19'),
        true,
      );
      assert.equal(
        proposalInputs[2]?.heldInDigests.some((digest) => digest.taskId === 'hin-0'),
        false,
      );
      assert.equal(result.decisions[2]?.metrics.lastKept.heldIn.passEligibleRate, 1);
      assert.equal(
        result.decisions[2]?.previousHeldInReferencePassEligibleRate,
        1 - result.decisions[2]!.heldInPassRateNoiseBand,
      );
      assert.equal(result.decisions[2]?.reason, 'held_in_within_noise');
    });
  });

  test('fails loud when a terminal keep makes the whole held-out partition unaddressable', async () => {
    await withHarness(async (harness) => {
      await assert.rejects(
        runLoop(harness, {
          heldInTasks: makeTasks('hin', 20),
          heldOutTasks: makeTasks('hout', 1),
          rewardFor: (roundId, taskId) => {
            if (taskId.startsWith('hout-')) return 0;
            if (roundId.startsWith('baseline-')) return taskIndex(taskId) < 10 ? 1 : 0;
            return 1;
          },
          rounds: 1,
          baselineRuns: 2,
        }),
        /held-out addressable task count is 0 after kept-prompt history filtering/,
      );
    });
  });

  test('aborts when no held-in task completes across baseline sweeps', async () => {
    await withHarness(async (harness) => {
      await assert.rejects(
        runLoop(harness, {
          heldInTasks: makeTasks('hin', 2),
          heldOutTasks: makeTasks('hout', 1),
          rewardFor: () => 1,
          shouldFail: (_roundId, taskId) => taskId.startsWith('hin-'),
          rounds: 1,
          baselineRuns: 1,
        }),
        /held-in stable task count 0 is below the minimum 1/,
      );
    });
  });

  test('drops a held-in task slower than the duration cap from calibration and rounds', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 3);
      const heldOutTasks = makeTasks('hout', 2);
      // hin-1 is pathologically slow in baseline; the cap drops it.
      const durationMsFor = (_roundId: string, taskId: string): number =>
        taskId === 'hin-1' ? 9_000 : 10;
      const rewardFor = (_roundId: string, taskId: string): number =>
        taskId.startsWith('hout-') ? 1 : taskIndex(taskId) === 0 ? 1 : 0;

      const result = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        durationMsFor,
        maxStableTaskDurationMs: 1_000,
        rounds: 1,
        baselineRuns: 2,
      });

      assert.deepEqual(result.droppedHeldInTaskIds, ['hin-1']);
      assert.equal(result.baseline.heldIn.taskCount, 2);
      assert.equal(result.stopReason, 'rounds_complete');
      assert.equal(result.smoke.status, 'pass');
    });
  });

  test('aborts when too few held-in tasks survive the minimum-stable floor', async () => {
    await withHarness(async (harness) => {
      await assert.rejects(
        runLoop(harness, {
          heldInTasks: makeTasks('hin', 4),
          heldOutTasks: makeTasks('hout', 2),
          rewardFor: () => 1,
          // Only hin-0 survives; the floor of 3 is not met, so the run fails loud
          // rather than calibrating on an unrepresentative single task.
          shouldFail: (_roundId, taskId) => taskId.startsWith('hin-') && taskId !== 'hin-0',
          minStableHeldInTasks: 3,
          rounds: 1,
          baselineRuns: 1,
        }),
        /held-in stable task count 1 is below the minimum 3 \(4 configured, 3 dropped/,
      );
    });
  });
});
