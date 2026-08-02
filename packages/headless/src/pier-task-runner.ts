import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, delimiter, join } from 'node:path';
import { PROVIDER_DEFAULTS, type ProviderType } from '@maka/core/llm-connections';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import {
  FixedPromptBudgetExhaustedError,
  type HarborVerifierOutcome,
  type TaskRunInput,
  type TaskRunOutput,
  type TaskRunner,
} from './fixed-prompt-controller.js';
import {
  assertNoExperimentIdentityOverrides,
  assertNoProviderSecretsInAgentEnv,
  findTrialDir,
  harborTraceMode,
  hostTraceEventsPath,
  isBudgetExhaustedError,
  isBudgetExhaustedTrialException,
  mergeAgentEnv,
  modelIdForProvider,
  providerProxyApiProtocol,
  providerProxyAuthMode,
  providerProxyUpstreamBaseUrl,
  providerProxyUsageProtocol,
  providerRequiresSecret,
  providerTelemetryArtifactRefs,
  providerTokenSummary,
  readCellOutput,
  readTimedOutTrialArtifacts,
  readTrialException,
  resolveNativeTrialTimeoutMs,
  withProviderTelemetryArtifact,
  incompleteTerminalProviderRequest,
  modelForOpenCode,
  type HarborTaskPricing,
} from './harbor-task-runner.js';
import { lenientPositiveIntEnv } from './headless-run-env.js';
import {
  CODEX_TOOLCHAIN_CONTAINER_PATH,
  CODEX_TOOLCHAIN_FINGERPRINT,
  CODEX_TOOLCHAIN_SPEC,
} from './codex-toolchain.js';
import {
  KIMI_CODE_TOOLCHAIN_CONTAINER_PATH,
  KIMI_CODE_TOOLCHAIN_FINGERPRINT,
} from './kimi-code-toolchain.js';
import {
  OPENCODE_TOOLCHAIN_CONTAINER_PATH,
  OPENCODE_TOOLCHAIN_FINGERPRINT,
  OPENCODE_TOOLCHAIN_SPEC,
} from './opencode-toolchain.js';
import {
  MAKA_NODE_TOOLCHAIN_CONTAINER_PATH,
  MAKA_NODE_TOOLCHAIN_FINGERPRINT,
} from './maka-node-toolchain.js';
import {
  summarizeProviderTelemetry,
  startProviderAuthProxy,
  startProviderAuthProxyHub,
  type ProviderAuthProxyHub,
  type ProviderAuthProxyRouteInput,
  type ProviderRequestTelemetry,
  type ProviderTokenUsage,
  type ProviderUpstreamCredentialResolver,
} from './provider-auth-proxy.js';

const CONTAINER_MAKA_REPO = '/opt/maka-agent';
const TRIAL_CELL_OUTPUT = 'agent/maka-cell-output.json';
const TRIAL_RUNTIME_EVENTS = 'agent/runtime-events.jsonl';
const TRIAL_REWARD_JSON = 'verifier/reward.json';
const TRIAL_RESULT = 'result.json';
const PROVIDER_REQUEST_TELEMETRY = 'provider-request-telemetry.json';

/** The default port an in-container agent binds the host provider
 * proxy to. Pier's Squid egress for offline (`allow_internet=false`) tasks only
 * permits destination ports 80/443 (`acl Safe_ports port 80 443`), so a
 * container reaching the host proxy through Squid must present one of those.
 * 443 keeps the model endpoint on the conventional TLS port. */
export const PIER_PROVIDER_PROXY_DEFAULT_PORT = 443;
export const PIER_MAKA_SETTLEMENT_GRACE_SEC = 30;

/** Compatibility fallback for callers that do not provide a run-scoped proxy
 * hub. Such callers still bind one fixed port per attempt, so concurrent binds
 * on the same port must serialize. Benchmark runs that need concurrency share
 * one listener through `providerProxyHub` and do not enter this queue. */
const proxyPortQueues = new Map<number, Promise<unknown>>();

function withProxyPortLock<T>(port: number, fn: () => Promise<T>): Promise<T> {
  const queue = proxyPortQueues.get(port) ?? Promise.resolve();
  const run = queue.then(fn);
  proxyPortQueues.set(
    port,
    run.catch(() => {}),
  );
  return run;
}

/** A Pier-side failure (build/docker/timeout/missing artifact) — NOT a benchmark
 * result. The fixed-prompt controller turns a thrown error into an infra_failed
 * event, excluding it from scoring instead of recording reward 0.
 *
 * Deliberately separate from HarborInfraError: the controller classifies infra
 * by behavior (any thrown non-budget error), never by error identity, so
 * sharing a class buys no invariant — while a Pier failure surfacing as
 * "HarborInfraError" in diagnostics would misattribute the failing harness.
 * The telemetry-attachment helpers below stay local for the same reason: they
 * construct this runner-local error type. */
export class PierInfraError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
    readonly kind: 'infra_failed' | 'timed_out' = 'infra_failed',
    readonly artifactRefs?: { providerTelemetryPath?: string },
  ) {
    super(message);
    this.name = 'PierInfraError';
  }
}

/** Same per-1M pricing contract as the Harbor runner (shared cost math). */
export type PierTaskPricing = HarborTaskPricing;
export type PierProviderProxyHub = ProviderAuthProxyHub;

export interface PierProviderProxyHubOptions {
  providerProxyPort?: number;
  providerProxyAdvertisedHost?: string;
}

