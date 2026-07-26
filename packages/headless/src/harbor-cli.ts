import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { BackendKind, ProviderType } from '@maka/core';
import { PROVIDER_DEFAULTS, normalizeProviderType } from '@maka/core';
import type { Config, Task } from './contracts.js';
import {
  type HarborCellExecutionIdentity,
  combineInvocations,
  validateHarborCellExecutionIdentity,
} from './cell-output.js';
import { runAutonomousTaskWithStorage } from './autonomous-agent-loop.js';
import type { BenchmarkAdapterRegistry } from './benchmark-adapters.js';
import { resolveEconomyTaskMode } from './economy-task-policy.js';
import {
  buildHarborAiSdkBackendRegistration,
  buildHarborCellContextBudgetPolicySnapshot,
  createHarborCellLocalToolExecutor,
  createHarborHttpToolExecutor,
  harborCellSoftTimeoutMsFromEnv,
  reasoningEffortFromEnv,
  runHarborCellWithStorage,
  writeHarborCellArtifacts,
  writeHarborCellExecutionIdentity,
  writeHarborCellUsageCheckpoint,
  writeHarborTaskRunTrace,
  type RunHarborCellEnv,
  type RunHarborCellInput,
} from './harbor-cell.js';
import { classifyExternalHarborBenchmarkFailure } from './harbor-failure-policy.js';
import { resolveHeavyTaskMode } from './heavy-task-policy.js';
import { openHeadlessStorageForWrite, type HeadlessStorageWriter } from './headless-storage.js';
import type { RealBackendIsolation } from './isolation.js';
import { writeTaskRunExport } from './result-export.js';
import { backendNeedsIsolation } from './runner.js';
import { runTaskOnceWithStorage } from './task-agent-controller.js';
import { taxonomyFromResultRecord } from './task-contracts.js';
import { taskRunLocator } from './task-run-identity.js';
import { requireProviderCredentialEnv } from './provider-env.js';
import { createProviderEnvFetch, type ProviderEnvFetch } from './provider-env-fetch.js';
import { resolveHeadlessSystemPrompt } from './system-prompts.js';
import { booleanEnv } from './headless-run-env.js';

type HarborMode = 'cell' | 'task-run';
type HarborIsolationMode = 'none' | 'harbor-local' | 'harbor-http';
type OfficialVerifier = 'external-harbor';

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string>;
  bools: Record<string, boolean>;
}

interface HarborRunOptions {
  mode: HarborMode;
  backend: BackendKind;
  isolation: HarborIsolationMode | undefined;
  officialVerifier: OfficialVerifier;
  instruction: string;
  workdir: string;
  sourceWorkspaceDir: string;
  outDir: string;
  cellArtifactDir: string;
  storageRoot: string;
  taskId: string;
  taskRunId: string;
  env: RunHarborCellEnv;
  config: Config;
  contextBudgetPolicy: ReturnType<typeof buildHarborCellContextBudgetPolicySnapshot>;
  includeEvents: boolean;
  autonomous: boolean;
  maxAttempts: number;
  maxRuntimeSteps?: number;
  maxWallTimeMs?: number;
  softTimeoutMs?: number;
  deadlineAtMs?: number;
  replayPriorAttemptRuntimeContext: boolean;
  now: () => number;
  newId: () => string;
  registerBackends?: RunHarborCellInput['registerBackends'];
  realBackendIsolation?: RealBackendIsolation;
  providerEnvFetch?: ProviderEnvFetch;
}

const HARBOR_RUN_FLAGS = [
  'mode',
  'backend',
  'isolation',
  'instruction',
  'instruction-file',
  'workdir',
  'task-id',
  'task-run-id',
  'out',
  'storage-root',
  'provider',
  'model',
  'base-url',
  'api-key-file',
  'connection-slug',
  'config-id',
  'system-prompt',
  'official-verifier',
  'benchmark',
  'instance-id',
  'max-steps',
  'max-attempts',
  'max-runtime-steps',
  'max-wall-time-sec',
];

const HARBOR_RUN_BOOLS = [
  'include-events',
  'autonomous',
  'replay-prior-attempt-runtime-context',
  'heavy-task',
  'economy-task',
];

export async function harborCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === 'run') return harborRunCommand(rest);
  printHarborUsage();
  return 1;
}

async function harborRunCommand(args: string[]): Promise<number> {
  let options: HarborRunOptions;
  try {
    options = await resolveHarborRunOptions(args, process.env);
  } catch (error) {
    console.error(`${(error as Error).message}\n${harborRunUsage()}`);
    return 1;
  }

  try {
    const storage = await openHeadlessStorageForWrite(options.storageRoot);
    if (options.mode === 'cell') return await runHarborCellMode(options, storage);
    return await runHarborTaskRunMode(options, storage);
  } catch (error) {
    console.error(`maka eval harbor run: ${(error as Error).message}`);
    return 1;
  } finally {
    await options.providerEnvFetch?.close();
  }
}

