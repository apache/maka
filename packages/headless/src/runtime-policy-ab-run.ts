import {
  runFixedPromptController,
  type FixedPromptTask,
  type TaskRunner,
} from './fixed-prompt-controller.js';
import { renderAbComparisonMarkdown } from './ab-render.js';
import { buildAbRunManifest, buildRunManifestFingerprint } from './ab-manifest.js';
import { runAbComparison } from './ab-run.js';
import type {
  AbArmSpec,
  AbComparisonSummary,
  AbRunManifest,
  AbRunManifestInput,
} from './ab-types.js';
import type { Config } from './contracts.js';
import { withAbRunLock } from './ab-run-lock.js';
import type { RuntimePolicyAbExecutionProfile } from './runtime-policy-ab-profile.js';
import {
  HARBOR_CELL_CONTEXT_ENV_KEYS,
  normalizeHarborCellContextEnv,
  type HarborCellContextEnvKey,
} from './harbor-cell-context-budget-env.js';

export const RUNTIME_POLICY_CONTEXT_ENV_KEYS = HARBOR_CELL_CONTEXT_ENV_KEYS;
export const RUNTIME_POLICY_SHARED_AGENT_ENV_KEYS = [
  'MAKA_HARBOR_CONTINUATION',
  'MAKA_HARBOR_CONTINUATION_MAX_TURNS',
  'MAKA_HARBOR_CONTINUATION_MAX_TOTAL_RUNTIME_STEPS',
  'MAKA_HARBOR_CONTINUATION_PROMPT',
] as const;

export type RuntimePolicyContextEnvKey = HarborCellContextEnvKey;
export type RuntimePolicySharedAgentEnvKey = (typeof RUNTIME_POLICY_SHARED_AGENT_ENV_KEYS)[number];

export interface RuntimePolicyAbArmInput {
  id: string;
  contextEnv: Partial<Record<RuntimePolicyContextEnvKey, string>>;
}

export interface RunRuntimePolicyAbComparisonInput {
  runId: string;
  runRoot: string;
  config: Config;
  systemPromptPath: string;
  resultsJsonlPath: string;
  evaluationTasks: readonly FixedPromptTask[];
  arms: readonly [RuntimePolicyAbArmInput, RuntimePolicyAbArmInput];
  reps?: number;
  executionProfile: RuntimePolicyAbExecutionProfile;
  roundIdPrefix?: string;
  resumeFingerprint?: string;
  budgetMs?: number;
  nonInferiorityMargin?: number;
  sharedAgentEnv?: Partial<Record<RuntimePolicySharedAgentEnvKey, string>>;
  harborRunner: TaskRunner;
  now?: () => number;
  newId?: () => string;
}

export type RuntimePolicyAbComparisonSummary = AbComparisonSummary;

export interface RuntimePolicyAbRunManifestInput
  extends Omit<
    AbRunManifestInput,
    | 'experimentKind'
    | 'arms'
    | 'taskBudgetSec'
    | 'harborTimeoutMs'
    | 'observedCostStopUsd'
    | 'maxConcurrency'
    | 'maxConcurrentAttempts'
  > {
  arms: readonly [RuntimePolicyAbArmInput, RuntimePolicyAbArmInput];
  promptHash: string;
  sharedAgentEnv?: Partial<Record<RuntimePolicySharedAgentEnvKey, string>>;
  executionProfile: RuntimePolicyAbExecutionProfile;
}

export type RuntimePolicyAbRunManifest = AbRunManifest;

export function buildRuntimePolicyAbRunManifest(
  input: RuntimePolicyAbRunManifestInput,
): RuntimePolicyAbRunManifest {
  const {
    arms,
    promptHash,
    executionProfile,
    sharedAgentEnv: rawSharedAgentEnv,
    ...abInput
  } = input;
  const maxConcurrency = pairConcurrency(executionProfile.maxConcurrentAttempts);
  const sharedAgentEnv = sanitizeSharedAgentEnv(rawSharedAgentEnv ?? {});
  const sharedMetadata = {
    promptHash,
    provider: executionProfile.provider,
    baseUrl: executionProfile.baseUrl,
    model: executionProfile.model,
    executionProfile,
    sharedAgentEnv,
  };
  return buildAbRunManifest({
    ...abInput,
    taskBudgetSec: executionProfile.taskBudgetSec,
    harborTimeoutMs: executionProfile.harborTimeoutMs,
    observedCostStopUsd: executionProfile.observedCostStopUsd,
    maxConcurrency,
    maxConcurrentAttempts: executionProfile.maxConcurrentAttempts,
    experimentKind: 'runtime',
    arms: [runtimeArmSpec(arms[0], sharedMetadata), runtimeArmSpec(arms[1], sharedMetadata)],
  });
}

