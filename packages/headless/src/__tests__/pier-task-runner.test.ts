import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { HarborCellOutput } from '../cell-output.js';
import {
  FixedPromptBudgetExhaustedError,
  hashSystemPrompt,
  runFixedPromptController,
  type TaskRunInput,
  type TaskRunOutput,
} from '../fixed-prompt-controller.js';
import { competitorRepoFiles } from '../agent-repo-mount.js';
import { CODEX_TOOLCHAIN_FINGERPRINT, CODEX_TOOLCHAIN_SPEC } from '../codex-toolchain.js';
import { OPENCODE_TOOLCHAIN_FINGERPRINT, OPENCODE_TOOLCHAIN_SPEC } from '../opencode-toolchain.js';
import { findTrialDir, MAKA_SETTLEMENT_GRACE_SEC } from '../harbor-task-runner.js';
import { MAKA_NODE_TOOLCHAIN_FINGERPRINT } from '../maka-node-toolchain.js';
import type { ProviderRequestTelemetry } from '../provider-auth-proxy.js';
import {
  buildPierRunArgs,
  createPierProviderProxyHub,
  createPierTaskRunner,
  defaultPierProcessRunner,
  PierInfraError,
  type PierProcessRunner,
  type PierRunRequest,
  type PierRunResult,
  type PierTaskRunnerOptions,
} from '../pier-task-runner.js';

function terminationRequest(script: string, graceMs: number): PierRunRequest {
  return {
    pierBin: 'bash',
    jobName: 'trial',
    jobsDir: '/tmp',
    args: ['-c', script],
    cwd: '/tmp',
    timeoutMs: 400,
    terminationGraceMs: graceMs,
  };
}

test('defaultPierProcessRunner terminates with SIGTERM first so pier can tear down', async () => {
  // Pier converts SIGTERM into KeyboardInterrupt (pier/cli/jobs.py) and runs
  // its finally-based docker teardown; a straight SIGKILL would leak the trial
  // containers and orphan a host cell. The trap stands in for that handler.
  const result = await defaultPierProcessRunner(
    terminationRequest("trap 'echo got-term; exit 0' TERM; echo ready; sleep 30 & wait", 5_000),
  );
  assert.equal(result.timedOut, true);
  assert.match(result.stdout, /got-term/);
  assert.notEqual(result.signal, 'SIGKILL');
});

test('defaultPierProcessRunner escalates to SIGKILL after the grace', async () => {
  // The loop respawns children the group SIGTERM kills, while bash itself
  // ignores TERM — only the SIGKILL escalation can end it.
  const result = await defaultPierProcessRunner(
    terminationRequest("trap '' TERM; while true; do sleep 1; done", 300),
  );
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGKILL');
});

test('shared findTrialDir honors the exception_stats trial-name hint with pier diagnostics', async () => {
  // The pier runner reuses harbor's trial-dir discovery, which must keep the
  // exception_stats branch: an errored trial appears only there, and the
  // directory-name fallback cannot disambiguate a stale sibling dir.
  const jobDir = await mkdtemp(join(tmpdir(), 'pier-findtrial-'));
  try {
    await mkdir(join(jobDir, 'stale-dir'));
    await mkdir(join(jobDir, 'errored-trial'));
    await writeFile(
      join(jobDir, 'result.json'),
      JSON.stringify({
        stats: {
          evals: { e1: { exception_stats: { NonZeroAgentExitCodeError: ['errored-trial'] } } },
        },
      }),
      'utf8',
    );
    const found = await findTrialDir(jobDir, 'unmatched-task', 'pier', PierInfraError);
    assert.equal(found, join(jobDir, 'errored-trial'));
    await assert.rejects(
      findTrialDir(join(jobDir, 'missing'), 'unmatched-task', 'pier', PierInfraError),
      (error: unknown) =>
        error instanceof PierInfraError && /pier produced no job output/.test(error.message),
    );
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

function cellOutput(overrides: Partial<HarborCellOutput> = {}): HarborCellOutput {
  return {
    schemaVersion: 1,
    status: 'completed',
    runtimeEventsPath: '/logs/agent/runtime-events.jsonl',
    executionIdentity: {
      llmConnectionSlug: 'fake',
      model: 'fake',
      systemPromptMode: 'default',
      systemPromptHash: 'sha256:abc',
      pricingProfile: 'fake-structural',
      agentTools: false,
    },
    toolSummary: {
      providerVisibleToolCount: 0,
      actualToolCalls: 0,
      actualToolNames: [],
      actualToolCallCounts: {},
    },
    steps: 1,
    durationMs: 9790,
    startedAt: 1,
    finishedAt: 2,
    runtimeRefs: { invocationId: 'inv', sessionId: 'sess', runId: 'run', turnId: 'turn' },
    ...overrides,
  };
}

interface FakeOptions {
  reward?: number;
  rewardJson?: boolean;
  /** Write reward.json verbatim (e.g. '{}' or malformed JSON), overriding the
   * structured numeric-reward body. */
  rewardJsonRaw?: string;
  verifierResultReward?: number;
  cell?: HarborCellOutput | null;
  executionIdentity?: Record<string, unknown>;
  exceptionInfo?: { exception_type: string; exception_message: string };
  exitCode?: number;
  timedOut?: boolean;
  combinedTrace?: boolean;
  sessionTrace?: boolean;
  captured?: { request?: PierRunRequest; envFile?: Record<string, string> };
}

/** A Pier process runner that writes the maka-dasel-fake2 trial layout: a
 * `<task>__<7ch>` trial dir with agent/maka-cell-output.json, verifier/reward.json,
 * and result.json (job aggregate + per-trial). Mirrors the captured schema. */
function fakePier(opts: FakeOptions): PierProcessRunner {
  return async (request): Promise<PierRunResult> => {
    if (opts.captured) {
      opts.captured.request = request;
      const envFileFlag = request.args.indexOf('--env-file');
      if (envFileFlag >= 0) {
        const raw = await readFile(request.args[envFileFlag + 1]!, 'utf8');
        opts.captured.envFile = Object.fromEntries(
          raw
            .split('\n')
            .filter((line) => line.includes('='))
            .map((line) => {
              const index = line.indexOf('=');
              return [line.slice(0, index), line.slice(index + 1)];
            }),
        );
      }
    }
    if (opts.timedOut) {
      return { exitCode: 137, stdout: '', stderr: 'killed', timedOut: true, signal: 'SIGKILL' };
    }
    if (opts.exitCode && opts.exitCode !== 0 && opts.cell === undefined && !opts.exceptionInfo) {
      return { exitCode: opts.exitCode, stdout: '', stderr: 'container build failed' };
    }
    const pathFlag = request.args.indexOf('-p');
    const taskName = request.args[pathFlag + 1]!.split('/').pop()!;
    const trialDir = join(request.jobsDir, request.jobName, `${taskName}__fjabYqp`);
    await mkdir(join(trialDir, 'agent'), { recursive: true });
    await mkdir(join(trialDir, 'verifier'), { recursive: true });
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
    await writeFile(join(trialDir, 'agent', 'runtime-events.jsonl'), '{"type":"x"}\n', 'utf8');
    if (opts.combinedTrace) {
      await writeFile(join(trialDir, 'agent', 'trace-events.jsonl'), '{"type":"first"}\n', 'utf8');
    }
    if (opts.sessionTrace) {
      // The in-cell session trace layout hostTraceEventsPath resolves via
      // cell.runtimeRefs (sessionId 'sess', runId 'run' in cellOutput()).
      const sessionDir = join(trialDir, 'agent', 'maka-storage', 'sessions', 'sess', 'runs', 'run');
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(sessionDir, 'events.jsonl'), '{"type":"tool_failed"}\n', 'utf8');
    }
    if (opts.rewardJsonRaw !== undefined) {
      await writeFile(join(trialDir, 'verifier', 'reward.json'), opts.rewardJsonRaw, 'utf8');
    } else if (opts.reward !== undefined && opts.rewardJson !== false) {
      await writeFile(
        join(trialDir, 'verifier', 'reward.json'),
        JSON.stringify({ reward: opts.reward, f2p: 0, p2p: 1 }),
        'utf8',
      );
    }
    const trialResult: Record<string, unknown> = {
      trial_name: `${taskName}__fjabYqp`,
      exception_info: opts.exceptionInfo ?? null,
      ...(opts.verifierResultReward !== undefined
        ? { verifier_result: { rewards: { reward: opts.verifierResultReward } } }
        : {}),
    };
    await writeFile(join(trialDir, 'result.json'), JSON.stringify(trialResult), 'utf8');
    // Job aggregate result.json points at the trial name via stats.evals[*].reward_stats.
    await writeFile(
      join(request.jobsDir, request.jobName, 'result.json'),
      JSON.stringify({
        stats: {
          evals: {
            maka__fake__adhoc: {
              reward_stats: { reward: { '0': [`${taskName}__fjabYqp`] } },
            },
          },
        },
      }),
      'utf8',
    );
    return { exitCode: opts.exitCode ?? 0, stdout: 'ok', stderr: '' };
  };
}

function runInput(overrides: Partial<TaskRunInput> = {}): TaskRunInput {
  return {
    runId: 'run-1',
    roundId: 'round-1',
    task: { id: 'dasel', path: '/tasks/dasel-html-document-format' },
    config: { id: 'cfg', backend: 'ai-sdk', llmConnectionSlug: 'fake', model: 'fake' },
    systemPrompt: 'CANDIDATE PROMPT\n',
    ...overrides,
  };
}

async function withDirs<T>(
  fn: (dirs: { jobsDir: string; repo: string }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'maka-pier-runner-'));
  try {
    return await fn({ jobsDir: join(root, 'jobs'), repo: join(root, 'repo') });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function baseOptions(
  overrides: Partial<PierTaskRunnerOptions> &
    Pick<PierTaskRunnerOptions, 'jobsDir' | 'makaRepoPath'>,
): PierTaskRunnerOptions {
  return { model: 'fake', backend: 'fake', ...overrides };
}

test('buildPierRunArgs emits the pier CLI contract for the Maka arm', () => {
  const args = buildPierRunArgs({
    agent: 'maka',
    model: 'k3',
    taskPath: '/tasks/dasel',
    jobsDir: '/jobs',
    jobName: 'trial',
    environment: 'docker',
    timeoutMultiplier: 1,
    agentTimeoutMultiplier: 1.0055555555555555,
    mounts: [{ type: 'bind', source: '/repo', target: '/opt/maka-agent', read_only: true }],
    agentEnv: { MAKA_MODEL: 'k3', MAKA_PROVIDER: 'kimi-coding-plan' },
  });
  const joined = args.join(' ');
  assert.match(joined, /--agent-import-path maka_agent:MakaAgent/);
  assert.match(joined, /-m k3/);
  assert.match(joined, /-p \/tasks\/dasel/);
  assert.match(joined, /-o \/jobs/);
  assert.match(joined, /--job-name trial/);
  assert.match(joined, /-k 1/);
  assert.match(joined, /-n 1/);
  assert.match(joined, /--agent-timeout-multiplier 1\.0055555555555555/);
  assert.match(joined, /--yes/);
  assert.ok(args.includes('--mounts-json'));
  assert.ok(args.includes('--ae'));
  assert.ok(args.includes('MAKA_MODEL=k3'));
  // No provider secret and no env-file were requested.
  assert.ok(!args.includes('--env-file'));
});

test('createPierTaskRunner gives Maka a controller-owned settlement tail', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const captured: FakeOptions['captured'] = {};
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        agent: 'maka',
        makaNodeToolchainPath: '/toolchains/maka-node',
        agentEnv: {
          MAKA_HARBOR_MODE: 'task-run',
          MAKA_CELL_TIMEOUT_SEC: '1',
          MAKA_AGENT_PHASE_TIMEOUT_SEC: '1',
        },
        runPier: fakePier({ reward: 0, captured }),
      }),
    );

    await runner(
      runInput({
        task: {
          id: 'dasel',
          path: '/tasks/dasel-html-document-format',
          metadata: {
            agentTimeoutSec: 5_400,
            buildTimeoutSec: 1_800,
            verifierTimeoutSec: 1_800,
          },
        },
      }),
    );

    const request = captured.request;
    assert.ok(request);
    const agentTimeoutFlag = request.args.indexOf('--agent-timeout-multiplier');
    assert.equal(request.args[agentTimeoutFlag + 1], '1.0055555555555555');
    // Container task-run reads the cell budget as the model budget itself and
    // takes its settlement window out of the agent phase, so the model already
    // gets the full 5400s here without adding the grace to the budget.
    assert.ok(request.args.includes('MAKA_CELL_TIMEOUT_SEC=5400'));
    assert.ok(request.args.includes('MAKA_CELL_SETTLEMENT_GRACE_SEC=30'));
    assert.ok(request.args.includes('MAKA_AGENT_PHASE_TIMEOUT_SEC=5430'));

    assert.equal(request.timeoutMs, 13_890_000);
  });
});

