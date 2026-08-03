import assert from 'node:assert/strict';
import fs from 'node:fs';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { RuntimeEvent } from '@maka/core';
import type { Config } from '../contracts.js';
import { buildHarborCellOutput } from '../cell-output.js';
import { tokenSummary } from './helpers/cell-output-fixtures.js';
import { contextBudgetSummary } from './helpers/ab-summary-fixtures.js';
import {
  appendFixedPromptWalEvent,
  FixedPromptBudgetExhaustedError,
  hashSystemPrompt,
  readFixedPromptWal,
  readHarborTaskRunOutput,
  runFixedPromptController,
  type FixedPromptWalEvent,
  type TaskRunInput,
  type TaskRunner,
  type TaskRunOutput,
} from '../fixed-prompt-controller.js';

const config: Config = {
  id: 'cfg-fixed',
  backend: 'fake',
  llmConnectionSlug: 'fake',
  model: 'fake-model',
};

describe('fixed prompt controller', () => {
  test('persists structured verifier attempts in the terminal WAL event', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const verifier = {
        outcome: 'passed' as const,
        attempts: [{ attempt: 1, classification: 'passed' as const, durationMs: 12, reward: 1 }],
      };
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () => harborOutput({ taskId: 'task-a', verifier }),
      });

      assert.equal(result.events[0]?.type, 'task_completed');
      if (result.events[0]?.type === 'task_completed')
        assert.deepEqual(result.events[0].harbor.verifier, verifier);
    });
  });

  test('rejects an execution identity with the wrong reasoning effort', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const maxConfig: Config = { ...config, thinkingLevel: 'max' };
      const output = harborOutput({
        taskId: 'task-a',
        executionIdentity: {
          llmConnectionSlug: 'fake',
          model: 'fake-model',
          reasoningEffort: 'high',
          systemPromptHash: hashSystemPrompt('fixed prompt\n'),
          pricingProfile: 'test-profile',
        },
      });

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config: maxConfig,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        requireExecutionIdentity: true,
        expectedPricingProfile: 'test-profile',
        taskRunner: async () => output,
      });

      assert.equal(result.events[0]?.type, 'task_plumbing_failed');
      assert.equal(result.events[0]?.errorClass, 'execution_identity_mismatch');
    });
  });

  test('rejects an execution identity with the wrong Agent tool policy', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const agentConfig: Config = { ...config, agentTools: true };
      const output = harborOutput({
        taskId: 'task-a',
        executionIdentity: {
          llmConnectionSlug: 'fake',
          model: 'fake-model',
          systemPromptHash: hashSystemPrompt('fixed prompt\n'),
          pricingProfile: 'test-profile',
          agentTools: false,
        },
      });

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config: agentConfig,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        requireExecutionIdentity: true,
        expectedPricingProfile: 'test-profile',
        taskRunner: async () => output,
      });

      assert.equal(result.events[0]?.type, 'task_plumbing_failed');
      assert.equal(result.events[0]?.errorClass, 'execution_identity_mismatch');
    });
  });

  test('rejects an execution identity missing the Agent tool policy', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const output = harborOutput({
        taskId: 'task-a',
        legacyExecutionIdentity: true,
        executionIdentity: {
          llmConnectionSlug: 'fake',
          model: 'fake-model',
          systemPromptHash: hashSystemPrompt('fixed prompt\n'),
          pricingProfile: 'test-profile',
        },
      });

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        requireExecutionIdentity: true,
        expectedPricingProfile: 'test-profile',
        taskRunner: async () => output,
      });

      assert.equal(result.events[0]?.type, 'task_plumbing_failed');
      assert.equal(result.events[0]?.errorClass, 'execution_identity_mismatch');
    });
  });

  test('resumes from completed task events in the WAL', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      await appendFile(
        resultsJsonlPath,
        `${JSON.stringify(taskCompletedEvent({ taskId: 'task-a' }))}\n`,
        'utf8',
      );

      const calls: string[] = [];
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [
          { id: 'task-a', path: '/bench/task-a' },
          { id: 'task-b', path: '/bench/task-b' },
        ],
        taskRunner: async ({ task }): Promise<TaskRunOutput> => {
          calls.push(task.id);
          return harborOutput({ taskId: task.id });
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.deepEqual(calls, ['task-b']);
      assert.deepEqual(result.taskIds, ['task-a', 'task-b']);

      const lines = (await readFile(resultsJsonlPath, 'utf8')).trimEnd().split('\n');
      assert.equal(lines.length, 2);
      assert.equal(JSON.parse(lines[1]!).taskId, 'task-b');
    });
  });

  test('reruns completed WAL events whose prompt hash is stale', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      await appendFile(
        resultsJsonlPath,
        `${JSON.stringify(taskCompletedEvent({ taskId: 'task-a', promptHash: 'sha256:stale' }))}\n`,
        'utf8',
      );

      const calls: string[] = [];
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async ({ task }) => {
          calls.push(task.id);
          return harborOutput({ taskId: task.id });
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.deepEqual(calls, ['task-a']);
      assert.equal(result.events[0]?.type, 'task_completed');
      assert.equal(result.events[0]?.promptHash, hashSystemPrompt('fixed prompt\n'));
      assert.equal((await readFile(resultsJsonlPath, 'utf8')).trimEnd().split('\n').length, 2);
    });
  });

  test('reuses WAL task events only when the resume fingerprint matches', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      await appendFile(
        resultsJsonlPath,
        `${JSON.stringify(taskCompletedEvent({ taskId: 'task-a', resumeFingerprint: 'fingerprint-old' }))}\n`,
        'utf8',
      );

      const matchingCalls: string[] = [];
      const matching = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'matching.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        resumeFingerprint: 'fingerprint-old',
        taskRunner: async ({ task }) => {
          matchingCalls.push(task.id);
          return harborOutput({ taskId: task.id });
        },
        now: () => 100,
        newId: idFactory(),
      });
      assert.deepEqual(matchingCalls, []);
      assert.equal(matching.events[0]?.type, 'task_completed');

      const changedCalls: string[] = [];
      const changed = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'changed.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        resumeFingerprint: 'fingerprint-new',
        taskRunner: async ({ task }) => {
          changedCalls.push(task.id);
          return harborOutput({ taskId: task.id });
        },
        now: () => 200,
        newId: idFactory(),
      });

      assert.deepEqual(changedCalls, ['task-a']);
      assert.equal(changed.events[0]?.type, 'task_completed');
      assert.equal(changed.events[0]?.resumeFingerprint, 'fingerprint-new');
      assert.equal((await readFile(resultsJsonlPath, 'utf8')).trimEnd().split('\n').length, 2);
    });
  });

  test('reuses budget-exhausted WAL events when the resume fingerprint matches', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results-old.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        resumeFingerprint: 'fingerprint-same',
        taskRunner: async () => {
          throw new FixedPromptBudgetExhaustedError('harbor run timed out after 600s');
        },
        now: () => 100,
        newId: idFactory(),
      });

      const calls: string[] = [];
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results-new.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        resumeFingerprint: 'fingerprint-same',
        taskRunner: async ({ task }) => {
          calls.push(task.id);
          return harborOutput({ taskId: task.id });
        },
        now: () => 200,
        newId: idFactory(),
      });

      assert.deepEqual(calls, []);
      assert.equal(result.events[0]?.type, 'task_budget_exhausted');
      assert.equal(result.events[0]?.resumeFingerprint, 'fingerprint-same');
      assert.equal((await readFile(resultsJsonlPath, 'utf8')).trimEnd().split('\n').length, 1);
    });
  });

  test('projects an unambiguous legacy timeout plumbing event as budget exhausted on resume', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const retainedContextBudgetSummary = contextBudgetSummary({ activePrunedToolResults: 1 });
      await writeFile(
        resultsJsonlPath,
        `${JSON.stringify({
          schemaVersion: 1,
          type: 'task_plumbing_failed',
          id: 'legacy-timeout',
          ts: 10,
          runId: 'run-1',
          roundId: 'round-1',
          resumeFingerprint: 'fingerprint-same',
          taskId: 'task-a',
          status: 'plumbing_failed',
          passed: false,
          scored: false,
          eligible: false,
          errorClass: 'missing_execution_identity',
          error: 'Timed-out Harbor attempt did not produce execution identity attestation',
          expectedPromptHash: hashSystemPrompt('fixed prompt\n'),
          contextBudgetPolicy: { enabled: true, minRecentTurns: 2 },
          contextBudgetSummary: retainedContextBudgetSummary,
          taskToolSummary: { todoWriteCalls: 3 },
          steps: 42,
          durationMs: 180_000,
        })}\n`,
        'utf8',
      );
      const originalWal = await readFile(resultsJsonlPath, 'utf8');
      const projectedWal = await readFixedPromptWal(resultsJsonlPath);
      assert.equal(projectedWal[0]?.type, 'task_budget_exhausted');
      let calls = 0;

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        resumeFingerprint: 'fingerprint-same',
        requireExecutionIdentity: true,
        taskRunner: async () => {
          calls += 1;
          return harborOutput({ taskId: 'task-a' });
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(calls, 0);
      const event = result.events[0];
      assert.equal(event?.type, 'task_budget_exhausted');
      if (event?.type !== 'task_budget_exhausted') assert.fail('expected budget exhaustion event');
      assert.equal(event.eligible, false);
      assert.equal(event.evidenceErrorClass, 'missing_execution_identity');
      assert.deepEqual(event.contextBudgetSummary, retainedContextBudgetSummary);
      assert.equal(event.taskToolSummary?.todoWriteCalls, 3);
      assert.equal(event.steps, 42);
      assert.equal(event.durationMs, 180_000);
      assert.equal(await readFile(resultsJsonlPath, 'utf8'), originalWal);
    });
  });

  test('ignores a torn final WAL line when resuming', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      await appendFile(
        resultsJsonlPath,
        `${JSON.stringify(taskCompletedEvent({ taskId: 'task-a' }))}\n{"schemaVersion":`,
        'utf8',
      );

      const calls: string[] = [];
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [
          { id: 'task-a', path: '/bench/task-a' },
          { id: 'task-b', path: '/bench/task-b' },
        ],
        taskRunner: async ({ task }) => {
          calls.push(task.id);
          return harborOutput({ taskId: task.id });
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.deepEqual(calls, ['task-b']);
      assert.deepEqual(result.taskIds, ['task-a', 'task-b']);

      const secondCalls: string[] = [];
      const second = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [
          { id: 'task-a', path: '/bench/task-a' },
          { id: 'task-b', path: '/bench/task-b' },
        ],
        taskRunner: async ({ task }) => {
          secondCalls.push(task.id);
          return harborOutput({ taskId: task.id });
        },
        now: () => 101,
        newId: idFactory(),
      });

      assert.deepEqual(secondCalls, []);
      assert.deepEqual(second.taskIds, ['task-a', 'task-b']);
    });
  });

  test('serializes concurrent WAL repair and append without losing events', async () => {
    await withDir(async (dir) => {
      const resultsJsonlPath = join(dir, 'results.jsonl');
      const retained = taskCompletedEvent({ taskId: 'retained' });
      await writeFile(resultsJsonlPath, `${JSON.stringify(retained)}\n{"torn"`, 'utf8');
      const appended = [
        taskCompletedEvent({ taskId: 'task-a' }),
        taskCompletedEvent({ taskId: 'task-b' }),
      ];
      const originalTruncate = fs.promises.truncate;
      const originalAppendFile = fs.promises.appendFile;
      let truncateCalls = 0;
      let firstAppendDone!: () => void;
      const firstAppend = new Promise<void>((resolve) => {
        firstAppendDone = resolve;
      });
      fs.promises.truncate = async (...args) => {
        truncateCalls += 1;
        if (truncateCalls === 2) await firstAppend;
        return originalTruncate(...args);
      };
      fs.promises.appendFile = async (...args) => {
        const result = await originalAppendFile(...args);
        firstAppendDone();
        return result;
      };
      syncBuiltinESMExports();

      try {
        await Promise.all(
          appended.map((event) => appendFixedPromptWalEvent(resultsJsonlPath, event)),
        );
      } finally {
        fs.promises.truncate = originalTruncate;
        fs.promises.appendFile = originalAppendFile;
        syncBuiltinESMExports();
      }

      const events = await readFixedPromptWal(resultsJsonlPath);
      assert.equal(events.length, appended.length + 1);
      const taskIds = events.flatMap((event) => ('taskId' in event ? [event.taskId] : []));
      assert.deepEqual(new Set(taskIds), new Set(['retained', 'task-a', 'task-b']));
    });
  });

  test('retries infra-failed WAL events on resume', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      await appendFile(
        resultsJsonlPath,
        `${JSON.stringify(taskInfraFailedEvent({ taskId: 'task-a' }))}\n`,
        'utf8',
      );

      const calls: string[] = [];
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async ({ task }) => {
          calls.push(task.id);
          return harborOutput({ taskId: task.id });
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.deepEqual(calls, ['task-a']);
      assert.equal(result.events[0]?.type, 'task_completed');
    });
  });

  test('derives results TSV from replayed task events', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      await appendFile(
        resultsJsonlPath,
        `${JSON.stringify(taskCompletedEvent({ taskId: 'task-a' }))}\n`,
        'utf8',
      );

      await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath,
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () => harborOutput({ taskId: 'unused' }),
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(
        await readFile(resultsTsvPath, 'utf8'),
        [
          'task_id\tstatus\tpassed\tscored\teligible\terror_class\tprompt_hash\ttokens\tcost_usd\truntime_events_path',
          `task-a\tcompleted\ttrue\ttrue\ttrue\t\t${hashSystemPrompt('fixed prompt\n')}\t5\t0.01\t/logs/task-a/runtime-events.jsonl`,
          '',
        ].join('\n'),
      );
    });
  });

  test('records Harbor runner failures as infra events', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () => {
          throw Object.assign(new Error('container crashed before result.json'), {
            artifactRefs: { providerTelemetryPath: '/logs/task-a/provider-request-telemetry.json' },
          });
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.events[0]?.type, 'task_infra_failed');
      assert.equal(result.events[0]?.taskId, 'task-a');
      assert.equal(result.events[0]?.eligible, false);
      assert.equal(result.events[0]?.scored, false);
      assert.equal(result.events[0]?.errorClass, 'infra_error');
      assert.equal(
        result.events[0]?.type === 'task_infra_failed'
          ? result.events[0].providerTelemetryPath
          : undefined,
        '/logs/task-a/provider-request-telemetry.json',
      );
      assert.match(await readFile(resultsJsonlPath, 'utf8'), /"type":"task_infra_failed"/);
    });
  });

  test('persists attempt admission before invoking Harbor', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        protectPassAtOne: true,
        taskRunner: async ({ task }) => {
          const wal = await readFile(`${resultsJsonlPath}.attempts.jsonl`, 'utf8');
          assert.match(wal, /"type":"task_attempt_started"/);
          assert.doesNotMatch(wal, /"type":"task_completed"/);
          return harborOutput({ taskId: task.id });
        },
        now: () => 100,
        newId: idFactory(),
      });

      const types = (await readFile(`${resultsJsonlPath}.attempts.jsonl`, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { type: string }).type);
      assert.deepEqual(types, ['task_attempt_started']);
    });
  });

  test('fails loud when durable Pass@1 admission cannot be persisted', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const originalAppendFile = fs.promises.appendFile;
      fs.promises.appendFile = async (...args) => {
        if (String(args[0]).endsWith('.attempts.jsonl')) {
          throw new Error('attempt WAL unavailable');
        }
        return originalAppendFile(...args);
      };
      syncBuiltinESMExports();
      let harborCalls = 0;

      try {
        await assert.rejects(
          runFixedPromptController({
            runId: 'run-1',
            roundId: 'round-1',
            config,
            systemPromptPath,
            resultsJsonlPath,
            tasks: [{ id: 'task-a', path: '/bench/task-a' }],
            infraFailurePolicy: 'terminal',
            protectPassAtOne: true,
            taskRunner: async ({ task }) => {
              harborCalls += 1;
              return harborOutput({ taskId: task.id });
            },
            now: () => 100,
            newId: idFactory(),
          }),
          /attempt WAL unavailable/,
        );
      } finally {
        fs.promises.appendFile = originalAppendFile;
        syncBuiltinESMExports();
      }

      assert.equal(harborCalls, 0);
      await assert.rejects(readFile(resultsJsonlPath, 'utf8'), { code: 'ENOENT' });
    });
  });

  test('protectPassAtOne never retries a full Harbor attempt after runner failure', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      let harborCalls = 0;

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        protectPassAtOne: true,
        taskRunner: async () => {
          harborCalls += 1;
          throw new Error('result collection failed after candidate sampling');
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(harborCalls, 1);
      assert.equal(result.events[0]?.type, 'task_infra_failed');
    });
  });

  test('fails loud instead of resampling an orphaned admitted attempt', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      await appendFixedPromptWalEvent(`${resultsJsonlPath}.attempts.jsonl`, {
        schemaVersion: 1,
        type: 'task_attempt_started',
        id: 'attempt-1',
        ts: 1,
        runId: 'run-1',
        roundId: 'round-1',
        taskId: 'task-a',
        promptHash: hashSystemPrompt('fixed prompt\n'),
      });
      let harborCalls = 0;

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        infraFailurePolicy: 'terminal',
        protectPassAtOne: true,
        taskRunner: async ({ task }) => {
          harborCalls += 1;
          return harborOutput({ taskId: task.id });
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(harborCalls, 0);
      assert.equal(result.events[0]?.type, 'task_plumbing_failed');
      assert.equal(result.events[0]?.errorClass, 'orphaned_sampled_attempt');
    });
  });

  test('fails closed after an orphaned durable admission even when no identity was observed', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      await appendFixedPromptWalEvent(`${resultsJsonlPath}.attempts.jsonl`, {
        schemaVersion: 1,
        type: 'task_attempt_started',
        id: 'attempt-1',
        ts: 1,
        runId: 'run-1',
        roundId: 'round-1',
        taskId: 'task-a',
        promptHash: hashSystemPrompt('fixed prompt\n'),
      });
      let harborCalls = 0;
      const taskRunner: TaskRunner = async ({ task }: TaskRunInput) => {
        harborCalls += 1;
        return harborOutput({ taskId: task.id });
      };

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        infraFailurePolicy: 'terminal',
        protectPassAtOne: true,
        taskRunner,
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(harborCalls, 0);
      assert.equal(result.events[0]?.type, 'task_plumbing_failed');
      assert.equal(result.events[0]?.errorClass, 'orphaned_sampled_attempt');
    });
  });

  test('keeps a terminal infrastructure failure closed after durable pass-at-one admission', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      await appendFixedPromptWalEvent(resultsJsonlPath, {
        schemaVersion: 1,
        type: 'task_infra_failed',
        id: 'infra-1',
        ts: 2,
        runId: 'run-1',
        roundId: 'round-1',
        taskId: 'task-a',
        status: 'infra_failed',
        passed: false,
        scored: false,
        eligible: false,
        errorClass: 'infra_error',
        error: 'Harbor failed before the agent started',
      });
      let harborCalls = 0;
      const taskRunner: TaskRunner = async ({ task }: TaskRunInput) => {
        harborCalls += 1;
        return harborOutput({ taskId: task.id });
      };

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        infraFailurePolicy: 'terminal',
        protectPassAtOne: true,
        taskRunner,
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(harborCalls, 0);
      assert.equal(result.events[0]?.type, 'task_infra_failed');
    });
  });

  test('permits one explicitly adjudicated infra retry without allowing a third attempt', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      await appendFixedPromptWalEvent(`${resultsJsonlPath}.attempts.jsonl`, {
        schemaVersion: 1,
        type: 'task_attempt_started',
        id: 'attempt-1',
        ts: 1,
        runId: 'run-1',
        roundId: 'round-1',
        taskId: 'task-a',
        promptHash: hashSystemPrompt('fixed prompt\n'),
      });
      await appendFixedPromptWalEvent(resultsJsonlPath, {
        schemaVersion: 1,
        type: 'task_infra_failed',
        id: 'infra-1',
        ts: 2,
        runId: 'run-1',
        roundId: 'round-1',
        taskId: 'task-a',
        status: 'infra_failed',
        passed: false,
        scored: false,
        eligible: false,
        errorClass: 'infra_error',
        error: 'adjudicated pre-execution failure',
      });
      let harborCalls = 0;
      const input = {
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        infraFailurePolicy: 'terminal' as const,
        protectPassAtOne: true,
        retryAdjudicatedInfraTaskIdsOnce: ['task-a'],
        taskRunner: async () => {
          harborCalls += 1;
          throw new Error('provider failed before the agent started again');
        },
        now: () => 100,
        newId: idFactory(),
      };

      const retried = await runFixedPromptController(input);
      assert.equal(harborCalls, 1);
      assert.equal(retried.events.at(-1)?.type, 'task_infra_failed');

      await runFixedPromptController(input);
      assert.equal(harborCalls, 1);
      assert.equal(
        (await readFile(`${resultsJsonlPath}.attempts.jsonl`, 'utf8')).trim().split('\n').length,
        2,
      );
    });
  });

  test('retries a thrown infra error once and records the successful retry', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      let attempts = 0;
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async ({ task }) => {
          attempts += 1;
          if (attempts === 1) throw new Error('transient container build hiccup');
          return harborOutput({ taskId: task.id });
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(attempts, 2); // failed once, retried once
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0]?.type, 'task_completed');
      const wal = await readFile(resultsJsonlPath, 'utf8');
      assert.match(wal, /"type":"task_completed"/);
      assert.doesNotMatch(wal, /"type":"task_infra_failed"/);
    });
  });

  test('records task_infra_failed only after the retry also throws', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      let attempts = 0;
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () => {
          attempts += 1;
          throw new Error('container crashed both times');
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(attempts, 2);
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0]?.type, 'task_infra_failed');
    });
  });

  test('records task_budget_exhausted without retrying budget errors', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      let attempts = 0;
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () => {
          attempts += 1;
          throw new FixedPromptBudgetExhaustedError('harbor run timed out after 600s');
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(attempts, 1);
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0]?.type, 'task_budget_exhausted');
      assert.equal(result.events[0]?.eligible, true);
      assert.equal(result.events[0]?.passed, false);
      assert.equal(result.events[0]?.expectedPromptHash, hashSystemPrompt('fixed prompt\n'));
      if (result.events[0]?.type !== 'task_budget_exhausted')
        assert.fail('expected budget exhaustion event');
      assert.equal(
        result.events[0].runtimeEventsUnavailableReason,
        'budget_exhausted_before_cell_output',
      );
      assert.match(await readFile(resultsJsonlPath, 'utf8'), /"type":"task_budget_exhausted"/);
    });
  });

  test('keeps an unattested timeout ineligible for A/B attribution', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        requireExecutionIdentity: true,
        expectedPricingProfile: 'test-profile',
        taskRunner: async () => {
          throw new FixedPromptBudgetExhaustedError('timed out before cell output');
        },
        now: () => 100,
        newId: idFactory(),
      });

      const event = result.events[0];
      assert.equal(event?.type, 'task_budget_exhausted');
      if (event?.type !== 'task_budget_exhausted') assert.fail('expected budget exhaustion event');
      assert.equal(event.status, 'budget_exhausted');
      assert.equal(event.eligible, false);
      assert.equal(event.evidenceErrorClass, 'missing_execution_identity');
      assert.equal('tokenSummary' in result.events[0]!, false);
    });
  });

  test('accounts for token cost retained by a timed-out cell', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const retainedUsage = tokenSummary({
        input: 100,
        output: 20,
        reasoning: 0,
        total: 120,
        costUsd: 0.42,
      });

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () => {
          throw new FixedPromptBudgetExhaustedError('agent timed out', undefined, {
            tokenSummary: retainedUsage,
          });
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.totalTokens, 120);
      assert.equal(result.totalCostUsd, 0.42);
      assert.equal(result.events[0]?.type, 'task_budget_exhausted');
      assert.deepEqual(
        'tokenSummary' in result.events[0]! ? result.events[0].tokenSummary : undefined,
        retainedUsage,
      );
      assert.equal(
        'tokenSummarySource' in result.events[0]! ? result.events[0].tokenSummarySource : undefined,
        'checkpoint',
      );
    });
  });

  test('keeps an identity-mismatched timeout as an ineligible budget exhaustion', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const cell = harborOutput({
        taskId: 'task-a',
        errorClass: 'network',
        executionIdentity: {
          llmConnectionSlug: 'deepseek',
          model: 'wrong-model',
          systemPromptHash: hashSystemPrompt('fixed prompt\n'),
          pricingProfile: 'test-profile',
        },
      }).cell;
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        requireExecutionIdentity: true,
        expectedPricingProfile: 'test-profile',
        taskRunner: async () => {
          throw new FixedPromptBudgetExhaustedError('agent timed out', undefined, {
            cellOutput: cell,
          });
        },
        now: () => 100,
        newId: idFactory(),
      });

      const event = result.events[0];
      assert.equal(event?.type, 'task_budget_exhausted');
      if (event?.type !== 'task_budget_exhausted') assert.fail('expected budget exhaustion event');
      assert.equal(event.status, 'budget_exhausted');
      assert.equal(event.eligible, false);
      assert.equal(event.evidenceErrorClass, 'execution_identity_mismatch');
    });
  });

  test('keeps an identity-verified timeout eligible as a budget exhaustion', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const retainedContextBudgetSummary = contextBudgetSummary({ prunedToolResults: 2 });
      const cell = harborOutput({
        taskId: 'task-a',
        contextBudgetPolicy: { enabled: true, minRecentTurns: 2 },
        contextBudgetSummary: retainedContextBudgetSummary,
        executionIdentity: {
          llmConnectionSlug: 'fake',
          model: 'fake-model',
          systemPromptHash: hashSystemPrompt('fixed prompt\n'),
          pricingProfile: 'test-profile',
        },
      }).cell;
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        requireExecutionIdentity: true,
        expectedPricingProfile: 'test-profile',
        taskRunner: async () => {
          throw new FixedPromptBudgetExhaustedError('agent timed out', undefined, {
            cellOutput: cell,
          });
        },
        now: () => 100,
        newId: idFactory(),
      });

      const event = result.events[0];
      assert.equal(event?.type, 'task_budget_exhausted');
      if (event?.type !== 'task_budget_exhausted') assert.fail('expected budget exhaustion event');
      assert.equal(event.status, 'budget_exhausted');
      assert.equal(event.eligible, true);
      assert.equal(event.evidenceErrorClass, undefined);
      assert.equal(event.tokenSummary?.total, 3);
      assert.equal(event.tokenSummary?.costUsd, 0.02);
      assert.equal(event.tokenSummarySource, 'final');
      assert.equal(event.runtimeEventsPath, cell.runtimeEventsPath);
      assert.equal(event.traceEventsPath, cell.traceEventsPath);
      assert.equal(event.providerTelemetryPath, '/logs/task-a/provider-request-telemetry.json');
      assert.deepEqual(
        'contextBudgetSummary' in event ? event.contextBudgetSummary : undefined,
        retainedContextBudgetSummary,
      );
      assert.equal(result.totalTokens, 3);
      assert.equal(result.totalCostUsd, 0.02);
    });
  });

  test('keeps an early-attested timeout eligible without claiming complete usage', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const executionIdentity = {
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        systemPromptHash: hashSystemPrompt('fixed prompt\n'),
        pricingProfile: 'test-profile',
        agentTools: false,
      };
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        requireExecutionIdentity: true,
        expectedPricingProfile: 'test-profile',
        taskRunner: async () => {
          throw new FixedPromptBudgetExhaustedError('agent timed out', undefined, {
            executionIdentity,
          });
        },
        now: () => 100,
        newId: idFactory(),
      });

      const event = result.events[0];
      assert.equal(event?.type, 'task_budget_exhausted');
      if (event?.type !== 'task_budget_exhausted') assert.fail('expected budget exhaustion event');
      assert.equal(event.eligible, true);
      assert.equal(event.evidenceErrorClass, undefined);
      assert.equal(event.tokenSummary, undefined);
      assert.deepEqual(
        (event as { executionIdentity?: typeof executionIdentity }).executionIdentity,
        executionIdentity,
      );
    });
  });

  test('keeps a provider-error timeout ineligible and stops the controller', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const cell = harborOutput({
        taskId: 'task-a',
        status: 'failed',
        errorClass: 'auth',
        executionIdentity: {
          llmConnectionSlug: 'fake',
          model: 'fake-model',
          systemPromptHash: hashSystemPrompt('fixed prompt\n'),
          pricingProfile: 'test-profile',
        },
      }).cell;
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        requireExecutionIdentity: true,
        expectedPricingProfile: 'test-profile',
        taskRunner: async () => {
          throw new FixedPromptBudgetExhaustedError('agent timed out', undefined, {
            cellOutput: cell,
          });
        },
        now: () => 100,
        newId: idFactory(),
      });

      const event = result.events[0];
      assert.equal(event?.type, 'task_budget_exhausted');
      if (event?.type !== 'task_budget_exhausted') assert.fail('expected budget exhaustion event');
      assert.equal(event.eligible, false);
      assert.equal(event.evidenceErrorClass, 'auth');
      assert.equal(result.stopReason, 'systemic_provider_failure');
    });
  });

  for (const errorClass of ['infra_failed', 'setup_failed', 'verification_error'] as const) {
    test(`keeps a timeout with ${errorClass} evidence ineligible`, async () => {
      await withDir(async (dir) => {
        const systemPromptPath = join(dir, 'system_prompt.md');
        await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
        const cell = harborOutput({
          taskId: 'task-a',
          status: 'failed',
          errorClass,
          executionIdentity: {
            llmConnectionSlug: 'fake',
            model: 'fake-model',
            systemPromptHash: hashSystemPrompt('fixed prompt\n'),
            pricingProfile: 'test-profile',
          },
        }).cell;
        const result = await runFixedPromptController({
          runId: 'run-1',
          roundId: 'round-1',
          config,
          systemPromptPath,
          resultsJsonlPath: join(dir, 'results.jsonl'),
          resultsTsvPath: join(dir, 'results.tsv'),
          tasks: [{ id: 'task-a', path: '/bench/task-a' }],
          requireExecutionIdentity: true,
          expectedPricingProfile: 'test-profile',
          taskRunner: async () => {
            throw new FixedPromptBudgetExhaustedError('agent timed out', undefined, {
              cellOutput: cell,
            });
          },
          now: () => 100,
          newId: idFactory(),
        });

        const event = result.events[0];
        assert.equal(event?.type, 'task_budget_exhausted');
        if (event?.type !== 'task_budget_exhausted')
          assert.fail('expected budget exhaustion event');
        assert.equal(event.eligible, false);
        assert.equal(event.evidenceErrorClass, errorClass);
      });
    });
  }

  test('keeps a timeout with rate-limit evidence ineligible', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const cell = harborOutput({
        taskId: 'task-a',
        status: 'failed',
        errorClass: 'rate_limit',
        executionIdentity: {
          llmConnectionSlug: 'fake',
          model: 'fake-model',
          systemPromptHash: hashSystemPrompt('fixed prompt\n'),
          pricingProfile: 'test-profile',
        },
      }).cell;
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        requireExecutionIdentity: true,
        expectedPricingProfile: 'test-profile',
        taskRunner: async () => {
          throw new FixedPromptBudgetExhaustedError('agent timed out', undefined, {
            cellOutput: cell,
          });
        },
        now: () => 100,
        newId: idFactory(),
      });

      const event = result.events[0];
      assert.equal(event?.type, 'task_budget_exhausted');
      if (event?.type !== 'task_budget_exhausted') assert.fail('expected budget exhaustion event');
      assert.equal(event.eligible, false);
      assert.equal((event as { evidenceErrorClass?: string }).evidenceErrorClass, 'rate_limit');
    });
  });

  test('reruns budget-exhausted WAL events instead of reusing a timeout', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results-old.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () => {
          throw new FixedPromptBudgetExhaustedError('harbor run timed out after 600s');
        },
        now: () => 100,
        newId: idFactory(),
      });

      const calls: string[] = [];
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results-new.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async ({ task }) => {
          calls.push(task.id);
          return harborOutput({ taskId: task.id });
        },
        now: () => 200,
        newId: idFactory(),
      });

      assert.deepEqual(calls, ['task-a']);
      assert.equal(result.events[0]?.type, 'task_completed');
      assert.equal(result.events[0]?.promptHash, hashSystemPrompt('fixed prompt\n'));
      assert.equal((await readFile(resultsJsonlPath, 'utf8')).trimEnd().split('\n').length, 2);
    });
  });

  test('stops when infra failures exceed the configured rate', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const calls: string[] = [];
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [
          { id: 'task-a', path: '/bench/task-a' },
          { id: 'task-b', path: '/bench/task-b' },
          { id: 'task-c', path: '/bench/task-c' },
          { id: 'task-d', path: '/bench/task-d' },
          { id: 'task-e', path: '/bench/task-e' },
        ],
        maxInfraFailureRate: 0.2,
        taskRunner: async ({ task }) => {
          calls.push(task.id);
          throw new Error(`container crashed for ${task.id}`);
        },
        now: () => 100,
        newId: idFactory(),
      });

      // Each failing task is retried once before being recorded, so it is
      // attempted twice; we still stop after task-b and never reach c/d/e.
      assert.deepEqual([...new Set(calls)], ['task-a', 'task-b']);
      assert.equal(result.stopReason, 'infra_failure_rate_exceeded');
      assert.deepEqual(result.taskIds, ['task-a', 'task-b']);
      assert.equal((await readFile(resultsJsonlPath, 'utf8')).trimEnd().split('\n').length, 2);
    });
  });

  test('checks infra failure rate between rolling concurrency waves', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      let inFlight = 0;
      let maxInFlight = 0;
      const calls: string[] = [];
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [
          { id: 'task-a', path: '/bench/task-a' },
          { id: 'task-b', path: '/bench/task-b' },
          { id: 'task-c', path: '/bench/task-c' },
          { id: 'task-d', path: '/bench/task-d' },
          { id: 'task-e', path: '/bench/task-e' },
        ],
        maxConcurrency: 3,
        maxInfraFailureRate: 0.2,
        taskRunner: async ({ task }) => {
          calls.push(task.id);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await delay(1);
          inFlight -= 1;
          throw new Error(`container crashed for ${task.id}`);
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(maxInFlight, 3);
      assert.deepEqual([...new Set(calls)], ['task-a', 'task-b', 'task-c', 'task-d']);
      assert.equal(result.stopReason, 'infra_failure_rate_exceeded');
      assert.deepEqual(result.taskIds, ['task-a', 'task-b', 'task-c', 'task-d']);
    });
  });

  test('rejects out-of-contract guard knobs instead of silently disabling them', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const base = {
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () => {
          throw new Error('should not run');
        },
        now: () => 100,
        newId: idFactory(),
      };
      await assert.rejects(
        runFixedPromptController({ ...base, maxConcurrency: 1.5 }),
        /maxConcurrency must be a positive integer/,
      );
      // Caught even when a stop guard would force the effective concurrency to 1.
      await assert.rejects(
        runFixedPromptController({ ...base, maxConcurrency: 1.5, costCeilingUsd: 10 }),
        /maxConcurrency must be a positive integer/,
      );
      await assert.rejects(
        runFixedPromptController({ ...base, costCeilingUsd: NaN }),
        /costCeilingUsd must be a finite positive number/,
      );
      await assert.rejects(
        runFixedPromptController({ ...base, maxInfraFailureRate: 0 }),
        /maxInfraFailureRate must be a number in \(0, 1\]/,
      );
      await assert.rejects(
        runFixedPromptController({
          ...base,
          protectPassAtOne: true,
          infraFailurePolicy: 'retry-once',
        }),
        /protectPassAtOne is incompatible with infraFailurePolicy retry-once/,
      );
    });
  });

  test('rejects duplicate task ids before running Harbor', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const calls: string[] = [];

      await assert.rejects(
        runFixedPromptController({
          runId: 'run-1',
          roundId: 'round-1',
          config,
          systemPromptPath,
          resultsJsonlPath: join(dir, 'results.jsonl'),
          resultsTsvPath: join(dir, 'results.tsv'),
          tasks: [
            { id: 'task-a', path: '/bench/task-a' },
            { id: 'task-a', path: '/bench/task-a-copy' },
          ],
          taskRunner: async ({ task }) => {
            calls.push(task.id);
            return harborOutput({ taskId: task.id });
          },
          now: () => 100,
          newId: idFactory(),
        }),
        /tasks contain duplicate id\(s\): task-a/,
      );
      assert.deepEqual(calls, []);
    });
  });

  test('preserves infra stop after WAL resume', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      await appendFile(
        resultsJsonlPath,
        `${JSON.stringify(taskInfraFailedEvent({ taskId: 'task-a' }))}\n`,
        'utf8',
      );
      await appendFile(
        resultsJsonlPath,
        `${JSON.stringify(taskInfraFailedEvent({ taskId: 'task-b' }))}\n`,
        'utf8',
      );

      const calls: string[] = [];
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [
          { id: 'task-a', path: '/bench/task-a' },
          { id: 'task-b', path: '/bench/task-b' },
          { id: 'task-c', path: '/bench/task-c' },
          { id: 'task-d', path: '/bench/task-d' },
          { id: 'task-e', path: '/bench/task-e' },
        ],
        maxInfraFailureRate: 0.2,
        taskRunner: async ({ task }) => {
          calls.push(task.id);
          return harborOutput({ taskId: task.id });
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.deepEqual(calls, []);
      assert.equal(result.stopReason, 'infra_failure_rate_exceeded');
      assert.deepEqual(result.taskIds, ['task-a', 'task-b']);
    });
  });

  test('stops immediately and leaves provider billing failures unscored', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const calls: string[] = [];

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [
          { id: 'task-a', path: '/bench/task-a' },
          { id: 'task-b', path: '/bench/task-b' },
        ],
        maxConcurrency: 1,
        taskRunner: async ({ task }) => {
          calls.push(task.id);
          return harborOutput({
            taskId: task.id,
            reward: 0,
            status: 'failed',
            errorClass: 'provider_billing',
            omitTokenSummary: true,
            steps: 0,
            verifier: {
              outcome: 'failed',
              attempts: [{ attempt: 1, classification: 'failed', durationMs: 20, reward: 0 }],
            },
          });
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.deepEqual(calls, ['task-a']);
      assert.equal(String(result.stopReason), 'systemic_provider_failure');
      assert.equal(result.events[0]?.type, 'task_infra_failed');
      assert.equal(String(result.events[0]?.errorClass), 'provider_billing');
      assert.equal(result.events[0]?.scored, false);
    });
  });

  test('stops immediately on a pre-execution authentication failure', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const calls: string[] = [];

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        tasks: [
          { id: 'task-a', path: '/bench/task-a' },
          { id: 'task-b', path: '/bench/task-b' },
        ],
        maxConcurrency: 1,
        taskRunner: async ({ task }) => {
          calls.push(task.id);
          return harborOutput({
            taskId: task.id,
            reward: 0,
            status: 'failed',
            errorClass: 'auth',
            omitTokenSummary: true,
            steps: 0,
            verifier: {
              outcome: 'failed',
              attempts: [{ attempt: 1, classification: 'failed', durationMs: 20, reward: 0 }],
            },
          });
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.deepEqual(calls, ['task-a']);
      assert.equal(result.stopReason, 'systemic_provider_failure');
      assert.equal(result.events[0]?.type, 'task_infra_failed');
      assert.equal(result.events[0]?.errorClass, 'auth');
      assert.equal(result.events[0]?.scored, false);
    });
  });

  test('stops when cost exceeds the configured ceiling', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const calls: string[] = [];
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [
          { id: 'task-a', path: '/bench/task-a' },
          { id: 'task-b', path: '/bench/task-b' },
          { id: 'task-c', path: '/bench/task-c' },
        ],
        costCeilingUsd: 0.03,
        taskRunner: async ({ task }) => {
          calls.push(task.id);
          return harborOutput({
            taskId: task.id,
            tokenSummary: tokenSummary({
              input: 1,
              output: 2,
              reasoning: 0,
              total: 3,
              costUsd: 0.02,
            }),
          });
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.deepEqual(calls, ['task-a', 'task-b']);
      assert.equal(result.stopReason, 'cost_ceiling_exceeded');
      assert.equal(result.totalCostUsd, 0.04);
      assert.deepEqual(result.taskIds, ['task-a', 'task-b']);
    });
  });

  test('checks the cost ceiling between rolling concurrency waves', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      let inFlight = 0;
      let maxInFlight = 0;
      const calls: string[] = [];
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [
          { id: 'task-a', path: '/bench/task-a' },
          { id: 'task-b', path: '/bench/task-b' },
          { id: 'task-c', path: '/bench/task-c' },
        ],
        maxConcurrency: 3,
        costCeilingUsd: 0.03,
        taskRunner: async ({ task }) => {
          calls.push(task.id);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await delay(1);
          inFlight -= 1;
          return harborOutput({
            taskId: task.id,
            tokenSummary: tokenSummary({
              input: 1,
              output: 2,
              reasoning: 0,
              total: 3,
              costUsd: 0.02,
            }),
          });
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(maxInFlight, 3);
      assert.deepEqual(calls, ['task-a', 'task-b', 'task-c']);
      assert.equal(result.stopReason, 'cost_ceiling_exceeded');
      assert.equal(result.totalCostUsd, 0.06);
      assert.deepEqual(result.taskIds, ['task-a', 'task-b', 'task-c']);
    });
  });

  test('preserves cost stop after WAL resume at the configured ceiling', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      await appendFile(
        resultsJsonlPath,
        `${JSON.stringify(taskCompletedEvent({ taskId: 'task-a' }))}\n`,
        'utf8',
      );

      const calls: string[] = [];
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [
          { id: 'task-a', path: '/bench/task-a' },
          { id: 'task-b', path: '/bench/task-b' },
        ],
        costCeilingUsd: 0.01,
        taskRunner: async ({ task }) => {
          calls.push(task.id);
          return harborOutput({ taskId: task.id });
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.deepEqual(calls, []);
      assert.equal(result.stopReason, 'cost_ceiling_exceeded');
      assert.equal(result.totalCostUsd, 0.01);
      assert.deepEqual(result.taskIds, ['task-a']);
    });
  });

  test('runs concurrent tasks while recording deterministic task order', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      let inFlight = 0;
      let maxInFlight = 0;
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [
          { id: 'task-a', path: '/bench/task-a' },
          { id: 'task-b', path: '/bench/task-b' },
          { id: 'task-c', path: '/bench/task-c' },
        ],
        maxConcurrency: 2,
        taskRunner: async ({ task }) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await delay(task.id === 'task-a' ? 20 : 0);
          inFlight -= 1;
          return harborOutput({ taskId: task.id });
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(maxInFlight, 2);
      assert.deepEqual(result.taskIds, ['task-a', 'task-b', 'task-c']);
      const events = (await readFile(resultsJsonlPath, 'utf8'))
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        events.map((event) => event.taskId),
        ['task-a', 'task-b', 'task-c'],
      );
    });
  });

  test('refills concurrency slots before a slow task finishes', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const releaseA = deferred<void>();
      const taskCStarted = deferred<void>();
      let taskAFinished = false;
      const calls: string[] = [];
      const run = runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [
          { id: 'task-a', path: '/bench/task-a' },
          { id: 'task-b', path: '/bench/task-b' },
          { id: 'task-c', path: '/bench/task-c' },
        ],
        maxConcurrency: 2,
        taskRunner: async ({ task }) => {
          calls.push(task.id);
          if (task.id === 'task-a') {
            await releaseA.promise;
            taskAFinished = true;
          }
          if (task.id === 'task-c') taskCStarted.resolve();
          return harborOutput({ taskId: task.id });
        },
        now: () => 100,
        newId: idFactory(),
      });

      await withTimeout(taskCStarted.promise, 200, 'task-c should start before task-a finishes');
      assert.equal(taskAFinished, false);
      releaseA.resolve();
      const result = await run;

      assert.deepEqual(calls, ['task-a', 'task-b', 'task-c']);
      assert.deepEqual(result.taskIds, ['task-a', 'task-b', 'task-c']);
      const events = (await readFile(resultsJsonlPath, 'utf8'))
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        events.map((event) => event.taskId),
        ['task-a', 'task-b', 'task-c'],
      );
    });
  });

  test('reads Harbor reward and Maka cell output artifacts', async () => {
    await withDir(async (dir) => {
      const harborResultPath = join(dir, 'result.json');
      const cellOutputPath = join(dir, 'maka-cell-output.json');
      await writeFile(
        harborResultPath,
        JSON.stringify({ verifier_result: { rewards: { reward: 0 } } }),
        'utf8',
      );
      await writeFile(
        cellOutputPath,
        JSON.stringify(harborOutput({ taskId: 'task-a' }).cell),
        'utf8',
      );

      const output = await readHarborTaskRunOutput({ harborResultPath, cellOutputPath });

      assert.equal(output.harbor.reward, 0);
      assert.equal(output.cell.status, 'completed');
      assert.equal(output.cell.runtimeRefs.sessionId, 'session-task-a');
    });
  });

  test('records context budget summary in completed task WAL events', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const contextBudgetSummary = {
        diagnosticEvents: 1,
        enabledEvents: 1,
        estimatedTokensBefore: 1000,
        estimatedTokensAfter: 600,
        keptTurns: 3,
        droppedTurns: 2,
        keptEvents: 8,
        droppedEvents: 5,
        prunedToolResults: 2,
        activePrunedToolResults: 0,
        activeEstimatedTokensSaved: 0,
        activeArchiveFailures: 0,
        archivePlaceholders: 2,
        archivePlaceholderReasonCounts: {},
        archiveWriteFailures: 0,
        retrievedArchiveToolResults: 1,
        retrievedArchiveEstimatedTokens: 120,
        archiveRetrievalSkipped: 0,
        archiveRetrievalSkippedReasonCounts: {},
        archiveRetrievalFailures: 0,
        archiveRetrievalFailureReasonCounts: {},
        semanticCompactCallInputTokens: 0,
        semanticCompactCallOutputTokens: 0,
        semanticCompactCallCacheReadInputTokens: 0,
        semanticCompactCallCacheWriteInputTokens: 0,
        semanticCompactCallTotalTokens: 0,
      };
      const contextBudgetPolicy = {
        enabled: true as const,
        name: 'harbor-cell-context-budget',
        staleToolResultPrune: {
          enabled: true,
          maxResultEstimatedTokens: 2048,
          minRecentTurnsFull: 2,
        },
        minRecentTurns: 2,
      };

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () =>
          harborOutput({ taskId: 'task-a', contextBudgetPolicy, contextBudgetSummary }),
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.events[0]?.type, 'task_completed');
      if (result.events[0]?.type === 'task_completed') {
        assert.deepEqual(result.events[0].contextBudgetPolicy, contextBudgetPolicy);
        assert.deepEqual(result.events[0].contextBudgetSummary, contextBudgetSummary);
      }
      const event = JSON.parse((await readFile(resultsJsonlPath, 'utf8')).trimEnd());
      assert.deepEqual(event.contextBudgetPolicy, contextBudgetPolicy);
      assert.deepEqual(event.contextBudgetSummary, contextBudgetSummary);
    });
  });

  test('records continuation summary in completed task WAL events', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const continuationSummary = {
        enabled: true,
        maxTurns: 3,
        maxTotalRuntimeSteps: 150,
        turnsUsed: 2,
        continuedTurns: 1,
        stepCapHits: 1,
        capExhausted: false,
        totalRuntimeSteps: 42,
        turns: [
          { turnIndex: 0, status: 'failed' as const, stepCapHit: true, runtimeSteps: 42 },
          { turnIndex: 1, status: 'completed' as const, stepCapHit: false, runtimeSteps: 0 },
        ],
      };

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () => harborOutput({ taskId: 'task-a', continuationSummary }),
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.events[0]?.type, 'task_completed');
      if (result.events[0]?.type === 'task_completed') {
        assert.deepEqual(result.events[0].continuationSummary, continuationSummary);
      }
      const event = JSON.parse((await readFile(resultsJsonlPath, 'utf8')).trimEnd());
      assert.deepEqual(event.continuationSummary, continuationSummary);
    });
  });

  test('records task tool summary in completed task WAL events', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const taskToolSummary = {
        todoWriteCalls: 5,
      };

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () => harborOutput({ taskId: 'task-a', taskToolSummary }),
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.events[0]?.type, 'task_completed');
      if (result.events[0]?.type === 'task_completed') {
        assert.deepEqual(result.events[0].taskToolSummary, taskToolSummary);
      }
      const event = JSON.parse((await readFile(resultsJsonlPath, 'utf8')).trimEnd());
      assert.deepEqual(event.taskToolSummary, taskToolSummary);
    });
  });

  test('classifies completed Harbor reward failures as benchmark failures', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () => harborOutput({ taskId: 'task-a', reward: 0 }),
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.events[0]?.type, 'task_completed');
      assert.equal(result.events[0]?.passed, false);
      assert.equal(result.events[0]?.scored, true);
      assert.equal(result.events[0]?.eligible, true);
      assert.equal(result.events[0]?.errorClass, 'verification_failed');
    });
  });

  test('keeps Harbor step-cap failures eligible as failed benchmark outcomes', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () =>
          harborOutput({
            taskId: 'task-a',
            reward: 0,
            status: 'failed',
            errorClass: 'tool_step_cap_reached',
          }),
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.events[0]?.type, 'task_completed');
      assert.equal(result.events[0]?.passed, false);
      assert.equal(result.events[0]?.scored, false);
      assert.equal(result.events[0]?.eligible, true);
      assert.equal(result.events[0]?.errorClass, 'tool_step_cap_reached');
    });
  });

  test('counts a verifier-graded max-token stop as a scored benchmark failure', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () =>
          harborOutput({
            taskId: 'task-a',
            reward: 0,
            status: 'failed',
            errorClass: 'max_tokens',
            verifier: {
              outcome: 'failed',
              attempts: [{ attempt: 1, classification: 'failed', durationMs: 20, reward: 0 }],
            },
          }),
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.events[0]?.type, 'task_completed');
      assert.equal(result.events[0]?.passed, false);
      assert.equal(result.events[0]?.scored, true);
      assert.equal(result.events[0]?.eligible, true);
      assert.equal(result.events[0]?.errorClass, 'max_tokens');
    });
  });

  test('counts a verifier-graded tool-step cap as a scored benchmark failure', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () =>
          harborOutput({
            taskId: 'task-a',
            reward: 0,
            status: 'failed',
            errorClass: 'tool_step_cap_reached',
            verifier: {
              outcome: 'failed',
              attempts: [{ attempt: 1, classification: 'failed', durationMs: 20, reward: 0 }],
            },
          }),
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.events[0]?.type, 'task_completed');
      assert.equal(result.events[0]?.passed, false);
      assert.equal(result.events[0]?.scored, true);
      assert.equal(result.events[0]?.eligible, true);
      assert.equal(result.events[0]?.errorClass, 'tool_step_cap_reached');
    });
  });

  test('counts a verifier-graded provider policy denial as a scored benchmark failure', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () =>
          harborOutput({
            taskId: 'task-a',
            reward: 0,
            status: 'failed',
            errorClass: 'policy_denied',
            verifier: {
              outcome: 'failed',
              attempts: [{ attempt: 1, classification: 'failed', durationMs: 20, reward: 0 }],
            },
          }),
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.events[0]?.type, 'task_completed');
      assert.equal(result.events[0]?.passed, false);
      assert.equal(result.events[0]?.scored, true);
      assert.equal(result.events[0]?.eligible, true);
      assert.equal(result.events[0]?.errorClass, 'policy_denied');
    });
  });

  test('keeps verifier-graded deadlines scored after completed model and workspace steps', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const rawOutput = harborOutput({
        taskId: 'task-a',
        reward: 0,
        status: 'failed',
        errorClass: 'aborted',
        deadlineSettlement: { source: 'benchmark.deadline', mode: 'immediate' },
        toolSummary: {
          providerVisibleToolCount: 1,
          actualToolCalls: 1,
          actualToolNames: ['Bash'],
          actualToolCallCounts: { Bash: 1 },
        },
        verifier: {
          outcome: 'failed',
          attempts: [{ attempt: 1, classification: 'failed', durationMs: 20, reward: 0 }],
        },
      });
      let taskRuns = 0;

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () => {
          taskRuns += 1;
          return rawOutput;
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(taskRuns, 1);
      assert.equal(rawOutput.cell.errorClass, 'aborted');
      assert.equal(result.events[0]?.type, 'task_completed');
      assert.equal(result.events[0]?.passed, false);
      assert.equal(result.events[0]?.scored, true);
      assert.equal(result.events[0]?.eligible, true);
      assert.equal(result.events[0]?.errorClass, 'budget_exhausted');
    });
  });

  test('keeps a verifier-graded deadline scored when the model completed but chose no workspace tool', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        requireFinalUsage: true,
        taskRunner: async () =>
          harborOutput({
            taskId: 'task-a',
            reward: 0,
            status: 'failed',
            errorClass: 'aborted',
            deadlineSettlement: { source: 'benchmark.deadline', mode: 'immediate' },
            verifier: {
              outcome: 'failed',
              attempts: [{ attempt: 1, classification: 'failed', durationMs: 20, reward: 0 }],
            },
          }),
      });

      assert.equal(result.events[0]?.type, 'task_completed');
      assert.equal(result.events[0]?.passed, false);
      assert.equal(result.events[0]?.scored, true);
      assert.equal(result.events[0]?.eligible, true);
      assert.equal(result.events[0]?.errorClass, 'budget_exhausted');
    });
  });

  test('classifies provider rate limits as infrastructure failures', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () =>
          harborOutput({
            taskId: 'task-a',
            reward: 0,
            status: 'failed',
            errorClass: 'rate_limit',
          }),
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.events[0]?.type, 'task_infra_failed');
      assert.equal(result.events[0]?.eligible, false);
      assert.equal(result.events[0]?.errorClass, 'rate_limit');
      assert.equal(
        result.events[0]?.type === 'task_infra_failed'
          ? result.events[0].providerTelemetryPath
          : undefined,
        '/logs/task-a/provider-request-telemetry.json',
      );
    });
  });

  test('classifies network failures as infrastructure failures', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () =>
          harborOutput({
            taskId: 'task-a',
            reward: 0,
            status: 'failed',
            errorClass: 'network',
          }),
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.events[0]?.type, 'task_infra_failed');
      assert.equal(result.events[0]?.eligible, false);
      assert.equal(result.events[0]?.errorClass, 'network');
    });
  });

  test('does not infer A/B eligibility from limit-like error text', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () =>
          harborOutput({
            taskId: 'task-a',
            reward: 0,
            status: 'failed',
            errorClass: 'request_limit_exceeded',
          }),
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.events[0]?.type, 'task_completed');
      assert.equal(result.events[0]?.eligible, false);
    });
  });

  test('keeps verifier infrastructure outcomes out of prompt scoring', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () =>
          harborOutput({
            taskId: 'task-a',
            reward: 0,
            status: 'failed',
            errorClass: 'infra_failed',
            verifier: {
              outcome: 'failed',
              attempts: [
                {
                  attempt: 1,
                  classification: 'infra_failed',
                  durationMs: 20,
                  reward: 0,
                },
              ],
            },
          }),
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.events[0]?.type, 'task_completed');
      assert.equal(result.events[0]?.passed, false);
      assert.equal(result.events[0]?.scored, false);
      assert.equal(result.events[0]?.eligible, false);
      assert.equal(result.events[0]?.errorClass, 'infra_failed');
    });
  });

  test('records zero cost with tokens as a plumbing failure', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () =>
          harborOutput({
            taskId: 'task-a',
            tokenSummary: tokenSummary({ input: 2, output: 1, reasoning: 0, total: 3, costUsd: 0 }),
          }),
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.events[0]?.type, 'task_plumbing_failed');
      assert.equal(result.events[0]?.passed, false);
      assert.equal(result.events[0]?.eligible, false);
      assert.equal(result.events[0]?.errorClass, 'zero_cost_with_tokens');
      assert.equal(result.totalTokens, 3);
      assert.equal(result.totalCostUsd, 0);
    });
  });

  test('accepts zero cost with tokens for an explicitly attested account plan', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        billingMode: 'account-plan',
        taskRunner: async () =>
          harborOutput({
            taskId: 'task-a',
            tokenSummary: tokenSummary({ input: 2, output: 1, reasoning: 0, total: 3, costUsd: 0 }),
          }),
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.events[0]?.type, 'task_completed');
      assert.equal(result.events[0]?.scored, true);
      assert.equal(result.totalTokens, 3);
      assert.equal(result.totalCostUsd, 0);
    });
  });

  test('keeps an attested completed result eligible when usage is unavailable', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        requireExecutionIdentity: true,
        expectedPricingProfile: 'test-profile',
        taskRunner: async () =>
          harborOutput({
            taskId: 'task-a',
            omitTokenSummary: true,
            executionIdentity: {
              llmConnectionSlug: 'fake',
              model: 'fake-model',
              systemPromptHash: hashSystemPrompt('fixed prompt\n'),
              pricingProfile: 'test-profile',
            },
          }),
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.events[0]?.type, 'task_completed');
      assert.equal(result.events[0]?.eligible, true);
      assert.equal(result.events[0]?.scored, true);
      assert.equal('tokenSummary' in result.events[0]!, false);
    });
  });

  test('rejects an attested completed result when final usage is required', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        requireExecutionIdentity: true,
        requireFinalUsage: true,
        expectedPricingProfile: 'test-profile',
        taskRunner: async () =>
          harborOutput({
            taskId: 'task-a',
            omitTokenSummary: true,
            executionIdentity: {
              llmConnectionSlug: 'fake',
              model: 'fake-model',
              systemPromptHash: hashSystemPrompt('fixed prompt\n'),
              pricingProfile: 'test-profile',
            },
          }),
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.events[0]?.type, 'task_plumbing_failed');
      assert.equal(result.events[0]?.errorClass, 'missing_token_usage');
      assert.equal(result.events[0]?.eligible, false);
      assert.equal(result.events[0]?.scored, false);
    });
  });

  test('rejects a verifier-graded failed result when required final usage is missing', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        requireFinalUsage: true,
        taskRunner: async () =>
          harborOutput({
            taskId: 'task-a',
            reward: 0,
            status: 'failed',
            errorClass: 'runtime_error',
            omitTokenSummary: true,
            toolSummary: {
              providerVisibleToolCount: 1,
              actualToolCalls: 1,
              actualToolNames: ['Bash'],
              actualToolCallCounts: { Bash: 1 },
            },
            verifier: {
              outcome: 'failed',
              attempts: [{ attempt: 1, classification: 'failed', durationMs: 20, reward: 0 }],
            },
          }),
      });

      assert.equal(result.events[0]?.type, 'task_plumbing_failed');
      assert.equal(result.events[0]?.errorClass, 'missing_token_usage');
      assert.equal(result.events[0]?.scored, false);
      assert.equal(result.events[0]?.eligible, false);
    });
  });

  test('rejects a deadline-settled workspace attempt when required provider usage is missing', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        requireFinalUsage: true,
        taskRunner: async () =>
          harborOutput({
            taskId: 'task-a',
            reward: 0,
            status: 'failed',
            errorClass: 'aborted',
            deadlineSettlement: { source: 'benchmark.deadline', mode: 'immediate' },
            omitTokenSummary: true,
            toolSummary: {
              providerVisibleToolCount: 1,
              actualToolCalls: 1,
              actualToolNames: ['Bash'],
              actualToolCallCounts: { Bash: 1 },
            },
          }),
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.events[0]?.type, 'task_plumbing_failed');
      assert.equal(result.events[0]?.errorClass, 'missing_token_usage');
      assert.equal(result.events[0]?.eligible, false);
      assert.equal(result.events[0]?.scored, false);
    });
  });

  test('keeps an attested tool-step-cap result eligible when usage is unavailable', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath,
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        requireExecutionIdentity: true,
        expectedPricingProfile: 'test-profile',
        taskRunner: async () =>
          harborOutput({
            taskId: 'task-a',
            status: 'failed',
            errorClass: 'tool_step_cap_reached',
            omitTokenSummary: true,
            executionIdentity: {
              llmConnectionSlug: 'fake',
              model: 'fake-model',
              systemPromptHash: hashSystemPrompt('fixed prompt\n'),
              pricingProfile: 'test-profile',
            },
          }),
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.events[0]?.type, 'task_completed');
      assert.equal(result.events[0]?.eligible, true);
      assert.equal(result.events[0]?.errorClass, 'tool_step_cap_reached');
      assert.equal('tokenSummary' in result.events[0]!, false);
      const [, row] = (await readFile(resultsTsvPath, 'utf8')).trimEnd().split('\n');
      assert.equal(row?.split('\t')[7], '');
      assert.equal(row?.split('\t')[8], '');
    });
  });

  test('records prompt hash mismatches as plumbing failures', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () => harborOutput({ taskId: 'task-a', promptHash: 'sha256:wrong' }),
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.events[0]?.type, 'task_plumbing_failed');
      assert.equal(result.events[0]?.errorClass, 'prompt_hash_mismatch');
      assert.equal(result.events[0]?.promptHash, 'sha256:wrong');
      assert.equal(result.events[0]?.expectedPromptHash, hashSystemPrompt('fixed prompt\n'));
    });
  });

  test('records execution model mismatches as plumbing failures', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () =>
          harborOutput({
            taskId: 'task-a',
            errorClass: 'network',
            executionIdentity: {
              llmConnectionSlug: 'fake',
              model: 'wrong-model',
              systemPromptHash: hashSystemPrompt('fixed prompt\n'),
              pricingProfile: 'test-profile',
            },
          }),
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.events[0]?.type, 'task_plumbing_failed');
      assert.equal(result.events[0]?.errorClass, 'execution_identity_mismatch');
    });
  });

  test('requires execution identity when the experiment requests attestation', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        requireExecutionIdentity: true,
        taskRunner: async () => harborOutput({ taskId: 'task-a' }),
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.events[0]?.type, 'task_plumbing_failed');
      assert.equal(result.events[0]?.errorClass, 'missing_execution_identity');
    });
  });

  test('records missing prompt hashes with tokens as plumbing failures', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () =>
          harborOutput({
            taskId: 'task-a',
            omitPromptHash: true,
            tokenSummary: tokenSummary({ input: 0, output: 0, reasoning: 0, total: 0, costUsd: 0 }),
          }),
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.events[0]?.type, 'task_plumbing_failed');
      assert.equal(result.events[0]?.errorClass, 'missing_prompt_hash');
      assert.equal(result.events[0]?.expectedPromptHash, hashSystemPrompt('fixed prompt\n'));
    });
  });

  test('accepts a prompt hash attested by execution identity without the legacy field', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const promptHash = hashSystemPrompt('fixed prompt\n');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        requireExecutionIdentity: true,
        expectedPricingProfile: 'test-profile',
        taskRunner: async () =>
          harborOutput({
            taskId: 'task-a',
            omitPromptHash: true,
            executionIdentity: {
              llmConnectionSlug: 'fake',
              model: 'fake-model',
              systemPromptHash: promptHash,
              pricingProfile: 'test-profile',
            },
          }),
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.events[0]?.type, 'task_completed');
      assert.equal(result.events[0]?.promptHash, promptHash);
    });
  });

  test('resumes a legacy terminal whose prompt hash is attested by execution identity', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      const promptHash = hashSystemPrompt('fixed prompt\n');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const seeded = taskCompletedEvent({ taskId: 'task-a', resumeFingerprint: 'sha256:manifest' });
      assert.equal(seeded.type, 'task_completed');
      if (seeded.type !== 'task_completed') throw new Error('expected completed fixture');
      const { promptHash: _legacyMissingPromptHash, ...withoutPromptHash } = seeded;
      await appendFixedPromptWalEvent(resultsJsonlPath, {
        ...withoutPromptHash,
        executionIdentity: {
          llmConnectionSlug: 'fake',
          model: 'fake-model',
          reasoningEffort: 'off',
          systemPromptHash: promptHash,
          pricingProfile: 'test-profile',
        },
      });
      let harborCalls = 0;

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        resumeFingerprint: 'sha256:manifest',
        protectPassAtOne: true,
        taskRunner: async () => {
          harborCalls += 1;
          return harborOutput({ taskId: 'task-a' });
        },
      });

      assert.equal(harborCalls, 0);
      assert.equal(result.events[0]?.type, 'task_completed');
    });
  });

  test('keeps a scored terminal authoritative over a later orphan marker', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      await appendFixedPromptWalEvent(
        resultsJsonlPath,
        taskCompletedEvent({
          taskId: 'task-a',
          resumeFingerprint: 'sha256:manifest',
        }),
      );
      await appendFixedPromptWalEvent(resultsJsonlPath, {
        schemaVersion: 1,
        type: 'task_plumbing_failed',
        id: 'orphan-1',
        ts: 20,
        runId: 'run-1',
        roundId: 'round-1',
        resumeFingerprint: 'sha256:manifest',
        taskId: 'task-a',
        status: 'plumbing_failed',
        passed: false,
        scored: false,
        eligible: false,
        errorClass: 'orphaned_sampled_attempt',
        error: 'terminal WAL append raced an old orphan marker',
        expectedPromptHash: hashSystemPrompt('fixed prompt\n'),
      });

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        resumeFingerprint: 'sha256:manifest',
        protectPassAtOne: true,
        taskRunner: async () => harborOutput({ taskId: 'task-a' }),
      });

      assert.equal(result.events[0]?.type, 'task_completed');
      assert.equal(result.events[0]?.scored, true);
    });
  });

  test('keeps a structured verifier pass authoritative after an agent infrastructure exit', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () =>
          harborOutput({
            taskId: 'task-a',
            reward: 1,
            status: 'failed',
            errorClass: 'infra_failed',
            verifier: {
              outcome: 'passed',
              attempts: [{ attempt: 1, classification: 'passed', durationMs: 20, reward: 1 }],
            },
          }),
      });

      assert.equal(result.events[0]?.type, 'task_completed');
      assert.equal(result.events[0]?.passed, true);
      assert.equal(result.events[0]?.scored, true);
      assert.equal(result.events[0]?.errorClass, undefined);
    });
  });

  test('keeps a verifier failure scored after a completed model step without usage', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const cell = failedCellAfterCompletedModelStepWithoutUsage('runtime_error');

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () => ({
          harbor: {
            reward: 0,
            verifier: {
              outcome: 'failed',
              attempts: [{ attempt: 1, classification: 'failed', durationMs: 20, reward: 0 }],
            },
          },
          cell: { ...cell, traceEventsPath: '/logs/task-a/events.jsonl' },
        }),
      });

      assert.equal(cell.steps, 1);
      assert.equal(cell.tokenSummary, undefined);
      assert.equal(result.events[0]?.type, 'task_completed');
      assert.equal(result.events[0]?.passed, false);
      assert.equal(result.events[0]?.scored, true);
      assert.equal(result.events[0]?.eligible, true);
    });
  });

  test('excludes a verifier failure when the agent never completed a model step or reported usage', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () =>
          harborOutput({
            taskId: 'task-a',
            reward: 0,
            status: 'failed',
            errorClass: 'runtime_error',
            steps: 0,
            omitTokenSummary: true,
            verifier: {
              outcome: 'failed',
              attempts: [{ attempt: 1, classification: 'failed', durationMs: 20, reward: 0 }],
            },
          }),
      });

      assert.equal(result.events[0]?.type, 'task_infra_failed');
      assert.equal(result.events[0]?.status, 'infra_failed');
      assert.equal(result.events[0]?.scored, false);
      assert.equal(result.events[0]?.eligible, false);
    });
  });

  test('rejects missing required usage after a completed model step', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const cell = failedCellAfterCompletedModelStepWithoutUsage('aborted', {
        source: 'benchmark.deadline',
        mode: 'immediate',
      });

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        requireFinalUsage: true,
        taskRunner: async () => ({
          harbor: {
            reward: 0,
            verifier: {
              outcome: 'failed',
              attempts: [{ attempt: 1, classification: 'failed', durationMs: 20, reward: 0 }],
            },
          },
          cell: { ...cell, traceEventsPath: '/logs/task-a/events.jsonl' },
        }),
      });

      assert.equal(cell.steps, 1);
      assert.equal(cell.tokenSummary, undefined);
      assert.equal(result.events[0]?.type, 'task_plumbing_failed');
      assert.equal(result.events[0]?.errorClass, 'missing_token_usage');
      assert.equal(result.events[0]?.scored, false);
      assert.equal(result.events[0]?.eligible, false);
    });
  });

  test('keeps a structured verifier failure authoritative after an agent failure', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      for (const errorClass of ['runtime_error', 'infra_failed', 'network']) {
        const result = await runFixedPromptController({
          runId: `run-${errorClass}`,
          roundId: 'round-1',
          config,
          systemPromptPath,
          resultsJsonlPath: join(dir, `results-${errorClass}.jsonl`),
          tasks: [{ id: 'task-a', path: '/bench/task-a' }],
          taskRunner: async () =>
            harborOutput({
              taskId: 'task-a',
              reward: 0,
              status: 'failed',
              errorClass,
              verifier: {
                outcome: 'failed',
                attempts: [{ attempt: 1, classification: 'failed', durationMs: 20, reward: 0 }],
              },
            }),
        });

        assert.equal(result.events[0]?.type, 'task_completed');
        assert.equal(result.events[0]?.passed, false);
        assert.equal(result.events[0]?.scored, true);
        assert.equal(result.events[0]?.eligible, true);
        assert.equal(
          result.events[0]?.errorClass,
          errorClass === 'infra_failed' ? 'runtime_error' : errorClass,
        );
      }
    });
  });

  test('keeps candidate resource exhaustion scored after normal workspace execution', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () =>
          harborOutput({
            taskId: 'task-a',
            reward: 0,
            status: 'failed',
            errorClass: 'infra_failed',
            steps: 64,
            toolSummary: {
              providerVisibleToolCount: 1,
              actualToolCalls: 32,
              actualToolNames: ['Bash'],
              actualToolCallCounts: { Bash: 32 },
            },
            verifier: {
              outcome: 'failed',
              attempts: [{ attempt: 1, classification: 'failed', durationMs: 20, reward: 0 }],
            },
          }),
      });

      assert.equal(result.events[0]?.type, 'task_completed');
      assert.equal(result.events[0]?.passed, false);
      assert.equal(result.events[0]?.scored, true);
      assert.equal(result.events[0]?.eligible, true);
      assert.equal(result.events[0]?.errorClass, 'runtime_error');
    });
  });

  test('keeps rejected runner verifier output ungraded', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const sparseAttempts = new Array(2) as NonNullable<
        TaskRunOutput['harbor']['verifier']
      >['attempts'];
      sparseAttempts[1] = {
        attempt: 2,
        classification: 'failed',
        durationMs: 20,
        reward: 0,
      };

      for (const { label, reward, verifier } of [
        { label: 'missing-attempts', reward: 0, verifier: { outcome: 'failed' } },
        {
          label: 'non-array-attempts',
          reward: 0,
          verifier: { outcome: 'failed', attempts: 'not-an-array' },
        },
        {
          label: 'sparse-attempts',
          reward: 0,
          verifier: { outcome: 'failed', attempts: sparseAttempts },
        },
        {
          label: 'reward-disagreement',
          reward: 1,
          verifier: {
            outcome: 'failed',
            attempts: [{ attempt: 1, classification: 'failed', durationMs: 20, reward: 0 }],
          },
        },
      ] as const) {
        const result = await runFixedPromptController({
          runId: `run-${label}`,
          roundId: 'round-1',
          config,
          systemPromptPath,
          resultsJsonlPath: join(dir, `results-${label}.jsonl`),
          tasks: [{ id: 'task-a', path: '/bench/task-a' }],
          taskRunner: async () =>
            harborOutput({
              taskId: 'task-a',
              reward,
              status: 'failed',
              errorClass: 'max_tokens',
              verifier: verifier as unknown as TaskRunOutput['harbor']['verifier'],
            }),
        });

        assert.equal(result.events[0]?.type, 'task_completed');
        assert.equal(result.events[0]?.passed, false);
        assert.equal(result.events[0]?.scored, false);
        assert.equal(result.events[0]?.eligible, false);
        assert.equal(result.events[0]?.errorClass, 'max_tokens');
      }
    });
  });

  test('rejects a sparse verifier attempt array as provider infrastructure output', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const attempts = new Array(2) as NonNullable<TaskRunOutput['harbor']['verifier']>['attempts'];
      attempts[1] = {
        attempt: 2,
        classification: 'failed',
        durationMs: 20,
        reward: 0,
      };

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () =>
          harborOutput({
            taskId: 'task-a',
            reward: 0,
            status: 'failed',
            errorClass: 'network',
            verifier: { outcome: 'failed', attempts },
          }),
      });

      assert.equal(result.events[0]?.type, 'task_infra_failed');
      assert.equal(result.events[0]?.scored, false);
      assert.equal(result.events[0]?.eligible, false);
      assert.equal(result.events[0]?.errorClass, 'network');
    });
  });

  test('projects a stored structured verifier failure without resampling Harbor', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const stored = taskCompletedEvent({ taskId: 'task-a' });
      assert.equal(stored.type, 'task_completed');
      if (stored.type !== 'task_completed') throw new Error('expected completed fixture');
      await appendFixedPromptWalEvent(resultsJsonlPath, {
        ...stored,
        status: 'failed',
        passed: false,
        scored: false,
        eligible: false,
        errorClass: 'infra_failed',
        harbor: {
          reward: 0,
          verifier: {
            outcome: 'failed',
            attempts: [{ attempt: 1, classification: 'failed', durationMs: 20, reward: 0 }],
          },
        },
      });
      let harborCalls = 0;

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () => {
          harborCalls += 1;
          return harborOutput({ taskId: 'task-a' });
        },
      });

      assert.equal(harborCalls, 0);
      assert.equal(result.events[0]?.type, 'task_completed');
      assert.equal(result.events[0]?.passed, false);
      assert.equal(result.events[0]?.scored, true);
      assert.equal(result.events[0]?.eligible, true);
      assert.equal(result.events[0]?.errorClass, 'runtime_error');
    });
  });

  test('reprojects stale fallback scores when stored verifier data is rejected', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const sparseAttempts = new Array(2);
      sparseAttempts[1] = {
        attempt: 2,
        classification: 'failed',
        durationMs: 20,
        reward: 0,
      };

      for (const [label, reward, verifier, errorClass] of [
        ['missing-attempts', 0, { outcome: 'failed' }, 'max_tokens'],
        ['non-array-attempts', 0, { outcome: 'failed', attempts: 'not-an-array' }, 'max_tokens'],
        ['sparse-attempts', 0, { outcome: 'failed', attempts: sparseAttempts }, 'max_tokens'],
        [
          'reward-disagreement',
          1,
          {
            outcome: 'failed',
            attempts: [{ attempt: 1, classification: 'failed', durationMs: 20, reward: 0 }],
          },
          'max_tokens',
        ],
        ['policy-denied', 0, { outcome: 'failed' }, 'policy_denied'],
      ] as const) {
        const resultsJsonlPath = join(dir, `results-${label}.jsonl`);
        const stored = taskCompletedEvent({ taskId: 'task-a' });
        assert.equal(stored.type, 'task_completed');
        if (stored.type !== 'task_completed') throw new Error('expected completed fixture');
        await writeFile(
          resultsJsonlPath,
          `${JSON.stringify({
            ...stored,
            status: 'failed',
            passed: false,
            scored: true,
            eligible: true,
            errorClass,
            harbor: { reward, verifier },
          })}\n`,
          'utf8',
        );
        let runnerCalls = 0;

        const result = await runFixedPromptController({
          runId: 'run-1',
          roundId: 'round-1',
          config,
          systemPromptPath,
          resultsJsonlPath,
          tasks: [{ id: 'task-a', path: '/bench/task-a' }],
          taskRunner: async () => {
            runnerCalls += 1;
            return harborOutput({ taskId: 'task-a' });
          },
        });

        assert.equal(runnerCalls, 0);
        assert.equal(result.events[0]?.type, 'task_completed');
        assert.equal(result.events[0]?.passed, false);
        assert.equal(result.events[0]?.scored, false);
        assert.equal(result.events[0]?.eligible, false);
        assert.equal(result.events[0]?.errorClass, errorClass);
      }
    });
  });

  test('removes a stale pass from rejected legacy verifier output', async () => {
    await withDir(async (dir) => {
      const resultsJsonlPath = join(dir, 'results.jsonl');
      const stored = taskCompletedEvent({ taskId: 'task-a' });
      assert.equal(stored.type, 'task_completed');
      if (stored.type !== 'task_completed') throw new Error('expected completed fixture');
      const { errorClass: _storedErrorClass, ...legacy } = stored;
      await writeFile(
        resultsJsonlPath,
        `${JSON.stringify({
          ...legacy,
          status: 'failed',
          passed: true,
          scored: true,
          eligible: true,
          harbor: {
            reward: 1,
            verifier: {
              outcome: 'failed',
              attempts: [{ attempt: 1, classification: 'failed', durationMs: 20, reward: 0 }],
            },
          },
        })}\n`,
        'utf8',
      );

      const [projected] = await readFixedPromptWal(resultsJsonlPath);

      assert.equal(projected?.type, 'task_completed');
      assert.equal(projected?.passed, false);
      assert.equal(projected?.scored, false);
      assert.equal(projected?.eligible, false);
      assert.equal(projected?.errorClass, 'verification_failed');
    });
  });

  test('preserves non-verifier scoring authorities while projecting stored WAL', async () => {
    await withDir(async (dir) => {
      const resultsJsonlPath = join(dir, 'results.jsonl');
      const base = taskCompletedEvent({ taskId: 'task-a' });
      assert.equal(base.type, 'task_completed');
      if (base.type !== 'task_completed') throw new Error('expected completed fixture');
      const malformedVerifier = { outcome: 'failed' };
      await writeFile(
        resultsJsonlPath,
        [
          {
            ...base,
            id: 'tool-step-cap',
            taskId: 'tool-step-cap',
            status: 'failed',
            passed: false,
            scored: true,
            eligible: true,
            errorClass: 'tool_step_cap_reached',
            harbor: { reward: 0, verifier: malformedVerifier },
          },
          {
            ...base,
            id: 'deadline',
            taskId: 'deadline',
            status: 'failed',
            passed: false,
            scored: true,
            eligible: true,
            errorClass: 'budget_exhausted',
            deadlineSettlement: { source: 'benchmark.deadline', mode: 'immediate' },
            harbor: { reward: 0, verifier: malformedVerifier },
          },
          {
            ...base,
            id: 'completed',
            taskId: 'completed',
            passed: false,
            scored: true,
            eligible: true,
            errorClass: 'verification_failed',
            harbor: { reward: 0, verifier: malformedVerifier },
          },
          {
            ...base,
            id: 'no-verifier',
            taskId: 'no-verifier',
            status: 'failed',
            passed: false,
            scored: true,
            eligible: true,
            errorClass: 'max_tokens',
            harbor: { reward: 0 },
          },
        ]
          .map((event) => JSON.stringify(event))
          .join('\n') + '\n',
        'utf8',
      );

      const projected = await readFixedPromptWal(resultsJsonlPath);
      assert.deepEqual(
        projected.map((event) => {
          assert.equal(event.type, 'task_completed');
          if (event.type !== 'task_completed') throw new Error('expected completed event');
          return {
            taskId: event.taskId,
            scored: event.scored,
            eligible: event.eligible,
            errorClass: event.errorClass,
          };
        }),
        [
          {
            taskId: 'tool-step-cap',
            scored: false,
            eligible: true,
            errorClass: 'tool_step_cap_reached',
          },
          {
            taskId: 'deadline',
            scored: true,
            eligible: true,
            errorClass: 'budget_exhausted',
          },
          {
            taskId: 'completed',
            scored: true,
            eligible: true,
            errorClass: 'verification_failed',
          },
          {
            taskId: 'no-verifier',
            scored: true,
            eligible: true,
            errorClass: 'max_tokens',
          },
        ],
      );
    });
  });

  test('projects a stored structured verifier pass without resampling Harbor', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const stored = taskCompletedEvent({ taskId: 'task-a' });
      assert.equal(stored.type, 'task_completed');
      if (stored.type !== 'task_completed') throw new Error('expected completed fixture');
      await appendFixedPromptWalEvent(resultsJsonlPath, {
        ...stored,
        status: 'failed',
        passed: false,
        scored: false,
        eligible: false,
        errorClass: 'infra_failed',
        harbor: {
          reward: 1,
          verifier: {
            outcome: 'passed',
            attempts: [{ attempt: 1, classification: 'passed', durationMs: 20, reward: 1 }],
          },
        },
      });
      let harborCalls = 0;

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        taskRunner: async () => {
          harborCalls += 1;
          return harborOutput({ taskId: 'task-a' });
        },
      });

      assert.equal(harborCalls, 0);
      assert.equal(result.events[0]?.passed, true);
      assert.equal(result.events[0]?.scored, true);
      assert.equal(result.events[0]?.errorClass, undefined);
    });
  });
});

