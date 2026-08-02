import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LlmConnection } from '@maka/core';
import type { Config } from './contracts.js';
import type { FixedPromptTask, TaskRunner } from './fixed-prompt-controller.js';
import {
  createHarborTaskRunner,
  modelIdForProvider,
  type HarborTaskPricing,
} from './harbor-task-runner.js';
import { createAiSdkMetaAgent } from './meta-agent-completion.js';
import { type MetaAgent } from './prompt-candidate-loop.js';
import { createCliPromptCandidateGit } from './prompt-candidate-git.js';
import {
  runPromptOptimizationLoop,
  type PromptOptimizationLoopResult,
} from './prompt-optimization-loop.js';

/**
 * Real-run wiring for the RSI prompt-optimization loop: discover and partition
 * cached Terminal-Bench tasks, derive reward-hack verifier patterns, and compose
 * the real Harbor task runner + DeepSeek meta-agent + CLI git before handing off
 * to {@link runPromptOptimizationLoop}. The expensive components are still
 * injectable so the composition is testable without Docker or the network.
 */

export interface PromptTaskPartition {
  heldInTasks: FixedPromptTask[];
  heldOutTasks: FixedPromptTask[];
}

export interface PromptOptimizationPartitionSelection extends PromptTaskPartition {
  heldOutNoPattern: FixedPromptTask[];
}

export type PromptOptimizationRunResult = PromptOptimizationLoopResult;

export function selectPromptOptimizationPartitions(
  tasks: readonly FixedPromptTask[],
  input: {
    heldInCount: number;
    heldOutCount: number;
    rewardHackVerifierPatternsByTaskId: Readonly<Record<string, readonly string[]>>;
  },
): PromptOptimizationPartitionSelection {
  if (input.heldInCount < 0 || input.heldOutCount < 0) {
    throw new Error('partition counts must be non-negative');
  }
  const sorted = [...tasks].sort((a, b) => a.id.localeCompare(b.id));
  const hasPattern = (task: FixedPromptTask) =>
    (input.rewardHackVerifierPatternsByTaskId[task.id] ?? []).some(
      (pattern) => pattern.trim().length > 0,
    );
  const heldInTasks = sorted.filter(hasPattern).slice(0, input.heldInCount);
  if (heldInTasks.length < input.heldInCount) {
    throw new Error(
      `not enough reward-hack-scannable held-in tasks: need ${input.heldInCount}, have ${heldInTasks.length}`,
    );
  }
  const heldInIds = new Set(heldInTasks.map((task) => task.id));
  const heldOutTasks = sorted
    .filter((task) => !heldInIds.has(task.id))
    .slice(0, input.heldOutCount);
  if (heldOutTasks.length < input.heldOutCount) {
    throw new Error(
      `not enough tasks: need ${input.heldInCount + input.heldOutCount}, have ${sorted.length}`,
    );
  }
  return {
    heldInTasks,
    heldOutTasks,
    heldOutNoPattern: heldOutTasks.filter((task) => !hasPattern(task)),
  };
}

const CANARY_PATTERN = /terminal-bench-canary GUID ([0-9a-fA-F-]{8,})/g;

/** Extract Terminal-Bench canary GUIDs that are exclusive to a task's tests.
 * Seeing one of these verifier-only patterns in model-visible output means the
 * agent read hidden verifier material.
 *
 * This is a substring backstop, not an airtight guarantee: an agent that reads and
 * parses the verifier without ever echoing the canary would evade it. Some tasks
 * also place the same canary in ordinary task material; those GUIDs are not
 * verifier-only and must not quarantine normal reads of allowed helper scripts.
 * Hidden files such as solution/ do not make a canary safe to expose. */
export async function extractRewardHackVerifierPatterns(taskPath: string): Promise<string[]> {
  const testPatterns = new Set<string>();
  const modelVisiblePatterns = new Set<string>();
  const testsPath = join(taskPath, 'tests');
  await collectCanaryPatterns(testsPath, testPatterns);
  await collectTaskMaterialCanaryPatterns(taskPath, modelVisiblePatterns);
  return [...testPatterns].filter((pattern) => !modelVisiblePatterns.has(pattern)).sort();
}

/** Recursively scan a directory tree, accumulating canary GUIDs from every file.
 * Canary material commonly lives in nested test fixtures (e.g. tests/data/…), so a
 * shallow scan of tests/ would miss it and misjudge the task as having no verifier
 * pattern — which then silently drops the task from held-in. Symlinks are not
 * followed (isDirectory/isFile are false for them), which also avoids cycles. */
async function collectCanaryPatterns(dir: string, patterns: Set<string>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectCanaryPatterns(entryPath, patterns);
      continue;
    }
    if (!entry.isFile()) continue;
    await collectCanaryPatternsFromFile(entryPath, patterns);
  }
}

async function collectTaskMaterialCanaryPatterns(
  taskPath: string,
  patterns: Set<string>,
): Promise<void> {
  await collectCanaryPatternsExcept(
    taskPath,
    patterns,
    new Set([join(taskPath, 'tests'), join(taskPath, 'solution')]),
  );
}