test('createPierTaskRunner honours an operator-widened settlement window', async () => {
  // Same contract as the Harbor runner. Pier used to overwrite the operator's
  // value with the constant, so widening the window worked on one executor and
  // silently did nothing on the other.
  await withDirs(async ({ jobsDir, repo }) => {
    const captured: FakeOptions['captured'] = {};
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        agent: 'maka',
        makaNodeToolchainPath: '/toolchains/maka-node',
        agentEnv: {
          MAKA_HARBOR_MODE: 'task-run',
          MAKA_CELL_SETTLEMENT_GRACE_SEC: '90',
        },
        runPier: fakePier({ reward: 0, captured }),
      }),
    );

    await runner(
      runInput({
        task: {
          id: 'dasel',
          path: '/tasks/dasel-html-document-format',
          metadata: { agentTimeoutSec: 5_400, buildTimeoutSec: 1_800, verifierTimeoutSec: 1_800 },
        },
      }),
    );

    const request = captured.request;
    assert.ok(request);
    assert.ok(request.args.includes('MAKA_CELL_TIMEOUT_SEC=5400'));
    assert.ok(request.args.includes('MAKA_CELL_SETTLEMENT_GRACE_SEC=90'));
    assert.ok(request.args.includes('MAKA_AGENT_PHASE_TIMEOUT_SEC=5490'));
  });
});

test('createPierTaskRunner gives a native CLI arm no settlement tail', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const captured: FakeOptions['captured'] = {};
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        agent: 'codex',
        agentVersion: CODEX_TOOLCHAIN_SPEC.codex.version,
        codexToolchainPath: repo,
        backend: 'ai-sdk',
        provider: 'openai-codex',
        model: 'gpt-5.6-sol',
        resolveProviderCredential: () => Promise.resolve({ value: 'upstream-key' }),
        providerProxyPort: 0,
        agentEnv: { MAKA_HARBOR_MODE: 'task-run' },
        runPier: fakePier({ reward: 0, captured }),
      }),
    );

    await runner(
      runInput({
        task: {
          id: 'dasel',
          path: '/tasks/dasel-html-document-format',
          metadata: {
            agentTimeoutSec: 5_400,
            buildTimeoutSec: 1_800,
            verifierTimeoutSec: 1_800,
          },
        },
      }),
    );

    const request = captured.request;
    assert.ok(request);
    // Codex has nothing to settle: it runs until Pier cancels it at the
    // task-native deadline, so it gets neither the phase stretch nor the
    // wall-clock window Maka needs on top of it.
    assert.ok(!request.args.includes('--agent-timeout-multiplier'));
    assert.ok(!request.args.some((arg) => arg.startsWith('MAKA_CELL_SETTLEMENT_GRACE_SEC=')));
    assert.ok(!request.args.some((arg) => arg.startsWith('MAKA_AGENT_PHASE_TIMEOUT_SEC=')));
    assert.equal(request.timeoutMs, 13_890_000 - MAKA_SETTLEMENT_GRACE_SEC * 1_000);
  });
});

test('createPierTaskRunner preserves caller timeouts for Maka cell mode', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const captured: FakeOptions['captured'] = {};
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        agent: 'maka',
        agentEnv: {
          MAKA_CELL_TIMEOUT_SEC: '600',
          MAKA_CELL_SETTLEMENT_GRACE_SEC: '30',
        },
        runPier: fakePier({ reward: 0, captured }),
      }),
    );

    await runner(
      runInput({
        task: {
          id: 'dasel',
          path: '/tasks/dasel-html-document-format',
          metadata: {
            agentTimeoutSec: 5_400,
            buildTimeoutSec: 1_800,
            verifierTimeoutSec: 1_800,
          },
        },
      }),
    );

    const args = captured.request?.args ?? [];
    assert.ok(!args.includes('--agent-timeout-multiplier'));
    assert.ok(args.includes('MAKA_CELL_TIMEOUT_SEC=600'));
    assert.ok(args.includes('MAKA_CELL_SETTLEMENT_GRACE_SEC=30'));
    assert.ok(!args.some((arg) => arg.startsWith('MAKA_AGENT_PHASE_TIMEOUT_SEC=')));
  });
});

test('createPierTaskRunner mounts the pinned Maka Node runtime for container task-run mode', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const captured: FakeOptions['captured'] = {};
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        agent: 'maka',
        agentEnv: { MAKA_HARBOR_MODE: 'task-run' },
        makaNodeToolchainPath: '/toolchains/maka-node',
        runPier: fakePier({ reward: 0, captured }),
      }),
    );

    await runner(runInput());

    const args = captured.request?.args ?? [];
    const mountsFlag = args.indexOf('--mounts-json');
    const mounts = JSON.parse(args[mountsFlag + 1]!) as Array<{
      source: string;
      target: string;
      read_only: boolean;
    }>;
    assert.ok(
      mounts.some(
        (mount) =>
          mount.source === '/toolchains/maka-node' &&
          mount.target === '/opt/maka-node-toolchain' &&
          mount.read_only,
      ),
    );
    assert.ok(args.includes(`MAKA_NODE_TOOLCHAIN_FINGERPRINT=${MAKA_NODE_TOOLCHAIN_FINGERPRINT}`));
  });
});