function taskCompletedEvent(input: {
  taskId: string;
  promptHash?: string;
  resumeFingerprint?: string;
}): FixedPromptWalEvent {
  return {
    schemaVersion: 1,
    type: 'task_completed',
    id: `event-${input.taskId}`,
    ts: 10,
    runId: 'run-1',
    roundId: 'round-1',
    taskId: input.taskId,
    status: 'completed',
    passed: true,
    scored: true,
    eligible: true,
    promptHash: input.promptHash ?? hashSystemPrompt('fixed prompt\n'),
    ...(input.resumeFingerprint ? { resumeFingerprint: input.resumeFingerprint } : {}),
    tokenSummary: tokenSummary({ input: 2, output: 3, reasoning: 0, total: 5, costUsd: 0.01 }),
    steps: 4,
    durationMs: 50,
    runtimeEventsPath: `/logs/${input.taskId}/runtime-events.jsonl`,
    traceEventsPath: `/logs/${input.taskId}/events.jsonl`,
    harbor: { reward: 1 },
  };
}

function taskInfraFailedEvent(input: { taskId: string }): FixedPromptWalEvent {
  return {
    schemaVersion: 1,
    type: 'task_infra_failed',
    id: `event-${input.taskId}`,
    ts: 10,
    runId: 'run-1',
    roundId: 'round-1',
    taskId: input.taskId,
    status: 'infra_failed',
    passed: false,
    scored: false,
    eligible: false,
    errorClass: 'infra_error',
    error: 'container crashed',
  };
}