async function runHarborCellMode(
  options: HarborRunOptions,
  storage: HeadlessStorageWriter,
): Promise<number> {
  const result = await runHarborCellWithStorage(
    {
      config: options.config,
      instruction: options.instruction,
      cwd: options.workdir,
      outputDir: options.outDir,
      storageRoot: options.storageRoot,
      ...(options.contextBudgetPolicy ? { contextBudgetPolicy: options.contextBudgetPolicy } : {}),
      ...(options.softTimeoutMs !== undefined ? { settleAfterMs: options.softTimeoutMs } : {}),
      ...(options.registerBackends ? { registerBackends: options.registerBackends } : {}),
      ...(options.realBackendIsolation
        ? { realBackendIsolation: options.realBackendIsolation }
        : {}),
      now: options.now,
      newId: options.newId,
    },
    storage,
  );
  process.stdout.write(
    `${JSON.stringify({
      mode: 'cell',
      status: result.output.status,
      errorClass: result.output.errorClass,
      outputPath: result.outputPath,
      runtimeEventsPath: result.runtimeEventsPath,
    })}\n`,
  );
  return result.output.status === 'completed' ? 0 : 1;
}

async function runHarborTaskRunMode(
  options: HarborRunOptions,
  storage: HeadlessStorageWriter,
): Promise<number> {
  await Promise.all([
    mkdir(options.outDir, { recursive: true }),
    mkdir(options.cellArtifactDir, { recursive: true }),
  ]);
  if (options.sourceWorkspaceDir !== options.workdir) {
    await mkdir(options.sourceWorkspaceDir, { recursive: true });
  }
  const task = buildHarborTask(options);
  const executionIdentity = await writeTaskRunExecutionIdentity(options, task);
  const common = {
    storageRoot: options.storageRoot,
    taskRunId: options.taskRunId,
    benchmarkAdapters: externalHarborBenchmarkAdapters(),
    ...(options.registerBackends ? { registerBackends: options.registerBackends } : {}),
    ...(options.realBackendIsolation ? { realBackendIsolation: options.realBackendIsolation } : {}),
    now: options.now,
    newId: options.newId,
    ...(options.deadlineAtMs !== undefined
      ? { deadlineAtMs: options.deadlineAtMs }
      : options.softTimeoutMs !== undefined
        ? { deadlineAtMs: options.now() + options.softTimeoutMs }
        : {}),
  };
  const run = options.autonomous
    ? await runAutonomousTaskWithStorage(
        options.config,
        task,
        {
          ...common,
          budget: {
            maxAttempts: options.maxAttempts,
            ...(options.maxRuntimeSteps !== undefined
              ? { maxRuntimeSteps: options.maxRuntimeSteps }
              : {}),
            ...(options.maxWallTimeMs !== undefined
              ? { maxWallTimeMs: options.maxWallTimeMs }
              : {}),
          },
          ...(options.replayPriorAttemptRuntimeContext
            ? { replayPriorAttemptRuntimeContext: true }
            : {}),
          decision: ({ attempt, budget }) => {
            const taxonomy =
              attempt.projection.latestScoreResult?.taxonomy ??
              attempt.projection.result?.taxonomy ??
              taxonomyFromResultRecord(attempt.resultRecord);
            if (taxonomy === 'unsupported_adapter') {
              return {
                decision: 'stop',
                reason: 'official Harbor verifier is external and pending',
              };
            }
            if (['policy_denied', 'blocked', 'setup_failed', 'infra_failed'].includes(taxonomy)) {
              return { decision: 'stop', reason: `${taxonomy} is not retryable` };
            }
            if (attempt.resultRecord.passed)
              return { decision: 'stop', reason: 'authoritative verification passed' };
            if (budget.attemptsUsed >= budget.maxAttempts)
              return { decision: 'stop', reason: 'max attempts exhausted' };
            if (
              budget.maxRuntimeSteps !== undefined &&
              budget.runtimeStepsUsed >= budget.maxRuntimeSteps
            ) {
              return { decision: 'stop', reason: 'runtime step cap reached' };
            }
            if (budget.maxWallTimeMs !== undefined && budget.elapsedMs >= budget.maxWallTimeMs) {
              return { decision: 'stop', reason: 'wall time cap reached' };
            }
            return {
              decision: 'continue',
              reason: `${taxonomy} can be retried while budget remains`,
            };
          },
        },
        storage,
      )
    : await runTaskOnceWithStorage(options.config, task, common, storage);

  const exportDir = join(options.outDir, 'exports', taskRunLocator(run.taskRunId));
  const exported = await writeTaskRunExport(exportDir, run.projection, {
    includeEvents: options.includeEvents,
  });
  const latestScore = run.projection.latestScoreResult;
  const invocations =
    'attempts' in run ? run.attempts.flatMap((attempt) => attempt.invocations) : run.invocations;
  const invocation = invocations.length > 0 ? combineInvocations(invocations) : undefined;
  const settledByDeadline =
    'attempts' in run
      ? run.attempts.some((attempt) => attempt.settledByDeadline)
      : run.settledByDeadline;
  const cellArtifacts = invocation
    ? await writeHarborCellArtifacts({
        outputDir: options.cellArtifactDir,
        executionIdentity,
        invocation,
        promptHash: executionIdentity.systemPromptHash,
        ...(settledByDeadline
          ? {
              deadlineSettlement: {
                source: 'benchmark.deadline' as const,
                mode: 'immediate' as const,
              },
            }
          : {}),
        ...(options.contextBudgetPolicy
          ? { contextBudgetPolicy: options.contextBudgetPolicy }
          : {}),
      })
    : undefined;
  const traceEventsPath =
    invocations.length > 0
      ? await writeHarborTaskRunTrace({
          outputDir: options.cellArtifactDir,
          storage,
          invocations,
        })
      : undefined;
  const taxonomy =
    run.projection.status === 'budget_exhausted'
      ? 'budget_exhausted'
      : (latestScore?.taxonomy ??
        run.projection.result?.taxonomy ??
        taxonomyFromResultRecord(run.resultRecord));
  const benchmarkFailure = classifyExternalHarborBenchmarkFailure({
    status:
      run.projection.status === 'budget_exhausted' ? 'budget_exhausted' : run.resultRecord.status,
    errorClass: run.resultRecord.errorClass,
    error: run.resultRecord.error,
    taxonomy,
  });
  process.stdout.write(
    `${JSON.stringify({
      mode: 'task-run',
      taskRunId: run.taskRunId,
      status: run.projection.status,
      settledByDeadline,
      taxonomy,
      scored: latestScore?.scored ?? run.resultRecord.scored ?? false,
      authoritative: latestScore?.authority?.authoritative ?? false,
      benchmarkFailureKind: benchmarkFailure.kind,
      benchmarkFailureShouldThrow: benchmarkFailure.shouldThrow,
      ...(cellArtifacts
        ? {
            outputPath: cellArtifacts.outputPath,
            runtimeEventsPath: cellArtifacts.runtimeEventsPath,
          }
        : {}),
      ...(traceEventsPath ? { traceEventsPath } : {}),
      exportDir,
      files: exported.files,
      result: {
        status: run.resultRecord.status,
        passed: run.resultRecord.passed,
        errorClass: run.resultRecord.errorClass,
      },
      runtimeRefs: latestScore?.details?.runtimeRefs,
    })}\n`,
  );
  return settledByDeadline ? 124 : benchmarkFailure.shouldThrow ? 1 : 0;
}