test('createPierTaskRunner withholds the repo tree from a competitor arm', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const repoMountsFor = async (agent: 'maka' | 'codex') => {
      const captured: FakeOptions['captured'] = {};
      const runner = createPierTaskRunner(
        baseOptions({
          jobsDir,
          makaRepoPath: repo,
          agent,
          agentVersion: CODEX_TOOLCHAIN_SPEC.codex.version,
          codexToolchainPath: '/toolchains/codex',
          ...(agent === 'codex'
            ? {
                backend: 'ai-sdk' as const,
                provider: 'openai-codex' as const,
                model: 'gpt-5.6-sol',
                resolveProviderCredential: () => Promise.resolve({ value: 'upstream-key' }),
                providerProxyPort: 0,
              }
            : {}),
          runPier: fakePier({ reward: 0, captured }),
        }),
      );
      await runner(runInput());
      const args = captured.request?.args ?? [];
      const mounts = JSON.parse(args[args.indexOf('--mounts-json') + 1]!) as Array<{
        target: string;
      }>;
      return mounts.filter((mount) => mount.target.startsWith('/opt/maka-agent'));
    };

    assert.ok((await repoMountsFor('maka')).some((mount) => mount.target === '/opt/maka-agent'));

    // Pier shares agent-repo-mount with the Harbor runner precisely so this
    // cannot regress in one executor while the other stays fixed.
    const competitor = await repoMountsFor('codex');
    assert.ok(competitor.every((mount) => mount.target !== '/opt/maka-agent'));
    assert.deepEqual(
      competitor.map((mount) => mount.target),
      competitorRepoFiles('codex').map((file) => `/opt/maka-agent/${file}`),
    );
  });
});

test('createPierTaskRunner rejects an unpinned Maka container task run', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        agent: 'maka',
        agentEnv: { MAKA_HARBOR_MODE: 'task-run' },
        runPier: fakePier({ reward: 0 }),
      }),
    );

    await assert.rejects(
      () => runner(runInput()),
      /makaNodeToolchainPath is required for Maka container task-run mode/,
    );
  });
});

test('buildPierRunArgs targets the Kimi Code adapter and forwards an env-file', () => {
  const args = buildPierRunArgs({
    agent: 'kimi-code',
    model: 'k3',
    taskPath: '/tasks/dasel',
    jobsDir: '/jobs',
    jobName: 'trial',
    environment: 'docker',
    timeoutMultiplier: 1,
    mounts: [],
    agentEnv: {},
    envFile: '/jobs/pier-agent.env',
  });
  assert.match(args.join(' '), /--agent-import-path kimi_code_agent:MakaKimiCodeAgent/);
  const envFileFlag = args.indexOf('--env-file');
  assert.equal(args[envFileFlag + 1], '/jobs/pier-agent.env');
});

test('createPierTaskRunner maps a completed fake trial to reward and host cell paths', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const captured: FakeOptions['captured'] = {};
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        runPier: fakePier({ reward: 0, captured }),
      }),
    );
    const output = await runner(runInput());
    assert.equal(output.harbor.reward, 0);
    // Pier's grading is surfaced as the structured verifier outcome the
    // controller requires for failed-cell scoring.
    assert.deepEqual(output.harbor.verifier, {
      outcome: 'failed',
      attempts: [{ attempt: 1, classification: 'failed', durationMs: 0, reward: 0 }],
    });
    assert.equal(output.cell.status, 'completed');
    // The container-local runtime path is overridden with the host trial path.
    assert.match(output.cell.runtimeEventsPath, /agent\/runtime-events\.jsonl$/);
    assert.ok(output.cell.runtimeEventsPath.startsWith(jobsDir));
    // MAKA_BACKEND rides the process env (CliFlag env_fallback reads os.environ),
    // never `--ae`.
    assert.equal(captured.request?.env?.MAKA_BACKEND, 'fake');
    assert.ok(!captured.request?.args.some((arg) => arg.startsWith('MAKA_BACKEND=')));
    // The system prompt rides the process env byte-exact (trailing newline
    // preserved) and must NOT appear in --ae, whose values pier strips — a
    // stripped extra_env copy would shadow os.environ and break the
    // execution-identity hash round-trip.
    assert.equal(captured.request?.env?.MAKA_SYSTEM_PROMPT, 'CANDIDATE PROMPT\n');
    assert.ok(!captured.request?.args.some((arg) => arg.startsWith('MAKA_SYSTEM_PROMPT=')));
  });
});

test('createPierTaskRunner projects the Agent tool policy from the run config', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const captured: FakeOptions['captured'] = {};
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        runPier: fakePier({ reward: 0, captured }),
      }),
    );

    await runner(
      runInput({
        config: {
          id: 'cfg',
          backend: 'ai-sdk',
          llmConnectionSlug: 'fake',
          model: 'fake',
          agentTools: true,
        },
      }),
    );

    assert.ok(captured.request?.args.includes('MAKA_AGENT_TOOLS=true'));
  });
});

test('createPierTaskRunner passes the provider-local bare model id to pier -m', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const captured: FakeOptions['captured'] = {};
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        model: 'deepseek/deepseek-v4-flash',
        provider: 'deepseek',
        runPier: fakePier({ reward: 0, captured }),
      }),
    );
    await runner(runInput());
    // The adapter's model_name outranks MAKA_MODEL, so a prefixed -m would leak
    // the provider-prefixed id into the cell. Same contract as modelIdForProvider
    // in the Harbor runner.
    const modelFlag = captured.request?.args.indexOf('-m') ?? -1;
    assert.equal(captured.request?.args[modelFlag + 1], 'deepseek-v4-flash');
    assert.ok(captured.request?.args.includes('MAKA_MODEL=deepseek-v4-flash'));
  });
});

test('createPierTaskRunner derives the wall-clock watchdog from the task-native budget', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const captured: FakeOptions['captured'] = {};
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        makaNodeToolchainPath: '/toolchains/maka-node',
        agentEnv: { MAKA_HARBOR_MODE: 'task-run' },
        runPier: fakePier({ reward: 0, captured }),
      }),
    );
    // DeepSWE-shaped budget (113/113 tasks): build 1800s + agent 5400s +
    // verifier 1800s, plus pier's fixed agent_setup phase (360s,
    // pier/trial/trial.py:176, multiplier-scaled per
    // pier/trial/execution.py:129-143), and pier retries build and
    // verification once each on their timeout errors (tenacity
    // stop_after_attempt(2) in pier/trial/execution.py:208 and
    // pier/trial/trial.py:333). The watchdog must cover the complete
    // legitimate lifecycle 2xbuild + setup + agent + 2xverifier = 12960s, or
    // cold builds, slow setups, and verifier retries get killed as infra.
    // Maka alone also reserves its 30s settlement tail. Contract: the derived
    // value covers that ceiling plus both settlement and outer process grace.
    const deepSweMetadata = {
      agentTimeoutSec: 5400,
      verifierTimeoutSec: 1800,
      buildTimeoutSec: 1800,
    };
    await runner(
      runInput({
        task: { id: 'dasel', path: '/tasks/dasel-html-document-format', metadata: deepSweMetadata },
      }),
    );
    assert.equal(
      captured.request?.timeoutMs,
      (2 * 1800 + 360 + 5400 + 30 + 2 * 1800) * 1_000 + 15 * 60_000,
    );
    assert.ok((captured.request?.timeoutMs ?? 0) >= 12_960_000);

    // Without task metadata the 45-minute floor holds.
    await runner(runInput());
    assert.equal(captured.request?.timeoutMs, 45 * 60_000);

    // An explicit pierTimeoutMs still wins.
    const explicit = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        pierTimeoutMs: 1_234,
        runPier: fakePier({ reward: 0, captured }),
      }),
    );
    await explicit(
      runInput({
        task: { id: 'dasel', path: '/tasks/dasel-html-document-format', metadata: deepSweMetadata },
      }),
    );
    assert.equal(captured.request?.timeoutMs, 1_234);
  });
});

test('createPierTaskRunner falls back to the trial verifier_result reward', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        runPier: fakePier({ reward: 1, rewardJson: false, verifierResultReward: 1 }),
      }),
    );
    const output = await runner(runInput());
    assert.equal(output.harbor.reward, 1);
  });
});

test('createPierTaskRunner surfaces the combined trace path in task-run mode', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        makaNodeToolchainPath: repo,
        agentEnv: { MAKA_HARBOR_MODE: 'task-run' },
        runPier: fakePier({ reward: 0, combinedTrace: true }),
      }),
    );
    const output = await runner(runInput());
    assert.match(output.cell.traceEventsPath ?? '', /agent\/trace-events\.jsonl$/);
  });
});

test('createPierTaskRunner resolves the cell-mode session trace via runtimeRefs', async () => {
  // Shared hostTraceEventsPath: in cell mode the rich trace lives at
  // agent/maka-storage/sessions/<sid>/runs/<rid>/events.jsonl. Skipping this
  // branch silently drops tool_failed / provider_request_captured attribution
  // from downstream failure analysis.
  await withDirs(async ({ jobsDir, repo }) => {
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        runPier: fakePier({ reward: 0, sessionTrace: true }),
      }),
    );
    const output = await runner(runInput());
    assert.match(
      output.cell.traceEventsPath ?? '',
      /agent\/maka-storage\/sessions\/sess\/runs\/run\/events\.jsonl$/,
    );
  });
});

