import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { Config } from '../contracts.js';
import { hashSystemPrompt, type TaskRunOutput } from '../fixed-prompt-controller.js';
import {
  compareKimiProtocolSmokeTrace,
  kimiProtocolAbArms,
  recommendKimiProtocolDefault,
  renderKimiProtocolAbMarkdown,
  runKimiProtocolAbComparison,
  summarizeKimiProtocolRequestMetrics,
} from '../kimi-protocol-ab.js';
import type {
  ProviderRequestTraceAnalysis,
  ProviderRequestTraceIdentity,
} from '../provider-request-trace.js';
import { tokenSummary } from './helpers/cell-output-fixtures.js';

describe('Kimi protocol A/B', () => {
  test('compares the same task through only the two explicit protocol env values', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-kimi-protocol-ab-'));
    const systemPromptPath = join(dir, 'system-prompt.md');
    const resultsJsonlPath = join(dir, 'results.jsonl');
    await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
    await writeFile(join(dir, 'runtime-events.jsonl'), '', 'utf8');
    const seen: Array<{ protocol?: string; keys: string[] }> = [];
    let traceIndex = 0;

    const result = await runKimiProtocolAbComparison({
      runId: 'run-kimi-protocol',
      config: config(),
      systemPromptPath,
      resultsJsonlPath,
      evaluationTasks: [{ id: 'task-a', path: '/bench/task-a' }],
      reps: 1,
      billingMode: 'account-plan',
      taskRunner: async (input) => {
        const protocol = input.agentEnv?.MAKA_MODEL_API_PROTOCOL;
        seen.push({ protocol, keys: Object.keys(input.agentEnv ?? {}).sort() });
        const traceEventsPath = join(dir, `trace-${traceIndex++}.jsonl`);
        await writeTrace(traceEventsPath, protocol, input.task.id);
        return output(input.task.id, traceEventsPath);
      },
      now: monotonicClock(),
      newId: idGenerator(),
    });

    assert.deepEqual(seen, [
      { protocol: 'anthropic-messages', keys: ['MAKA_MODEL_API_PROTOCOL'] },
      { protocol: 'openai-chat', keys: ['MAKA_MODEL_API_PROTOCOL'] },
    ]);
    assert.equal(result.summary.decision, 'diagnostic', JSON.stringify(result.summary, null, 2));
    assert.equal(result.evidence.length, 2);
    assert.equal(result.smokeTrace.onlyIntendedDifferences, true);
    assert.equal(result.smokeTrace.requestCount, 1);
    assert.equal(result.requestMetrics.anthropic.requests, 1);
    assert.equal(result.requestMetrics.openai.requests, 1);
    assert.equal(result.defaultRecommendation, 'keep_anthropic_default');
    assert.deepEqual(
      kimiProtocolAbArms().map((arm) => arm.metadata?.protocol),
      ['anthropic-messages', 'openai-chat'],
    );
    assert.match(renderKimiProtocolAbMarkdown(result), /Raw request telemetry/);
    assert.match(renderKimiProtocolAbMarkdown(result), /trace-anthropic/);
    assert.equal((await readFile(resultsJsonlPath, 'utf8')).trimEnd().split('\n').length, 2);
  });

  test('rejects a host-authority protocol override before running a paid arm', async () => {
    let runnerCalls = 0;

    await assert.rejects(
      runKimiProtocolAbComparison({
        runId: 'run-kimi-protocol',
        config: config(),
        systemPromptPath: '/unused/system-prompt.md',
        resultsJsonlPath: '/unused/results.jsonl',
        evaluationTasks: [{ id: 'task-a', path: '/bench/task-a' }],
        sharedAgentEnv: { MAKA_HOST_MODEL_API_PROTOCOL: 'anthropic-messages' },
        taskRunner: async () => {
          runnerCalls += 1;
          throw new Error('task runner must not be called');
        },
      }),
      /owns MAKA_HOST_MODEL_API_PROTOCOL per arm/,
    );
    assert.equal(runnerCalls, 0);
  });

  test('rejects an inherited host-authority protocol override before running a paid arm', async () => {
    const originalProtocol = process.env.MAKA_HOST_MODEL_API_PROTOCOL;
    let runnerCalls = 0;
    process.env.MAKA_HOST_MODEL_API_PROTOCOL = 'anthropic-messages';

    try {
      await assert.rejects(
        runKimiProtocolAbComparison({
          runId: 'run-kimi-protocol',
          config: config(),
          systemPromptPath: '/unused/system-prompt.md',
          resultsJsonlPath: '/unused/results.jsonl',
          evaluationTasks: [{ id: 'task-a', path: '/bench/task-a' }],
          taskRunner: async () => {
            runnerCalls += 1;
            throw new Error('task runner must not be called');
          },
        }),
        /owns MAKA_HOST_MODEL_API_PROTOCOL per arm/,
      );
      assert.equal(runnerCalls, 0);
    } finally {
      if (originalProtocol === undefined) delete process.env.MAKA_HOST_MODEL_API_PROTOCOL;
      else process.env.MAKA_HOST_MODEL_API_PROTOCOL = originalProtocol;
    }
  });

  test('rejects a request trace from another task execution', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-kimi-protocol-ab-identity-'));
    const systemPromptPath = join(dir, 'system-prompt.md');
    const traceEventsPath = join(dir, 'trace.jsonl');
    await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
    await writeTrace(traceEventsPath, 'anthropic-messages');

    const result = await runKimiProtocolAbComparison({
      runId: 'run-kimi-protocol',
      config: config(),
      systemPromptPath,
      resultsJsonlPath: join(dir, 'results.jsonl'),
      evaluationTasks: [{ id: 'task-a', path: '/bench/task-a' }],
      reps: 1,
      taskRunner: async (input) => output(input.task.id, traceEventsPath),
      now: monotonicClock(),
      newId: idGenerator(),
    });

    assert.equal(result.summary.decision, 'invalid');
    assert.match(result.smokeTrace.error ?? '', /runId expected run-task-a, observed run-1/);
  });

  test('accepts and measures every request from a continuation trace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-kimi-protocol-ab-continuation-'));
    const systemPromptPath = join(dir, 'system-prompt.md');
    await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
    let runnerCalls = 0;

    const result = await runKimiProtocolAbComparison({
      runId: 'run-kimi-protocol',
      config: config(),
      systemPromptPath,
      resultsJsonlPath: join(dir, 'results.jsonl'),
      evaluationTasks: [{ id: 'task-a', path: '/bench/task-a' }],
      reps: 1,
      billingMode: 'account-plan',
      taskRunner: async (input) => {
        runnerCalls += 1;
        const traceEventsPath = join(dir, `trace-${runnerCalls}.jsonl`);
        const runtimeRefs = await writeContinuationTrace(
          traceEventsPath,
          input.agentEnv?.MAKA_MODEL_API_PROTOCOL,
          input.task.id,
        );
        const terminal = output(input.task.id, traceEventsPath);
        terminal.cell.runtimeRefs = { invocationId: `inv-${input.task.id}-2`, ...runtimeRefs };
        return terminal;
      },
      now: monotonicClock(),
      newId: idGenerator(),
    });

    assert.equal(result.summary.decision, 'diagnostic', JSON.stringify(result, null, 2));
    assert.equal(result.evidence.length, 2);
    assert.equal(result.requestMetrics.anthropic.requests, 2);
    assert.equal(result.requestMetrics.openai.requests, 2);
  });

  test('fails closed when a torn request attempt appears beside valid telemetry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-kimi-protocol-ab-torn-trace-'));
    const systemPromptPath = join(dir, 'system-prompt.md');
    await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
    let runnerCalls = 0;

    const result = await runKimiProtocolAbComparison({
      runId: 'run-kimi-protocol',
      config: config(),
      systemPromptPath,
      resultsJsonlPath: join(dir, 'results.jsonl'),
      evaluationTasks: [{ id: 'task-a', path: '/bench/task-a' }],
      reps: 1,
      taskRunner: async (input) => {
        runnerCalls += 1;
        const traceEventsPath = join(dir, `trace-${runnerCalls}.jsonl`);
        await writeTrace(traceEventsPath, input.agentEnv?.MAKA_MODEL_API_PROTOCOL, input.task.id);
        const rows = (await readFile(traceEventsPath, 'utf8')).trimEnd().split('\n');
        const tornAttempt = JSON.parse(rows[1]!) as {
          id: string;
          data: Record<string, unknown>;
        };
        tornAttempt.id = 'attempt-torn';
        tornAttempt.data = { ...tornAttempt.data, attemptId: 'attempt-torn' };
        delete tornAttempt.data.completedAt;
        await writeFile(traceEventsPath, `${rows.join('\n')}\n${JSON.stringify(tornAttempt)}\n`);
        return output(input.task.id, traceEventsPath);
      },
      now: monotonicClock(),
      newId: idGenerator(),
    });

    assert.equal(result.summary.decision, 'invalid');
    assert.equal(runnerCalls, 1);
    assert.match(result.smokeTrace.error ?? '', /line 3: provider request attempt data is invalid/);
  });

  test('stops a multi-task multi-rep run at the paired smoke preflight', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-kimi-protocol-ab-preflight-'));
    const systemPromptPath = join(dir, 'system-prompt.md');
    await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
    const calls: Array<{ taskId: string; protocol: string | undefined }> = [];

    const result = await runKimiProtocolAbComparison({
      runId: 'run-kimi-protocol',
      config: config(),
      systemPromptPath,
      resultsJsonlPath: join(dir, 'results.jsonl'),
      evaluationTasks: [
        { id: 'task-a', path: '/bench/task-a' },
        { id: 'task-b', path: '/bench/task-b' },
      ],
      reps: 3,
      taskRunner: async (input) => {
        const protocol = input.agentEnv?.MAKA_MODEL_API_PROTOCOL;
        calls.push({ taskId: input.task.id, protocol });
        const traceEventsPath = join(dir, `trace-${calls.length}.jsonl`);
        await writeTrace(
          traceEventsPath,
          protocol,
          input.task.id,
          protocol === 'openai-chat' ? 'sha256:drifted-message' : 'sha256:message',
        );
        return output(input.task.id, traceEventsPath);
      },
      now: monotonicClock(),
      newId: idGenerator(),
    });

    assert.equal(result.summary.decision, 'invalid');
    assert.deepEqual(calls, [
      { taskId: 'task-a', protocol: 'anthropic-messages' },
      { taskId: 'task-a', protocol: 'openai-chat' },
    ]);
    assert.match(result.smokeTrace.error ?? '', /shared request segment differs/);
  });

  test('turns a terminal event without a trace into a stable invalid resume result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-kimi-protocol-ab-attempt-'));
    const systemPromptPath = join(dir, 'system-prompt.md');
    await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
    let runnerCalls = 0;
    const run = () =>
      runKimiProtocolAbComparison({
        runId: 'run-kimi-protocol',
        config: config(),
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        evaluationTasks: [{ id: 'task-a', path: '/bench/task-a' }],
        reps: 1,
        taskRunner: async (input) => {
          runnerCalls += 1;
          const terminal = output(input.task.id, join(dir, 'unused-trace.jsonl'));
          delete terminal.cell.traceEventsPath;
          return terminal;
        },
        now: monotonicClock(),
        newId: idGenerator(),
      });

    const first = await run();
    assert.equal(first.summary.decision, 'invalid');
    assert.equal(runnerCalls, 1);
    const resumed = await run();
    assert.equal(resumed.summary.decision, 'invalid');
    assert.equal(runnerCalls, 1);
  });

  test('preserves provider infrastructure failures without requiring a request trace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-kimi-protocol-ab-infra-'));
    const systemPromptPath = join(dir, 'system-prompt.md');
    await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

    const result = await runKimiProtocolAbComparison({
      runId: 'run-kimi-protocol',
      config: config(),
      systemPromptPath,
      resultsJsonlPath: join(dir, 'results.jsonl'),
      evaluationTasks: [{ id: 'task-a', path: '/bench/task-a' }],
      reps: 1,
      taskRunner: async (input) => {
        const terminal = output(input.task.id, join(dir, 'unused-trace.jsonl'));
        terminal.harbor.reward = 0;
        terminal.cell.status = 'failed';
        terminal.cell.errorClass = 'provider_billing';
        delete terminal.cell.traceEventsPath;
        return terminal;
      },
      now: monotonicClock(),
      newId: idGenerator(),
    });

    assert.equal(result.summary.baseline.infraFailed, 1);
    assert.equal(result.summary.baseline.plumbingFailed, 0);
  });

  test('fails the smoke trace when a shared prompt/history segment changes', () => {
    const anthropic = trace('anthropic', 'sha256:message');
    const openai = trace('openai', 'sha256:different-message');
    assert.throws(
      () => compareKimiProtocolSmokeTrace(anthropic, openai),
      /shared request segment differs/,
    );
  });

  test('compares both protocol arms on the same Kimi provider connection', () => {
    const anthropic = trace('anthropic', 'sha256:message');
    const openai = trace('openai', 'sha256:message');
    anthropic.captures[0]!.providerId = 'kimi-coding-plan';
    openai.captures[0]!.providerId = 'kimi-coding-plan';

    const result = compareKimiProtocolSmokeTrace(anthropic, openai);

    assert.equal(result.onlyIntendedDifferences, true);
    assert.equal(result.anthropicProviderId, 'kimi-coding-plan');
    assert.equal(result.openaiProviderId, 'kimi-coding-plan');
  });

  test('fails the smoke trace when protocol arms use different provider connections', () => {
    const anthropic = trace('anthropic', 'sha256:message');
    const openai = trace('openai', 'sha256:message');
    anthropic.captures[0]!.providerId = 'anthropic';
    openai.captures[0]!.providerId = 'openai';

    assert.throws(
      () => compareKimiProtocolSmokeTrace(anthropic, openai),
      /provider connection differs/,
    );
  });

  test('fails the smoke trace when a later request changes its shared history', () => {
    const anthropic = trace('anthropic', 'sha256:message');
    const openai = trace('openai', 'sha256:message');
    appendContinuationCapture(anthropic, 'sha256:continuation');
    appendContinuationCapture(openai, 'sha256:different-continuation');

    assert.throws(
      () => compareKimiProtocolSmokeTrace(anthropic, openai),
      /shared request segment differs/,
    );
  });

  test('reports every matched request in a continuation smoke trace', () => {
    const anthropic = trace('anthropic', 'sha256:message');
    const openai = trace('openai', 'sha256:message');
    appendContinuationCapture(anthropic, 'sha256:continuation');
    appendContinuationCapture(openai, 'sha256:continuation');

    const result = compareKimiProtocolSmokeTrace(anthropic, openai);

    assert.equal(result.requestCount, 2);
    assert.equal(result.sharedSegmentCount, 6);
  });

  test('fails the smoke trace when continuation request counts differ', () => {
    const anthropic = trace('anthropic', 'sha256:message');
    const openai = trace('openai', 'sha256:message');
    appendContinuationCapture(anthropic, 'sha256:continuation');

    assert.throws(() => compareKimiProtocolSmokeTrace(anthropic, openai), /request count differs/);
  });

  test('fails the smoke trace when continuation request steps differ', () => {
    const anthropic = trace('anthropic', 'sha256:message');
    const openai = trace('openai', 'sha256:message');
    appendContinuationCapture(anthropic, 'sha256:continuation');
    appendContinuationCapture(openai, 'sha256:continuation');
    openai.captures[1]!.step = 2;

    assert.throws(() => compareKimiProtocolSmokeTrace(anthropic, openai), /request 2 step differs/);
  });

  test('fails the smoke trace when a non-protocol request parameter changes', () => {
    const anthropic = trace('anthropic', 'sha256:message');
    const openai = trace('openai', 'sha256:message');
    Object.assign(anthropic.captures[0]!, {
      requestPayloadWithoutProviderOptionsHash: 'sha256:max-output-131072',
    });
    Object.assign(openai.captures[0]!, {
      requestPayloadWithoutProviderOptionsHash: 'sha256:max-output-missing',
    });

    assert.throws(
      () => compareKimiProtocolSmokeTrace(anthropic, openai),
      /non-protocol request parameters differ/,
    );
  });

  test('fails the smoke trace when full non-protocol request evidence is missing', () => {
    const anthropic = trace('anthropic', 'sha256:message');
    const openai = trace('openai', 'sha256:message');
    Object.assign(anthropic.captures[0]!, { requestPayloadWithoutProviderOptionsHash: undefined });
    Object.assign(openai.captures[0]!, { requestPayloadWithoutProviderOptionsHash: undefined });

    assert.throws(
      () => compareKimiProtocolSmokeTrace(anthropic, openai),
      /missing non-protocol request parameter evidence/,
    );
  });

  test('aggregates request-level usage without filling missing provider values', () => {
    const metrics = summarizeKimiProtocolRequestMetrics([
      trace('anthropic', 'sha256:message'),
      {
        ...trace('anthropic', 'sha256:message'),
        attempts: [
          {
            ...trace('anthropic', 'sha256:message').attempts[0]!,
            attemptId: 'attempt-2',
            inputTokens: undefined,
            cacheReadInputTokens: undefined,
            cacheMissInputTokens: undefined,
            cacheWriteInputTokens: undefined,
            outputTokens: undefined,
            reasoningTokens: undefined,
          },
        ],
      },
    ]);
    assert.equal(metrics.requests, 2);
    assert.equal(metrics.completeUsageRequests, 1);
    assert.equal(metrics.missingUsageRequests, 1);
    assert.equal(metrics.inputTokens, null);
    assert.equal(metrics.cacheWriteInputTokens, null);
    assert.equal(metrics.reasoningTokens, null);
    assert.equal(metrics.totalLatencyMs, 4);
    assert.equal(metrics.meanLatencyMs, 2);
  });

  test('treats missing cache-write or reasoning usage as incomplete telemetry', () => {
    const missingCacheWrite = trace('anthropic', 'sha256:message');
    missingCacheWrite.attempts[0] = {
      ...missingCacheWrite.attempts[0]!,
      cacheWriteInputTokens: undefined,
    };
    const missingReasoning = trace('openai', 'sha256:message');
    missingReasoning.attempts[0] = {
      ...missingReasoning.attempts[0]!,
      reasoningTokens: undefined,
    };

    const metrics = summarizeKimiProtocolRequestMetrics([missingCacheWrite, missingReasoning]);

    assert.equal(metrics.requests, 2);
    assert.equal(metrics.completeUsageRequests, 0);
    assert.equal(metrics.missingUsageRequests, 2);
  });

  test('never recommends changing the default when correctness or telemetry differs', () => {
    const metrics = summarizeKimiProtocolRequestMetrics([trace('openai', 'sha256:message')]);
    const fast = { ...metrics, totalLatencyMs: 100, meanLatencyMs: 100 };
    const slow = { ...metrics, totalLatencyMs: 200, meanLatencyMs: 200 };
    assert.equal(
      recommendKimiProtocolDefault({
        conclusive: true,
        correctnessUnchanged: true,
        hasSuccessfulPair: true,
        completeTelemetry: true,
        anthropic: slow,
        openai: fast,
      }),
      'openai_candidate',
    );
    assert.equal(
      recommendKimiProtocolDefault({
        conclusive: true,
        correctnessUnchanged: false,
        hasSuccessfulPair: true,
        completeTelemetry: true,
        anthropic: slow,
        openai: fast,
      }),
      'keep_anthropic_default',
    );
    assert.equal(
      recommendKimiProtocolDefault({
        conclusive: true,
        correctnessUnchanged: true,
        hasSuccessfulPair: true,
        completeTelemetry: false,
        anthropic: slow,
        openai: fast,
      }),
      'keep_anthropic_default',
    );
  });

  test('never recommends changing the default without a successful task pair', () => {
    const fast = summarizeKimiProtocolRequestMetrics([trace('openai', 'sha256:message')]);
    const slow = { ...fast, totalLatencyMs: 3, meanLatencyMs: 3 };
    const input = {
      conclusive: true,
      correctnessUnchanged: true,
      hasSuccessfulPair: false,
      completeTelemetry: true,
      anthropic: slow,
      openai: fast,
    };

    assert.equal(recommendKimiProtocolDefault(input), 'keep_anthropic_default');
  });

  test('does not treat lower per-request latency as an end-to-end improvement', () => {
    const base = summarizeKimiProtocolRequestMetrics([trace('anthropic', 'sha256:message')]);
    const anthropic = { ...base, requests: 1, totalLatencyMs: 100, meanLatencyMs: 100 };
    const openai = { ...base, requests: 10, totalLatencyMs: 900, meanLatencyMs: 90 };

    assert.equal(
      recommendKimiProtocolDefault({
        conclusive: true,
        correctnessUnchanged: true,
        hasSuccessfulPair: true,
        completeTelemetry: true,
        anthropic,
        openai,
      }),
      'keep_anthropic_default',
    );
  });

  test('does not recommend a token improvement when total latency regresses', () => {
    const base = summarizeKimiProtocolRequestMetrics([trace('anthropic', 'sha256:message')]);
    const anthropic = { ...base, totalTokens: 100, totalLatencyMs: 100 };
    const openai = { ...base, totalTokens: 90, totalLatencyMs: 1_000 };

    assert.equal(
      recommendKimiProtocolDefault({
        conclusive: true,
        correctnessUnchanged: true,
        hasSuccessfulPair: true,
        completeTelemetry: true,
        anthropic,
        openai,
      }),
      'keep_anthropic_default',
    );
  });

  test('does not recommend a sub-percent latency improvement', () => {
    const base = summarizeKimiProtocolRequestMetrics([trace('anthropic', 'sha256:message')]);
    const anthropic = { ...base, totalLatencyMs: 1_000 };
    const openai = { ...base, totalLatencyMs: 999 };

    assert.equal(
      recommendKimiProtocolDefault({
        conclusive: true,
        correctnessUnchanged: true,
        hasSuccessfulPair: true,
        completeTelemetry: true,
        anthropic,
        openai,
      }),
      'keep_anthropic_default',
    );
  });

  test('does not recommend a one-millisecond latency improvement', () => {
    const base = summarizeKimiProtocolRequestMetrics([trace('anthropic', 'sha256:message')]);
    const anthropic = { ...base, totalLatencyMs: 100 };
    const openai = { ...base, totalLatencyMs: 99 };

    assert.equal(
      recommendKimiProtocolDefault({
        conclusive: true,
        correctnessUnchanged: true,
        hasSuccessfulPair: true,
        completeTelemetry: true,
        anthropic,
        openai,
      }),
      'keep_anthropic_default',
    );
  });
});

