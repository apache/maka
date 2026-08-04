import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { FixedPromptTaskWalEvent } from '../fixed-prompt-controller.js';
import { analyzeRsiRound, heldInTaskSetHash } from '../rsi-round-analysis.js';
import { tokenSummary } from './helpers/cell-output-fixtures.js';

describe('RSI round analysis', () => {
  test('summarizes held-in transitions, coverage regressions, and error classes', async () => {
    const lastKeptEvents = [
      completed({ taskId: 'task-a', passed: true }),
      completed({ taskId: 'task-b', passed: false, errorClass: 'verification_failed' }),
      completed({ taskId: 'task-c', passed: false, errorClass: 'verification_failed' }),
    ];
    const previousCandidateEvents = [
      completed({ taskId: 'task-a', passed: false, errorClass: 'verification_failed' }),
      completed({ taskId: 'task-b', passed: false, errorClass: 'verification_failed' }),
      completed({ taskId: 'task-c', passed: true }),
    ];
    const candidateEvents = [
      completed({ taskId: 'task-a', passed: false, errorClass: 'verification_failed' }),
      completed({ taskId: 'task-b', passed: false, scored: false, errorClass: 'max_tokens' }),
      plumbingFailed({ taskId: 'task-c', errorClass: 'missing_prompt_hash' }),
      completed({ taskId: 'held-out-secret', passed: true }),
    ];

    const analysis = await analyzeRsiRound({
      heldInTaskIds: ['task-a', 'task-b', 'task-c'],
      lastKeptEvents,
      previousCandidateEvents,
      candidateEvents,
    });

    assert.equal(analysis.heldInTaskSetHash, heldInTaskSetHash(['task-c', 'task-a', 'task-b']));
    assert.deepEqual(analysis.transitionVsLastKept, [
      { taskId: 'task-a', from: 'pass', to: 'fail' },
      { taskId: 'task-b', from: 'fail', to: 'unscored' },
      { taskId: 'task-c', from: 'fail', to: 'plumbing' },
    ]);
    assert.deepEqual(analysis.transitionVsPreviousCandidate, [
      { taskId: 'task-b', from: 'fail', to: 'unscored' },
      { taskId: 'task-c', from: 'pass', to: 'plumbing' },
    ]);
    assert.deepEqual(analysis.coverageRegressionTaskIds, ['task-b', 'task-c']);
    assert.deepEqual(analysis.errorClassDistribution, [
      { errorClass: 'max_tokens', count: 1 },
      { errorClass: 'missing_prompt_hash', count: 1 },
      { errorClass: 'verification_failed', count: 1 },
    ]);
  });

  test('reads a graded budget exhaustion as the score it carries, not as lost coverage', async () => {
    // A verifier-graded timeout has a score. Reporting it as a coverage
    // regression and a pass→budget flip would blame the candidate prompt for
    // evidence that exists and says the task passed.
    const analysis = await analyzeRsiRound({
      heldInTaskIds: ['task-a', 'task-b', 'task-c'],
      lastKeptEvents: [
        completed({ taskId: 'task-a', passed: true }),
        completed({ taskId: 'task-b', passed: true }),
        completed({ taskId: 'task-c', passed: true }),
      ],
      candidateEvents: [
        budgetExhausted({ taskId: 'task-a', passed: true, scored: true }),
        budgetExhausted({ taskId: 'task-b', passed: false, scored: true }),
        budgetExhausted({ taskId: 'task-c' }),
      ],
    });

    assert.deepEqual(analysis.transitionVsLastKept, [
      { taskId: 'task-b', from: 'pass', to: 'fail' },
      { taskId: 'task-c', from: 'pass', to: 'budget' },
    ]);
    // Only the ungraded one actually lost coverage.
    assert.deepEqual(analysis.coverageRegressionTaskIds, ['task-c']);
  });

  test('only reports coverage regression when last kept was covered', async () => {
    const analysis = await analyzeRsiRound({
      heldInTaskIds: ['task-a', 'task-b', 'task-c'],
      lastKeptEvents: [
        completed({ taskId: 'task-a', passed: true }),
        completed({ taskId: 'task-c', passed: false, scored: false, errorClass: 'max_tokens' }),
      ],
      candidateEvents: [
        completed({ taskId: 'task-a', passed: false, scored: false, errorClass: 'max_tokens' }),
        completed({ taskId: 'task-b', passed: false, scored: false, errorClass: 'max_tokens' }),
        completed({ taskId: 'task-c', passed: false, scored: false, errorClass: 'max_tokens' }),
      ],
    });

    assert.deepEqual(analysis.coverageRegressionTaskIds, ['task-a']);
  });

  test('sanitizes prompt-visible error classes before grouping and signaling', async () => {
    const analysis = await analyzeRsiRound({
      heldInTaskIds: ['task-a'],
      lastKeptEvents: [],
      candidateEvents: [
        completed({
          taskId: 'task-a',
          passed: false,
          errorClass: '<unsafe verifier clue /app/tests/secret.md>',
        }),
      ],
    });

    assert.deepEqual(analysis.errorClassDistribution, [{ errorClass: 'unknown_error', count: 1 }]);
    assert.equal(JSON.stringify(analysis).includes('<unsafe verifier clue'), false);
    assert.deepEqual(
      analysis.signals
        .filter((signal) => signal.kind === 'error_class')
        .map(({ id: _id, ...signal }) => signal),
      [{ kind: 'error_class', taskIds: ['task-a'], errorClass: 'unknown_error', count: 1 }],
    );
  });

  test('aggregates bounded prompt-safe tool failure clusters from held-in traces', async () => {
    await withDir(async (dir) => {
      const taskARuntime = join(dir, 'task-a-runtime.jsonl');
      const taskATrace = join(dir, 'task-a-trace.jsonl');
      const taskBRuntime = join(dir, 'task-b-runtime.jsonl');
      const taskBTrace = join(dir, 'task-b-trace.jsonl');
      const taskCRuntime = join(dir, 'task-c-runtime.jsonl');
      const taskCTrace = join(dir, 'task-c-trace.jsonl');
      const heldOutRuntime = join(dir, 'held-out-runtime.jsonl');
      const heldOutTrace = join(dir, 'held-out-trace.jsonl');

      await writeJsonl(taskARuntime, [
        functionCall('call-a', 'Bash', { command: 'exit 1', timeoutMs: 10 }),
      ]);
      await writeJsonl(taskATrace, [
        toolFailed('call-a', 'Bash', 'TimeoutError'),
        toolFailed('call-a', 'Bash', 'TimeoutError'),
      ]);
      await writeJsonl(taskBRuntime, [functionCall('call-b', 'Read', { path: '/app/file.txt' })]);
      await writeJsonl(taskBTrace, [
        toolFailed('call-b', 'Read', 'FileError'),
        toolFailed('call-b', 'Read', 'FileError'),
        toolFailed('call-b', 'Read', 'FileError'),
      ]);
      await writeJsonl(taskCRuntime, [functionCall('call-c', '<unsafe tool>', { '<raw>': 'x' })]);
      await writeJsonl(taskCTrace, [toolFailed('call-c', '<unsafe tool>', 'bad error')]);
      await writeJsonl(heldOutRuntime, [
        functionCall('call-held-out', 'SecretTool', { secret: 'held-out' }),
      ]);
      await writeJsonl(heldOutTrace, [
        toolFailed('call-held-out', 'SecretTool', 'SecretError'),
        toolFailed('call-held-out', 'SecretTool', 'SecretError'),
        toolFailed('call-held-out', 'SecretTool', 'SecretError'),
        toolFailed('call-held-out', 'SecretTool', 'SecretError'),
      ]);

      const analysis = await analyzeRsiRound({
        heldInTaskIds: ['task-a', 'task-b', 'task-c'],
        lastKeptEvents: [],
        candidateEvents: [
          completed({
            taskId: 'task-a',
            passed: false,
            runtimeEventsPath: taskARuntime,
            traceEventsPath: taskATrace,
          }),
          completed({
            taskId: 'task-b',
            passed: false,
            runtimeEventsPath: taskBRuntime,
            traceEventsPath: taskBTrace,
          }),
          completed({
            taskId: 'task-c',
            passed: false,
            runtimeEventsPath: taskCRuntime,
            traceEventsPath: taskCTrace,
          }),
          completed({
            taskId: 'held-out-secret',
            passed: false,
            runtimeEventsPath: heldOutRuntime,
            traceEventsPath: heldOutTrace,
          }),
        ],
        limits: { maxToolFailureClusters: 2 },
      });

      assert.deepEqual(analysis.toolFailureClusters, [
        {
          name: 'Read',
          errorClass: 'FileError',
          argsPreview: 'path',
          count: 3,
          taskIds: ['task-b'],
        },
        {
          name: 'Bash',
          errorClass: 'TimeoutError',
          argsPreview: 'command,timeoutMs',
          count: 2,
          taskIds: ['task-a'],
        },
      ]);
      assert.equal(JSON.stringify(analysis).includes('held-out'), false);
      assert.equal(JSON.stringify(analysis).includes('<unsafe'), false);
    });
  });

  test('aggregates error and aborted tool completions but ignores successful completions', async () => {
    await withDir(async (dir) => {
      const runtimeEventsPath = join(dir, 'runtime.jsonl');
      const traceEventsPath = join(dir, 'trace.jsonl');

      await writeJsonl(runtimeEventsPath, [
        functionCall('call-error', 'Bash', { command: 'exit 1' }),
        functionCall('call-aborted', 'Bash', { command: 'sleep 10' }),
        functionCall('call-success', 'Bash', { command: 'true' }),
      ]);
      await writeJsonl(traceEventsPath, [
        toolCompleted('call-error', 'Bash', 'error'),
        toolCompleted('call-aborted', 'Bash', 'aborted'),
        toolCompleted('call-success', 'Bash', 'success'),
      ]);

      const analysis = await analyzeRsiRound({
        heldInTaskIds: ['task-a'],
        lastKeptEvents: [],
        candidateEvents: [
          completed({ taskId: 'task-a', passed: false, runtimeEventsPath, traceEventsPath }),
        ],
      });

      assert.deepEqual(analysis.toolFailureClusters, [
        {
          name: 'Bash',
          argsPreview: 'command',
          count: 2,
          taskIds: ['task-a'],
        },
      ]);
    });
  });

  test('does not expose tool failure clusters as evidence for tasks with pass fail transitions', async () => {
    await withDir(async (dir) => {
      const taskARuntime = join(dir, 'task-a-runtime.jsonl');
      const taskATrace = join(dir, 'task-a-trace.jsonl');
      const taskBRuntime = join(dir, 'task-b-runtime.jsonl');
      const taskBTrace = join(dir, 'task-b-trace.jsonl');

      await writeJsonl(taskARuntime, [
        functionCall('call-a', 'Write', { path: '/app/index.html' }),
      ]);
      await writeJsonl(taskATrace, [toolFailed('call-a', 'Write', 'Validation')]);
      await writeJsonl(taskBRuntime, [functionCall('call-b', 'Bash', { command: 'pytest -q' })]);
      await writeJsonl(taskBTrace, [toolFailed('call-b', 'Bash', 'RuntimeError')]);

      const analysis = await analyzeRsiRound({
        heldInTaskIds: ['task-a', 'task-b'],
        lastKeptEvents: [
          completed({ taskId: 'task-a', passed: true }),
          completed({ taskId: 'task-b', passed: false, errorClass: 'verification_failed' }),
        ],
        candidateEvents: [
          completed({
            taskId: 'task-a',
            passed: false,
            errorClass: 'verification_failed',
            runtimeEventsPath: taskARuntime,
            traceEventsPath: taskATrace,
          }),
          completed({
            taskId: 'task-b',
            passed: false,
            errorClass: 'verification_failed',
            runtimeEventsPath: taskBRuntime,
            traceEventsPath: taskBTrace,
          }),
        ],
      });

      assert.deepEqual(
        analysis.toolFailureClusters.map(({ taskIds, ...cluster }) => ({ ...cluster, taskIds })),
        [
          {
            name: 'Bash',
            errorClass: 'RuntimeError',
            argsPreview: 'command',
            count: 1,
            taskIds: ['task-b'],
          },
          {
            name: 'Write',
            errorClass: 'Validation',
            argsPreview: 'path',
            count: 1,
            taskIds: ['task-a'],
          },
        ],
      );
      assert.deepEqual(
        analysis.signals
          .filter((signal) => signal.kind === 'tool_failure_cluster')
          .map(({ id: _id, ...signal }) => signal),
        [
          {
            kind: 'tool_failure_cluster',
            taskIds: ['task-b'],
            cluster: {
              name: 'Bash',
              errorClass: 'RuntimeError',
              argsPreview: 'command',
              count: 1,
              taskIds: ['task-b'],
            },
          },
        ],
      );
    });
  });

  test('does not aggregate recovered tool failures from passed held-in tasks', async () => {
    await withDir(async (dir) => {
      const passedRuntime = join(dir, 'passed-runtime.jsonl');
      const passedTrace = join(dir, 'passed-trace.jsonl');
      const failedRuntime = join(dir, 'failed-runtime.jsonl');
      const failedTrace = join(dir, 'failed-trace.jsonl');

      await writeJsonl(passedRuntime, [
        functionCall('passed-call', 'Read', { path: '/app/input.txt' }),
      ]);
      await writeJsonl(passedTrace, [toolFailed('passed-call', 'Read', 'Error')]);
      await writeJsonl(failedRuntime, [
        functionCall('failed-call', 'Write', { path: '/app/output.txt' }),
      ]);
      await writeJsonl(failedTrace, [toolFailed('failed-call', 'Write', 'Error')]);

      const analysis = await analyzeRsiRound({
        heldInTaskIds: ['passed-task', 'failed-task'],
        lastKeptEvents: [
          completed({ taskId: 'passed-task', passed: true }),
          completed({ taskId: 'failed-task', passed: false, errorClass: 'verification_failed' }),
        ],
        candidateEvents: [
          completed({
            taskId: 'passed-task',
            passed: true,
            runtimeEventsPath: passedRuntime,
            traceEventsPath: passedTrace,
          }),
          completed({
            taskId: 'failed-task',
            passed: false,
            errorClass: 'verification_failed',
            runtimeEventsPath: failedRuntime,
            traceEventsPath: failedTrace,
          }),
        ],
      });

      assert.deepEqual(analysis.toolFailureClusters, [
        {
          name: 'Write',
          errorClass: 'Error',
          argsPreview: 'path',
          count: 1,
          taskIds: ['failed-task'],
        },
      ]);
      assert.deepEqual(
        analysis.signals
          .filter((signal) => signal.kind === 'tool_failure_cluster')
          .map(({ id: _id, ...signal }) => signal),
        [
          {
            kind: 'tool_failure_cluster',
            taskIds: ['failed-task'],
            cluster: {
              name: 'Write',
              errorClass: 'Error',
              argsPreview: 'path',
              count: 1,
              taskIds: ['failed-task'],
            },
          },
        ],
      );
    });
  });

  test('aggregates tool failure clusters from plumbing events with traces', async () => {
    await withDir(async (dir) => {
      const runtimeEventsPath = join(dir, 'runtime.jsonl');
      const traceEventsPath = join(dir, 'trace.jsonl');

      await writeJsonl(runtimeEventsPath, [
        functionCall('call-a', 'Bash', {
          j: 1,
          i: 1,
          h: 1,
          g: 1,
          f: 1,
          e: 1,
          d: 1,
          c: 1,
          b: 1,
          a: 1,
        }),
      ]);
      await writeJsonl(
        traceEventsPath,
        Array.from({ length: 1001 }, () => toolFailed('call-a', 'Bash', 'TimeoutError')),
      );

      const analysis = await analyzeRsiRound({
        heldInTaskIds: ['task-a'],
        lastKeptEvents: [],
        candidateEvents: [
          plumbingFailed({
            taskId: 'task-a',
            errorClass: 'missing_prompt_hash',
            runtimeEventsPath,
            traceEventsPath,
          }),
        ],
      });

      assert.deepEqual(analysis.toolFailureClusters, [
        {
          name: 'Bash',
          errorClass: 'TimeoutError',
          argsPreview: 'a,b,c,d,e,f,g,h',
          count: 1000,
          taskIds: ['task-a'],
        },
      ]);
    });
  });

  test('keeps trace-derived clusters when runtime artifacts are unavailable', async () => {
    await withDir(async (dir) => {
      const missingRuntimePath = join(dir, 'missing-runtime.jsonl');
      const traceEventsPath = join(dir, 'trace.jsonl');

      await writeJsonl(traceEventsPath, [toolFailed('call-a', 'Bash', 'TimeoutError')]);

      const analysis = await analyzeRsiRound({
        heldInTaskIds: ['task-a'],
        lastKeptEvents: [],
        candidateEvents: [
          completed({
            taskId: 'task-a',
            passed: false,
            runtimeEventsPath: missingRuntimePath,
            traceEventsPath,
          }),
        ],
      });

      assert.deepEqual(analysis.toolFailureClusters, [
        { name: 'Bash', errorClass: 'TimeoutError', count: 1, taskIds: ['task-a'] },
      ]);
      assert.deepEqual(traceUnavailableSignals(analysis), [
        {
          kind: 'trace_unavailable',
          taskIds: ['task-a'],
          source: 'runtime',
          reason: 'missing_file',
        },
      ]);
    });
  });

  test('signals missing trace paths instead of silently skipping artifact events', async () => {
    await withDir(async (dir) => {
      const runtimeEventsPath = join(dir, 'runtime.jsonl');

      await writeJsonl(runtimeEventsPath, [functionCall('call-a', 'Bash', { command: 'exit 1' })]);

      const analysis = await analyzeRsiRound({
        heldInTaskIds: ['task-a', 'task-b'],
        lastKeptEvents: [],
        candidateEvents: [
          completed({ taskId: 'task-a', passed: false, runtimeEventsPath }),
          plumbingFailed({
            taskId: 'task-b',
            errorClass: 'missing_prompt_hash',
            runtimeEventsPath,
          }),
        ],
      });

      assert.deepEqual(analysis.toolFailureClusters, []);
      assert.deepEqual(traceUnavailableSignals(analysis), [
        {
          kind: 'trace_unavailable',
          taskIds: ['task-a', 'task-b'],
          source: 'trace',
          reason: 'missing_path',
        },
      ]);
    });
  });

  test('keeps trace parsing bounded and tolerant per task', async () => {
    await withDir(async (dir) => {
      const taskARuntime = join(dir, 'task-a-runtime.jsonl');
      const taskATrace = join(dir, 'task-a-trace.jsonl');
      const taskBRuntime = join(dir, 'task-b-runtime.jsonl');
      const taskBTrace = join(dir, 'task-b-trace.jsonl');
      const taskDRuntime = join(dir, 'task-d-runtime.jsonl');
      const taskDTrace = join(dir, 'task-d-trace.jsonl');

      await writeJsonl(taskARuntime, [functionCall('call-a', 'Read', { path: '/app/file.txt' })]);
      await writeFile(taskATrace, '{not-json}\n', 'utf8');
      await writeJsonl(taskBRuntime, [functionCall('call-b', 'Bash', { command: 'exit 1' })]);
      await writeJsonl(
        taskBTrace,
        Array.from({ length: 10001 }, () => toolFailed('call-b', 'Bash', 'TimeoutError')),
      );
      await writeJsonl(taskDRuntime, [functionCall('call-d', 'Glob', { pattern: '*.ts' })]);
      await writeFile(taskDTrace, `${'x'.repeat(1_000_001)}\n`, 'utf8');

      const analysis = await analyzeRsiRound({
        heldInTaskIds: ['task-a', 'task-b', 'task-d'],
        lastKeptEvents: [],
        candidateEvents: [
          completed({
            taskId: 'task-a',
            passed: false,
            runtimeEventsPath: taskARuntime,
            traceEventsPath: taskATrace,
          }),
          completed({
            taskId: 'task-b',
            passed: false,
            runtimeEventsPath: taskBRuntime,
            traceEventsPath: taskBTrace,
          }),
          completed({
            taskId: 'task-d',
            passed: false,
            runtimeEventsPath: taskDRuntime,
            traceEventsPath: taskDTrace,
          }),
        ],
      });

      assert.deepEqual(analysis.toolFailureClusters, []);
      assert.deepEqual(traceUnavailableSignals(analysis), [
        {
          kind: 'trace_unavailable',
          taskIds: ['task-b', 'task-d'],
          source: 'trace',
          reason: 'input_limit_exceeded',
        },
        {
          kind: 'trace_unavailable',
          taskIds: ['task-a'],
          source: 'trace',
          reason: 'invalid_jsonl',
        },
      ]);
    });
  });

  test('keeps useful runtime calls when partial events exceed raw JSONL limits', async () => {
    await withDir(async (dir) => {
      const runtimeEventsPath = join(dir, 'runtime.jsonl');
      const traceEventsPath = join(dir, 'trace.jsonl');
      const noisyPartial = {
        content: { kind: 'thinking', text: 'x'.repeat(50_000), partial: true },
      };

      await writeJsonl(runtimeEventsPath, [
        ...Array.from({ length: 25 }, () => noisyPartial),
        functionCall('call-a', 'Write', { path: '/app/output.txt', content: 'done' }),
      ]);
      await writeJsonl(traceEventsPath, [toolFailed('call-a', 'Write', 'Validation')]);

      const analysis = await analyzeRsiRound({
        heldInTaskIds: ['task-a'],
        lastKeptEvents: [],
        candidateEvents: [
          completed({ taskId: 'task-a', passed: false, runtimeEventsPath, traceEventsPath }),
        ],
      });

      assert.deepEqual(analysis.toolFailureClusters, [
        {
          name: 'Write',
          errorClass: 'Validation',
          argsPreview: 'content,path',
          count: 1,
          taskIds: ['task-a'],
        },
      ]);
      assert.deepEqual(traceUnavailableSignals(analysis), []);
    });
  });

  test('treats non-positive tool failure cluster limits as zero', async () => {
    await withDir(async (dir) => {
      const runtimeEventsPath = join(dir, 'runtime.jsonl');
      const traceEventsPath = join(dir, 'trace.jsonl');

      await writeJsonl(runtimeEventsPath, [
        functionCall('call-a', 'Bash', { command: 'exit 1' }),
        functionCall('call-b', 'Read', { path: '/app/file.txt' }),
      ]);
      await writeJsonl(traceEventsPath, [
        toolFailed('call-a', 'Bash', 'TimeoutError'),
        toolFailed('call-b', 'Read', 'FileError'),
      ]);

      for (const maxToolFailureClusters of [0, -1]) {
        const analysis = await analyzeRsiRound({
          heldInTaskIds: ['task-a'],
          lastKeptEvents: [],
          candidateEvents: [
            completed({ taskId: 'task-a', passed: false, runtimeEventsPath, traceEventsPath }),
          ],
          limits: { maxToolFailureClusters },
        });

        assert.deepEqual(analysis.toolFailureClusters, []);
      }
    });
  });

  test('emits deterministic held-in-only analysis signal ids for later evidence refs', async () => {
    const input = {
      heldInTaskIds: ['task-b', 'task-a'],
      lastKeptEvents: [
        completed({ taskId: 'task-a', passed: true }),
        completed({ taskId: 'task-b', passed: false, errorClass: 'verification_failed' }),
      ],
      candidateEvents: [
        completed({ taskId: 'task-a', passed: false, errorClass: 'verification_failed' }),
        completed({ taskId: 'task-b', passed: false, scored: false, errorClass: 'max_tokens' }),
        completed({ taskId: 'held-out-secret', passed: false, errorClass: 'secret_error' }),
      ],
    };

    const first = await analyzeRsiRound(input);
    const second = await analyzeRsiRound({ ...input, heldInTaskIds: ['task-a', 'task-b'] });

    assert.deepEqual(first.signals, second.signals);
    assert.ok(first.signals.length > 0);
    for (const signal of first.signals) {
      assert.match(signal.id, /^rsi-sig:[0-9a-f]{16}$/);
      assert.equal(signal.taskIds.includes('held-out-secret'), false);
    }
    assert.deepEqual(
      first.signals.map((signal) => signal.kind),
      [
        'transition',
        'transition',
        'coverage_regression',
        'error_class',
        'error_class',
        'trace_unavailable',
      ],
    );
    assert.deepEqual(traceUnavailableSignals(first), [
      {
        kind: 'trace_unavailable',
        taskIds: ['task-a', 'task-b'],
        source: 'trace',
        reason: 'missing_path',
      },
    ]);
  });
});

