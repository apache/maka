import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { tokenSummary } from './helpers/cell-output-fixtures.js';
import { type HarborAgentEntry, harborAgentPhaseSec } from './helpers/harbor-agent-phase.js';
import { competitorRepoFiles } from '../agent-repo-mount.js';
import type { HarborCellExecutionIdentity, HarborCellOutput } from '../cell-output.js';
import {
  FixedPromptBudgetExhaustedError,
  runFixedPromptController,
  type FixedPromptTaskBudgetExhaustedEvent,
  type TaskRunInput,
} from '../fixed-prompt-controller.js';
import { CODEX_TOOLCHAIN_SPEC } from '../codex-toolchain.js';
import {
  buildHarborJobConfig,
  createHarborOracleQualifier,
  createHarborTaskRunner,
  HarborInfraError,
  incompleteTerminalProviderRequest,
  trialGradeSurvivingProviderOutage,
  MAKA_SETTLEMENT_GRACE_SEC,
  type HarborProcessRunner,
  type HarborRunRequest,
  type HarborRunResult,
} from '../harbor-task-runner.js';
import {
  harnessAgentImportPath,
  providerProxyClientAuthMode,
  providerProxyClientBaseUrl,
  providerProxyUpstreamAuthMode,
  providerProxyUsageProtocol,
} from '../harness-agent-registry.js';
import type { ProviderRequestTelemetry } from '../provider-auth-proxy.js';
import { HARBOR_ORACLE_EXECUTION_POLICY } from '../harness-oracle-policy.js';
import {
  CLAUDE_CODE_TOOLCHAIN_FINGERPRINT,
  CLAUDE_CODE_TOOLCHAIN_SPEC,
} from '../claude-code-toolchain.js';
import { REASONIX_TOOLCHAIN_FINGERPRINT, REASONIX_TOOLCHAIN_SPEC } from '../reasonix-toolchain.js';

function cellOutput(overrides: Partial<HarborCellOutput> = {}): HarborCellOutput {
  return {
    schemaVersion: 1,
    status: 'completed',
    runtimeEventsPath: '/logs/agent/runtime-events.jsonl',
    promptHash: 'sha256:abc',
    tokenSummary: tokenSummary({
      input: 100,
      output: 50,
      reasoning: 0,
      total: 150,
      costUsd: 0.0001,
    }),
    toolSummary: {
      providerVisibleToolCount: 6,
      actualToolCalls: 2,
      actualToolNames: ['Bash'],
      actualToolCallCounts: { Bash: 2 },
    },
    steps: 3,
    durationMs: 1000,
    startedAt: 1,
    finishedAt: 2,
    runtimeRefs: { invocationId: 'inv', sessionId: 'sess', runId: 'run', turnId: 'turn' },
    ...overrides,
  };
}

function runInput(overrides: Partial<TaskRunInput> = {}): TaskRunInput {
  return {
    runId: 'run-1',
    roundId: 'round-1',
    task: { id: 'task-1', path: '/tasks/cobol-modernization' },
    config: {
      id: 'cfg',
      backend: 'ai-sdk',
      llmConnectionSlug: 'deepseek',
      model: 'deepseek-v4-flash',
    },
    systemPrompt: 'CANDIDATE PROMPT\n',
    ...overrides,
  };
}

function copilotModelsResponse(): Response {
  return Response.json({
    data: [
      {
        id: 'gpt-5.4',
        model_picker_enabled: true,
        supported_endpoints: ['/responses'],
        policy: { state: 'enabled' },
        capabilities: {
          limits: { max_prompt_tokens: 128_000, max_output_tokens: 16_000 },
          supports: { tool_calls: true },
        },
      },
    ],
  });
}

test('DeepSeek routes each CLI through its native wire protocol', () => {
  assert.equal(providerProxyUsageProtocol('codex', 'deepseek'), 'openai-responses-sse');
  assert.equal(providerProxyUsageProtocol('codex', 'openai-codex'), 'openai-responses-sse');
  assert.equal(providerProxyUsageProtocol('claude-code', 'deepseek'), 'anthropic-sse');
  assert.equal(providerProxyClientAuthMode('codex', 'deepseek'), 'bearer');
  assert.equal(providerProxyClientAuthMode('claude-code', 'deepseek'), 'x-api-key');
  assert.equal(providerProxyUpstreamAuthMode('claude-code', 'deepseek'), 'bearer');
  assert.equal(
    providerProxyClientBaseUrl('https://proxy.invalid/lease', 'claude-code', 'deepseek'),
    'https://proxy.invalid/lease/anthropic',
  );
  // Reasonix speaks DeepSeek's OpenAI-compatible wire natively, so it needs no
  // agent-specific auth, usage, or base-URL branch — only the registry entry.
  assert.equal(providerProxyUsageProtocol('reasonix', 'deepseek'), 'openai-chat-sse');
  assert.equal(providerProxyClientAuthMode('reasonix', 'deepseek'), 'bearer');
  assert.equal(providerProxyUpstreamAuthMode('reasonix', 'deepseek'), 'bearer');
  assert.equal(
    providerProxyClientBaseUrl('https://proxy.invalid/lease', 'reasonix', 'deepseek'),
    'https://proxy.invalid/lease',
  );
  assert.equal(harnessAgentImportPath('reasonix'), 'reasonix_agent:MakaReasonixAgent');
});

interface FakeOptions {
  reward?: string;
  cell?: HarborCellOutput | null;
  executionIdentity?: HarborCellExecutionIdentity;
  usageCheckpoint?: HarborCellOutput['tokenSummary'];
  exitCode?: number;
  exitCodeAfterArtifacts?: number;
  events?: string;
  verifierStdout?: string;
  verifierOutcome?: Record<string, unknown> | null;
  trialResult?: Record<string, unknown>;
  makaTrace?: boolean;
  taskRunTrace?: boolean;
  combinedTrace?: boolean;
  captured?: { config?: Record<string, unknown>; request?: HarborRunRequest };
}

function fakeRunner(opts: FakeOptions): HarborProcessRunner {
  return async (request): Promise<HarborRunResult> => {
    const config = JSON.parse(await readFile(request.configPath, 'utf8')) as Record<
      string,
      unknown
    >;
    if (opts.captured) {
      opts.captured.config = config;
      opts.captured.request = request;
    }
    if (opts.exitCode && opts.exitCode !== 0) {
      return { exitCode: opts.exitCode, stdout: '', stderr: 'container build failed' };
    }
    const tasks = config.tasks as Array<{ path: string }>;
    const taskName = tasks[0]!.path.split('/').pop()!;
    const trialDir = join(request.jobsDir, request.jobName, `${taskName}__t1`);
    await mkdir(join(trialDir, 'verifier'), { recursive: true });
    await mkdir(join(trialDir, 'agent'), { recursive: true });
    if (opts.reward !== undefined) {
      await writeFile(join(trialDir, 'verifier', 'reward.txt'), opts.reward, 'utf8');
    }
    if (opts.verifierStdout !== undefined) {
      await writeFile(join(trialDir, 'verifier', 'test-stdout.txt'), opts.verifierStdout, 'utf8');
    }
    const verifierOutcome =
      opts.verifierOutcome === undefined && opts.reward !== undefined
        ? Number(opts.reward.trim()) > 0
          ? {
              schemaVersion: 1,
              outcome: 'passed',
              attempts: [
                {
                  attempt: 1,
                  classification: 'passed',
                  durationMs: 1,
                  reward: Number(opts.reward.trim()),
                },
              ],
            }
          : {
              schemaVersion: 1,
              outcome: 'failed',
              attempts: [{ attempt: 1, classification: 'failed', durationMs: 1, reward: 0 }],
            }
        : opts.verifierOutcome;
    if (verifierOutcome !== undefined && verifierOutcome !== null) {
      await writeFile(
        join(trialDir, 'verifier', 'maka-verifier-outcome.json'),
        JSON.stringify(verifierOutcome),
        'utf8',
      );
    }
    if (opts.cell !== null) {
      await writeFile(
        join(trialDir, 'agent', 'maka-cell-output.json'),
        JSON.stringify(opts.cell ?? cellOutput()),
        'utf8',
      );
    }
    if (opts.executionIdentity) {
      await writeFile(
        join(trialDir, 'agent', 'maka-cell-execution-identity.json'),
        JSON.stringify(opts.executionIdentity),
        'utf8',
      );
    }
    if (opts.usageCheckpoint) {
      await writeFile(
        join(trialDir, 'agent', 'maka-cell-usage-checkpoint.json'),
        JSON.stringify(opts.usageCheckpoint),
        'utf8',
      );
    }
    if (opts.trialResult) {
      await writeFile(join(trialDir, 'result.json'), JSON.stringify(opts.trialResult), 'utf8');
    }
    await writeFile(
      join(trialDir, 'agent', 'runtime-events.jsonl'),
      opts.events ?? '{"type":"x"}\n',
      'utf8',
    );
    if (opts.makaTrace !== false) {
      await mkdir(join(trialDir, 'agent', 'maka-storage', 'sessions', 'sess', 'runs', 'run'), {
        recursive: true,
      });
      await writeFile(
        join(trialDir, 'agent', 'maka-storage', 'sessions', 'sess', 'runs', 'run', 'events.jsonl'),
        '{"type":"tool_failed"}\n',
        'utf8',
      );
    }
    if (opts.taskRunTrace) {
      await mkdir(
        join(trialDir, 'agent', 'maka-task-run', 'runs', 'sessions', 'sess', 'runs', 'run'),
        { recursive: true },
      );
      await writeFile(
        join(
          trialDir,
          'agent',
          'maka-task-run',
          'runs',
          'sessions',
          'sess',
          'runs',
          'run',
          'events.jsonl',
        ),
        '{"type":"task_run_tool_failed"}\n',
        'utf8',
      );
    }
    if (opts.combinedTrace) {
      await writeFile(
        join(trialDir, 'agent', 'trace-events.jsonl'),
        '{"type":"first_invocation"}\n{"type":"second_invocation"}\n',
        'utf8',
      );
    }
    return {
      exitCode: opts.exitCodeAfterArtifacts ?? 0,
      stdout: opts.exitCodeAfterArtifacts ? '' : 'ok',
      stderr: opts.exitCodeAfterArtifacts ? 'trial failed' : '',
    };
  };
}