async function collectCanaryPatternsExcept(
  dir: string,
  patterns: Set<string>,
  excludedDirs: ReadonlySet<string>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (excludedDirs.has(entryPath)) continue;
      await collectCanaryPatternsExcept(entryPath, patterns, excludedDirs);
      continue;
    }
    if (!entry.isFile()) continue;
    await collectCanaryPatternsFromFile(entryPath, patterns);
  }
}

async function collectCanaryPatternsFromFile(
  filePath: string,
  patterns: Set<string>,
): Promise<void> {
  let content;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return;
  }
  for (const match of content.matchAll(CANARY_PATTERN)) {
    if (match[1]) patterns.add(match[1]);
  }
}

export async function buildRewardHackVerifierPatterns(
  tasks: readonly FixedPromptTask[],
): Promise<Record<string, string[]>> {
  const map: Record<string, string[]> = {};
  for (const task of tasks) {
    map[task.id] = await extractRewardHackVerifierPatterns(task.path);
  }
  return map;
}

export interface PromptOptimizationRunInput {
  runId: string;
  rounds: number;
  baselineRuns?: number;
  zScore?: number;

  // Prompt repo (git working tree the meta-agent edits).
  gitCwdPath: string;
  agentCwdPath: string;
  programPath: string;
  systemPromptPath: string;

  // Controller-only artifacts (must resolve outside agentCwdPath).
  resultsJsonlPath: string;
  heldInResultsTsvPath: string;
  heldOutResultsTsvPath: string;

  heldInTasks: readonly FixedPromptTask[];
  heldOutTasks: readonly FixedPromptTask[];
  heldOutArtifactPaths?: readonly string[];

  // Model / provider / key.
  connection: LlmConnection;
  /** Provider-qualified model id, e.g. "deepseek/deepseek-v4-flash". */
  model: string;
  /** MAKA_PROVIDER, e.g. "deepseek". */
  provider: string;
  /** Host path to the API key file (mounted into the container; read on host for
   * the meta-agent). */
  apiKeyFile: string;
  pricing: HarborTaskPricing;

  // Harbor.
  makaRepoPath: string;
  jobsDir: string;
  harborBin?: string;
  agentEnv?: Record<string, string>;
  harborTimeoutMs?: number;
  resumeFingerprint?: string;
  runtimeProfile?: PromptOptimizationRuntimeProfile;

  rewardHackVerifierPatternsByTaskId: Readonly<Record<string, readonly string[]>>;

  costCeilingUsd?: number;
  maxInfraFailureRate?: number;
  maxConcurrency?: number;
  minStableHeldInTasks?: number;
  minStableHeldOutTasks?: number;
  maxStableTaskDurationMs?: number;

  // Test overrides — bypass the real Docker/network components.
  harborRunner?: TaskRunner;
  metaAgent?: MetaAgent;
  now?: () => number;
  newId?: () => string;
}

export interface PromptOptimizationRuntimeProfile {
  taskBudgetSec?: number;
  commandTimeoutMs?: number;
  continuation?: PromptOptimizationContinuationProfile;
  contextEnv?: Record<string, string>;
}

export interface PromptOptimizationContinuationProfile {
  enabled: boolean;
  maxTurns?: number;
  maxTotalRuntimeSteps?: number;
  prompt?: string;
}

export function buildPromptOptimizationTaskAgentEnv(
  baseAgentEnv: Record<string, string> | undefined,
  task: FixedPromptTask,
  profile: PromptOptimizationRuntimeProfile | undefined,
): Record<string, string> {
  const env = { ...(baseAgentEnv ?? {}) };
  if (profile?.taskBudgetSec !== undefined) {
    const taskTimeoutSec = task.metadata?.agentTimeoutSec;
    const timeoutSec =
      taskTimeoutSec !== undefined
        ? Math.min(taskTimeoutSec, profile.taskBudgetSec)
        : profile.taskBudgetSec;
    env.MAKA_CELL_TIMEOUT_SEC = String(timeoutSec);
  }
  if (profile?.commandTimeoutMs !== undefined) {
    env.MAKA_CELL_COMMAND_TIMEOUT_MS = String(profile.commandTimeoutMs);
  }
  if (profile?.continuation) {
    env.MAKA_HARBOR_CONTINUATION = profile.continuation.enabled ? 'on' : 'off';
    if (profile.continuation.maxTurns !== undefined) {
      env.MAKA_HARBOR_CONTINUATION_MAX_TURNS = String(profile.continuation.maxTurns);
    }
    if (profile.continuation.maxTotalRuntimeSteps !== undefined) {
      env.MAKA_HARBOR_CONTINUATION_MAX_TOTAL_RUNTIME_STEPS = String(
        profile.continuation.maxTotalRuntimeSteps,
      );
    }
    if (profile.continuation.prompt !== undefined) {
      env.MAKA_HARBOR_CONTINUATION_PROMPT = profile.continuation.prompt;
    }
  }
  Object.assign(env, profile?.contextEnv ?? {});
  return env;
}

