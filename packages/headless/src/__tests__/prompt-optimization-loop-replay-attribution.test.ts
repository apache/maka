import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { readFixedPromptWal } from '../fixed-prompt-controller.js';
import { heldInTaskSetHash } from '../rsi-round-analysis.js';
import {
  execFileAsync,
  fakeMetaAgent,
  makeTasks,
  runLoop,
  taskIndex,
  withHarness,
} from './helpers/prompt-optimization-loop-harness.js';

describe('runPromptOptimizationLoop replay attribution guards', () => {
  test('fails closed when a replayed decision is missing RSI attribution evidence', async () => {
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
      const withoutAttribution = events.filter(
        (event) => !(event.type === 'rsi_controller_attribution' && event.roundId === 'round-0'),
      );
      await writeFile(
        harness.resultsJsonlPath,
        `${withoutAttribution.map((event) => JSON.stringify(event)).join('\n')}\n`,
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
        /RSI WAL replay missing post-decision RSI attribution evidence for round-0/,
      );
      assert.equal(nextRoundPrompted, false);
    });
  });

  test('fails closed when RSI attribution appears before its decision', async () => {
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
      const attributionIndex = events.findIndex(
        (event) => event.type === 'rsi_controller_attribution' && event.roundId === 'round-0',
      );
      const decisionIndex = events.findIndex(
        (event) => event.type === 'prompt_candidate_decided' && event.roundId === 'round-0',
      );
      assert.ok(attributionIndex > decisionIndex);
      const attribution = events[attributionIndex]!;
      const withoutAttribution = events.filter((_event, index) => index !== attributionIndex);
      const decisionIndexAfterRemoval = withoutAttribution.findIndex(
        (event) => event.type === 'prompt_candidate_decided' && event.roundId === 'round-0',
      );
      const attributionBeforeDecision = [
        ...withoutAttribution.slice(0, decisionIndexAfterRemoval),
        attribution,
        ...withoutAttribution.slice(decisionIndexAfterRemoval),
      ];
      await writeFile(
        harness.resultsJsonlPath,
        `${attributionBeforeDecision.map((event) => JSON.stringify(event)).join('\n')}\n`,
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
        /RSI WAL replay found RSI attribution before decision for round-0/,
      );
      assert.equal(nextRoundPrompted, false);
    });
  });

  test('fails closed when wrong-candidate RSI attribution appears before its decision', async () => {
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
      const attribution = events.find(
        (event): event is Extract<typeof event, { type: 'rsi_controller_attribution' }> =>
          event.type === 'rsi_controller_attribution' && event.roundId === 'round-0',
      );
      const decisionIndex = events.findIndex(
        (event) => event.type === 'prompt_candidate_decided' && event.roundId === 'round-0',
      );
      assert.ok(attribution);
      assert.ok(decisionIndex > -1);
      const wrongCandidateAttribution = {
        ...attribution,
        id: 'wrong-candidate-attribution',
        candidateCommitSha: 'sha1:wrong-candidate',
      };
      const attributionBeforeDecision = [
        ...events.slice(0, decisionIndex),
        wrongCandidateAttribution,
        ...events.slice(decisionIndex),
      ];
      await writeFile(
        harness.resultsJsonlPath,
        `${attributionBeforeDecision.map((event) => JSON.stringify(event)).join('\n')}\n`,
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
        /RSI WAL replay found RSI attribution before decision for round-0/,
      );
      assert.equal(nextRoundPrompted, false);
    });
  });

  test('fails closed when RSI attribution appears after the next candidate', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      const rewardFor = (roundId: string, taskId: string): number => {
        const index = taskIndex(taskId);
        if (taskId.startsWith('hout-')) return index < 4 ? 1 : 0;
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        return roundId === 'round-0' ? 1 : 0;
      };

      await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 2,
        baselineRuns: 1,
      });
      const events = await readFixedPromptWal(harness.resultsJsonlPath);
      const attributionIndex = events.findIndex(
        (event) => event.type === 'rsi_controller_attribution' && event.roundId === 'round-0',
      );
      const nextCandidateIndex = events.findIndex(
        (event) => event.type === 'prompt_candidate_committed' && event.roundId === 'round-1',
      );
      assert.ok(attributionIndex > -1);
      assert.ok(nextCandidateIndex > attributionIndex);
      const attribution = events[attributionIndex]!;
      const withoutAttribution = events.filter((_event, index) => index !== attributionIndex);
      const nextCandidateIndexAfterRemoval = withoutAttribution.findIndex(
        (event) => event.type === 'prompt_candidate_committed' && event.roundId === 'round-1',
      );
      const attributionAfterNextCandidate = [
        ...withoutAttribution.slice(0, nextCandidateIndexAfterRemoval + 1),
        attribution,
        ...withoutAttribution.slice(nextCandidateIndexAfterRemoval + 1),
      ];
      await writeFile(
        harness.resultsJsonlPath,
        `${attributionAfterNextCandidate.map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf8',
      );
      const candidateCommitCountBefore = attributionAfterNextCandidate.filter(
        (event) => event.type === 'prompt_candidate_committed',
      ).length;

      let laterRoundPrompted = false;
      await assert.rejects(
        runLoop(harness, {
          heldInTasks,
          heldOutTasks,
          rewardFor,
          rounds: 3,
          baselineRuns: 1,
          metaAgent: async (promptInput) => {
            if (promptInput.roundId === 'round-2') laterRoundPrompted = true;
            return fakeMetaAgent()(promptInput);
          },
        }),
        /RSI WAL replay missing post-decision RSI attribution evidence for round-0/,
      );
      assert.equal(laterRoundPrompted, false);
      const eventsAfterResume = await readFixedPromptWal(harness.resultsJsonlPath);
      assert.equal(
        eventsAfterResume.filter((event) => event.type === 'prompt_candidate_committed').length,
        candidateCommitCountBefore,
      );
      assert.equal(
        eventsAfterResume.some(
          (event) => event.type === 'prompt_candidate_committed' && event.roundId === 'round-2',
        ),
        false,
      );
    });
  });

  test('fails closed before prompting when replayed RSI attribution leaks held-out scope', async () => {
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
      const tamperedAttribution = events.map((event) =>
        event.type === 'rsi_controller_attribution' && event.roundId === 'round-0'
          ? { ...event, predictedFixes: [{ taskId: 'hout-0', outcome: 'improved' }] }
          : event,
      );
      await writeFile(
        harness.resultsJsonlPath,
        `${tamperedAttribution.map((event) => JSON.stringify(event)).join('\n')}\n`,
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
        /RSI WAL replay invalid RSI attribution evidence for round-0/,
      );
      assert.equal(nextRoundPrompted, false);
    });
  });

  test('fails closed before prompting when replayed RSI attribution outcome is stale', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      const rewardFor = (roundId: string, taskId: string): number => {
        const index = taskIndex(taskId);
        if (taskId.startsWith('hout-')) return index < 4 ? 1 : 0;
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        return 1;
      };
      const metaAgent = async (promptInput: Parameters<ReturnType<typeof fakeMetaAgent>>[0]) => {
        const signal = promptInput.rsiAnalysis?.signals[0];
        return {
          systemPrompt: `candidate prompt ${promptInput.roundId}\n`,
          summary: `tuned for ${promptInput.roundId}`,
          candidateRationale: {
            editedSurface: 'system_prompt' as const,
            evidenceRefs: signal ? [signal.id] : [],
            hypothesis: 'make hin-0 pass reliably',
            targetedFix: 'clarify the success criteria',
            predictedFixes: ['hin-0'],
            riskTasks: [],
            ...(!signal ? { failurePattern: 'coverage_regression' as const } : {}),
          },
        };
      };

      await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 1,
        baselineRuns: 1,
        metaAgent,
      });
      const events = await readFixedPromptWal(harness.resultsJsonlPath);
      const attribution = events.find(
        (event): event is Extract<typeof event, { type: 'rsi_controller_attribution' }> =>
          event.type === 'rsi_controller_attribution' && event.roundId === 'round-0',
      );
      assert.ok(attribution);
      assert.deepEqual(attribution.predictedFixes, [{ taskId: 'hin-0', outcome: 'unchanged' }]);
      const tamperedEvents = events.map((event) =>
        event.type === 'rsi_controller_attribution' && event.roundId === 'round-0'
          ? { ...event, predictedFixes: [{ taskId: 'hin-0', outcome: 'improved' }] }
          : event,
      );
      await writeFile(
        harness.resultsJsonlPath,
        `${tamperedEvents.map((event) => JSON.stringify(event)).join('\n')}\n`,
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
            return metaAgent(promptInput);
          },
        }),
        /RSI WAL replay attribution mismatch for round-0/,
      );
      assert.equal(nextRoundPrompted, false);
    });
  });

  test('fails closed before prompting when candidate metadata makes held-out attribution look held-in', async () => {
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
      const tamperedHeldInTaskIds = [...heldInTasks.map((task) => task.id), 'hout-0'];
      const tamperedHeldInTaskSetHash = heldInTaskSetHash(tamperedHeldInTaskIds);
      const events = await readFixedPromptWal(harness.resultsJsonlPath);
      const tamperedEvents = events.map((event) => {
        if (event.type === 'prompt_candidate_committed' && event.roundId === 'round-0') {
          return {
            ...event,
            heldInTaskIds: tamperedHeldInTaskIds,
            heldInTaskSetHash: tamperedHeldInTaskSetHash,
            candidateRationale: {
              ...event.candidateRationale,
              predictedFixes: ['hout-0'],
            },
          };
        }
        if (event.type === 'rsi_controller_attribution' && event.roundId === 'round-0') {
          return {
            ...event,
            heldInTaskSetHash: tamperedHeldInTaskSetHash,
            predictedFixes: [{ taskId: 'hout-0', outcome: 'improved' }],
          };
        }
        return event;
      });
      await writeFile(
        harness.resultsJsonlPath,
        `${tamperedEvents.map((event) => JSON.stringify(event)).join('\n')}\n`,
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
        /RSI WAL replay candidate (task-set|rationale) mismatch for round-0/,
      );
      assert.equal(nextRoundPrompted, false);
    });
  });
});
