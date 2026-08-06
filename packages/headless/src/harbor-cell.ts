import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  AgentRunEvent,
  AgentRunHeader,
  BackendKind,
  EmittedAgentRunEvent,
  PricingConfig,
  ProviderType,
  RuntimeEvent,
} from '@maka/core';
import { isTerminalRuntimeEvent, isThinkingLevel, resolveModelVisionSupport } from '@maka/core';
import {
  AgentGraphCoordinator,
  AGENT_TOOL_GROUP_ID,
  AiSdkBackend,
  BackendRegistry,
  PiAgentBackend,
  SessionManager,
  buildChildAgentTools,
  buildProviderOptions,
  buildSubscriptionModelFetch,
  createProviderRequestCaptureRecorder,
  getAIModel,
  getBuiltinPricing,
  loadSynthesisCacheBlocksFromArtifacts,
  persistSynthesisCacheBlocksToArtifacts,
  projectEffectiveProductToolSurface,
  routeWebSearchTools,
  type InvocationResult,
  type SynthesisCacheArtifactStore,
  type SynthesisCacheLoader,
  type SynthesisCacheWriter,
  type TurnStartOptions,
} from '@maka/runtime';
import {
  createAttachmentByteReader,
  createReadImageSnapshotter,
  exportSessionBundleState,
  persistProviderRequestCaptureArtifact,
} from '@maka/storage';
import { createAgentGraphControlStore } from '@maka/storage/agent-graph-control-store';
import { registerFakeBackend } from './backends.js';
import {
  buildHarborCellOutput,
  combineInvocations,
  countRuntimeSteps,
  selectHarborCellTokenSummary,
  validateHarborCellOutput,
  validateHarborCellTokenSummary,
  type HarborCellContextBudgetPolicySnapshot,
  type HarborCellDeadlineSettlement,
  type HarborCellExecutionIdentity,
  type HarborCellOutput,
} from './cell-output.js';
import type { Config, Task } from './contracts.js';
import { resolveHeavyTaskMode } from './heavy-task-policy.js';
import { resolveEconomyTaskMode } from './economy-task-policy.js';
import {
  authenticateHeadlessStorageWriter,
  isStorageRootAuthorityError,
  openHeadlessStorageForWrite,
  type HeadlessStorageWriter,
} from './headless-storage.js';
import type { HeadlessBackendContext, RealBackendIsolation } from './isolation.js';
import { endManagedShellSessions, validateRealBackendIsolation } from './isolation.js';
import { PiCliJsonTransport } from './pi-cli-json-transport.js';
import { providerFromEnv, resolveHarborCellAiSdkEnv } from './provider-env.js';
import { backendNeedsIsolation } from './runner.js';
import {
  buildHeadlessProductToolSurfaceForBackend,
  buildIsolatedHeadlessSupplementalTools,
} from './tools.js';
import { createHeadlessSessionCapabilityBridge } from './session-capabilities.js';
import { resolveHeadlessSystemPrompt } from './system-prompts.js';
import {
  createInMemoryTaskLedgerExperimentStore,
  renderTaskLedgerExperimentReplay,
} from './task-ledger-experiment.js';
import {
  booleanEnv,
  MAX_NODE_TIMER_MS,
  numericEnv,
  positiveIntEnv,
  type RunHarborCellEnv,
} from './headless-run-env.js';
import {
  buildHarborCellContextBudgetBackendOptions,
  buildHarborCellContextBudgetPolicySnapshot,
  buildHarborCellTaskLedgerExperimentPolicy,
} from './harbor-cell-context-budget-env.js';
import {
  buildHarborCellAiSdkTools,
  createHarborCellLocalToolExecutor,
} from './harbor-cell-tool-executor.js';
import { createProviderEnvFetch, type ProviderEnvFetch } from './provider-env-fetch.js';

// The Harbor cell orchestration module keeps `#harbor-cell` (and './harbor-cell.js')
// as the stable public surface. After the sink-file split the moved symbols live in
// dedicated leaves; re-export them here so existing importers keep resolving them
// from the orchestration module.
export {
  HARBOR_CELL_CONTEXT_ENV_KEYS,
  normalizeHarborCellContextEnv,
  buildHarborCellContextBudgetBackendOptions,
  buildHarborCellContextBudgetPolicySnapshot,
  buildHarborCellTaskLedgerExperimentPolicy,
  type HarborCellContextEnvKey,
  type HarborCellContextBudgetBackendOptions,
  type HarborCellTaskLedgerExperimentPolicy,
} from './harbor-cell-context-budget-env.js';
export {
  HARBOR_CELL_DEFAULT_COMMAND_TIMEOUT_MS,
  buildHarborCellAiSdkTools,
  createHarborCellLocalToolExecutor,
  createHarborHttpToolExecutor,
} from './harbor-cell-tool-executor.js';
export {
  providerApiKeyEnvName,
  resolveHostProviderAuthority,
  resolveHarborCellAiSdkEnv,
  type ResolvedHostProviderAuthority,
  type ResolvedHarborCellAiSdkEnv,
} from './provider-env.js';
export type { RunHarborCellEnv } from './headless-run-env.js';

export const HARBOR_CELL_OUTPUT_FILENAME = 'maka-cell-output.json';
export const HARBOR_CELL_RUNTIME_EVENTS_FILENAME = 'runtime-events.jsonl';
export const HARBOR_CELL_TRACE_EVENTS_FILENAME = 'trace-events.jsonl';
export const HARBOR_CELL_EXECUTION_IDENTITY_FILENAME = 'maka-cell-execution-identity.json';
export const HARBOR_CELL_USAGE_CHECKPOINT_FILENAME = 'maka-cell-usage-checkpoint.json';
export const HARBOR_CELL_TRAJECTORY_STATE_DIRECTORY = 'trajectory-state';

export interface RunHarborCellInput {
  config: Config;
  instruction: string;
  cwd: string;
  outputDir: string;
  storageRoot: string;
  pricingProfile?: string;
  registerBackends?: (
    registry: BackendRegistry,
    context: HeadlessBackendContext,
  ) => void | Promise<void>;
  realBackendIsolation?: RealBackendIsolation;
  contextBudgetPolicy?: HarborCellContextBudgetPolicySnapshot;
  continuationPolicy?: HarborCellContinuationPolicy;
  taskToolSummaryEnabled?: boolean;
  settleAfterMs?: number;
  /**
   * Deterministic trigger for the same settlement the settleAfterMs timer
   * arms. A wall-clock budget cannot encode an ordering guarantee, so a test
   * about "deadline fires before/after completion" resolves this promise at
   * the exact point in the run it means, instead of hoping a fixed number of
   * milliseconds lands on the right side of the race (#2221).
   */
  settleSignal?: Promise<void>;
  now?: () => number;
  newId?: () => string;
  /** Resume one already-materialized session instead of creating a fresh session. */
  resumeSessionId?: string;
  /** Optional measurement hook passed through Runtime's run-start boundary. */
  onRunStarted?: TurnStartOptions['onRunStarted'];
}

export interface HarborCellContinuationPolicy {
  enabled: boolean;
  maxTurns: number;
  maxTotalRuntimeSteps: number;
  prompt: string;
}