async function writeTaskRunExecutionIdentity(
  options: HarborRunOptions,
  task: Task,
): Promise<HarborCellExecutionIdentity> {
  const prompt = resolveHeadlessSystemPrompt(options.config, {
    heavyTaskMode: resolveHeavyTaskMode(options.config, task),
    economyTaskMode: resolveEconomyTaskMode(options.config, task),
  });
  const executionIdentity = validateHarborCellExecutionIdentity({
    llmConnectionSlug: options.config.llmConnectionSlug,
    model: options.config.model,
    ...(options.config.thinkingLevel ? { reasoningEffort: options.config.thinkingLevel } : {}),
    systemPromptMode: prompt.mode,
    systemPromptHash: prompt.systemPromptHash,
    pricingProfile: options.env.MAKA_TRIAL_PRICING_SOURCE ?? 'unconfigured',
    agentTools: options.config.agentTools === true,
  });
  await writeHarborCellExecutionIdentity(options.cellArtifactDir, executionIdentity);
  return executionIdentity;
}

export async function resolveHarborRunOptions(
  args: string[],
  baseEnv: NodeJS.ProcessEnv,
): Promise<HarborRunOptions> {
  const parsed = parseArgs(args, HARBOR_RUN_FLAGS, HARBOR_RUN_BOOLS);
  if (parsed.positional.length > 0)
    throw new Error(`unexpected positional argument: ${parsed.positional[0]}`);
  const env = cliEnv(parsed, baseEnv);
  // Resolve backend before applying desktop defaults so --backend fake /
  // pi-agent never picks up the workspace's default connection. cliEnv does
  // not forward the backend flag, so guarding inside applyConnectionDefaults
  // only covers the MAKA_BACKEND env-var path, not the flag path.
  const backend = backendKind(valueOf(parsed, env, 'backend', 'MAKA_BACKEND') ?? 'ai-sdk');
  if (backend === 'ai-sdk') {
    applyConnectionDefaults(env);
  }
  applyApiKeyFile(parsed, env);
  const mode = harborMode(valueOf(parsed, env, 'mode', 'MAKA_HARBOR_MODE') ?? 'task-run');
  const isolation = optionalIsolation(
    valueOf(parsed, env, 'isolation', 'MAKA_HARBOR_ISOLATION') ?? env.MAKA_ISOLATION,
  );
  preflightIsolation(backend, isolation, env);

  const outDir = resolve(valueOf(parsed, env, 'out', 'MAKA_OUTPUT_DIR') ?? '/logs/agent');
  const cellArtifactDir = mode === 'cell' ? outDir : resolve(env.MAKA_CELL_ARTIFACT_DIR ?? outDir);
  const storageRoot = resolve(
    valueOf(parsed, env, 'storage-root', 'MAKA_STORAGE_ROOT') ??
      (mode === 'task-run' ? join(outDir, 'runs') : join(outDir, 'maka-storage')),
  );
  const taskId =
    valueOf(parsed, env, 'task-id', 'MAKA_TASK_ID') ??
    env.HARBOR_SESSION_ID ??
    'terminal-bench-task';
  const taskRunId = valueOf(parsed, env, 'task-run-id', 'MAKA_TASK_RUN_ID') ?? `harbor-${taskId}`;
  const requestedWorkdir = valueOf(parsed, env, 'workdir', 'MAKA_WORKDIR') ?? process.cwd();
  const workdir = isolation === 'harbor-http' ? requestedWorkdir : resolve(requestedWorkdir);
  const sourceWorkspaceDir =
    isolation && isolation !== 'none' ? resolve(join(outDir, 'host-workspace-source')) : workdir;
  const instruction = await instructionFromOptions(parsed, env);
  const officialVerifier = officialVerifierKind(
    valueOf(parsed, env, 'official-verifier', 'MAKA_OFFICIAL_VERIFIER') ?? 'external-harbor',
  );
  const now = Date.now;
  const newId = randomUUID;
  const contextBudgetPolicy = buildHarborCellContextBudgetPolicySnapshot(env);
  const maxSteps = optionalPositiveInt(
    valueOf(parsed, env, 'max-steps', 'MAKA_MAX_STEPS'),
    '--max-steps',
  );
  const maxRuntimeSteps = optionalPositiveInt(
    valueOf(parsed, env, 'max-runtime-steps', 'MAKA_MAX_RUNTIME_STEPS'),
    '--max-runtime-steps',
  );
  const maxWallTimeSec = optionalPositiveInt(
    valueOf(parsed, env, 'max-wall-time-sec', 'MAKA_MAX_WALL_TIME_SEC'),
    '--max-wall-time-sec',
  );
  const softTimeoutMs = harborCellSoftTimeoutMsFromEnv(env);
  const deadlineAtMs = optionalPositiveInt(
    env.MAKA_CELL_DEADLINE_AT_MS,
    'MAKA_CELL_DEADLINE_AT_MS',
  );
  const config = buildConfig({
    parsed,
    env,
    backend,
    heavyTask: parsed.bools['heavy-task'] || truthyEnv(env.MAKA_HEAVY_TASK_MODE),
    economyTask: parsed.bools['economy-task']
      ? true
      : booleanEnv(env.MAKA_ECONOMY_TASK_MODE, 'MAKA_ECONOMY_TASK_MODE'),
    agentTools: booleanEnv(env.MAKA_AGENT_TOOLS, 'MAKA_AGENT_TOOLS') ?? false,
  });
  const realBackendIsolation = buildIsolation(isolation, env, workdir, outDir);
  const providerEnvFetch = backend === 'ai-sdk' ? createProviderEnvFetch(env) : undefined;
  let registerBackends: RunHarborCellInput['registerBackends'];
  try {
    registerBackends = buildBackendRegistration({
      backend,
      env,
      now,
      newId,
      cellArtifactDir,
      ...(providerEnvFetch ? { fetch: providerEnvFetch.fetch } : {}),
      maxSteps,
    });
  } catch (error) {
    await providerEnvFetch?.close();
    throw error;
  }
  return {
    mode,
    backend,
    isolation,
    officialVerifier,
    instruction,
    workdir,
    sourceWorkspaceDir,
    outDir,
    cellArtifactDir,
    storageRoot,
    taskId,
    taskRunId,
    env,
    config,
    contextBudgetPolicy,
    includeEvents: parsed.bools['include-events'],
    autonomous: parsed.bools.autonomous || truthyEnv(env.MAKA_AUTONOMOUS),
    maxAttempts: positiveInt(
      valueOf(parsed, env, 'max-attempts', 'MAKA_MAX_ATTEMPTS') ?? '1',
      '--max-attempts',
    ),
    ...(maxRuntimeSteps !== undefined ? { maxRuntimeSteps } : {}),
    ...(maxWallTimeSec !== undefined ? { maxWallTimeMs: maxWallTimeSec * 1000 } : {}),
    ...(softTimeoutMs !== undefined ? { softTimeoutMs } : {}),
    ...(deadlineAtMs !== undefined ? { deadlineAtMs } : {}),
    replayPriorAttemptRuntimeContext:
      parsed.bools['replay-prior-attempt-runtime-context'] ||
      truthyEnv(env.MAKA_REPLAY_PRIOR_ATTEMPT_RUNTIME_CONTEXT),
    now,
    newId,
    ...(registerBackends ? { registerBackends } : {}),
    ...(realBackendIsolation ? { realBackendIsolation } : {}),
    ...(providerEnvFetch ? { providerEnvFetch } : {}),
  };
}