test('createPierTaskRunner falls back to runtime events when no richer trace exists', async () => {
  // Harbor-parity (hostTraceEventsPath): traceEventsPath is always set, so
  // downstream trace analysis never silently skips the sample.
  await withDirs(async ({ jobsDir, repo }) => {
    const runner = createPierTaskRunner(
      baseOptions({ jobsDir, makaRepoPath: repo, runPier: fakePier({ reward: 0 }) }),
    );
    const output = await runner(runInput());
    assert.equal(output.cell.traceEventsPath, output.cell.runtimeEventsPath);
    assert.match(output.cell.traceEventsPath ?? '', /agent\/runtime-events\.jsonl$/);
  });
});

test('createPierTaskRunner classifies a pier launch failure as infra', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        runPier: () => Promise.reject(new Error('pier: command not found')),
      }),
    );
    await assert.rejects(runner(runInput()), (error: Error) => {
      assert.ok(error instanceof PierInfraError);
      assert.equal(error.kind, 'infra_failed');
      return true;
    });
  });
});

test('createPierTaskRunner classifies a timed-out pier run', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const runner = createPierTaskRunner(
      baseOptions({ jobsDir, makaRepoPath: repo, runPier: fakePier({ timedOut: true }) }),
    );
    await assert.rejects(runner(runInput()), (error: Error) => {
      assert.ok(error instanceof PierInfraError);
      assert.equal(error.kind, 'timed_out');
      return true;
    });
  });
});

test('createPierTaskRunner reports a budget exhaustion as a benchmark outcome', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        runPier: fakePier({
          cell: null,
          exceptionInfo: {
            exception_type: 'AgentTimeoutError',
            exception_message: 'Agent execution timed out after 600 seconds',
          },
        }),
      }),
    );
    await assert.rejects(
      runner(runInput()),
      (error: Error) => error instanceof FixedPromptBudgetExhaustedError,
    );
  });
});

test('pier-graded failed cells stay scored through the fixed-prompt controller', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-pier-controller-'));
    try {
      const systemPrompt = 'CANDIDATE PROMPT\n';
      const systemPromptPath = join(dir, 'prompt.txt');
      await writeFile(systemPromptPath, systemPrompt, 'utf8');
      const promptHash = hashSystemPrompt(systemPrompt);
      const cell = cellOutput({
        status: 'failed',
        errorClass: 'max_tokens',
        promptHash,
        executionIdentity: {
          llmConnectionSlug: 'fake',
          model: 'fake',
          systemPromptMode: 'default',
          systemPromptHash: promptHash,
          pricingProfile: 'fake-structural',
          agentTools: false,
        },
      });
      const runner = createPierTaskRunner(
        baseOptions({ jobsDir, makaRepoPath: repo, runPier: fakePier({ reward: 0, cell }) }),
      );
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config: { id: 'cfg', backend: 'fake', llmConnectionSlug: 'fake', model: 'fake' },
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        tasks: [{ id: 'dasel', path: '/tasks/dasel-html-document-format' }],
        taskRunner: runner,
      });
      // Without the structured verifier outcome this event is scored=false and
      // silently leaves the benchmark denominator.
      const event = result.events[0]!;
      assert.equal(event.type, 'task_completed');
      assert.equal(event.passed, false);
      assert.equal(event.scored, true);
      assert.equal(event.eligible, true);
      assert.equal(event.errorClass, 'max_tokens');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test('pier and harbor normalize an infra-labeled graded cell to the same runtime outcome', async () => {
  // Cross-runner parity lock: once either harness produces a valid structured
  // pass/fail grade, the verifier is authoritative even if the agent cell
  // exited with an infrastructure label. Once the candidate had an execution
  // opportunity, that label describes its runtime outcome, not harness infra.
  await withDirs(async ({ jobsDir, repo }) => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-pier-parity-'));
    try {
      const systemPrompt = 'CANDIDATE PROMPT\n';
      const systemPromptPath = join(dir, 'prompt.txt');
      await writeFile(systemPromptPath, systemPrompt, 'utf8');
      const promptHash = hashSystemPrompt(systemPrompt);
      for (const reward of [0, 1]) {
        const normalizedEvents: Array<Record<string, unknown>> = [];
        const cell = cellOutput({
          status: 'failed',
          errorClass: 'infra_failed',
          promptHash,
          executionIdentity: {
            llmConnectionSlug: 'fake',
            model: 'fake',
            systemPromptMode: 'default',
            systemPromptHash: promptHash,
            pricingProfile: 'fake-structural',
            agentTools: false,
          },
        });
        const pierRunner = createPierTaskRunner(
          baseOptions({ jobsDir, makaRepoPath: repo, runPier: fakePier({ reward, cell }) }),
        );
        const pierOutput = await pierRunner(
          runInput({
            config: { id: 'cfg', backend: 'fake', llmConnectionSlug: 'fake', model: 'fake' },
          }),
        );
        // The canonical Harbor-shaped output for the same trial: same graded
        // reward, same structured verifier outcome, same cell artifacts.
        const harborOutput: TaskRunOutput = {
          harbor: {
            reward,
            verifier: {
              outcome: reward > 0 ? 'passed' : 'failed',
              attempts: [
                {
                  attempt: 1,
                  classification: reward > 0 ? 'passed' : 'failed',
                  durationMs: 0,
                  reward,
                },
              ],
            },
          },
          cell: pierOutput.cell,
        };
        for (const [flavor, output] of [
          ['pier', pierOutput],
          ['harbor', harborOutput],
        ] as const) {
          const result = await runFixedPromptController({
            runId: 'run-1',
            roundId: 'round-1',
            config: { id: 'cfg', backend: 'fake', llmConnectionSlug: 'fake', model: 'fake' },
            systemPromptPath,
            resultsJsonlPath: join(dir, `results-${flavor}-${reward}.jsonl`),
            tasks: [{ id: 'dasel', path: '/tasks/dasel-html-document-format' }],
            taskRunner: () => Promise.resolve(output),
          });
          const event = { ...(result.events[0] as unknown as Record<string, unknown>) };
          for (const volatile of ['id', 'ts', 'startedAt', 'finishedAt', 'durationMs']) {
            delete event[volatile];
          }
          normalizedEvents.push(event);
        }
        assert.deepEqual(normalizedEvents[0], normalizedEvents[1]);
        assert.equal(normalizedEvents[0]?.type, 'task_completed');
        assert.equal(normalizedEvents[0]?.passed, reward > 0);
        assert.equal(normalizedEvents[0]?.scored, true);
        assert.equal(normalizedEvents[0]?.eligible, true);
        assert.equal(normalizedEvents[0]?.errorClass, reward > 0 ? undefined : 'runtime_error');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test('createPierTaskRunner scores a graded trial despite an AgentTimeoutError', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    // Pier records the agent exception and then unconditionally runs the
    // verifier, so a timed-out agent can still earn its actual reward — for
    // both outcomes, and even when pier itself exits non-zero.
    for (const reward of [1, 0]) {
      const runner = createPierTaskRunner(
        baseOptions({
          jobsDir,
          makaRepoPath: repo,
          runPier: fakePier({
            reward,
            exitCode: 3,
            exceptionInfo: {
              exception_type: 'AgentTimeoutError',
              exception_message: 'Agent execution timed out after 600 seconds',
            },
          }),
        }),
      );
      const output = await runner(runInput());
      assert.equal(output.harbor.reward, reward);
      assert.equal(output.harbor.verifier?.outcome, reward > 0 ? 'passed' : 'failed');
      assert.equal(output.cell.status, 'completed');
    }
  });
});

test('createPierTaskRunner recovers execution identity from a budget-exhausted trial', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const identity = {
      llmConnectionSlug: 'fake',
      model: 'fake',
      systemPromptMode: 'default',
      systemPromptHash: 'sha256:abc',
      pricingProfile: 'fake-structural',
      agentTools: false,
    };
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        runPier: fakePier({
          cell: null,
          executionIdentity: identity,
          exceptionInfo: {
            exception_type: 'AgentTimeoutError',
            exception_message: 'Agent execution timed out after 600 seconds',
          },
        }),
      }),
    );
    // The recovered identity keeps the sample Pass@1-eligible; a null
    // artifactRefs would demote it to missing_execution_identity and silently
    // shrink the benchmark denominator. Recovery is the shared Harbor
    // implementation (readTimedOutTrialArtifacts), so both runners honor the
    // same cross-runner contract by construction.
    await assert.rejects(runner(runInput()), (error: Error) => {
      assert.ok(error instanceof FixedPromptBudgetExhaustedError);
      assert.deepEqual(error.artifactRefs?.executionIdentity, identity);
      return true;
    });
  });
});

test('createPierTaskRunner carries the verifier grade of a budget-exhausted trial without cell output', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        runPier: fakePier({
          cell: null,
          reward: 1,
          exceptionInfo: {
            exception_type: 'AgentTimeoutError',
            exception_message: 'Agent execution timed out after 600 seconds',
          },
        }),
      }),
    );
    await assert.rejects(runner(runInput()), (error: Error) => {
      assert.ok(error instanceof FixedPromptBudgetExhaustedError);
      assert.equal(error.artifactRefs?.harbor?.reward, 1);
      assert.equal(error.artifactRefs?.harbor?.verifier?.outcome, 'passed');
      return true;
    });
  });
});