export interface HarborCellContinuationSummary {
  enabled: boolean;
  maxTurns: number;
  maxTotalRuntimeSteps: number;
  turnsUsed: number;
  continuedTurns: number;
  stepCapHits: number;
  capExhausted: boolean;
  totalRuntimeSteps: number;
  turns: HarborCellContinuationTurnSummary[];
}

export interface HarborCellContinuationTurnSummary {
  turnIndex: number;
  status: InvocationResult['status'];
  stepCapHit: boolean;
  runtimeSteps: number;
}

export interface RunHarborCellResult {
  invocation: InvocationResult;
  output: HarborCellOutput;
  outputPath: string;
  runtimeEventsPath: string;
  settledByDeadline: boolean;
}

export interface WriteHarborCellArtifactsInput {
  invocation: InvocationResult;
  outputDir: string;
  storageRoot?: string;
  promptHash?: string;
  executionIdentity?: HarborCellExecutionIdentity;
  deadlineSettlement?: HarborCellDeadlineSettlement;
  contextBudgetPolicy?: HarborCellContextBudgetPolicySnapshot;
  continuationSummary?: HarborCellContinuationSummary;
  taskToolSummaryEnabled?: boolean;
}

export interface WriteHarborCellArtifactsResult {
  output: HarborCellOutput;
  outputPath: string;
  runtimeEventsPath: string;
}

export const HARBOR_CELL_DEFAULT_CONTINUATION_PROMPT =
  'Continue the same benchmark task from the current workspace state. Do not restart. If the task is complete, provide the final response.';
const HARBOR_CELL_DEFAULT_MAX_STEPS_PER_TURN = 50;

export interface RunHarborCellFromEnvOptions {
  registerBackends?: RunHarborCellInput['registerBackends'];
  now?: () => number;
  newId?: () => string;
}

export interface HarborCellUsageCheckpoint {
  inputTokens: number;
  outputTokens: number;
  cacheHitInputTokens: number;
  cacheMissInputTokens: number;
  cacheMissInputSource: 'explicit' | 'derived';
  cacheWriteInputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd?: number;
}