type TraceUnavailableSignal = {
  kind: 'trace_unavailable';
  taskIds: string[];
  source: string;
  reason: string;
};

function traceUnavailableSignals(
  analysis: Awaited<ReturnType<typeof analyzeRsiRound>>,
): TraceUnavailableSignal[] {
  return analysis.signals
    .filter(
      (signal): signal is typeof signal & { kind: 'trace_unavailable' } =>
        signal.kind === 'trace_unavailable',
    )
    .map(({ id: _id, ...signal }) => signal);
}

function completed(input: {
  taskId: string;
  passed: boolean;
  scored?: boolean;
  errorClass?: string;
  runtimeEventsPath?: string;
  traceEventsPath?: string;
}): FixedPromptTaskWalEvent {
  return {
    schemaVersion: 1,
    type: 'task_completed',
    id: `${input.taskId}-event`,
    ts: 1,
    runId: 'run-1',
    roundId: 'round-1',
    taskId: input.taskId,
    status: input.passed ? 'completed' : 'failed',
    passed: input.passed,
    scored: input.scored ?? true,
    eligible: true,
    ...(input.errorClass ? { errorClass: input.errorClass } : {}),
    promptHash: 'sha256:prompt',
    tokenSummary: tokenSummary({ input: 1, output: 1, reasoning: 0, total: 2, costUsd: 0.01 }),
    steps: 1,
    durationMs: 10,
    runtimeEventsPath: input.runtimeEventsPath ?? '/tmp/runtime-events.jsonl',
    ...(input.traceEventsPath ? { traceEventsPath: input.traceEventsPath } : {}),
    harbor: { reward: input.passed ? 1 : 0 },
  };
}