export async function runRuntimePolicyAbComparison(
  input: RunRuntimePolicyAbComparisonInput,
): Promise<RuntimePolicyAbComparisonSummary> {
  return withAbRunLock(input.runRoot, () => runRuntimePolicyAbComparisonUnlocked(input));
}

export async function runRuntimePolicyAbComparisonUnlocked(
  input: RunRuntimePolicyAbComparisonInput,
): Promise<RuntimePolicyAbComparisonSummary> {
  assertProfileIdentity(input.executionProfile, input.config);
  const maxConcurrency = pairConcurrency(input.executionProfile.maxConcurrentAttempts);
  const sharedAgentEnv = sanitizeSharedAgentEnv(input.sharedAgentEnv ?? {});
  return runAbComparison({
    runId: input.runId,
    arms: [runtimeArmSpec(input.arms[0]), runtimeArmSpec(input.arms[1])],
    evaluationTasks: input.evaluationTasks,
    ...(input.reps !== undefined ? { reps: input.reps } : {}),
    maxConcurrency,
    observedCostStopUsd: input.executionProfile.observedCostStopUsd,
    ...(input.roundIdPrefix ? { roundIdPrefix: input.roundIdPrefix } : {}),
    ...(input.budgetMs !== undefined ? { budgetMs: input.budgetMs } : {}),
    ...(input.nonInferiorityMargin !== undefined
      ? { nonInferiorityMargin: input.nonInferiorityMargin }
      : {}),
    runArm: async ({ roundId, arm, task }) => {
      const runtimeArm = input.arms.find((candidate) => candidate.id === arm.id);
      if (!runtimeArm) throw new Error(`runtime policy A/B arm ${arm.id} is not configured`);
      const contextEnv = sanitizeContextEnv(runtimeArm.contextEnv);
      const resumeFingerprint = runtimePolicyArmResumeFingerprint(input, runtimeArm);
      const agentEnv = { ...sharedAgentEnv, ...contextEnv };
      const result = await runFixedPromptController({
        runId: input.runId,
        roundId,
        config: input.config,
        systemPromptPath: input.systemPromptPath,
        resultsJsonlPath: input.resultsJsonlPath,
        resultsTsvPath: `${input.resultsJsonlPath}.${roundId}.tsv`,
        tasks: [task],
        requireExecutionIdentity: true,
        expectedPricingProfile: input.executionProfile.id,
        ...(input.executionProfile.billingMode
          ? { billingMode: input.executionProfile.billingMode }
          : {}),
        resumeFingerprint,
        taskRunner: (runnerInput) => input.harborRunner({ ...runnerInput, agentEnv }),
        ...(input.now ? { now: input.now } : {}),
        ...(input.newId ? { newId: input.newId } : {}),
      });
      const event = result.events.find((candidate) => candidate.taskId === task.id);
      if (!event)
        throw new Error(`runtime policy A/B arm ${roundId} produced no event for ${task.id}`);
      return event;
    },
  });
}

function pairConcurrency(maxConcurrentAttempts: number): number {
  if (
    !Number.isSafeInteger(maxConcurrentAttempts) ||
    maxConcurrentAttempts < 2 ||
    maxConcurrentAttempts % 2 !== 0
  ) {
    throw new Error(
      'maxConcurrentAttempts must be an even integer of at least 2 so each A/B pair starts together',
    );
  }
  return maxConcurrentAttempts / 2;
}

function assertProfileIdentity(
  profile: RuntimePolicyAbExecutionProfile,
  config: Pick<Config, 'llmConnectionSlug' | 'model'>,
): void {
  if (config.llmConnectionSlug !== profile.llmConnectionSlug || config.model !== profile.model) {
    throw new Error(`runtime policy A/B config must match execution profile ${profile.id}`);
  }
}