async function withRun<T>(
  fn: (dirs: { jobsDir: string; repo: string; keyFile: string }) => Promise<T>,
): Promise<T> {
  const base = await mkdtemp(join(tmpdir(), 'maka-harbor-runner-'));
  const repo = join(base, 'repo');
  const jobsDir = join(base, 'jobs');
  const keyFile = join(base, 'deepseek-key');
  await mkdir(repo, { recursive: true });
  await writeFile(keyFile, 'sk-secret\n', 'utf8');
  try {
    return await fn({ jobsDir, repo, keyFile });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

/** Drives the real Harbor runner through the controller so a trial directory on
 * disk is projected into the WAL row the benchmark actually counts. */
async function budgetExhaustedWalEvent(input: {
  jobsDir: string;
  repo: string;
  opts: FakeOptions;
}): Promise<FixedPromptTaskBudgetExhaustedEvent> {
  const systemPromptPath = join(input.repo, 'system_prompt.md');
  await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
  let id = 0;
  const result = await runFixedPromptController({
    runId: 'run-1',
    roundId: 'round-1',
    config: {
      id: 'cfg',
      backend: 'ai-sdk',
      llmConnectionSlug: 'deepseek',
      model: 'deepseek-v4-flash',
    },
    systemPromptPath,
    resultsJsonlPath: join(input.jobsDir, 'results.jsonl'),
    tasks: [{ id: 'task-1', path: '/tasks/cobol-modernization' }],
    taskRunner: createHarborTaskRunner({
      makaRepoPath: input.repo,
      jobsDir: input.jobsDir,
      model: 'deepseek/deepseek-v4-flash',
      runHarbor: fakeRunner({
        trialResult: {
          exception_info: {
            exception_type: 'AgentTimeoutError',
            exception_message: 'Agent execution timed out after 60.0 seconds',
          },
        },
        ...input.opts,
      }),
    }),
    now: () => 100,
    newId: () => `id-${(id += 1)}`,
  });
  const event = result.events[0];
  assert.equal(event?.type, 'task_budget_exhausted');
  if (event?.type !== 'task_budget_exhausted') assert.fail('expected budget exhaustion event');
  return event;
}

describe('createHarborTaskRunner', () => {
  test('parses reward + cell output and rewrites runtime events to the host path', async () => {
    await withRun(async ({ jobsDir, repo, keyFile }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        provider: 'deepseek',
        apiKeyFile: keyFile,
        pricing: {
          inputUsdPer1M: 0.145,
          outputUsdPer1M: 0.29,
          cacheReadUsdPer1M: 0.0029,
          source: 'v4-flash',
        },
        runHarbor: fakeRunner({
          reward: '1\n',
          cell: cellOutput({ promptHash: 'sha256:candidate' }),
        }),
      });

      const output = await runner(runInput());
      assert.equal(output.harbor.reward, 1);
      assert.equal(output.cell.status, 'completed');
      assert.equal(output.cell.promptHash, 'sha256:candidate');
      // runtimeEventsPath must be the host trial path, not the container path.
      assert.match(
        output.cell.runtimeEventsPath,
        /run-1\/round-1\/task-1\/trial\/cobol-modernization__t1\/agent\/runtime-events\.jsonl$/,
      );
      assert.doesNotMatch(output.cell.runtimeEventsPath, /^\/logs\//);
      assert.match(
        output.cell.traceEventsPath ?? '',
        /run-1\/round-1\/task-1\/trial\/cobol-modernization__t1\/agent\/maka-storage\/sessions\/sess\/runs\/run\/events\.jsonl$/,
      );
      assert.doesNotMatch(output.cell.traceEventsPath ?? '', /^\/logs\//);
    });
  });

  test('uses the task-run trace when the cell stores sessions under its task-run root', async () => {
    await withRun(async ({ jobsDir, repo, keyFile }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        provider: 'deepseek',
        apiKeyFile: keyFile,
        agentEnv: { MAKA_HARBOR_MODE: 'task-run' },
        runHarbor: fakeRunner({ reward: '1\n', makaTrace: false, taskRunTrace: true }),
      });

      const output = await runner(runInput());
      assert.match(
        output.cell.traceEventsPath ?? '',
        /agent\/maka-task-run\/runs\/sessions\/sess\/runs\/run\/events\.jsonl$/,
      );
      assert.equal(
        await readFile(output.cell.traceEventsPath ?? '', 'utf8'),
        '{"type":"task_run_tool_failed"}\n',
      );
    });
  });

  test('prefers the complete task-run trace over a last-invocation trace', async () => {
    await withRun(async ({ jobsDir, repo, keyFile }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        provider: 'deepseek',
        apiKeyFile: keyFile,
        agentEnv: { MAKA_HARBOR_MODE: 'task-run' },
        runHarbor: fakeRunner({ reward: '1\n', taskRunTrace: true, combinedTrace: true }),
      });

      const output = await runner(runInput());
      assert.match(output.cell.traceEventsPath ?? '', /agent\/trace-events\.jsonl$/);
      assert.equal(
        await readFile(output.cell.traceEventsPath ?? '', 'utf8'),
        '{"type":"first_invocation"}\n{"type":"second_invocation"}\n',
      );
    });
  });

  test('cell mode ignores stale task-run traces', async () => {
    await withRun(async ({ jobsDir, repo, keyFile }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        provider: 'deepseek',
        apiKeyFile: keyFile,
        runHarbor: fakeRunner({ reward: '1\n', taskRunTrace: true, combinedTrace: true }),
      });

      const output = await runner(runInput());
      assert.match(
        output.cell.traceEventsPath ?? '',
        /agent\/maka-storage\/sessions\/sess\/runs\/run\/events\.jsonl$/,
      );
      assert.equal(
        await readFile(output.cell.traceEventsPath ?? '', 'utf8'),
        '{"type":"tool_failed"}\n',
      );
    });
  });

  test('selects the Harbor result trial instead of a stale matching directory', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: async (request) => {
          const staleDir = join(request.jobsDir, request.jobName, 'cobol-modernization__aaa');
          await mkdir(join(staleDir, 'agent'), { recursive: true });
          await writeFile(
            join(staleDir, 'agent', 'maka-cell-output.json'),
            JSON.stringify(cellOutput({ promptHash: 'sha256:stale' })),
            'utf8',
          );

          const realDir = join(request.jobsDir, request.jobName, 'cobol-modernization__zzz');
          await mkdir(join(realDir, 'verifier'), { recursive: true });
          await mkdir(join(realDir, 'agent'), { recursive: true });
          await writeFile(join(realDir, 'verifier', 'reward.txt'), '1\n', 'utf8');
          await writeFile(
            join(realDir, 'verifier', 'maka-verifier-outcome.json'),
            JSON.stringify({
              schemaVersion: 1,
              outcome: 'passed',
              attempts: [{ attempt: 1, classification: 'passed', durationMs: 1, reward: 1 }],
            }),
            'utf8',
          );
          await writeFile(
            join(realDir, 'agent', 'maka-cell-output.json'),
            JSON.stringify(cellOutput({ promptHash: 'sha256:real' })),
            'utf8',
          );
          await writeFile(join(realDir, 'agent', 'runtime-events.jsonl'), '{"type":"x"}\n', 'utf8');
          await mkdir(join(realDir, 'agent', 'maka-storage', 'sessions', 'sess', 'runs', 'run'), {
            recursive: true,
          });
          await writeFile(
            join(
              realDir,
              'agent',
              'maka-storage',
              'sessions',
              'sess',
              'runs',
              'run',
              'events.jsonl',
            ),
            '{"type":"tool_failed"}\n',
            'utf8',
          );
          await writeFile(
            join(request.jobsDir, request.jobName, 'result.json'),
            JSON.stringify({
              stats: {
                evals: {
                  maka: {
                    reward_stats: { reward: { '1.0': ['cobol-modernization__zzz'] } },
                  },
                },
              },
            }),
            'utf8',
          );
          return { exitCode: 0, stdout: 'ok', stderr: '' };
        },
      });

      const output = await runner(runInput());
      assert.equal(output.cell.promptHash, 'sha256:real');
      assert.equal(output.harbor.reward, 1);
    });
  });

  test('the provider channel follows where the arm runs, not which arm it is', async () => {
    const channelFor = async (
      makaPlacement: 'task-container' | undefined,
    ): Promise<Record<string, string>> => {
      let harborEnv: Record<string, string> = {};
      await withRun(async ({ jobsDir, repo, keyFile }) => {
        const captured: { config?: Record<string, unknown> } = {};
        const runner = createHarborTaskRunner({
          makaRepoPath: repo,
          jobsDir,
          model: 'deepseek/deepseek-v4-flash',
          provider: 'deepseek',
          apiKeyFile: keyFile,
          agentEnv: { DEEPSEEK_BASE_URL: 'https://api.deepseek.com' },
          ...(makaPlacement
            ? { makaPlacement, makaNodeToolchainPath: join(repo, 'toolchain') }
            : {}),
          runHarbor: async (request) => {
            harborEnv = (request.env ?? {}) as Record<string, string>;
            return fakeRunner({ reward: '0\n', captured })(request);
          },
        });
        await runner(runInput());
      });
      return harborEnv;
    };

    // Host-bridge is the historical channel: the arm runs beside the proxy and
    // dials it directly.
    const hostBridge = await channelFor(undefined);
    assert.equal(typeof hostBridge.MAKA_HOST_BASE_URL, 'string');
    assert.equal(hostBridge.MAKA_PROVIDER_PROXY_URL, undefined);

    // In the task container the arm is on the far side of the same boundary as
    // every competitor, so it needs the competitors' channel. Routing this by
    // arm name instead of by placement is the revert that would leave the run
    // dialling 127.0.0.1 from inside the container -- itself -- while the
    // manifest still declared task-container.
    const inContainer = await channelFor('task-container');
    assert.equal(typeof inContainer.MAKA_PROVIDER_PROXY_URL, 'string');
    assert.equal(typeof inContainer.MAKA_PROVIDER_PROXY_TOKEN, 'string');
    assert.equal(inContainer.MAKA_HOST_BASE_URL, undefined);
    assert.doesNotMatch(inContainer.MAKA_PROVIDER_PROXY_URL ?? '', /127\.0\.0\.1|localhost/);
  });

  test('generates a JobConfig with verbatim prompt, host-side provider auth, and trial pricing', async () => {
    await withRun(async ({ jobsDir, repo, keyFile }) => {
      const captured: { config?: Record<string, unknown> } = {};
      let harborEnv: Record<string, string> | undefined;
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        provider: 'deepseek',
        apiKeyFile: keyFile,
        pricing: {
          inputUsdPer1M: 0.145,
          outputUsdPer1M: 0.29,
          cacheReadUsdPer1M: 0.0029,
          source: 'v4-flash',
        },
        agentEnv: { DEEPSEEK_BASE_URL: 'https://api.deepseek.com' },
        runHarbor: async (request) => {
          harborEnv = request.env;
          return fakeRunner({ reward: '0\n', captured })(request);
        },
      });
      await runner(runInput({ systemPrompt: 'PROMPT WITH\nNEWLINES\n' }));

      const config = captured.config!;
      const agent = (config.agents as Array<Record<string, unknown>>)[0]!;
      const env = agent.env as Record<string, string>;
      assert.equal(agent.import_path, 'maka_agent:MakaAgent');
      assert.equal(config.n_attempts, 1);
      assert.equal(config.n_concurrent_trials, 1);
      assert.equal(env.MAKA_BACKEND, 'ai-sdk');
      // The provider-matching prefix is stripped so the native DeepSeek API gets a
      // bare model id (slashful would 400). model_name carries the same value.
      assert.equal(env.MAKA_MODEL, 'deepseek-v4-flash');
      assert.equal(agent.model_name, 'deepseek-v4-flash');
      // Byte-for-byte, including the trailing newline the controller hashes.
      assert.equal(env.MAKA_SYSTEM_PROMPT, 'PROMPT WITH\nNEWLINES\n');
      assert.equal(env.DEEPSEEK_API_KEY_FILE, undefined);
      assert.equal(env.DEEPSEEK_API_KEY, undefined);
      assert.equal(env.DEEPSEEK_BASE_URL, undefined);
      assert.equal(env.MAKA_TRIAL_INPUT_USD_PER_1M, '0.145');
      assert.equal(env.MAKA_TRIAL_OUTPUT_USD_PER_1M, '0.29');
      assert.equal(env.MAKA_TRIAL_CACHE_READ_USD_PER_1M, '0.0029');
      assert.equal(env.MAKA_TRIAL_PRICING_SOURCE, 'v4-flash');
      const mounts = (config.environment as { mounts: Array<Record<string, unknown>> }).mounts;
      assert.ok(mounts.some((m) => m.target === '/opt/maka-agent' && m.read_only === true));
      assert.equal(
        mounts.some((m) => m.target === '/run/secrets/deepseek-key' || m.source === keyFile),
        false,
      );
      assert.doesNotMatch(
        JSON.stringify(config),
        /\/run\/secrets|deepseek-key|sk-secret|host\.docker\.internal|maka-broker/,
      );
      assert.equal(harborEnv?.MAKA_HOST_REPO_ROOT, repo);
      assert.equal(harborEnv?.MAKA_HOST_API_KEY_FILE, keyFile);
      assert.equal(harborEnv?.MAKA_HOST_API_KEY_ENV_NAME, undefined);
      assert.equal(harborEnv?.MAKA_HOST_BASE_URL, 'https://api.deepseek.com');
      assert.deepEqual(config.tasks, [{ path: '/tasks/cobol-modernization', overwrite: false }]);
    });
  });

  test('discovers the selected GitHub Copilot model on the host before a Harbor cell starts', async () => {
    await withRun(async ({ jobsDir, repo, keyFile }) => {
      await writeFile(keyFile, 'gho_account-token\n', 'utf8');
      let harborEnv: Record<string, string> | undefined;
      let discoveryAuthorization = '';
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'github-copilot/gpt-5.4',
        provider: 'github-copilot',
        apiKeyFile: keyFile,
        copilotFetch: async (_url, init) => {
          discoveryAuthorization = new Headers(init?.headers).get('authorization') ?? '';
          return copilotModelsResponse();
        },
        runHarbor: async (request) => {
          harborEnv = request.env;
          return fakeRunner({ reward: '1\n' })(request);
        },
      });

      await runner(runInput());

      assert.equal(discoveryAuthorization, 'Bearer gho_account-token');
      assert.equal(harborEnv?.MAKA_HOST_API_KEY, 'gho_account-token');
      assert.equal(harborEnv?.MAKA_HOST_API_KEY_FILE, undefined);
      assert.equal(harborEnv?.MAKA_HOST_API_KEY_ENV_NAME, undefined);
      assert.equal(harborEnv?.MAKA_HOST_BASE_URL, 'https://api.githubcopilot.com');
      assert.equal(harborEnv?.MAKA_HOST_MODEL_API_PROTOCOL, 'openai-responses');
    });
  });

  test('consumes a Copilot GitHub token env on the host without copying it into the task container', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      let harborEnv: Record<string, string> | undefined;
      const captured: { config?: Record<string, unknown> } = {};
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'github-copilot/gpt-5.4',
        provider: 'github-copilot',
        agentEnv: { GH_TOKEN: 'ghu_account-token' },
        copilotFetch: async () => copilotModelsResponse(),
        runHarbor: async (request) => {
          harborEnv = request.env;
          return fakeRunner({ reward: '1\n', captured })(request);
        },
      });

      await runner(runInput());

      assert.equal(harborEnv?.MAKA_HOST_API_KEY, 'ghu_account-token');
      assert.equal(harborEnv?.MAKA_HOST_NO_AUTH, undefined);
      assert.equal(harborEnv?.MAKA_HOST_MODEL_API_PROTOCOL, 'openai-responses');
      assert.doesNotMatch(JSON.stringify(captured.config), /GH_TOKEN|ghu_account-token/);
    });
  });

  test('rejects the unsupported OpenCode Harbor route before creating a Copilot auth proxy', async () => {
    await withRun(async ({ jobsDir, repo, keyFile }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        agent: 'opencode',
        opencodeToolchainPath: '/toolchain',
        agentVersion: '1.17.18',
        model: 'github-copilot/gpt-5.4',
        provider: 'github-copilot',
        apiKeyFile: keyFile,
      });

      await assert.rejects(runner(runInput()), (error: unknown) => {
        assert.ok(error instanceof HarborInfraError);
        assert.match(error.detail ?? '', /OpenCode Harbor adapter does not support this provider/);
        return true;
      });
    });
  });

  test('rejects the unsupported Kimi Code Harbor route before creating a Copilot auth proxy', async () => {
    await withRun(async ({ jobsDir, repo, keyFile }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        agent: 'kimi-code',
        kimiCodeToolchainPath: '/toolchain',
        agentVersion: '0.26.0',
        model: 'github-copilot/gpt-5.4',
        provider: 'github-copilot',
        apiKeyFile: keyFile,
      });

      await assert.rejects(runner(runInput()), (error: unknown) => {
        assert.ok(error instanceof HarborInfraError);
        assert.match(error.detail ?? '', /Kimi Code Harbor adapter does not support this provider/);
        return true;
      });
    });
  });

  test('gives OpenCode an ephemeral host proxy without exposing the provider key file', async () => {
    await withRun(async ({ jobsDir, repo, keyFile }) => {
      const captured: { config?: Record<string, unknown> } = {};
      let harborEnv: Record<string, string> | undefined;
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        agent: 'opencode',
        opencodeToolchainPath: '/toolchain',
        agentVersion: '1.17.18',
        model: 'zai-coding-plan/glm-5.2',
        provider: 'zai-coding-plan',
        reasoningEffort: 'max',
        apiKeyFile: keyFile,
        agentEnv: { ZAI_BASE_URL: 'https://api.z.ai/api/coding/paas/v4' },
        runHarbor: async (request) => {
          harborEnv = request.env;
          return fakeRunner({ reward: '1\n', captured })(request);
        },
      });

      await runner(runInput());

      assert.equal(harborEnv?.ZAI_API_KEY_FILE, undefined);
      assert.match(
        harborEnv?.MAKA_PROVIDER_PROXY_URL ?? '',
        /^http:\/\/host\.docker\.internal:\d+\/api\/coding\/paas\/v4$/,
      );
      assert.match(harborEnv?.MAKA_PROVIDER_PROXY_TOKEN ?? '', /^[a-f0-9]{64}$/);
      assert.notEqual(harborEnv?.MAKA_PROVIDER_PROXY_TOKEN, keyFile);
      assert.doesNotMatch(JSON.stringify(harborEnv), /deepseek-key|sk-secret/);
      assert.doesNotMatch(JSON.stringify(captured.config), /ZAI_API_KEY|deepseek-key|sk-secret/);
      const closedProxyUrl = harborEnv?.MAKA_PROVIDER_PROXY_URL?.replace(
        'host.docker.internal',
        '127.0.0.1',
      );
      assert.ok(closedProxyUrl);
      await assert.rejects(fetch(closedProxyUrl));
    });
  });

  test('rejects an OpenCode cell whose terminal provider stream is incomplete', async () => {
    await withRun(async ({ jobsDir, repo, keyFile }) => {
      const upstream = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      });
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const address = upstream.address();
      assert.ok(address && typeof address !== 'string');
      try {
        const runner = createHarborTaskRunner({
          makaRepoPath: repo,
          jobsDir,
          agent: 'opencode',
          opencodeToolchainPath: '/toolchain',
          agentVersion: '1.17.18',
          model: 'deepseek/deepseek-v4-flash',
          provider: 'deepseek',
          reasoningEffort: 'max',
          apiKeyFile: keyFile,
          agentEnv: { DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}` },
          runHarbor: async (request) => {
            const proxyUrl = request.env?.MAKA_PROVIDER_PROXY_URL?.replace(
              'host.docker.internal',
              '127.0.0.1',
            );
            const proxyToken = request.env?.MAKA_PROVIDER_PROXY_TOKEN;
            assert.ok(proxyUrl && proxyToken);
            const response = await fetch(`${proxyUrl}/chat/completions`, {
              method: 'POST',
              headers: { authorization: `Bearer ${proxyToken}` },
              body: '{}',
            });
            assert.equal(response.status, 200);
            await response.text();
            return fakeRunner({ reward: '0\n' })(request);
          },
        });

        await assert.rejects(runner(runInput()), (error: unknown) => {
          assert.ok(error instanceof HarborInfraError);
          assert.match(error.message, /terminal provider request did not complete/);
          assert.ok(error.artifactRefs?.providerTelemetryPath);
          return true;
        });
      } finally {
        await new Promise<void>((resolve, reject) =>
          upstream.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  });

  test('scores a cell whose agent exited cleanly while a provider stream was open', async () => {
    // Codex and Claude Code end their last turn by tearing down an in-flight
    // stream, which the proxy records as `aborted`. The trial itself raises
    // nothing and the verifier grades it, so the cell is evidence: reading that
    // tail as an outage discarded passing competitor cells as infra failures.
    await withRun(async ({ jobsDir, repo, keyFile }) => {
      const upstream = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      });
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const address = upstream.address();
      assert.ok(address && typeof address !== 'string');
      try {
        const runner = createHarborTaskRunner({
          makaRepoPath: repo,
          jobsDir,
          agent: 'codex',
          codexToolchainPath: '/toolchain',
          agentVersion: '0.146.0',
          model: 'deepseek/deepseek-v4-flash',
          provider: 'deepseek',
          reasoningEffort: 'max',
          apiKeyFile: keyFile,
          agentEnv: { MAKA_BASE_URL: `http://127.0.0.1:${address.port}` },
          runHarbor: async (request) => {
            const proxyUrl = request.env?.MAKA_PROVIDER_PROXY_URL?.replace(
              'host.docker.internal',
              '127.0.0.1',
            );
            const proxyToken = request.env?.MAKA_PROVIDER_PROXY_TOKEN;
            assert.ok(proxyUrl && proxyToken);
            const abort = new AbortController();
            const pending = fetch(`${proxyUrl}/chat/completions`, {
              method: 'POST',
              headers: { authorization: `Bearer ${proxyToken}` },
              body: '{}',
              signal: abort.signal,
            });
            const response = await pending;
            assert.equal(response.status, 200);
            abort.abort();
            await response.body?.cancel().catch(() => {});
            return fakeRunner({ reward: '1\n' })(request);
          },
        });

        const output = await runner(runInput());

        assert.equal(output.harbor.reward, 1);
        const telemetry = JSON.parse(
          await readFile(output.cell.providerTelemetryPath!, 'utf8'),
        ) as { requests: Array<{ outcome: string }> };
        assert.equal(telemetry.requests.at(-1)?.outcome, 'aborted');
      } finally {
        await new Promise<void>((resolve, reject) =>
          upstream.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  });

  test('gives Codex an ephemeral OpenAI proxy without exposing the provider key file', async () => {
    await withRun(async ({ jobsDir, repo, keyFile }) => {
      const captured: { config?: Record<string, unknown> } = {};
      let harborEnv: Record<string, string> | undefined;
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        agent: 'codex',
        codexToolchainPath: '/toolchain',
        agentVersion: '0.146.0',
        model: 'openai/gpt-5.6-sol',
        provider: 'openai',
        reasoningEffort: 'max',
        apiKeyFile: keyFile,
        agentEnv: { MAKA_BASE_URL: 'https://api.openai.com/v1' },
        runHarbor: async (request) => {
          harborEnv = request.env;
          return fakeRunner({ reward: '1\n', captured })(request);
        },
      });

      await runner(runInput());

      assert.match(
        harborEnv?.MAKA_PROVIDER_PROXY_URL ?? '',
        /^http:\/\/host\.docker\.internal:\d+\/v1$/,
      );
      assert.match(harborEnv?.MAKA_PROVIDER_PROXY_TOKEN ?? '', /^[a-f0-9]{64}$/);
      assert.equal(harborEnv?.OPENAI_API_KEY, undefined);
      assert.doesNotMatch(JSON.stringify(harborEnv), /deepseek-key|sk-secret/);
      assert.doesNotMatch(JSON.stringify(captured.config), /OPENAI_API_KEY|deepseek-key|sk-secret/);
    });
  });

  test('keeps rotating Codex OAuth authority behind the host proxy', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const captured: { config?: Record<string, unknown> } = {};
      let harborEnv: Record<string, string> | undefined;
      let upstreamAuthorization = '';
      let upstreamAccountId = '';
      const upstream = createServer((request, response) => {
        upstreamAuthorization = request.headers.authorization ?? '';
        upstreamAccountId = String(request.headers['chatgpt-account-id'] ?? '');
        response.writeHead(200).end('ok');
      });
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const address = upstream.address();
      assert.ok(address && typeof address !== 'string');
      try {
        const runner = createHarborTaskRunner({
          makaRepoPath: repo,
          jobsDir,
          agent: 'codex',
          codexToolchainPath: '/toolchain',
          agentVersion: '0.146.0',
          model: 'openai-codex/gpt-5.6-sol',
          provider: 'openai-codex',
          reasoningEffort: 'max',
          agentEnv: { MAKA_BASE_URL: `http://127.0.0.1:${address.port}` },
          resolveProviderCredential: async () => ({
            value: 'current-oauth-token',
            headers: { 'ChatGPT-Account-Id': 'account-shared' },
          }),
          runHarbor: async (request: HarborRunRequest) => {
            harborEnv = request.env;
            const proxyUrl = request.env?.MAKA_PROVIDER_PROXY_URL?.replace(
              'host.docker.internal',
              '127.0.0.1',
            );
            assert.ok(proxyUrl);
            const response = await fetch(`${proxyUrl}/responses`, {
              method: 'POST',
              headers: { authorization: `Bearer ${request.env?.MAKA_PROVIDER_PROXY_TOKEN}` },
              body: '{}',
            });
            assert.equal(response.status, 200);
            return fakeRunner({ reward: '1\n', captured })(request);
          },
        });

        await runner(runInput());

        assert.match(
          harborEnv?.MAKA_PROVIDER_PROXY_URL ?? '',
          /^http:\/\/host\.docker\.internal:\d+$/,
        );
        assert.match(harborEnv?.MAKA_PROVIDER_PROXY_TOKEN ?? '', /^[a-f0-9]{64}$/);
        assert.equal(upstreamAuthorization, 'Bearer current-oauth-token');
        assert.equal(upstreamAccountId, 'account-shared');
        assert.ok(captured.config);
        assert.doesNotMatch(JSON.stringify(captured.config), /AUTH_JSON|current-oauth-token/);
      } finally {
        await new Promise<void>((resolve, reject) =>
          upstream.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  });

  test('routes the Maka arm through the same rotating OAuth proxy boundary', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const captured: { config?: Record<string, unknown> } = {};
      let upstreamAuthorization = '';
      const upstream = createServer((request, response) => {
        upstreamAuthorization = request.headers.authorization ?? '';
        response.writeHead(200).end('ok');
      });
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const address = upstream.address();
      assert.ok(address && typeof address !== 'string');
      try {
        const runner = createHarborTaskRunner({
          makaRepoPath: repo,
          jobsDir,
          agent: 'maka',
          model: 'openai-codex/gpt-5.6-sol',
          provider: 'openai-codex',
          reasoningEffort: 'max',
          agentEnv: { MAKA_BASE_URL: `http://127.0.0.1:${address.port}` },
          resolveProviderCredential: async () => ({ value: 'current-oauth-token' }),
          runHarbor: async (request: HarborRunRequest) => {
            const proxyUrl = request.env?.MAKA_HOST_BASE_URL;
            assert.ok(proxyUrl);
            assert.match(proxyUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
            const response = await fetch(`${proxyUrl}/responses`, {
              method: 'POST',
              headers: { authorization: `Bearer ${request.env?.MAKA_HOST_API_KEY}` },
              body: '{}',
            });
            assert.equal(response.status, 200);
            return fakeRunner({ reward: '1\n', captured })(request);
          },
        });

        await runner(runInput());

        assert.equal(upstreamAuthorization, 'Bearer current-oauth-token');
        assert.ok(captured.config);
        assert.doesNotMatch(JSON.stringify(captured.config), /current-oauth-token/);
      } finally {
        await new Promise<void>((resolve, reject) =>
          upstream.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  });

  test('selects Anthropic x-api-key auth for the OpenCode Kimi Coding Plan proxy', async () => {
    await withRun(async ({ jobsDir, repo, keyFile }) => {
      let upstreamApiKey = '';
      let upstreamPath = '';
      const upstream = createServer((request, response) => {
        upstreamApiKey = String(request.headers['x-api-key'] ?? '');
        upstreamPath = request.url ?? '';
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(
          [
            'event: message_start',
            'data: {"type":"message_start","message":{"usage":{"input_tokens":70,"cache_creation_input_tokens":10,"cache_read_input_tokens":20,"output_tokens":1}}}',
            '',
            'event: message_delta',
            'data: {"type":"message_delta","usage":{"output_tokens":25}}',
            '',
            'event: message_stop',
            'data: {"type":"message_stop"}',
            '',
          ].join('\n'),
        );
      });
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const address = upstream.address();
      assert.ok(address && typeof address !== 'string');
      try {
        const runner = createHarborTaskRunner({
          makaRepoPath: repo,
          jobsDir,
          agent: 'opencode',
          opencodeToolchainPath: '/toolchain',
          agentVersion: '1.17.18',
          model: 'kimi-coding-plan/k3',
          provider: 'kimi-coding-plan',
          reasoningEffort: 'max',
          apiKeyFile: keyFile,
          pricing: {
            inputUsdPer1M: 0,
            cacheReadUsdPer1M: 0,
            cacheWriteUsdPer1M: 0,
            outputUsdPer1M: 0,
          },
          agentEnv: {
            MAKA_BASE_URL: `http://127.0.0.1:${address.port}/coding/v1`,
            MAKA_MODEL_API_PROTOCOL: 'anthropic-messages',
          },
          runHarbor: async (request) => {
            const proxyUrl = request.env?.MAKA_PROVIDER_PROXY_URL?.replace(
              'host.docker.internal',
              '127.0.0.1',
            );
            const proxyToken = request.env?.MAKA_PROVIDER_PROXY_TOKEN;
            assert.ok(proxyUrl && proxyToken);
            const response = await fetch(`${proxyUrl}/messages`, {
              method: 'POST',
              headers: { 'x-api-key': proxyToken },
              body: '{}',
            });
            assert.equal(response.status, 200);
            await response.text();
            return fakeRunner({
              reward: '1\n',
              cell: cellOutput({ tokenSummary: undefined }),
            })(request);
          },
        });

        const output = await runner(runInput());
        assert.equal(upstreamApiKey, 'sk-secret');
        assert.equal(upstreamPath, '/coding/v1/messages');
        assert.deepEqual(output.cell.tokenSummary, {
          input: 100,
          output: 25,
          cachedInput: 20,
          cacheHitInput: 20,
          cacheMissInput: 70,
          cacheWriteInput: 10,
          cacheMissInputSource: 'explicit',
          reasoning: 0,
          total: 125,
          costUsd: 0,
          pricingSource: 'runtime',
        });
      } finally {
        await new Promise<void>((resolve, reject) =>
          upstream.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  });

  test('uses the host-selected OpenAI protocol for the default Maka Kimi Coding Plan proxy', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      let upstreamAuthorization = '';
      let upstreamPath = '';
      const upstream = createServer((request, response) => {
        upstreamAuthorization = request.headers.authorization ?? '';
        upstreamPath = request.url ?? '';
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(
          [
            'data: {"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":25,"prompt_tokens_details":{"cached_tokens":20},"completion_tokens_details":{"reasoning_tokens":15}}}',
            '',
            'data: [DONE]',
            '',
          ].join('\n'),
        );
      });
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const address = upstream.address();
      assert.ok(address && typeof address !== 'string');
      try {
        const runner = createHarborTaskRunner({
          makaRepoPath: repo,
          jobsDir,
          model: 'kimi-coding-plan/k3',
          provider: 'kimi-coding-plan',
          reasoningEffort: 'max',
          resolveProviderCredential: async () => ({ value: 'sk-secret' }),
          pricing: {
            inputUsdPer1M: 0,
            cacheReadUsdPer1M: 0,
            cacheWriteUsdPer1M: 0,
            outputUsdPer1M: 0,
          },
          agentEnv: {
            MAKA_BASE_URL: `http://127.0.0.1:${address.port}/coding/v1`,
            MAKA_HOST_MODEL_API_PROTOCOL: 'openai-chat',
          },
          runHarbor: async (request) => {
            const proxyUrl = request.env?.MAKA_HOST_BASE_URL;
            const proxyToken = request.env?.MAKA_HOST_API_KEY;
            assert.ok(proxyUrl && proxyToken);
            const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
              method: 'POST',
              headers: { authorization: `Bearer ${proxyToken}` },
              body: '{}',
            });
            assert.equal(response.status, 200);
            await response.text();
            return fakeRunner({
              reward: '1\n',
              cell: cellOutput({ tokenSummary: undefined }),
            })(request);
          },
        });

        const output = await runner(runInput());
        assert.equal(upstreamAuthorization, 'Bearer sk-secret');
        assert.equal(upstreamPath, '/coding/v1/chat/completions');
        assert.equal(output.cell.tokenSummary?.total, 125);
        assert.equal(output.cell.tokenSummary?.reasoning, 15);
      } finally {
        await new Promise<void>((resolve, reject) =>
          upstream.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  });

  test('gives Kimi Code bearer auth and fills missing cell usage from the provider stream', async () => {
    await withRun(async ({ jobsDir, repo, keyFile }) => {
      let upstreamAuthorization = '';
      let upstreamPath = '';
      const upstream = createServer((request, response) => {
        upstreamAuthorization = request.headers.authorization ?? '';
        upstreamPath = request.url ?? '';
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(
          [
            'data: {"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":25,"prompt_tokens_details":{"cached_tokens":20},"completion_tokens_details":{"reasoning_tokens":15}}}',
            '',
            'data: [DONE]',
            '',
          ].join('\n'),
        );
      });
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const address = upstream.address();
      assert.ok(address && typeof address !== 'string');
      try {
        const runner = createHarborTaskRunner({
          makaRepoPath: repo,
          jobsDir,
          agent: 'kimi-code',
          kimiCodeToolchainPath: '/toolchain',
          agentVersion: '0.26.0',
          model: 'kimi-coding-plan/k3',
          provider: 'kimi-coding-plan',
          reasoningEffort: 'max',
          apiKeyFile: keyFile,
          pricing: {
            inputUsdPer1M: 0,
            cacheReadUsdPer1M: 0,
            cacheWriteUsdPer1M: 0,
            outputUsdPer1M: 0,
          },
          agentEnv: { MAKA_BASE_URL: `http://127.0.0.1:${address.port}/coding/v1` },
          runHarbor: async (request) => {
            const proxyUrl = request.env?.MAKA_PROVIDER_PROXY_URL?.replace(
              'host.docker.internal',
              '127.0.0.1',
            );
            const proxyToken = request.env?.MAKA_PROVIDER_PROXY_TOKEN;
            assert.ok(proxyUrl && proxyToken);
            const response = await fetch(`${proxyUrl}/chat/completions`, {
              method: 'POST',
              headers: { authorization: `Bearer ${proxyToken}` },
              body: '{}',
            });
            assert.equal(response.status, 200);
            await response.text();
            return fakeRunner({
              reward: '1\n',
              cell: cellOutput({ tokenSummary: undefined }),
            })(request);
          },
        });

        const output = await runner(runInput());
        assert.equal(upstreamAuthorization, 'Bearer sk-secret');
        assert.equal(upstreamPath, '/coding/v1/chat/completions');
        assert.deepEqual(output.cell.tokenSummary, {
          input: 100,
          output: 25,
          cachedInput: 20,
          cacheHitInput: 20,
          cacheMissInput: 80,
          cacheWriteInput: 0,
          cacheMissInputSource: 'explicit',
          reasoning: 15,
          total: 125,
          costUsd: 0,
          pricingSource: 'runtime',
        });
        assert.ok(output.cell.providerTelemetryPath);
        const telemetry = JSON.parse(await readFile(output.cell.providerTelemetryPath, 'utf8')) as {
          schemaVersion: number;
          summary: { requests: number; completed: number; reasoningTokens: number | null };
          requests: Array<{ outcome: string; terminalEvent: boolean }>;
        };
        assert.equal(telemetry.schemaVersion, 1);
        assert.equal(telemetry.summary.requests, 1);
        assert.equal(telemetry.summary.completed, 1);
        assert.equal(telemetry.summary.reasoningTokens, 15);
        assert.equal(telemetry.requests[0]?.outcome, 'completed');
        assert.equal(telemetry.requests[0]?.terminalEvent, true);
      } finally {
        await new Promise<void>((resolve, reject) =>
          upstream.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  });

  test('uses the external agent runtime stream as its readable trace evidence', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        agent: 'kimi-code',
        kimiCodeToolchainPath: '/toolchain',
        agentVersion: '0.26.0',
        model: 'kimi-coding-plan/k3',
        provider: 'ollama',
        runHarbor: fakeRunner({ reward: '1\n', makaTrace: false }),
      });

      const output = await runner(runInput());
      assert.equal(output.cell.traceEventsPath, output.cell.runtimeEventsPath);
      assert.equal(await readFile(output.cell.traceEventsPath, 'utf8'), '{"type":"x"}\n');
    });
  });

  test('keeps no-auth providers on the existing OpenCode direct path', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      let harborEnv: Record<string, string> | undefined;
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        agent: 'opencode',
        opencodeToolchainPath: '/toolchain',
        agentVersion: '1.17.18',
        model: 'ollama/qwen2.5-coder:7b',
        provider: 'ollama',
        agentEnv: { MAKA_BASE_URL: 'http://host.docker.internal:11434/v1' },
        runHarbor: async (request) => {
          harborEnv = request.env;
          return fakeRunner({ reward: '1\n' })(request);
        },
      });

      await runner(runInput());

      assert.equal(harborEnv?.MAKA_HOST_NO_AUTH, undefined);
      assert.equal(harborEnv?.MAKA_PROVIDER_PROXY_URL, undefined);
    });
  });

  test('routes SiliconFlow key files and base URLs through the host-side cell', async () => {
    await withRun(async ({ jobsDir, repo, keyFile }) => {
      let harborEnv: Record<string, string> | undefined;
      const captured: { config?: Record<string, unknown> } = {};
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'siliconflow/moonshotai/Kimi-K2.6',
        provider: 'siliconflow',
        apiKeyFile: keyFile,
        agentEnv: { SILICONFLOW_BASE_URL: 'https://api.siliconflow.cn/v1' },
        runHarbor: async (request) => {
          harborEnv = request.env;
          return fakeRunner({ reward: '1\n', captured })(request);
        },
      });

      await runner(runInput());

      assert.equal(harborEnv?.MAKA_HOST_API_KEY_ENV_NAME, undefined);
      assert.equal(harborEnv?.MAKA_HOST_BASE_URL, 'https://api.siliconflow.cn/v1');
      const agent = (captured.config!.agents as Array<{ env: Record<string, string> }>)[0]!;
      assert.equal(agent.env.SILICONFLOW_BASE_URL, undefined);
    });
  });

  test('routes Vercel Gateway key files and base URLs through the host-side cell', async () => {
    await withRun(async ({ jobsDir, repo, keyFile }) => {
      let harborEnv: Record<string, string> | undefined;
      const captured: { config?: Record<string, unknown> } = {};
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'vercel/xai/grok-4.3',
        provider: 'vercel',
        apiKeyFile: keyFile,
        agentEnv: { AI_GATEWAY_BASE_URL: 'https://ai-gateway.vercel.sh/v1' },
        runHarbor: async (request) => {
          harborEnv = request.env;
          return fakeRunner({ reward: '1\n', captured })(request);
        },
      });

      await runner(runInput());

      assert.equal(harborEnv?.MAKA_HOST_API_KEY_ENV_NAME, undefined);
      assert.equal(harborEnv?.MAKA_HOST_BASE_URL, 'https://ai-gateway.vercel.sh/v1');
      const agent = (captured.config!.agents as Array<{ env: Record<string, string> }>)[0]!;
      assert.equal(agent.env.AI_GATEWAY_BASE_URL, undefined);
    });
  });

  test('builds the Cloudflare Workers AI host base URL from the non-secret account id', async () => {
    await withRun(async ({ jobsDir, repo, keyFile }) => {
      const captured: { config?: Record<string, unknown> } = {};
      let harborEnv: Record<string, string> | undefined;
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'cloudflare-workers-ai/@cf/moonshotai/kimi-k2.6',
        provider: 'cloudflare-workers-ai',
        apiKeyFile: keyFile,
        agentEnv: { CLOUDFLARE_ACCOUNT_ID: 'account-123' },
        runHarbor: async (request) => {
          harborEnv = request.env;
          return fakeRunner({ reward: '1\n', captured })(request);
        },
      });

      await runner(runInput());

      const agent = (captured.config!.agents as Array<Record<string, unknown>>)[0]!;
      const agentEnv = agent.env as Record<string, string>;
      assert.equal(agent.model_name, '@cf/moonshotai/kimi-k2.6');
      assert.equal(agentEnv.MAKA_MODEL, '@cf/moonshotai/kimi-k2.6');
      assert.equal(agentEnv.CLOUDFLARE_ACCOUNT_ID, 'account-123');
      assert.equal(agentEnv.CLOUDFLARE_API_KEY, undefined);
      assert.equal(agentEnv.CLOUDFLARE_API_KEY_FILE, undefined);
      assert.equal(harborEnv?.MAKA_HOST_API_KEY_ENV_NAME, undefined);
      assert.equal(
        harborEnv?.MAKA_HOST_BASE_URL,
        'https://api.cloudflare.com/client/v4/accounts/account-123/ai/v1',
      );
    });
  });

  for (const model of ['hf.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M', 'qwen3.5:cloud']) {
    test(`routes no-auth Ollama model ${model} through the host-side cell without exposing credentials`, async () => {
      await withRun(async ({ jobsDir, repo }) => {
        let harborEnv: Record<string, string> | undefined;
        const captured: { config?: Record<string, unknown> } = {};
        const baseUrl = 'http://127.0.0.1:11434/v1';
        const runner = createHarborTaskRunner({
          makaRepoPath: repo,
          jobsDir,
          model: `ollama/${model}`,
          provider: 'ollama',
          agentEnv: { MAKA_BASE_URL: baseUrl },
          runHarbor: async (request) => {
            harborEnv = request.env;
            return fakeRunner({ reward: '1\n', captured })(request);
          },
        });

        await runner(runInput());

        assert.equal(harborEnv?.MAKA_HOST_REPO_ROOT, repo);
        assert.equal(harborEnv?.MAKA_HOST_BASE_URL, baseUrl);
        assert.equal(harborEnv?.MAKA_HOST_NO_AUTH, 'true');
        assert.equal(harborEnv?.MAKA_HOST_API_KEY, undefined);
        assert.equal(harborEnv?.MAKA_HOST_API_KEY_FILE, undefined);
        const agent = (
          captured.config!.agents as Array<{ model_name: string; env: Record<string, string> }>
        )[0]!;
        assert.equal(agent.model_name, model);
        assert.equal(agent.env.MAKA_MODEL, model);
        assert.equal(agent.env.MAKA_BASE_URL, undefined);
        assert.doesNotMatch(JSON.stringify(captured.config), /API_KEY|127\.0\.0\.1:11434/);
      });
    });
  }

  test('routes keyless LocalAI through the host-side cell without rewriting its exact alias', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      let harborEnv: Record<string, string> | undefined;
      const captured: { config?: Record<string, unknown> } = {};
      const model = 'localai/Qwen3-8B-Instruct-GGUF:Q4_K_M';
      const baseUrl = 'http://127.0.0.1:8080/v1';
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: `localai/${model}`,
        provider: 'localai',
        agentEnv: { LOCALAI_BASE_URL: baseUrl },
        runHarbor: async (request) => {
          harborEnv = request.env;
          return fakeRunner({ reward: '1\n', captured })(request);
        },
      });

      await runner(runInput());

      assert.equal(harborEnv?.MAKA_HOST_BASE_URL, baseUrl);
      assert.equal(harborEnv?.MAKA_HOST_NO_AUTH, 'true');
      assert.equal(harborEnv?.MAKA_HOST_API_KEY_FILE, undefined);
      const agent = (
        captured.config!.agents as Array<{ model_name: string; env: Record<string, string> }>
      )[0]!;
      assert.equal(agent.model_name, model);
      assert.equal(agent.env.MAKA_MODEL, model);
      assert.equal(agent.env.LOCALAI_BASE_URL, undefined);
      assert.doesNotMatch(JSON.stringify(captured.config), /API_KEY|127\.0\.0\.1:8080/);
    });
  });

  test('rejects provider secrets in agentEnv even when host-side key file is configured', async () => {
    await withRun(async ({ jobsDir, repo, keyFile }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        provider: 'deepseek',
        apiKeyFile: keyFile,
        pricing: { inputUsdPer1M: 0.145, outputUsdPer1M: 0.29 },
        agentEnv: {
          DEEPSEEK_API_KEY: 'raw-should-not-enter-task',
          DEEPSEEK_API_KEY_FILE: '/tmp/should-not-enter-task',
          DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
        },
        runHarbor: async () => {
          throw new Error('harbor must not run with provider secrets in agentEnv');
        },
      });
      await assert.rejects(
        runner(runInput()),
        /agentEnv must not contain provider secrets: DEEPSEEK_API_KEY, DEEPSEEK_API_KEY_FILE/,
      );
    });
  });

  test('rejects provider secrets in agentEnv when no key file is configured', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        provider: 'deepseek',
        agentEnv: { OPENAI_API_KEY_FILE: '/tmp/openai-key' },
        runHarbor: async () => {
          throw new Error('harbor must not run with provider secrets in agentEnv');
        },
      });
      await assert.rejects(
        runner(runInput()),
        /agentEnv must not contain provider secrets: OPENAI_API_KEY_FILE/,
      );
    });
  });

  test('throws HarborInfraError when harbor exits non-zero', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({ exitCode: 1 }),
      });
      await assert.rejects(runner(runInput()), HarborInfraError);
    });
  });

  test('keeps provider telemetry evidence when Harbor exits non-zero', async () => {
    await withRun(async ({ jobsDir, repo, keyFile }) => {
      const upstream = createServer((_request, response) => {
        response.writeHead(429, { 'content-type': 'application/json' });
        response.end('{"error":"rate_limited"}');
      });
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const address = upstream.address();
      assert.ok(address && typeof address !== 'string');
      try {
        const runner = createHarborTaskRunner({
          makaRepoPath: repo,
          jobsDir,
          agent: 'kimi-code',
          kimiCodeToolchainPath: '/toolchain',
          agentVersion: '0.26.0',
          model: 'kimi-coding-plan/k3',
          provider: 'kimi-coding-plan',
          apiKeyFile: keyFile,
          agentEnv: { MAKA_BASE_URL: `http://127.0.0.1:${address.port}/coding/v1` },
          runHarbor: async (request) => {
            const proxyUrl = request.env?.MAKA_PROVIDER_PROXY_URL?.replace(
              'host.docker.internal',
              '127.0.0.1',
            );
            const proxyToken = request.env?.MAKA_PROVIDER_PROXY_TOKEN;
            assert.ok(proxyUrl && proxyToken);
            const response = await fetch(`${proxyUrl}/chat/completions`, {
              method: 'POST',
              headers: { authorization: `Bearer ${proxyToken}` },
              body: '{}',
            });
            assert.equal(response.status, 429);
            await response.text();
            return { exitCode: 1, stdout: '', stderr: 'container failed' };
          },
        });

        let caught: unknown;
        try {
          await runner(runInput());
        } catch (error) {
          caught = error;
        }
        assert.ok(caught instanceof HarborInfraError);
        assert.ok(caught.artifactRefs?.providerTelemetryPath);
        const telemetry = JSON.parse(
          await readFile(caught.artifactRefs.providerTelemetryPath, 'utf8'),
        ) as {
          summary: { failed: number };
        };
        assert.equal(telemetry.summary.failed, 1);
      } finally {
        await new Promise<void>((resolve, reject) =>
          upstream.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  });

  test('throws HarborInfraError when the cell output is missing', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({ reward: '1\n', cell: null }),
      });
      await assert.rejects(runner(runInput()), HarborInfraError);
    });
  });

  test('throws HarborInfraError when the verifier reward is missing', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({ cell: cellOutput() }),
      });
      await assert.rejects(runner(runInput()), HarborInfraError);
    });
  });

  test('reports Harbor trial exception when setup fails before verifier reward exists', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          cell: cellOutput(),
          trialResult: {
            exception_info: {
              exception_type: 'NonZeroAgentExitCodeError',
              exception_message: 'Command failed (exit 127): nvm install 22',
            },
          },
        }),
      });
      await assert.rejects(
        runner(runInput()),
        /Harbor trial failed before verifier reward for task task-1: NonZeroAgentExitCodeError: Command failed \(exit 127\): nvm install 22/,
      );
    });
  });

  test('treats host cell timeout before verifier reward as budget exhausted', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          cell: cellOutput(),
          trialResult: {
            exception_info: {
              exception_type: 'RuntimeError',
              exception_message: 'Maka host cell exceeded 1800s',
            },
          },
        }),
      });
      await assert.rejects(runner(runInput()), FixedPromptBudgetExhaustedError);
    });
  });

  test('returns the official verifier result after a Harbor agent timeout', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const timedCell = cellOutput({
        executionIdentity: {
          llmConnectionSlug: 'deepseek',
          model: 'deepseek-v4-flash',
          systemPromptHash: 'sha256:abc',
          pricingProfile: 'test-profile',
        },
      });
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          reward: '1\n',
          cell: timedCell,
          trialResult: {
            exception_info: {
              exception_type: 'AgentTimeoutError',
              exception_message: 'Agent execution timed out after 60.0 seconds',
            },
          },
        }),
      });
      const output = await runner(runInput());
      assert.equal(output.harbor.reward, 1);
      assert.equal(output.harbor.verifier?.outcome, 'passed');
      assert.equal(output.cell.status, 'failed');
      assert.equal(output.cell.errorClass, 'budget_exhausted');
      assert.deepEqual(output.cell.deadlineSettlement, {
        source: 'benchmark.deadline',
        mode: 'immediate',
      });
      assert.deepEqual(output.cell.tokenSummary, timedCell.tokenSummary);
      assert.deepEqual(output.cell.executionIdentity, timedCell.executionIdentity);
    });
  });

  test('propagates an authoritative Harbor agent timeout into a failed graded cell', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          reward: '0\n',
          cell: cellOutput({ status: 'completed', errorClass: undefined }),
          trialResult: {
            exception_info: {
              exception_type: 'AgentTimeoutError',
              exception_message: 'Agent execution timed out after 900.0 seconds',
            },
          },
        }),
      });

      const output = await runner(runInput());
      assert.equal(output.harbor.reward, 0);
      assert.equal(output.cell.status, 'failed');
      assert.equal(output.cell.errorClass, 'budget_exhausted');
      assert.deepEqual(output.cell.deadlineSettlement, {
        source: 'benchmark.deadline',
        mode: 'immediate',
      });
    });
  });

  test('does not infer a benchmark deadline from an ordinary verifier failure', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          reward: '0\n',
          cell: cellOutput({ status: 'completed', errorClass: undefined }),
        }),
      });

      const output = await runner(runInput());
      assert.equal(output.cell.status, 'completed');
      assert.equal(output.cell.errorClass, undefined);
      assert.equal(output.cell.deadlineSettlement, undefined);
    });
  });

  test('hydrates missing deadline usage from the trial checkpoint', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const usageCheckpoint = tokenSummary({
        input: 12_000,
        output: 800,
        reasoning: 400,
        total: 12_800,
        costUsd: 0.01,
      });
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          reward: '0\n',
          cell: cellOutput({
            status: 'failed',
            errorClass: 'aborted',
            deadlineSettlement: { source: 'benchmark.deadline', mode: 'immediate' },
            tokenSummary: undefined,
          }),
          usageCheckpoint,
        }),
      });

      const output = await runner(runInput());
      assert.deepEqual(output.cell.tokenSummary, usageCheckpoint);
    });
  });

  test('replaces a parent-only summary with a child-inclusive checkpoint', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const parentOnly = tokenSummary({
        input: 100,
        output: 10,
        reasoning: 2,
        total: 110,
        costUsd: 0.004,
      });
      const childInclusive = tokenSummary({
        input: 160,
        output: 25,
        reasoning: 7,
        total: 185,
        costUsd: 0.011,
      });
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          reward: '1\n',
          cell: cellOutput({ tokenSummary: parentOnly }),
          usageCheckpoint: childInclusive,
        }),
      });

      const output = await runner(runInput());
      assert.deepEqual(output.cell.tokenSummary, childInclusive);
    });
  });

  test('retains the final summary when a higher-total checkpoint is not cumulative', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const finalSummary = tokenSummary({
        input: 100,
        output: 20,
        reasoning: 4,
        total: 120,
        costUsd: 0.008,
      });
      const conflictingCheckpoint = tokenSummary({
        input: 90,
        output: 40,
        reasoning: 8,
        total: 130,
        costUsd: 0.01,
      });
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          reward: '1\n',
          cell: cellOutput({ tokenSummary: finalSummary }),
          usageCheckpoint: conflictingCheckpoint,
        }),
      });

      const output = await runner(runInput());
      assert.deepEqual(output.cell.tokenSummary, finalSummary);
    });
  });

  test('treats a non-zero Harbor exit with an incomplete agent-timeout trial as budget exhausted', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const executionIdentity = {
        llmConnectionSlug: 'deepseek',
        model: 'deepseek-v4-flash',
        systemPromptHash: 'sha256:abc',
        pricingProfile: 'test-profile',
      };
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          exitCodeAfterArtifacts: 1,
          cell: null,
          executionIdentity,
          trialResult: {
            exception_info: {
              exception_type: 'AgentTimeoutError',
              exception_message: 'Agent execution timed out after 900.0 seconds',
            },
          },
        }),
      });

      await assert.rejects(runner(runInput()), (error: unknown) => {
        assert.ok(error instanceof FixedPromptBudgetExhaustedError);
        assert.deepEqual(error.artifactRefs?.executionIdentity, executionIdentity);
        return true;
      });
    });
  });

  test('settles a timeout by its exception type when the harness rewords the message', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          exitCodeAfterArtifacts: 1,
          reward: '1\n',
          cell: cellOutput({ status: 'failed', errorClass: 'aborted' }),
          trialResult: {
            exception_info: {
              // AgentTimeoutError is Harbor's own class, so the type settles it.
              // The message is upstream prose and may be reworded at any time.
              exception_type: 'AgentTimeoutError',
              exception_message: 'Agent execution exceeded its 900s deadline',
            },
          },
        }),
      });

      const output = await runner(runInput());
      assert.equal(output.harbor.reward, 1);
      assert.equal(output.cell.deadlineSettlement?.source, 'benchmark.deadline');
    });
  });

  test('scores a graded trial the agent ended by exiting non-zero', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          exitCodeAfterArtifacts: 1,
          reward: '1\n',
          cell: cellOutput({ status: 'failed', errorClass: 'aborted' }),
          trialResult: {
            exception_info: {
              exception_type: 'NonZeroAgentExitCodeError',
              exception_message: 'agent exited 1',
            },
          },
        }),
      });

      const output = await runner(runInput());
      assert.equal(output.harbor.reward, 1);
      assert.equal(output.harbor.verifier?.outcome, 'passed');
      // No deadline ended this run, so nothing may claim one — the structured
      // verifier grade is what makes the trial scoreable.
      assert.equal(output.cell.deadlineSettlement, undefined);
      assert.equal(output.cell.errorClass, 'aborted');
    });
  });

  test('scores a graded-failed agent exit, not just a graded-passed one', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          exitCodeAfterArtifacts: 1,
          reward: '0\n',
          cell: cellOutput({ status: 'failed', errorClass: 'aborted' }),
          trialResult: {
            exception_info: {
              exception_type: 'NonZeroAgentExitCodeError',
              exception_message: 'agent exited 1',
            },
          },
        }),
      });

      // A verdict settles the trial whichever way it went; scoring only the
      // passes would quietly drop every graded failure from the denominator.
      const output = await runner(runInput());
      assert.equal(output.harbor.reward, 0);
      assert.equal(output.harbor.verifier?.outcome, 'failed');
    });
  });

  test('keeps an externally ended run that exited non-zero infra despite full artifacts', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          exitCodeAfterArtifacts: 1,
          // Every artifact present and the verdict conclusive: the container
          // died after the verifier ran. The agent still never got the run it
          // was given, so this is not a fair sample at any reward.
          //
          // Scoped deliberately to the non-zero exit. Both harnesses swallow a
          // recorded agent-phase exception and exit 0 (trial.py run()), and on
          // that path an external termination with a full verdict still falls
          // through and scores. That is defensible — the verifier did grade it,
          // and the verifier only ever runs for an agent-owned termination in
          // the first place — but it is not what this test pins.
          reward: '0\n',
          cell: cellOutput({ status: 'failed', errorClass: 'aborted' }),
          trialResult: {
            exception_info: {
              exception_type: 'DockerExecError',
              exception_message: 'container exec failed',
            },
          },
        }),
      });

      await assert.rejects(runner(runInput()), (error: unknown) => {
        assert.ok(error instanceof HarborInfraError);
        assert.match(error.message, /harbor run exited 1/);
        // The infra message has to name the trial exception: the WAL keeps only
        // the message, so anything dropped here is unfindable after the run.
        assert.match(error.message, /trial exception: DockerExecError: container exec failed/);
        return true;
      });
    });
  });

  test('returns the official verifier result after a non-zero Harbor timeout exit', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const timedCell = cellOutput({
        executionIdentity: {
          llmConnectionSlug: 'deepseek',
          model: 'deepseek-v4-flash',
          systemPromptHash: 'sha256:abc',
          pricingProfile: 'test-profile',
        },
      });
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          exitCodeAfterArtifacts: 1,
          reward: '1\n',
          cell: timedCell,
          trialResult: {
            exception_info: {
              exception_type: 'AgentTimeoutError',
              exception_message: 'Agent execution timed out after 60.0 seconds',
            },
          },
        }),
      });

      const output = await runner(runInput());
      assert.equal(output.harbor.reward, 1);
      assert.equal(output.harbor.verifier?.outcome, 'passed');
    });
  });

  test('recovers early identity and completed-step usage from an agent-timeout trial without cell output', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const executionIdentity = {
        llmConnectionSlug: 'deepseek',
        model: 'deepseek-v4-flash',
        systemPromptHash: 'sha256:abc',
        pricingProfile: 'test-profile',
      };
      const usageCheckpoint: HarborCellOutput['tokenSummary'] = {
        input: 12_000,
        output: 800,
        cachedInput: 10_000,
        cacheHitInput: 10_000,
        cacheMissInput: 2_000,
        cacheWriteInput: 0,
        cacheMissInputSource: 'explicit',
        reasoning: 400,
        total: 12_800,
        costUsd: 0.01,
        pricingSource: 'runtime',
      };
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          reward: '0\n',
          cell: null,
          executionIdentity,
          usageCheckpoint,
          trialResult: {
            exception_info: {
              exception_type: 'AgentTimeoutError',
              exception_message: 'Agent execution timed out after 60.0 seconds',
            },
          },
        }),
      });

      await assert.rejects(runner(runInput()), (error: unknown) => {
        assert.ok(error instanceof FixedPromptBudgetExhaustedError);
        assert.deepEqual(
          (error.artifactRefs as { executionIdentity?: HarborCellExecutionIdentity } | undefined)
            ?.executionIdentity,
          executionIdentity,
        );
        assert.deepEqual(error.artifactRefs?.tokenSummary, usageCheckpoint);
        return true;
      });
    });
  });

  // The runner transports the verifier's artifacts verbatim; the controller
  // decides what counts as a grade. So the contract under test here is only
  // "readable artifacts travel, unreadable ones do not" — including reward 0,
  // which is a real graded failure and must not be silently dropped.
  for (const trial of [
    {
      name: 'a passing reward',
      opts: { reward: '1.0\n' },
      expected: { reward: 1, outcome: 'passed' },
    },
    { name: 'a zero reward', opts: { reward: '0\n' }, expected: { reward: 0, outcome: 'failed' } },
    { name: 'no reward file', opts: {}, expected: undefined },
    { name: 'an empty reward file', opts: { reward: '' }, expected: undefined },
    { name: 'a non-numeric reward', opts: { reward: 'crashed\n' }, expected: undefined },
    {
      name: 'no verifier outcome file',
      opts: { reward: '1.0\n', verifierOutcome: null },
      expected: undefined,
    },
    {
      name: 'a malformed verifier outcome',
      opts: { reward: '1.0\n', verifierOutcome: { schemaVersion: 1, outcome: 'passed' } },
      expected: undefined,
    },
  ] as const) {
    test(`carries the verifier artifacts of a timed-out trial without cell output: ${trial.name}`, async () => {
      await withRun(async ({ jobsDir, repo }) => {
        const runner = createHarborTaskRunner({
          makaRepoPath: repo,
          jobsDir,
          model: 'deepseek/deepseek-v4-flash',
          runHarbor: fakeRunner({
            ...trial.opts,
            cell: null,
            trialResult: {
              exception_info: {
                exception_type: 'AgentTimeoutError',
                exception_message: 'Agent execution timed out after 60.0 seconds',
              },
            },
          }),
        });

        await assert.rejects(runner(runInput()), (error: unknown) => {
          assert.ok(error instanceof FixedPromptBudgetExhaustedError);
          assert.equal(error.artifactRefs?.harbor?.reward, trial.expected?.reward);
          assert.equal(error.artifactRefs?.harbor?.verifier?.outcome, trial.expected?.outcome);
          return true;
        });
      });
    });
  }

  // The reported defect end to end: the six dropped cells were exactly these
  // artifacts on disk. Nothing else joins the runner's read of the trial dir to
  // the WAL row the benchmark counts.
  test('scores a timed-out trial the verifier graded, from trial dir to WAL', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const event = await budgetExhaustedWalEvent({
        jobsDir,
        repo,
        opts: { reward: '1.0\n', cell: null },
      });
      assert.equal(event.passed, true);
      assert.equal(event.scored, true);
      assert.equal(event.eligible, true);
      assert.equal(event.harbor?.reward, 1);
    });
  });

  test('refuses to score a timed-out trial whose reward disagrees with its verifier outcome', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const event = await budgetExhaustedWalEvent({
        jobsDir,
        repo,
        opts: {
          reward: '1.0\n',
          verifierOutcome: {
            schemaVersion: 1,
            outcome: 'failed',
            attempts: [{ attempt: 1, classification: 'failed', durationMs: 1, reward: 0 }],
          },
          cell: null,
        },
      });
      // The completed path rejects these same artifacts as infra
      // (assertVerifierRewardAgreement); a missing self-report must not turn a
      // corrupt scoring authority into a pass.
      assert.equal(event.passed, false);
      assert.equal(event.scored, false);
    });
  });

  test('refuses to score a timed-out trial whose verifier never concluded', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const event = await budgetExhaustedWalEvent({
        jobsDir,
        repo,
        opts: {
          reward: '1.0\n',
          verifierOutcome: {
            schemaVersion: 1,
            outcome: 'candidate_timeout',
            attempts: [{ attempt: 1, classification: 'timeout', durationMs: 1 }],
          },
          cell: null,
        },
      });
      assert.equal(event.passed, false);
      assert.equal(event.scored, false);
    });
  });

  test('recovers checkpoint usage when a timed-out deadline cell has no summary', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const usageCheckpoint = tokenSummary({
        input: 120,
        output: 15,
        reasoning: 3,
        total: 135,
        costUsd: 0.009,
      });
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          cell: cellOutput({
            status: 'failed',
            errorClass: 'aborted',
            deadlineSettlement: { source: 'benchmark.deadline', mode: 'immediate' },
            tokenSummary: undefined,
          }),
          usageCheckpoint,
          trialResult: {
            exception_info: {
              exception_type: 'AgentTimeoutError',
              exception_message: 'Agent execution timed out after 60.0 seconds',
            },
          },
        }),
      });

      await assert.rejects(runner(runInput()), (error: unknown) => {
        assert.ok(error instanceof FixedPromptBudgetExhaustedError);
        assert.deepEqual(error.artifactRefs?.tokenSummary, usageCheckpoint);
        assert.deepEqual(error.artifactRefs?.cellOutput?.tokenSummary, usageCheckpoint);
        return true;
      });
    });
  });

  test('recovers child-inclusive usage when a timed-out cell has a parent summary', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const parentOnly = tokenSummary({
        input: 100,
        output: 10,
        reasoning: 2,
        total: 110,
        costUsd: 0.006,
      });
      const childInclusive = tokenSummary({
        input: 140,
        output: 20,
        reasoning: 5,
        total: 160,
        costUsd: 0.012,
      });
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          cell: cellOutput({ tokenSummary: parentOnly }),
          usageCheckpoint: childInclusive,
          trialResult: {
            exception_info: {
              exception_type: 'AgentTimeoutError',
              exception_message: 'Agent execution timed out after 60.0 seconds',
            },
          },
        }),
      });

      await assert.rejects(runner(runInput()), (error: unknown) => {
        assert.ok(error instanceof FixedPromptBudgetExhaustedError);
        assert.deepEqual(error.artifactRefs?.tokenSummary, childInclusive);
        assert.deepEqual(error.artifactRefs?.cellOutput?.tokenSummary, childInclusive);
        return true;
      });
    });
  });

  test('returns an unscored failed cell without throwing (model API failure path)', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          reward: '0\n',
          cell: cellOutput({ status: 'failed', errorClass: 'runtime_error' }),
        }),
      });
      const output = await runner(runInput());
      assert.equal(output.harbor.reward, 0);
      assert.equal(output.cell.status, 'failed');
      assert.equal(output.cell.errorClass, 'runtime_error');
    });
  });

  test('rejects a custom-verifier trial that omits its structured outcome', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          reward: '0\n',
          cell: cellOutput(),
          verifierOutcome: null,
          verifierStdout: [
            'Err:1 http://archive.ubuntu.com/ubuntu noble InRelease',
            '  502  Bad Gateway',
            'E: Failed to fetch http://archive.ubuntu.com/ubuntu/dists/noble/InRelease  502  Bad Gateway',
            '/tests/test.sh: line 8: curl: command not found',
            '/tests/test.sh: line 19: uvx: command not found',
          ].join('\n'),
        }),
      });

      await assert.rejects(runner(runInput()), (error: unknown) => {
        assert.ok(error instanceof HarborInfraError);
        assert.match(error.message, /structured verifier outcome/);
        return true;
      });
    });
  });

  test('uses structured verifier timeout outcome instead of stdout infrastructure heuristics', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          reward: '0\n',
          verifierStdout: 'APT 502 Failed to fetch archive',
          verifierOutcome: {
            schemaVersion: 1,
            outcome: 'candidate_timeout',
            attempts: [{ attempt: 1, classification: 'timeout', durationMs: 600_000 }],
          },
        }),
      });

      const output = await runner(runInput());

      assert.equal(output.harbor.verifierFailureSummary, 'candidate_timeout');
      assert.equal(output.harbor.verifier?.outcome, 'candidate_timeout');
      assert.equal(output.harbor.verifier?.attempts.length, 1);
      assert.notEqual(output.cell.errorClass, 'infra_failed');
    });
  });

  test('accepts recovery after multiple verifier infra attempts without rerunning the Agent', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      let agentRuns = 0;
      const runTrial = fakeRunner({
        reward: '1\n',
        verifierOutcome: {
          schemaVersion: 1,
          outcome: 'passed',
          attempts: [
            { attempt: 1, classification: 'infra_setup_failed', durationMs: 15, reward: 0 },
            { attempt: 2, classification: 'infra_setup_failed', durationMs: 25, reward: 0 },
            { attempt: 3, classification: 'passed', durationMs: 12, reward: 1 },
          ],
        },
      });
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: async (request) => {
          agentRuns += 1;
          return runTrial(request);
        },
      });

      const output = await runner(runInput());

      assert.equal(output.harbor.reward, 1);
      assert.equal(agentRuns, 1);
      assert.equal(output.harbor.verifier?.outcome, 'passed');
      assert.deepEqual(
        output.harbor.verifier?.attempts.map((attempt) => attempt.classification),
        ['infra_setup_failed', 'infra_setup_failed', 'passed'],
      );
    });
  });

  test('rejects a Harbor reward that disagrees with the structured verifier outcome', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          reward: '1\n',
          verifierOutcome: {
            schemaVersion: 1,
            outcome: 'failed',
            attempts: [{ attempt: 1, classification: 'failed', durationMs: 12, reward: 0 }],
          },
        }),
      });

      await assert.rejects(runner(runInput()), (error: unknown) => {
        assert.ok(error instanceof HarborInfraError);
        assert.match(error.message, /reward disagrees with verifier outcome/);
        return true;
      });
    });
  });

  test('summarizes verifier assertion failures without raw expected output', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          reward: '0\n',
          cell: cellOutput(),
          verifierStdout: [
            "E       AssertionError: Expected '79586' to be in answer.txt",
            "E       assert '79586' in '79585'",
          ].join('\n'),
        }),
      });

      const output = await runner(runInput());

      assert.equal(
        output.harbor.verifierFailureSummary,
        'output_assertion_failed integer_output_off_by_one',
      );
      assert.equal(JSON.stringify(output).includes('79586'), false);
      assert.equal(JSON.stringify(output).includes('79585'), false);
    });
  });

  test('summarizes final-state text mismatches without raw expected output', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          reward: '0\n',
          cell: cellOutput(),
          verifierStdout: [
            "E       AssertionError: Expected 'hello world'",
            "E       Got: 'hello from final test'",
          ].join('\n'),
        }),
      });

      const output = await runner(runInput());

      assert.equal(
        output.harbor.verifierFailureSummary,
        'output_assertion_failed final_state_expected_text_mismatch',
      );
      assert.equal(JSON.stringify(output).includes('hello world'), false);
      assert.equal(JSON.stringify(output).includes('hello from final test'), false);
    });
  });

  test('summarizes structured output value mismatches without raw verifier details', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          reward: '0\n',
          cell: cellOutput(),
          verifierStdout: [
            'E       AssertionError: Only found 0.00% of expected values in the submitted file',
            'E       missing values: 0x401234, 0x401250',
          ].join('\n'),
        }),
      });

      const output = await runner(runInput());

      assert.equal(
        output.harbor.verifierFailureSummary,
        'output_assertion_failed structured_output_values_mismatch',
      );
      assert.equal(JSON.stringify(output).includes('0x401234'), false);
      assert.equal(JSON.stringify(output).includes('0x401250'), false);
    });
  });
});

