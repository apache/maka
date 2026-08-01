import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { basename, delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import {
  PROVIDER_DEFAULTS,
  providerAuthRequiresSecret,
  type ProviderType,
} from '@maka/core/llm-connections';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import { fetchGitHubCopilotModels, isSupportedGitHubCopilotAccountToken } from '@maka/runtime';
import {
  selectHarborCellTokenSummary,
  validateHarborCellExecutionIdentity,
  validateHarborCellOutput,
  validateHarborCellTokenSummary,
  type HarborCellExecutionIdentity,
  type HarborCellOutput,
} from './cell-output.js';
import {
  FixedPromptBudgetExhaustedError,
  type FixedPromptBudgetExhaustedError as FixedPromptBudgetExhaustedErrorType,
  type TaskRunInput,
  type TaskRunOutput,
  type TaskRunner,
} from './fixed-prompt-controller.js';
import type { HarborVerifierAttempt, HarborVerifierOutcome } from './fixed-prompt-wal-types.js';
import {
  HARBOR_ORACLE_EXECUTION_POLICY,
  HARBOR_ORACLE_MAX_ATTEMPTS,
  resolveHarnessOracleWatchdogTimeoutMs,
  type HarnessOracleTaskResult,
} from './harness-oracle-policy.js';
import {
  summarizeProviderTelemetry,
  startProviderAuthProxy,
  type ProviderRequestTelemetry,
  type ProviderTokenUsage,
  type ProviderUpstreamCredentialResolver,
  type ProviderUsageProtocol,
} from './provider-auth-proxy.js';
import {
  isSensitiveEnvName,
  providerBaseUrlFromEnv,
  providerCredentialEnv,
} from './provider-env.js';
import { lenientPositiveIntEnv } from './headless-run-env.js';
import {
  OPENCODE_TOOLCHAIN_CONTAINER_PATH,
  OPENCODE_TOOLCHAIN_FINGERPRINT,
  OPENCODE_TOOLCHAIN_SPEC,
} from './opencode-toolchain.js';
import {
  KIMI_CODE_TOOLCHAIN_CONTAINER_PATH,
  KIMI_CODE_TOOLCHAIN_FINGERPRINT,
  KIMI_CODE_TOOLCHAIN_SPEC,
} from './kimi-code-toolchain.js';
import {
  CODEX_TOOLCHAIN_CONTAINER_PATH,
  CODEX_TOOLCHAIN_FINGERPRINT,
  CODEX_TOOLCHAIN_SPEC,
} from './codex-toolchain.js';

const execFileAsync = promisify(execFile);

const CONTAINER_MAKA_REPO = '/opt/maka-agent';
const TRIAL_CELL_OUTPUT = 'agent/maka-cell-output.json';
const TRIAL_EXECUTION_IDENTITY = 'agent/maka-cell-execution-identity.json';
const TRIAL_USAGE_CHECKPOINT = 'agent/maka-cell-usage-checkpoint.json';
const TRIAL_RUNTIME_EVENTS = 'agent/runtime-events.jsonl';
const TRIAL_TASK_RUN_TRACE_EVENTS = 'agent/trace-events.jsonl';
const TRIAL_REWARD = 'verifier/reward.txt';
const TRIAL_VERIFIER_STDOUT = 'verifier/test-stdout.txt';
const TRIAL_VERIFIER_OUTCOME = 'verifier/maka-verifier-outcome.json';
const TRIAL_RESULT = 'result.json';
const TRIAL_TASK_RUN_TRACE_EVENTS_ROOT = 'agent/maka-task-run/runs/sessions';
const TRIAL_LEGACY_TRACE_EVENTS_ROOT = 'agent/maka-storage/sessions';
const PROVIDER_REQUEST_TELEMETRY = 'provider-request-telemetry.json';

/** A Harbor-side failure (build/docker/timeout/missing artifact) — NOT a benchmark
 * result. The controller turns a thrown error into an infra_failed event so it is
 * excluded from scoring instead of polluting the KEEP/DISCARD decision as reward 0. */
/** Shared across runners: the last proxied provider request must have
 * completed. A 200 stream without its protocol terminal event means the
 * provider response is incomplete — the trial is an infra failure, never a
 * graded model failure. Complete timed-out trials settle by deadline, so
 * their truncated tail request is expected and exempt. */
export function incompleteTerminalProviderRequest(
  providerTelemetry: readonly ProviderRequestTelemetry[],
  completeTimedOutTrial: boolean,
): ProviderRequestTelemetry | undefined {
  if (completeTimedOutTrial) return undefined;
  const terminal = providerTelemetry.at(-1);
  return terminal && terminal.outcome !== 'completed' ? terminal : undefined;
}

export class HarborInfraError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
    readonly kind: 'infra_failed' | 'timed_out' = 'infra_failed',
    readonly artifactRefs?: { providerTelemetryPath?: string },
  ) {
    super(message);
    this.name = 'HarborInfraError';
  }
}

/** Structural shape shared by HarborInfraError and PierInfraError — PierInfraError
 * is deliberately NOT a subclass (the controller classifies by behavior, never
 * identity), so the shared helpers are typed against the structure, not the class. */
export interface InfraErrorLike extends Error {
  readonly detail?: string;
  readonly kind: 'infra_failed' | 'timed_out';
  readonly artifactRefs?: { providerTelemetryPath?: string };
}

/** Constructor shape shared by HarborInfraError and PierInfraError. The shared
 * trial-mapping helpers below take this so they throw the calling runner's own
 * error type — diagnostics must keep naming the failing harness. */
export type InfraErrorCtor = new (
  message: string,
  detail?: string,
  kind?: 'infra_failed' | 'timed_out',
  artifactRefs?: { providerTelemetryPath?: string },
) => InfraErrorLike;

export interface HarborTaskPricing {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  cacheReadUsdPer1M?: number;
  cacheWriteUsdPer1M?: number;
  source?: string;
}

export type HarborBillingMode = 'metered' | 'account-plan';

export interface HarborTaskRunnerOptions {
  /** Host path to the maka repo, mounted read-only at /opt/maka-agent. */
  makaRepoPath: string;
  /** Harbor adapter under test (default: Maka). */
  agent?: 'maka' | 'opencode' | 'kimi-code' | 'codex';
  /** Version passed to Harbor's installed-agent adapter. */
  agentVersion?: string;
  /** Prepared OpenCode toolchain mounted read-only into task containers. */
  opencodeToolchainPath?: string;
  /** Prepared Kimi Code toolchain mounted read-only into task containers. */
  kimiCodeToolchainPath?: string;
  /** Prepared Codex CLI toolchain mounted read-only into task containers. */
  codexToolchainPath?: string;
  /** Explicit Docker target platform shared by comparison arms. */
  dockerPlatform?: 'linux/amd64';
  /** Base directory under which each task gets an isolated per-task job dir. */
  jobsDir: string;
  /** MAKA_MODEL, e.g. "deepseek/deepseek-v4-flash". */
  model: string;
  /** MAKA_PROVIDER, e.g. "deepseek". */
  provider?: string;
  reasoningEffort?: ThinkingLevel;
  /** Host path to an API key file. The key stays in the Harbor control process;
   * the task container receives no provider key env, key-file path, or secret mount. */
  apiKeyFile?: string;
  /** Resolves the current provider authority inside the host proxy for every request. */
  resolveProviderCredential?: ProviderUpstreamCredentialResolver;
  /** Per-1M USD pricing forwarded as MAKA_TRIAL_* so the cell emits real costUsd. */
  pricing?: HarborTaskPricing;
  /** Extra agent env merged last (e.g. DEEPSEEK_BASE_URL). */
  agentEnv?: Record<string, string>;
  harborBin?: string;
  /** Harbor environment type (default "docker"). */
  environment?: string;
  timeoutMultiplier?: number;
  /** Wall-clock ceiling for a single `harbor run`; a hung Docker/Harbor would
   * otherwise stall the unattended loop forever. Defaults to 45 minutes. */
  harborTimeoutMs?: number;
  /** Injectable Harbor process runner (default: execFile the harbor binary). */
  runHarbor?: HarborProcessRunner;
  /** Injectable only for deterministic GitHub Copilot account-discovery tests. */
  copilotFetch?: typeof fetch;
  now?: () => number;
}