function buildHarborTask(options: HarborRunOptions): Task {
  return {
    id: options.taskId,
    instruction: options.instruction,
    workspaceDir: options.sourceWorkspaceDir,
    verifier: {
      kind: 'terminal_bench',
      adapter: 'terminal-bench',
      instanceId: options.env.MAKA_INSTANCE_ID ?? options.taskId,
      dataset: options.env.MAKA_BENCHMARK_DATASET ?? 'terminal-bench/terminal-bench-2-1',
      protectedPaths: [],
      adapterOptions: {
        officialVerifier: options.officialVerifier,
        authority: 'external_harbor_post_exit',
      },
    },
    benchmark: {
      source: 'terminal_bench',
      instanceId: options.env.MAKA_INSTANCE_ID ?? options.taskId,
      official: true,
      metadata: {
        remoteWorkspaceDir: options.workdir,
      },
    },
  };
}

function externalHarborBenchmarkAdapters(): BenchmarkAdapterRegistry {
  return {
    'terminal-bench': {
      name: 'terminal-bench',
      runVerifier: ({ verifier }) => {
        if (verifier.kind !== 'terminal_bench') {
          throw new Error(
            `external Harbor adapter received unsupported verifier kind: ${verifier.kind}`,
          );
        }
        return {
          kind: 'terminal_bench',
          passed: false,
          exitCode: null,
          error: 'official Harbor verifier runs after the agent exits',
          errorClass: 'external_verifier_pending',
          authority: {
            source: 'system',
            authoritative: false,
            label: 'external Harbor verifier pending',
          },
          details: {
            adapter: verifier.adapter,
            instanceId: verifier.instanceId,
            ...(verifier.dataset ? { dataset: verifier.dataset } : {}),
            ...(verifier.datasetPath ? { datasetPath: verifier.datasetPath } : {}),
            ...(verifier.taskDir ? { taskDir: verifier.taskDir } : {}),
            ...(verifier.taskDescriptionKey
              ? { taskDescriptionKey: verifier.taskDescriptionKey }
              : {}),
            officialVerifier: 'external_harbor_post_exit',
            pendingExternalHarborVerifier: true,
          },
        };
      },
    },
  };
}