const PI_BASE_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SHELL',
  'SystemRoot',
  'COMSPEC',
];
const PI_PROVIDER_ENV_RULES = [
  { includes: ['volcengine'], prefixes: ['XIAOMI_', 'VOLCENGINE_'] },
  {
    includes: ['deepseek'],
    keys: ['DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY_FILE', 'DEEPSEEK_BASE_URL'],
  },
  { includes: ['openai'], keys: ['OPENAI_API_KEY', 'OPENAI_API_KEY_FILE', 'OPENAI_BASE_URL'] },
  { includes: ['anthropic', 'claude'], keys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY_FILE'] },
  {
    includes: ['google', 'gemini'],
    keys: [
      'GOOGLE_API_KEY',
      'GOOGLE_API_KEY_FILE',
      'GEMINI_API_KEY',
      'GOOGLE_GENERATIVE_AI_API_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'GOOGLE_CLOUD_PROJECT',
      'GOOGLE_CLOUD_LOCATION',
      'GOOGLE_GENAI_USE_VERTEXAI',
    ],
  },
  {
    includes: ['moonshot', 'kimi'],
    keys: ['MOONSHOT_API_KEY', 'MOONSHOT_API_KEY_FILE', 'MOONSHOT_BASE_URL'],
  },
  {
    includes: ['zai'],
    keys: [
      'ZAI_API_KEY',
      'ZAI_API_KEY_FILE',
      'ZAI_CODING_CN_API_KEY',
      'ZAI_CODING_CN_API_KEY_FILE',
      'ZAI_BASE_URL',
    ],
  },
  { includes: ['minimax'], keys: ['MINIMAX_API_KEY', 'MINIMAX_API_KEY_FILE', 'MINIMAX_BASE_URL'] },
] satisfies Array<{ includes: string[]; keys?: string[]; prefixes?: string[] }>;

export async function runHarborCell(input: RunHarborCellInput): Promise<RunHarborCellResult> {
  const storage = await openHeadlessStorageForWrite(input.storageRoot);
  return runHarborCellWithStorage(input, storage);
}

export async function runHarborCellWithStorage(
  input: RunHarborCellInput,
  storage: HeadlessStorageWriter,
): Promise<RunHarborCellResult> {
  storage = authenticateHeadlessStorageWriter(storage);
  if (
    input.settleAfterMs !== undefined &&
    (!Number.isFinite(input.settleAfterMs) || input.settleAfterMs <= 0)
  ) {
    throw new Error('settleAfterMs must be a finite positive number');
  }
  if (backendNeedsIsolation(input.config.backend)) {
    validateRealBackendIsolation(input.realBackendIsolation);
    if (!input.registerBackends) {
      throw new Error(
        `@maka/headless: backend "${input.config.backend}" requires registerBackends to wire an isolated backend factory`,
      );
    }
  }

  const now = input.now ?? Date.now;
  const newId = input.newId ?? randomId;
  const sessionStore = storage.executionStores.sessionStore;
  const agentRunStore = storage.executionStores.agentRunStore;
  const runtimeEventStore = storage.executionStores.runtimeEventStore;
  const resumedSession = input.resumeSessionId
    ? await sessionStore.readHeaderSnapshot(input.resumeSessionId)
    : undefined;
  const backends = new BackendRegistry();
  const sessionCapabilities = createHeadlessSessionCapabilityBridge();
  const task: Task = {
    id: 'harbor-cell',
    instruction: input.instruction,
    workspaceDir: input.cwd,
  };
  const heavyTaskMode = resolveHeavyTaskMode(input.config, task);
  const economyTaskMode = resolveEconomyTaskMode(input.config, task);
  const prompt = resolveHeadlessSystemPrompt(input.config, { heavyTaskMode, economyTaskMode });
  const config = { ...input.config, systemPrompt: prompt.systemPrompt };
  if (resumedSession) {
    const boundary = await sessionStore.readExecutionBoundary(resumedSession.id);
    if (boundary.kind !== 'external') {
      throw new Error(
        `Harbor resume session requires an external execution boundary, observed ${boundary.kind}`,
      );
    }
    const executionFacts = [
      ['cwd', input.cwd, resumedSession.cwd],
      ['backend', input.config.backend, resumedSession.backend],
      ['llmConnectionSlug', config.llmConnectionSlug, resumedSession.llmConnectionSlug],
      ['model', config.model, resumedSession.model],
      ['thinkingLevel', config.thinkingLevel, resumedSession.thinkingLevel],
    ] as const;
    for (const [name, expected, observed] of executionFacts) {
      if (expected !== observed) {
        throw new Error(
          `Harbor resume session ${name} expected ${String(expected)}, observed ${String(observed)}`,
        );
      }
    }
  }
  const productToolSurface = buildHeadlessProductToolSurfaceForBackend(
    config.backend,
    input.realBackendIsolation?.toolExecutor,
    {
      agentTools: config.agentTools,
      snapshotImage: createReadImageSnapshotter(storage.artifactStore),
    },
  );
  const registerBackends =
    input.registerBackends ?? ((registry: BackendRegistry) => registerFakeBackend(registry));
  await registerBackends(backends, {
    config,
    task,
    storageRoot: input.storageRoot,
    workspaceDir: input.cwd,
    ...sessionCapabilities.capabilities,
    artifactStore: storage.artifactStore,
    ...(productToolSurface ? { productToolSurface } : {}),
    ...(backendNeedsIsolation(input.config.backend)
      ? {
          realBackendIsolation: input.realBackendIsolation,
          toolExecutor: input.realBackendIsolation?.toolExecutor,
        }
      : {}),
  });
  if (!config.model)
    throw new Error('Harbor cell config must include a model for execution identity');
  const executionIdentity = {
    llmConnectionSlug: config.llmConnectionSlug,
    model: config.model,
    ...(config.thinkingLevel ? { reasoningEffort: config.thinkingLevel } : {}),
    systemPromptMode: prompt.mode,
    systemPromptHash: prompt.systemPromptHash,
    pricingProfile: input.pricingProfile ?? 'unconfigured',
    agentTools: productToolSurface?.boundSurfaceIds.includes(AGENT_TOOL_GROUP_ID) ?? false,
    ...(productToolSurface ? { productToolSurface: productToolSurface.identity } : {}),
  };
  await writeHarborCellExecutionIdentity(input.outputDir, executionIdentity);

  let invocation: InvocationResult | undefined;
  const manager = new SessionManager({
    store: sessionStore,
    runStore: agentRunStore,
    runtimeEventStore,
    backends,
    ...(productToolSurface?.boundSurfaceIds.includes(AGENT_TOOL_GROUP_ID)
      ? {
          childTools: buildChildAgentTools(productToolSurface.tools),
        }
      : {}),
    newId,
    now,
    runtimeSource: 'test',
    runtimeInvocationObserver: (result) => {
      invocation = result;
    },
  });
  const session =
    resumedSession ??
    (await manager.createSession(
      {
        cwd: input.cwd,
        backend: input.config.backend,
        llmConnectionSlug: config.llmConnectionSlug,
        model: config.model,
        ...(config.thinkingLevel ? { thinkingLevel: config.thinkingLevel } : {}),
        permissionMode: 'ask',
        name: `harbor-cell:${input.config.id}`,
      },
      { initialBoundary: { kind: 'external', revision: 0 } },
    ));
  const graphControlStore = createAgentGraphControlStore(input.storageRoot);
  const graphCoordinator = new AgentGraphCoordinator({
    sessionStore,
    runStore: agentRunStore,
    runtimeEventStore,
    controlStore: graphControlStore,
    runtime: manager,
    newId,
    rootSessionId: session.id,
  });
  sessionCapabilities.bind(manager, graphCoordinator);
  let deadlineReached = false;
  let settlementError: unknown;
  let settlementAttempt: Promise<void> | undefined;
  let settlementClosed = false;
  const armDeadlineSettlement = () => {
    if (settlementClosed || deadlineReached) return;
    deadlineReached = true;
    settlementAttempt = sessionCapabilities
      .settle(session.id, {
        source: 'benchmark_deadline',
      })
      .catch((error) => {
        settlementError = error;
      });
  };
  const settlementTimer =
    input.settleAfterMs === undefined
      ? undefined
      : setTimeout(armDeadlineSettlement, input.settleAfterMs);
  if (input.settleSignal) void input.settleSignal.then(armDeadlineSettlement);

  const continuationPolicy = input.continuationPolicy ?? {
    enabled: false,
    maxTurns: 1,
    maxTotalRuntimeSteps: HARBOR_CELL_DEFAULT_MAX_STEPS_PER_TURN,
    prompt: HARBOR_CELL_DEFAULT_CONTINUATION_PROMPT,
  };
  const invocations: InvocationResult[] = [];
  let sendMessageError: unknown;
  let nextText = input.instruction;
  let stepCapHits = 0;
  let attemptedTurnId: string | undefined;
  let attemptedRunId: string | undefined;
  try {
    for (let turnIndex = 0; turnIndex < continuationPolicy.maxTurns; turnIndex += 1) {
      if (deadlineReached) break;
      const turnId = newId();
      const runId = newId();
      attemptedTurnId = turnId;
      attemptedRunId = runId;
      invocation = undefined;
      for await (const _event of manager.sendMessage(
        session.id,
        { turnId, text: nextText },
        {
          runId,
          ...(input.onRunStarted ? { onRunStarted: input.onRunStarted } : {}),
        },
      )) {
        // Event consumption drives the externally isolated Harbor run.
      }
      if (!invocation)
        throw new Error('Harbor cell turn finished without a runtime invocation result');
      invocations.push(invocation);
      if (deadlineReached) break;
      if (!isToolCallStepCap(invocation)) break;
      stepCapHits += 1;
      if (totalRuntimeSteps(invocations) >= continuationPolicy.maxTotalRuntimeSteps) break;
      if (!continuationPolicy.enabled || turnIndex + 1 >= continuationPolicy.maxTurns) break;
      nextText = continuationPolicy.prompt;
    }
  } catch (error) {
    if (isStorageRootAuthorityError(error)) throw error;
    sendMessageError = error;
  } finally {
    settlementClosed = true;
    if (settlementTimer) clearTimeout(settlementTimer);
    // The agent phase is over here, and grading runs after this process exits.
    // Anything the model left managed — a background build, a PTY it never
    // closed — has to die now: it cannot influence verification, and a PTY
    // child outliving this process would be an orphan nobody can reap.
    // Processes the model deliberately detached (`nohup … &`) are NOT managed
    // and deliberately survive, because some tasks are graded against a
    // service the agent was asked to leave running.
    await endManagedShellSessions(input.realBackendIsolation);
    try {
      if (settlementAttempt) {
        await settlementAttempt;
      } else {
        await sessionCapabilities.settle(
          session.id,
          deadlineReached ? { source: 'benchmark_deadline' } : undefined,
        );
      }
    } finally {
      try {
        await graphCoordinator.close();
      } finally {
        graphControlStore.close();
      }
    }
  }
  await settlementAttempt;
  if (settlementError) throw settlementError;
  const deadlineRun =
    deadlineReached && attemptedRunId
      ? await agentRunStore.readRun(session.id, attemptedRunId).catch((error) => {
          if (isStorageRootAuthorityError(error)) throw error;
          return undefined;
        })
      : undefined;
  const settledByDeadline =
    deadlineRun?.status === 'cancelled' && deadlineRun.abortSource === 'benchmark.deadline';
  if (sendMessageError) {
    invocations.push(
      settledByDeadline
        ? failedDeadlineInvocationFromRun(
            deadlineRun,
            await runtimeEventStore.readRuntimeEvents(session.id, deadlineRun.runId),
          )
        : failedInvocationFromError(sendMessageError, {
            newId,
            now,
            sessionId: session.id,
            turnId: attemptedTurnId ?? newId(),
          }),
    );
  } else if (invocations.length === 0) {
    throw new Error('Harbor cell finished without a runtime invocation result');
  }
  const combinedInvocation = combineInvocations(invocations);
  const continuationSummary = continuationPolicy.enabled
    ? buildContinuationSummary(continuationPolicy, invocations, stepCapHits)
    : undefined;

  const artifacts = await writeHarborCellArtifacts({
    invocation: combinedInvocation,
    outputDir: input.outputDir,
    storageRoot: input.storageRoot,
    executionIdentity,
    ...(settledByDeadline
      ? {
          deadlineSettlement: {
            source: 'benchmark.deadline' as const,
            mode: 'immediate' as const,
          },
        }
      : {}),
    ...(input.contextBudgetPolicy ? { contextBudgetPolicy: input.contextBudgetPolicy } : {}),
    ...(continuationSummary ? { continuationSummary } : {}),
    ...(input.taskToolSummaryEnabled !== undefined
      ? { taskToolSummaryEnabled: input.taskToolSummaryEnabled }
      : {}),
  });

  return {
    invocation: combinedInvocation,
    ...artifacts,
    settledByDeadline,
  };
}

export async function writeHarborCellExecutionIdentity(
  outputDir: string,
  executionIdentity: HarborCellExecutionIdentity,
): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await rm(join(outputDir, HARBOR_CELL_USAGE_CHECKPOINT_FILENAME), { force: true });
  await writeHarborCellArtifact(
    join(outputDir, HARBOR_CELL_EXECUTION_IDENTITY_FILENAME),
    `${JSON.stringify(executionIdentity, null, 2)}\n`,
  );
}