function harborOutput(input: {
  taskId: string;
  reward?: number;
  promptHash?: string;
  omitPromptHash?: boolean;
  tokenSummary?: TaskRunOutput['cell']['tokenSummary'];
  omitTokenSummary?: boolean;
  contextBudgetPolicy?: TaskRunOutput['cell']['contextBudgetPolicy'];
  contextBudgetSummary?: TaskRunOutput['cell']['contextBudgetSummary'];
  continuationSummary?: TaskRunOutput['cell']['continuationSummary'];
  taskToolSummary?: TaskRunOutput['cell']['taskToolSummary'];
  toolSummary?: TaskRunOutput['cell']['toolSummary'];
  errorClass?: string;
  status?: TaskRunOutput['cell']['status'];
  executionIdentity?: TaskRunOutput['cell']['executionIdentity'];
  legacyExecutionIdentity?: boolean;
  deadlineSettlement?: TaskRunOutput['cell']['deadlineSettlement'];
  verifier?: TaskRunOutput['harbor']['verifier'];
  providerTelemetryPath?: string;
  steps?: number;
  durationMs?: number;
}): TaskRunOutput {
  return {
    harbor: { reward: input.reward ?? 1, ...(input.verifier ? { verifier: input.verifier } : {}) },
    cell: {
      schemaVersion: 1,
      status: input.status ?? 'completed',
      ...(input.errorClass ? { errorClass: input.errorClass } : {}),
      runtimeEventsPath: `/logs/${input.taskId}/runtime-events.jsonl`,
      traceEventsPath: `/logs/${input.taskId}/events.jsonl`,
      providerTelemetryPath:
        input.providerTelemetryPath ?? `/logs/${input.taskId}/provider-request-telemetry.json`,
      ...(input.omitPromptHash
        ? {}
        : { promptHash: input.promptHash ?? hashSystemPrompt('fixed prompt\n') }),
      ...(input.executionIdentity
        ? {
            executionIdentity: input.legacyExecutionIdentity
              ? input.executionIdentity
              : { agentTools: false, ...input.executionIdentity },
          }
        : {}),
      ...(input.deadlineSettlement ? { deadlineSettlement: input.deadlineSettlement } : {}),
      ...(input.omitTokenSummary
        ? {}
        : {
            tokenSummary:
              input.tokenSummary ??
              tokenSummary({ input: 1, output: 2, reasoning: 0, total: 3, costUsd: 0.02 }),
          }),
      ...(input.contextBudgetPolicy ? { contextBudgetPolicy: input.contextBudgetPolicy } : {}),
      ...(input.contextBudgetSummary ? { contextBudgetSummary: input.contextBudgetSummary } : {}),
      ...(input.continuationSummary ? { continuationSummary: input.continuationSummary } : {}),
      ...(input.taskToolSummary ? { taskToolSummary: input.taskToolSummary } : {}),
      toolSummary: input.toolSummary ?? {
        providerVisibleToolCount: 0,
        actualToolCalls: 0,
        actualToolNames: [],
        actualToolCallCounts: {},
      },
      steps: input.steps ?? 2,
      durationMs: input.durationMs ?? 40,
      startedAt: 20,
      finishedAt: 60,
      runtimeRefs: {
        invocationId: `inv-${input.taskId}`,
        sessionId: `session-${input.taskId}`,
        runId: `run-${input.taskId}`,
        turnId: `turn-${input.taskId}`,
      },
    },
  };
}

