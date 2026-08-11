import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  buildRiveCommand,
  runRiveCli,
  RiveCliError,
} from '../rive-cli.js';
import {
  buildRiveWorkflowTool,
  type RiveWorkflowToolResult,
} from '../rive-workflow-tool.js';

describe('RiveWorkflow tool and CLI bridge', { concurrency: false }, () => {
  it('builds shell-free argv for high-level workflow commands', () => {
    assert.deepEqual(buildRiveCommand({
      action: 'workflow_run',
      templateId: 'sentinel.prod-debug',
      commandId: 'cmd-1',
      params: { env: 'prd', dry_run: true, window: 30 },
      runner: 'opencode',
      workers: ['worker-a', 'worker-b'],
      maxParallel: 2,
      acceptanceMode: 'auto-reported',
      workspaceMode: 'worktree',
      trustProject: true,
      timeoutSeconds: 900,
    }), [
      'workflow', 'run', 'sentinel.prod-debug', '--command-id', 'cmd-1',
      '--param', 'env=prd', '--param', 'dry_run=true', '--param', 'window=30',
      '--runner', 'opencode', '--worker', 'worker-a', '--worker', 'worker-b',
      '--max-parallel', '2', '--acceptance-mode', 'auto-reported',
      '--workspace-mode', 'worktree', '--timeout-seconds', '900', '--trust-project',
    ]);
    assert.deepEqual(buildRiveCommand({
      action: 'work_retry',
      workNodeId: 'work_1',
      commandId: 'retry-1',
      workers: ['worker-a'],
      workspaceMode: 'worktree',
    }), [
      'work', 'retry', 'work_1', '--command-id', 'retry-1', '--worker', 'worker-a', '--workspace-mode', 'worktree',
    ]);
    assert.deepEqual(buildRiveCommand({
      action: 'scheduler_resume',
      schedulerRunId: 'sched_1',
      commandId: 'resume-1',
      runner: 'opencode',
      workers: ['worker-a'],
      failed: true,
    }), [
      'scheduler', 'resume', '--command-id', 'resume-1', '--run', 'sched_1', '--worker', 'worker-a', '--failed',
    ]);
  });

  it('runs a fake Rive CLI and returns projection ids, not stdout success', async () => {
    await withFakeRive('success', async (riveBin, cwd) => {
      const emitted: string[] = [];
      const tool = buildRiveWorkflowTool({ riveBin });
      const result = await runTool(tool, cwd, {
        action: 'workflow_run',
        templateId: 'sentinel.prod-debug',
        commandId: 'cmd-success',
        params: { slack_channel: '#alerts' },
        workers: ['worker-a'],
      }, (stream, chunk) => emitted.push(`${stream}:${chunk}`));

      assert.equal(result.ok, true);
      assert.equal(result.kind, 'rive_workflow');
      assert.equal(result.ids.workflowRunId, 'wfrun_fake');
      assert.equal(result.ids.schedulerRunId, 'sched_fake');
      assert.equal(result.ids.rootWorkNodeId, 'work_root_fake');
      assert.equal(result.state, 'completed');
      assert.equal(result.summary, 'Workflow run wfrun_fake root work_root_fake state completed');
      assert.equal('protocol' in result, false);
      assert.equal('display' in result, false);
      assert.equal(result.projection?.workflowRunId, 'wfrun_fake');
      assert.equal(result.stderrTail?.includes('super-secret'), false);
      assert.equal(emitted.join('').includes('super-secret'), false);
      assert.equal(result.command.includes('workflow'), true);
    });
  });

  it('fails closed when Rive is not installed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-rive-missing-'));
    try {
      const tool = buildRiveWorkflowTool({ riveBin: join(cwd, 'missing-rive') });
      const result = await runTool(tool, cwd, {
        action: 'workflow_status',
        workflowRunId: 'wfrun_missing',
      });
      assert.equal(result.ok, false);
      assert.equal(result.error?.reason, 'rive_not_installed');
      assert.match(result.error?.message ?? '', /not executable|not found/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('reports timeout and abort without parsing stdout as success', async () => {
    await withFakeRive('sleep', async (riveBin, cwd) => {
      const tool = buildRiveWorkflowTool({ riveBin });
      const timedOut = await runTool(tool, cwd, {
        action: 'workflow_status',
        workflowRunId: 'wfrun_sleep',
        timeoutMs: 30,
      });
      assert.equal(timedOut.ok, false);
      assert.equal(timedOut.error?.reason, 'timeout');

      const controller = new AbortController();
      const promise = runTool(tool, cwd, {
        action: 'workflow_status',
        workflowRunId: 'wfrun_sleep',
      }, undefined, controller);
      setTimeout(() => controller.abort(), 20);
      const aborted = await promise;
      assert.equal(aborted.ok, false);
      assert.equal(aborted.error?.reason, 'aborted');
    });
  });

  it('kills and reaps a Rive child that ignores SIGTERM on abort', async () => {
    await withFakeRive('ignore-term', async (riveBin, cwd) => {
      const pidFile = join(cwd, 'pid');
      const controller = new AbortController();
      let childReady!: () => void;
      const childReadyPromise = new Promise<void>((resolve) => { childReady = resolve; });
      const promise = runRiveCli({
        action: 'workflow_status',
        workflowRunId: 'wfrun_ignore_term',
      }, {
        cwd,
        riveBin,
        env: { ...process.env, PID_FILE: pidFile },
        abortSignal: controller.signal,
        emitOutput: (stream, chunk) => {
          if (stream === 'stdout' && chunk.includes('RIVE_CHILD_READY')) childReady();
        },
      });
      let readyTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          childReadyPromise,
          new Promise<never>((_, reject) => {
            readyTimer = setTimeout(() => reject(new Error('timed out waiting for the fake Rive child')), 2_000);
          }),
        ]);
      } finally {
        if (readyTimer) clearTimeout(readyTimer);
      }
      const pid = Number((await readFile(pidFile, 'utf8')).trim());
      controller.abort();
      await assert.rejects(promise, (error) => {
        assert.equal(error instanceof RiveCliError, true);
        assert.equal((error as RiveCliError).reason, 'aborted');
        return true;
      });
      assert.throws(() => process.kill(pid, 0));
    });
  });


  it('surfaces bad JSON and Rive error envelopes as structured tool failures', async () => {
    await withFakeRive('bad-json', async (riveBin, cwd) => {
      const tool = buildRiveWorkflowTool({ riveBin });
      const result = await runTool(tool, cwd, {
        action: 'workflow_status',
        workflowRunId: 'wfrun_bad_json',
      });
      assert.equal(result.ok, false);
      assert.equal(result.error?.reason, 'bad_json');
    });

    await withFakeRive('failed-envelope', async (riveBin, cwd) => {
      const tool = buildRiveWorkflowTool({ riveBin });
      const result = await runTool(tool, cwd, {
        action: 'workflow_run',
        templateId: 'sentinel.prod-debug',
        commandId: 'cmd-failed',
        noScheduler: true,
      });
      assert.equal(result.ok, false);
      assert.equal(result.error?.reason, 'rive_failed');
      assert.equal(result.error?.code, 'workflow_param_missing');
      assert.equal(result.error?.suggestedAction, 'fix_arguments');
      assert.match(result.summary, /workflow missing param/);
    });
  });

  it('rejects invalid scheduler arguments before spawning Rive', async () => {
    await withFakeRive('success', async (riveBin, cwd) => {
      const tool = buildRiveWorkflowTool({ riveBin });
      const result = await runTool(tool, cwd, {
        action: 'workflow_run',
        templateId: 'sentinel.prod-debug',
        commandId: 'cmd-invalid',
      });
      assert.equal(result.ok, false);
      assert.equal(result.error?.reason, 'invalid_arguments');
      assert.match(result.summary, /worker is required/);
      assert.deepEqual(result.command, []);
    });
  });

  it('redacts secrets from bridge errors and output tails', async () => {
    await withFakeRive('failed-secret', async (riveBin, cwd) => {
      await assert.rejects(
        runRiveCli({
          action: 'workflow_status',
          workflowRunId: 'wfrun_secret',
        }, { cwd, riveBin }),
        (error) => {
          assert.equal(error instanceof RiveCliError, true);
          const riveError = error as RiveCliError;
          assert.equal(riveError.reason, 'rive_failed');
          assert.equal(JSON.stringify(riveError.envelope).includes('abc123-super-secret'), false);
          assert.equal((riveError.stderrTail ?? '').includes('abc123-super-secret'), false);
          return true;
        },
      );
    });
  });

});