export async function writeHarborCellArtifacts(
  input: WriteHarborCellArtifactsInput,
): Promise<WriteHarborCellArtifactsResult> {
  await mkdir(input.outputDir, { recursive: true });
  if (input.storageRoot) {
    await exportHarborCellTrajectoryState({
      invocation: input.invocation,
      outputDir: input.outputDir,
      storageRoot: input.storageRoot,
    }).catch(async () => {
      await rm(join(input.outputDir, HARBOR_CELL_TRAJECTORY_STATE_DIRECTORY), {
        recursive: true,
        force: true,
      });
    });
  }
  const runtimeEventsPath = join(input.outputDir, HARBOR_CELL_RUNTIME_EVENTS_FILENAME);
  const outputPath = join(input.outputDir, HARBOR_CELL_OUTPUT_FILENAME);
  await writeHarborCellArtifact(runtimeEventsPath, runtimeEventsJsonl(input.invocation));
  const rawOutput = validateHarborCellOutput(
    buildHarborCellOutput({
      invocation: input.invocation,
      runtimeEventsPath,
      ...(input.promptHash ? { promptHash: input.promptHash } : {}),
      ...(input.executionIdentity ? { executionIdentity: input.executionIdentity } : {}),
      ...(input.deadlineSettlement ? { deadlineSettlement: input.deadlineSettlement } : {}),
      ...(input.contextBudgetPolicy ? { contextBudgetPolicy: input.contextBudgetPolicy } : {}),
      ...(input.continuationSummary ? { continuationSummary: input.continuationSummary } : {}),
      ...(input.taskToolSummaryEnabled !== undefined
        ? { taskToolSummaryEnabled: input.taskToolSummaryEnabled }
        : {}),
    }),
  );
  const usageCheckpoint = await readHarborCellUsageCheckpoint(input.outputDir);
  const tokenSummary = selectHarborCellTokenSummary(rawOutput.tokenSummary, usageCheckpoint);
  const output =
    tokenSummary && tokenSummary !== rawOutput.tokenSummary
      ? { ...rawOutput, tokenSummary }
      : rawOutput;
  await writeHarborCellArtifact(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  return { output, outputPath, runtimeEventsPath };
}

export async function exportHarborCellTrajectoryState(input: {
  invocation: InvocationResult;
  outputDir: string;
  storageRoot: string;
}): Promise<string | undefined> {
  const destinationRoot = join(input.outputDir, HARBOR_CELL_TRAJECTORY_STATE_DIRECTORY);
  await rm(destinationRoot, { recursive: true, force: true });
  if (!hasSessionImageArtifactReference(input.invocation.events)) return undefined;
  await exportSessionBundleState({
    stateRoot: input.storageRoot,
    configRoot: input.storageRoot,
    destinationRoot,
    sessionId: input.invocation.sessionId,
    allowShared: true,
  });
  return destinationRoot;
}

function hasSessionImageArtifactReference(events: readonly RuntimeEvent[]): boolean {
  return events.some((event) => {
    if (event.content?.kind !== 'function_response') return false;
    const result = event.content.result;
    if (typeof result !== 'object' || result === null || Array.isArray(result)) return false;
    const record = result as Record<string, unknown>;
    const ref = record.ref;
    return (
      record.kind === 'image' &&
      typeof ref === 'object' &&
      ref !== null &&
      !Array.isArray(ref) &&
      (ref as Record<string, unknown>).kind === 'session_file'
    );
  });
}

async function readHarborCellUsageCheckpoint(
  outputDir: string,
): Promise<NonNullable<HarborCellOutput['tokenSummary']> | null> {
  try {
    return validateHarborCellTokenSummary(
      JSON.parse(await readFile(join(outputDir, HARBOR_CELL_USAGE_CHECKPOINT_FILENAME), 'utf8')),
    );
  } catch {
    return null;
  }
}

/** Export top-level invocation ledgers for provider-request benchmark evidence. */
export async function writeHarborTaskRunTrace(input: {
  outputDir: string;
  storage: HeadlessStorageWriter;
  invocations: readonly InvocationResult[];
}): Promise<string> {
  const storage = authenticateHeadlessStorageWriter(input.storage);
  const eventGroups = await Promise.all(
    input.invocations.map(async (invocation) => {
      const [header, events] = await Promise.all([
        storage.executionStores.agentRunStore.readRun(invocation.sessionId, invocation.runId),
        storage.executionStores.agentRunStore.readEventsForEvidence(
          invocation.sessionId,
          invocation.runId,
        ),
      ]);
      const evidenceEvents =
        header.traceWriteError && !events.some((event) => event.type === 'trace_write_failed')
          ? [
              ...events,
              {
                type: 'trace_write_failed',
                id: `run-header-trace-write-failed-${header.runId}`,
                runId: header.runId,
                sessionId: header.sessionId,
                turnId: header.turnId,
                ts: header.updatedAt,
                message: header.traceWriteError,
              } satisfies EmittedAgentRunEvent,
            ]
          : events;
      if (header.backendKind !== 'ai-sdk' || evidenceEvents.some(isProviderRequestTraceEvidence)) {
        return evidenceEvents;
      }
      return [
        ...evidenceEvents,
        {
          type: 'event_corrupt',
          id: `run-provider-request-evidence-missing-${header.runId}`,
          runId: header.runId,
          sessionId: header.sessionId,
          turnId: header.turnId,
          ts: header.updatedAt,
          message: `Provider request trace evidence is missing for invocation ${invocation.invocationId}`,
          data: {
            reason: 'missing_provider_request_evidence',
            invocationId: invocation.invocationId,
          },
        } satisfies EmittedAgentRunEvent,
      ];
    }),
  );
  const chunks = eventGroups.map((events) =>
    events.map((event) => JSON.stringify(event)).join('\n'),
  );
  const nonEmptyChunks = chunks.map((chunk) => chunk.trimEnd()).filter(Boolean);
  const traceEventsPath = join(input.outputDir, HARBOR_CELL_TRACE_EVENTS_FILENAME);
  await writeHarborCellArtifact(
    traceEventsPath,
    nonEmptyChunks.length > 0 ? `${nonEmptyChunks.join('\n')}\n` : '',
  );
  return traceEventsPath;
}

function isProviderRequestTraceEvidence(event: AgentRunEvent): boolean {
  return (
    event.type === 'provider_request_captured' ||
    event.type === 'provider_request_attempt_recorded' ||
    event.type === 'trace_write_failed'
  );
}

export async function runHarborCellFromEnv(
  env: RunHarborCellEnv = process.env,
  options: RunHarborCellFromEnvOptions = {},
): Promise<RunHarborCellResult> {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? randomId;
  const outputDir = env.MAKA_OUTPUT_DIR ?? '/logs/agent';
  const storageRoot = env.MAKA_STORAGE_ROOT ?? join(outputDir, 'maka-storage');
  const resolvedEnv: RunHarborCellEnv = {
    ...env,
    MAKA_OUTPUT_DIR: outputDir,
    MAKA_STORAGE_ROOT: storageRoot,
  };
  const backend = backendFromEnv(resolvedEnv.MAKA_BACKEND);
  const contextBudgetPolicy = buildHarborCellContextBudgetPolicySnapshot(resolvedEnv);
  const continuationPolicy = buildHarborCellContinuationPolicy(resolvedEnv);
  const economyTaskMode = economyTaskModeFromEnv(resolvedEnv.MAKA_ECONOMY_TASK_MODE);
  const taskLedgerExperimentPolicy = buildHarborCellTaskLedgerExperimentPolicy(resolvedEnv);
  const maxSteps = harborCellMaxStepsFromEnv(resolvedEnv);
  const settleAfterMs = harborCellSoftTimeoutMsFromEnv(resolvedEnv);
  const reasoningEffort = reasoningEffortFromEnv(resolvedEnv.MAKA_REASONING_EFFORT);
  const agentTools = booleanEnv(resolvedEnv.MAKA_AGENT_TOOLS, 'MAKA_AGENT_TOOLS') ?? false;
  const baseConfig = {
    id: resolvedEnv.MAKA_CONFIG_ID ?? 'harbor-cell',
    backend,
    agentTools,
    ...(reasoningEffort ? { thinkingLevel: reasoningEffort } : {}),
    ...(resolvedEnv.MAKA_SYSTEM_PROMPT !== undefined
      ? { systemPrompt: resolvedEnv.MAKA_SYSTEM_PROMPT }
      : {}),
    ...(economyTaskMode !== undefined ? { economyTaskMode } : {}),
  };
  let config: Config;
  let registerBackends = options.registerBackends;
  let providerEnvFetch: ProviderEnvFetch | undefined;

  switch (backend) {
    case 'ai-sdk': {
      const modelSpec = parseModelSpec(
        resolvedEnv.MAKA_MODEL ?? resolvedEnv.HARBOR_MODEL ?? 'deepseek/deepseek-v4-flash',
        resolvedEnv.MAKA_PROVIDER,
      );
      config = {
        ...baseConfig,
        llmConnectionSlug: resolvedEnv.MAKA_LLM_CONNECTION_SLUG ?? modelSpec.provider,
        model: modelSpec.model,
      };
      if (!registerBackends) {
        providerEnvFetch = createProviderEnvFetch(resolvedEnv);
        registerBackends = buildAiSdkCellBackendRegistration({
          provider: modelSpec.provider,
          model: modelSpec.model,
          env: resolvedEnv,
          now,
          newId,
          ...(providerEnvFetch ? { fetch: providerEnvFetch.fetch } : {}),
          ...(maxSteps !== undefined ? { maxSteps } : {}),
          recordUsageCheckpoint: (usage) => writeHarborCellUsageCheckpoint(outputDir, usage),
        });
      }
      break;
    }
    case 'pi-agent': {
      const model = resolvedEnv.MAKA_PI_MODEL ?? resolvedEnv.MAKA_MODEL ?? resolvedEnv.HARBOR_MODEL;
      if (!model)
        throw new Error('MAKA_PI_MODEL, MAKA_MODEL, or HARBOR_MODEL must include a model id');
      const piProvider = resolvedEnv.MAKA_PI_PROVIDER;
      if (!registerBackends && !piProvider) {
        throw new Error('MAKA_PI_PROVIDER is required when using the default Pi CLI transport');
      }
      config = {
        ...baseConfig,
        llmConnectionSlug: resolvedEnv.MAKA_LLM_CONNECTION_SLUG ?? piProvider ?? 'pi-agent',
        model,
      };
      registerBackends ??= (registry) => {
        registry.register(
          'pi-agent',
          (ctx) =>
            new PiAgentBackend({
              sessionId: ctx.sessionId,
              header: ctx.header,
              appendMessage:
                ctx.appendMessage ?? ((message) => ctx.store.appendMessage(ctx.sessionId, message)),
              transport: new PiCliJsonTransport({
                command: resolvedEnv.MAKA_PI_COMMAND ?? 'pi',
                ...(piProvider ? { provider: piProvider } : {}),
                model,
                env: buildPiCliEnv(resolvedEnv, piProvider),
              }),
            }),
        );
      };
      break;
    }
    case 'fake':
      config = {
        ...baseConfig,
        llmConnectionSlug: resolvedEnv.MAKA_LLM_CONNECTION_SLUG ?? 'fake',
        model: resolvedEnv.MAKA_MODEL ?? resolvedEnv.HARBOR_MODEL ?? 'fake',
      };
      break;
  }

  try {
    return await runHarborCell({
      config,
      instruction: await instructionFromEnv(resolvedEnv),
      cwd: resolvedEnv.MAKA_WORKDIR ?? process.cwd(),
      outputDir,
      storageRoot,
      pricingProfile: resolvedEnv.MAKA_TRIAL_PRICING_SOURCE ?? 'unconfigured',
      ...(contextBudgetPolicy ? { contextBudgetPolicy } : {}),
      ...(continuationPolicy ? { continuationPolicy } : {}),
      ...(taskLedgerExperimentPolicy ? { taskToolSummaryEnabled: true } : {}),
      ...(settleAfterMs !== undefined ? { settleAfterMs } : {}),
      ...(registerBackends ? { registerBackends } : {}),
      ...(backendNeedsIsolation(backend)
        ? {
            realBackendIsolation: {
              kind: 'external',
              label: 'Harbor task container',
              toolExecutor: createHarborCellLocalToolExecutor(resolvedEnv),
            },
          }
        : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.newId ? { newId: options.newId } : {}),
    });
  } finally {
    await providerEnvFetch?.close();
  }
}

export function reasoningEffortFromEnv(
  value: string | undefined,
): import('@maka/core').ThinkingLevel | undefined {
  if (value === undefined || value === '') return undefined;
  if (!isThinkingLevel(value)) throw new Error(`unsupported MAKA_REASONING_EFFORT: ${value}`);
  return value;
}

function economyTaskModeFromEnv(value: string | undefined): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

export function buildHarborCellContinuationPolicy(
  env: RunHarborCellEnv = process.env,
): HarborCellContinuationPolicy | undefined {
  const enabled = booleanEnv(env.MAKA_HARBOR_CONTINUATION, 'MAKA_HARBOR_CONTINUATION') ?? false;
  if (!enabled) return undefined;
  const maxTurns =
    positiveIntEnv(env.MAKA_HARBOR_CONTINUATION_MAX_TURNS, 'MAKA_HARBOR_CONTINUATION_MAX_TURNS') ??
    3;
  return {
    enabled: true,
    maxTurns,
    maxTotalRuntimeSteps:
      positiveIntEnv(
        env.MAKA_HARBOR_CONTINUATION_MAX_TOTAL_RUNTIME_STEPS,
        'MAKA_HARBOR_CONTINUATION_MAX_TOTAL_RUNTIME_STEPS',
      ) ?? maxTurns * HARBOR_CELL_DEFAULT_MAX_STEPS_PER_TURN,
    prompt: env.MAKA_HARBOR_CONTINUATION_PROMPT ?? HARBOR_CELL_DEFAULT_CONTINUATION_PROMPT,
  };
}

export function harborCellMaxStepsFromEnv(env: RunHarborCellEnv = process.env): number | undefined {
  return positiveIntEnv(env.MAKA_MAX_STEPS, 'MAKA_MAX_STEPS');
}

export function harborCellSoftTimeoutMsFromEnv(
  env: RunHarborCellEnv = process.env,
): number | undefined {
  const value = positiveIntEnv(env.MAKA_CELL_SOFT_TIMEOUT_MS, 'MAKA_CELL_SOFT_TIMEOUT_MS');
  if (value !== undefined && value > MAX_NODE_TIMER_MS) {
    throw new Error(`MAKA_CELL_SOFT_TIMEOUT_MS must not exceed ${MAX_NODE_TIMER_MS}`);
  }
  return value;
}

function isToolCallStepCap(invocation: InvocationResult): boolean {
  return (
    invocation.failure?.class === 'tool_step_cap_reached' ||
    invocation.failure?.class === 'incomplete_tool_calls'
  );
}

function buildContinuationSummary(
  policy: HarborCellContinuationPolicy,
  invocations: readonly InvocationResult[],
  stepCapHits: number,
): HarborCellContinuationSummary {
  const turns = invocations.map((invocation, index) => continuationTurnSummary(invocation, index));
  const runtimeSteps = turns.reduce((sum, turn) => sum + turn.runtimeSteps, 0);
  return {
    enabled: policy.enabled,
    maxTurns: policy.maxTurns,
    maxTotalRuntimeSteps: policy.maxTotalRuntimeSteps,
    turnsUsed: invocations.length,
    continuedTurns: Math.max(0, invocations.length - 1),
    stepCapHits,
    capExhausted:
      stepCapHits > 0 &&
      isToolCallStepCap(invocations[invocations.length - 1]!) &&
      (invocations.length >= policy.maxTurns || runtimeSteps >= policy.maxTotalRuntimeSteps),
    totalRuntimeSteps: runtimeSteps,
    turns,
  };
}

function totalRuntimeSteps(invocations: readonly InvocationResult[]): number {
  return invocations.reduce((sum, candidate) => sum + invocationRuntimeSteps(candidate), 0);
}

function continuationTurnSummary(
  invocation: InvocationResult,
  turnIndex: number,
): HarborCellContinuationTurnSummary {
  return {
    turnIndex,
    status: invocation.status,
    stepCapHit: isToolCallStepCap(invocation),
    runtimeSteps: invocationRuntimeSteps(invocation),
  };
}

function invocationRuntimeSteps(invocation: InvocationResult): number {
  return countRuntimeSteps(invocation.events);
}

function failedInvocationFromError(
  error: unknown,
  input: {
    newId: () => string;
    now: () => number;
    sessionId: string;
    turnId: string;
  },
): InvocationResult {
  const ts = input.now();
  const failureClass = error instanceof Error ? error.name : 'Error';
  return {
    invocationId: input.newId(),
    sessionId: input.sessionId,
    runId: input.newId(),
    turnId: input.turnId,
    status: 'failed',
    failure: {
      class: failureClass,
      message: error instanceof Error ? error.message : String(error),
    },
    events: [],
    startedAt: ts,
    finishedAt: ts,
  };
}

function failedDeadlineInvocationFromRun(
  run: AgentRunHeader,
  events: RuntimeEvent[],
): InvocationResult {
  let terminal: RuntimeEvent | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const candidate = events[index]!;
    if (!isTerminalRuntimeEvent(candidate)) continue;
    terminal = candidate;
    break;
  }
  const terminalStatus =
    terminal?.status === 'completed' ? 'cancelled' : (terminal?.status ?? 'cancelled');
  const message = terminal?.content?.kind === 'error' ? terminal.content.message : undefined;
  return {
    invocationId: run.invocationId ?? events[0]?.invocationId ?? run.runId,
    runId: run.runId,
    sessionId: run.sessionId,
    turnId: run.turnId,
    status: 'failed',
    failure: {
      class: terminalStatus,
      ...(message ? { message } : {}),
      terminalStatus,
    },
    events,
    startedAt: run.createdAt,
    finishedAt: run.completedAt ?? run.updatedAt,
  };
}