// The grade travels only from a graded state. `invalid` (corrupt or crashed
// verifier) and `ungraded` (no reward at all) are not verdicts, so a budget
// exhaustion carries no score — the same negative side the Harbor table pins.
for (const trial of [
  { name: 'a crash-sentinel reward', opts: { reward: -1 } },
  { name: 'a corrupt reward.json', opts: { rewardJsonRaw: 'not-json{' } },
  { name: 'no reward at all', opts: {} },
] as const) {
  test(`createPierTaskRunner carries no verdict from a budget-exhausted trial with ${trial.name}`, async () => {
    await withDirs(async ({ jobsDir, repo }) => {
      const runner = createPierTaskRunner(
        baseOptions({
          jobsDir,
          makaRepoPath: repo,
          runPier: fakePier({
            ...trial.opts,
            cell: null,
            exceptionInfo: {
              exception_type: 'AgentTimeoutError',
              exception_message: 'Agent execution timed out after 600 seconds',
            },
          }),
        }),
      );
      await assert.rejects(runner(runInput()), (error: Error) => {
        assert.ok(error instanceof FixedPromptBudgetExhaustedError);
        assert.equal(error.artifactRefs?.harbor, undefined);
        return true;
      });
    });
  });
}

test('createPierTaskRunner withholds a budget-exhausted grade when the provider cut the tail short', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const makeRunner = (outcome: ProviderRequestTelemetry['outcome']) =>
      createPierTaskRunner(
        baseOptions({
          jobsDir,
          makaRepoPath: repo,
          agent: 'opencode',
          agentVersion: OPENCODE_TOOLCHAIN_SPEC.opencode.version,
          backend: 'ai-sdk',
          provider: 'deepseek',
          model: 'deepseek-v4-flash',
          reasoningEffort: 'max',
          opencodeToolchainPath: repo,
          apiKeyFile: '/secrets/deepseek.key',
          providerProxyHub: {
            baseUrl: 'http://host.docker.internal:443',
            issue: () => ({
              baseUrl: 'http://host.docker.internal:443',
              token: 'ephemeral-token',
              usage: () => null,
              telemetry: () => [
                {
                  requestId: 1,
                  method: 'POST',
                  path: '/chat/completions',
                  status: 200,
                  outcome,
                  durationMs: 5,
                  bodyChunks: 1,
                  responseBytes: 64,
                  terminalEvent: outcome === 'completed',
                },
              ],
              close: async () => {},
            }),
            close: async () => {},
          },
          runPier: fakePier({
            reward: 1,
            cell: null,
            exceptionInfo: {
              exception_type: 'AgentTimeoutError',
              exception_message: 'Agent execution timed out after 600 seconds',
            },
          }),
        }),
      );

    // The agent tearing its own request down on the way out is what a deadline
    // looks like from the proxy, so the verdict still travels.
    await assert.rejects(makeRunner('aborted')(runInput()), (error: Error) => {
      assert.ok(error instanceof FixedPromptBudgetExhaustedError);
      assert.equal(error.artifactRefs?.harbor?.reward, 1);
      return true;
    });
    // An upstream truncation is a provider outage: the agent never got the run
    // it was given, so its verdict is not this arm's evidence.
    await assert.rejects(makeRunner('interrupted')(runInput()), (error: Error) => {
      assert.ok(error instanceof FixedPromptBudgetExhaustedError);
      assert.equal(error.artifactRefs?.harbor, undefined);
      return true;
    });
  });
});

test('createPierTaskRunner scores a graded trial despite a non-budget exception', async () => {
  // Harbor-authority parity: exception_info records how the agent phase ended,
  // not whether the trial was graded. A Kimi CLI non-zero exit the verifier
  // still passed must count as passed, not be discarded as infra.
  await withDirs(async ({ jobsDir, repo }) => {
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        runPier: fakePier({
          reward: 1,
          exceptionInfo: {
            exception_type: 'NonZeroAgentExitCodeError',
            exception_message: 'agent exited 1',
          },
        }),
      }),
    );
    const output = await runner(runInput());
    assert.equal(output.harbor.reward, 1);
    assert.equal(output.harbor.verifier?.outcome, 'passed');
  });
});

test('createPierTaskRunner scores a graded trial despite a non-zero pier exit', async () => {
  // The grade is the evidence, the exit code is not: pier can exit non-zero on
  // an exceptional trial the verifier nonetheless graded. Discarding it as infra
  // drops a real sample out of the Pass@1 denominator.
  await withDirs(async ({ jobsDir, repo }) => {
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        runPier: fakePier({
          reward: 1,
          exitCode: 1,
          // status 'failed' keeps the verifier grade load-bearing: with the
          // default 'completed' the controller would score the trial on status
          // alone and the settle rule under test would not be exercised.
          cell: cellOutput({ status: 'failed', errorClass: 'aborted' }),
          exceptionInfo: {
            exception_type: 'NonZeroAgentExitCodeError',
            exception_message: 'agent exited 1',
          },
        }),
      }),
    );
    const output = await runner(runInput());
    assert.equal(output.harbor.reward, 1);
    assert.equal(output.harbor.verifier?.outcome, 'passed');
    assert.equal(output.cell.deadlineSettlement, undefined);
  });
});

test('createPierTaskRunner scores a graded-failed agent exit, not just a graded-passed one', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        runPier: fakePier({
          reward: 0,
          exitCode: 1,
          cell: cellOutput({ status: 'failed', errorClass: 'aborted' }),
          exceptionInfo: {
            exception_type: 'NonZeroAgentExitCodeError',
            exception_message: 'agent exited 1',
          },
        }),
      }),
    );
    const output = await runner(runInput());
    assert.equal(output.harbor.reward, 0);
    assert.equal(output.harbor.verifier?.outcome, 'failed');
  });
});

test('createPierTaskRunner keeps an externally ended run infra despite a full grade', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        runPier: fakePier({
          // Graded and complete, but pier's container — not the agent — ended
          // the run, so the artifacts are not evidence of a fair sample.
          reward: 1,
          exitCode: 1,
          cell: cellOutput({ status: 'failed', errorClass: 'aborted' }),
          exceptionInfo: { exception_type: 'DockerExecError', exception_message: 'exec failed' },
        }),
      }),
    );
    await assert.rejects(runner(runInput()), (error: Error) => {
      assert.ok(error instanceof PierInfraError);
      assert.match(error.message, /pier run exited 1/);
      // The WAL keeps only the message, so the cause has to travel inside it.
      assert.match(error.message, /trial exception: DockerExecError: exec failed/);
      return true;
    });
  });
});

test('createPierTaskRunner treats an ungraded non-budget trial exception as infra', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        runPier: fakePier({
          cell: null,
          exceptionInfo: { exception_type: 'RuntimeError', exception_message: 'boom' },
        }),
      }),
    );
    await assert.rejects(runner(runInput()), (error: Error) => {
      assert.ok(error instanceof PierInfraError);
      // The trial exception is the root cause and must ride the diagnostics.
      assert.match(error.message, /failed before verifier reward/);
      assert.match(error.message, /RuntimeError: boom/);
      return true;
    });
  });
});

test('createPierTaskRunner classifies the reward.json crash sentinel as infra', async () => {
  // DeepSWE test.sh traps a verifier crash by writing reward -1 when no reward
  // file exists; grader.py documents real rewards as binary 0/1. A sentinel
  // must never be recorded as a scored failed sample.
  await withDirs(async ({ jobsDir, repo }) => {
    const runner = createPierTaskRunner(
      baseOptions({ jobsDir, makaRepoPath: repo, runPier: fakePier({ reward: -1 }) }),
    );
    await assert.rejects(runner(runInput()), (error: Error) => {
      assert.ok(error instanceof PierInfraError);
      assert.match(error.message, /crash sentinel/);
      return true;
    });
  });
});

test('createPierTaskRunner rejects non-binary rewards as infra', async () => {
  // grader.py: the main reward is binary 0/1 (113/113 DeepSWE tasks); 0.5 or 2
  // can only come from corrupt or non-contract verifier output, and 0.5 would
  // otherwise score as a PASS through `reward > 0`.
  for (const reward of [0.5, 2]) {
    await withDirs(async ({ jobsDir, repo }) => {
      const runner = createPierTaskRunner(
        baseOptions({ jobsDir, makaRepoPath: repo, runPier: fakePier({ reward }) }),
      );
      await assert.rejects(runner(runInput()), (error: Error) => {
        assert.ok(error instanceof PierInfraError);
        assert.match(error.message, /binary 0\/1 contract/);
        return true;
      });
    });
  }
});

test('createPierTaskRunner classifies the verifier_result crash sentinel as infra', async () => {
  // The sentinel arrives via reward.txt -> pier's verifier parse ->
  // verifier_result.rewards.reward; there is no reward.json in that path.
  await withDirs(async ({ jobsDir, repo }) => {
    const runner = createPierTaskRunner(
      baseOptions({ jobsDir, makaRepoPath: repo, runPier: fakePier({ verifierResultReward: -1 }) }),
    );
    await assert.rejects(runner(runInput()), (error: Error) => {
      assert.ok(error instanceof PierInfraError);
      assert.match(error.message, /crash sentinel/);
      return true;
    });
  });
});

test('createPierTaskRunner scores a graded trial when both reward mirrors agree', async () => {
  // The reward.json authority and its trial-result mirror
  // (verifier_result.rewards.reward) carry the same value on a completed trial;
  // an agreeing pair must score normally, not trip the mirror-consistency guard.
  for (const reward of [0, 1]) {
    await withDirs(async ({ jobsDir, repo }) => {
      const runner = createPierTaskRunner(
        baseOptions({
          jobsDir,
          makaRepoPath: repo,
          runPier: fakePier({ reward, verifierResultReward: reward }),
        }),
      );
      const output = await runner(runInput());
      assert.equal(output.harbor.reward, reward);
    });
  }
});