export interface HarborRunRequest {
  harborBin: string;
  configPath: string;
  jobName: string;
  jobsDir: string;
  args: readonly string[];
  cwd: string;
  /** Wall-clock ceiling in ms; the default runner kills harbor past this. */
  timeoutMs?: number;
  /** Env overlaid onto the harbor process (e.g. PYTHONPATH for the adapter). */
  env?: Record<string, string>;
}

const DEFAULT_HARBOR_TIMEOUT_MS = 45 * 60_000;
const HARBOR_SETUP_TEARDOWN_GRACE_MS = 15 * 60_000;
export interface HarborRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  signal?: string;
}

export type HarborProcessRunner = (request: HarborRunRequest) => Promise<HarborRunResult>;

export interface HarborOracleQualifierOptions {
  makaRepoPath: string;
  jobsDir: string;
  harborBin?: string;
  runHarbor?: HarborProcessRunner;
}

export type HarborOracleQualifier = (
  task: TaskRunInput['task'],
) => Promise<HarnessOracleTaskResult>;

const EXPERIMENT_IDENTITY_ENV_KEYS = new Set([
  'MAKA_BACKEND',
  'MAKA_MODEL',
  'MAKA_PROVIDER',
  'MAKA_LLM_CONNECTION_SLUG',
  'MAKA_AGENT_TOOLS',
  'MAKA_REASONING_EFFORT',
  'MAKA_OPENCODE_VARIANT',
  'MAKA_SYSTEM_PROMPT',
  'MAKA_TRIAL_INPUT_USD_PER_1M',
  'MAKA_TRIAL_OUTPUT_USD_PER_1M',
  'MAKA_TRIAL_CACHE_READ_USD_PER_1M',
  'MAKA_TRIAL_CACHE_WRITE_USD_PER_1M',
  'MAKA_TRIAL_PRICING_SOURCE',
]);

export function createHarborTaskRunner(options: HarborTaskRunnerOptions): TaskRunner {
  const runHarbor = options.runHarbor ?? defaultHarborProcessRunner;
  const harborBin = options.harborBin ?? 'harbor';
  // The bare local adapter import paths resolve only when the adapter
  // directory is on harbor's PYTHONPATH; harbor is a uv-installed tool, so its cwd
  // is not enough. Prepend it (keeping any inherited PYTHONPATH).
  const harborAdapterDir = join(options.makaRepoPath, 'packages', 'headless', 'harbor');
  const pythonPath = [harborAdapterDir, process.env.PYTHONPATH].filter(Boolean).join(delimiter);

  const runner: TaskRunner = async (input: TaskRunInput): Promise<TaskRunOutput> => {
    const jobsDir = join(
      options.jobsDir,
      sanitize(input.runId),
      sanitize(input.roundId),
      sanitize(input.task.id),
    );
    const jobName = 'trial';
    const jobDir = join(jobsDir, jobName);
    // Start each attempt from a clean dir so a crashed prior attempt cannot be
    // mistaken for this attempt's trial output.
    await rm(jobsDir, { recursive: true, force: true });
    await mkdir(jobsDir, { recursive: true });

    const runnerOptions = {
      ...options,
      agentEnv: mergeAgentEnv(options.agentEnv, input.agentEnv),
    };
    const allowedHostCredentialEnvNames =
      runnerOptions.provider === 'github-copilot'
        ? new Set(providerCredentialEnv('github-copilot')?.apiKeys ?? [])
        : undefined;
    assertNoProviderSecretsInAgentEnv(runnerOptions.agentEnv, allowedHostCredentialEnvNames);
    const hasHostProviderRuntime =
      runnerOptions.apiKeyFile !== undefined ||
      runnerOptions.resolveProviderCredential !== undefined ||
      githubCopilotAccountTokenFromEnv(runnerOptions.provider, runnerOptions.agentEnv) !==
        undefined ||
      (!usesHostProviderProxy(runnerOptions.agent) &&
        !providerRequiresSecret(runnerOptions.provider));
    const configPath = join(jobsDir, 'job-config.json');
    const { agentEnv: _attemptAgentEnv, ...inputWithoutAttemptEnv } = input;
    const config = buildHarborJobConfig(inputWithoutAttemptEnv, {
      ...runnerOptions,
      jobsDir,
      jobName,
      ...(hasHostProviderRuntime
        ? { agentEnv: taskAgentEnvWithoutProviderSecrets(runnerOptions) }
        : {}),
    });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    const args = ['run', '--config', configPath, '--yes'];
    let result: HarborRunResult;
    let providerUsage: ProviderTokenUsage | null = null;
    let providerTelemetry: ProviderRequestTelemetry[] = [];
    const providerTelemetryPath = join(jobsDir, PROVIDER_REQUEST_TELEMETRY);
    try {
      const providerRuntime = await hostSideProviderRuntime(runnerOptions);
      try {
        result = await runHarbor({
          harborBin,
          configPath,
          jobName,
          jobsDir,
          args,
          cwd: options.makaRepoPath,
          timeoutMs: resolveHarborTimeoutMs(runnerOptions, input),
          env: { PYTHONPATH: pythonPath, ...(providerRuntime?.env ?? {}) },
        });
      } finally {
        await providerRuntime?.close?.();
        providerUsage = providerRuntime?.usage?.() ?? null;
        providerTelemetry = providerRuntime?.telemetry?.() ?? [];
        if (providerTelemetry.length > 0) {
          await writeFile(
            providerTelemetryPath,
            `${JSON.stringify(
              {
                schemaVersion: 1,
                summary: summarizeProviderTelemetry(providerTelemetry),
                requests: providerTelemetry,
              },
              null,
              2,
            )}\n`,
            'utf8',
          );
        }
      }
    } catch (error) {
      if (isBudgetExhaustedError(error)) throw error;
      throw new HarborInfraError(
        `harbor run failed to launch for task ${input.task.id}`,
        errorText(error),
        'infra_failed',
        providerTelemetryArtifactRefs(providerTelemetry, providerTelemetryPath),
      );
    }
    try {
      if (result.timedOut) {
        throw new HarborInfraError(
          `harbor run timed out for task ${input.task.id}`,
          tail(result.stderr || result.stdout),
        );
      }
      let trialDir: string;
      try {
        trialDir = await findTrialDir(jobDir, basename(input.task.path));
      } catch (error) {
        if (result.exitCode === 0) throw error;
        throw new HarborInfraError(
          `harbor run exited ${result.exitCode} for task ${input.task.id}`,
          tail(result.stderr || result.stdout),
        );
      }
      const cellOutputPath = join(trialDir, TRIAL_CELL_OUTPUT);
      const rewardPath = join(trialDir, TRIAL_REWARD);
      const resultPath = join(trialDir, TRIAL_RESULT);
      const hostEventsPath = join(trialDir, TRIAL_RUNTIME_EVENTS);

      const trialException = await readTrialException(resultPath);
      let completeTimedOutTrial = false;
      if (trialException && isBudgetExhaustedTrialException(trialException)) {
        const [rewardArtifact, verifierArtifact, cellArtifact] = await Promise.all([
          readOptionalText(rewardPath),
          readOptionalText(join(trialDir, TRIAL_VERIFIER_OUTCOME)),
          readOptionalText(cellOutputPath),
        ]);
        if (rewardArtifact === null || verifierArtifact === null || cellArtifact === null) {
          const artifactRefs = await readTimedOutTrialArtifacts(
            trialDir,
            input.task.id,
            runnerOptions.agent,
            harborTraceMode(runnerOptions.agentEnv),
          );
          throw new FixedPromptBudgetExhaustedError(
            `agent budget exhausted for task ${input.task.id}`,
            trialException,
            artifactRefs || providerTelemetry.length > 0
              ? {
                  ...(artifactRefs ?? {}),
                  ...(providerTelemetry.length > 0 ? { providerTelemetryPath } : {}),
                }
              : undefined,
          );
        }
        completeTimedOutTrial = true;
      }
      if (result.exitCode !== 0 && !completeTimedOutTrial) {
        throw new HarborInfraError(
          `harbor run exited ${result.exitCode} for task ${input.task.id}`,
          tail(result.stderr || result.stdout),
        );
      }
      const terminalProviderRequest = incompleteTerminalProviderRequest(
        providerTelemetry,
        completeTimedOutTrial,
      );
      if (terminalProviderRequest) {
        throw new HarborInfraError(
          `terminal provider request did not complete for task ${input.task.id}`,
          [
            `outcome=${terminalProviderRequest.outcome}`,
            terminalProviderRequest.status !== undefined
              ? `status=${terminalProviderRequest.status}`
              : undefined,
            terminalProviderRequest.errorClass
              ? `errorClass=${terminalProviderRequest.errorClass}`
              : undefined,
          ]
            .filter(Boolean)
            .join(', '),
          'infra_failed',
          { providerTelemetryPath },
        );
      }
      const reward = await readReward(rewardPath, resultPath, input.task.id);
      const rawCell = await readCellOutput(cellOutputPath, input.task.id);
      const usageCheckpoint = await readOptionalTokenSummary(
        join(trialDir, TRIAL_USAGE_CHECKPOINT),
      );
      const selectedUsage = selectHarborCellTokenSummary(rawCell.tokenSummary, usageCheckpoint);
      const checkpointedCell =
        selectedUsage && selectedUsage !== rawCell.tokenSummary
          ? { ...rawCell, tokenSummary: selectedUsage }
          : rawCell;
      const usageCell =
        checkpointedCell.tokenSummary || !providerUsage || !runnerOptions.pricing
          ? checkpointedCell
          : {
              ...checkpointedCell,
              tokenSummary: providerTokenSummary(providerUsage, runnerOptions.pricing),
            };
      const cell = completeTimedOutTrial
        ? {
            ...usageCell,
            status: 'failed' as const,
            errorClass: 'budget_exhausted',
            deadlineSettlement: {
              source: 'benchmark.deadline' as const,
              mode: 'immediate' as const,
            },
          }
        : usageCell;
      const verifierStdout = await readOptionalText(join(trialDir, TRIAL_VERIFIER_STDOUT));
      const verifier = await readVerifierOutcome(
        join(trialDir, TRIAL_VERIFIER_OUTCOME),
        input.task.id,
      );
      if (!verifier) {
        throw new HarborInfraError(
          `custom verifier produced no structured verifier outcome for task ${input.task.id}`,
        );
      }
      assertVerifierRewardAgreement(verifier, reward, input.task.id);
      const verifierFailureSummary =
        verifier?.outcome === 'candidate_timeout'
          ? 'candidate_timeout'
          : reward <= 0
            ? summarizeVerifierFailure(verifierStdout)
            : undefined;

      return {
        harbor: {
          reward,
          ...(verifierFailureSummary ? { verifierFailureSummary } : {}),
          ...(verifier ? { verifier } : {}),
        },
        // Override the container-local runtimeEventsPath with the host path so the
        // controller's reward-hack scan and structural smoke can read raw events.
        cell: {
          ...cell,
          ...(providerTelemetry.length > 0 ? { providerTelemetryPath } : {}),
          runtimeEventsPath: hostEventsPath,
          traceEventsPath: hostTraceEventsPath(
            runnerOptions.agent,
            harborTraceMode(runnerOptions.agentEnv),
            trialDir,
            cell,
            hostEventsPath,
          ),
        },
      };
    } catch (error) {
      throw withProviderTelemetryArtifact(error, providerTelemetry, providerTelemetryPath);
    }
  };
  return runner;
}