function config(): Config {
  return {
    id: 'cfg-kimi-protocol',
    backend: 'ai-sdk',
    llmConnectionSlug: 'kimi-coding-plan',
    model: 'k3',
  };
}

function output(taskId: string, traceEventsPath: string): TaskRunOutput {
  return {
    harbor: {
      reward: 1,
      verifier: {
        outcome: 'passed',
        attempts: [{ attempt: 1, classification: 'passed', durationMs: 1, reward: 1 }],
      },
    },
    cell: {
      schemaVersion: 1,
      status: 'completed',
      runtimeEventsPath: join(traceEventsPath, '..', 'runtime-events.jsonl'),
      traceEventsPath,
      promptHash: hashSystemPrompt('fixed prompt\n'),
      tokenSummary: tokenSummary({
        input: 12,
        output: 3,
        reasoning: 2,
        total: 15,
        costUsd: 0,
      }),
      toolSummary: {
        providerVisibleToolCount: 1,
        actualToolCalls: 1,
        actualToolNames: ['Read'],
        actualToolCallCounts: { Read: 1 },
      },
      steps: 1,
      durationMs: 2,
      startedAt: 1,
      finishedAt: 3,
      runtimeRefs: {
        invocationId: `inv-${taskId}`,
        sessionId: `session-${taskId}`,
        runId: `run-${taskId}`,
        turnId: `turn-${taskId}`,
      },
    },
  };
}