export function buildAiSdkCellBackendRegistration(input: {
  provider: ProviderType;
  model: string;
  env: RunHarborCellEnv;
  now: () => number;
  newId: () => string;
  fetch?: typeof globalThis.fetch;
  maxSteps?: number;
  recordUsageCheckpoint?: (usage: HarborCellUsageCheckpoint) => void | Promise<void>;
}): NonNullable<RunHarborCellInput['registerBackends']> {
  const { connection, apiKey } = resolveHarborCellAiSdkEnv({
    provider: input.provider,
    model: input.model,
    env: input.env,
    ts: input.now(),
  });
  const nativeWebSearchEnabled =
    booleanEnv(input.env.MAKA_WEB_SEARCH_ENABLED, 'MAKA_WEB_SEARCH_ENABLED') ?? false;
  const modelKey = `${connection.providerType}:${input.model}`;
  const pricingOverride = resolveHarborCellPricingOverride(input.env, modelKey);
  const lookupPricing = pricingOverride
    ? (key: string): PricingConfig | null =>
        key === modelKey ? pricingOverride : getBuiltinPricing(key)
    : getBuiltinPricing;
  const contextBudgetBackendOptions = buildHarborCellContextBudgetBackendOptions(input.env);
  const streamConnectTimeoutMs = positiveIntEnv(
    input.env.MAKA_STREAM_CONNECT_TIMEOUT_MS,
    'MAKA_STREAM_CONNECT_TIMEOUT_MS',
  );
  const streamIdleTimeoutMs = positiveIntEnv(
    input.env.MAKA_STREAM_IDLE_TIMEOUT_MS,
    'MAKA_STREAM_IDLE_TIMEOUT_MS',
  );
  const synthesisCacheEnabled =
    contextBudgetBackendOptions.contextBudget?.synthesisCache?.enabled === true;
  const taskLedgerExperimentPolicy = buildHarborCellTaskLedgerExperimentPolicy(input.env);
  const taskLedgerExperimentStore = taskLedgerExperimentPolicy
    ? createInMemoryTaskLedgerExperimentStore({ now: input.now, newId: input.newId })
    : undefined;
  const backendUsageCheckpoints = new Map<symbol, HarborCellUsageCheckpoint>();
  let usageCheckpointQueue = Promise.resolve();
  return (registry, context) => {
    if (!context.toolExecutor) {
      throw new Error('Harbor ai-sdk backend requires an isolated tool executor');
    }
    if (!context.productToolSurface) {
      throw new Error('Harbor ai-sdk backend requires the projected product-tool surface');
    }
    // Artifact consumers share the same lease-bound store and metadata index.
    const artifactStore = context.artifactStore;
    const synthesisCacheCallbacks = buildHarborCellSynthesisCacheCallbacks(
      artifactStore,
      synthesisCacheEnabled,
    );
    registry.register('ai-sdk', (ctx) => {
      const backendUsageKey = Symbol('harbor-cell-backend-usage');
      const subscriptionFetch = buildSubscriptionModelFetch({
        connection,
        sessionId: ctx.sessionId,
        modelId: input.model,
        ...(input.fetch ? { fetchFn: input.fetch } : {}),
      });
      const providerFetch = subscriptionFetch ?? input.fetch;
      const routedTools = routeWebSearchTools({
        tools: ctx.tools ?? context.productToolSurface!.tools,
        settings: {
          enabled: nativeWebSearchEnabled,
          defaultProvider: 'model',
        },
        connection,
        model: input.model,
        allowAddNative: ctx.tools === undefined,
      });
      const productToolSurface = projectEffectiveProductToolSurface({
        host: 'headless',
        tools: routedTools,
        policy: context.productToolSurface!.identity.policy,
      });
      const productTools = [...productToolSurface.tools];
      const supplementalTools = ctx.tools
        ? []
        : buildIsolatedHeadlessSupplementalTools({
            ...(context.heavyTaskProgress ? { heavyTaskProgress: context.heavyTaskProgress } : {}),
            ...(context.heavyTaskSelfCheck
              ? { heavyTaskSelfCheck: context.heavyTaskSelfCheck }
              : {}),
            ...(taskLedgerExperimentStore && taskLedgerExperimentPolicy
              ? { taskLedgerExperiment: { store: taskLedgerExperimentStore } }
              : {}),
          });
      const tools = [...productTools, ...supplementalTools];
      const admitsAgentChildren = productToolSurface.boundSurfaceIds.includes(AGENT_TOOL_GROUP_ID);
      return new AiSdkBackend({
        sessionId: ctx.sessionId,
        header: { ...ctx.header, model: input.model },
        appendMessage:
          ctx.appendMessage ?? ((message) => ctx.store.appendMessage(ctx.sessionId, message)),
        readExecutionBoundary: () => ctx.store.readExecutionBoundary(ctx.sessionId),
        connection,
        apiKey,
        modelId: input.model,
        modelFactory: (modelInput) =>
          getAIModel({
            ...modelInput,
            ...(providerFetch ? { fetch: providerFetch } : {}),
          }),
        tools,
        toolAvailability: productToolSurface.toolAvailability,
        ...(admitsAgentChildren
          ? {
              spawnChildAgent: context.spawnChildAgent
                ? (childInput) => context.spawnChildAgent!(ctx.sessionId, childInput)
                : undefined,
              spawnChildSession: context.spawnChildSession
                ? (childInput) =>
                    context.spawnChildSession!(ctx.sessionId, {
                      spawnedBy: {
                        parentRunId: childInput.parentRunId,
                        parentTurnId: childInput.parentTurnId,
                        toolCallId: childInput.toolCallId,
                      },
                      agentProfile: childInput.agentProfile,
                      prompt: childInput.prompt,
                      ...(childInput.swarm ? { swarm: childInput.swarm } : {}),
                      abortSignal: childInput.abortSignal,
                      ...(childInput.onReady ? { onReady: childInput.onReady } : {}),
                      ...(childInput.onEvent ? { onEvent: childInput.onEvent } : {}),
                    })
                : undefined,
              prepareChildAgentResume: context.prepareChildAgentResume
                ? (sourceRunId) => context.prepareChildAgentResume!(ctx.sessionId, sourceRunId)
                : undefined,
              resumeChildAgent: context.resumeChildAgent
                ? (childInput) => context.resumeChildAgent!(ctx.sessionId, childInput)
                : undefined,
              retryChildAgent: context.retryChildAgent
                ? (childInput) => context.retryChildAgent!(ctx.sessionId, childInput)
                : undefined,
              listChildAgents: context.listChildAgents
                ? () => context.listChildAgents!(ctx.sessionId)
                : undefined,
              readChildAgentOutput: context.readChildAgentOutput
                ? (childInput) => context.readChildAgentOutput!(ctx.sessionId, childInput)
                : undefined,
            }
          : {}),
        providerOptions: buildProviderOptions(connection, input.model, ctx.header.thinkingLevel),
        supportsVision: resolveModelVisionSupport(
          connection.providerType,
          connection.models,
          input.model,
        ),
        readAttachmentBytes: createAttachmentByteReader({
          artifactStore,
          sessionId: ctx.sessionId,
        }),
        ...(streamConnectTimeoutMs !== undefined ? { streamConnectTimeoutMs } : {}),
        ...(streamIdleTimeoutMs !== undefined ? { streamIdleTimeoutMs } : {}),
        systemPrompt: ctx.systemPrompt ?? context.config.systemPrompt,
        ...(taskLedgerExperimentStore && taskLedgerExperimentPolicy
          ? {
              turnTailPrompt: async ({ sessionId }) =>
                renderTaskLedgerExperimentReplay(await taskLedgerExperimentStore.list(sessionId), {
                  maxChars: taskLedgerExperimentPolicy.replayMaxChars,
                }),
            }
          : {}),
        lookupPricing,
        ...contextBudgetBackendOptions,
        ...synthesisCacheCallbacks,
        ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
        newId: input.newId,
        now: input.now,
        recordRunTrace: ctx.recordRunTrace,
        // The canonical metering sink (#1679); the controller has always
        // exposed it, this composition just never passed it through.
        ...(ctx.recordModelCallAttempt
          ? { recordModelCallAttempt: ctx.recordModelCallAttempt }
          : {}),
        ...(ctx.recordProviderRequestCapture
          ? {
              recordProviderRequestCapture: createProviderRequestCaptureRecorder({
                persistArtifact: async (capture) => {
                  const artifact = await persistProviderRequestCaptureArtifact(artifactStore, {
                    sessionId: ctx.sessionId,
                    turnId: capture.turnId,
                    captureId: capture.captureId,
                    step: capture.step,
                    serializedRequest: capture.serializedRequest,
                    now: input.now(),
                  });
                  return { artifactId: artifact.id };
                },
                recordLedger: ctx.recordProviderRequestCapture,
              }),
              recordProviderRequestAttempt: ctx.recordProviderRequestAttempt,
            }
          : {}),
        recordActiveFullCompactBlock: ctx.recordActiveFullCompactBlock,
        recordSemanticCompactBlock: ctx.recordSemanticCompactBlock,
        loadTurnRuntimeEvents: ctx.loadTurnRuntimeEvents,
        allowMidTurnHistoryCompaction: ctx.allowMidTurnHistoryCompaction,
        ...(input.recordUsageCheckpoint
          ? {
              recordUsageCheckpoint: (usage: HarborCellUsageCheckpoint) => {
                const update = usageCheckpointQueue.then(async () => {
                  backendUsageCheckpoints.set(backendUsageKey, usage);
                  await input.recordUsageCheckpoint!(
                    aggregateHarborCellUsageCheckpoints(backendUsageCheckpoints.values()),
                  );
                });
                usageCheckpointQueue = update.catch(() => {});
                return update;
              },
            }
          : {}),
      });
    });
  };
}

