import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Config } from '../contracts.js';
import {
  FixedPromptBudgetExhaustedError,
  hashSystemPrompt,
  type TaskRunInput,
  type TaskRunOutput,
} from '../fixed-prompt-controller.js';
import { runRuntimePolicyAbLifecycle } from '../runtime-policy-ab-lifecycle.js';
import { contextBudgetSummary } from './helpers/ab-summary-fixtures.js';
import { tokenSummary } from './helpers/cell-output-fixtures.js';
import type { RuntimePolicyAbExecutionProfile } from '../runtime-policy-ab-profile.js';

const config: Config = {
  id: 'runtime-ab',
  backend: 'fake',
  llmConnectionSlug: 'deepseek',
  model: 'deepseek/deepseek-v4-flash',
};

const executionProfile: RuntimePolicyAbExecutionProfile = {
  schemaVersion: 1,
  id: 'test-profile',
  llmConnectionSlug: 'deepseek',
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek/deepseek-v4-flash',
  pricing: {
    inputUsdPer1M: 1,
    outputUsdPer1M: 1,
    cacheReadUsdPer1M: 0,
    cacheWriteUsdPer1M: 0,
    source: 'test-profile',
  },
  taskBudgetSec: 1800,
  harborTimeoutMs: 2_100_000,
  observedCostStopUsd: 20,
  maxConcurrentAttempts: 2,
};