async function writeTrace(
  path: string,
  protocol: string | undefined,
  taskId?: string,
  messageHash = 'sha256:message',
): Promise<void> {
  const provider = protocol === 'openai-chat' ? 'openai' : 'anthropic';
  const identity = taskId
    ? {
        runId: `run-${taskId}`,
        sessionId: `session-${taskId}`,
        turnId: `turn-${taskId}`,
      }
    : undefined;
  const value = trace(provider, messageHash, identity);
  if (provider === 'openai') {
    value.attempts[0] = {
      ...value.attempts[0]!,
      completedAt: 2,
      latencyMs: 1,
    };
  }
  const events = [
    {
      type: 'provider_request_captured',
      id: value.captures[0]!.captureId,
      runId: value.identity!.runId,
      sessionId: value.identity!.sessionId,
      turnId: value.identity!.turnId,
      ts: 1,
      data: value.captures[0],
    },
    {
      type: 'provider_request_attempt_recorded',
      id: value.attempts[0]!.attemptId,
      runId: value.identity!.runId,
      sessionId: value.identity!.sessionId,
      turnId: value.identity!.turnId,
      ts: 3,
      data: value.attempts[0],
    },
  ];
  await writeFile(path, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
}

async function writeContinuationTrace(
  path: string,
  protocol: string | undefined,
  taskId: string,
): Promise<ProviderRequestTraceIdentity> {
  const provider = protocol === 'openai-chat' ? 'openai' : 'anthropic';
  const sessionId = `session-${taskId}`;
  const rows: Record<string, unknown>[] = [];
  let finalIdentity: ProviderRequestTraceIdentity | undefined;
  for (const turn of [1, 2]) {
    const identity = {
      runId: `run-${taskId}-${turn}`,
      sessionId,
      turnId: `turn-${taskId}-${turn}`,
    };
    finalIdentity = identity;
    const value = trace(provider, `sha256:message-${turn}`, identity);
    const traceId = `trace-${provider}-${turn}`;
    const captureId = `capture-${provider}-${turn}`;
    const artifactId = `artifact-${provider}-${turn}`;
    const attemptId = `attempt-${provider}-${turn}`;
    const capture = {
      ...value.captures[0]!,
      traceId,
      captureId,
      artifactId,
    };
    const attempt = {
      ...value.attempts[0]!,
      traceId,
      attemptId,
      captureId,
      captureArtifactId: artifactId,
    };
    rows.push(
      {
        type: 'provider_request_captured',
        id: captureId,
        ...identity,
        ts: turn * 10,
        data: capture,
      },
      {
        type: 'provider_request_attempt_recorded',
        id: attemptId,
        ...identity,
        ts: turn * 10 + 2,
        data: attempt,
      },
    );
  }
  await writeFile(path, `${rows.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
  return finalIdentity!;
}

function trace(
  provider: string,
  messageHash: string,
  identity: ProviderRequestTraceIdentity = {
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
  },
): ProviderRequestTraceAnalysis {
  const providerOptionHash =
    provider === 'openai' ? 'sha256:openai-options' : 'sha256:anthropic-options';
  return {
    identity,
    traceId: `trace-${provider}`,
    captures: [
      {
        schemaVersion: 2,
        traceId: `trace-${provider}`,
        captureId: `capture-${provider}`,
        artifactId: `artifact-${provider}`,
        turnId: identity.turnId,
        step: 0,
        providerId: 'kimi-coding-plan',
        modelId: 'k3',
        requestHash: `sha256:request-${provider}`,
        requestPayloadWithoutProviderOptionsHash: 'sha256:shared-request',
        requestBytes: 100,
        segments: [
          {
            kind: 'system_prompt',
            index: 0,
            cacheable: true,
            hash: 'sha256:system',
            bytes: 10,
          },
          {
            kind: 'tool_schema',
            index: 0,
            cacheable: true,
            hash: 'sha256:tools',
            bytes: 20,
          },
          {
            kind: 'message',
            index: 0,
            role: 'user',
            cacheable: true,
            hash: messageHash,
            bytes: 30,
          },
          {
            kind: 'provider_options',
            index: 0,
            cacheable: false,
            hash: providerOptionHash,
            bytes: 15,
          },
        ],
      },
    ],
    attempts: [
      {
        traceId: `trace-${provider}`,
        attemptId: `attempt-${provider}`,
        turnId: identity.turnId,
        step: 0,
        attempt: 1,
        captureId: `capture-${provider}`,
        captureArtifactId: `artifact-${provider}`,
        providerId: 'kimi-coding-plan',
        modelId: 'k3',
        requestHash: `sha256:request-${provider}`,
        requestBytes: 100,
        segments: [
          {
            kind: 'system_prompt',
            index: 0,
            cacheable: true,
            hash: 'sha256:system',
            bytes: 10,
          },
          {
            kind: 'tool_schema',
            index: 0,
            cacheable: true,
            hash: 'sha256:tools',
            bytes: 20,
          },
          {
            kind: 'message',
            index: 0,
            role: 'user',
            cacheable: true,
            hash: messageHash,
            bytes: 30,
          },
          {
            kind: 'provider_options',
            index: 0,
            cacheable: false,
            hash: providerOptionHash,
            bytes: 15,
          },
        ],
        startedAt: 1,
        completedAt: 3,
        status: 'completed',
        finishReason: 'stop',
        latencyMs: 2,
        timeToFirstTokenMs: 1,
        inputTokens: 12,
        cacheReadInputTokens: 4,
        cacheReadInputSource: 'provider',
        cacheMissInputTokens: 8,
        cacheMissInputSource: 'derived',
        cacheWriteInputTokens: 1,
        cacheWriteInputSource: 'provider',
        outputTokens: 3,
        reasoningTokens: 2,
      },
    ],
    diagnostics: [],
  };
}

function appendContinuationCapture(value: ProviderRequestTraceAnalysis, messageHash: string): void {
  const capture = structuredClone(value.captures[0]!);
  capture.captureId = `${capture.captureId}-continuation`;
  capture.artifactId = `${capture.artifactId}-continuation`;
  capture.step = 1;
  const message = capture.segments.find((segment) => segment.kind === 'message');
  assert.ok(message);
  message.hash = messageHash;
  value.captures.push(capture);
}

function idGenerator(): () => string {
  let value = 0;
  return () => `id-${++value}`;
}

function monotonicClock(): () => number {
  let value = 100;
  return () => ++value;
}