test('createPierTaskRunner treats disagreeing reward mirrors as infra', async () => {
  // The two persisted mirrors of the grading authority must be identical; a
  // reward.json that disagrees with verifier_result.rewards.reward — in either
  // direction — is infra, never a silently-preferred score.
  for (const [rewardJsonValue, resultValue] of [
    [1, 0],
    [0, 1],
  ] as const) {
    await withDirs(async ({ jobsDir, repo }) => {
      const runner = createPierTaskRunner(
        baseOptions({
          jobsDir,
          makaRepoPath: repo,
          runPier: fakePier({ reward: rewardJsonValue, verifierResultReward: resultValue }),
        }),
      );
      await assert.rejects(runner(runInput()), (error: Error) => {
        assert.ok(error instanceof PierInfraError);
        assert.match(error.message, /mirrors disagree/);
        return true;
      });
    });
  }
});

test('createPierTaskRunner treats a reward.json without a reward field as infra', async () => {
  // A reward.json that exists as valid JSON but carries no numeric reward field
  // is corrupt grading authority — infra, not a fall-through to the result
  // mirror or an ungraded miss.
  await withDirs(async ({ jobsDir, repo }) => {
    const runner = createPierTaskRunner(
      baseOptions({ jobsDir, makaRepoPath: repo, runPier: fakePier({ rewardJsonRaw: '{}' }) }),
    );
    await assert.rejects(runner(runInput()), (error: Error) => {
      assert.ok(error instanceof PierInfraError);
      assert.match(error.message, /no valid numeric reward field/);
      return true;
    });
  });
});

test('createPierTaskRunner reports a budget exhaustion despite a crash-sentinel reward', async () => {
  // Budget-gate context: the agent already exhausted its budget, so a verifier
  // that crashed (result-mirror sentinel -1) does NOT overturn that fact. The
  // trial is budget_exhausted (no retry), not infra — a graded read would call
  // the sentinel infra, but here the spent agent budget takes precedence.
  await withDirs(async ({ jobsDir, repo }) => {
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        runPier: fakePier({
          verifierResultReward: -1,
          exceptionInfo: {
            exception_type: 'AgentTimeoutError',
            exception_message: 'Agent execution timed out after 600 seconds',
          },
        }),
      }),
    );
    await assert.rejects(
      runner(runInput()),
      (error: Error) => error instanceof FixedPromptBudgetExhaustedError,
    );
  });
});

test('createPierTaskRunner reports a budget exhaustion despite a corrupt reward.json', async () => {
  // Same budget-gate precedence for a reward.json that is not valid JSON: a
  // corrupt verifier artifact after the agent already spent its budget stays a
  // budget_exhausted outcome, not an infra failure the controller would retry.
  await withDirs(async ({ jobsDir, repo }) => {
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        runPier: fakePier({
          rewardJsonRaw: 'not-json{',
          exceptionInfo: {
            exception_type: 'AgentTimeoutError',
            exception_message: 'Agent execution timed out after 600 seconds',
          },
        }),
      }),
    );
    await assert.rejects(
      runner(runInput()),
      (error: Error) => error instanceof FixedPromptBudgetExhaustedError,
    );
  });
});

test('createPierTaskRunner rejects provider secrets in agentEnv', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        agentEnv: { KIMI_MODEL_API_KEY: 'sk-real' },
        runPier: fakePier({ reward: 0 }),
      }),
    );
    await assert.rejects(runner(runInput()), /must not contain provider secrets/);
  });
});

test('createPierTaskRunner rejects experiment identity and pricing overrides in agentEnv', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const overrides: Array<Record<string, string>> = [
      { MAKA_MODEL: 'other-model' },
      { MAKA_AGENT_TOOLS: 'true' },
      { MAKA_TRIAL_INPUT_USD_PER_1M: '9' },
    ];
    for (const env of overrides) {
      const runner = createPierTaskRunner(
        baseOptions({
          jobsDir,
          makaRepoPath: repo,
          agentEnv: env,
          runPier: fakePier({ reward: 0 }),
        }),
      );
      await assert.rejects(runner(runInput()), /must not override experiment identity/);
    }
  });
});

test('createPierTaskRunner requires the Kimi toolchain mount for the Kimi arm', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        agent: 'kimi-code',
        provider: 'kimi-coding-plan',
        resolveProviderCredential: () => Promise.resolve({ value: 'upstream-key' }),
        runPier: fakePier({ reward: 0 }),
      }),
    );
    await assert.rejects(runner(runInput()), /kimiCodeToolchainPath is required/);
  });
});

test('createPierTaskRunner wires the Kimi arm through the host proxy on a Squid-legal port', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const captured: FakeOptions['captured'] = {};
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        agent: 'kimi-code',
        backend: 'ai-sdk',
        provider: 'kimi-coding-plan',
        model: 'k3',
        baseUrl: 'https://api.kimi.com/coding/v1',
        kimiCodeToolchainPath: repo,
        resolveProviderCredential: () => Promise.resolve({ value: 'upstream-key' }),
        // A fixed high port stands in for 80/443 without needing privileges.
        providerProxyPort: 0,
        runPier: fakePier({ reward: 0, captured }),
      }),
    );
    const output = await runner(runInput());
    assert.equal(output.harbor.reward, 0);
    // The proxy URL and a minted (non-real) token reach the container via env-file,
    // never argv.
    assert.match(
      captured.envFile?.MAKA_PROVIDER_PROXY_URL ?? '',
      /^http:\/\/host\.docker\.internal:\d+\/coding\/v1$/,
    );
    assert.ok((captured.envFile?.MAKA_PROVIDER_PROXY_TOKEN ?? '').length >= 32);
    assert.notEqual(captured.envFile?.MAKA_PROVIDER_PROXY_TOKEN, 'upstream-key');
    assert.ok(!captured.request?.args.some((arg) => arg.startsWith('MAKA_PROVIDER_PROXY_TOKEN=')));
    // The Kimi toolchain is mounted read-only alongside the maka repo.
    const mountsFlag = captured.request?.args.indexOf('--mounts-json') ?? -1;
    const mounts = JSON.parse(captured.request!.args[mountsFlag + 1]!) as Array<{ target: string }>;
    assert.ok(mounts.some((mount) => mount.target === '/opt/maka-kimi-code-toolchain'));
  });
});

test('createPierTaskRunner overrides the Kimi proxy advertised host for native Linux Docker', async () => {
  // host.docker.internal does not resolve on native Linux Docker (pier's compose
  // wires no extra_hosts), so the Kimi arm must be able to advertise the host's
  // docker-bridge address instead; the container reads it via MAKA_PROVIDER_PROXY_URL.
  await withDirs(async ({ jobsDir, repo }) => {
    const captured: FakeOptions['captured'] = {};
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        agent: 'kimi-code',
        backend: 'ai-sdk',
        provider: 'kimi-coding-plan',
        model: 'k3',
        baseUrl: 'https://api.kimi.com/coding/v1',
        kimiCodeToolchainPath: repo,
        resolveProviderCredential: () => Promise.resolve({ value: 'upstream-key' }),
        providerProxyPort: 0,
        providerProxyAdvertisedHost: '172.17.0.1',
        runPier: fakePier({ reward: 0, captured }),
      }),
    );
    await runner(runInput());
    assert.match(
      captured.envFile?.MAKA_PROVIDER_PROXY_URL ?? '',
      /^http:\/\/172\.17\.0\.1:\d+\/coding\/v1$/,
    );
  });
});

async function runConcurrentKimiAttempts(
  ports: readonly number[],
  providerProxyHub?: Awaited<ReturnType<typeof createPierProviderProxyHub>>,
): Promise<number> {
  return await withDirs(async ({ jobsDir, repo }) => {
    let inFlight = 0;
    let maxInFlight = 0;
    const inner = fakePier({ reward: 0 });
    const runners = ports.map((providerProxyPort) =>
      createPierTaskRunner(
        baseOptions({
          jobsDir,
          makaRepoPath: repo,
          agent: 'kimi-code',
          backend: 'ai-sdk',
          provider: 'kimi-coding-plan',
          model: 'k3',
          baseUrl: 'https://api.kimi.com/coding/v1',
          kimiCodeToolchainPath: repo,
          resolveProviderCredential: () => Promise.resolve({ value: 'upstream-key' }),
          providerProxyPort,
          ...(providerProxyHub ? { providerProxyHub } : {}),
          runPier: async (request) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 25));
            try {
              return await inner(request);
            } finally {
              inFlight -= 1;
            }
          },
        }),
      ),
    );
    const outputs = await Promise.all(
      runners.map((runner, index) =>
        runner(runInput({ task: { id: `t${index}`, path: '/tasks/dasel-html-document-format' } })),
      ),
    );
    for (const output of outputs) assert.equal(output.harbor.reward, 0);
    return maxInFlight;
  });
}

/** Grab currently-free ports from the OS (all probes held open together so the
 * ports are distinct) so tests bind real listeners without privileges for 443. */