async function runTool(
  tool: ReturnType<typeof buildRiveWorkflowTool>,
  cwd: string,
  args: Parameters<typeof tool.impl>[0],
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void,
  controller = new AbortController(),
): Promise<RiveWorkflowToolResult> {
  return await tool.impl(args, {
    sessionId: 'session',
    turnId: 'turn',
    cwd,
    toolCallId: 'tool-call',
    abortSignal: controller.signal,
    emitOutput: onOutput ?? (() => {}),
  });
}

async function withFakeRive(
  mode: 'success' | 'sleep' | 'ignore-term' | 'bad-json' | 'failed-envelope' | 'failed-secret',
  fn: (riveBin: string, cwd: string) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'maka-rive-tool-'));
  const riveBin = join(cwd, 'rive');
  await writeFile(riveBin, fakeRiveScript(mode), 'utf8');
  await chmod(riveBin, 0o755);
  try {
    await fn(riveBin, cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function fakeRiveScript(mode: string): string {
  if (mode === 'ignore-term') {
    return [
      '#!/bin/sh',
      'trap "" TERM',
      'echo $$ > "$PID_FILE"',
      'echo RIVE_CHILD_READY',
      'sleep 20',
      'echo \'{"protocol":{"state":"completed"},"display":{"summary":"late"}}\'',
      '',
    ].join('\n');
  }
  if (mode === 'sleep') {
    return [
      '#!/bin/sh',
      'sleep 5',
      'echo \'{"protocol":{"state":"completed"},"display":{"summary":"late"}}\'',
      '',
    ].join('\n');
  }
  if (mode === 'bad-json') {
    return ['#!/bin/sh', 'echo "not json"', ''].join('\n');
  }
  if (mode === 'failed-envelope') {
    return [
      '#!/bin/sh',
      'cat <<\'JSON\'',
      '{"error":{"code":"workflow_param_missing","message":"workflow missing param: slack_channel","action":"fix_arguments"}}',
      'JSON',
      'exit 1',
      '',
    ].join('\n');
  }
  if (mode === 'failed-secret') {
    return [
      '#!/bin/sh',
      'echo "api_key=abc123-super-secret" >&2',
      'cat <<\'JSON\'',
      '{"error":{"code":"auth","message":"token=abc123-super-secret"}}',
      'JSON',
      'exit 1',
      '',
    ].join('\n');
  }
  return [
    '#!/bin/sh',
    'echo "token=abc123-super-secret" >&2',
    'cat <<\'JSON\'',
    '{"protocol":{"workflow_run_id":"wfrun_fake","scheduler_run_id":"sched_fake","root_work_node_id":"work_root_fake","state":"completed"},"display":{"summary":"Workflow run wfrun_fake root work_root_fake state completed"}}',
    'JSON',
    '',
  ].join('\n');
}