function buildConfig(input: {
  parsed: ParsedArgs;
  env: RunHarborCellEnv;
  backend: BackendKind;
  heavyTask: boolean;
  economyTask: boolean | undefined;
  agentTools: boolean;
}): Config {
  const thinkingLevel = reasoningEffortFromEnv(input.env.MAKA_REASONING_EFFORT);
  const economyTaskMode =
    input.economyTask === undefined
      ? {}
      : {
          economyTaskMode: {
            enabled: input.economyTask,
            reason: input.economyTask
              ? 'maka eval harbor run --economy-task'
              : 'maka eval harbor run MAKA_ECONOMY_TASK_MODE=false',
          },
        };
  if (input.backend === 'fake') {
    return {
      id: input.parsed.flags['config-id'] ?? input.env.MAKA_CONFIG_ID ?? 'harbor-fake',
      backend: 'fake',
      llmConnectionSlug: input.env.MAKA_LLM_CONNECTION_SLUG ?? 'fake',
      model: input.env.MAKA_MODEL ?? input.env.HARBOR_MODEL ?? 'fake',
      ...(thinkingLevel ? { thinkingLevel } : {}),
      agentTools: input.agentTools,
      ...(input.heavyTask
        ? { heavyTaskMode: { enabled: true, reason: 'maka eval harbor run --heavy-task' } }
        : {}),
      ...economyTaskMode,
    };
  }
  if (input.backend !== 'ai-sdk') {
    throw new Error(
      `maka eval harbor run task-run currently supports backend fake or ai-sdk, got ${input.backend}`,
    );
  }
  const modelSpec = parseModelSpec(
    input.env.MAKA_MODEL ?? input.env.HARBOR_MODEL ?? 'deepseek/deepseek-v4-flash',
    input.env.MAKA_PROVIDER,
  );
  return {
    id:
      input.parsed.flags['config-id'] ?? input.env.MAKA_CONFIG_ID ?? `harbor-${modelSpec.provider}`,
    backend: 'ai-sdk',
    llmConnectionSlug: input.env.MAKA_LLM_CONNECTION_SLUG ?? modelSpec.provider,
    model: modelSpec.model,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    agentTools: input.agentTools,
    ...(input.env.MAKA_SYSTEM_PROMPT !== undefined
      ? { systemPrompt: input.env.MAKA_SYSTEM_PROMPT }
      : {}),
    ...(input.heavyTask
      ? { heavyTaskMode: { enabled: true, reason: 'maka eval harbor run --heavy-task' } }
      : {}),
    ...economyTaskMode,
  };
}