/** Shared across runners: attach the provider-request telemetry artifact to a
 * thrown outcome so infra failures keep their billing/usage evidence. */
export function providerTelemetryArtifactRefs(
  telemetry: readonly ProviderRequestTelemetry[],
  providerTelemetryPath: string,
): { providerTelemetryPath: string } | undefined {
  return telemetry.length > 0 ? { providerTelemetryPath } : undefined;
}

/** Shared across runners: enriches only the calling runner's own infra error
 * type, so a foreign error passes through untouched. */
export function withProviderTelemetryArtifact(
  error: unknown,
  telemetry: readonly ProviderRequestTelemetry[],
  providerTelemetryPath: string,
  infraError: InfraErrorCtor = HarborInfraError,
): unknown {
  const artifactRefs = providerTelemetryArtifactRefs(telemetry, providerTelemetryPath);
  if (
    !(error instanceof infraError) ||
    !artifactRefs ||
    error.artifactRefs?.providerTelemetryPath
  ) {
    return error;
  }
  const enriched = new infraError(error.message, error.detail, error.kind, artifactRefs);
  enriched.stack = error.stack;
  return enriched;
}

export function createHarborOracleQualifier(
  options: HarborOracleQualifierOptions,
): HarborOracleQualifier {
  const runHarbor = options.runHarbor ?? defaultHarborProcessRunner;
  const harborBin = options.harborBin ?? 'harbor';
  const harborAdapterDir = join(options.makaRepoPath, 'packages', 'headless', 'harbor');
  const pythonPath = [harborAdapterDir, process.env.PYTHONPATH].filter(Boolean).join(delimiter);
  return async (task) => {
    const jobsDir = join(options.jobsDir, sanitize(task.id));
    const jobName = 'qualification';
    const jobDir = join(jobsDir, jobName);
    await rm(jobsDir, { recursive: true, force: true });
    await mkdir(jobsDir, { recursive: true });
    const verifier = verifierPolicy(task);
    const configPath = join(jobsDir, 'job-config.json');
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          job_name: jobName,
          jobs_dir: jobsDir,
          n_attempts: HARBOR_ORACLE_EXECUTION_POLICY.job.attempts,
          n_concurrent_trials: HARBOR_ORACLE_EXECUTION_POLICY.job.concurrentTrials,
          timeout_multiplier: HARBOR_ORACLE_EXECUTION_POLICY.job.timeoutMultiplier,
          quiet: true,
          environment: {
            type: HARBOR_ORACLE_EXECUTION_POLICY.environment.type,
            force_build: HARBOR_ORACLE_EXECUTION_POLICY.environment.forceBuild,
            delete: HARBOR_ORACLE_EXECUTION_POLICY.environment.delete,
            extra_docker_compose: [
              join(
                options.makaRepoPath,
                'packages/headless/harbor',
                HARBOR_ORACLE_EXECUTION_POLICY.environment.composeFile,
              ),
            ],
          },
          verifier: harborVerifierConfig(verifier),
          metrics: [{ type: 'mean', kwargs: {} }],
          agents: [
            {
              name: HARBOR_ORACLE_EXECUTION_POLICY.job.agent,
              ...(task.metadata?.agentTimeoutSec !== undefined
                ? { max_timeout_sec: task.metadata.agentTimeoutSec }
                : {}),
            },
          ],
          datasets: [],
          tasks: [{ path: task.path, overwrite: false }],
          artifacts: [],
          extra_instruction_paths: [],
          plugins: [],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    const result = await runHarbor({
      harborBin,
      configPath,
      jobName,
      jobsDir,
      args: ['run', '--config', configPath, '--yes'],
      cwd: options.makaRepoPath,
      timeoutMs: resolveHarnessOracleWatchdogTimeoutMs({
        agentTimeoutSec: task.metadata?.agentTimeoutSec ?? 0,
        verifierTimeoutSec: verifier.outerTimeoutSec,
      }),
      env: { PYTHONPATH: pythonPath },
    });
    if (result.timedOut) {
      throw new HarborInfraError(
        `Harbor Oracle qualification timed out for task ${task.id}`,
        tail(result.stderr || result.stdout),
        'timed_out',
      );
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `Harbor Oracle qualification exited ${result.exitCode} for task ${task.id}: ${tail(result.stderr || result.stdout)}`,
      );
    }
    const trialDir = await findTrialDir(jobDir, basename(task.path));
    const outcome = await readVerifierOutcome(join(trialDir, TRIAL_VERIFIER_OUTCOME), task.id);
    if (!outcome)
      throw new HarborInfraError(
        `Oracle qualification produced no structured verifier outcome for task ${task.id}`,
      );
    const reward = await readReward(
      join(trialDir, TRIAL_REWARD),
      join(trialDir, TRIAL_RESULT),
      task.id,
    );
    assertVerifierRewardAgreement(outcome, reward, task.id, 'Oracle qualification ');
    return { outcome: outcome.outcome, reward, attempts: outcome.attempts.length };
  };
}