describe('createHarborOracleQualifier', () => {
  test('runs the built-in Oracle with the same structured verifier policy', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const captured: FakeOptions['captured'] = {};
      const qualify = createHarborOracleQualifier({
        makaRepoPath: repo,
        jobsDir,
        runHarbor: fakeRunner({
          captured,
          reward: '1\n',
          cell: null,
          verifierOutcome: {
            schemaVersion: 1,
            outcome: 'passed',
            attempts: [{ attempt: 1, classification: 'passed', durationMs: 12, reward: 1 }],
          },
        }),
      });

      const result = await qualify({ id: 'task-1', path: '/tasks/cobol-modernization' });
      const config = captured.config!;
      const verifier = config.verifier as Record<string, unknown>;
      assert.deepEqual(result, { outcome: 'passed', reward: 1, attempts: 1 });
      assert.deepEqual(config.agents, [{ name: 'oracle' }]);
      assert.equal(config.n_attempts, HARBOR_ORACLE_EXECUTION_POLICY.job.attempts);
      assert.equal(config.n_concurrent_trials, HARBOR_ORACLE_EXECUTION_POLICY.job.concurrentTrials);
      assert.equal(config.timeout_multiplier, HARBOR_ORACLE_EXECUTION_POLICY.job.timeoutMultiplier);
      assert.equal(
        (config.environment as Record<string, unknown>).force_build,
        HARBOR_ORACLE_EXECUTION_POLICY.environment.forceBuild,
      );
      assert.equal(
        (config.environment as Record<string, unknown>).delete,
        HARBOR_ORACLE_EXECUTION_POLICY.environment.delete,
      );
      assert.deepEqual((config.environment as Record<string, unknown>).extra_docker_compose, [
        join(
          repo,
          'packages/headless/harbor',
          HARBOR_ORACLE_EXECUTION_POLICY.environment.composeFile,
        ),
      ]);
      assert.equal(verifier.import_path, 'maka_verifier:MakaVerifier');
      assert.equal(
        (verifier.kwargs as Record<string, unknown>).attempt_timeout_sec,
        HARBOR_ORACLE_EXECUTION_POLICY.verifier.defaultAttemptTimeoutSec,
      );
      assert.equal(
        (verifier.kwargs as Record<string, unknown>).max_attempts,
        HARBOR_ORACLE_EXECUTION_POLICY.verifier.maxAttempts,
      );
      assert.equal(
        captured.request?.timeoutMs,
        HARBOR_ORACLE_EXECUTION_POLICY.watchdog.minimumSec * 1_000,
      );
    });
  });

  test('types the outer Oracle watchdog separately from a scored candidate timeout', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const qualify = createHarborOracleQualifier({
        makaRepoPath: repo,
        jobsDir,
        runHarbor: async () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'watchdog expired',
          timedOut: true,
          signal: 'SIGKILL',
        }),
      });

      await assert.rejects(
        qualify({ id: 'task-1', path: '/tasks/cobol-modernization' }),
        (error: unknown) => error instanceof HarborInfraError && error.kind === 'timed_out',
      );
    });
  });

  test('does not classify an unknown Oracle process failure as reusable infrastructure evidence', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const qualify = createHarborOracleQualifier({
        makaRepoPath: repo,
        jobsDir,
        runHarbor: async () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'Traceback: generated JobConfig parser bug',
        }),
      });

      await assert.rejects(
        qualify({ id: 'task-1', path: '/tasks/cobol-modernization' }),
        (error: unknown) => error instanceof Error && !(error instanceof HarborInfraError),
      );
    });
  });
});

