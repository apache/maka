import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { hashSystemPrompt, readFixedPromptWal } from '../fixed-prompt-controller.js';
import {
  execFileAsync,
  fakeMetaAgent,
  makeTasks,
  runLoop,
  taskIndex,
  withHarness,
} from './helpers/prompt-optimization-loop-harness.js';

describe('runPromptOptimizationLoop replay identity guards', () => {
  test('fails closed when replayed prompt decisions belong to a different resume fingerprint', async () => {
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
        resumeFingerprint: 'fingerprint-old',
      });

      await assert.rejects(
        runLoop(harness, {
          heldInTasks,
          heldOutTasks,
          rewardFor,
          rounds: 2,
          baselineRuns: 1,
          resumeFingerprint: 'fingerprint-new',
        }),
        /RSI WAL replay identity mismatch/,
      );
    });
  });

  test('fails closed when replayed task evidence has no prompt hash', async () => {
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
      const missingHashEvents = events.map((event) => {
        if (
          event.type !== 'task_completed' ||
          event.roundId !== 'round-0' ||
          event.taskId !== 'hin-0'
        )
          return event;
        const { promptHash: _promptHash, ...withoutPromptHash } = event;
        return withoutPromptHash;
      });
      await writeFile(
        harness.resultsJsonlPath,
        `${missingHashEvents.map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf8',
      );

      await assert.rejects(
        runLoop(harness, {
          heldInTasks,
          heldOutTasks,
          rewardFor,
          rounds: 2,
          baselineRuns: 1,
        }),
        /RSI WAL replay prompt hash mismatch/,
      );
    });
  });

  test('fails closed when a candidate prompt hash disagrees with its prompt commit', async () => {
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
      const tamperedPromptHash = hashSystemPrompt('different candidate prompt\n');
      const events = await readFixedPromptWal(harness.resultsJsonlPath);
      const tamperedEvents = events.map((event) => {
        if (event.type === 'prompt_candidate_committed' && event.roundId === 'round-0') {
          return { ...event, promptHash: tamperedPromptHash };
        }
        if (event.type === 'task_completed' && event.roundId === 'round-0') {
          return { ...event, promptHash: tamperedPromptHash };
        }
        return event;
      });
      await writeFile(
        harness.resultsJsonlPath,
        `${tamperedEvents.map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf8',
      );

      await assert.rejects(
        runLoop(harness, {
          heldInTasks,
          heldOutTasks,
          rewardFor,
          rounds: 2,
          baselineRuns: 1,
        }),
        /RSI WAL replay candidate prompt hash mismatch for round-0/,
      );
    });
  });

  test('fails closed when replayed baseline task evidence has a stale prompt hash', async () => {
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
      const staleEvents = events.map((event) =>
        event.type === 'task_completed' &&
        event.roundId === 'baseline-0' &&
        event.taskId === 'hin-0'
          ? { ...event, promptHash: 'sha256:stale' }
          : event,
      );
      await writeFile(
        harness.resultsJsonlPath,
        `${staleEvents.map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf8',
      );

      await assert.rejects(
        runLoop(harness, {
          heldInTasks,
          heldOutTasks,
          rewardFor,
          rounds: 2,
          baselineRuns: 1,
        }),
        /RSI WAL replay prompt hash mismatch/,
      );
    });
  });

  test('fails closed when replayed baseline task evidence has duplicate task ids', async () => {
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
      const duplicate = events.find(
        (event) =>
          event.type === 'task_completed' &&
          event.roundId === 'baseline-0' &&
          event.taskId === 'hin-0',
      );
      assert.ok(duplicate);
      await writeFile(
        harness.resultsJsonlPath,
        `${[...events, duplicate].map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf8',
      );

      await assert.rejects(
        runLoop(harness, {
          heldInTasks,
          heldOutTasks,
          rewardFor,
          rounds: 2,
          baselineRuns: 1,
        }),
        /RSI WAL replay duplicate task event/,
      );
    });
  });

  test('fails closed when replaying task evidence without a resume fingerprint', async () => {
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
        resumeFingerprint: null,
      });

      await assert.rejects(
        runLoop(harness, {
          heldInTasks,
          heldOutTasks,
          rewardFor,
          rounds: 2,
          baselineRuns: 1,
          resumeFingerprint: null,
        }),
        /RSI WAL replay requires a resume fingerprint/,
      );
    });
  });

  test('fails closed when task source changes under the same task ids', async () => {
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
        resumeFingerprint: 'task-source-v1',
      });

      await assert.rejects(
        runLoop(harness, {
          heldInTasks: heldInTasks.map((task) => ({ ...task, path: `${task.path}-changed` })),
          heldOutTasks: heldOutTasks.map((task) => ({ ...task, path: `${task.path}-changed` })),
          rewardFor,
          rounds: 2,
          baselineRuns: 1,
          resumeFingerprint: 'task-source-v2',
        }),
        /RSI WAL replay identity mismatch/,
      );
    });
  });

  test('fails closed before baseline when the WAL already belongs to another run', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      const rewardFor = (roundId: string, taskId: string): number => {
        const index = taskIndex(taskId);
        if (taskId.startsWith('hout-')) return index < 4 ? 1 : 0;
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        return 0;
      };

      await runLoop(harness, {
        runId: 'run-old',
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 1,
        baselineRuns: 1,
      });

      const taskRuns: string[] = [];
      await assert.rejects(
        runLoop(harness, {
          runId: 'run-new',
          heldInTasks,
          heldOutTasks,
          rewardFor,
          rounds: 1,
          baselineRuns: 1,
          onTaskRun: (roundId, taskId) => taskRuns.push(`${roundId}:${taskId}`),
        }),
        /RSI WAL replay found events for a different runId/,
      );
      assert.deepEqual(taskRuns, []);
    });
  });
});