function assertVerifierRewardAgreement(
  outcome: HarborVerifierOutcome,
  reward: number,
  taskId: string,
  prefix = '',
): void {
  if ((outcome.outcome === 'passed') !== reward > 0) {
    throw new HarborInfraError(
      `${prefix}reward disagrees with verifier outcome for task ${taskId}`,
    );
  }
}

function resolveHarborTimeoutMs(options: HarborTaskRunnerOptions, input: TaskRunInput): number {
  if (options.harborTimeoutMs !== undefined) return options.harborTimeoutMs;
  return resolveNativeHarborTimeoutMs(options, input.task);
}

function resolveNativeHarborTimeoutMs(
  options: Pick<HarborTaskRunnerOptions, 'timeoutMultiplier' | 'agentEnv'>,
  task: TaskRunInput['task'],
): number {
  const configuredCellTimeoutSec = lenientPositiveIntEnv(options.agentEnv?.MAKA_CELL_TIMEOUT_SEC);
  const agentTimeoutSec = Math.max(
    task.metadata?.agentTimeoutSec ?? 0,
    configuredCellTimeoutSec ?? 0,
  );
  return resolveNativeTrialTimeoutMs({
    nativePhasesSec: agentTimeoutSec + verifierPolicy(task).outerTimeoutSec,
    timeoutMultiplier: options.timeoutMultiplier ?? 1,
  });
}

/** Shared wall-clock watchdog contract for one trial: the harness's maximum
 * legitimate lifecycle in native seconds, times the multiplier, plus
 * setup/teardown grace, floored at 45 minutes so short tasks keep a sane
 * ceiling. Cross-runner benchmark invariant: each runner owns its own
 * lifecycle shape (which phases run, and how often its harness retries them)
 * and supplies the summed seconds — Harbor passes agent + the oracle verifier
 * policy's outer budget; Pier passes its full phase-and-retry model. */
export function resolveNativeTrialTimeoutMs(input: {
  nativePhasesSec: number;
  timeoutMultiplier: number;
}): number {
  const nativePhasesMs = input.nativePhasesSec * input.timeoutMultiplier * 1_000;
  return Math.max(DEFAULT_HARBOR_TIMEOUT_MS, nativePhasesMs + HARBOR_SETUP_TEARDOWN_GRACE_MS);
}

async function readOptionalCellOutput(
  cellOutputPath: string,
  taskId: string,
): Promise<HarborCellOutput | null> {
  try {
    return await readCellOutput(cellOutputPath, taskId);
  } catch {
    return null;
  }
}

/** Shared across runners: resolve the richest host-side trace for a trial.
 * Task-run mode prefers the combined agent/trace-events.jsonl, then the
 * task-run session layout; cell mode resolves the maka-storage session events
 * via cell.runtimeRefs — the raw runtime-events fallback is a last resort, and
 * skipping the session branch silently drops tool_failed /
 * provider_request_captured failure attribution downstream. */
export function hostTraceEventsPath(
  agent: HarborTaskRunnerOptions['agent'],
  mode: 'cell' | 'task-run',
  trialDir: string,
  cell: HarborCellOutput,
  hostEventsPath: string,
): string {
  if (agent !== undefined && agent !== 'maka') return hostEventsPath;
  const traceSuffix = [cell.runtimeRefs.sessionId, 'runs', cell.runtimeRefs.runId, 'events.jsonl'];
  if (mode === 'task-run') {
    const combinedTracePath = join(trialDir, TRIAL_TASK_RUN_TRACE_EVENTS);
    if (existsSync(combinedTracePath)) return combinedTracePath;
    const taskRunTracePath = join(trialDir, TRIAL_TASK_RUN_TRACE_EVENTS_ROOT, ...traceSuffix);
    return existsSync(taskRunTracePath) ? taskRunTracePath : hostEventsPath;
  }
  const cellTracePath = join(trialDir, TRIAL_LEGACY_TRACE_EVENTS_ROOT, ...traceSuffix);
  return existsSync(cellTracePath) ? cellTracePath : hostEventsPath;
}

/** Exported alongside readTimedOutTrialArtifacts: the Pier runner resolves the
 * same MAKA_HARBOR_MODE contract when recovering timed-out trial artifacts. */
export function harborTraceMode(agentEnv: Record<string, string> | undefined): 'cell' | 'task-run' {
  return agentEnv?.MAKA_HARBOR_MODE === 'task-run' ? 'task-run' : 'cell';
}

function cellArtifactRefs(
  cell: HarborCellOutput,
  hostEventsPath: string,
  trialDir: string,
  agent: HarborTaskRunnerOptions['agent'],
  mode: 'cell' | 'task-run',
) {
  const traceEventsPath = hostTraceEventsPath(agent, mode, trialDir, cell, hostEventsPath);
  return {
    runtimeEventsPath: hostEventsPath,
    traceEventsPath,
    ...(cell.tokenSummary ? { tokenSummary: cell.tokenSummary } : {}),
    cellOutput: { ...cell, runtimeEventsPath: hostEventsPath, traceEventsPath },
  };
}

/** Recover whatever attested evidence a timed-out/budget-exhausted trial left
 * behind (cell output, execution identity, usage checkpoint) so the sample keeps
 * its Pass@1 eligibility instead of being excluded as missing_execution_identity.
 * Cross-runner benchmark invariant: the Pier runner reuses this exact
 * implementation — both runners' trials are written by the same adapters into
 * the same agent/ layout, so the recovery contract must not fork. */
export async function readTimedOutTrialArtifacts(
  trialDir: string,
  taskId: string,
  agent: HarborTaskRunnerOptions['agent'],
  mode: 'cell' | 'task-run',
) {
  const cell = await readOptionalCellOutput(join(trialDir, TRIAL_CELL_OUTPUT), taskId);
  if (cell) {
    const usageCheckpoint = await readOptionalTokenSummary(join(trialDir, TRIAL_USAGE_CHECKPOINT));
    const selectedUsage = selectHarborCellTokenSummary(cell.tokenSummary, usageCheckpoint);
    const recoveredCell =
      selectedUsage && selectedUsage !== cell.tokenSummary
        ? { ...cell, tokenSummary: selectedUsage }
        : cell;
    return cellArtifactRefs(
      recoveredCell,
      join(trialDir, TRIAL_RUNTIME_EVENTS),
      trialDir,
      agent,
      mode,
    );
  }
  const [executionIdentity, tokenSummary] = await Promise.all([
    readOptionalExecutionIdentity(join(trialDir, TRIAL_EXECUTION_IDENTITY)),
    readOptionalTokenSummary(join(trialDir, TRIAL_USAGE_CHECKPOINT)),
  ]);
  return executionIdentity || tokenSummary
    ? {
        ...(executionIdentity ? { executionIdentity } : {}),
        ...(tokenSummary ? { tokenSummary } : {}),
      }
    : null;
}

async function readOptionalExecutionIdentity(
  path: string,
): Promise<HarborCellExecutionIdentity | null> {
  try {
    return validateHarborCellExecutionIdentity(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return null;
  }
}

async function readOptionalTokenSummary(path: string) {
  try {
    return validateHarborCellTokenSummary(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return null;
  }
}

async function readOptionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function readVerifierOutcome(
  path: string,
  taskId: string,
): Promise<HarborVerifierOutcome | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return null;
    throw new HarborInfraError(
      `failed to read verifier outcome for task ${taskId}`,
      errorText(error),
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new HarborInfraError(
      `verifier outcome is not valid JSON for task ${taskId}`,
      errorText(error),
    );
  }
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new HarborInfraError(`verifier outcome is malformed for task ${taskId}`);
  }
  const outcome = value.outcome;
  if (outcome === 'infra_failed') {
    throw new HarborInfraError(`verifier infrastructure failed for task ${taskId}`);
  }
  if (outcome !== 'passed' && outcome !== 'failed' && outcome !== 'candidate_timeout') {
    throw new HarborInfraError(`verifier outcome is malformed for task ${taskId}`);
  }
  if (
    !Array.isArray(value.attempts) ||
    value.attempts.length < 1 ||
    value.attempts.length > HARBOR_ORACLE_MAX_ATTEMPTS
  ) {
    throw new HarborInfraError(`verifier outcome attempts are malformed for task ${taskId}`);
  }
  const attempts = value.attempts.map((attempt, index) =>
    validateVerifierAttempt(attempt, index + 1, taskId),
  );
  const last = attempts.at(-1)!;
  const priorAttemptsAreRetryable = attempts
    .slice(0, -1)
    .every(
      (attempt) =>
        attempt.classification === 'infra_setup_failed' ||
        attempt.classification === 'infra_failed',
    );
  if (
    !priorAttemptsAreRetryable ||
    (outcome === 'passed' && (last.classification !== 'passed' || (last.reward ?? 0) <= 0)) ||
    (outcome === 'failed' && (last.classification !== 'failed' || last.reward !== 0)) ||
    (outcome === 'candidate_timeout' && last.classification !== 'timeout')
  ) {
    throw new HarborInfraError(`verifier outcome disagrees with its attempts for task ${taskId}`);
  }
  return { outcome, attempts };
}

