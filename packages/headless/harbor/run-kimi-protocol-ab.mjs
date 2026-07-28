#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_HEADLESS_SYSTEM_PROMPT } from '@maka/headless';
import { buildAbRunManifest, ensureAbRunManifest } from '#ab-manifest';
import { runExperiment } from '#experiment-engine';
import {
  buildSubjectFingerprint,
  buildTaskSourceFingerprint,
  buildToolchainFingerprint,
} from '#experiment-fingerprint';
import {
  discoverCachedHarborTasks,
  resolveFixedPromptRunRoot,
  selectTasksByIds,
} from '#fixed-prompt-task-source';
import { createHarborTaskRunner } from '#harbor-task-runner';
import { envIds, envPath, envPositiveInt, envRatio } from '#headless-run-env';
import {
  kimiProtocolAbArms,
  renderKimiProtocolAbMarkdown,
  runKimiProtocolAbComparison,
} from '#kimi-protocol-ab';

const PROVIDER = 'kimi-coding-plan';
const DEFAULT_MODEL = 'k3';
const DEFAULT_BASE_URL = 'https://api.kimi.com/coding/v1';
const DEFAULT_REPS = 3;
const DEFAULT_MAX_CONCURRENCY = 1;
const DEFAULT_TASK_BUDGET_SEC = 1_800;
const DEFAULT_NON_INFERIORITY_MARGIN = 0.1;
const PRICING_PROFILE = 'kimi-coding-plan-account-plan';
const SHARED_HARBOR_POLICY_ENV_KEYS = new Set([
  'MAKA_CELL_COMMAND_TIMEOUT_MS',
  'MAKA_ECONOMY_TASK_MODE',
  'MAKA_HARBOR_CONTINUATION',
  'MAKA_HARBOR_CONTINUATION_MAX_TURNS',
  'MAKA_HARBOR_CONTINUATION_MAX_TOTAL_RUNTIME_STEPS',
  'MAKA_HARBOR_CONTINUATION_PROMPT',
  'MAKA_STREAM_CONNECT_TIMEOUT_MS',
  'MAKA_STREAM_IDLE_TIMEOUT_MS',
]);