async function grabFreePorts(count: number): Promise<number[]> {
  const probes = Array.from({ length: count }, () => createServer());
  const ports = await Promise.all(
    probes.map(
      (probe) =>
        new Promise<number>((resolve) => {
          probe.listen(0, () => resolve((probe.address() as AddressInfo).port));
        }),
    ),
  );
  await Promise.all(probes.map((probe) => new Promise((resolve) => probe.close(resolve))));
  return ports;
}

test('createPierTaskRunner runs concurrent attempts through one fixed-port proxy hub', async () => {
  const [fixedPort] = await grabFreePorts(1);
  const hub = await createPierProviderProxyHub({
    providerProxyPort: fixedPort,
    providerProxyAdvertisedHost: '127.0.0.1',
  });
  try {
    assert.equal(await runConcurrentKimiAttempts(Array(8).fill(fixedPort!), hub), 8);
  } finally {
    await hub.close();
  }
});

test('createPierTaskRunner serializes fixed-port attempts when no proxy hub is provided', async () => {
  // Backward compatibility for direct runner callers: without a run-scoped hub,
  // each attempt owns a listener and therefore must still serialize the bind.
  const [fixedPort] = await grabFreePorts(1);
  assert.equal(await runConcurrentKimiAttempts([fixedPort!, fixedPort!]), 1);
});

test('createPierTaskRunner lets ephemeral-port Kimi attempts run concurrently', async () => {
  // Port 0 asks the OS for a fresh port per bind — no collision is possible,
  // so the serialization lock must not throttle throughput.
  assert.equal(await runConcurrentKimiAttempts([0, 0]), 2);
});

test('createPierTaskRunner lets Kimi attempts on distinct fixed ports run concurrently', async () => {
  // The lock is per port, not global: distinct fixed ports cannot collide.
  const [portA, portB] = await grabFreePorts(2);
  assert.notEqual(portA, portB);
  assert.equal(await runConcurrentKimiAttempts([portA!, portB!]), 2);
});

test('buildPierRunArgs targets the Codex adapter and forwards constructor kwargs via --ak', () => {
  const args = buildPierRunArgs({
    agent: 'codex',
    model: 'gpt-5.6-sol',
    taskPath: '/tasks/dasel',
    jobsDir: '/jobs',
    jobName: 'trial',
    environment: 'docker',
    timeoutMultiplier: 1,
    mounts: [],
    agentEnv: {},
    agentKwargs: { version: '0.146.0', reasoning_effort: 'xhigh' },
  });
  assert.match(args.join(' '), /--agent-import-path codex_agent:MakaCodexAgent/);
  assert.ok(!args.includes('--agent-timeout-multiplier'));
  assert.ok(args.includes('--ak'));
  assert.ok(args.includes('version=0.146.0'));
  assert.ok(args.includes('reasoning_effort=xhigh'));
});

test('createPierTaskRunner rejects a Codex arm whose version does not match the pinned toolchain', () => {
  assert.throws(
    () =>
      createPierTaskRunner({
        makaRepoPath: '/repo',
        jobsDir: '/jobs',
        model: 'gpt-5.6-sol',
        agent: 'codex',
        agentVersion: '0.0.1',
      }),
    /Codex adapter version must match toolchain version/,
  );
});

test('createPierTaskRunner requires the Codex toolchain mount for the Codex arm', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        agent: 'codex',
        agentVersion: CODEX_TOOLCHAIN_SPEC.codex.version,
        provider: 'openai-codex',
        resolveProviderCredential: () => Promise.resolve({ value: 'upstream-key' }),
        runPier: fakePier({ reward: 0 }),
      }),
    );
    await assert.rejects(runner(runInput()), /codexToolchainPath is required/);
  });
});

test('createPierTaskRunner wires the Codex arm through the host proxy with the pinned toolchain', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const captured: FakeOptions['captured'] = {};
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        agent: 'codex',
        agentVersion: CODEX_TOOLCHAIN_SPEC.codex.version,
        backend: 'ai-sdk',
        provider: 'openai-codex',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'xhigh',
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        codexToolchainPath: repo,
        resolveProviderCredential: () => Promise.resolve({ value: 'upstream-key' }),
        providerProxyPort: 0,
        runPier: fakePier({ reward: 0, captured }),
      }),
    );
    const output = await runner(
      runInput({
        task: {
          id: 'dasel',
          path: '/tasks/dasel-html-document-format',
          metadata: {
            agentTimeoutSec: 5_400,
            buildTimeoutSec: 1_800,
            verifierTimeoutSec: 1_800,
          },
        },
      }),
    );
    assert.equal(output.harbor.reward, 0);
    // The proxy URL and a minted (non-real) token reach the container via
    // env-file, never argv.
    assert.match(
      captured.envFile?.MAKA_PROVIDER_PROXY_URL ?? '',
      /^http:\/\/host\.docker\.internal:\d+\/backend-api\/codex$/,
    );
    assert.ok((captured.envFile?.MAKA_PROVIDER_PROXY_TOKEN ?? '').length >= 32);
    assert.notEqual(captured.envFile?.MAKA_PROVIDER_PROXY_TOKEN, 'upstream-key');
    const args = captured.request?.args ?? [];
    // Constructor kwargs ride --ak; the pinned-toolchain fingerprint rides --ae.
    assert.ok(!args.includes('--agent-timeout-multiplier'));
    assert.equal(captured.request?.timeoutMs, 13_860_000);
    assert.ok(args.includes(`version=${CODEX_TOOLCHAIN_SPEC.codex.version}`));
    assert.ok(args.includes('reasoning_effort=xhigh'));
    assert.ok(args.includes(`MAKA_CODEX_TOOLCHAIN_FINGERPRINT=${CODEX_TOOLCHAIN_FINGERPRINT}`));
    const mountsFlag = args.indexOf('--mounts-json');
    const mounts = JSON.parse(args[mountsFlag + 1]!) as Array<{ target: string }>;
    assert.ok(mounts.some((mount) => mount.target === '/opt/maka-codex-toolchain'));
  });
});

test('buildPierRunArgs targets the OpenCode adapter', () => {
  const args = buildPierRunArgs({
    agent: 'opencode',
    model: 'deepseek-v4-flash',
    taskPath: '/tasks/dasel',
    jobsDir: '/jobs',
    jobName: 'trial',
    environment: 'docker',
    timeoutMultiplier: 1,
    mounts: [],
    agentEnv: {},
  });
  assert.match(args.join(' '), /--agent-import-path opencode_agent:MakaOpenCodeAgent/);
  assert.ok(!args.includes('--agent-timeout-multiplier'));
});

test('createPierTaskRunner rejects an OpenCode arm whose version does not match the pinned toolchain', () => {
  assert.throws(
    () =>
      createPierTaskRunner({
        makaRepoPath: '/repo',
        jobsDir: '/jobs',
        model: 'deepseek-v4-flash',
        agent: 'opencode',
        agentVersion: '0.0.1',
      }),
    /OpenCode adapter version must match toolchain version/,
  );
});

test('createPierTaskRunner requires the OpenCode toolchain mount for the OpenCode arm', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        agent: 'opencode',
        agentVersion: OPENCODE_TOOLCHAIN_SPEC.opencode.version,
        provider: 'deepseek',
        apiKeyFile: '/secrets/deepseek.key',
        runPier: fakePier({ reward: 0 }),
      }),
    );
    await assert.rejects(runner(runInput()), /opencodeToolchainPath is required/);
  });
});

test('createPierTaskRunner rejects a Pier cell whose terminal provider stream is incomplete', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const makeRunner = (outcome: ProviderRequestTelemetry['outcome']) =>
      createPierTaskRunner(
        baseOptions({
          jobsDir,
          makaRepoPath: repo,
          agent: 'opencode',
          agentVersion: OPENCODE_TOOLCHAIN_SPEC.opencode.version,
          backend: 'ai-sdk',
          provider: 'deepseek',
          model: 'deepseek-v4-flash',
          reasoningEffort: 'max',
          opencodeToolchainPath: repo,
          apiKeyFile: '/secrets/deepseek.key',
          providerProxyHub: {
            baseUrl: 'http://host.docker.internal:443',
            issue: () => ({
              baseUrl: 'http://host.docker.internal:443',
              token: 'ephemeral-token',
              usage: () => null,
              telemetry: () => [
                {
                  requestId: 1,
                  method: 'POST',
                  path: '/chat/completions',
                  status: 200,
                  outcome,
                  durationMs: 5,
                  bodyChunks: 1,
                  responseBytes: 64,
                  terminalEvent: outcome === 'completed',
                },
              ],
              close: async () => {},
            }),
            close: async () => {},
          },
          runPier: fakePier({ reward: 0 }),
        }),
      );

    // A 200 stream without its protocol terminal event means the provider
    // response is incomplete: same infra classification as the Harbor runner,
    // never a graded model failure.
    await assert.rejects(makeRunner('interrupted')(runInput()), (error: unknown) => {
      assert.ok(error instanceof PierInfraError);
      assert.match(error.message, /terminal provider request did not complete/);
      assert.ok(error.artifactRefs?.providerTelemetryPath);
      return true;
    });
    // A completed terminal request takes the normal reward path.
    const output = await makeRunner('completed')(runInput());
    assert.equal(output.harbor.reward, 0);
    // So does a tail the agent tore down itself on its way out: the trial
    // raised nothing and the verifier graded it, so the cell is evidence.
    assert.equal((await makeRunner('aborted')(runInput())).harbor.reward, 0);
  });
});