function plumbingFailed(input: {
  taskId: string;
  errorClass: 'zero_cost_with_tokens' | 'prompt_hash_mismatch' | 'missing_prompt_hash';
  runtimeEventsPath?: string;
  traceEventsPath?: string;
}): FixedPromptTaskWalEvent {
  return {
    schemaVersion: 1,
    type: 'task_plumbing_failed',
    id: `${input.taskId}-plumbing`,
    ts: 1,
    runId: 'run-1',
    roundId: 'round-1',
    taskId: input.taskId,
    status: 'plumbing_failed',
    passed: false,
    scored: false,
    eligible: false,
    errorClass: input.errorClass,
    error: 'plumbing failed',
    expectedPromptHash: 'sha256:prompt',
    tokenSummary: tokenSummary({ input: 1, output: 1, reasoning: 0, total: 2, costUsd: 0.01 }),
    steps: 1,
    durationMs: 10,
    runtimeEventsPath: input.runtimeEventsPath ?? '/tmp/runtime-events.jsonl',
    ...(input.traceEventsPath ? { traceEventsPath: input.traceEventsPath } : {}),
    harbor: { reward: 0 },
  };
}

function budgetExhausted(input: {
  taskId: string;
  passed?: boolean;
  scored?: boolean;
}): FixedPromptTaskWalEvent {
  const scored = input.scored ?? false;
  return {
    schemaVersion: 1,
    type: 'task_budget_exhausted',
    id: `${input.taskId}-budget`,
    ts: 1,
    runId: 'run-1',
    roundId: 'round-1',
    taskId: input.taskId,
    status: 'budget_exhausted',
    passed: input.passed ?? false,
    scored,
    eligible: true,
    errorClass: 'budget_exhausted',
    error: 'agent budget exhausted',
    expectedPromptHash: 'sha256:prompt',
    ...(scored ? { harbor: { reward: input.passed ? 1 : 0 } } : {}),
  };
}

function functionCall(id: string, name: string, args: Record<string, unknown>): unknown {
  return { content: { kind: 'function_call', id, name, args } };
}

function toolFailed(toolUseId: string, toolName: string, errorClass: string): unknown {
  return { type: 'tool_failed', data: { toolUseId, toolName, errorClass } };
}

function toolCompleted(toolUseId: string, toolName: string, status: string): unknown {
  return { type: 'tool_completed', data: { toolUseId, toolName, status } };
}

async function writeJsonl(path: string, events: readonly unknown[]): Promise<void> {
  await writeFile(path, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'maka-rsi-analysis-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