export function parseKimiProtocolAbEnv(
  env,
  repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url))),
) {
  const taskIds = envIds(env.MAKA_KIMI_PROTOCOL_AB_TASK_IDS);
  if (!taskIds) throw new Error('MAKA_KIMI_PROTOCOL_AB_TASK_IDS is required');
  const duplicates = [...new Set(taskIds.filter((id, index) => taskIds.indexOf(id) !== index))];
  if (duplicates.length > 0) {
    throw new Error(`duplicate task id(s): ${duplicates.join(', ')}`);
  }
  const reps = envPositiveInt(
    'MAKA_KIMI_PROTOCOL_AB_REPS',
    env.MAKA_KIMI_PROTOCOL_AB_REPS,
    DEFAULT_REPS,
  );
  const maxConcurrency = envPositiveInt(
    'MAKA_KIMI_PROTOCOL_AB_MAX_CONCURRENCY',
    env.MAKA_KIMI_PROTOCOL_AB_MAX_CONCURRENCY,
    DEFAULT_MAX_CONCURRENCY,
  );
  const taskBudgetSec = envPositiveInt(
    'MAKA_KIMI_PROTOCOL_AB_TASK_BUDGET_SEC',
    env.MAKA_KIMI_PROTOCOL_AB_TASK_BUDGET_SEC,
    DEFAULT_TASK_BUDGET_SEC,
  );
  const harborTimeoutMs = envPositiveInt(
    'MAKA_KIMI_PROTOCOL_AB_HARBOR_TIMEOUT_MS',
    env.MAKA_KIMI_PROTOCOL_AB_HARBOR_TIMEOUT_MS,
    undefined,
  );
  const nonInferiorityMargin = envRatio(
    'MAKA_KIMI_PROTOCOL_AB_NON_INFERIORITY_MARGIN',
    env.MAKA_KIMI_PROTOCOL_AB_NON_INFERIORITY_MARGIN,
    DEFAULT_NON_INFERIORITY_MARGIN,
  );
  return {
    repoRoot,
    makaRepoPath: envPath(
      'MAKA_KIMI_PROTOCOL_AB_MAKA_REPO',
      env.MAKA_KIMI_PROTOCOL_AB_MAKA_REPO,
      repoRoot,
    ),
    outDir: envPath('MAKA_KIMI_PROTOCOL_AB_OUT_DIR', env.MAKA_KIMI_PROTOCOL_AB_OUT_DIR),
    tasksRoot: envPath(
      'MAKA_KIMI_PROTOCOL_AB_TASKS_ROOT',
      env.MAKA_KIMI_PROTOCOL_AB_TASKS_ROOT,
      join(homedir(), '.cache/harbor/tasks'),
    ),
    keyFile: envPath(
      'MAKA_KIMI_PROTOCOL_AB_KEY_FILE',
      env.MAKA_KIMI_PROTOCOL_AB_KEY_FILE,
      join(homedir(), '.maka/secrets/kimi-coding-plan.key'),
    ),
    runId: env.MAKA_KIMI_PROTOCOL_AB_RUN_ID || `kimi-protocol-ab-${Date.now()}`,
    taskIds,
    model: env.MAKA_KIMI_PROTOCOL_AB_MODEL || DEFAULT_MODEL,
    baseUrl: env.MAKA_KIMI_PROTOCOL_AB_BASE_URL || DEFAULT_BASE_URL,
    reps,
    maxConcurrency,
    taskBudgetSec,
    harborTimeoutMs,
    nonInferiorityMargin,
    sharedAgentEnv: kimiProtocolSharedAgentEnv(env),
    dryRun: env.MAKA_KIMI_PROTOCOL_AB_DRY_RUN === '1',
  };
}

