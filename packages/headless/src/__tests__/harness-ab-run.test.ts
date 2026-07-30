import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { HarborCellOutput } from '../cell-output.js';
import type { TaskRunner } from '../fixed-prompt-controller.js';
import { assertHarnessAbReportCompleted, buildHarnessAbReport } from '../harness-ab-report.js';
import { runHarnessAbComparison } from '../harness-ab-run.js';
import { HarborInfraError } from '../harbor-task-runner.js';
import { hashHeadlessSystemPrompt } from '../system-prompts.js';
import { tokenSummary } from './helpers/cell-output-fixtures.js';

describe('runHarnessAbComparison', () => {
  test('runs two paired tasks concurrently with both harness arms in parallel', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-concurrency-'));
    try {
      const promptPath = join(dir, 'empty-system-prompt.txt');
      await writeFile(promptPath, '', 'utf8');
      let release!: () => void;
      const releasePromise = new Promise<void>((resolve) => {
        release = resolve;
      });
      let fourStarted!: () => void;
      const fourStartedPromise = new Promise<void>((resolve) => {
        fourStarted = resolve;
      });
      let active = 0;
      let maxActive = 0;
      const calls: string[] = [];
      const beforeRun = async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (active === 4) fourStarted();
        await releasePromise;
        active -= 1;
      };
      const comparison = runHarnessAbComparison({
        runId: 'glm-harness-ab',
        runRoot: dir,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        systemPromptPath: promptPath,
        resumeFingerprint: 'sha256:manifest',
        evaluationTasks: ['a', 'b', 'c'].map((id) => ({ id, path: `/tasks/${id}` })),
        arms: [harnessArm('maka', calls, beforeRun), harnessArm('opencode', calls, beforeRun)],
      });

      // Bound is intentionally generous: the full headless suite runs many
      // files under one `node --test` process, so a 100ms observe window was
      // flaking under load even when all four arms did start. Concurrency
      // breakage still fails (fourStarted never resolves).
      const observedFour = await Promise.race([
        fourStartedPromise.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
      ]);
      release();
      await comparison;

      assert.equal(observedFour, true);
      assert.equal(maxActive, 4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('runs paired harness arms sequentially when requested', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-sequential-'));
    try {
      const promptPath = join(dir, 'empty-system-prompt.txt');
      await writeFile(promptPath, '', 'utf8');
      let active = 0;
      let maxActive = 0;
      const calls: string[] = [];
      const beforeRun = async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
      };

      await runHarnessAbComparison({
        runId: 'codex-oauth-harness-ab',
        runRoot: dir,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        systemPromptPath: promptPath,
        resumeFingerprint: 'sha256:manifest',
        evaluationTasks: [{ id: 'a', path: '/tasks/a' }],
        arms: [harnessArm('maka', calls, beforeRun), harnessArm('opencode', calls, beforeRun)],
        armExecution: 'sequential',
      });

      assert.equal(maxActive, 1);
      assert.deepEqual(calls, ['a:maka', 'a:opencode']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('extends a completed prefix without rerunning valid cells', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-'));
    try {
      const promptPath = join(dir, 'empty-system-prompt.txt');
      const resultsPath = join(dir, 'results.jsonl');
      await writeFile(promptPath, '', 'utf8');
      const calls: string[] = [];
      const arms = [harnessArm('maka', calls), harnessArm('opencode', calls)] as const;
      const tasks = ['a', 'b', 'c'].map((id) => ({ id, path: `/tasks/${id}` }));
      const common = {
        runId: 'glm-harness-ab',
        runRoot: dir,
        resultsJsonlPath: resultsPath,
        systemPromptPath: promptPath,
        resumeFingerprint: 'sha256:manifest',
        arms,
      };

      const pilot = await runHarnessAbComparison({ ...common, evaluationTasks: tasks.slice(0, 2) });
      assert.equal(pilot.baseline.observed, 2);
      assert.equal(pilot.candidate.observed, 2);
      assert.equal(calls.length, 4);
      assert.deepEqual(new Set(calls), new Set(['a:maka', 'a:opencode', 'b:maka', 'b:opencode']));

      const full = await runHarnessAbComparison({ ...common, evaluationTasks: tasks });
      assert.equal(full.baseline.observed, 3);
      assert.equal(full.candidate.observed, 3);
      assert.equal(calls.length, 6);
      assert.deepEqual(
        new Set(calls),
        new Set(['a:maka', 'a:opencode', 'b:maka', 'b:opencode', 'c:maka', 'c:opencode']),
      );
      assert.deepEqual(
        (await readdir(dir)).filter((name) => name.endsWith('.tsv')),
        [],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('rejects a concurrent writer for the same run root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-lock-'));
    try {
      const promptPath = join(dir, 'empty-system-prompt.txt');
      await writeFile(promptPath, '', 'utf8');
      let release!: () => void;
      let started!: () => void;
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      const releasePromise = new Promise<void>((resolve) => {
        release = resolve;
      });
      const calls: string[] = [];
      const input = {
        runId: 'glm-harness-ab',
        runRoot: dir,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        systemPromptPath: promptPath,
        resumeFingerprint: 'sha256:manifest',
        evaluationTasks: [{ id: 'a', path: '/tasks/a' }],
        arms: [
          harnessArm('maka', calls, async () => {
            started();
            await releasePromise;
          }),
          harnessArm('opencode', calls),
        ] as const,
      };

      const active = runHarnessAbComparison(input);
      await startedPromise;
      await assert.rejects(runHarnessAbComparison(input), /A\/B run is already active/);
      release();
      await active;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('treats infrastructure failure as the single terminal harness attempt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-single-attempt-'));
    try {
      const promptPath = join(dir, 'empty-system-prompt.txt');
      await writeFile(promptPath, '', 'utf8');
      let failingAttempts = 0;
      const calls: string[] = [];
      const failingArm = harnessArm('maka', calls);
      failingArm.harborRunner = async () => {
        failingAttempts += 1;
        throw new Error('container failed after launch');
      };
      const input = {
        runId: 'glm-harness-ab',
        runRoot: dir,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        systemPromptPath: promptPath,
        resumeFingerprint: 'sha256:manifest',
        evaluationTasks: [{ id: 'a', path: '/tasks/a' }],
        arms: [failingArm, harnessArm('opencode', calls)] as const,
      };

      const first = await runHarnessAbComparison(input);
      assert.equal(failingAttempts, 1);
      assert.equal(first.baseline.infraFailed, 1);

      await runHarnessAbComparison(input);
      assert.equal(failingAttempts, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('continues the frozen schedule after a terminal cell infrastructure failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-resilient-schedule-'));
    try {
      const promptPath = join(dir, 'empty-system-prompt.txt');
      const resultsPath = join(dir, 'results.jsonl');
      await writeFile(promptPath, '', 'utf8');
      const calls: string[] = [];
      let failingAttempts = 0;
      const maka = harnessArm('maka', calls);
      const successfulMakaRunner = maka.harborRunner;
      maka.harborRunner = async (input) => {
        calls.push(`${input.task.id}:maka`);
        if (input.task.id === 'b') {
          failingAttempts += 1;
          throw new HarborInfraError('provider network failed after launch');
        }
        calls.pop();
        return successfulMakaRunner(input);
      };
      const input = {
        runId: 'glm-harness-ab',
        runRoot: dir,
        resultsJsonlPath: resultsPath,
        systemPromptPath: promptPath,
        resumeFingerprint: 'sha256:manifest',
        evaluationTasks: ['a', 'b', 'c'].map((id) => ({ id, path: `/tasks/${id}` })),
        arms: [maka, harnessArm('opencode', calls)] as const,
      };

      const first = await runHarnessAbComparison(input);

      assert.equal(first.baseline.observed, 3);
      assert.equal(first.candidate.observed, 3);
      assert.equal(first.baseline.infraFailed, 1);
      assert.equal(failingAttempts, 1);
      assert.deepEqual(
        new Set(calls),
        new Set(['a:maka', 'a:opencode', 'b:maka', 'b:opencode', 'c:maka', 'c:opencode']),
      );
      const terminalEvents = (await readFile(resultsPath, 'utf8'))
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              taskId: string;
              type: string;
            },
        );
      assert.equal(
        terminalEvents.find((event) => event.taskId === 'b' && event.type === 'task_infra_failed')
          ?.type,
        'task_infra_failed',
      );
      assert.equal(
        terminalEvents.filter((event) => event.taskId === 'c' && event.type === 'task_completed')
          .length,
        2,
      );
      assert.equal(
        (await readFile(`${resultsPath}.attempts.jsonl`, 'utf8')).trim().split('\n').length,
        6,
      );

      await runHarnessAbComparison(input);
      assert.equal(failingAttempts, 1);
      assert.equal(calls.length, 6);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('continues after an explicitly resumed systemic provider failure without resampling it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-resume-systemic-'));
    try {
      const promptPath = join(dir, 'empty-system-prompt.txt');
      const resultsPath = join(dir, 'results.jsonl');
      await writeFile(promptPath, '', 'utf8');
      const calls: string[] = [];
      let authAttempts = 0;
      const maka = harnessArm('maka', calls);
      const successfulMakaRunner = maka.harborRunner;
      maka.harborRunner = async (input) => {
        calls.push(`${input.task.id}:maka`);
        if (input.task.id === 'b') {
          authAttempts += 1;
          const output = await successfulMakaRunner(input);
          calls.pop();
          return { ...output, cell: { ...output.cell, status: 'failed', errorClass: 'auth' } };
        }
        calls.pop();
        return successfulMakaRunner(input);
      };
      const input = {
        runId: 'codex-oauth-harness-ab',
        runRoot: dir,
        resultsJsonlPath: resultsPath,
        systemPromptPath: promptPath,
        resumeFingerprint: 'sha256:manifest',
        pairConcurrency: 1,
        evaluationTasks: ['a', 'b', 'c'].map((id) => ({ id, path: `/tasks/${id}` })),
        arms: [maka, harnessArm('opencode', calls)] as const,
      };

      const stopped = await runHarnessAbComparison(input);
      assert.equal(stopped.stopReason, 'systemic_provider_failure');
      assert.equal(authAttempts, 1);
      assert.ok(!calls.includes('c:maka'));
      assert.ok(!calls.includes('c:opencode'));

      const resumed = await runHarnessAbComparison(input);
      assert.equal(resumed.stopReason, undefined);
      assert.equal(resumed.baseline.observed, 3);
      assert.equal(resumed.candidate.observed, 3);
      assert.equal(authAttempts, 1);
      assert.equal(calls.filter((call) => call === 'c:maka').length, 1);
      assert.equal(calls.filter((call) => call === 'c:opencode').length, 1);
      assert.equal(
        (await readFile(`${resultsPath}.attempts.jsonl`, 'utf8')).trim().split('\n').length,
        6,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('completes with gaps when one attempted cell has no usable output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-missing-usage-'));
    try {
      const promptPath = join(dir, 'empty-system-prompt.txt');
      await writeFile(promptPath, '', 'utf8');
      const calls: string[] = [];
      const opencodeArm = harnessArm('opencode', calls);
      opencodeArm.harborRunner = async () => {
        throw new HarborInfraError('maka-cell-output.json tokenSummary must be a JSON object');
      };

      const summary = await runHarnessAbComparison({
        runId: 'glm-harness-ab',
        runRoot: dir,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        systemPromptPath: promptPath,
        resumeFingerprint: 'sha256:manifest',
        evaluationTasks: [{ id: 'a', path: '/tasks/a' }],
        arms: [harnessArm('maka', calls), opencodeArm],
      });
      const report = buildHarnessAbReport(summary);

      assert.equal(summary.pairedAttempts.excludedPairIds.length, 1);
      assert.equal(report.runStatus, 'completed_with_gaps');
      assert.deepEqual(report.coverage, {
        scheduledCells: 2,
        attemptedCells: 2,
        modelScoredCells: 1,
        infraFailedCells: 1,
        unscoredCells: 1,
        missingFinalUsageCells: 0,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('fails closed when an otherwise completed harness cell has no final usage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-final-usage-'));
    try {
      const promptPath = join(dir, 'empty-system-prompt.txt');
      const resultsPath = join(dir, 'results.jsonl');
      await writeFile(promptPath, '', 'utf8');
      const calls: string[] = [];
      const maka = harnessArm('maka', calls);
      const meteredRunner = maka.harborRunner;
      maka.harborRunner = async (input) => {
        const output = await meteredRunner(input);
        const { tokenSummary: _tokenSummary, ...cell } = output.cell;
        return { ...output, cell };
      };

      const summary = await runHarnessAbComparison({
        runId: 'glm-harness-ab',
        runRoot: dir,
        resultsJsonlPath: resultsPath,
        systemPromptPath: promptPath,
        resumeFingerprint: 'sha256:manifest',
        evaluationTasks: [{ id: 'a', path: '/tasks/a' }],
        arms: [maka, harnessArm('opencode', calls)],
      });
      const events = (await readFile(resultsPath, 'utf8'))
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              type: string;
              errorClass?: string;
            },
        );
      const report = buildHarnessAbReport(summary);

      assert.ok(
        events.some(
          (event) =>
            event.type === 'task_plumbing_failed' && event.errorClass === 'missing_token_usage',
        ),
      );
      assert.equal(report.runStatus, 'completed_with_gaps');
      assert.throws(() => assertHarnessAbReportCompleted(report), /completed with gaps/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function harnessArm(id: 'maka' | 'opencode', calls: string[], beforeRun?: () => Promise<void>) {
  const config = {
    id: `harness-${id}`,
    backend: 'ai-sdk' as const,
    llmConnectionSlug: 'zai-coding-plan',
    model: 'glm-5.2',
  };
  const harborRunner: TaskRunner = async ({ task, systemPrompt }) => {
    await beforeRun?.();
    calls.push(`${task.id}:${id}`);
    const promptHash = hashHeadlessSystemPrompt(systemPrompt);
    const cell: HarborCellOutput = {
      schemaVersion: 1,
      status: 'completed',
      runtimeEventsPath: `/artifacts/${id}/${task.id}.jsonl`,
      promptHash,
      executionIdentity: {
        llmConnectionSlug: config.llmConnectionSlug,
        model: config.model,
        systemPromptHash: promptHash,
        pricingProfile: 'glm-5.2-public-2026-07-13',
        agentTools: false,
      },
      tokenSummary: tokenSummary({
        input: 100,
        output: 10,
        reasoning: 0,
        total: 110,
        costUsd: 0.000184,
      }),
      toolSummary: {
        providerVisibleToolCount: 1,
        actualToolCalls: 1,
        actualToolNames: ['bash'],
        actualToolCallCounts: { bash: 1 },
      },
      steps: 1,
      durationMs: 10,
      startedAt: 0,
      finishedAt: 10,
      runtimeRefs: {
        invocationId: `${id}-${task.id}`,
        sessionId: `${id}-${task.id}`,
        runId: `${id}-${task.id}`,
        turnId: `${id}-${task.id}`,
      },
    };
    return { harbor: { reward: id === 'maka' ? 1 : 0 }, cell };
  };
  return {
    id,
    config,
    expectedPricingProfile: 'glm-5.2-public-2026-07-13',
    harborRunner,
  };
}