describe('buildHarborJobConfig', () => {
  test('projects the Agent tool policy from the run config', () => {
    const config = buildHarborJobConfig(
      runInput({
        config: {
          id: 'cfg',
          backend: 'ai-sdk',
          llmConnectionSlug: 'deepseek',
          model: 'deepseek-v4-flash',
          agentTools: true,
        },
      }),
      {
        makaRepoPath: '/repo',
        jobsDir: '/jobs/x',
        jobName: 'trial',
        model: 'deepseek/deepseek-v4-flash',
      },
    );
    const agent = (config.agents as Array<Record<string, unknown>>)[0]!;
    const env = agent.env as Record<string, string>;

    assert.equal(env.MAKA_AGENT_TOOLS, 'true');
  });

  test('pins the OpenCode adapter and max model variant without serializing credentials', () => {
    const toolchain = {
      opencodeToolchainPath: '/cache/opencode-1.17.18-linux-x64',
      dockerPlatform: 'linux/amd64',
    } as const;
    const config = buildHarborJobConfig(runInput(), {
      makaRepoPath: '/repo',
      jobsDir: '/jobs/x',
      jobName: 'trial',
      agent: 'opencode',
      model: 'zai-coding-plan/glm-5.2',
      provider: 'zai-coding-plan',
      reasoningEffort: 'max',
      agentVersion: '1.17.18',
      pricing: { inputUsdPer1M: 1.4, cacheReadUsdPer1M: 0.26, outputUsdPer1M: 4.4 },
      ...toolchain,
    });
    const agent = (config.agents as Array<Record<string, unknown>>)[0]!;
    const env = agent.env as Record<string, string>;
    const mounts = (config.environment as { mounts: Array<Record<string, unknown>> }).mounts;
    const extraDockerCompose = (config.environment as { extra_docker_compose?: string[] })
      .extra_docker_compose;
    const verifier = config.verifier as Record<string, unknown>;

    // Harbor resolves built-in names before import_path, so setting both would
    // silently bypass MakaOpenCodeAgent and its host-side auth proxy.
    assert.equal(agent.name, undefined);
    assert.equal(agent.import_path, 'opencode_agent:MakaOpenCodeAgent');
    assert.equal(agent.model_name, 'zai-coding-plan/glm-5.2');
    assert.deepEqual(agent.kwargs, { version: '1.17.18' });
    assert.equal(env.MAKA_OPENCODE_VARIANT, 'max');
    assert.equal(env.MAKA_LLM_CONNECTION_SLUG, 'zai-coding-plan');
    assert.equal(env.MAKA_REASONING_EFFORT, 'max');
    assert.match(env.MAKA_OPENCODE_TOOLCHAIN_FINGERPRINT, /^sha256:[a-f0-9]{64}$/);
    assert.ok(
      mounts.some(
        (mount) =>
          mount.source === '/cache/opencode-1.17.18-linux-x64' &&
          mount.target === '/opt/maka-opencode-toolchain' &&
          mount.read_only === true,
      ),
    );
    assert.deepEqual(extraDockerCompose, [
      '/repo/packages/headless/harbor/docker-compose-linux-amd64.yaml',
    ]);
    assert.equal(verifier.import_path, 'maka_verifier:MakaVerifier');
    assert.deepEqual(verifier.kwargs, {
      attempt_timeout_sec: 600,
      max_attempts: 3,
      retry_backoff_sec: 2,
      total_timeout_sec: 1_200,
    });
    assert.equal(verifier.override_timeout_sec, 1_320);
    assert.equal(env.ZAI_API_KEY, undefined);
    assert.equal(env.ZAI_API_KEY_FILE, undefined);
  });

  test('pins the Maka arm to the same Docker platform as OpenCode', () => {
    const config = buildHarborJobConfig(runInput(), {
      makaRepoPath: '/repo',
      jobsDir: '/jobs/x',
      jobName: 'trial',
      agent: 'maka',
      model: 'zai-coding-plan/glm-5.2',
      provider: 'zai-coding-plan',
      dockerPlatform: 'linux/amd64',
    } as unknown as Parameters<typeof buildHarborJobConfig>[1]);

    assert.deepEqual(
      (config.environment as { extra_docker_compose?: string[] }).extra_docker_compose,
      ['/repo/packages/headless/harbor/docker-compose-linux-amd64.yaml'],
    );
  });

  test('the in-container Maka arm carries its toolchain and the fingerprint that admits it', async () => {
    const { MAKA_NODE_TOOLCHAIN_CONTAINER_PATH, MAKA_NODE_TOOLCHAIN_FINGERPRINT } = await import(
      '../maka-node-toolchain.js'
    );
    const base = {
      makaRepoPath: '/repo',
      jobsDir: '/jobs/x',
      jobName: 'trial',
      agent: 'maka',
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
    } as unknown as Parameters<typeof buildHarborJobConfig>[1];

    const inContainer = buildHarborJobConfig(runInput(), {
      ...base,
      makaPlacement: 'task-container',
      makaNodeToolchainPath: '/runs/r1/toolchains/maka-node',
    } as unknown as Parameters<typeof buildHarborJobConfig>[1]);

    // The arm cannot start without both halves: the adapter re-verifies the
    // mounted toolchain against the fingerprint before it will install, so a
    // mount without the fingerprint leaves the arm dead with the mount in
    // place -- which is exactly how this failed the first time.
    const mounts = (inContainer.environment as { mounts: Array<Record<string, unknown>> }).mounts;
    assert.ok(
      mounts.some(
        (m) =>
          m.target === MAKA_NODE_TOOLCHAIN_CONTAINER_PATH &&
          m.source === '/runs/r1/toolchains/maka-node' &&
          m.read_only === true,
      ),
    );
    const agent = (inContainer.agents as Array<Record<string, unknown>>)[0]!;
    assert.equal(
      (agent.env as Record<string, string>).MAKA_NODE_TOOLCHAIN_FINGERPRINT,
      MAKA_NODE_TOOLCHAIN_FINGERPRINT,
    );

    // Host-bridge is the historical shape and must stay free of both, or every
    // existing Terminal-Bench manifest changes identity for a run that did not.
    const hostBridge = buildHarborJobConfig(runInput(), base);
    const hostMounts = (hostBridge.environment as { mounts: Array<Record<string, unknown>> })
      .mounts;
    assert.equal(
      hostMounts.some((m) => m.target === MAKA_NODE_TOOLCHAIN_CONTAINER_PATH),
      false,
    );
    assert.equal(
      ((hostBridge.agents as Array<Record<string, unknown>>)[0]!.env as Record<string, string>)
        .MAKA_NODE_TOOLCHAIN_FINGERPRINT,
      undefined,
    );

    // A placement that asks for the container without supplying the toolchain
    // has to fail at config time; the alternative is a container that starts
    // and finds nothing at the mount point.
    assert.throws(
      () =>
        buildHarborJobConfig(runInput(), {
          ...base,
          makaPlacement: 'task-container',
        } as unknown as Parameters<typeof buildHarborJobConfig>[1]),
      /makaNodeToolchainPath is required for task-container Maka placement/,
    );
  });

  test('layers the apt mirror overlay after the harness compose file', () => {
    // Order is the assertion. Compose appends `extra_hosts` across `-f` files
    // rather than replacing them -- `docker compose config` over a base and an
    // overlay keeps every entry from both, duplicate keys included -- so the
    // host-gateway mapping every competitor dials survives either way. What the
    // order pins is a deterministic overlay position; it does not let the
    // mirror override a task image that declares its own archive.ubuntu.com
    // entry, which would sit beside ours and be resolved by /etc/hosts order.
    const config = buildHarborJobConfig(runInput(), {
      makaRepoPath: '/repo',
      jobsDir: '/jobs/x',
      jobName: 'trial',
      agent: 'maka',
      model: 'zai-coding-plan/glm-5.2',
      provider: 'zai-coding-plan',
      dockerPlatform: 'linux/amd64',
      aptMirrorComposePath: '/runs/r1/apt-mirror.compose.yaml',
    } as unknown as Parameters<typeof buildHarborJobConfig>[1]);

    assert.deepEqual(
      (config.environment as { extra_docker_compose?: string[] }).extra_docker_compose,
      [
        '/repo/packages/headless/harbor/docker-compose-linux-amd64.yaml',
        '/runs/r1/apt-mirror.compose.yaml',
      ],
    );
  });

  test('pins the Kimi Code adapter and official toolchain without serializing credentials', () => {
    const config = buildHarborJobConfig(runInput(), {
      makaRepoPath: '/repo',
      jobsDir: '/jobs/x',
      jobName: 'trial',
      agent: 'kimi-code',
      model: 'kimi-coding-plan/k3',
      provider: 'kimi-coding-plan',
      reasoningEffort: 'max',
      agentVersion: '0.26.0',
      kimiCodeToolchainPath: '/cache/kimi-code-0.26.0-linux-x64',
      dockerPlatform: 'linux/amd64',
    });
    const agent = (config.agents as Array<Record<string, unknown>>)[0]!;
    const env = agent.env as Record<string, string>;
    const mounts = (config.environment as { mounts: Array<Record<string, unknown>> }).mounts;

    assert.equal(agent.name, undefined);
    assert.equal(agent.import_path, 'kimi_code_agent:MakaKimiCodeAgent');
    assert.equal(agent.model_name, 'k3');
    assert.deepEqual(agent.kwargs, { version: '0.26.0' });
    assert.match(env.MAKA_KIMI_CODE_TOOLCHAIN_FINGERPRINT, /^sha256:[a-f0-9]{64}$/);
    assert.ok(
      mounts.some(
        (mount) =>
          mount.source === '/cache/kimi-code-0.26.0-linux-x64' &&
          mount.target === '/opt/maka-kimi-code-toolchain' &&
          mount.read_only === true,
      ),
    );
    assert.equal(env.KIMI_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
  });

  test('pins the Reasonix adapter and official toolchain without serializing credentials', () => {
    const config = buildHarborJobConfig(runInput(), {
      makaRepoPath: '/repo',
      jobsDir: '/jobs/x',
      jobName: 'trial',
      agent: 'reasonix',
      model: 'deepseek/deepseek-v4-flash',
      provider: 'deepseek',
      reasoningEffort: 'max',
      agentVersion: REASONIX_TOOLCHAIN_SPEC.reasonix.version,
      reasonixToolchainPath: '/cache/reasonix-1.19.4-linux-x64',
      dockerPlatform: 'linux/amd64',
    });
    const agent = (config.agents as Array<Record<string, unknown>>)[0]!;
    const env = agent.env as Record<string, string>;
    const mounts = (config.environment as { mounts: Array<Record<string, unknown>> }).mounts;

    assert.equal(agent.import_path, 'reasonix_agent:MakaReasonixAgent');
    assert.equal(agent.model_name, 'deepseek-v4-flash');
    assert.deepEqual(agent.kwargs, { version: REASONIX_TOOLCHAIN_SPEC.reasonix.version });
    assert.equal(env.MAKA_REASONIX_TOOLCHAIN_FINGERPRINT, REASONIX_TOOLCHAIN_FINGERPRINT);
    assert.equal(env.MAKA_REASONING_EFFORT, 'max');
    assert.ok(
      mounts.some(
        (mount) =>
          mount.source === '/cache/reasonix-1.19.4-linux-x64' &&
          mount.target === '/opt/maka-reasonix-toolchain' &&
          mount.read_only === true,
      ),
    );
    assert.equal(env.DEEPSEEK_API_KEY, undefined);
    assert.equal(env.MAKA_REASONIX_PROXY_TOKEN, undefined);
  });

  test('refuses a Reasonix arm whose adapter version drifts from the pinned toolchain', () => {
    assert.throws(
      () =>
        buildHarborJobConfig(runInput(), {
          makaRepoPath: '/repo',
          jobsDir: '/jobs/x',
          jobName: 'trial',
          agent: 'reasonix',
          model: 'deepseek/deepseek-v4-flash',
          provider: 'deepseek',
          agentVersion: '1.19.3',
          reasonixToolchainPath: '/cache/reasonix-1.19.4-linux-x64',
        }),
      /Reasonix adapter version must match toolchain version 1\.19\.4/,
    );
    assert.throws(
      () =>
        buildHarborJobConfig(runInput(), {
          makaRepoPath: '/repo',
          jobsDir: '/jobs/x',
          jobName: 'trial',
          agent: 'reasonix',
          model: 'deepseek/deepseek-v4-flash',
          provider: 'deepseek',
          agentVersion: REASONIX_TOOLCHAIN_SPEC.reasonix.version,
        }),
      /reasonixToolchainPath is required for the Reasonix adapter/,
    );
  });

  test('pins the Codex adapter and toolchain behind the host provider proxy', () => {
    const config = buildHarborJobConfig(runInput(), {
      makaRepoPath: '/repo',
      jobsDir: '/jobs/x',
      jobName: 'trial',
      agent: 'codex',
      model: 'openai/gpt-5.6-sol',
      provider: 'openai',
      reasoningEffort: 'max',
      agentVersion: '0.146.0',
      codexToolchainPath: '/cache/codex-0.146.0-linux-x64',
      dockerPlatform: 'linux/amd64',
    } as unknown as Parameters<typeof buildHarborJobConfig>[1]);
    const agent = (config.agents as Array<Record<string, unknown>>)[0]!;
    const env = agent.env as Record<string, string>;
    const mounts = (config.environment as { mounts: Array<Record<string, unknown>> }).mounts;

    assert.equal(agent.name, undefined);
    assert.equal(agent.import_path, 'codex_agent:MakaCodexAgent');
    assert.equal(agent.model_name, 'gpt-5.6-sol');
    assert.deepEqual(agent.kwargs, { version: '0.146.0', reasoning_effort: 'max' });
    assert.match(env.MAKA_CODEX_TOOLCHAIN_FINGERPRINT, /^sha256:[a-f0-9]{64}$/);
    assert.ok(
      mounts.some(
        (mount) =>
          mount.source === '/cache/codex-0.146.0-linux-x64' &&
          mount.target === '/opt/maka-codex-toolchain' &&
          mount.read_only === true,
      ),
    );
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.CODEX_API_KEY, undefined);
  });

  test('withholds the repo tree from a competitor arm', () => {
    const forAgent = (agent: 'maka' | 'codex' | 'claude-code') =>
      (
        buildHarborJobConfig(runInput(), {
          makaRepoPath: '/repo',
          jobsDir: '/jobs/x',
          jobName: 'trial',
          agent,
          model: 'deepseek/deepseek-v4-flash',
          provider: 'deepseek',
          agentVersion:
            agent === 'codex' ? '0.146.0' : CLAUDE_CODE_TOOLCHAIN_SPEC.claudeCode.version,
          codexToolchainPath: '/cache/codex',
          claudeCodeToolchainPath: '/cache/claude-code',
        } as unknown as Parameters<typeof buildHarborJobConfig>[1]).environment as {
          mounts: Array<Record<string, unknown>>;
        }
      ).mounts;

    // Maka executes out of the tree, so it still gets the tree.
    assert.ok(forAgent('maka').some((mount) => mount.target === '/opt/maka-agent'));

    // A competitor gets the files it named and no directory to walk. Reverting
    // to the shared tree mount re-opens the path Codex used in the #1970 run:
    // read the pinned benchmark revision, fetch the task's reference solution.
    for (const agent of ['codex', 'claude-code'] as const) {
      const repoMounts = forAgent(agent).filter((mount) =>
        String(mount.target).startsWith('/opt/maka-agent'),
      );
      assert.ok(
        repoMounts.every((mount) => mount.target !== '/opt/maka-agent'),
        `${agent} must not receive the repo root`,
      );
      assert.deepEqual(
        repoMounts.map((mount) => mount.target),
        competitorRepoFiles(agent).map((file) => `/opt/maka-agent/${file}`),
      );
    }
  });

  test('pins the Claude Code adapter and native toolchain behind the host provider proxy', () => {
    const config = buildHarborJobConfig(runInput(), {
      makaRepoPath: '/repo',
      jobsDir: '/jobs/x',
      jobName: 'trial',
      agent: 'claude-code',
      model: 'deepseek/deepseek-v4-flash',
      provider: 'deepseek',
      reasoningEffort: 'max',
      agentVersion: CLAUDE_CODE_TOOLCHAIN_SPEC.claudeCode.version,
      claudeCodeToolchainPath: '/cache/claude-code-2.1.220-linux-x64',
      dockerPlatform: 'linux/amd64',
    });
    const agent = (config.agents as Array<Record<string, unknown>>)[0]!;
    const env = agent.env as Record<string, string>;
    const mounts = (config.environment as { mounts: Array<Record<string, unknown>> }).mounts;

    assert.equal(agent.import_path, 'claude_code_agent:MakaClaudeCodeAgent');
    assert.equal(agent.model_name, 'deepseek-v4-flash');
    assert.deepEqual(agent.kwargs, { version: '2.1.220', reasoning_effort: 'max' });
    assert.equal(env.MAKA_CLAUDE_CODE_TOOLCHAIN_FINGERPRINT, CLAUDE_CODE_TOOLCHAIN_FINGERPRINT);
    assert.ok(
      mounts.some(
        (mount) =>
          mount.source === '/cache/claude-code-2.1.220-linux-x64' &&
          mount.target === '/opt/maka-claude-code-toolchain' &&
          mount.read_only === true,
      ),
    );
  });

  test('requires a prepared toolchain for OpenCode before Harbor starts', () => {
    assert.throws(
      () =>
        buildHarborJobConfig(runInput(), {
          makaRepoPath: '/repo',
          jobsDir: '/jobs/x',
          jobName: 'trial',
          agent: 'opencode',
          model: 'zai-coding-plan/glm-5.2',
          provider: 'zai-coding-plan',
          agentVersion: '1.17.18',
        }),
      /opencodeToolchainPath is required for the OpenCode adapter/,
    );
  });

  test('requires the pinned Kimi Code toolchain before Harbor starts', () => {
    assert.throws(
      () =>
        buildHarborJobConfig(runInput(), {
          makaRepoPath: '/repo',
          jobsDir: '/jobs/x',
          jobName: 'trial',
          agent: 'kimi-code',
          model: 'kimi-coding-plan/k3',
          provider: 'kimi-coding-plan',
          agentVersion: '0.26.0',
        }),
      /kimiCodeToolchainPath is required for the Kimi Code adapter/,
    );
    assert.throws(
      () =>
        buildHarborJobConfig(runInput(), {
          makaRepoPath: '/repo',
          jobsDir: '/jobs/x',
          jobName: 'trial',
          agent: 'kimi-code',
          model: 'kimi-coding-plan/k3',
          provider: 'kimi-coding-plan',
          agentVersion: '0.25.0',
          kimiCodeToolchainPath: '/toolchain',
        }),
      /Kimi Code adapter version must match toolchain version 0\.26\.0/,
    );
  });

  test('requires the pinned Codex toolchain before Harbor starts', () => {
    assert.throws(
      () =>
        buildHarborJobConfig(runInput(), {
          makaRepoPath: '/repo',
          jobsDir: '/jobs/x',
          jobName: 'trial',
          agent: 'codex',
          model: 'openai/gpt-5.6-sol',
          provider: 'openai',
          agentVersion: '0.146.0',
        } as unknown as Parameters<typeof buildHarborJobConfig>[1]),
      /codexToolchainPath is required for the Codex adapter/,
    );
    assert.throws(
      () =>
        buildHarborJobConfig(runInput(), {
          makaRepoPath: '/repo',
          jobsDir: '/jobs/x',
          jobName: 'trial',
          agent: 'codex',
          model: 'openai/gpt-5.6-sol',
          provider: 'openai',
          agentVersion: '0.143.0',
          codexToolchainPath: '/toolchain',
        } as unknown as Parameters<typeof buildHarborJobConfig>[1]),
      /Codex adapter version must match toolchain version 0\.146\.0/,
    );
  });

  test('rejects experiment identity overrides in extra agent env', () => {
    assert.throws(
      () =>
        buildHarborJobConfig(runInput(), {
          makaRepoPath: '/repo',
          jobsDir: '/jobs/x',
          jobName: 'trial',
          model: 'deepseek/deepseek-v4-flash',
          pricing: { inputUsdPer1M: 0.145, outputUsdPer1M: 0.29 },
          agentEnv: {
            MAKA_AGENT_TOOLS: 'false',
            MAKA_MODEL: 'deepseek-v4-pro',
            MAKA_SYSTEM_PROMPT: 'wrong prompt',
            MAKA_TRIAL_INPUT_USD_PER_1M: '9',
          },
        }),
      /agentEnv must not override experiment identity: MAKA_AGENT_TOOLS, MAKA_MODEL, MAKA_SYSTEM_PROMPT, MAKA_TRIAL_INPUT_USD_PER_1M/,
    );
  });

  test('rejects provider secrets in extra agent env at config-build time', () => {
    assert.throws(
      () =>
        buildHarborJobConfig(runInput(), {
          makaRepoPath: '/repo',
          jobsDir: '/jobs/x',
          jobName: 'trial',
          model: 'deepseek/deepseek-v4-flash',
          agentEnv: { DEEPSEEK_API_KEY: 'raw-secret' },
        }),
      /agentEnv must not contain provider secrets: DEEPSEEK_API_KEY/,
    );
  });

  test('rejects token-shaped provider secrets from an unrelated provider', () => {
    assert.throws(
      () =>
        buildHarborJobConfig(runInput(), {
          makaRepoPath: '/repo',
          jobsDir: '/jobs/x',
          jobName: 'trial',
          model: 'deepseek/deepseek-v4-flash',
          provider: 'deepseek',
          agentEnv: {
            MAKA_API_KEY: 'generic-secret',
            MAKA_HOST_API_KEY: 'host-secret',
            MAKA_HOST_API_KEY_FILE: '/tmp/host-secret',
            OPENAI_CODEX_OAUTH_TOKEN: 'codex-secret',
            GH_TOKEN: 'github-secret',
            HF_TOKEN: 'huggingface-secret',
          },
        }),
      /agentEnv must not contain provider secrets: GH_TOKEN, HF_TOKEN, MAKA_API_KEY, MAKA_HOST_API_KEY, MAKA_HOST_API_KEY_FILE, OPENAI_CODEX_OAUTH_TOKEN/,
    );
  });

  test('rejects secret-shaped env even when no provider registry entry owns it', () => {
    assert.throws(
      () =>
        buildHarborJobConfig(runInput(), {
          makaRepoPath: '/repo',
          jobsDir: '/jobs/x',
          jobName: 'trial',
          model: 'deepseek/deepseek-v4-flash',
          provider: 'deepseek',
          agentEnv: {
            ACME_API_KEY: 'unregistered-secret',
            GOOGLE_APPLICATION_CREDENTIALS: '/tmp/google-credentials.json',
            PGPASSWORD: 'postgres-secret',
          },
        }),
      /agentEnv must not contain provider secrets: ACME_API_KEY, GOOGLE_APPLICATION_CREDENTIALS, PGPASSWORD/,
    );
  });

  test('omits pricing env when no pricing is configured', () => {
    const config = buildHarborJobConfig(runInput(), {
      makaRepoPath: '/repo',
      jobsDir: '/jobs/x',
      jobName: 'trial',
      model: 'deepseek/deepseek-v4-flash',
    });
    const env = (config.agents as Array<{ env: Record<string, string> }>)[0]!.env;
    assert.equal(env.MAKA_TRIAL_INPUT_USD_PER_1M, undefined);
    assert.equal(env.MAKA_BACKEND, 'ai-sdk');
  });

  // Deadline assertions below go through harborAgentPhaseSec — Harbor's own
  // resolution rule, modelled once in ./helpers/harbor-agent-phase.js and shared with
  // the smoke producer's suite. See that file for why a field-shaped assertion
  // is not enough.

  test('resolves Maka a settlement tail past the task-declared agent timeout', () => {
    // The regression this pins: publishing budget + grace on max_timeout_sec.
    // Harbor folds that to min(1800, 1830) = 1800, so the cell was SIGKILLed at
    // the instant it was supposed to begin writing maka-cell-output.json — and
    // every timed-out Maka cell lost its already-authoritative verifier reward.
    const declared = 1800;
    const config = buildHarborJobConfig(runInput(), {
      makaRepoPath: '/repo',
      jobsDir: '/jobs/x',
      jobName: 'trial',
      model: 'deepseek/deepseek-v4-flash',
      agentEnv: { MAKA_CELL_TIMEOUT_SEC: String(declared) },
    });
    const agent = (config.agents as HarborAgentEntry[])[0]!;
    assert.equal(
      harborAgentPhaseSec(config, declared),
      declared + MAKA_SETTLEMENT_GRACE_SEC,
      'Harbor must kill one settlement window after the model budget, not at it',
    );
    // A ceiling cannot raise a base, so leaving one behind can only re-clamp it.
    assert.equal(agent.max_timeout_sec, undefined);
  });

  test('every arm gets the same model budget and only Maka a settlement tail', () => {
    // Maka's cell stops calling the model one grace window before its own budget
    // runs out; native CLIs run until Harbor cancels. Taking the grace out of the
    // budget would hand Maka less model time than its competitors for the same task.
    const configFor = (adapter: 'maka' | 'codex') =>
      buildHarborJobConfig(runInput(), {
        makaRepoPath: '/repo',
        jobsDir: '/jobs/x',
        jobName: 'trial',
        model: 'deepseek/deepseek-v4-flash',
        agentEnv: { MAKA_CELL_TIMEOUT_SEC: '1800' },
        ...(adapter === 'codex'
          ? {
              agent: adapter,
              agentVersion: CODEX_TOOLCHAIN_SPEC.codex.version,
              codexToolchainPath: '/toolchains/codex',
            }
          : {}),
      });

    // Pin the window as a real quantity: with a zero grace every assertion below
    // would hold for an implementation that gives no arm any settlement tail.
    assert.ok(MAKA_SETTLEMENT_GRACE_SEC > 0, 'the settlement window must be a real window');

    const makaConfig = configFor('maka');
    const maka = (makaConfig.agents as HarborAgentEntry[])[0]!;
    const makaPhase = harborAgentPhaseSec(makaConfig, 1800);
    assert.equal(makaPhase, 1800 + MAKA_SETTLEMENT_GRACE_SEC);
    // The budget the cell is handed is the model budget itself, on every path.
    assert.equal(maka.env.MAKA_CELL_TIMEOUT_SEC, '1800');
    assert.equal(maka.env.MAKA_CELL_SETTLEMENT_GRACE_SEC, String(MAKA_SETTLEMENT_GRACE_SEC));
    // Harbor kills at the agent phase, which is that budget plus the window.
    assert.equal(makaPhase - Number(maka.env.MAKA_CELL_TIMEOUT_SEC), MAKA_SETTLEMENT_GRACE_SEC);

    const codexConfig = configFor('codex');
    const codex = (codexConfig.agents as HarborAgentEntry[])[0]!;
    const codexPhase = harborAgentPhaseSec(codexConfig, 1800);
    assert.equal(codexPhase, 1800);
    assert.equal(codex.env.MAKA_CELL_SETTLEMENT_GRACE_SEC, undefined);
    // The whole asymmetry: Maka's phase is longer by exactly the window it
    // spends settling, and both arms still call the model for the same 1800s.
    assert.equal(makaPhase - codexPhase, MAKA_SETTLEMENT_GRACE_SEC);
  });

  test('an operator-widened settlement window is honoured, not overwritten', () => {
    // The grace is a default, not a constant: a run that needs a longer tail
    // must keep it, and the budget must widen with it so model time is unchanged.
    const widened = MAKA_SETTLEMENT_GRACE_SEC + 45;
    const config = buildHarborJobConfig(runInput(), {
      makaRepoPath: '/repo',
      jobsDir: '/jobs/x',
      jobName: 'trial',
      model: 'deepseek/deepseek-v4-flash',
      agentEnv: {
        MAKA_CELL_TIMEOUT_SEC: '1800',
        MAKA_CELL_SETTLEMENT_GRACE_SEC: String(widened),
      },
    });
    const agent = (config.agents as HarborAgentEntry[])[0]!;
    assert.equal(agent.env.MAKA_CELL_SETTLEMENT_GRACE_SEC, String(widened));
    assert.equal(agent.env.MAKA_CELL_TIMEOUT_SEC, '1800');
    assert.equal(harborAgentPhaseSec(config, 1800), 1800 + widened);
  });

  test('a malformed cell timeout falls back instead of failing the run', () => {
    // Shared contract with the Python adapter (maka_agent.py _cell_timeout_sec):
    // an unparseable or non-positive MAKA_CELL_TIMEOUT_SEC falls back to the task
    // metadata timeout, or passes through for the adapter to apply its default.
    // Both sides accept an ASCII decimal positive integer literal only
    // (regex [1-9][0-9]*) capped at 2^53-1, so "1e3"/"1.0"/"+1800"/"01800"/"1٢"
    // are a miss; the over-long row locks the JS guard against Number() overflow
    // (unified in #1145).
    const cases: Array<{ raw: string | undefined; parsed: number | undefined }> = [
      { raw: undefined, parsed: undefined },
      { raw: '', parsed: undefined },
      { raw: '   ', parsed: undefined },
      { raw: 'oops', parsed: undefined },
      { raw: '0', parsed: undefined },
      { raw: '-5', parsed: undefined },
      { raw: '1e3', parsed: undefined },
      { raw: '1.0', parsed: undefined },
      { raw: '1800', parsed: 1800 },
      { raw: '+1800', parsed: undefined },
      { raw: '01800', parsed: undefined },
      { raw: '1٢', parsed: undefined },
      { raw: '9'.repeat(400), parsed: undefined },
    ];
    for (const { raw, parsed } of cases) {
      const agentEnv: Record<string, string> =
        raw === undefined ? {} : { MAKA_CELL_TIMEOUT_SEC: raw };
      // String(): JSON.stringify(undefined) is undefined, and an undefined assert
      // message throws ERR_INVALID_ARG_TYPE over the top of the real diff.
      const label = String(JSON.stringify(raw));

      // A parse miss falls back to the task metadata timeout.
      const withMetadata = buildHarborJobConfig(
        runInput({
          task: {
            id: 'task-1',
            path: '/tasks/task-1',
            metadata: { agentTimeoutSec: 1234 },
          },
          agentEnv,
        }),
        {
          makaRepoPath: '/repo',
          jobsDir: '/jobs/x',
          jobName: 'trial',
          model: 'deepseek/deepseek-v4-flash',
        },
      );
      const metadataAgent = (withMetadata.agents as HarborAgentEntry[])[0]!;
      assert.equal(metadataAgent.env.MAKA_CELL_TIMEOUT_SEC, String(parsed ?? 1234), label);
      assert.equal(
        metadataAgent.env.MAKA_STREAM_CONNECT_TIMEOUT_MS,
        String((parsed ?? 1234) * 1_000),
        label,
      );
      assert.equal(
        metadataAgent.env.MAKA_STREAM_IDLE_TIMEOUT_MS,
        String((parsed ?? 1234) * 1_000),
        label,
      );
      assert.equal(
        harborAgentPhaseSec(withMetadata, 1234),
        (parsed ?? 1234) + MAKA_SETTLEMENT_GRACE_SEC,
        label,
      );

      // Without metadata, a parsed value is rewritten into the env; a parse
      // miss passes the raw string through for the adapter's default.
      const withoutMetadata = buildHarborJobConfig(runInput({ agentEnv }), {
        makaRepoPath: '/repo',
        jobsDir: '/jobs/x',
        jobName: 'trial',
        model: 'deepseek/deepseek-v4-flash',
      });
      const agent = (withoutMetadata.agents as HarborAgentEntry[])[0]!;
      assert.equal(
        agent.env.MAKA_CELL_TIMEOUT_SEC,
        parsed !== undefined ? String(parsed) : raw,
        label,
      );
      // With nothing to derive a budget from, the phase must stay Harbor's own —
      // the task's declared timeout, stood in for here by a sentinel.
      const declaredSentinel = 4321;
      assert.equal(
        harborAgentPhaseSec(withoutMetadata, declaredSentinel),
        parsed === undefined ? declaredSentinel : parsed + MAKA_SETTLEMENT_GRACE_SEC,
        label,
      );
    }
  });

  test('uses each Terminal-Bench task native agent timeout when no override is set', () => {
    const config = buildHarborJobConfig(
      runInput({
        task: {
          id: 'task-1',
          path: '/tasks/task-1',
          metadata: { agentTimeoutSec: 1234 },
        },
      }),
      {
        makaRepoPath: '/repo',
        jobsDir: '/jobs/x',
        jobName: 'trial',
        model: 'zai-coding-plan/glm-5.2',
        provider: 'zai-coding-plan',
      },
    );
    const agent = (config.agents as HarborAgentEntry[])[0]!;
    assert.equal(agent.env.MAKA_CELL_TIMEOUT_SEC, '1234');
    assert.equal(agent.env.MAKA_STREAM_CONNECT_TIMEOUT_MS, '1234000');
    assert.equal(agent.env.MAKA_STREAM_IDLE_TIMEOUT_MS, '1234000');
    assert.equal(harborAgentPhaseSec(config, 1234), 1234 + MAKA_SETTLEMENT_GRACE_SEC);
  });

  test('merges per-attempt agent env into the Harbor agent config', () => {
    const config = buildHarborJobConfig(
      runInput({
        agentEnv: {
          MAKA_CONTEXT_BUDGET: 'off',
          MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on',
        },
      }),
      {
        makaRepoPath: '/repo',
        jobsDir: '/jobs/x',
        jobName: 'trial',
        model: 'deepseek/deepseek-v4-flash',
        agentEnv: { MAKA_CELL_TIMEOUT_SEC: '1800' },
      },
    );
    const env = (config.agents as Array<{ env: Record<string, string> }>)[0]!.env;
    assert.equal(env.MAKA_CELL_TIMEOUT_SEC, '1800');
    assert.equal(env.MAKA_CONTEXT_BUDGET, 'off');
    assert.equal(env.MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE, 'on');
  });

  test('keeps a gateway-routed slashful model id when the prefix is not the provider', () => {
    const config = buildHarborJobConfig(runInput(), {
      makaRepoPath: '/repo',
      jobsDir: '/jobs/x',
      jobName: 'trial',
      model: 'anthropic/claude-sonnet-4-5',
      provider: 'openai-compatible',
    });
    const agent = (config.agents as Array<{ env: Record<string, string>; model_name: string }>)[0]!;
    assert.equal(agent.env.MAKA_MODEL, 'anthropic/claude-sonnet-4-5');
    assert.equal(agent.model_name, 'anthropic/claude-sonnet-4-5');
  });
});