export function kimiProtocolSharedAgentEnv(env) {
  return Object.fromEntries(
    Object.entries(env)
      .filter(
        ([key, value]) =>
          typeof value === 'string' &&
          (key.startsWith('MAKA_CONTEXT_') || SHARED_HARBOR_POLICY_ENV_KEYS.has(key)),
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function main() {
  const options = parseKimiProtocolAbEnv(process.env);
  const runRoot = resolveFixedPromptRunRoot(
    options.outDir,
    options.runId,
    'MAKA_KIMI_PROTOCOL_AB_RUN_ID',
  );
  const discovered = await discoverCachedHarborTasks(options.tasksRoot, new Set(options.taskIds), {
    duplicatePolicy: 'newest',
  });
  const evaluationTasks = selectTasksByIds(discovered, options.taskIds);
  const promptHash = `sha256:${createHash('sha256')
    .update(JSON.stringify(DEFAULT_HEADLESS_SYSTEM_PROMPT))
    .digest('hex')}`;
  const runManifest = buildAbRunManifest({
    experimentKind: 'provider',
    metadata: {
      provider: PROVIDER,
      model: options.model,
      baseUrl: options.baseUrl,
      promptHash,
      protocolVariable: 'MAKA_MODEL_API_PROTOCOL',
      armExecution: 'sequential',
      billingMode: 'account-plan',
      requestTelemetry: 'provider_request_attempt_recorded',
      sharedAgentEnv: options.sharedAgentEnv,
    },
    arms: kimiProtocolAbArms(),
    taskBudgetSec: options.taskBudgetSec,
    harborTimeoutMs: options.harborTimeoutMs ?? null,
    subjectFingerprint: await buildSubjectFingerprint(
      options.makaRepoPath,
      process.env.MAKA_KIMI_PROTOCOL_AB_EXPLICIT_SUBJECT_FINGERPRINT,
      undefined,
      'MAKA_KIMI_PROTOCOL_AB',
    ),
    taskSourceFingerprint: await buildTaskSourceFingerprint(options.tasksRoot, evaluationTasks),
    toolchainFingerprint: await buildToolchainFingerprint(
      process.env.MAKA_KIMI_PROTOCOL_AB_TOOLCHAIN_FINGERPRINT,
      undefined,
      options.makaRepoPath,
      'MAKA_KIMI_PROTOCOL_AB',
    ),
    evaluationTaskIds: options.taskIds,
    reps: options.reps,
    candidateLimit: null,
    maxConcurrency: options.maxConcurrency,
    selectionMode: 'explicit',
    candidateTaskIds: options.taskIds,
    nonInferiorityMargin: options.nonInferiorityMargin,
  });
  const manifestPath = join(runRoot, 'kimi-protocol-ab-manifest.json');
  await ensureAbRunManifest(manifestPath, runManifest);

  if (options.dryRun) {
    console.log(`dry-run: executable manifest validated -> ${manifestPath}`);
    return;
  }

  await readFile(options.keyFile, 'utf8');
  const systemPromptPath = join(runRoot, 'prompts', 'shared-system-prompt.md');
  const resultPath = join(runRoot, 'kimi-protocol-ab-result.json');
  const reportPath = join(runRoot, 'kimi-protocol-ab-report.md');
  const config = {
    id: 'kimi-protocol-ab',
    backend: 'ai-sdk',
    llmConnectionSlug: PROVIDER,
    model: options.model,
    thinkingLevel: 'max',
  };
  const result = await runExperiment({
    runRoot,
    prompts: () => [{ path: systemPromptPath, content: DEFAULT_HEADLESS_SYSTEM_PROMPT }],
    run: ({ jobsDir, resultsJsonlPath }) => {
      const taskRunner = createHarborTaskRunner({
        makaRepoPath: options.makaRepoPath,
        jobsDir,
        model: options.model,
        provider: PROVIDER,
        reasoningEffort: 'max',
        apiKeyFile: options.keyFile,
        pricing: {
          inputUsdPer1M: 0,
          cacheReadUsdPer1M: 0,
          cacheWriteUsdPer1M: 0,
          outputUsdPer1M: 0,
          source: PRICING_PROFILE,
        },
        agentEnv: {
          ...options.sharedAgentEnv,
          MAKA_BASE_URL: options.baseUrl,
          MAKA_CELL_TIMEOUT_SEC: String(options.taskBudgetSec),
        },
        ...(options.harborTimeoutMs !== undefined
          ? { harborTimeoutMs: options.harborTimeoutMs }
          : {}),
      });
      return runKimiProtocolAbComparison({
        runId: options.runId,
        config,
        systemPromptPath,
        resultsJsonlPath,
        evaluationTasks,
        taskRunner,
        reps: options.reps,
        maxConcurrency: options.maxConcurrency,
        armExecution: 'sequential',
        budgetMs: options.taskBudgetSec * 1_000,
        nonInferiorityMargin: options.nonInferiorityMargin,
        resumeFingerprint: runManifest.fingerprint,
        sharedAgentEnv: options.sharedAgentEnv,
        requireExecutionIdentity: true,
        requireFinalUsage: true,
        expectedPricingProfile: PRICING_PROFILE,
        billingMode: 'account-plan',
      });
    },
    artifacts: (comparison, layout) => [
      {
        path: resultPath,
        content: `${JSON.stringify(
          {
            schemaVersion: 'maka.kimi_protocol_ab.v1',
            runId: options.runId,
            runManifest,
            rawResultsJsonlPath: layout.resultsJsonlPath,
            comparison,
          },
          null,
          2,
        )}\n`,
      },
      {
        path: reportPath,
        content: renderKimiProtocolAbMarkdown(comparison),
      },
    ],
  });

  console.log(`decision: ${result.summary.decision} (${result.summary.reason})`);
  console.log(`default recommendation: ${result.defaultRecommendation}`);
  console.log(`result -> ${resultPath}`);
  console.log(`report -> ${reportPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