function buildBackendRegistration(input: {
  backend: BackendKind;
  env: RunHarborCellEnv;
  now: () => number;
  newId: () => string;
  cellArtifactDir: string;
  fetch?: typeof globalThis.fetch;
  maxSteps?: number;
}): RunHarborCellInput['registerBackends'] | undefined {
  if (input.backend === 'fake') return undefined;
  if (input.backend !== 'ai-sdk') throw new Error(`unsupported Harbor backend: ${input.backend}`);
  const modelSpec = parseModelSpec(
    input.env.MAKA_MODEL ?? input.env.HARBOR_MODEL ?? 'deepseek/deepseek-v4-flash',
    input.env.MAKA_PROVIDER,
  );
  return buildHarborAiSdkBackendRegistration({
    provider: modelSpec.provider,
    model: modelSpec.model,
    env: input.env,
    now: input.now,
    newId: input.newId,
    ...(input.fetch ? { fetch: input.fetch } : {}),
    recordUsageCheckpoint: (usage) => writeHarborCellUsageCheckpoint(input.cellArtifactDir, usage),
    ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
  });
}

function buildIsolation(
  mode: HarborIsolationMode | undefined,
  env: RunHarborCellEnv,
  workdir: string,
  outDir: string,
): RealBackendIsolation | undefined {
  if (!mode || mode === 'none') return undefined;
  if (mode === 'harbor-local') {
    return {
      kind: 'external',
      label: 'Harbor task container',
      workspaceDir: workdir,
      submittedSnapshotRoot: join(outDir, 'submitted-snapshots'),
      toolExecutor: createHarborCellLocalToolExecutor(env),
    };
  }
  return {
    kind: 'external',
    label: 'Harbor task container via host adapter',
    workspaceDir: workdir,
    toolExecutor: createHarborHttpToolExecutor(env),
  };
}

function preflightIsolation(
  backend: BackendKind,
  isolation: HarborIsolationMode | undefined,
  env: RunHarborCellEnv,
): void {
  if (backendNeedsIsolation(backend) && (!isolation || isolation === 'none')) {
    throw new Error(
      `backend "${backend}" requires --isolation harbor-local|harbor-http for maka eval harbor run`,
    );
  }
  if (isolation === 'harbor-http') {
    if (!env.MAKA_HARBOR_TOOL_EXECUTOR_URL)
      throw new Error('MAKA_HARBOR_TOOL_EXECUTOR_URL is required for --isolation harbor-http');
    if (!env.MAKA_HARBOR_TOOL_EXECUTOR_TOKEN)
      throw new Error('MAKA_HARBOR_TOOL_EXECUTOR_TOKEN is required for --isolation harbor-http');
  }
}

function cliEnv(parsed: ParsedArgs, baseEnv: NodeJS.ProcessEnv): RunHarborCellEnv {
  const env: RunHarborCellEnv = { ...baseEnv };
  setFlagEnv(env, parsed, 'provider', 'MAKA_PROVIDER');
  setFlagEnv(env, parsed, 'model', 'MAKA_MODEL');
  setFlagEnv(env, parsed, 'base-url', 'MAKA_BASE_URL');
  setFlagEnv(env, parsed, 'connection-slug', 'MAKA_LLM_CONNECTION_SLUG');
  setFlagEnv(env, parsed, 'instruction', 'MAKA_INSTRUCTION');
  setFlagEnv(env, parsed, 'instruction-file', 'MAKA_INSTRUCTION_FILE');
  setFlagEnv(env, parsed, 'workdir', 'MAKA_WORKDIR');
  setFlagEnv(env, parsed, 'task-id', 'MAKA_TASK_ID');
  setFlagEnv(env, parsed, 'task-run-id', 'MAKA_TASK_RUN_ID');
  setFlagEnv(env, parsed, 'out', 'MAKA_OUTPUT_DIR');
  setFlagEnv(env, parsed, 'storage-root', 'MAKA_STORAGE_ROOT');
  setFlagEnv(env, parsed, 'system-prompt', 'MAKA_SYSTEM_PROMPT');
  setFlagEnv(env, parsed, 'instance-id', 'MAKA_INSTANCE_ID');
  if (parsed.flags.benchmark && parsed.flags.benchmark !== 'terminal-bench') {
    throw new Error('--benchmark currently supports only terminal-bench');
  }
  return env;
}