export interface PierTaskRunnerOptions {
  /** Host path to the maka repo, bind-mounted read-only at /opt/maka-agent. */
  makaRepoPath: string;
  /** Pinned Linux/x64 Node runtime mounted read-only for in-container Maka task runs. */
  makaNodeToolchainPath?: string;
  /** Pier adapter under test (default: Maka). */
  agent?: PierAgent;
  /** In-container/host cell backend. Only the Maka arm reads it. `fake` runs the
   * inert cell for zero-cost structural checks; `ai-sdk` is the real run. */
  backend?: 'ai-sdk' | 'fake';
  /** Prepared Kimi Code toolchain bind-mounted read-only into task containers. */
  kimiCodeToolchainPath?: string;
  /** Prepared Codex toolchain bind-mounted read-only into task containers. */
  codexToolchainPath?: string;
  /** Prepared OpenCode toolchain bind-mounted read-only into task containers. */
  opencodeToolchainPath?: string;
  /** Competitor CLI version, forwarded as the adapter's `version` kwarg. The
   * Codex arm requires it to match the pinned toolchain spec so the fixed
   * build under test is exactly the one fingerprinted into the manifest. */
  agentVersion?: string;
  /** Base directory under which each task gets an isolated per-task job dir. */
  jobsDir: string;
  /** MAKA_MODEL / pier `-m`, e.g. "k3" or "deepseek/deepseek-v4-flash". */
  model: string;
  /** MAKA_PROVIDER, e.g. "kimi-coding-plan". */
  provider?: string;
  reasoningEffort?: ThinkingLevel;
  /** Upstream model base URL. Falls back to the provider's registry default. */
  baseUrl?: string;
  /** Host path to an API key file. The key stays in the host control process
   * (read by the host cell, or minted into a scoped token by the proxy); the task
   * container never receives a provider key env, key-file path, or secret mount. */
  apiKeyFile?: string;
  /** Resolves the upstream authority inside the host proxy for every request. */
  resolveProviderCredential?: ProviderUpstreamCredentialResolver;
  /** Route a Maka host cell through the auth proxy instead of reading the key
   * file directly. In-container agents, including Maka task-run, always use it. */
  useProviderProxy?: boolean;
  /** Explicit host proxy listen port for an in-container agent (default 443). */
  providerProxyPort?: number;
  /** Host an in-container agent should dial to reach the host provider proxy.
   * This covers Kimi, Codex, and Maka task-run mode; a Maka host cell still uses
   * loopback (127.0.0.1). Unset keeps the default host.docker.internal, which
   * Docker Desktop injects but native Linux Docker does NOT provide (pier
   * 0.3.0's compose wires no
   * extra_hosts/host-gateway), so on native Linux pass the host's
   * docker-bridge-reachable address (e.g. 172.17.0.1) or the container's Squid
   * cannot resolve the proxy. */
  providerProxyAdvertisedHost?: string;
  /** Run-scoped fixed-port listener shared by concurrent in-container attempts.
   * Each attempt receives an independent token-routed lease, including its own
   * upstream credential resolver, usage, telemetry, and abort lifecycle. */
  providerProxyHub?: PierProviderProxyHub;
  /** Per-1M USD pricing forwarded as MAKA_TRIAL_* so the cell emits real costUsd. */
  pricing?: PierTaskPricing;
  /** Extra agent env merged last (e.g. MAKA_HARBOR_MODE). Never provider secrets. */
  agentEnv?: Record<string, string>;
  /** Pier launcher (default "pier"). */
  pierBin?: string;
  /** Pier environment type (default "docker"). Unlike Harbor, Pier's
   * EnvironmentConfig has no extra_docker_compose or platform field, so an
   * explicit Docker target platform cannot be wired through `pier run`. */
  environment?: string;
  timeoutMultiplier?: number;
  /** Wall-clock ceiling for a single `pier run`; a hung Docker/Pier would
   * otherwise stall the unattended loop forever. Defaults to pier's maximum
   * legitimate trial lifecycle (2 x build + agent + 2 x verifier task-native
   * seconds, covering pier's one-retry policy on build and verification) x
   * timeoutMultiplier plus setup/teardown grace, floored at 45 minutes —
   * shared floor+grace contract with the Harbor runner. */
  pierTimeoutMs?: number;
  /** Injectable Pier process runner (default: execFile the pier binary). */
  runPier?: PierProcessRunner;
}

/** Start the one fixed-port provider listener owned by a Pier benchmark run.
 * Runners receive the returned hub through `providerProxyHub` and issue one
 * isolated lease per attempt. */
export async function createPierProviderProxyHub(
  input: PierProviderProxyHubOptions = {},
): Promise<PierProviderProxyHub> {
  return await startProviderAuthProxyHub({
    port: input.providerProxyPort ?? PIER_PROVIDER_PROXY_DEFAULT_PORT,
    ...(input.providerProxyAdvertisedHost
      ? { advertisedHost: input.providerProxyAdvertisedHost }
      : {}),
  });
}

export interface PierRunRequest {
  pierBin: string;
  jobName: string;
  jobsDir: string;
  args: readonly string[];
  cwd: string;
  /** Wall-clock ceiling in ms; the default runner kills pier past this. */
  timeoutMs?: number;
  /** Env overlaid onto the pier process: PYTHONPATH, MAKA_BACKEND (the adapter's
   * CliFlag env_fallback reads only os.environ), and MAKA_SYSTEM_PROMPT (byte-
   * exact; pier's --ae parser would strip its whitespace). */
  env?: Record<string, string>;
  /** SIGTERM-to-SIGKILL grace once the watchdog fires (default 120s: pier's
   * SIGTERM-triggered finally chain must finish docker compose teardown). */
  terminationGraceMs?: number;
}

export interface PierRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  signal?: string;
}

export type PierProcessRunner = (request: PierRunRequest) => Promise<PierRunResult>;

export type PierAgent = 'maka' | 'kimi-code' | 'codex' | 'opencode';

interface PierProviderRuntime {
  /** Proxy-minted secret env delivered via `--env-file` (kept off argv). */
  envFile: Record<string, string>;
  /** Non-secret host env delivered via `--ae` (paths, base URLs). */
  agentEnv: Record<string, string>;
  usage?: () => ProviderTokenUsage | null;
  telemetry?: () => ProviderRequestTelemetry[];
  close?: () => Promise<void>;
}