export const buildHarborAiSdkBackendRegistration = buildAiSdkCellBackendRegistration;

function aggregateHarborCellUsageCheckpoints(
  checkpoints: Iterable<HarborCellUsageCheckpoint>,
): HarborCellUsageCheckpoint {
  let aggregate: HarborCellUsageCheckpoint | undefined;
  for (const checkpoint of checkpoints) {
    if (!aggregate) {
      aggregate = { ...checkpoint };
      continue;
    }
    aggregate = {
      inputTokens: aggregate.inputTokens + checkpoint.inputTokens,
      outputTokens: aggregate.outputTokens + checkpoint.outputTokens,
      cacheHitInputTokens: aggregate.cacheHitInputTokens + checkpoint.cacheHitInputTokens,
      cacheMissInputTokens: aggregate.cacheMissInputTokens + checkpoint.cacheMissInputTokens,
      cacheMissInputSource:
        aggregate.cacheMissInputSource === 'explicit' ||
        checkpoint.cacheMissInputSource === 'explicit'
          ? 'explicit'
          : 'derived',
      cacheWriteInputTokens: aggregate.cacheWriteInputTokens + checkpoint.cacheWriteInputTokens,
      reasoningTokens: aggregate.reasoningTokens + checkpoint.reasoningTokens,
      totalTokens: aggregate.totalTokens + checkpoint.totalTokens,
      ...(aggregate.costUsd !== undefined && checkpoint.costUsd !== undefined
        ? { costUsd: aggregate.costUsd + checkpoint.costUsd }
        : {}),
    };
  }
  if (!aggregate) throw new Error('cannot aggregate an empty Harbor usage checkpoint set');
  return aggregate;
}