function validateVerifierAttempt(
  value: unknown,
  expectedAttempt: number,
  taskId: string,
): HarborVerifierAttempt {
  if (!isRecord(value) || value.attempt !== expectedAttempt) {
    throw new HarborInfraError(`verifier attempt is malformed for task ${taskId}`);
  }
  const classification = value.classification;
  if (
    classification !== 'passed' &&
    classification !== 'failed' &&
    classification !== 'timeout' &&
    classification !== 'infra_setup_failed' &&
    classification !== 'infra_failed'
  ) {
    throw new HarborInfraError(`verifier attempt classification is malformed for task ${taskId}`);
  }
  if (
    typeof value.durationMs !== 'number' ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0
  ) {
    throw new HarborInfraError(`verifier attempt duration is malformed for task ${taskId}`);
  }
  if (
    value.reward !== undefined &&
    (typeof value.reward !== 'number' || !Number.isFinite(value.reward))
  ) {
    throw new HarborInfraError(`verifier attempt reward is malformed for task ${taskId}`);
  }
  return {
    attempt: expectedAttempt,
    classification,
    durationMs: value.durationMs,
    ...(typeof value.reward === 'number' ? { reward: value.reward } : {}),
  };
}

function summarizeVerifierFailure(text: string | null): string | undefined {
  if (!text) return undefined;
  const normalized = text.toLowerCase();
  const parts: string[] = [];
  if (normalized.includes('assertionerror') || normalized.includes('assert ')) {
    parts.push('output_assertion_failed');
  }
  if (integerAssertionOffByOne(text)) {
    parts.push('integer_output_off_by_one');
  }
  if (finalStateTextMismatch(text)) {
    parts.push('final_state_expected_text_mismatch');
  }
  if (structuredOutputValuesMismatch(normalized)) {
    parts.push('structured_output_values_mismatch');
  }
  if (
    normalized.includes("module 'numpy' has no attribute 'int'") ||
    normalized.includes('module "numpy" has no attribute "int"')
  ) {
    parts.push('python_numpy_removed_alias_np.int');
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function integerAssertionOffByOne(text: string): boolean {
  const match = text.match(/assert\s+['"](\d+)['"]\s+in\s+['"](\d+)['"]/);
  if (!match) return false;
  const expected = Number(match[1]);
  const actual = Number(match[2]);
  return (
    Number.isSafeInteger(expected) &&
    Number.isSafeInteger(actual) &&
    Math.abs(expected - actual) === 1
  );
}

function finalStateTextMismatch(text: string): boolean {
  return /\bExpected\s+['"][^'"\n]{1,200}['"]/i.test(text) && /\bGot:\s+['"]/i.test(text);
}

function structuredOutputValuesMismatch(normalizedText: string): boolean {
  return normalizedText.includes('only found') && normalizedText.includes('expected values');
}

/** Shared across runners: overlay attempt-level env onto runner-level env. */
export function mergeAgentEnv(
  base: Record<string, string> | undefined,
  attempt: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!base && !attempt) return undefined;
  return { ...(base ?? {}), ...(attempt ?? {}) };
}

export function buildHarborJobConfig(
  input: TaskRunInput,
  options: HarborTaskRunnerOptions & { jobsDir: string; jobName: string },
): Record<string, unknown> {
  const attemptAgentEnv = mergeAgentEnv(options.agentEnv, input.agentEnv);
  assertNoProviderSecretsInAgentEnv(attemptAgentEnv);
  assertNoExperimentIdentityOverrides(attemptAgentEnv);
  const provider = options.provider ?? 'deepseek';
  const makaModel = modelIdForProvider(options.model, provider);
  const adapter = options.agent ?? 'maka';
  const agentModel = adapter === 'opencode' ? modelForOpenCode(options.model, provider) : makaModel;
  if (adapter === 'opencode' && !options.opencodeToolchainPath) {
    throw new Error('opencodeToolchainPath is required for the OpenCode adapter');
  }
  if (adapter === 'opencode' && options.agentVersion !== OPENCODE_TOOLCHAIN_SPEC.opencode.version) {
    throw new Error(
      `OpenCode adapter version must match toolchain version ${OPENCODE_TOOLCHAIN_SPEC.opencode.version}`,
    );
  }
  if (adapter === 'kimi-code' && !options.kimiCodeToolchainPath) {
    throw new Error('kimiCodeToolchainPath is required for the Kimi Code adapter');
  }
  if (
    adapter === 'kimi-code' &&
    options.agentVersion !== KIMI_CODE_TOOLCHAIN_SPEC.kimiCode.version
  ) {
    throw new Error(
      `Kimi Code adapter version must match toolchain version ${KIMI_CODE_TOOLCHAIN_SPEC.kimiCode.version}`,
    );
  }
  if (adapter === 'codex' && !options.codexToolchainPath) {
    throw new Error('codexToolchainPath is required for the Codex adapter');
  }
  if (adapter === 'codex' && options.agentVersion !== CODEX_TOOLCHAIN_SPEC.codex.version) {
    throw new Error(
      `Codex adapter version must match toolchain version ${CODEX_TOOLCHAIN_SPEC.codex.version}`,
    );
  }
  const mounts: Array<Record<string, unknown>> = [
    { type: 'bind', source: options.makaRepoPath, target: CONTAINER_MAKA_REPO, read_only: true },
    ...(adapter === 'opencode'
      ? [
          {
            type: 'bind',
            source: options.opencodeToolchainPath!,
            target: OPENCODE_TOOLCHAIN_CONTAINER_PATH,
            read_only: true,
          },
        ]
      : adapter === 'kimi-code'
        ? [
            {
              type: 'bind',
              source: options.kimiCodeToolchainPath!,
              target: KIMI_CODE_TOOLCHAIN_CONTAINER_PATH,
              read_only: true,
            },
          ]
        : adapter === 'codex'
          ? [
              {
                type: 'bind',
                source: options.codexToolchainPath!,
                target: CODEX_TOOLCHAIN_CONTAINER_PATH,
                read_only: true,
              },
            ]
          : []),
  ];

  const agentEnv: Record<string, string> = {
    MAKA_BACKEND: 'ai-sdk',
    MAKA_MODEL: makaModel,
    MAKA_PROVIDER: provider,
    MAKA_LLM_CONNECTION_SLUG: provider,
    MAKA_AGENT_TOOLS: input.config.agentTools === true ? 'true' : 'false',
    // Verbatim — the controller hashes exactly these bytes and verifies the round-trip.
    MAKA_SYSTEM_PROMPT: input.systemPrompt,
  };
  if (options.reasoningEffort) {
    agentEnv.MAKA_REASONING_EFFORT = options.reasoningEffort;
    if (adapter === 'opencode') agentEnv.MAKA_OPENCODE_VARIANT = options.reasoningEffort;
  }
  if (adapter === 'opencode') {
    agentEnv.MAKA_OPENCODE_TOOLCHAIN_FINGERPRINT = OPENCODE_TOOLCHAIN_FINGERPRINT;
  }
  if (adapter === 'kimi-code') {
    agentEnv.MAKA_KIMI_CODE_TOOLCHAIN_FINGERPRINT = KIMI_CODE_TOOLCHAIN_FINGERPRINT;
  }
  if (adapter === 'codex') {
    agentEnv.MAKA_CODEX_TOOLCHAIN_FINGERPRINT = CODEX_TOOLCHAIN_FINGERPRINT;
  }

  if (options.pricing) {
    agentEnv.MAKA_TRIAL_INPUT_USD_PER_1M = String(options.pricing.inputUsdPer1M);
    agentEnv.MAKA_TRIAL_OUTPUT_USD_PER_1M = String(options.pricing.outputUsdPer1M);
    if (options.pricing.cacheReadUsdPer1M !== undefined) {
      agentEnv.MAKA_TRIAL_CACHE_READ_USD_PER_1M = String(options.pricing.cacheReadUsdPer1M);
    }
    if (options.pricing.cacheWriteUsdPer1M !== undefined) {
      agentEnv.MAKA_TRIAL_CACHE_WRITE_USD_PER_1M = String(options.pricing.cacheWriteUsdPer1M);
    }
    if (options.pricing.source) {
      agentEnv.MAKA_TRIAL_PRICING_SOURCE = options.pricing.source;
    }
  }

  Object.assign(agentEnv, attemptAgentEnv ?? {});
  // Lenient by shared contract with the Python adapter: a malformed value must
  // fall back (metadata, then the adapter's default) rather than fail the run.
  const cellTimeoutSec =
    lenientPositiveIntEnv(agentEnv.MAKA_CELL_TIMEOUT_SEC) ?? input.task.metadata?.agentTimeoutSec;
  if (cellTimeoutSec !== undefined) {
    agentEnv.MAKA_CELL_TIMEOUT_SEC = String(cellTimeoutSec);
    const streamTimeoutMs = cellTimeoutSec * 1_000;
    if (adapter === 'maka' && Number.isSafeInteger(streamTimeoutMs)) {
      // Harbor already owns the task-native hard deadline. Keep the runtime's
      // first-event and between-event watchdogs from imposing a shorter,
      // benchmark-distorting cutoff on long reasoning turns.
      agentEnv.MAKA_STREAM_CONNECT_TIMEOUT_MS = String(streamTimeoutMs);
      agentEnv.MAKA_STREAM_IDLE_TIMEOUT_MS = String(streamTimeoutMs);
    }
  }
  const verifier = verifierPolicy(input.task);

  return {
    job_name: options.jobName,
    jobs_dir: options.jobsDir,
    n_attempts: 1,
    n_concurrent_trials: 1,
    timeout_multiplier: options.timeoutMultiplier ?? 1.0,
    quiet: true,
    environment: {
      type: options.environment ?? 'docker',
      force_build: false,
      delete: true,
      mounts,
      ...(options.dockerPlatform === 'linux/amd64'
        ? {
            extra_docker_compose: [
              join(
                options.makaRepoPath,
                'packages/headless/harbor/docker-compose-linux-amd64.yaml',
              ),
            ],
          }
        : {}),
    },
    verifier: harborVerifierConfig(verifier),
    metrics: [{ type: 'mean', kwargs: {} }],
    agents: [
      {
        ...(adapter === 'maka' ? { name: adapter } : {}),
        import_path:
          adapter === 'opencode'
            ? 'opencode_agent:MakaOpenCodeAgent'
            : adapter === 'kimi-code'
              ? 'kimi_code_agent:MakaKimiCodeAgent'
              : adapter === 'codex'
                ? 'codex_agent:MakaCodexAgent'
                : 'maka_agent:MakaAgent',
        model_name: agentModel,
        kwargs:
          adapter === 'maka'
            ? { backend: 'ai-sdk' }
            : options.agentVersion
              ? {
                  version: options.agentVersion,
                  ...(adapter === 'codex' && options.reasoningEffort
                    ? { reasoning_effort: options.reasoningEffort }
                    : {}),
                }
              : {},
        env: agentEnv,
        ...(cellTimeoutSec !== undefined ? { max_timeout_sec: cellTimeoutSec } : {}),
      },
    ],
    datasets: [],
    tasks: [{ path: input.task.path, overwrite: false }],
    artifacts: [],
    extra_instruction_paths: [],
    plugins: [],
  };
}

function harborVerifierConfig(verifier: ReturnType<typeof verifierPolicy>) {
  return {
    env: {},
    disable: false,
    import_path: HARBOR_ORACLE_EXECUTION_POLICY.verifier.importPath,
    kwargs: {
      attempt_timeout_sec: verifier.attemptTimeoutSec,
      max_attempts: HARBOR_ORACLE_MAX_ATTEMPTS,
      retry_backoff_sec: HARBOR_ORACLE_EXECUTION_POLICY.verifier.retryBackoffSec,
      total_timeout_sec: verifier.totalTimeoutSec,
    },
    override_timeout_sec: verifier.outerTimeoutSec,
  };
}

function verifierPolicy(task: TaskRunInput['task']): {
  attemptTimeoutSec: number;
  totalTimeoutSec: number;
  outerTimeoutSec: number;
} {
  const attemptTimeoutSec =
    task.metadata?.verifierTimeoutSec ??
    HARBOR_ORACLE_EXECUTION_POLICY.verifier.defaultAttemptTimeoutSec;
  const totalTimeoutSec =
    attemptTimeoutSec * HARBOR_ORACLE_EXECUTION_POLICY.verifier.totalAttemptBudgetMultiplier;
  return {
    attemptTimeoutSec,
    totalTimeoutSec,
    outerTimeoutSec: totalTimeoutSec + HARBOR_ORACLE_EXECUTION_POLICY.verifier.retryGraceSec,
  };
}

async function hostSideProviderRuntime(options: HarborTaskRunnerOptions): Promise<{
  env: Record<string, string>;
  usage?: () => ProviderTokenUsage | null;
  telemetry?: () => ProviderRequestTelemetry[];
  close?: () => Promise<void>;
} | null> {
  const agent = options.agent ?? 'maka';
  const provider = options.provider ?? 'deepseek';
  if (usesHostProviderProxy(agent) && provider === 'github-copilot') {
    const adapter = agent === 'kimi-code' ? 'Kimi Code' : agent === 'codex' ? 'Codex' : 'OpenCode';
    throw new Error(
      `GitHub Copilot Harbor runs use the Maka host agent; the ${adapter} Harbor adapter does not support this provider`,
    );
  }
  const githubToken =
    provider === 'github-copilot'
      ? options.apiKeyFile
        ? (await readFile(options.apiKeyFile, 'utf8')).trim()
        : githubCopilotAccountTokenFromEnv(provider, options.agentEnv)
      : undefined;
  if (
    !options.apiKeyFile &&
    !options.resolveProviderCredential &&
    !githubToken &&
    providerRequiresSecret(provider)
  )
    return null;
  const providerEnv = providerCredentialEnv(provider);
  const [primaryBaseUrl] = providerEnv?.baseUrls ?? [];
  const configuredBaseUrl =
    (primaryBaseUrl ? options.agentEnv?.[primaryBaseUrl] : undefined) ??
    options.agentEnv?.MAKA_BASE_URL ??
    providerBaseUrlFromEnv(provider, options.agentEnv ?? {});
  const copilotCredential = githubToken
    ? await resolveGitHubCopilotHostCredential(
        githubToken,
        modelIdForProvider(options.model, provider),
        configuredBaseUrl ?? PROVIDER_DEFAULTS['github-copilot'].baseUrl,
        options.copilotFetch,
      )
    : undefined;
  const baseUrl = copilotCredential?.baseUrl ?? configuredBaseUrl;
  if (options.resolveProviderCredential || usesHostProviderProxy(agent)) {
    const apiKeyFile = options.apiKeyFile;
    const resolveProviderCredential = options.resolveProviderCredential;
    if (!apiKeyFile && !resolveProviderCredential) return null;
    if (!baseUrl) throw new Error(`${agent} provider ${provider} requires a base URL`);
    const apiProtocol = providerProxyApiProtocol(agent, options.agentEnv);
    const proxy = await startProviderAuthProxy({
      upstreamBaseUrl: providerProxyUpstreamBaseUrl(baseUrl, provider, apiProtocol),
      ...(agent === 'maka' ? { advertisedHost: '127.0.0.1' } : {}),
      ...(resolveProviderCredential
        ? { resolveUpstreamCredential: resolveProviderCredential }
        : { apiKeyFile: apiKeyFile! }),
      authMode: agent === 'kimi-code' ? 'bearer' : providerProxyAuthMode(provider, apiProtocol),
      usageProtocol: providerProxyUsageProtocol(agent, provider, apiProtocol),
    });
    return {
      env:
        agent === 'maka'
          ? {
              MAKA_HOST_BASE_URL: proxy.baseUrl,
              MAKA_HOST_API_KEY: proxy.token,
            }
          : {
              MAKA_PROVIDER_PROXY_URL: proxy.baseUrl,
              MAKA_PROVIDER_PROXY_TOKEN: proxy.token,
            },
      usage: proxy.usage,
      telemetry: proxy.telemetry,
      close: proxy.close,
    };
  }
  return {
    env: {
      MAKA_HOST_REPO_ROOT: options.makaRepoPath,
      ...(copilotCredential
        ? { MAKA_HOST_API_KEY: copilotCredential.accessToken }
        : options.apiKeyFile
          ? { MAKA_HOST_API_KEY_FILE: options.apiKeyFile }
          : {}),
      ...(!options.apiKeyFile && !copilotCredential ? { MAKA_HOST_NO_AUTH: 'true' } : {}),
      ...(baseUrl ? { MAKA_HOST_BASE_URL: baseUrl } : {}),
      ...(copilotCredential ? { MAKA_HOST_MODEL_API_PROTOCOL: copilotCredential.apiProtocol } : {}),
    },
  };
}

function usesHostProviderProxy(agent: HarborTaskRunnerOptions['agent']): boolean {
  return agent === 'opencode' || agent === 'kimi-code' || agent === 'codex';
}

/** Shared cost math across runners: build the cell token summary from proxy-observed usage and per-1M pricing. */
export function providerTokenSummary(
  usage: ProviderTokenUsage,
  pricing: HarborTaskPricing,
): NonNullable<HarborCellOutput['tokenSummary']> {
  const cacheMissInput = Math.max(0, usage.input - usage.cacheRead - usage.cacheWrite);
  const costUsd =
    (cacheMissInput * pricing.inputUsdPer1M +
      usage.cacheRead * (pricing.cacheReadUsdPer1M ?? pricing.inputUsdPer1M) +
      usage.cacheWrite * (pricing.cacheWriteUsdPer1M ?? pricing.inputUsdPer1M) +
      usage.output * pricing.outputUsdPer1M) /
    1_000_000;
  return {
    input: usage.input,
    output: usage.output,
    cachedInput: usage.cacheRead,
    cacheHitInput: usage.cacheRead,
    cacheMissInput,
    cacheWriteInput: usage.cacheWrite,
    cacheMissInputSource: 'explicit',
    reasoning: usage.reasoning ?? 0,
    total: usage.input + usage.output,
    costUsd,
    pricingSource: 'runtime',
  };
}

/** Match the Maka host connection's protocol authority when configuring its auth proxy. */
export function providerProxyApiProtocol(
  agent: HarborTaskRunnerOptions['agent'],
  agentEnv: Record<string, string> | undefined,
): string | undefined {
  if (agent !== 'maka') return undefined;
  return agentEnv?.MAKA_HOST_MODEL_API_PROTOCOL || agentEnv?.MAKA_MODEL_API_PROTOCOL || undefined;
}

/** OpenAI-compatible Kimi runtimes add /v1 to the advertised proxy base. */
export function providerProxyUpstreamBaseUrl(
  baseUrl: string,
  provider: string,
  apiProtocol?: string,
): string {
  if (provider !== 'kimi-coding-plan' || apiProtocol !== 'openai-chat') return baseUrl;
  const upstream = new URL(baseUrl);
  if (!/\/v1\/?$/i.test(upstream.pathname)) return baseUrl;
  upstream.pathname = upstream.pathname.replace(/\/v1\/?$/i, '') || '/';
  return upstream.toString();
}

/** Shared across runners: the selected Kimi protocol overrides its Anthropic registry default. */
export function providerProxyAuthMode(
  provider: string,
  apiProtocol?: string,
): 'bearer' | 'x-api-key' {
  if (provider === 'kimi-coding-plan' && apiProtocol === 'openai-chat') return 'bearer';
  if (provider === 'kimi-coding-plan' && apiProtocol === 'anthropic-messages') return 'x-api-key';
  const definition = (
    PROVIDER_DEFAULTS as Partial<Record<string, (typeof PROVIDER_DEFAULTS)[ProviderType]>>
  )[provider];
  return definition?.runtimeAdapter.kind === 'anthropic' &&
    definition.runtimeAdapter.auth === 'api-key'
    ? 'x-api-key'
    : 'bearer';
}

/** Shared across runners: adapter/provider registry drives the proxy's SSE usage parser. */
export function providerProxyUsageProtocol(
  agent: HarborTaskRunnerOptions['agent'],
  provider: string,
  apiProtocol?: string,
): ProviderUsageProtocol | undefined {
  if (agent === 'kimi-code') return 'openai-chat-sse';
  if (provider === 'kimi-coding-plan' && apiProtocol === 'openai-chat') return 'openai-chat-sse';
  if (provider === 'kimi-coding-plan' && apiProtocol === 'anthropic-messages')
    return 'anthropic-sse';
  const definition = (
    PROVIDER_DEFAULTS as Partial<Record<string, (typeof PROVIDER_DEFAULTS)[ProviderType]>>
  )[provider];
  if (definition?.runtimeAdapter.kind === 'anthropic') return 'anthropic-sse';
  if (definition?.runtimeAdapter.kind === 'openai-compatible') return 'openai-chat-sse';
  return undefined;
}

async function resolveGitHubCopilotHostCredential(
  githubToken: string,
  modelId: string,
  baseUrl: string,
  fetchFn?: typeof fetch,
): Promise<{
  accessToken: string;
  baseUrl: string;
  apiProtocol: 'openai-chat' | 'openai-responses' | 'anthropic-messages';
}> {
  if (!isSupportedGitHubCopilotAccountToken(githubToken)) {
    throw new Error(
      'GitHub Copilot requires a GitHub OAuth, GitHub App user, or fine-grained account token; classic PATs are not accepted',
    );
  }
  const models = await fetchGitHubCopilotModels(baseUrl, githubToken, fetchFn);
  const model = models.find(({ id }) => id === modelId);
  if (!model?.apiProtocol)
    throw new Error(`GitHub Copilot account does not expose model ${modelId}`);
  return { accessToken: githubToken, baseUrl, apiProtocol: model.apiProtocol };
}

function githubCopilotAccountTokenFromEnv(
  provider: string | undefined,
  agentEnv: Readonly<Record<string, string>> | undefined,
): string | undefined {
  if (provider !== 'github-copilot') return undefined;
  for (const name of providerCredentialEnv(provider)?.apiKeys ?? []) {
    const value = agentEnv?.[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function taskAgentEnvWithoutProviderSecrets(
  options: HarborTaskRunnerOptions,
): Record<string, string> {
  const providerEnv = providerCredentialEnv(options.provider ?? 'deepseek');
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.agentEnv ?? {})) {
    if (
      providerEnv?.apiKeys.includes(key) ||
      key === providerEnv?.apiKeyFile ||
      providerEnv?.baseUrls.includes(key)
    )
      continue;
    if (key === 'MAKA_BASE_URL') continue;
    if (isSensitiveEnvName(key)) continue;
    result[key] = value;
  }
  return result;
}

/** Shared benchmark invariant: agentEnv must never carry provider secrets. */
export function assertNoProviderSecretsInAgentEnv(
  agentEnv: Record<string, string> | undefined,
  allowedHostCredentialEnvNames: ReadonlySet<string> = new Set(),
): void {
  const forbidden = Object.keys(agentEnv ?? {}).filter(
    (key) => isSensitiveEnvName(key) && !allowedHostCredentialEnvNames.has(key),
  );
  if (forbidden.length > 0) {
    throw new Error(`agentEnv must not contain provider secrets: ${forbidden.sort().join(', ')}`);
  }
}

/** Shared benchmark invariant: attempt-level agentEnv must never override the
 * experiment's identity or pricing. Exported so the Pier runner enforces the
 * exact same key set instead of drifting on a copied list. */
export function assertNoExperimentIdentityOverrides(
  agentEnv: Record<string, string> | undefined,
): void {
  const forbidden = Object.keys(agentEnv ?? {}).filter((key) =>
    EXPERIMENT_IDENTITY_ENV_KEYS.has(key),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `agentEnv must not override experiment identity: ${forbidden.sort().join(', ')}`,
    );
  }
}

/** Shared across runners: registry-driven check whether a provider needs a
 * real credential (keyless providers like ollama/lm-studio run MAKA_HOST_NO_AUTH). */
export function providerRequiresSecret(provider: string | undefined): boolean {
  const providerType = (provider ?? 'deepseek') as ProviderType;
  const definition = PROVIDER_DEFAULTS[providerType];
  if (!definition) throw new Error(`unsupported MAKA_PROVIDER: ${provider ?? ''}`);
  return providerAuthRequiresSecret(providerType);
}

/** Shared across runners: Harbor and Pier lay out job output the same way
 * (result.json reward_stats/exception_stats trial-name hint, then a
 * task-name-prefixed directory fallback), so trial-dir discovery must not fork.
 * `harness`/`infraError` keep the thrown diagnostics naming the calling runner. */
export async function findTrialDir(
  jobDir: string,
  taskName: string,
  harness = 'harbor',
  infraError: InfraErrorCtor = HarborInfraError,
): Promise<string> {
  let entries;
  try {
    entries = await readdir(jobDir, { withFileTypes: true });
  } catch (error) {
    throw new infraError(`${harness} produced no job output at ${jobDir}`, errorText(error));
  }
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const resultTrialName = await readResultTrialName(join(jobDir, 'result.json'));
  if (resultTrialName && dirs.includes(resultTrialName)) {
    return join(jobDir, resultTrialName);
  }
  const match =
    dirs.find((name) => name === taskName || name.startsWith(`${taskName}__`)) ?? dirs[0];
  if (!match) {
    throw new infraError(
      `${harness} produced no trial directory under ${jobDir} for task ${taskName}`,
    );
  }
  return join(jobDir, match);
}

async function readResultTrialName(resultPath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(resultPath, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.stats) || !isRecord(parsed.stats.evals)) return null;
  for (const evalResult of Object.values(parsed.stats.evals)) {
    if (!isRecord(evalResult)) continue;
    const rewardStats = isRecord(evalResult.reward_stats) ? evalResult.reward_stats : null;
    const rewards =
      rewardStats && isRecord(rewardStats.reward) ? Object.values(rewardStats.reward) : [];
    for (const trialNames of rewards) {
      const trialName = firstString(trialNames);
      if (trialName) return trialName;
    }
    const exceptionStats = isRecord(evalResult.exception_stats)
      ? Object.values(evalResult.exception_stats)
      : [];
    for (const trialNames of exceptionStats) {
      const trialName = firstString(trialNames);
      if (trialName) return trialName;
    }
  }
  return null;
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first = value.find((item): item is string => typeof item === 'string');
    return first ?? null;
  }
  return null;
}

async function readReward(rewardPath: string, resultPath: string, taskId: string): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(rewardPath, 'utf8');
  } catch (error) {
    const trialException = await readTrialException(resultPath);
    if (trialException) {
      if (isBudgetExhaustedTrialException(trialException)) {
        throw new FixedPromptBudgetExhaustedError(
          `host cell budget exhausted for task ${taskId}`,
          trialException,
        );
      }
      throw new HarborInfraError(
        `Harbor trial failed before verifier reward for task ${taskId}: ${trialException}`,
        errorText(error),
      );
    }
    throw new HarborInfraError(`missing verifier reward for task ${taskId}`, errorText(error));
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new HarborInfraError(`empty verifier reward for task ${taskId}`);
  }
  const reward = Number(trimmed);
  if (!Number.isFinite(reward)) {
    throw new HarborInfraError(`non-numeric verifier reward for task ${taskId}: ${trimmed}`);
  }
  return reward;
}

