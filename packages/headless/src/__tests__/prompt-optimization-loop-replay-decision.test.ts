import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { readFixedPromptWal } from '../fixed-prompt-controller.js';
import {
  execFileAsync,
  fakeMetaAgent,
  makeTasks,
  runLoop,
  taskIndex,
  withHarness,
} from './helpers/prompt-optimization-loop-harness.js';

describe('runPromptOptimizationLoop replay decision guards', () => {
  test('replays a decided discard round with infra-failed task evidence', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      const rewardFor = (roundId: string, taskId: string): number => {
        const index = taskIndex(taskId);
        if (taskId.startsWith('hout-')) return index < 4 ? 1 : 0;
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        return 1;
      };

      const first = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 1,
        baselineRuns: 1,
        shouldThrowInfra: (roundId, taskId) => roundId === 'round-0' && taskId === 'hin-0',
      });
      assert.equal(first.decisions[0]?.decision, 'discard');
      const events = await readFixedPromptWal(harness.resultsJsonlPath);
      assert.ok(
        events.some((event) => event.type === 'task_infra_failed' && event.roundId === 'round-0'),
      );

      const taskRuns: string[] = [];
      const resumed = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 2,
        baselineRuns: 1,
        shouldThrowInfra: (roundId, taskId) => roundId === 'round-0' && taskId === 'hin-0',
        onTaskRun: (roundId, taskId) => taskRuns.push(`${roundId}:${taskId}`),
      });

      assert.equal(resumed.decisions[0]?.decision, 'discard');
      assert.ok(taskRuns.every((item) => !item.startsWith('round-0:')));
    });
  });

  test('replays a decided round after infra failure was retried to completion', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      const rewardFor = (roundId: string, taskId: string): number => {
        const index = taskIndex(taskId);
        if (taskId.startsWith('hout-')) return index < 4 ? 1 : 0;
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        return 1;
      };

      await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 1,
        baselineRuns: 1,
        shouldThrowInfra: (roundId, taskId) => roundId === 'round-0' && taskId === 'hin-0',
      });
      const tornEvents = await readFixedPromptWal(harness.resultsJsonlPath);
      const committed = tornEvents.find(
        (event): event is Extract<typeof event, { type: 'prompt_candidate_committed' }> =>
          event.type === 'prompt_candidate_committed' && event.roundId === 'round-0',
      );
      const infraIndex = tornEvents.findIndex(
        (event) =>
          event.type === 'task_infra_failed' &&
          event.roundId === 'round-0' &&
          event.taskId === 'hin-0',
      );
      assert.ok(committed);
      assert.ok(infraIndex > -1);
      await writeFile(
        harness.resultsJsonlPath,
        `${tornEvents
          .slice(0, infraIndex + 1)
          .map((event) => JSON.stringify(event))
          .join('\n')}\n`,
        'utf8',
      );
      await execFileAsync('git', ['reset', '--hard', committed.commitSha], {
        cwd: harness.repoDir,
      });

      await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 1,
        baselineRuns: 1,
      });
      const completedEvents = await readFixedPromptWal(harness.resultsJsonlPath);
      assert.ok(
        completedEvents.some(
          (event) =>
            event.type === 'task_infra_failed' &&
            event.roundId === 'round-0' &&
            event.taskId === 'hin-0',
        ),
      );
      assert.ok(
        completedEvents.some(
          (event) =>
            event.type === 'task_completed' &&
            event.roundId === 'round-0' &&
            event.taskId === 'hin-0',
        ),
      );

      const taskRuns: string[] = [];
      const resumed = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 2,
        baselineRuns: 1,
        onTaskRun: (roundId, taskId) => taskRuns.push(`${roundId}:${taskId}`),
      });

      assert.equal(resumed.decisions[0]?.decision, 'keep');
      assert.ok(taskRuns.every((item) => !item.startsWith('round-0:')));
    });
  });

  test('fails closed when task evidence appears after its decision', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      const rewardFor = (roundId: string, taskId: string): number => {
        const index = taskIndex(taskId);
        if (taskId.startsWith('hout-')) return index < 4 ? 1 : 0;
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        return taskId.startsWith('hin-') ? 1 : index < 4 ? 1 : 0;
      };

      await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 1,
        baselineRuns: 1,
      });
      const events = await readFixedPromptWal(harness.resultsJsonlPath);
      const heldOutIndex = events.findIndex(
        (event) =>
          event.type === 'task_completed' &&
          event.roundId === 'round-0' &&
          event.taskId === 'hout-0',
      );
      const decisionIndex = events.findIndex(
        (event) => event.type === 'prompt_candidate_decided' && event.roundId === 'round-0',
      );
      assert.ok(heldOutIndex > -1);
      assert.ok(decisionIndex > heldOutIndex);
      const heldOutEvent = events[heldOutIndex]!;
      const reordered = events.filter((_event, index) => index !== heldOutIndex);
      const shiftedDecisionIndex = reordered.findIndex(
        (event) => event.type === 'prompt_candidate_decided' && event.roundId === 'round-0',
      );
      reordered.splice(shiftedDecisionIndex + 1, 0, heldOutEvent);
      await writeFile(
        harness.resultsJsonlPath,
        `${reordered.map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf8',
      );

      let nextRoundPrompted = false;
      await assert.rejects(
        runLoop(harness, {
          heldInTasks,
          heldOutTasks,
          rewardFor,
          rounds: 2,
          baselineRuns: 1,
          metaAgent: async (promptInput) => {
            if (promptInput.roundId === 'round-1') nextRoundPrompted = true;
            return fakeMetaAgent()(promptInput);
          },
        }),
        /RSI WAL replay found task evidence after decision for round-0\/hout-0/,
      );
      assert.equal(nextRoundPrompted, false);
    });
  });

  test('fails closed when sampling evidence appears after its decision', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      const rewardFor = (roundId: string, taskId: string): number => {
        const index = taskIndex(taskId);
        if (taskId.startsWith('hout-')) return index < 4 ? 1 : 0;
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        return 1;
      };

      await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 1,
        baselineRuns: 1,
      });
      const events = await readFixedPromptWal(harness.resultsJsonlPath);
      const samplingIndex = events.findIndex(
        (event) => event.type === 'task_completed' && event.roundId === 'sampling-0',
      );
      const decisionIndex = events.findIndex(
        (event) => event.type === 'prompt_candidate_decided' && event.roundId === 'round-0',
      );
      assert.ok(samplingIndex > -1);
      assert.ok(decisionIndex > samplingIndex);
      const samplingEvent = events[samplingIndex]!;
      const reordered = events.filter((_event, index) => index !== samplingIndex);
      const shiftedDecisionIndex = reordered.findIndex(
        (event) => event.type === 'prompt_candidate_decided' && event.roundId === 'round-0',
      );
      reordered.splice(shiftedDecisionIndex + 1, 0, samplingEvent);
      await writeFile(
        harness.resultsJsonlPath,
        `${reordered.map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf8',
      );

      await assert.rejects(
        runLoop(harness, {
          heldInTasks,
          heldOutTasks,
          rewardFor,
          rounds: 1,
          baselineRuns: 1,
        }),
        /RSI WAL replay missing sampling baseline evidence for round-0/,
      );
    });
  });

  test('fails closed when sampling evidence appears after the candidate commit', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      const rewardFor = (roundId: string, taskId: string): number => {
        const index = taskIndex(taskId);
        if (taskId.startsWith('hout-')) return index < 4 ? 1 : 0;
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        return 1;
      };

      await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 1,
        baselineRuns: 1,
      });
      const events = await readFixedPromptWal(harness.resultsJsonlPath);
      const samplingIndex = events.findIndex(
        (event) => event.type === 'task_completed' && event.roundId === 'sampling-0',
      );
      const candidateIndex = events.findIndex(
        (event) => event.type === 'prompt_candidate_committed' && event.roundId === 'round-0',
      );
      const decisionIndex = events.findIndex(
        (event) => event.type === 'prompt_candidate_decided' && event.roundId === 'round-0',
      );
      assert.ok(samplingIndex > -1);
      assert.ok(candidateIndex > samplingIndex);
      assert.ok(decisionIndex > candidateIndex);
      const samplingEvent = events[samplingIndex]!;
      const withoutSampling = events.filter((_event, index) => index !== samplingIndex);
      const shiftedDecisionIndex = withoutSampling.findIndex(
        (event) => event.type === 'prompt_candidate_decided' && event.roundId === 'round-0',
      );
      withoutSampling.splice(shiftedDecisionIndex, 0, samplingEvent);
      await writeFile(
        harness.resultsJsonlPath,
        `${withoutSampling.map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf8',
      );

      await assert.rejects(
        runLoop(harness, {
          heldInTasks,
          heldOutTasks,
          rewardFor,
          rounds: 1,
          baselineRuns: 1,
        }),
        /RSI WAL replay missing sampling baseline evidence for round-0/,
      );
    });
  });

  test('fails closed when a held-out regression decision is missing held-out task evidence', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      const rewardFor = (roundId: string, taskId: string): number => {
        const index = taskIndex(taskId);
        if (taskId.startsWith('hout-')) return roundId.startsWith('baseline-') && index < 4 ? 1 : 0;
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        return 1;
      };

      const first = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 1,
        baselineRuns: 1,
      });
      assert.equal(first.decisions[0]?.reason, 'held_out_regressed');
      const events = await readFixedPromptWal(harness.resultsJsonlPath);
      const missingHeldOut = events.filter(
        (event) =>
          !(
            event.type === 'task_completed' &&
            event.roundId === 'round-0' &&
            event.taskId.startsWith('hout-')
          ),
      );
      await writeFile(
        harness.resultsJsonlPath,
        `${missingHeldOut.map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf8',
      );

      let nextRoundPrompted = false;
      await assert.rejects(
        runLoop(harness, {
          heldInTasks,
          heldOutTasks,
          rewardFor,
          rounds: 2,
          baselineRuns: 1,
          metaAgent: async (promptInput) => {
            if (promptInput.roundId === 'round-1') nextRoundPrompted = true;
            return fakeMetaAgent()(promptInput);
          },
        }),
        /RSI WAL replay missing required held-out task evidence for round-0/,
      );
      assert.equal(nextRoundPrompted, false);
    });
  });

  test('fails closed when a replayed decision is missing reward-hack scan evidence', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      const rewardFor = (roundId: string, taskId: string): number => {
        const index = taskIndex(taskId);
        if (taskId.startsWith('hout-')) return index < 4 ? 1 : 0;
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        return 1;
      };

      await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 1,
        baselineRuns: 1,
      });
      const events = await readFixedPromptWal(harness.resultsJsonlPath);
      const withoutScan = events.map((event) => {
        if (event.type !== 'prompt_candidate_decided' || event.roundId !== 'round-0') return event;
        const { rewardHackScan: _rewardHackScan, ...withoutRewardHackScan } = event;
        return withoutRewardHackScan;
      });
      await writeFile(
        harness.resultsJsonlPath,
        `${withoutScan.map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf8',
      );

      let nextRoundPrompted = false;
      await assert.rejects(
        runLoop(harness, {
          heldInTasks,
          heldOutTasks,
          rewardFor,
          rounds: 2,
          baselineRuns: 1,
          metaAgent: async (promptInput) => {
            if (promptInput.roundId === 'round-1') nextRoundPrompted = true;
            return fakeMetaAgent()(promptInput);
          },
        }),
        /RSI WAL replay missing reward-hack scan evidence for round-0/,
      );
      assert.equal(nextRoundPrompted, false);
    });
  });

  test('fails closed when a replayed decision disagrees with task evidence', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      const rewardFor = (roundId: string, taskId: string): number => {
        const index = taskIndex(taskId);
        if (taskId.startsWith('hout-')) return index < 4 ? 1 : 0;
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        return 1;
      };

      await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 1,
        baselineRuns: 1,
      });
      const events = await readFixedPromptWal(harness.resultsJsonlPath);
      const tamperedDecision = events.map((event) =>
        event.type === 'prompt_candidate_decided' && event.roundId === 'round-0'
          ? { ...event, metrics: { tampered: true } }
          : event,
      );
      await writeFile(
        harness.resultsJsonlPath,
        `${tamperedDecision.map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf8',
      );

      let nextRoundPrompted = false;
      await assert.rejects(
        runLoop(harness, {
          heldInTasks,
          heldOutTasks,
          rewardFor,
          rounds: 2,
          baselineRuns: 1,
          metaAgent: async (promptInput) => {
            if (promptInput.roundId === 'round-1') nextRoundPrompted = true;
            return fakeMetaAgent()(promptInput);
          },
        }),
        /RSI WAL replay decision mismatch for round-0/,
      );
      assert.equal(nextRoundPrompted, false);
    });
  });
});