export async function writeHarborCellUsageCheckpoint(
  outputDir: string,
  usage: HarborCellUsageCheckpoint,
): Promise<void> {
  if (usage.costUsd === undefined) return;
  const tokenSummary: HarborCellOutput['tokenSummary'] = {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cachedInput: usage.cacheHitInputTokens,
    cacheHitInput: usage.cacheHitInputTokens,
    cacheMissInput: usage.cacheMissInputTokens,
    cacheWriteInput: usage.cacheWriteInputTokens,
    cacheMissInputSource: usage.cacheMissInputSource,
    reasoning: usage.reasoningTokens,
    total: usage.totalTokens,
    costUsd: usage.costUsd,
    pricingSource: 'runtime',
  };
  await mkdir(outputDir, { recursive: true });
  const path = join(outputDir, HARBOR_CELL_USAGE_CHECKPOINT_FILENAME);
  await writeHarborCellArtifact(path, `${JSON.stringify(tokenSummary, null, 2)}\n`);
}

async function writeHarborCellArtifact(path: string, contents: string): Promise<void> {
  const pendingPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(pendingPath, contents, { encoding: 'utf8', flush: true });
    await rename(pendingPath, path);
  } finally {
    await rm(pendingPath, { force: true });
  }
}

function buildHarborCellSynthesisCacheCallbacks(
  artifactStore: SynthesisCacheArtifactStore,
  enabled: boolean,
): { loadSynthesisCache?: SynthesisCacheLoader; writeSynthesisCache?: SynthesisCacheWriter } {
  if (!enabled) return {};
  return {
    loadSynthesisCache: (event) => loadSynthesisCacheBlocksFromArtifacts(artifactStore, event),
    writeSynthesisCache: (event) => persistSynthesisCacheBlocksToArtifacts(artifactStore, event),
  };
}