/** Shared across runners: both harnesses record how the agent phase ended in
 * the trial result's `exception_info`, in the same shape. */
export async function readTrialException(
  resultPath: string,
  fallbackType = 'HarborTrialError',
): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(resultPath, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const exceptionInfo = isRecord(parsed.exception_info) ? parsed.exception_info : null;
  if (!exceptionInfo) return null;
  const type =
    typeof exceptionInfo.exception_type === 'string' ? exceptionInfo.exception_type : fallbackType;
  const message =
    typeof exceptionInfo.exception_message === 'string' ? exceptionInfo.exception_message : '';
  return message ? `${type}: ${message}` : type;
}

/** Shared across runners: the trial exceptions that mean the agent budget ran out (host cell deadline or harness AgentTimeoutError). */
export function isBudgetExhaustedTrialException(message: string): boolean {
  return (
    /^RuntimeError: Maka host cell exceeded \d+(?:\.\d+)?s$/.test(message) ||
    /^AgentTimeoutError: Agent execution timed out after \d+(?:\.\d+)? seconds$/.test(message)
  );
}

/** Shared across runners: the same adapters write the same maka-cell-output.json
 * contract into both harnesses' trial layouts. */
export async function readCellOutput(
  cellOutputPath: string,
  taskId: string,
  infraError: InfraErrorCtor = HarborInfraError,
): Promise<HarborCellOutput> {
  let raw: string;
  try {
    raw = await readFile(cellOutputPath, 'utf8');
  } catch (error) {
    throw new infraError(`maka cell did not write output for task ${taskId}`, errorText(error));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new infraError(`maka cell output is not valid JSON for task ${taskId}`, errorText(error));
  }
  try {
    return validateHarborCellOutput(parsed);
  } catch (error) {
    throw new infraError(`maka cell output is malformed for task ${taskId}`, errorText(error));
  }
}