/**
 * Apply --api-key-file AFTER applyConnectionDefaults so that provider
 * inference uses the final resolved MAKA_MODEL, not the pre-defaults value.
 */
function applyApiKeyFile(parsed: ParsedArgs, env: RunHarborCellEnv): void {
  if (!parsed.flags['api-key-file']) return;
  const provider = providerFromValue(
    parsed.flags.provider ??
      env.MAKA_PROVIDER ??
      providerFromModel(env.MAKA_MODEL ?? env.HARBOR_MODEL),
  );
  env[apiKeyFileEnvName(provider)] = parsed.flags['api-key-file'];
}

async function instructionFromOptions(parsed: ParsedArgs, env: RunHarborCellEnv): Promise<string> {
  if (parsed.flags.instruction !== undefined || env.MAKA_INSTRUCTION !== undefined) {
    return (parsed.flags.instruction ?? env.MAKA_INSTRUCTION) as string;
  }
  const filePath = parsed.flags['instruction-file'] ?? env.MAKA_INSTRUCTION_FILE;
  if (filePath) return await readFile(filePath, 'utf8');
  throw new Error(
    '--instruction, --instruction-file, MAKA_INSTRUCTION, or MAKA_INSTRUCTION_FILE is required',
  );
}

function valueOf(
  parsed: ParsedArgs,
  env: RunHarborCellEnv,
  flag: string,
  envName: string,
): string | undefined {
  return parsed.flags[flag] ?? env[envName];
}

function setFlagEnv(
  env: RunHarborCellEnv,
  parsed: ParsedArgs,
  flag: string,
  envName: string,
): void {
  const value = parsed.flags[flag];
  if (value !== undefined) env[envName] = value;
}

function parseArgs(
  args: string[],
  knownFlags: readonly string[],
  boolFlags: readonly string[],
): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  const bools: Record<string, boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (boolFlags.includes(name)) {
      bools[name] = true;
      continue;
    }
    if (!knownFlags.includes(name)) throw new Error(`unknown flag: ${arg}`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`flag ${arg} needs a value`);
    flags[name] = value;
    i++;
  }
  return { positional, flags, bools };
}

function harborMode(value: string): HarborMode {
  if (value === 'cell' || value === 'task-run') return value;
  throw new Error(`--mode must be cell or task-run, got ${JSON.stringify(value)}`);
}

function optionalIsolation(value: string | undefined): HarborIsolationMode | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === 'none' || value === 'harbor-local' || value === 'harbor-http') return value;
  throw new Error(
    `--isolation must be none, harbor-local, or harbor-http, got ${JSON.stringify(value)}`,
  );
}

function officialVerifierKind(value: string): OfficialVerifier {
  if (value === 'external-harbor') return value;
  throw new Error(`--official-verifier must be external-harbor, got ${JSON.stringify(value)}`);
}

function backendKind(value: string): BackendKind {
  if (value === 'fake' || value === 'ai-sdk' || value === 'pi-agent') return value;
  throw new Error(`--backend must be fake, ai-sdk, or pi-agent, got ${JSON.stringify(value)}`);
}

/**
 * When no explicit model/provider/connection input is set, read the desktop
 * workspace's llm-connections.json and inject the default connection's
 * provider, model, slug, and baseUrl into env so downstream code resolves
 * them naturally.
 *
 * Guards:
 * - Skip if any explicit model/provider/connection input is already set
 * - Skip for non-ai-sdk backends (fake, pi-agent)
 * - Validate providerType against PROVIDER_DEFAULTS before writing
 * - Only write MAKA_LLM_CONNECTION_SLUG / MAKA_BASE_URL if they are undefined
 */