describe('createHarborTaskRunner timeout', () => {
  test('forwards a default wall-clock timeout to the harbor process', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      let seenTimeout: number | undefined;
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: async (request) => {
          seenTimeout = request.timeoutMs;
          return fakeRunner({ reward: '1\n' })(request);
        },
      });
      await runner(runInput());
      assert.equal(seenTimeout, 45 * 60_000);
    });
  });

  test('derives the outer Harbor timeout from task-native agent and verifier limits', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      let seenTimeout: number | undefined;
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'zai-coding-plan/glm-5.2',
        provider: 'zai-coding-plan',
        runHarbor: async (request) => {
          seenTimeout = request.timeoutMs;
          return fakeRunner({ reward: '1\n' })(request);
        },
      });
      await runner(
        runInput({
          task: {
            id: 'task-1',
            path: '/tasks/task-1',
            metadata: { agentTimeoutSec: 7_200, verifierTimeoutSec: 600 },
          },
        }),
      );
      // The agent phase Harbor is handed is the model budget plus Maka's
      // settlement window, so the watchdog has to outlast that sum — otherwise
      // it can kill a trial that is still legitimately settling.
      assert.equal(seenTimeout, (7_200 + MAKA_SETTLEMENT_GRACE_SEC + 1_320 + 15 * 60) * 1_000);
    });
  });

  test('gives a native CLI arm no settlement window in the outer watchdog', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      let seenTimeout: number | undefined;
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        agent: 'codex',
        agentVersion: CODEX_TOOLCHAIN_SPEC.codex.version,
        codexToolchainPath: '/toolchains/codex',
        runHarbor: async (request) => {
          seenTimeout = request.timeoutMs;
          return fakeRunner({ reward: '1\n' })(request);
        },
      });
      await runner(
        runInput({
          task: {
            id: 'task-1',
            path: '/tasks/task-1',
            metadata: { agentTimeoutSec: 7_200, verifierTimeoutSec: 600 },
          },
        }),
      );
      // Codex is cancelled at its own deadline with nothing to settle, so its
      // watchdog must not carry Maka's window either.
      assert.equal(seenTimeout, (7_200 + 1_320 + 15 * 60) * 1_000);
    });
  });

  test('derives the outer Harbor timeout from a configured cell budget above the task limit', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      let seenTimeout: number | undefined;
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'kimi-coding-plan/k3',
        provider: 'kimi-coding-plan',
        agentEnv: { MAKA_CELL_TIMEOUT_SEC: '7200' },
        runHarbor: async (request) => {
          seenTimeout = request.timeoutMs;
          return fakeRunner({ reward: '1\n' })(request);
        },
      });
      await runner(
        runInput({
          task: {
            id: 'task-1',
            path: '/tasks/task-1',
            metadata: { agentTimeoutSec: 600, verifierTimeoutSec: 600 },
          },
        }),
      );
      assert.equal(seenTimeout, (7_200 + MAKA_SETTLEMENT_GRACE_SEC + 1_320 + 15 * 60) * 1_000);
    });
  });

  test('puts the adapter dir on PYTHONPATH so harbor can import maka_agent', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      let seenEnv: Record<string, string> | undefined;
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: async (request) => {
          seenEnv = request.env;
          return fakeRunner({ reward: '1\n' })(request);
        },
      });
      await runner(runInput());
      assert.ok(seenEnv?.PYTHONPATH?.startsWith(join(repo, 'packages', 'headless', 'harbor')));
    });
  });

  test('forwards an explicit harborTimeoutMs override', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      let seenTimeout: number | undefined;
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        harborTimeoutMs: 1234,
        runHarbor: async (request) => {
          seenTimeout = request.timeoutMs;
          return fakeRunner({ reward: '1\n' })(request);
        },
      });
      await runner(runInput());
      assert.equal(seenTimeout, 1234);
    });
  });

  test('classifies the outer Harbor watchdog as infrastructure failure', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        harborTimeoutMs: 600_000,
        runHarbor: async () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'killed after timeout',
          timedOut: true,
          signal: 'SIGKILL',
        }),
      });
      await assert.rejects(runner(runInput()), HarborInfraError);
    });
  });

  test('keeps an outer watchdog timeout infrastructural after cell output exists', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const writeArtifacts = fakeRunner({
        cell: cellOutput({
          executionIdentity: {
            llmConnectionSlug: 'deepseek',
            model: 'deepseek-v4-flash',
            systemPromptHash: 'sha256:abc',
            pricingProfile: 'test-profile',
          },
        }),
      });
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: async (request) => {
          await writeArtifacts(request);
          return {
            exitCode: 1,
            stdout: '',
            stderr: 'timed out',
            timedOut: true,
            signal: 'SIGKILL',
          };
        },
      });

      await assert.rejects(runner(runInput()), HarborInfraError);
    });
  });

  test('keeps an outer watchdog timeout infrastructural after early identity exists', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const executionIdentity = {
        llmConnectionSlug: 'deepseek',
        model: 'deepseek-v4-flash',
        systemPromptHash: 'sha256:abc',
        pricingProfile: 'test-profile',
      };
      const writeArtifacts = fakeRunner({ cell: null, executionIdentity });
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: async (request) => {
          await writeArtifacts(request);
          return {
            exitCode: 1,
            stdout: '',
            stderr: 'timed out',
            timedOut: true,
            signal: 'SIGKILL',
          };
        },
      });

      await assert.rejects(runner(runInput()), HarborInfraError);
    });
  });
});