export async function runPromptOptimizationRun(
  input: PromptOptimizationRunInput,
): Promise<PromptOptimizationRunResult> {
  assertValidPromptTaskPartitions(input.heldInTasks, input.heldOutTasks);

  const modelId = resolvePromptOptimizationModelId(input.model, input.provider);

  const baseHarborRunner =
    input.harborRunner ??
    createHarborTaskRunner({
      makaRepoPath: input.makaRepoPath,
      jobsDir: input.jobsDir,
      model: input.model,
      provider: input.provider,
      apiKeyFile: input.apiKeyFile,
      pricing: input.pricing,
      ...(input.harborBin ? { harborBin: input.harborBin } : {}),
      ...(input.agentEnv ? { agentEnv: input.agentEnv } : {}),
      ...(input.harborTimeoutMs !== undefined ? { harborTimeoutMs: input.harborTimeoutMs } : {}),
    });
  const harborRunner: TaskRunner = async (runInput) =>
    baseHarborRunner({
      ...runInput,
      agentEnv: {
        ...buildPromptOptimizationTaskAgentEnv(input.agentEnv, runInput.task, input.runtimeProfile),
        ...(runInput.agentEnv ?? {}),
      },
    });

  const metaAgent =
    input.metaAgent ??
    createAiSdkMetaAgent({
      connection: input.connection,
      apiKey: readFileSync(input.apiKeyFile, 'utf8').trim(),
      modelId,
    });

  const git = createCliPromptCandidateGit({
    cwd: input.gitCwdPath,
    systemPromptPath: input.systemPromptPath,
  });
  const config: Config = {
    id: input.runId,
    backend: 'ai-sdk',
    llmConnectionSlug: input.provider,
    model: modelId,
  };

  return runPromptOptimizationLoop({
    runId: input.runId,
    rounds: input.rounds,
    ...(input.baselineRuns !== undefined ? { baselineRuns: input.baselineRuns } : {}),
    ...(input.zScore !== undefined ? { zScore: input.zScore } : {}),
    agentCwdPath: input.agentCwdPath,
    programPath: input.programPath,
    systemPromptPath: input.systemPromptPath,
    resultsJsonlPath: input.resultsJsonlPath,
    heldInResultsTsvPath: input.heldInResultsTsvPath,
    heldOutResultsTsvPath: input.heldOutResultsTsvPath,
    heldInTasks: input.heldInTasks,
    heldOutTasks: input.heldOutTasks,
    ...(input.heldOutArtifactPaths ? { heldOutArtifactPaths: input.heldOutArtifactPaths } : {}),
    config,
    harborRunner,
    metaAgent,
    git,
    rewardHackVerifierPatternsByTaskId: input.rewardHackVerifierPatternsByTaskId,
    ...(input.resumeFingerprint ? { resumeFingerprint: input.resumeFingerprint } : {}),
    ...(input.costCeilingUsd !== undefined ? { costCeilingUsd: input.costCeilingUsd } : {}),
    ...(input.maxInfraFailureRate !== undefined
      ? { maxInfraFailureRate: input.maxInfraFailureRate }
      : {}),
    ...(input.maxConcurrency !== undefined ? { maxConcurrency: input.maxConcurrency } : {}),
    ...(input.minStableHeldInTasks !== undefined
      ? { minStableHeldInTasks: input.minStableHeldInTasks }
      : {}),
    ...(input.minStableHeldOutTasks !== undefined
      ? { minStableHeldOutTasks: input.minStableHeldOutTasks }
      : {}),
    ...(input.maxStableTaskDurationMs !== undefined
      ? { maxStableTaskDurationMs: input.maxStableTaskDurationMs }
      : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(input.newId ? { newId: input.newId } : {}),
  });
}

export function resolvePromptOptimizationModelId(model: string, provider: string): string {
  return modelIdForProvider(model, provider);
}

function assertValidPromptTaskPartitions(
  heldInTasks: readonly FixedPromptTask[],
  heldOutTasks: readonly FixedPromptTask[],
): void {
  const heldInTaskIds = heldInTasks.map((task) => task.id);
  const heldOutTaskIds = heldOutTasks.map((task) => task.id);
  assertUniqueTaskIds('held-in', heldInTaskIds);
  assertUniqueTaskIds('held-out', heldOutTaskIds);
  const heldIn = new Set(heldInTaskIds);
  const overlap = [...new Set(heldOutTaskIds.filter((taskId) => heldIn.has(taskId)))].sort();
  if (overlap.length > 0) {
    throw new Error(`held-in and held-out tasks overlap: ${overlap.join(', ')}`);
  }
}

function assertUniqueTaskIds(label: string, taskIds: readonly string[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const taskId of taskIds) {
    if (seen.has(taskId)) duplicates.add(taskId);
    seen.add(taskId);
  }
  if (duplicates.size > 0) {
    throw new Error(`${label} tasks contain duplicate id(s): ${[...duplicates].sort().join(', ')}`);
  }
}