test('createPierTaskRunner wires the OpenCode arm through the host proxy with the pinned toolchain', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const captured: FakeOptions['captured'] = {};
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        agent: 'opencode',
        agentVersion: OPENCODE_TOOLCHAIN_SPEC.opencode.version,
        backend: 'ai-sdk',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
        opencodeToolchainPath: repo,
        apiKeyFile: '/secrets/deepseek.key',
        providerProxyPort: 0,
        runPier: fakePier({ reward: 0, captured }),
      }),
    );
    const output = await runner(runInput());
    assert.equal(output.harbor.reward, 0);
    // The proxy URL and a minted token reach the container via env-file,
    // never argv — the adapter dials only the proxy.
    assert.match(
      captured.envFile?.MAKA_PROVIDER_PROXY_URL ?? '',
      /^http:\/\/host\.docker\.internal:\d+/,
    );
    assert.ok((captured.envFile?.MAKA_PROVIDER_PROXY_TOKEN ?? '').length >= 32);
    const args = captured.request?.args ?? [];
    assert.ok(!args.includes('--agent-timeout-multiplier'));
    // The adapter requires provider/model format (it splits on "/"), unlike
    // the other arms which take the provider-local bare id.
    assert.ok(args.includes('deepseek/deepseek-v4-flash'));
    // The pinned version rides --ak so trial provenance records it; the
    // toolchain fingerprint and reasoning variant ride --ae.
    assert.ok(args.includes(`version=${OPENCODE_TOOLCHAIN_SPEC.opencode.version}`));
    assert.ok(
      args.includes(`MAKA_OPENCODE_TOOLCHAIN_FINGERPRINT=${OPENCODE_TOOLCHAIN_FINGERPRINT}`),
    );
    assert.ok(args.includes('MAKA_OPENCODE_VARIANT=max'));
    const mountsFlag = args.indexOf('--mounts-json');
    const mounts = JSON.parse(args[mountsFlag + 1]!) as Array<{ target: string }>;
    assert.ok(mounts.some((mount) => mount.target === '/opt/maka-opencode-toolchain'));
  });
});

test('createPierTaskRunner routes a resolver-backed Maka arm through the host proxy', async () => {
  // A resolver credential (e.g. Codex OAuth) is only usable through the proxy,
  // so the Maka arm must take the proxy path even without useProviderProxy.
  await withDirs(async ({ jobsDir, repo }) => {
    const captured: FakeOptions['captured'] = {};
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        agent: 'maka',
        backend: 'ai-sdk',
        provider: 'openai-codex',
        model: 'gpt-5.6-sol',
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        resolveProviderCredential: () => Promise.resolve({ value: 'upstream-key' }),
        runPier: fakePier({ reward: 0, captured }),
      }),
    );
    await runner(runInput());
    // The host cell dials the loopback proxy with a minted token, never the
    // upstream credential.
    assert.match(
      captured.envFile?.MAKA_HOST_BASE_URL ?? '',
      /^http:\/\/127\.0\.0\.1:\d+\/backend-api\/codex$/,
    );
    assert.ok((captured.envFile?.MAKA_HOST_API_KEY ?? '').length >= 32);
    assert.notEqual(captured.envFile?.MAKA_HOST_API_KEY, 'upstream-key');
  });
});

test('createPierTaskRunner gives a Maka container task run a container-reachable proxy', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const captured: FakeOptions['captured'] = {};
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        makaNodeToolchainPath: repo,
        agent: 'maka',
        agentEnv: { MAKA_HARBOR_MODE: 'task-run' },
        backend: 'ai-sdk',
        provider: 'openai-codex',
        model: 'gpt-5.6-sol',
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        resolveProviderCredential: () => Promise.resolve({ value: 'upstream-key' }),
        providerProxyPort: 0,
        runPier: fakePier({ reward: 0, captured }),
      }),
    );

    await runner(runInput());

    assert.match(
      captured.envFile?.MAKA_PROVIDER_PROXY_URL ?? '',
      /^http:\/\/host\.docker\.internal:\d+\/backend-api\/codex$/,
    );
    assert.ok((captured.envFile?.MAKA_PROVIDER_PROXY_TOKEN ?? '').length >= 32);
    assert.notEqual(captured.envFile?.MAKA_PROVIDER_PROXY_TOKEN, 'upstream-key');
    assert.equal(captured.envFile?.MAKA_HOST_BASE_URL, undefined);
    assert.equal(captured.envFile?.MAKA_HOST_API_KEY, undefined);
  });
});

test('createPierTaskRunner gives the host-selected Kimi protocol proxy authority', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    let upstreamAuthorization = '';
    let upstreamPath = '';
    const upstream = createHttpServer((request, response) => {
      upstreamAuthorization = request.headers.authorization ?? '';
      upstreamPath = request.url ?? '';
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        [
          'data: {"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":25}}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
      );
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    assert.ok(address && typeof address !== 'string');
    const inner = fakePier({ reward: 0 });
    try {
      const runner = createPierTaskRunner(
        baseOptions({
          jobsDir,
          makaRepoPath: repo,
          agent: 'maka',
          backend: 'ai-sdk',
          provider: 'kimi-coding-plan',
          model: 'k3',
          baseUrl: `http://127.0.0.1:${address.port}/coding/v1`,
          resolveProviderCredential: () => Promise.resolve({ value: 'upstream-key' }),
          pricing: { inputUsdPer1M: 0, outputUsdPer1M: 0 },
          runPier: async (request) => {
            const envFileFlag = request.args.indexOf('--env-file');
            assert.ok(envFileFlag >= 0);
            const env = Object.fromEntries(
              (await readFile(request.args[envFileFlag + 1]!, 'utf8'))
                .split('\n')
                .filter((line) => line.includes('='))
                .map((line) => {
                  const index = line.indexOf('=');
                  return [line.slice(0, index), line.slice(index + 1)];
                }),
            );
            const response = await fetch(`${env.MAKA_HOST_BASE_URL}/v1/chat/completions`, {
              method: 'POST',
              headers: { authorization: `Bearer ${env.MAKA_HOST_API_KEY}` },
              body: '{}',
            });
            assert.equal(response.status, 200);
            await response.text();
            return inner(request);
          },
        }),
      );

      const output = await runner(
        runInput({
          agentEnv: {
            MAKA_HOST_MODEL_API_PROTOCOL: 'openai-chat',
            MAKA_MODEL_API_PROTOCOL: 'anthropic-messages',
          },
        }),
      );
      assert.equal(upstreamAuthorization, 'Bearer upstream-key');
      assert.equal(upstreamPath, '/coding/v1/chat/completions');
      assert.equal(output.cell.tokenSummary?.total, 125);
    } finally {
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

test('createPierTaskRunner keeps the real key host-side via a file path for the Maka arm', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const captured: FakeOptions['captured'] = {};
    const keyFile = join(repo, 'key');
    await mkdir(repo, { recursive: true });
    await writeFile(keyFile, 'sk-real\n', 'utf8');
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        agent: 'maka',
        backend: 'ai-sdk',
        provider: 'kimi-coding-plan',
        baseUrl: 'https://api.kimi.com/coding/v1',
        apiKeyFile: keyFile,
        runPier: fakePier({ reward: 0, captured }),
      }),
    );
    await runner(runInput());
    // Only the key-file PATH rides --ae; the key itself never leaves the file.
    assert.ok(captured.request?.args.includes(`MAKA_HOST_API_KEY_FILE=${keyFile}`));
    assert.ok(!captured.request?.args.some((arg) => arg.includes('sk-real')));
    assert.ok(captured.request?.args.includes('MAKA_HOST_BASE_URL=https://api.kimi.com/coding/v1'));
  });
});

test('createPierTaskRunner runs keyless providers as a host cell with MAKA_HOST_NO_AUTH', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const captured: FakeOptions['captured'] = {};
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        agent: 'maka',
        backend: 'ai-sdk',
        provider: 'ollama',
        model: 'qwen3:32b',
        runPier: fakePier({ reward: 0, captured }),
      }),
    );
    await runner(runInput());
    // Mirrors the Harbor runner: authKind 'none' providers need no key file and
    // run on the host with an explicit no-auth marker instead of silently
    // falling back to the in-container cell.
    assert.ok(captured.request?.args.includes('MAKA_HOST_NO_AUTH=true'));
    assert.ok(captured.request?.args.includes(`MAKA_HOST_REPO_ROOT=${repo}`));
    assert.ok(!captured.request?.args.some((arg) => arg.startsWith('MAKA_HOST_API_KEY_FILE=')));
  });
});

test('createPierTaskRunner keeps the fake backend on the in-container cell with no MAKA_HOST_*', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const captured: FakeOptions['captured'] = {};
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        agent: 'maka',
        provider: 'ollama',
        runPier: fakePier({ reward: 0, captured }),
      }),
    );
    await runner(runInput());
    // backend 'fake' is the zero-cost structural path (bind-mounted repo,
    // in-container cell); host-runtime wiring must not leak into it even for
    // keyless providers.
    assert.ok(!captured.request?.args.some((arg) => arg.startsWith('MAKA_HOST_')));
  });
});
