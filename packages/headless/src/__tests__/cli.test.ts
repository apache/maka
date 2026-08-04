import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { createSessionStore } from '@maka/storage';
import { validateHarborCellOutput } from '../cell-output.js';
import { openHeadlessStorageForWrite } from '../headless-storage.js';
import { readResults } from '../results.js';
import type { TaskEvent } from '../task-contracts.js';
import { taskRunLocator } from '../task-run-identity.js';

const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

function runCli(
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...options.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('maka-headless CLI', () => {
  test('task-run readers report an actionable error for a non-Headless root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-headless-unmarked-'));
    const exportRoot = join(root, 'export');
    try {
      for (const args of [
        ['task', 'inspect', 'missing', '--store', root],
        ['task', 'export', 'missing', '--store', root, '--out', exportRoot],
      ]) {
        const result = await runCli(args);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /Pass the <out>\/runs directory created by a task run/);
        assert.doesNotMatch(result.stderr, /StorageRootAuthorityError|\n\s+at /);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects a task missing protectedPaths (grading boundary required)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-headless-cli-'));
    try {
      const spec = {
        configs: [
          { id: 'fake-cfg', backend: 'fake', llmConnectionSlug: 'fake', model: 'fake-model' },
        ],
        tasks: [
          {
            id: 't',
            instruction: 'go',
            workspaceDir: 'fixture',
            verification: { command: 'true' },
          },
        ],
      };
      const specPath = join(dir, 'spec.json');
      await writeFile(specPath, JSON.stringify(spec), 'utf8');
      const result = await runCli(['eval', specPath, '--out', join(dir, 'out')]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /protectedPaths/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('harbor run refuses real backend without explicit isolation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-headless-harbor-cli-'));
    try {
      await mkdir(join(dir, 'fixture'), { recursive: true });
      const result = await runCli([
        'harbor',
        'run',
        '--backend',
        'ai-sdk',
        '--instruction',
        'solve it',
        '--workdir',
        join(dir, 'fixture'),
      ]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /requires --isolation harbor-local\|harbor-http/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('harbor run preflights host bridge URL and token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-headless-harbor-cli-'));
    try {
      await mkdir(join(dir, 'fixture'), { recursive: true });
      const missingUrl = await runCli([
        'harbor',
        'run',
        '--backend',
        'fake',
        '--isolation',
        'harbor-http',
        '--instruction',
        'solve it',
        '--workdir',
        join(dir, 'fixture'),
      ]);
      assert.equal(missingUrl.code, 1);
      assert.match(missingUrl.stderr, /MAKA_HARBOR_TOOL_EXECUTOR_URL is required/);

      const missingToken = await runCli(
        [
          'harbor',
          'run',
          '--backend',
          'fake',
          '--isolation',
          'harbor-http',
          '--instruction',
          'solve it',
          '--workdir',
          join(dir, 'fixture'),
        ],
        { env: { MAKA_HARBOR_TOOL_EXECUTOR_URL: 'http://127.0.0.1:1' } },
      );
      assert.equal(missingToken.code, 1);
      assert.match(missingToken.stderr, /MAKA_HARBOR_TOOL_EXECUTOR_TOKEN is required/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('harbor run task-run writes external Harbor verifier export without fake verifier authority', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-headless-harbor-cli-'));
    try {
      const fixture = join(dir, 'fixture');
      const outDir = join(dir, 'out');
      const cellArtifactDir = join(dir, 'cell-artifacts');
      await mkdir(fixture, { recursive: true });
      await writeFile(join(fixture, 'README.txt'), 'Harbor owns the task workspace.\n', 'utf8');

      const result = await runCli(
        [
          'harbor',
          'run',
          '--backend',
          'fake',
          '--isolation',
          'none',
          '--instruction',
          'solve it',
          '--workdir',
          fixture,
          '--task-id',
          'tb-real-backend',
          '--task-run-id',
          'harbor-run-1',
          '--out',
          outDir,
          '--include-events',
        ],
        {
          env: {
            MAKA_ECONOMY_TASK_MODE: 'true',
            MAKA_CELL_ARTIFACT_DIR: cellArtifactDir,
            MAKA_MODEL: 'fake-model',
            MAKA_REASONING_EFFORT: 'xhigh',
            MAKA_TRIAL_PRICING_SOURCE: 'test-account-plan',
          },
        },
      );
      assert.equal(result.code, 0, result.stderr);
      const summary = JSON.parse(result.stdout);
      assert.equal(summary.taskRunId, 'harbor-run-1');
      assert.equal(summary.mode, 'task-run');
      assert.equal(summary.scored, false);
      assert.equal(summary.authoritative, false);

      const cell = validateHarborCellOutput(
        JSON.parse(await readFile(join(cellArtifactDir, 'maka-cell-output.json'), 'utf8')),
      );
      assert.equal(cell.status, 'completed');
      assert.equal(cell.promptHash, cell.executionIdentity?.systemPromptHash);
      assert.equal(cell.executionIdentity?.llmConnectionSlug, 'fake');
      assert.equal(cell.executionIdentity?.model, 'fake-model');
      assert.equal(cell.executionIdentity?.reasoningEffort, 'xhigh');
      assert.equal(cell.executionIdentity?.pricingProfile, 'test-account-plan');
      assert.equal(cell.executionIdentity?.agentTools, false);
      assert.equal(cell.toolSummary.actualToolCalls, 0);
      assert.equal(cell.steps, 1);
      assert.equal(cell.runtimeEventsPath, join(cellArtifactDir, 'runtime-events.jsonl'));
      assert.match(await readFile(cell.runtimeEventsPath, 'utf8'), /"role":"system"/);
      const durableIdentity = JSON.parse(
        await readFile(join(cellArtifactDir, 'maka-cell-execution-identity.json'), 'utf8'),
      );
      assert.deepEqual(durableIdentity, cell.executionIdentity);

      const harborExport = join(outDir, 'exports', taskRunLocator('harbor-run-1'));
      const taskRunJson = JSON.parse(await readFile(join(harborExport, 'task-run.json'), 'utf8'));
      assert.equal(taskRunJson.policy.economyTask.enabled, true);
      assert.equal(taskRunJson.policy.economyTask.triggerSource, 'config');
      assert.equal(taskRunJson.verifier.kind, 'terminal_bench');
      assert.equal(taskRunJson.verifier.benchmark.instanceId, 'tb-real-backend');
      assert.equal(taskRunJson.verifier.benchmark.dataset, 'terminal-bench/terminal-bench-2-1');
      assert.equal(taskRunJson.verifier.benchmark.pendingExternalHarborVerifier, true);
      assert.equal(taskRunJson.verifier.authority.authoritative, false);
      assert.equal(taskRunJson.verifier.authority.label, 'external Harbor verifier pending');
      const events = await readFile(join(harborExport, 'events.jsonl'), 'utf8');
      assert.doesNotMatch(events, /"testCommand":"false"/);
      assert.doesNotMatch(events, /"placeholder":true/);
      assert.doesNotMatch(events, /verificationPlaceholder/);
      assert.doesNotMatch(events, /unsupported local benchmark placeholder/);
      const resultJson = await readFile(join(harborExport, 'result.json'), 'utf8');
      assert.doesNotMatch(resultJson, /verificationPlaceholder/);
      assert.doesNotMatch(resultJson, /unsupported local benchmark placeholder/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('harbor run task-run cell evidence covers every heavy-task invocation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-headless-harbor-heavy-'));
    try {
      const fixture = join(dir, 'fixture');
      const outDir = join(dir, 'out');
      const cellArtifactDir = join(dir, 'cell-artifacts');
      await mkdir(fixture, { recursive: true });
      await writeFile(join(fixture, 'README.txt'), 'Harbor owns the task workspace.\n', 'utf8');

      const result = await runCli(
        [
          'harbor',
          'run',
          '--backend',
          'fake',
          '--isolation',
          'none',
          '--instruction',
          'solve it',
          '--workdir',
          fixture,
          '--task-id',
          'tb-heavy-trajectory',
          '--task-run-id',
          'harbor-heavy-trajectory',
          '--out',
          outDir,
          '--heavy-task',
        ],
        { env: { MAKA_CELL_ARTIFACT_DIR: cellArtifactDir, MAKA_MODEL: 'fake-model' } },
      );
      assert.equal(result.code, 0, result.stderr);

      const cell = validateHarborCellOutput(
        JSON.parse(await readFile(join(cellArtifactDir, 'maka-cell-output.json'), 'utf8')),
      );
      const runtimeEvents = (await readFile(cell.runtimeEventsPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const completedModelSteps = runtimeEvents.filter(
        (event) => event.role === 'model' && event.partial !== true,
      );

      assert.equal(cell.steps, 2);
      assert.equal(completedModelSteps.length, 2);
      const traceEvents = (await readFile(join(cellArtifactDir, 'trace-events.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.equal(
        new Set(traceEvents.map((event) => event.runId).filter(Boolean)).size,
        2,
        'combined trace must retain both heavy-task runs',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('exits 0 when a run completes but fails verification (valid benchmark data)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-headless-cli-'));
    try {
      await mkdir(join(dir, 'fixture'), { recursive: true });
      const spec = {
        configs: [
          { id: 'fake-cfg', backend: 'fake', llmConnectionSlug: 'fake', model: 'fake-model' },
        ],
        tasks: [
          {
            id: 't-fail',
            instruction: 'go',
            workspaceDir: 'fixture',
            verification: { command: 'test -f nope.txt', protectedPaths: [] },
          },
        ],
      };
      const specPath = join(dir, 'spec.json');
      await writeFile(specPath, JSON.stringify(spec), 'utf8');
      const result = await runCli(['eval', specPath, '--out', join(dir, 'out')]);
      assert.equal(result.code, 0, result.stderr);
      const records = await readResults(join(dir, 'out', 'results.jsonl'));
      assert.equal(records[0]?.passed, false);
      assert.ok(!records[0]?.error);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('task run, inspect, and exports tolerate unavailable optional Session evidence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-headless-task-cli-'));
    try {
      await mkdir(join(dir, 'fixture'), { recursive: true });
      await writeFile(join(dir, 'fixture', 'marker.txt'), 'ok', 'utf8');
      const spec = {
        configs: [
          { id: 'fake-cfg', backend: 'fake', llmConnectionSlug: 'fake', model: 'fake-model' },
        ],
        tasks: [
          {
            id: 'tb-pass',
            instruction: 'go',
            workspaceDir: 'fixture',
            verifier: {
              kind: 'terminal_bench',
              adapter: 'terminal-bench',
              instanceId: 'tb-local',
              testCommand: 'test -f marker.txt',
              protectedPaths: [],
            },
          },
        ],
      };
      const specPath = join(dir, 'spec.json');
      const outDir = join(dir, 'out');
      await writeFile(specPath, JSON.stringify(spec), 'utf8');

      const run = await runCli([
        'task',
        'run',
        specPath,
        '--task',
        'tb-pass',
        '--config',
        'fake-cfg',
        '--task-run-id',
        'task-run-1',
        '--out',
        outDir,
        '--include-events',
      ]);
      assert.equal(run.code, 1);
      assert.match(run.stdout, /taskRunId: task-run-1/);

      const inspect = await runCli([
        'task',
        'inspect',
        'task-run-1',
        '--store',
        join(outDir, 'runs'),
        '--json',
      ]);
      assert.equal(inspect.code, 0, inspect.stderr);
      const inspectDocument = JSON.parse(inspect.stdout);
      assert.equal(inspectDocument.schemaVersion, 'maka.task_run_inspect.v1');
      assert.equal(inspectDocument.kind, 'task_run');
      assert.equal(inspectDocument.taskRun.result.taxonomy, 'verification_failed');
      assert.ok(Array.isArray(inspectDocument.attempts));

      const humanInspect = await runCli([
        'task',
        'inspect',
        'task-run-1',
        '--store',
        join(outDir, 'runs'),
      ]);
      assert.equal(humanInspect.code, 0, humanInspect.stderr);
      assert.match(humanInspect.stdout, /TaskRun task-run-1 \[/);
      assert.match(humanInspect.stdout, /Task Events task_event:task-run-1/);

      const exportDir = join(dir, 'manual-export');
      const exported = await runCli([
        'task',
        'export',
        'task-run-1',
        '--store',
        join(outDir, 'runs'),
        '--out',
        exportDir,
        '--include-events',
      ]);
      assert.equal(exported.code, 0, exported.stderr);
      const taskRunJson = JSON.parse(await readFile(join(exportDir, 'task-run.json'), 'utf8'));
      assert.equal(taskRunJson.verifier.kind, 'terminal_bench');
      assert.equal(taskRunJson.verifier.benchmark.instanceId, 'tb-local');
      assert.equal(taskRunJson.verifier.authority.authoritative, false);
      assert.equal(taskRunJson.verifier.benchmark.verificationPlaceholder, true);
      assert.match(
        await readFile(join(exportDir, 'events.jsonl'), 'utf8'),
        /verifier_result_recorded/,
      );

      const sessionId = inspectDocument.attempts[0]?.agentRuns[0]?.identity?.sessionId;
      assert.equal(typeof sessionId, 'string');
      const sessions = createSessionStore(join(outDir, 'runs'));
      try {
        await sessions.remove(sessionId);
      } finally {
        await sessions.close?.();
      }

      const aheExportDir = join(dir, 'ahe-export');
      const aheExported = await runCli([
        'ahe',
        'export',
        'task-run-1',
        '--store',
        join(outDir, 'runs'),
        '--repo',
        repoRoot,
        '--out',
        aheExportDir,
        '--include-events',
      ]);
      assert.equal(aheExported.code, 0, aheExported.stderr);
      assert.match(aheExported.stdout, /harnessResults:/);
      const aheResults = JSON.parse(
        await readFile(join(aheExportDir, 'harness-results.json'), 'utf8'),
      );
      assert.equal(aheResults.results[0].status, 'excluded');
      assert.equal(aheResults.results[0].scoreAuthority, 'self_check');
      assert.equal(aheResults.results[0].taskRunId, 'task-run-1');
      assert.match(aheResults.results[0].executionLineageRef.digest, /^sha256:/);
      const aheTraceIndex = await readFile(join(aheExportDir, 'trace-index.json'), 'utf8');
      const traceLocator = taskRunLocator('task-run-1');
      assert.match(aheTraceIndex, new RegExp(`traces/${traceLocator}/result\\.md`));
      assert.match(aheTraceIndex, /task-events.jsonl/);
      assert.doesNotMatch(aheTraceIndex, /"runtimeEventsJsonl"/);
      const aheLineage = JSON.parse(
        await readFile(
          join(aheExportDir, 'traces', traceLocator, 'execution-lineage.json'),
          'utf8',
        ),
      );
      assert.equal(aheLineage.rawRuntimeEvents, 'included');
      assert.equal(aheLineage.attempts[0].executions.length > 0, true);
      assert.match(
        aheLineage.attempts[0].executions[0].inspectRef.ref,
        /agent-runs\/.+\/inspect.json$/,
      );
      assert.match(
        aheLineage.attempts[0].executions[0].runtimeEventsRef.ref,
        /agent-runs\/.+\/runtime-events.jsonl$/,
      );
      assert.match(
        await readFile(
          join(aheExportDir, aheLineage.attempts[0].executions[0].inspectRef.ref),
          'utf8',
        ),
        /maka.agent_run_inspect.v1/,
      );
      assert.match(
        await readFile(
          join(aheExportDir, aheLineage.attempts[0].executions[0].runtimeEventsRef.ref),
          'utf8',
        ),
        /"runId"/,
      );
      const aheMessages = JSON.parse(
        await readFile(join(aheExportDir, 'traces', traceLocator, 'messages.json'), 'utf8'),
      );
      assert.deepEqual(
        aheMessages.messages.map((message: { role: string }) => message.role),
        ['system', 'user', 'assistant'],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('preserves a long TaskRun identity across run, inspect, result, and export', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-headless-long-task-run-'));
    try {
      await mkdir(join(dir, 'fixture'), { recursive: true });
      await writeFile(join(dir, 'fixture', 'marker.txt'), 'ok', 'utf8');
      const spec = {
        configs: [
          { id: 'fake-cfg', backend: 'fake', llmConnectionSlug: 'fake', model: 'fake-model' },
        ],
        tasks: [
          {
            id: 'long-id-task',
            instruction: 'complete the task',
            workspaceDir: 'fixture',
            verification: { command: 'test -f marker.txt', protectedPaths: [] },
          },
        ],
      };
      const specPath = join(dir, 'spec.json');
      const outDir = join(dir, 'out');
      const taskRunId = `long-task-run-${'x'.repeat(320)}`;
      await writeFile(specPath, JSON.stringify(spec), 'utf8');

      const run = await runCli([
        'task',
        'run',
        specPath,
        '--task',
        'long-id-task',
        '--config',
        'fake-cfg',
        '--task-run-id',
        taskRunId,
        '--out',
        outDir,
        '--include-events',
      ]);
      assert.equal(run.code, 0, run.stderr);

      const inspect = await runCli([
        'task',
        'inspect',
        taskRunId,
        '--store',
        join(outDir, 'runs'),
        '--json',
      ]);
      assert.equal(inspect.code, 0, inspect.stderr);
      const inspectDocument = JSON.parse(inspect.stdout);
      assert.equal(inspectDocument.taskRun.taskRunId, taskRunId);
      assert.equal(inspectDocument.taskRun.result.taxonomy, 'passed');

      const records = await readResults(join(outDir, 'results.jsonl'));
      assert.equal(records.length, 1);
      assert.equal(records[0]?.passed, true);

      const exportRoot = join(outDir, 'exports', taskRunLocator(taskRunId));
      const exported = JSON.parse(await readFile(join(exportRoot, 'task-run.json'), 'utf8'));
      assert.equal(exported.taskRun.taskRunId, taskRunId);
      assert.equal(exported.taskRun.result.taxonomy, 'passed');
      assert.match(await readFile(join(exportRoot, 'events.jsonl'), 'utf8'), /task_run_completed/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('task resume continues a parked needs_approval task run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-headless-task-resume-'));
    try {
      await mkdir(join(dir, 'fixture'), { recursive: true });
      await writeFile(join(dir, 'fixture', 'marker.txt'), 'ok', 'utf8');
      const spec = {
        configs: [
          { id: 'fake-cfg', backend: 'fake', llmConnectionSlug: 'fake', model: 'fake-model' },
        ],
        tasks: [
          {
            id: 'approval-task',
            instruction: 'go',
            workspaceDir: 'fixture',
            verification: { command: 'test -f marker.txt', protectedPaths: [] },
          },
        ],
      };
      const specPath = join(dir, 'spec.json');
      const outDir = join(dir, 'out');
      const taskRunId = 'parked-run';
      const firstAttemptId = `${taskRunId}-attempt-1`;
      await writeFile(specPath, JSON.stringify(spec), 'utf8');
      const initialEvents = [
        JSON.stringify({
          type: 'task_run_created',
          id: 'e1',
          taskRunId,
          ts: 1,
          taskId: 'approval-task',
          configId: 'fake-cfg',
        }),
        JSON.stringify({
          type: 'task_run_started',
          id: 'e2',
          taskRunId,
          ts: 2,
          startedAt: 2,
          sessionId: 'session-1',
          agentRunId: 'agent-1',
        }),
        JSON.stringify({
          type: 'task_attempt_started',
          id: 'e3',
          taskRunId,
          ts: 2,
          attemptId: firstAttemptId,
          startedAt: 2,
          sessionId: 'session-1',
          agentRunId: 'agent-1',
        }),
        JSON.stringify({
          type: 'task_inbox_item_recorded',
          id: 'e4',
          taskRunId,
          ts: 3,
          item: {
            schemaVersion: 1,
            inboxItemId: 'inbox-1',
            taskRunId,
            attemptId: firstAttemptId,
            kind: 'approval_request',
            status: 'open',
            title: 'Approval required',
            reason: 'Bash requires approval',
            createdAt: 3,
            relatedRequestId: 'request-1',
          },
        }),
        JSON.stringify({
          type: 'task_run_needs_approval',
          id: 'e5',
          taskRunId,
          ts: 3,
          attemptId: firstAttemptId,
          reason: 'approval',
          inboxItemId: 'inbox-1',
        }),
      ].map((line) => JSON.parse(line) as TaskEvent);
      const { taskRunStore } = await openHeadlessStorageForWrite(join(outDir, 'runs'));
      for (const event of initialEvents) await taskRunStore.appendEvent(taskRunId, event);

      const resumed = await runCli([
        'task',
        'resume',
        taskRunId,
        '--spec',
        specPath,
        '--out',
        outDir,
      ]);
      assert.equal(resumed.code, 0, resumed.stderr);
      assert.match(resumed.stdout, /resumed: parked-run/);
      assert.match(resumed.stdout, /status: completed/);

      const inspect = await runCli([
        'task',
        'inspect',
        taskRunId,
        '--store',
        join(outDir, 'runs'),
        '--json',
      ]);
      assert.equal(inspect.code, 0, inspect.stderr);
      const projected = JSON.parse(inspect.stdout);
      assert.equal(projected.taskRun.status, 'completed');
      assert.equal(projected.taskRun.result.taxonomy, 'passed');
      assert.equal(projected.taskRun.attemptCount, 2);
      assert.equal(projected.attempts.length, 2);
      assert.equal(projected.taskRun.parked, undefined);

      const exported = JSON.parse(
        await readFile(join(outDir, 'exports', taskRunLocator(taskRunId), 'task-run.json'), 'utf8'),
      );
      assert.equal(exported.taskRun.status, 'completed');
      assert.equal(exported.inbox.items[0].status, 'resolved');

      const records = await readResults(join(outDir, 'results.jsonl'));
      assert.equal(records.length, 1);
      assert.equal(records[0]?.taskId, 'approval-task');
      assert.equal(records[0]?.passed, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('task retry-failed retries retryable failures and skips unsupported adapters', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-headless-task-retry-'));
    try {
      await mkdir(join(dir, 'fixture'), { recursive: true });
      const spec = {
        configs: [
          { id: 'fake-cfg', backend: 'fake', llmConnectionSlug: 'fake', model: 'fake-model' },
        ],
        tasks: [
          {
            id: 'pass',
            instruction: 'go',
            workspaceDir: 'fixture',
            verification: { command: 'true', protectedPaths: [] },
          },
          {
            id: 'retry-me',
            instruction: 'go',
            workspaceDir: 'fixture',
            verification: { command: 'true', protectedPaths: [] },
          },
          {
            id: 'unsupported',
            instruction: 'go',
            workspaceDir: 'fixture',
            verification: { command: 'true', protectedPaths: [] },
          },
        ],
      };
      const specPath = join(dir, 'spec.json');
      const priorPath = join(dir, 'prior-results.jsonl');
      await writeFile(specPath, JSON.stringify(spec), 'utf8');
      await writeFile(
        priorPath,
        [
          JSON.stringify(record('pass', 'fake-cfg', true)),
          JSON.stringify(
            record('retry-me', 'fake-cfg', false, {
              errorClass: 'verification_failed',
              exitCode: 1,
            }),
          ),
          JSON.stringify(
            record('unsupported', 'fake-cfg', false, {
              errorClass: 'unsupported_adapter',
              excludedReason: 'unsupported_adapter',
              error: 'adapter missing',
              exitCode: null,
            }),
          ),
          '',
        ].join('\n'),
        'utf8',
      );

      const outDir = join(dir, 'out');
      const result = await runCli([
        'task',
        'retry-failed',
        priorPath,
        '--spec',
        specPath,
        '--out',
        outDir,
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /retry retry-me/);
      assert.match(result.stdout, /skip unsupported/);

      const records = await readResults(join(outDir, 'results.jsonl'));
      assert.equal(records.length, 4);
      assert.equal(records.filter((r) => r.taskId === 'retry-me').length, 2);
      assert.equal(records.at(-1)?.passed, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function record(
  taskId: string,
  configId: string,
  passed: boolean,
  extra: Record<string, unknown> = {},
) {
  return {
    taskId,
    configId,
    sessionId: `s-${taskId}`,
    runId: `r-${taskId}`,
    status: 'completed',
    passed,
    exitCode: passed ? 0 : 1,
    steps: 1,
    durationMs: 1,
    startedAt: 1,
    finishedAt: 2,
    scored: true,
    eligible: true,
    ...extra,
  };
}