// Builtin pricing has no entry for newer DeepSeek models (e.g. deepseek-v4-flash),
// so without an override the cell would emit costUsd=0 and the controller would
// flag every task as a zero_cost_with_tokens plumbing failure. Honor the same
// MAKA_TRIAL_*_USD_PER_1M env the Python adapter (trial_pricing.py) already reads,
// so one pricing source feeds both the runtime cell cost and the Harbor trial cost.
function resolveHarborCellPricingOverride(
  env: RunHarborCellEnv,
  modelKey: string,
): PricingConfig | null {
  const inputUsdPer1M = numericEnv(env.MAKA_TRIAL_INPUT_USD_PER_1M);
  const outputUsdPer1M = numericEnv(env.MAKA_TRIAL_OUTPUT_USD_PER_1M);
  if (inputUsdPer1M === undefined || outputUsdPer1M === undefined) return null;
  const cacheReadUsdPer1M = numericEnv(env.MAKA_TRIAL_CACHE_READ_USD_PER_1M);
  const cacheWriteUsdPer1M = numericEnv(env.MAKA_TRIAL_CACHE_WRITE_USD_PER_1M);
  return {
    modelKey,
    inputUsdPer1M,
    outputUsdPer1M,
    ...(cacheReadUsdPer1M !== undefined ? { cacheReadUsdPer1M } : {}),
    ...(cacheWriteUsdPer1M !== undefined ? { cacheWriteUsdPer1M } : {}),
  };
}

function buildPiCliEnv(env: RunHarborCellEnv, provider: string | undefined): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  copyEnv(result, { ...process.env, ...env }, PI_BASE_ENV_KEYS);
  copyPrefixedEnv(result, env, 'PI_');

  const normalizedProvider = provider?.toLowerCase() ?? '';
  const rule = PI_PROVIDER_ENV_RULES.find((candidate) =>
    candidate.includes.some((value) => normalizedProvider.includes(value)),
  );
  copyEnv(result, env, rule?.keys ?? []);
  for (const prefix of rule?.prefixes ?? []) copyPrefixedEnv(result, env, prefix);

  return result;
}

function copyPrefixedEnv(
  target: NodeJS.ProcessEnv,
  source: RunHarborCellEnv,
  prefix: string,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith(prefix) && value !== undefined) target[key] = value;
  }
}

function copyEnv(target: NodeJS.ProcessEnv, source: RunHarborCellEnv, keys: string[]): void {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) target[key] = value;
  }
}

async function instructionFromEnv(env: RunHarborCellEnv): Promise<string> {
  if (env.MAKA_INSTRUCTION !== undefined) return env.MAKA_INSTRUCTION;
  if (env.MAKA_INSTRUCTION_FILE) return await readFile(env.MAKA_INSTRUCTION_FILE, 'utf8');
  throw new Error('MAKA_INSTRUCTION or MAKA_INSTRUCTION_FILE is required');
}

function backendFromEnv(value: string | undefined): BackendKind {
  if (!value) return 'ai-sdk';
  if (value === 'fake' || value === 'ai-sdk' || value === 'pi-agent') return value;
  throw new Error(`unsupported MAKA_BACKEND: ${value}`);
}

function parseModelSpec(
  rawModel: string,
  rawProvider: string | undefined,
): { provider: ProviderType; model: string } {
  if (rawProvider !== undefined) {
    if (!rawModel) throw new Error('MAKA_MODEL must include a model id');
    return { provider: providerFromEnv(rawProvider), model: rawModel };
  }
  const separator = rawModel.indexOf('/');
  const [providerPart, modelPart] =
    separator >= 0
      ? [rawModel.slice(0, separator), rawModel.slice(separator + 1)]
      : ['deepseek', rawModel];
  const provider = providerFromEnv(providerPart);
  if (!modelPart) throw new Error('MAKA_MODEL must include a model id');
  return { provider, model: modelPart };
}

function runtimeEventsJsonl(invocation: InvocationResult): string {
  if (invocation.events.length === 0) return '';
  return `${invocation.events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

function randomId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `cell_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
  );
}