describe('incompleteTerminalProviderRequest', () => {
  const request = (outcome: ProviderRequestTelemetry['outcome']): ProviderRequestTelemetry => ({
    requestId: 1,
    method: 'POST',
    path: '/v1/messages',
    outcome,
    durationMs: 10,
    bodyChunks: 1,
    responseBytes: 10,
    terminalEvent: outcome === 'completed',
  });

  test('accepts a completed tail request whether or not the trial settled', () => {
    assert.equal(incompleteTerminalProviderRequest([request('completed')], false), undefined);
    assert.equal(incompleteTerminalProviderRequest([request('completed')], true), undefined);
  });

  test('exempts a settled trial whose tail request the client tore down', () => {
    // `aborted` is set from `signal.aborted` — it is what killing the agent
    // looks like from the proxy, so a settled trial explains it.
    assert.equal(incompleteTerminalProviderRequest([request('aborted')], true), undefined);
  });

  test('keeps a provider-side truncation infra even on a settled trial', () => {
    // This is the boundary that keeps a provider outage out of the denominator
    // instead of recording it as the agent's zero. `interrupted` (200 stream
    // with no terminal event) and `failed` are the upstream's doing, and the
    // agent phase ending does not explain either.
    for (const outcome of ['interrupted', 'failed'] as const) {
      assert.equal(
        incompleteTerminalProviderRequest([request(outcome)], true)?.outcome,
        outcome,
        `${outcome} must stay infra`,
      );
    }
  });

  test('withholds a budget-exhausted grade when the provider cut the tail request short', () => {
    // The grade is evidence only if the agent got the run it was given. A
    // provider-side truncation says it did not, so the verdict does not travel
    // — the same boundary that makes the settled path infra, applied where the
    // trial ends as a budget exhaustion instead.
    const grade = { reward: 1 };
    assert.equal(trialGradeSurvivingProviderOutage(grade, [request('completed')]), grade);
    assert.equal(trialGradeSurvivingProviderOutage(grade, [request('aborted')]), grade);
    assert.equal(trialGradeSurvivingProviderOutage(grade, []), grade);
    for (const outcome of ['interrupted', 'failed'] as const) {
      assert.equal(
        trialGradeSurvivingProviderOutage(grade, [request(outcome)]),
        undefined,
        `${outcome} must withhold the grade`,
      );
    }
    assert.equal(trialGradeSurvivingProviderOutage(undefined, [request('completed')]), undefined);
  });

  test('keeps every non-completing tail request infra on an unsettled trial', () => {
    for (const outcome of ['interrupted', 'failed', 'aborted'] as const) {
      assert.equal(incompleteTerminalProviderRequest([request(outcome)], false)?.outcome, outcome);
    }
  });

  test('reads only the last request', () => {
    assert.equal(
      incompleteTerminalProviderRequest([request('failed'), request('completed')], false),
      undefined,
    );
    assert.equal(incompleteTerminalProviderRequest([], false), undefined);
  });
});

test('the linux/amd64 compose override resolves host.docker.internal for in-container agents', async () => {
  const compose = await readFile(
    new URL('../../harbor/docker-compose-linux-amd64.yaml', import.meta.url),
    'utf8',
  );

  // Docker Desktop injects this name; native Linux Docker does not. Codex and
  // Claude Code dial it to reach the host credential proxy, so dropping the
  // mapping fails both competitor arms before their first model step while the
  // Maka host cell -- which uses loopback -- keeps passing. That asymmetry
  // looks like a competitor defect rather than a harness one, so pin it here.
  assert.match(compose, /extra_hosts:/);
  assert.match(compose, /host\.docker\.internal:host-gateway/);
});