test('same-run pilot checkpoint gates full execution and resumes completed state', async () => {
  await withDir(async (dir) => {
    const promptPath = join(dir, 'prompt.md');
    await writeFile(promptPath, 'shared prompt\n', 'utf8');
    const calls: string[] = [];
    const input = {
      runId: 'run-1',
      runRoot: dir,
      manifestFingerprint: 'sha256:manifest',
      config,
      systemPromptPath: promptPath,
      resultsJsonlPath: join(dir, 'results.jsonl'),
      pilotTasks: [{ id: 'pilot', path: '/tasks/pilot' }],
      evaluationTasks: [{ id: 'full', path: '/tasks/full' }],
      fullReps: 2,
      arms: [
        { id: 'prune/off', contextEnv: { MAKA_CONTEXT_BUDGET: 'off' } },
        { id: 'prune-on', contextEnv: { MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on' } },
      ] as const,
      executionProfile,
      harborRunner: async (runInput: TaskRunInput) => {
        calls.push(runInput.roundId);
        return output(runInput, runInput.agentEnv?.MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE === 'on');
      },
    };

    const first = await runRuntimePolicyAbLifecycle(input);
    assert.equal(first.status, 'full_completed');
    assert.equal(first.pilot?.candidate.contextBudget?.activatedAttempts, 1);
    assert.equal(calls.length, 6);
    assert.equal(
      calls.every((roundId) => roundId.startsWith('pilot-') || roundId.startsWith('full-')),
      true,
    );

    const resumed = await runRuntimePolicyAbLifecycle(input);
    assert.equal(resumed.status, 'full_completed');
    assert.equal(calls.length, 6);
  });
});

test('rebuilds a legacy terminal lifecycle summary from WAL before returning it', async () => {
  await withDir(async (dir) => {
    const promptPath = join(dir, 'prompt.md');
    const statePath = join(dir, 'runtime-policy-ab-state.json');
    await writeFile(promptPath, 'shared prompt\n', 'utf8');
    const calls: string[] = [];
    const input = {
      runId: 'run-1',
      runRoot: dir,
      manifestFingerprint: 'sha256:manifest',
      config,
      systemPromptPath: promptPath,
      resultsJsonlPath: join(dir, 'results.jsonl'),
      pilotTasks: [{ id: 'pilot', path: '/tasks/pilot' }],
      evaluationTasks: [{ id: 'full', path: '/tasks/full' }],
      fullReps: 2,
      arms: [
        { id: 'prune/off', contextEnv: { MAKA_CONTEXT_BUDGET: 'off' } },
        { id: 'prune-on', contextEnv: { MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on' } },
      ] as const,
      executionProfile,
      harborRunner: async (runInput: TaskRunInput) => {
        calls.push(runInput.roundId);
        return output(runInput, runInput.agentEnv?.MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE === 'on');
      },
    };
    await runRuntimePolicyAbLifecycle(input);
    const wal = await readFile(input.resultsJsonlPath, 'utf8');
    const walEvents = wal
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>);
    const firstFullBaseline = walEvents.find(
      (event) => event.roundId === 'full-ab-prune-off-r0-full',
    );
    assert.ok(firstFullBaseline);
    const staleRetry = {
      ...firstFullBaseline,
      id: 'stale-infra-before-successful-retry',
      type: 'task_infra_failed',
      status: 'infra_failed',
      passed: false,
      scored: false,
      eligible: false,
      errorClass: 'network',
      error: 'transient failure before retry',
    };
    const legacy = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, any>;
    legacy.schemaVersion = 'maka.runtime_policy_ab.lifecycle.v1';
    legacy.status = 'invalid';
    legacy.reason = 'asymmetric_budget_exhaustion';
    for (const summary of [legacy.pilot, legacy.full]) {
      delete summary.baseline.attestationWarnings;
      delete summary.candidate.attestationWarnings;
      delete summary.taskLevel.excludedTaskIds;
      delete summary.pairedAttempts.evaluatedPairs;
      delete summary.pairedAttempts.excludedPairIds;
    }
    await writeFile(statePath, `${JSON.stringify(legacy)}\n`, 'utf8');

    const ambiguousLegacyTimeout = {
      ...walEvents[0],
      type: 'task_plumbing_failed',
      status: 'plumbing_failed',
      passed: false,
      scored: false,
      eligible: false,
      errorClass: 'missing_execution_identity',
      error:
        'Harbor cell did not attest the connection, model, prompt, and pricing profile that executed',
    };
    await writeFile(
      input.resultsJsonlPath,
      `${[ambiguousLegacyTimeout, ...walEvents.slice(1)].map((event) => JSON.stringify(event)).join('\n')}\n`,
      'utf8',
    );
    await assert.rejects(
      runRuntimePolicyAbLifecycle(input),
      /legacy missing-identity event .* has no authoritative outcome/,
    );

    const staleAmbiguousRetry = {
      ...firstFullBaseline,
      id: 'stale-ambiguous-before-successful-retry',
      type: 'task_plumbing_failed',
      status: 'plumbing_failed',
      passed: false,
      scored: false,
      eligible: false,
      errorClass: 'missing_execution_identity',
      error: 'ambiguous legacy result superseded by a successful retry',
    };
    const unrelatedAmbiguousEvent = {
      ...staleAmbiguousRetry,
      id: 'unrelated-run-ambiguous-event',
      runId: 'another-run',
    };
    await writeFile(
      input.resultsJsonlPath,
      `${JSON.stringify(unrelatedAmbiguousEvent)}\n${JSON.stringify(staleAmbiguousRetry)}\n${JSON.stringify(staleRetry)}\n${wal}`,
      'utf8',
    );

    const resumed = await runRuntimePolicyAbLifecycle(input);
    assert.equal(resumed.schemaVersion, 'maka.runtime_policy_ab.lifecycle.v2');
    assert.equal(resumed.status, 'full_completed');
    assert.equal(resumed.reason, undefined);
    assert.deepEqual(resumed.full?.pairedAttempts.excludedPairIds, []);
    assert.equal(calls.length, 6);
  });
});

test('pilot without candidate activation does not launch full execution', async () => {
  await withDir(async (dir) => {
    const promptPath = join(dir, 'prompt.md');
    await writeFile(promptPath, 'shared prompt\n', 'utf8');
    const calls: string[] = [];
    const state = await runRuntimePolicyAbLifecycle({
      runId: 'run-1',
      runRoot: dir,
      manifestFingerprint: 'sha256:manifest',
      config,
      systemPromptPath: promptPath,
      resultsJsonlPath: join(dir, 'results.jsonl'),
      pilotTasks: [{ id: 'pilot', path: '/tasks/pilot' }],
      evaluationTasks: [{ id: 'full', path: '/tasks/full' }],
      fullReps: 2,
      arms: [
        { id: 'prune-off', contextEnv: { MAKA_CONTEXT_BUDGET: 'off' } },
        { id: 'prune-on', contextEnv: { MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on' } },
      ],
      executionProfile,
      harborRunner: async (runInput) => {
        calls.push(runInput.roundId);
        return output(runInput, false);
      },
    });

    assert.equal(state.status, 'pilot_not_cleared');
    assert.equal(state.reason, 'pilot_candidate_not_activated');
    assert.equal(calls.length, 2);
  });
});

test('pilot candidate pass against an attested baseline timeout can launch full execution', async () => {
  await withDir(async (dir) => {
    const promptPath = join(dir, 'prompt.md');
    await writeFile(promptPath, 'shared prompt\n', 'utf8');
    const calls: string[] = [];
    const state = await runRuntimePolicyAbLifecycle({
      runId: 'run-1',
      runRoot: dir,
      manifestFingerprint: 'sha256:manifest',
      config,
      systemPromptPath: promptPath,
      resultsJsonlPath: join(dir, 'results.jsonl'),
      pilotTasks: [{ id: 'pilot', path: '/tasks/pilot' }],
      evaluationTasks: [{ id: 'full', path: '/tasks/full' }],
      fullReps: 2,
      arms: [
        { id: 'prune-off', contextEnv: { MAKA_CONTEXT_BUDGET: 'off' } },
        { id: 'prune-on', contextEnv: { MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on' } },
      ],
      executionProfile,
      harborRunner: async (runInput) => {
        calls.push(runInput.roundId);
        const candidate = runInput.agentEnv?.MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE === 'on';
        if (runInput.roundId.startsWith('pilot-') && !candidate) {
          throw new FixedPromptBudgetExhaustedError('pilot budget exhausted', undefined, {
            executionIdentity: {
              llmConnectionSlug: 'deepseek',
              model: 'deepseek-v4-flash',
              systemPromptHash: hashSystemPrompt(runInput.systemPrompt),
              pricingProfile: 'test-profile',
              agentTools: false,
            },
            tokenSummary: tokenSummary({
              input: 4,
              output: 6,
              reasoning: 0,
              total: 10,
              costUsd: 0.01,
            }),
          });
        }
        return output(runInput, candidate);
      },
    });

    assert.equal(state.status, 'full_completed');
    assert.equal(state.pilot?.baseline.budgetExhausted, 1);
    assert.equal(state.pilot?.candidate.passed, 1);
    assert.equal(calls.length, 6);
  });
});

test('pilot records an unattested baseline timeout warning and launches full execution', async () => {
  await withDir(async (dir) => {
    const promptPath = join(dir, 'prompt.md');
    await writeFile(promptPath, 'shared prompt\n', 'utf8');
    const calls: string[] = [];
    const state = await runRuntimePolicyAbLifecycle({
      runId: 'run-1',
      runRoot: dir,
      manifestFingerprint: 'sha256:manifest',
      config,
      systemPromptPath: promptPath,
      resultsJsonlPath: join(dir, 'results.jsonl'),
      pilotTasks: [{ id: 'pilot', path: '/tasks/pilot' }],
      evaluationTasks: [{ id: 'full', path: '/tasks/full' }],
      fullReps: 2,
      arms: [
        { id: 'prune-off', contextEnv: { MAKA_CONTEXT_BUDGET: 'off' } },
        { id: 'prune-on', contextEnv: { MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on' } },
      ],
      executionProfile,
      harborRunner: async (runInput) => {
        calls.push(runInput.roundId);
        const candidate = runInput.agentEnv?.MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE === 'on';
        if (!candidate) throw new FixedPromptBudgetExhaustedError('pilot budget exhausted');
        return output(runInput, true);
      },
    });

    assert.equal(state.status, 'full_completed');
    assert.equal(state.pilot?.baseline.attestationWarnings, 1);
    assert.equal(state.pilot?.baseline.budgetExhausted, 1);
    assert.equal(calls.length, 6);
  });
});

test('pilot preserves candidate activation from an unattested timeout', async () => {
  await withDir(async (dir) => {
    const promptPath = join(dir, 'prompt.md');
    await writeFile(promptPath, 'shared prompt\n', 'utf8');
    const calls: string[] = [];
    const state = await runRuntimePolicyAbLifecycle({
      runId: 'run-1',
      runRoot: dir,
      manifestFingerprint: 'sha256:manifest',
      config,
      systemPromptPath: promptPath,
      resultsJsonlPath: join(dir, 'results.jsonl'),
      pilotTasks: [{ id: 'pilot', path: '/tasks/pilot' }],
      evaluationTasks: [{ id: 'full', path: '/tasks/full' }],
      fullReps: 2,
      arms: [
        { id: 'prune-off', contextEnv: { MAKA_CONTEXT_BUDGET: 'off' } },
        { id: 'prune-on', contextEnv: { MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on' } },
      ],
      executionProfile,
      harborRunner: async (runInput) => {
        calls.push(runInput.roundId);
        const candidate = runInput.agentEnv?.MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE === 'on';
        if (runInput.roundId.startsWith('pilot-') && candidate) {
          const { executionIdentity: _, ...cellOutput } = output(runInput, true).cell;
          throw new FixedPromptBudgetExhaustedError('pilot budget exhausted', undefined, {
            cellOutput,
          });
        }
        return output(runInput, candidate);
      },
    });

    assert.equal(state.status, 'full_completed');
    assert.equal(state.pilot?.candidate.attestationWarnings, 1);
    assert.equal(state.pilot?.candidate.contextBudget?.activatedAttempts, 1);
    assert.equal(calls.length, 6);
  });
});

test('maps an invalid full summary to invalid lifecycle status', async () => {
  await withDir(async (dir) => {
    const promptPath = join(dir, 'prompt.md');
    await writeFile(promptPath, 'shared prompt\n', 'utf8');
    const state = await runRuntimePolicyAbLifecycle({
      runId: 'run-1',
      runRoot: dir,
      manifestFingerprint: 'sha256:manifest',
      config,
      systemPromptPath: promptPath,
      resultsJsonlPath: join(dir, 'results.jsonl'),
      pilotTasks: [{ id: 'pilot', path: '/tasks/pilot' }],
      evaluationTasks: [{ id: 'full', path: '/tasks/full' }],
      fullReps: 2,
      arms: [
        { id: 'prune-off', contextEnv: { MAKA_CONTEXT_BUDGET: 'off' } },
        { id: 'prune-on', contextEnv: { MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on' } },
      ],
      executionProfile,
      harborRunner: async (runInput) => {
        const result = output(
          runInput,
          runInput.agentEnv?.MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE === 'on',
        );
        if (runInput.roundId.startsWith('full-')) {
          return {
            ...result,
            cell: {
              ...result.cell,
              executionIdentity: { ...result.cell.executionIdentity!, model: 'wrong-model' },
            },
          };
        }
        return result;
      },
    });

    assert.equal(state.full?.decision, 'invalid');
    assert.equal(state.status, 'invalid');
    assert.equal(state.reason, 'plumbing_failure_observed');
  });
});

function output(input: TaskRunInput, activated: boolean): TaskRunOutput {
  return {
    harbor: { reward: 1 },
    cell: {
      schemaVersion: 1,
      status: 'completed',
      promptHash: hashSystemPrompt(input.systemPrompt),
      executionIdentity: {
        llmConnectionSlug: 'deepseek',
        model: 'deepseek-v4-flash',
        systemPromptHash: hashSystemPrompt(input.systemPrompt),
        pricingProfile: 'test-profile',
        agentTools: false,
      },
      tokenSummary: tokenSummary({ input: 4, output: 6, reasoning: 0, total: 10, costUsd: 0.01 }),
      ...(activated
        ? { contextBudgetSummary: contextBudgetSummary({ activePrunedToolResults: 1 }) }
        : {}),
      toolSummary: {
        providerVisibleToolCount: 0,
        actualToolCalls: 0,
        actualToolNames: [],
        actualToolCallCounts: {},
      },
      steps: 1,
      durationMs: 100,
      startedAt: 0,
      finishedAt: 100,
      runtimeEventsPath: `/logs/${input.task.id}/runtime-events.jsonl`,
      runtimeRefs: { invocationId: 'inv', sessionId: 'session', runId: 'run', turnId: 'turn' },
    },
  };
}

async function withDir(action: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'maka-runtime-ab-lifecycle-'));
  try {
    await mkdir(dir, { recursive: true });
    await action(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