export function applyConnectionDefaults(env: Record<string, string | undefined>): void {
  // Skip if any explicit model/provider/connection input is set
  if (env.MAKA_MODEL || env.HARBOR_MODEL || env.MAKA_PROVIDER || env.MAKA_LLM_CONNECTION_SLUG)
    return;
  // Skip for non-ai-sdk backends
  if (env.MAKA_BACKEND === 'fake' || env.MAKA_BACKEND === 'pi-agent') return;

  const connectionsPath = env.MAKA_CONNECTIONS_PATH ?? resolveDefaultConnectionsPath();
  try {
    const file = JSON.parse(readFileSync(connectionsPath, 'utf8')) as {
      defaultSlug?: string | null;
      connections?: Array<{
        slug: string;
        providerType?: string;
        defaultModel?: string;
        baseUrl?: string;
        enabled?: boolean;
      }>;
    };
    if (!file.defaultSlug || !Array.isArray(file.connections)) return;
    const conn = file.connections.find((c) => c.slug === file.defaultSlug && c.enabled !== false);
    if (!conn?.providerType || !conn.defaultModel) return;
    // Normalize legacy persisted providerType ids (e.g. codex-subscription ->
    // openai-codex) so connections stored before a rename keep resolving.
    // applyConnectionDefaults reads llm-connections.json directly, bypassing
    // ConnectionStore's on-read normalization.
    const providerType = normalizeProviderType(conn.providerType);
    if (!(providerType in PROVIDER_DEFAULTS)) return;

    env.MAKA_MODEL = `${providerType}/${conn.defaultModel}`;
    if (env.MAKA_LLM_CONNECTION_SLUG === undefined) env.MAKA_LLM_CONNECTION_SLUG = conn.slug;
    if (env.MAKA_BASE_URL === undefined && conn.baseUrl) env.MAKA_BASE_URL = conn.baseUrl;
    // credentials.json lives next to llm-connections.json in the workspace;
    // point readStoredMakaApiKey at it so Windows/Linux no-env works too,
    // not just macOS.
    if (env.MAKA_CREDENTIALS_PATH === undefined) {
      env.MAKA_CREDENTIALS_PATH = join(dirname(connectionsPath), 'credentials.json');
    }
  } catch {
    // File doesn't exist or is malformed — fall through to existing hardcoded defaults
  }
}

export function resolveDefaultConnectionsPath(): string {
  const home = homedir();
  switch (process.platform) {
    case 'darwin':
      return join(
        home,
        'Library',
        'Application Support',
        'Maka',
        'workspaces',
        'default',
        'llm-connections.json',
      );
    case 'win32':
      return join(
        process.env.APPDATA ?? join(home, 'AppData', 'Roaming'),
        'Maka',
        'workspaces',
        'default',
        'llm-connections.json',
      );
    default:
      return join(
        process.env.XDG_CONFIG_HOME ?? join(home, '.config'),
        'Maka',
        'workspaces',
        'default',
        'llm-connections.json',
      );
  }
}

function parseModelSpec(
  rawModel: string,
  rawProvider: string | undefined,
): { provider: ProviderType; model: string } {
  if (rawProvider !== undefined)
    return { provider: providerFromValue(rawProvider), model: requireModel(rawModel) };
  const separator = rawModel.indexOf('/');
  const provider = separator >= 0 ? rawModel.slice(0, separator) : 'deepseek';
  const model = separator >= 0 ? rawModel.slice(separator + 1) : rawModel;
  return { provider: providerFromValue(provider), model: requireModel(model) };
}

function providerFromModel(rawModel: string | undefined): ProviderType {
  const model = rawModel ?? 'deepseek/deepseek-v4-flash';
  const separator = model.indexOf('/');
  return providerFromValue(separator >= 0 ? model.slice(0, separator) : 'deepseek');
}

function providerFromValue(value: string | undefined): ProviderType {
  if (!value || !(value in PROVIDER_DEFAULTS))
    throw new Error(`unsupported MAKA_PROVIDER: ${value ?? ''}`);
  return value as ProviderType;
}

function requireModel(value: string): string {
  if (!value) throw new Error('MAKA_MODEL must include a model id');
  return value;
}

function apiKeyFileEnvName(provider: ProviderType): string {
  return requireProviderCredentialEnv(provider).apiKeyFile;
}

function optionalPositiveInt(raw: string | undefined, flagName: string): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  return positiveInt(raw, flagName);
}

function positiveInt(raw: string, flagName: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${flagName} must be a positive integer`);
  return value;
}

function truthyEnv(raw: string | undefined): boolean {
  if (!raw) return false;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(raw.trim().toLowerCase());
}

function printHarborUsage(): void {
  console.error('maka eval harbor commands:\n');
  console.error(harborRunUsage());
}

function harborRunUsage(): string {
  return [
    'usage: maka eval harbor run --instruction <text>|--instruction-file <path> --isolation harbor-local|harbor-http [options]',
    '       real backends fail closed without explicit isolation; harbor-http requires MAKA_HARBOR_TOOL_EXECUTOR_URL and MAKA_HARBOR_TOOL_EXECUTOR_TOKEN',
  ].join('\n');
}
