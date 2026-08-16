import assert from 'node:assert/strict';
import test from 'node:test';
import type { OperationHandlerMap } from '../server/operation-dispatcher.js';
import { HostHostedExecutionRunner } from '../server/hosted-execution-runner.js';

test('hosted execution reads usage only after execution residencies settle', async () => {
  const residency = deferred();
  let usageRead = false;
  const runner = new HostHostedExecutionRunner({
    handlers: handlers({
      usage: () => {
        usageRead = true;
        return usageSummary();
      },
    }),
    context: context(),
    requestDrain: () => {},
    waitForExecutionResidencies: () => residency.promise,
    waitForAllResidencies: () => residency.promise,
    now: sequence(100, 200),
  });

  const execution = runner.run(input(), new AbortController().signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(usageRead, false);
  residency.resolve();

  assert.deepEqual(await execution, {
    executionId: ID,
    kind: 'settled',
    status: 'completed',
    usage: {
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      reasoningTokens: 1,
      totalTokens: 18,
    },
    costUsd: 0.25,
  });
  assert.equal(usageRead, true);
});

test('incomplete usage preserves its fixed safe cause', async () => {
  const usage = usageSummary();
  usage.provenance.coverage.usageMissingAttempts = 1;
  const runner = new HostHostedExecutionRunner({
    handlers: handlers({ usage: () => usage }),
    context: context(),
    requestDrain: () => {},
    waitForExecutionResidencies: async () => {},
    waitForAllResidencies: async () => {},
  });

  const result = await runner.run(input(), new AbortController().signal);

  assert.equal(result.failureReason, 'Runtime Host usage did not settle: missing_attempt_usage');
});

test('abort after terminal completion preserves the completed result', async () => {
  const result = await runWithAbortAfterTerminal();
  assert.equal(result.kind, 'settled');
  if (result.kind === 'settled') assert.equal(result.status, 'completed');
});

test('abort after terminal failure preserves the failure reason', async () => {
  const result = await runWithAbortAfterTerminal(() => terminalTurn('failed'));
  assert.equal(result.kind, 'settled');
  if (result.kind !== 'settled') return;
  assert.equal(result.status, 'failed');
  assert.equal(result.failureReason, 'subject failed');
});

async function runWithAbortAfterTerminal(query?: () => unknown) {
  const abort = new AbortController();
  const residency = deferred();
  const settling = deferred();
  const runner = new HostHostedExecutionRunner({
    handlers: handlers(query ? { query } : {}),
    context: context(),
    requestDrain: () => {},
    waitForExecutionResidencies: () => {
      settling.resolve();
      return residency.promise;
    },
    waitForAllResidencies: () => residency.promise,
    now: sequence(100, 200),
  });

  const execution = runner.run(input(), abort.signal);
  await settling.promise;
  abort.abort();
  residency.resolve();

  return execution;
}

test('hosted execution cancellation drains the Host and waits for canonical stop', async () => {
  const abort = new AbortController();
  const started = deferred();
  let drains = 0;
  let stops = 0;
  const runner = new HostHostedExecutionRunner({
    handlers: handlers({
      query: async () => {
        started.resolve();
        return runningTurn();
      },
      stop: async () => {
        stops += 1;
        return terminalTurn('cancelled');
      },
    }),
    context: context(),
    requestDrain: () => {
      drains += 1;
    },
    waitForExecutionResidencies: async () => {},
    waitForAllResidencies: async () => {},
    now: sequence(100, 200),
  });

  const execution = runner.run(input(), abort.signal);
  await started.promise;
  abort.abort();
  const result = await execution;

  assert.equal(result.kind, 'settled');
  if (result.kind === 'settled') assert.equal(result.status, 'cancelled');
  assert.equal(stops, 1);
  assert.equal(drains, 1);
});

test('hosted execution cancellation before Turn admission starts no Turn', async () => {
  const abort = new AbortController();
  const creating = deferred();
  const releaseCreate = deferred();
  let turnStarts = 0;
  const runner = new HostHostedExecutionRunner({
    handlers: handlers({
      create: async () => {
        creating.resolve();
        await releaseCreate.promise;
      },
      start: () => {
        turnStarts += 1;
      },
    }),
    context: context(),
    requestDrain: () => {},
    waitForExecutionResidencies: async () => {},
    waitForAllResidencies: async () => {},
  });

  const execution = runner.run(input(), abort.signal);
  await creating.promise;
  abort.abort();
  releaseCreate.resolve();

  assert.equal((await execution).kind, 'indeterminate');
  assert.equal(turnStarts, 0);
});

test('hosted execution cancellation remains active while Runtime continuations settle', async () => {
  const abort = new AbortController();
  const residency = deferred();
  const settling = deferred();
  const started = deferred();
  let drains = 0;
  const runner = new HostHostedExecutionRunner({
    handlers: handlers({
      query: async () => {
        started.resolve();
        return runningTurn();
      },
    }),
    context: context(),
    requestDrain: () => {
      drains += 1;
    },
    waitForExecutionResidencies: () => {
      throw new Error('cancelled execution must wait for all residencies');
    },
    waitForAllResidencies: () => {
      settling.resolve();
      return residency.promise;
    },
  });

  const execution = runner.run(input(), abort.signal);
  await started.promise;
  abort.abort();
  await settling.promise;
  residency.resolve();

  const result = await execution;
  assert.equal(result.kind, 'settled');
  if (result.kind !== 'settled') return;
  assert.equal(result.status, 'cancelled');
  assert.equal(drains, 1);
});

const ID = '00000000-0000-4000-8000-000000000001';

function input() {
  return {
    executionId: ID,
    session: {
      workspace: { kind: 'host_path' as const, path: '/workspace' },
      modelTarget: { kind: 'explicit' as const, connectionSlug: 'env-openai', model: 'model' },
    },
    content: { text: 'solve' },
  };
}

function handlers(
  overrides: {
    create?: () => unknown;
    start?: () => unknown;
    query?: () => unknown;
    stop?: () => unknown;
    usage?: () => unknown;
  } = {},
) {
  return {
    'session.create': async () => {
      await overrides.create?.();
      return { ok: true, result: { kind: 'created', session: {} } };
    },
    'turn.start': async () => {
      await overrides.start?.();
      return {
        ok: true,
        result: { kind: 'started', turn: runningTurn(), skillInvocation: emptySkillInvocation() },
      };
    },
    'turn.query': async () => ({
      ok: true,
      result: (await overrides.query?.()) ?? terminalTurn('completed'),
    }),
    'turn.stop': async () => ({
      ok: true,
      result: (await overrides.stop?.()) ?? terminalTurn('cancelled'),
    }),
    'usage.query': async () => ({
      ok: true,
      result: (await overrides.usage?.()) ?? usageSummary(),
    }),
  } as unknown as Pick<
    OperationHandlerMap,
    'session.create' | 'turn.start' | 'turn.query' | 'turn.stop' | 'usage.query'
  >;
}

function runningTurn() {
  return {
    sessionId: ID,
    turnId: ID,
    runId: ID,
    status: 'running' as const,
    maxSteps: 100,
    startedAt: 100,
  };
}

function terminalTurn(status: 'completed' | 'failed' | 'cancelled') {
  return {
    ...runningTurn(),
    status,
    completedAt: 150,
    ...(status === 'failed' ? { failureClass: 'subject failed' } : {}),
  };
}

function usageSummary() {
  return {
    kind: 'summary' as const,
    summary: {
      range: { from: 100, to: 200 },
      totalRequests: 1,
      totalCostUsd: 0.25,
      totalTokens: {
        input: 11,
        output: 7,
        cacheMiss: 8,
        cacheRead: 3,
        cacheWrite: 2,
        reasoning: 1,
        total: 18,
      },
      cacheHitRequests: 1,
      cacheCreateRequests: 1,
      errorRequests: 0,
    },
    provenance: {
      coverage: {
        attempts: 1,
        pricedAttempts: 1,
        unpricedAttempts: 0,
        usageReportedAttempts: 1,
        usagePartialAttempts: 0,
        usageMissingAttempts: 0,
      },
      legacyRecords: 0,
      unreadableRecords: 0,
      pendingRepairs: 0,
    },
  };
}

function emptySkillInvocation() {
  return { loaded: [], failed: [], receipts: [] };
}

function context() {
  return {
    hostEpoch: 'host-epoch',
    connectionId: 'hosted-execution',
    surface: 'run' as const,
    principal: 'runtime_host' as const,
    acquireResidency: () => ({ release() {} }),
  };
}

function deferred() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((settle) => {
      resolve = settle;
    }),
    resolve: () => resolve(),
  };
}

function sequence(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}