const defaultHarborProcessRunner: HarborProcessRunner = async (request) => {
  try {
    const { stdout, stderr } = await execFileAsync(request.harborBin, [...request.args], {
      cwd: request.cwd,
      maxBuffer: 64 * 1024 * 1024,
      ...(request.timeoutMs !== undefined
        ? { timeout: request.timeoutMs, killSignal: 'SIGKILL' as const }
        : {}),
      ...(request.env ? { env: { ...process.env, ...request.env } } : {}),
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const exitCode =
      typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1;
    return {
      exitCode,
      stdout: String((error as { stdout?: unknown }).stdout ?? ''),
      stderr: String((error as { stderr?: unknown }).stderr ?? '') || errorText(error),
      timedOut: isExecFileTimeout(error),
      ...(typeof (error as { signal?: unknown }).signal === 'string'
        ? { signal: (error as { signal: string }).signal }
        : {}),
    };
  }
};

function isExecFileTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { killed?: unknown; signal?: unknown };
  return record.killed === true && record.signal === 'SIGKILL';
}

/** Shared across runners: identify FixedPromptBudgetExhaustedError across module instances. */
export function isBudgetExhaustedError(
  error: unknown,
): error is FixedPromptBudgetExhaustedErrorType {
  return (
    error instanceof FixedPromptBudgetExhaustedError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'FixedPromptBudgetExhaustedError')
  );
}

/** Strip a model's own provider prefix so the native provider receives a bare id
 * ("deepseek/deepseek-v4-flash" + provider "deepseek" -> "deepseek-v4-flash"). A
 * gateway provider keeps the slash because the prefix does not match the provider
 * ("openai-compatible" routing "anthropic/claude-sonnet-4-5"). The cell's
 * parseModelSpec preserves whatever it receives when a provider is set, so the
 * stripping must happen here. */
export function modelIdForProvider(model: string, provider: string): string {
  const prefix = `${provider}/`;
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

export function modelForOpenCode(model: string, provider: string): string {
  return model.includes('/') ? model : `${provider}/${model}`;
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

function tail(text: string, lines = 20): string {
  return text.split('\n').slice(-lines).join('\n');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