function idFactory(): () => string {
  let i = 0;
  return () => `id-${++i}`;
}

function completedModelEventWithoutUsage(): RuntimeEvent {
  return {
    id: 'model-final',
    sessionId: 'session-task-a',
    invocationId: 'inv-task-a',
    runId: 'run-task-a',
    turnId: 'turn-task-a',
    ts: 30,
    partial: false,
    role: 'model',
    author: 'agent',
    refs: { stepId: 'step-1' },
    content: { kind: 'text', text: 'candidate response' },
  };
}

function failedCellAfterCompletedModelStepWithoutUsage(
  errorClass: string,
  deadlineSettlement?: TaskRunOutput['cell']['deadlineSettlement'],
) {
  return buildHarborCellOutput({
    invocation: {
      invocationId: 'inv-task-a',
      sessionId: 'session-task-a',
      runId: 'run-task-a',
      turnId: 'turn-task-a',
      status: 'failed',
      failure: { class: errorClass },
      events: [completedModelEventWithoutUsage()],
      startedAt: 20,
      finishedAt: 60,
    },
    runtimeEventsPath: '/logs/task-a/runtime-events.jsonl',
    promptHash: hashSystemPrompt('fixed prompt\n'),
    ...(deadlineSettlement ? { deadlineSettlement } : {}),
  });
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'maka-fixed-prompt-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