export function createPierTaskRunner(options: PierTaskRunnerOptions): TaskRunner {
  if (options.agent === 'codex' && options.agentVersion !== CODEX_TOOLCHAIN_SPEC.codex.version) {
    throw new Error(
      `Codex adapter version must match toolchain version ${CODEX_TOOLCHAIN_SPEC.codex.version}`,
    );
  }
  if (
    options.agent === 'opencode' &&
    options.agentVersion !== OPENCODE_TOOLCHAIN_SPEC.opencode.version
  ) {
    throw new Error(
      `OpenCode adapter version must match toolchain version ${OPENCODE_TOOLCHAIN_SPEC.opencode.version}`,
    );
  }
  const runPier = options.runPier ?? defaultPierProcessRunner;
  const pierBin = options.pierBin ?? 'pier';
  // The bare adapter import path (`maka_agent:MakaAgent`) resolves only when the
  // adapter directory is on pier's PYTHONPATH; pier is a uv-installed tool, so its
  // cwd is not enough. Prepend it, keeping any inherited PYTHONPATH.
  const harborAdapterDir = join(options.makaRepoPath, 'packages', 'headless', 'harbor');
  const pythonPath = [harborAdapterDir, process.env.PYTHONPATH].filter(Boolean).join(delimiter);

  const runner: TaskRunner = async (input: TaskRunInput): Promise<TaskRunOutput> => {
    const agent = options.agent ?? 'maka';
    const timeoutMultiplier = options.timeoutMultiplier ?? 1;
    const taskAgentTimeoutSec = input.task.metadata?.agentTimeoutSec;
    const attemptAgentEnv = mergeAgentEnv(options.agentEnv, input.agentEnv);
    const traceMode = harborTraceMode(attemptAgentEnv);
    const makaDeadline =
      agent === 'maka' &&
      traceMode === 'task-run' &&
      timeoutMultiplier === 1 &&
      taskAgentTimeoutSec !== undefined
        ? {
            modelBudgetSec: taskAgentTimeoutSec,
            settlementGraceSec: PIER_MAKA_SETTLEMENT_GRACE_SEC,
            phaseTimeoutSec: taskAgentTimeoutSec + PIER_MAKA_SETTLEMENT_GRACE_SEC,
          }
        : undefined;
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

    assertNoProviderSecretsInAgentEnv(attemptAgentEnv);
    // Same benchmark invariant as the Harbor runner (shared implementation):
    // agentEnv must not override experiment identity or MAKA_TRIAL_* pricing.
    assertNoExperimentIdentityOverrides(attemptAgentEnv);

    const providerTelemetryPath = join(jobsDir, PROVIDER_REQUEST_TELEMETRY);
    let providerUsage: ProviderTokenUsage | null = null;
    let providerTelemetry: ProviderRequestTelemetry[] = [];
    const envFilePath = join(jobsDir, 'pier-agent.env');
    // Config errors fail fast before the proxy exists (and outside the port lock).
    const mounts = buildPierMounts(options, agent, traceMode);
    const launchAttempt = async (): Promise<PierRunResult> => {
      // Proxy bind errors surface raw, before the launch try, with their own
      // message — they are configuration faults, not infra flakes.
      const providerRuntime = await pierProviderRuntime(
        { ...options, agentEnv: attemptAgentEnv },
        agent,
        traceMode,
      );
      const envFileEntries = providerRuntime?.envFile ?? {};
      const usesEnvFile = Object.keys(envFileEntries).length > 0;
      try {
        // Everything from here until runPier returns lives under one finally that
        // closes the proxy: a failure in this window (env-file write, arg
        // assembly) must not leak the listening socket.
        try {
          const aeEnv = buildPierAgentEnv(
            input,
            options,
            agent,
            providerRuntime?.agentEnv ?? {},
            makaDeadline,
          );
          const processEnv: Record<string, string> = {
            PYTHONPATH: pythonPath,
            // MAKA_BACKEND is a CliFlag whose env_fallback reads os.environ only, so
            // `--ae MAKA_BACKEND=` is silently ignored — it must ride the pier process
            // env. The Kimi adapter ignores it.
            MAKA_BACKEND: options.backend ?? 'ai-sdk',
            // Byte-safe channel for the prompt: pier's --ae parser strips leading and
            // trailing whitespace from values (pier/cli/utils.py key.strip() /
            // value.strip()), which would drop the prompt's trailing newline and break
            // the execution-identity hash round-trip on every task. Both adapters fall
            // back to os.environ (CliFlag env_fallback for Maka, _get_env for Kimi) and
            // forward the exact bytes into the cell, so the value rides the pier
            // process env verbatim — and must never also appear in --ae, where the
            // stripped extra_env copy would take precedence in _get_env.
            MAKA_SYSTEM_PROMPT: input.systemPrompt,
          };
          if (usesEnvFile) await writeEnvFile(envFilePath, envFileEntries);
          const args = buildPierRunArgs({
            agent,
            // Provider-local bare id for the Maka/Kimi/Codex arms (same
            // normalization contract as the Harbor runner); OpenCode instead
            // requires the provider/model form its adapter splits on.
            model:
              agent === 'opencode'
                ? modelForOpenCode(options.model, options.provider ?? 'deepseek')
                : modelIdForProvider(options.model, options.provider ?? 'deepseek'),
            taskPath: input.task.path,
            jobsDir,
            jobName,
            environment: options.environment ?? 'docker',
            timeoutMultiplier,
            ...(makaDeadline
              ? {
                  agentTimeoutMultiplier:
                    makaDeadline.phaseTimeoutSec / makaDeadline.modelBudgetSec,
                }
              : {}),
            mounts,
            agentEnv: aeEnv,
            ...(usesEnvFile ? { envFile: envFilePath } : {}),
            // Constructor kwargs ride `--ak`; env cannot carry them. The Codex
            // adapter pins its CLI build via `version` and forwards the effort
            // as the `-c model_reasoning_effort` CLI flag descriptor.
            ...(agent === 'codex'
              ? {
                  agentKwargs: {
                    version: options.agentVersion!,
                    ...(options.reasoningEffort
                      ? { reasoning_effort: options.reasoningEffort }
                      : {}),
                  },
                }
              : agent === 'opencode'
                ? {
                    // OpenCode pins its CLI build the same way so trial
                    // provenance records the fingerprinted version instead of
                    // 'unknown'; its reasoning variant rides --ae instead.
                    agentKwargs: { version: options.agentVersion! },
                  }
                : {}),
          });
          return await runPier({
            pierBin,
            jobName,
            jobsDir,
            args,
            cwd: harborAdapterDir,
            // Task-aware watchdog (shared Harbor floor+grace contract, fed with
            // pier's complete lifecycle model): a fixed 45-minute default would
            // systematically undercut DeepSWE's native budgets.
            timeoutMs:
              options.pierTimeoutMs ??
              resolveNativeTrialTimeoutMs({
                nativePhasesSec:
                  pierMaxTrialPhasesSec(input.task.metadata) +
                  (makaDeadline?.settlementGraceSec ?? 0),
                timeoutMultiplier,
              }),
            env: processEnv,
          });
        } finally {
          await providerRuntime?.close?.();
          if (usesEnvFile) await rm(envFilePath, { force: true });
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
        throw new PierInfraError(
          `pier run failed to launch for task ${input.task.id}`,
          errorText(error),
          'infra_failed',
          providerTelemetryArtifactRefs(providerTelemetry, providerTelemetryPath),
        );
      }
    };
    // Only an in-container agent on a FIXED port competes for the bind; a Maka
    // host cell and an explicit port 0 (OS-assigned, used by tests) cannot
    // collide and need no serialization.
    const containerProxyPort = options.providerProxyPort ?? PIER_PROVIDER_PROXY_DEFAULT_PORT;
    const usesContainerProxy = agent !== 'maka' || traceMode === 'task-run';
    const result =
      usesContainerProxy && !options.providerProxyHub && containerProxyPort !== 0
        ? await withProxyPortLock(containerProxyPort, launchAttempt)
        : await launchAttempt();

    try {
      if (result.timedOut) {
        throw new PierInfraError(
          `pier run timed out for task ${input.task.id}`,
          tail(result.stderr || result.stdout),
          'timed_out',
        );
      }
      let trialDir: string;
      try {
        trialDir = await findTrialDir(jobDir, basename(input.task.path), 'pier', PierInfraError);
      } catch (error) {
        if (result.exitCode === 0) throw error;
        throw new PierInfraError(
          `pier run exited ${result.exitCode} for task ${input.task.id}`,
          tail(result.stderr || result.stdout),
        );
      }

      // A populated `exception_info` records how the agent phase ended, NOT
      // whether the trial was graded: pier's trial.py records the exception and
      // then unconditionally runs verification, so an exceptional trial can
      // still carry an authoritative reward. Mirror Harbor's authority order
      // exactly: an ungraded budget exhaustion is a budget_exhausted outcome;
      // every other exception falls through to the normal reward/cell reads —
      // a graded trial scores on its actual reward (e.g. a non-zero Kimi CLI
      // exit the verifier still passed), and missing artifacts become infra
      // there, with the trial exception attached for diagnosis.
      const trialException = await readTrialException(
        join(trialDir, TRIAL_RESULT),
        'PierTrialError',
      );
      let completeTimedOutTrial = false;
      if (trialException && isBudgetExhaustedTrialException(trialException)) {
        const [grade, cellArtifact] = await Promise.all([
          readPierGrade(trialDir, input.task.id),
          readOptionalText(join(trialDir, TRIAL_CELL_OUTPUT)),
        ]);
        // Budget-gate context, distinct from the graded read path: the agent has
        // already exhausted its budget, which is the authoritative fact. A
        // verifier that crashed or wrote a corrupt reward here does NOT overturn
        // it — an `invalid` grade is treated exactly like `ungraded` / a missing
        // reward file, yielding budget_exhausted (no retry, Pass@1 evidence
        // preserved) rather than an infra failure the controller would retry. In
        // the graded read path a corrupt scoring authority IS infra; only when
        // the budget is already spent does the agent fact take precedence.
        if (grade.state !== 'graded' || cellArtifact === null) {
          // Recover attested evidence (identity/usage/cell output) via the shared
          // Harbor implementation so a budget-exhausted sample keeps its Pass@1
          // eligibility instead of being excluded as missing_execution_identity.
          const artifactRefs = await readTimedOutTrialArtifacts(
            trialDir,
            input.task.id,
            agent,
            harborTraceMode(attemptAgentEnv),
          );
          throw new FixedPromptBudgetExhaustedError(
            `agent budget exhausted for task ${input.task.id}`,
            // Carry the invalid-grade detail alongside the exhaustion cause so a
            // corrupt/crashed verifier is still diagnosable, without letting it
            // count toward the score.
            grade.state === 'invalid' ? `${trialException}; ${grade.detail}` : trialException,
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
        throw new PierInfraError(
          `pier run exited ${result.exitCode} for task ${input.task.id}`,
          tail(result.stderr || result.stdout),
        );
      }
      // Same terminal-stream contract as the Harbor runner: a non-completing
      // last provider request is infra, never a graded model failure.
      const terminalProviderRequest = incompleteTerminalProviderRequest(
        providerTelemetry,
        completeTimedOutTrial,
      );
      if (terminalProviderRequest) {
        throw new PierInfraError(
          `terminal provider request did not complete for task ${input.task.id}`,
          [
            `outcome=${terminalProviderRequest.outcome}`,
            terminalProviderRequest.status !== undefined
              ? `status=${terminalProviderRequest.status}`
              : undefined,
          ]
            .filter(Boolean)
            .join(', '),
          'infra_failed',
          { providerTelemetryPath },
        );
      }

      const reward = await readPierReward(trialDir, input.task.id, trialException);
      const rawCell = await readCellOutput(
        join(trialDir, TRIAL_CELL_OUTPUT),
        input.task.id,
        PierInfraError,
      );
      const cell =
        rawCell.tokenSummary || !providerUsage || !options.pricing
          ? rawCell
          : { ...rawCell, tokenSummary: providerTokenSummary(providerUsage, options.pricing) };
      const hostEventsPath = join(trialDir, TRIAL_RUNTIME_EVENTS);
      // Pier's verifier grading is the scoring authority. Surface it as the
      // structured verifier outcome the controller requires: without it a
      // graded failed cell (max_tokens / tool_step_cap_reached / policy_denied)
      // is never verifierGraded and drops out of the benchmark denominator as
      // scored=false. The outcome is derived from the reward itself, so unlike
      // Harbor's independently-written oracle artifact it cannot disagree.
      const verifier = pierVerifierOutcome(
        reward,
        await readVerifierDurationMs(join(trialDir, TRIAL_RESULT)),
      );
      return {
        harbor: { reward, verifier },
        cell: {
          ...cell,
          ...(providerTelemetry.length > 0 ? { providerTelemetryPath } : {}),
          runtimeEventsPath: hostEventsPath,
          // Shared Harbor resolution: cell mode prefers the maka-storage
          // session events (the rich trace with tool_failed /
          // provider_request_captured), task-run mode the combined trace, and
          // only then the raw runtime events — same layouts, same adapters.
          traceEventsPath: hostTraceEventsPath(
            agent,
            harborTraceMode(attemptAgentEnv),
            trialDir,
            cell,
            hostEventsPath,
          ),
        },
      };
    } catch (error) {
      throw withProviderTelemetryArtifact(
        error,
        providerTelemetry,
        providerTelemetryPath,
        PierInfraError,
      );
    }
  };
  return runner;
}

export interface BuildPierRunArgsInput {
  agent: PierAgent;
  model: string;
  taskPath: string;
  jobsDir: string;
  jobName: string;
  environment: string;
  timeoutMultiplier: number;
  agentTimeoutMultiplier?: number;
  mounts: ReadonlyArray<Record<string, unknown>>;
  agentEnv: Record<string, string>;
  envFile?: string;
  /** Adapter constructor kwargs forwarded as `--ak key=value`. */
  agentKwargs?: Record<string, string>;
}

/** Assemble the `pier run` argv. Exported for deterministic unit tests. */
export function buildPierRunArgs(input: BuildPierRunArgsInput): string[] {
  const importPath =
    input.agent === 'kimi-code'
      ? 'kimi_code_agent:MakaKimiCodeAgent'
      : input.agent === 'codex'
        ? 'codex_agent:MakaCodexAgent'
        : input.agent === 'opencode'
          ? 'opencode_agent:MakaOpenCodeAgent'
          : 'maka_agent:MakaAgent';
  const args = [
    'run',
    '--agent-import-path',
    importPath,
    '-m',
    input.model,
    '-p',
    input.taskPath,
    '-o',
    input.jobsDir,
    '--job-name',
    input.jobName,
    // -k attempts / -n concurrent: one attempt, one trial — Pass@1 semantics.
    '-k',
    '1',
    '-n',
    '1',
    '--timeout-multiplier',
    String(input.timeoutMultiplier),
    '-e',
    input.environment,
    '--mounts-json',
    JSON.stringify(input.mounts),
    '--yes',
    '--quiet',
  ];
  if (input.agentTimeoutMultiplier !== undefined) {
    args.push('--agent-timeout-multiplier', String(input.agentTimeoutMultiplier));
  }
  if (input.envFile) args.push('--env-file', input.envFile);
  for (const [key, value] of Object.entries(input.agentKwargs ?? {})) {
    args.push('--ak', `${key}=${value}`);
  }
  for (const [key, value] of Object.entries(input.agentEnv)) {
    args.push('--ae', `${key}=${value}`);
  }
  return args;
}

function buildPierMounts(
  options: PierTaskRunnerOptions,
  agent: PierAgent,
  mode: 'cell' | 'task-run',
): Array<Record<string, unknown>> {
  const mounts: Array<Record<string, unknown>> = [
    { type: 'bind', source: options.makaRepoPath, target: CONTAINER_MAKA_REPO, read_only: true },
  ];
  if (agent === 'maka' && mode === 'task-run') {
    if (!options.makaNodeToolchainPath) {
      throw new Error('makaNodeToolchainPath is required for Maka container task-run mode');
    }
    mounts.push({
      type: 'bind',
      source: options.makaNodeToolchainPath,
      target: MAKA_NODE_TOOLCHAIN_CONTAINER_PATH,
      read_only: true,
    });
  }
  if (agent === 'kimi-code') {
    if (!options.kimiCodeToolchainPath) {
      throw new Error('kimiCodeToolchainPath is required for the Kimi Code adapter');
    }
    mounts.push({
      type: 'bind',
      source: options.kimiCodeToolchainPath,
      target: KIMI_CODE_TOOLCHAIN_CONTAINER_PATH,
      read_only: true,
    });
  }
  if (agent === 'codex') {
    if (!options.codexToolchainPath) {
      throw new Error('codexToolchainPath is required for the Codex adapter');
    }
    mounts.push({
      type: 'bind',
      source: options.codexToolchainPath,
      target: CODEX_TOOLCHAIN_CONTAINER_PATH,
      read_only: true,
    });
  }
  if (agent === 'opencode') {
    if (!options.opencodeToolchainPath) {
      throw new Error('opencodeToolchainPath is required for the OpenCode adapter');
    }
    mounts.push({
      type: 'bind',
      source: options.opencodeToolchainPath,
      target: OPENCODE_TOOLCHAIN_CONTAINER_PATH,
      read_only: true,
    });
  }
  return mounts;
}

function buildPierAgentEnv(
  input: TaskRunInput,
  options: PierTaskRunnerOptions,
  agent: PierAgent,
  providerAgentEnv: Record<string, string>,
  makaDeadline?: {
    modelBudgetSec: number;
    settlementGraceSec: number;
    phaseTimeoutSec: number;
  },
): Record<string, string> {
  const provider = options.provider ?? 'deepseek';
  const makaModel = modelIdForProvider(options.model, provider);
  const env: Record<string, string> = {
    MAKA_MODEL: makaModel,
    MAKA_PROVIDER: provider,
    MAKA_LLM_CONNECTION_SLUG: provider,
    MAKA_AGENT_TOOLS: input.config.agentTools === true ? 'true' : 'false',
    MAKA_REPO_ROOT: CONTAINER_MAKA_REPO,
    // MAKA_SYSTEM_PROMPT deliberately does NOT ride --ae: pier's CLI strips
    // whitespace from --ae values, and a stripped copy in the adapter's
    // extra_env would shadow the byte-exact os.environ value. See processEnv.
  };
  if (options.reasoningEffort) env.MAKA_REASONING_EFFORT = options.reasoningEffort;
  if (agent === 'maka' && options.makaNodeToolchainPath) {
    env.MAKA_NODE_TOOLCHAIN_FINGERPRINT = MAKA_NODE_TOOLCHAIN_FINGERPRINT;
  }
  if (agent === 'kimi-code') {
    env.MAKA_KIMI_CODE_TOOLCHAIN_FINGERPRINT = KIMI_CODE_TOOLCHAIN_FINGERPRINT;
  }
  if (agent === 'codex') {
    env.MAKA_CODEX_TOOLCHAIN_FINGERPRINT = CODEX_TOOLCHAIN_FINGERPRINT;
  }
  if (agent === 'opencode') {
    env.MAKA_OPENCODE_TOOLCHAIN_FINGERPRINT = OPENCODE_TOOLCHAIN_FINGERPRINT;
    if (options.reasoningEffort) env.MAKA_OPENCODE_VARIANT = options.reasoningEffort;
  }
  if (options.pricing) {
    env.MAKA_TRIAL_INPUT_USD_PER_1M = String(options.pricing.inputUsdPer1M);
    env.MAKA_TRIAL_OUTPUT_USD_PER_1M = String(options.pricing.outputUsdPer1M);
    if (options.pricing.cacheReadUsdPer1M !== undefined) {
      env.MAKA_TRIAL_CACHE_READ_USD_PER_1M = String(options.pricing.cacheReadUsdPer1M);
    }
    if (options.pricing.cacheWriteUsdPer1M !== undefined) {
      env.MAKA_TRIAL_CACHE_WRITE_USD_PER_1M = String(options.pricing.cacheWriteUsdPer1M);
    }
    if (options.pricing.source) env.MAKA_TRIAL_PRICING_SOURCE = options.pricing.source;
  }
  Object.assign(env, providerAgentEnv);
  Object.assign(env, mergeAgentEnv(options.agentEnv, input.agentEnv) ?? {});
  if (makaDeadline) {
    env.MAKA_CELL_TIMEOUT_SEC = String(makaDeadline.modelBudgetSec);
    env.MAKA_CELL_SETTLEMENT_GRACE_SEC = String(makaDeadline.settlementGraceSec);
    env.MAKA_AGENT_PHASE_TIMEOUT_SEC = String(makaDeadline.phaseTimeoutSec);
  }
  // Lenient by shared contract with the Python adapter: a malformed value must
  // fall back to the task metadata rather than fail the run.
  const cellTimeoutSec =
    lenientPositiveIntEnv(env.MAKA_CELL_TIMEOUT_SEC) ?? input.task.metadata?.agentTimeoutSec;
  if (cellTimeoutSec !== undefined) {
    env.MAKA_CELL_TIMEOUT_SEC = String(cellTimeoutSec);
    const streamTimeoutMs = cellTimeoutSec * 1_000;
    if (agent === 'maka' && Number.isSafeInteger(streamTimeoutMs)) {
      // Pier already owns the task-native hard deadline. Keep the runtime's
      // first-event and between-event watchdogs from imposing a shorter cutoff.
      env.MAKA_STREAM_CONNECT_TIMEOUT_MS = String(streamTimeoutMs);
      env.MAKA_STREAM_IDLE_TIMEOUT_MS = String(streamTimeoutMs);
    }
  }
  return env;
}

async function pierProviderRuntime(
  options: PierTaskRunnerOptions,
  agent: PierAgent,
  mode: 'cell' | 'task-run',
): Promise<PierProviderRuntime | null> {
  const provider = options.provider ?? 'deepseek';
  const baseUrl = options.baseUrl ?? providerDefaultBaseUrl(provider);
  const makaContainerTaskRun = agent === 'maka' && mode === 'task-run';
  // A resolver-backed credential (e.g. Codex OAuth) is only usable through the
  // proxy — same contract as the Harbor runner — so it forces the proxy path
  // even when the caller forgot useProviderProxy.
  const usesProxy =
    agent !== 'maka' ||
    (makaContainerTaskRun && options.backend !== 'fake') ||
    options.useProviderProxy === true ||
    options.resolveProviderCredential !== undefined;

  if (!usesProxy) {
    if (agent !== 'maka') return null;
    // The fake backend runs the inert in-container cell with no host-side
    // provider runtime at all — the zero-cost structural path the live e2e
    // evidence depends on. Never wire MAKA_HOST_* for it.
    if (options.backend === 'fake') return null;
    if (!options.apiKeyFile) {
      // Mirror the Harbor runner's predicate: a keyless-ready provider
      // (registry authKind 'none' — ollama, lm-studio, localai) runs the host
      // cell with MAKA_HOST_NO_AUTH; a secret-requiring provider without a key
      // stays unconfigured so the adapter fails loud at environment creation
      // instead of the cell dialing the API with an empty credential.
      if (providerRequiresSecret(provider)) return null;
      return {
        envFile: {},
        agentEnv: {
          MAKA_HOST_REPO_ROOT: options.makaRepoPath,
          MAKA_HOST_NO_AUTH: 'true',
          ...(baseUrl ? { MAKA_HOST_BASE_URL: baseUrl } : {}),
        },
      };
    }
    // Direct host-side key file: the host cell reads the real key from the
    // file path. The path (not the key) rides `--ae`; the container stays
    // offline and never sees a key. No proxy, so no token metering.
    return {
      envFile: {},
      agentEnv: {
        MAKA_HOST_REPO_ROOT: options.makaRepoPath,
        MAKA_HOST_API_KEY_FILE: options.apiKeyFile,
        ...(baseUrl ? { MAKA_HOST_BASE_URL: baseUrl } : {}),
      },
    };
  }

  if (!options.apiKeyFile && !options.resolveProviderCredential) {
    throw new Error(
      `${agent} Pier runs require apiKeyFile or resolveProviderCredential to mint the proxy credential`,
    );
  }
  if (!baseUrl) throw new Error(`Pier ${agent} provider ${provider} requires a base URL`);

  const proxyPort =
    agent !== 'maka' || makaContainerTaskRun
      ? (options.providerProxyPort ?? PIER_PROVIDER_PROXY_DEFAULT_PORT)
      : undefined;
  // A Maka host cell reaches the proxy on loopback. In-container agents reach
  // it through Docker's host gateway on a Squid-legal port, defaulting to
  // host.docker.internal unless native Linux supplies an explicit bridge host.
  const advertisedHost =
    agent === 'maka' && !makaContainerTaskRun ? '127.0.0.1' : options.providerProxyAdvertisedHost;
  const apiProtocol = providerProxyApiProtocol(agent, options.agentEnv);
  const routeInput: ProviderAuthProxyRouteInput = {
    upstreamBaseUrl: providerProxyUpstreamBaseUrl(baseUrl, provider, apiProtocol),
    ...(options.resolveProviderCredential
      ? { resolveUpstreamCredential: options.resolveProviderCredential }
      : { apiKeyFile: options.apiKeyFile! }),
    authMode: agent === 'kimi-code' ? 'bearer' : providerProxyAuthMode(provider, apiProtocol),
    usageProtocol: providerProxyUsageProtocol(agent, provider, apiProtocol),
  };
  const proxy =
    options.providerProxyHub && proxyPort !== undefined
      ? options.providerProxyHub.issue(routeInput)
      : await startProviderAuthProxy({
          ...routeInput,
          ...(advertisedHost !== undefined ? { advertisedHost } : {}),
          ...(proxyPort !== undefined ? { port: proxyPort } : {}),
        });

  return {
    // Proxy-minted, scoped, ephemeral token — never the real provider key. Routed
    // through `--env-file` (0600, removed after the run) so it stays off argv.
    envFile:
      agent === 'maka'
        ? makaContainerTaskRun
          ? {
              MAKA_PROVIDER_PROXY_URL: proxy.baseUrl,
              MAKA_PROVIDER_PROXY_TOKEN: proxy.token,
            }
          : {
              MAKA_HOST_REPO_ROOT: options.makaRepoPath,
              MAKA_HOST_BASE_URL: proxy.baseUrl,
              MAKA_HOST_API_KEY: proxy.token,
            }
        : { MAKA_PROVIDER_PROXY_URL: proxy.baseUrl, MAKA_PROVIDER_PROXY_TOKEN: proxy.token },
    agentEnv: {},
    usage: proxy.usage,
    telemetry: proxy.telemetry,
    close: proxy.close,
  };
}

function providerDefaultBaseUrl(provider: string): string | undefined {
  const definition = (
    PROVIDER_DEFAULTS as Partial<Record<string, (typeof PROVIDER_DEFAULTS)[ProviderType]>>
  )[provider];
  return definition?.baseUrl;
}

async function writeEnvFile(path: string, env: Record<string, string>): Promise<void> {
  // dotenv KEY=VALUE lines. Values here are minted/scoped proxy tokens and URLs,
  // never the real provider key; the file is created 0600 and removed after run.
  const body = Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  await writeFile(path, `${body}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
}

/** Pier's agent_setup phase budget (pier/trial/trial.py:176
 * `_AGENT_SETUP_TIMEOUT_SEC = 360.0`); like the other phases it is scaled by
 * the timeout multiplier (pier/trial/execution.py:129-143). */
const PIER_AGENT_SETUP_TIMEOUT_SEC = 360;

/** Pier's maximum legitimate trial lifecycle in task-native seconds. Owns the
 * COMPLETE pier phase-and-retry model in one place — never patch phases in
 * piecemeal. Pier runs environment build, then agent setup, then the agent
 * once, then the verifier, and retries two of those phases once on their
 * timeout errors (tenacity `stop_after_attempt(2)`: `start_environment` in
 * pier/trial/execution.py:208 on EnvironmentStartTimeoutError, and
 * `_verify_with_retry` in pier/trial/trial.py:333 on VerifierTimeoutError), so
 * the legitimate ceiling is 2 x build + setup + agent + 2 x verifier. For
 * DeepSWE (build 1800s, setup 360s, agent 5400s, verifier 1800s) that is
 * 12960s — a derivation missing any phase or retry would let the watchdog
 * kill legitimate trials as infra. */
function pierMaxTrialPhasesSec(metadata: TaskRunInput['task']['metadata']): number {
  return (
    2 * (metadata?.buildTimeoutSec ?? 0) +
    PIER_AGENT_SETUP_TIMEOUT_SEC +
    (metadata?.agentTimeoutSec ?? 0) +
    2 * (metadata?.verifierTimeoutSec ?? 0)
  );
}

/** Single-attempt structured outcome from Pier's scoring authority, aligned
 * with the HarborVerifierOutcome contract the fixed-prompt controller consumes.
 * Harbor reads this from the Maka oracle verifier's own JSON artifact; Pier has
 * no such artifact, so the outcome is constructed from the graded reward. */
function pierVerifierOutcome(reward: number, durationMs: number): HarborVerifierOutcome {
  const passed = reward > 0;
  return {
    outcome: passed ? 'passed' : 'failed',
    attempts: [
      {
        attempt: 1,
        classification: passed ? 'passed' : 'failed',
        durationMs,
        reward,
      },
    ],
  };
}

async function readVerifierDurationMs(resultPath: string): Promise<number> {
  const result = await readOptionalJson(resultPath);
  const phase = result && isRecord(result.verifier) ? result.verifier : null;
  const started = typeof phase?.started_at === 'string' ? Date.parse(phase.started_at) : Number.NaN;
  const finished =
    typeof phase?.finished_at === 'string' ? Date.parse(phase.finished_at) : Number.NaN;
  return Number.isFinite(started) && Number.isFinite(finished) && finished >= started
    ? finished - started
    : 0;
}

/** The trial's grading state, read as ONE discriminated value from both
 * persisted mirrors of Pier's scoring authority. Callers interpret it per
 * context (a corrupt authority is infra when reading a grade, but does not
 * overturn an already-exhausted agent budget at the budget gate), so the read
 * itself never throws — there is exactly one place that decides what each
 * state means for each context.
 *
 *  - `graded`: an authoritative binary 0/1 reward. Either reward.json carried
 *    it and the trial result mirror (verifier_result.rewards.reward), if
 *    present, agreed; or reward.json was absent/empty and the result mirror
 *    carried it.
 *  - `ungraded`: neither mirror carried a numeric reward (the trial was never
 *    graded).
 *  - `invalid`: the grading authority existed but cannot be trusted as a grade
 *    — reward.json is not valid JSON, or is valid JSON with no finite numeric
 *    reward field, or a value is the crash sentinel / violates the binary 0/1
 *    contract, or the two mirrors both carried a value and disagree. */
type PierGrade =
  | { readonly state: 'graded'; readonly reward: number }
  | { readonly state: 'ungraded' }
  | { readonly state: 'invalid'; readonly detail: string };

/** Read both persisted mirrors of Pier's scoring authority and reduce them to a
 * single discriminated grade. Prefers the DeepSWE task verifier's reward.json,
 * cross-checking it against the trial result's verifier_result.rewards.reward
 * (same value on a completed trial); when reward.json is absent or empty the
 * result mirror stands alone. Unlike the Maka oracle verifier, Pier tasks write
 * no structured maka-verifier-outcome.json. */
async function readPierGrade(trialDir: string, taskId: string): Promise<PierGrade> {
  const rewardJsonText = await readOptionalText(join(trialDir, TRIAL_REWARD_JSON));
  let rewardJsonValue: number | null = null;
  // An empty file is treated as absent (never written); a non-empty reward.json
  // is the grading authority and, if it cannot be read as a numeric reward, is
  // infra — the authority existed and cannot be trusted.
  if (rewardJsonText && rewardJsonText.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rewardJsonText);
    } catch (error) {
      return {
        state: 'invalid',
        detail: `verifier reward.json is not valid JSON for task ${taskId}: ${errorText(error)}`,
      };
    }
    if (isRecord(parsed) && typeof parsed.reward === 'number' && Number.isFinite(parsed.reward)) {
      rewardJsonValue = parsed.reward;
    } else {
      return {
        state: 'invalid',
        detail: `verifier reward.json for task ${taskId} has no valid numeric reward field; a corrupt reward.json is infra — the grading authority existed and cannot be read`,
      };
    }
  }
  const result = await readOptionalJson(join(trialDir, TRIAL_RESULT));
  const verifierResult = isRecord(result?.verifier_result) ? result.verifier_result : undefined;
  const rewards =
    verifierResult && isRecord(verifierResult.rewards) ? verifierResult.rewards : undefined;
  const resultValue =
    rewards && typeof rewards.reward === 'number' && Number.isFinite(rewards.reward)
      ? rewards.reward
      : null;

  if (rewardJsonValue !== null && resultValue !== null && rewardJsonValue !== resultValue) {
    return {
      state: 'invalid',
      detail: `verifier reward mirrors disagree for task ${taskId}: ${TRIAL_REWARD_JSON} reward ${rewardJsonValue} != ${TRIAL_RESULT} verifier_result.rewards.reward ${resultValue}; the two persisted mirrors of the grading authority must be identical`,
    };
  }
  const value = rewardJsonValue ?? resultValue;
  if (value === null) return { state: 'ungraded' };
  return classifyPierReward(value, taskId);
}

/** DeepSWE's grading contract is BINARY: grader.py documents the main reward
 * as exactly 0 or 1 ("reward binary 0/1"). -1 is the verifier CRASH sentinel —
 * every task's tests/test.sh traps EXIT with `echo -1 > reward.txt` when the
 * verifier died before writing any reward file, grader.py documents that path
 * as "an infrastructure error", and pier's verifier parses reward.txt verbatim
 * into verifier_result.rewards.reward. Any other value (0.5, 2, ...) can only
 * come from corrupt or non-contract verifier output. Recording either as a
 * grade would poison the benchmark: a sentinel as a scored failure, a
 * fractional value as a pass (`reward > 0`). */
function classifyPierReward(reward: number, taskId: string): PierGrade {
  if (reward === 0 || reward === 1) return { state: 'graded', reward };
  if (reward < 0) {
    return {
      state: 'invalid',
      detail: `verifier crashed for task ${taskId}: reward ${reward} is the DeepSWE test.sh crash sentinel, not a grade`,
    };
  }
  return {
    state: 'invalid',
    detail: `verifier reward ${reward} for task ${taskId} violates the DeepSWE binary 0/1 contract (grader.py); treating as infra, not a grade`,
  };
}

/** Graded read path (normal completion and non-budget exception fall-through):
 * the scoring authority is authoritative here, so an invalid grade IS infra. */
async function readPierReward(
  trialDir: string,
  taskId: string,
  trialException: string | null,
): Promise<number> {
  const grade = await readPierGrade(trialDir, taskId);
  if (grade.state === 'graded') return grade.reward;
  if (grade.state === 'invalid') throw new PierInfraError(grade.detail);
  // ungraded — mirror Harbor's readReward diagnostics: when the trial recorded
  // an exception and grading never produced a reward, name the exception, which
  // is the root cause, not the missing file.
  if (trialException) {
    throw new PierInfraError(
      `pier trial failed before verifier reward for task ${taskId}: ${trialException}`,
    );
  }
  throw new PierInfraError(`missing verifier reward for task ${taskId}`);
}

/** Grace between SIGTERM and SIGKILL when the watchdog fires. Pier's SIGTERM
 * handler (pier/cli/jobs.py:771 -> :148 raises KeyboardInterrupt) unwinds its
 * Python finally chain, which owns docker compose teardown — containers need
 * real time to stop and delete, so the grace must cover a compose down. */
const DEFAULT_TERMINATION_GRACE_MS = 120_000;
const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Two-phase trial termination. A direct SIGKILL (execFile's timeout path)
 * would skip every Python finally in pier — leaking docker compose containers
 * — and, on the Maka host-cell arm, orphan the run-host-cell.mjs child, which
 * would keep burning real tokens until its own cell deadline. Instead the
 * child runs detached in its own process group; on timeout the whole group
 * gets SIGTERM (triggering pier's own teardown — the teardown authority is
 * pier's finally chain, never docker scanning here), then SIGKILL after the
 * grace. Exported for the termination-contract tests. The Harbor runner shares
 * this SIGKILL gap on main; its CLI's signal semantics are unverified, so that
 * fix is deliberately out of this module's scope. */
export const defaultPierProcessRunner: PierProcessRunner = async (request) => {
  return await new Promise<PierRunResult>((resolvePromise) => {
    const child = spawn(request.pierBin, [...request.args], {
      cwd: request.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(request.env ? { env: { ...process.env, ...request.env } } : {}),
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError: Error | null = null;
    let graceTimer: NodeJS.Timeout | undefined;
    const watchdog =
      request.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            killProcessGroup(child, 'SIGTERM');
            graceTimer = setTimeout(
              () => killProcessGroup(child, 'SIGKILL'),
              request.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
            );
          }, request.timeoutMs)
        : undefined;
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURED_OUTPUT_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURED_OUTPUT_BYTES) stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (code, signal) => {
      clearTimeout(watchdog);
      clearTimeout(graceTimer);
      resolvePromise({
        exitCode: code ?? 1,
        stdout,
        stderr: stderr || (spawnError ? errorText(spawnError) : ''),
        ...(timedOut ? { timedOut } : {}),
        ...(signal ? { signal } : {}),
      });
    });
  });
};

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    // Negative pid: signal the whole detached process group, so pier's own
    // children (docker compose, the host cell) are reached too.
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

// The generic helpers below (readOptionalText .. isRecord) intentionally stay
// local copies of their harbor-task-runner counterparts: they carry no
// benchmark semantics, and exporting 3-line utilities would widen the Harbor
// module's surface for no invariant. Everything with benchmark meaning is
// imported from harbor-task-runner above.

async function readOptionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function readOptionalJson(path: string): Promise<Record<string, unknown> | null> {
  const raw = await readOptionalText(path);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
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