export function renderRuntimePolicyAbComparisonMarkdown(
  summary: RuntimePolicyAbComparisonSummary,
): string {
  return renderAbComparisonMarkdown(summary).replace(
    '# A/B Comparison',
    '# Runtime Policy A/B Comparison',
  );
}

function runtimeArmSpec(
  arm: RuntimePolicyAbArmInput,
  sharedMetadata: Record<string, unknown> = {},
): AbArmSpec {
  const contextEnv = sanitizeContextEnv(arm.contextEnv);
  return {
    id: arm.id,
    kind: 'runtime' as const,
    fingerprint: contextEnvFingerprint(contextEnv),
    metadata: { ...sharedMetadata, contextEnv },
  };
}

function sanitizeContextEnv(
  env: Partial<Record<RuntimePolicyContextEnvKey, string>>,
):
  | Record<RuntimePolicyContextEnvKey, string>
  | Partial<Record<RuntimePolicyContextEnvKey, string>> {
  for (const key of Object.keys(env)) {
    if (!key.startsWith('MAKA_CONTEXT_'))
      throw new Error(`unsupported runtime policy env key: ${key}`);
  }
  return normalizeHarborCellContextEnv(env);
}

function sanitizeSharedAgentEnv(
  env: Partial<Record<RuntimePolicySharedAgentEnvKey, string>>,
): Partial<Record<RuntimePolicySharedAgentEnvKey, string>> {
  const allowed = new Set<string>(RUNTIME_POLICY_SHARED_AGENT_ENV_KEYS);
  const result: Partial<Record<RuntimePolicySharedAgentEnvKey, string>> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!allowed.has(key)) {
      throw new Error(`unsupported runtime policy shared agent env key: ${key}`);
    }
    if (value !== undefined) {
      result[key as RuntimePolicySharedAgentEnvKey] = value;
    }
  }
  return result;
}

function contextEnvFingerprint(env: Partial<Record<RuntimePolicyContextEnvKey, string>>): string {
  return buildRunManifestFingerprint(sanitizeContextEnv(env));
}

function sharedAgentEnvFingerprint(
  env: Partial<Record<RuntimePolicySharedAgentEnvKey, string>>,
): string {
  return buildRunManifestFingerprint(sanitizeSharedAgentEnv(env));
}

function runtimePolicySharedConfigFingerprint(config: Config): string {
  const { systemPrompt: _systemPrompt, ...effectiveConfig } = config;
  return buildRunManifestFingerprint(effectiveConfig);
}

function runtimePolicyExecutionFingerprint(profile: RuntimePolicyAbExecutionProfile): string {
  const {
    observedCostStopUsd: _observedCostStopUsd,
    maxConcurrentAttempts: _maxConcurrentAttempts,
    ...cellSemantics
  } = profile;
  return buildRunManifestFingerprint(cellSemantics);
}

function runtimePolicyResumeFingerprint(input: {
  sharedConfigFingerprint: string;
  executionProfileFingerprint: string;
  sharedAgentEnvFingerprint: string;
  armContextEnvFingerprint: string;
  callerResumeFingerprint?: string;
}): string {
  return buildRunManifestFingerprint({
    version: 'maka-runtime-policy-resume-v2',
    sharedConfigFingerprint: input.sharedConfigFingerprint,
    executionProfileFingerprint: input.executionProfileFingerprint,
    sharedAgentEnvFingerprint: input.sharedAgentEnvFingerprint,
    armContextEnvFingerprint: input.armContextEnvFingerprint,
    callerResumeFingerprint: input.callerResumeFingerprint,
  });
}

export function runtimePolicyArmResumeFingerprint(
  input: Pick<
    RunRuntimePolicyAbComparisonInput,
    'config' | 'executionProfile' | 'sharedAgentEnv' | 'resumeFingerprint'
  >,
  arm: RuntimePolicyAbArmInput,
): string {
  return runtimePolicyResumeFingerprint({
    sharedConfigFingerprint: runtimePolicySharedConfigFingerprint(input.config),
    executionProfileFingerprint: runtimePolicyExecutionFingerprint(input.executionProfile),
    sharedAgentEnvFingerprint: sharedAgentEnvFingerprint(
      sanitizeSharedAgentEnv(input.sharedAgentEnv ?? {}),
    ),
    armContextEnvFingerprint: contextEnvFingerprint(sanitizeContextEnv(arm.contextEnv)),
    callerResumeFingerprint: input.resumeFingerprint,
  });
}
