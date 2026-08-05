#!/usr/bin/env node

import { readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildRunManifestFingerprint, ensureAbRunManifest, readAbRunManifest } from '#ab-manifest';
import {
  discoverCachedHarborTasks,
  fingerprintFixedPromptTaskTree,
  resolveFixedPromptRunRoot,
  selectTasksByIds,
} from '#fixed-prompt-task-source';
import { createHarborTaskRunner, MAKA_SETTLEMENT_GRACE_SEC } from '#harbor-task-runner';
import { createPierProviderProxyHub, createPierTaskRunner } from '#pier-task-runner';
import {
  buildHarnessOracleExecutionPolicyFingerprint,
  HARBOR_ORACLE_DOCKER_PLATFORM,
} from '#harness-oracle-policy';
import {
  buildHarnessOracleAuditTasks,
  loadHarnessOracleRegistrySnapshot,
  resolveHarnessOracleAnnotations,
} from '#harness-oracle-registry';
import {
  OPENCODE_TOOLCHAIN_FINGERPRINT,
  OPENCODE_TOOLCHAIN_SPEC,
  prepareOpenCodeToolchain,
} from '#opencode-toolchain';
import {
  KIMI_CODE_TOOLCHAIN_FINGERPRINT,
  KIMI_CODE_TOOLCHAIN_SPEC,
  prepareKimiCodeToolchain,
} from '#kimi-code-toolchain';
import {
  CODEX_TOOLCHAIN_FINGERPRINT,
  CODEX_TOOLCHAIN_SPEC,
  CODEX_DEEPSEEK_MODEL_CATALOG_FINGERPRINT,
  prepareCodexToolchain,
} from '#codex-toolchain';
import {
  CLAUDE_CODE_TOOLCHAIN_FINGERPRINT,
  CLAUDE_CODE_TOOLCHAIN_SPEC,
  prepareClaudeCodeToolchain,
} from '#claude-code-toolchain';
import {
  REASONIX_TOOLCHAIN_FINGERPRINT,
  REASONIX_TOOLCHAIN_SPEC,
  prepareReasonixToolchain,
} from '#reasonix-toolchain';
import { MAKA_NODE_TOOLCHAIN_FINGERPRINT, prepareMakaNodeToolchain } from '#maka-node-toolchain';
import { createCodexOAuthHarnessCredentialBinding } from '#codex-oauth-harness';
import {
  assertDeepSweFullTaskSet,
  assertDeepSweFullTaskTreeFingerprint,
  assertDeepSweSubset30TaskTreeFingerprint,
  assertTerminalBench21TaskSet,
  assertTerminalBench21TaskTreeFingerprint,
  buildHarnessAbResumeFingerprint,
  buildHarnessAbRunManifest,
  DEEP_SWE_FULL_TASK_IDS,
  DEEP_SWE_REVISION,
  DEEP_SWE_SUBSET_30_TASK_IDS,
  HARNESS_MAKA_CONTEXT_BUDGET,
  TERMINAL_BENCH_2_1_REVISION,
  TERMINAL_BENCH_2_1_TASK_IDS,
} from '#harness-ab-manifest';
import {
  runHarnessAbComparisonUnlocked,
  runHarnessArmCohortUnlocked,
  withHarnessAbRunLock,
} from '#harness-ab-run';
import { DEFAULT_HEADLESS_SYSTEM_PROMPT } from '@maka/headless';
import { thinkingVariantsForModel } from '@maka/core/model-thinking';
import {
  assertHarnessAbReportCompleted,
  buildHarnessAbReport,
  buildHarnessCohortReport,
  renderHarnessAbReportCsv,
  renderHarnessAbReportMarkdown,
  renderHarnessCohortReportCsv,
  renderHarnessCohortReportMarkdown,
} from '#harness-ab-report';
import { envPath as parseEnvPath } from '#headless-run-env';
import { buildSubjectFingerprint, buildToolchainFingerprint } from '#experiment-fingerprint';
import { runExperiment } from '#experiment-engine';
import { DEEPSEEK_V4_FLASH_PRICING } from '#deepseek-pricing';
import { harnessAgentImportPath, providerProxyUsageProtocol } from '#harness-agent-registry';

const execFileAsync = promisify(execFile);

export const DEFAULT_HARNESS_AB_RUN_ID = 'k3-maka-vs-kimi-code-tbench-2.1-full-v2';
const CANARY_TASKS = 5;
// Bounds host load only: every cell is an independent Harbor run, so pair
// concurrency never enters scoring or resume identity beyond the manifest.
const MAX_PAIR_CONCURRENCY = 16;
const DEFAULT_PAIR_CONCURRENCY = 1;
const DEFAULT_ARM_EXECUTION = 'sequential';
const KIMI_CODING_PLAN_PRICING = Object.freeze({
  currency: 'USD',
  unit: 'per_1m_tokens',
  input: 0,
  cachedInput: 0,
  output: 0,
  source: 'kimi-coding-plan-account-plan',
});
const ZAI_CODING_PLAN_PRICING = Object.freeze({
  currency: 'USD',
  unit: 'per_1m_tokens',
  input: 0,
  cachedInput: 0,
  output: 0,
  source: 'zai-coding-plan-account-plan',
});
const DEEPSEEK_V4_FLASH_HARNESS_PRICING = Object.freeze({
  currency: 'USD',
  unit: 'per_1m_tokens',
  input: DEEPSEEK_V4_FLASH_PRICING.inputUsdPer1M,
  cachedInput: DEEPSEEK_V4_FLASH_PRICING.cacheReadUsdPer1M,
  cacheWrite: DEEPSEEK_V4_FLASH_PRICING.cacheWriteUsdPer1M,
  output: DEEPSEEK_V4_FLASH_PRICING.outputUsdPer1M,
  source: DEEPSEEK_V4_FLASH_PRICING.source,
});
const HARBOR_SETUP_TEARDOWN_GRACE_SEC = 15 * 60;
const ORACLE_EVIDENCE_RESOLUTION_TIMEOUT_MS = 15_000;
const BACKGROUND_RUN_ENV = 'MAKA_HARNESS_AB_BACKGROUND_RUN';
const BACKGROUND_STARTED_AT_ENV = 'MAKA_HARNESS_AB_DETACHED_STARTED_AT';
const BACKGROUND_JOURNAL_FILENAME = 'background-run.json';
const BACKGROUND_LOG_FILENAME = 'background-run.log';

/** The benchmark axis of a harness A/B. A benchmark is a BOUND pair of frozen
 * task source and executor — Terminal-Bench 2.1 tasks run under plain Harbor
 * 0.13.2, DeepSWE tasks under Pier ≥ 0.3.0 — so one profile carries both. The
 * runtime and competitor axes stay orthogonal until resolveHarnessComposition
 * validates the selected triple against the sparse support table. */
export const HARNESS_BENCHMARK_PROFILES = Object.freeze({
  'terminal-bench-2.1': Object.freeze({
    id: 'terminal-bench-2.1',
    label: 'Terminal-Bench 2.1',
    dataset: 'terminal-bench',
    version: '2.1',
    revision: TERMINAL_BENCH_2_1_REVISION,
    taskIds: TERMINAL_BENCH_2_1_TASK_IDS,
    executor: 'harbor',
    runIdSlug: 'tbench-2.1-full',
    // The Harbor oracle registry (advisory task-quality evidence) exists only
    // for Terminal-Bench; DeepSWE grading is each task's own verifier.
    oracle: true,
  }),
  'deep-swe-1.1': Object.freeze({
    id: 'deep-swe-1.1',
    label: 'DeepSWE subset-30',
    dataset: 'deep-swe',
    version: '1.1',
    revision: DEEP_SWE_REVISION,
    taskIds: DEEP_SWE_SUBSET_30_TASK_IDS,
    executor: 'pier',
    runIdSlug: 'deepswe-subset30',
    oracle: false,
  }),
  'deep-swe-1.1-full': Object.freeze({
    id: 'deep-swe-1.1-full',
    label: 'DeepSWE full-113',
    dataset: 'deep-swe',
    version: '1.1',
    revision: DEEP_SWE_REVISION,
    taskIds: DEEP_SWE_FULL_TASK_IDS,
    executor: 'pier',
    runIdSlug: 'deepswe-full',
    oracle: false,
  }),
});

export function resolveHarnessBenchmarkProfile(
  raw = process.env.MAKA_HARNESS_AB_BENCHMARK || 'terminal-bench-2.1',
) {
  const profile = HARNESS_BENCHMARK_PROFILES[raw];
  if (!profile) {
    throw new Error(
      `MAKA_HARNESS_AB_BENCHMARK must be one of: ${Object.keys(HARNESS_BENCHMARK_PROFILES).join(', ')}`,
    );
  }
  return profile;
}

export function defaultHarnessBenchmarkTasksRoot(benchmarkProfile) {
  return benchmarkProfile.dataset === 'deep-swe'
    ? join(homedir(), '.maka/eval/task-sources/deep-swe-6db64a40/tasks')
    : join(homedir(), '.cache/harbor/tasks');
}

/** Discover, freeze, and fingerprint the benchmark's task source. The frozen
 * set is always the benchmark's full task list — fingerprint identity must not
 * depend on which slice of it a canary run evaluates. */
export async function resolveFrozenBenchmarkTasks(benchmarkProfile, tasksRoot) {
  const discovered = await discoverCachedHarborTasks(tasksRoot);
  if (benchmarkProfile.dataset === 'deep-swe') {
    if (benchmarkProfile.id === 'deep-swe-1.1-full') {
      // The full profile compares the whole pinned tree: assert the exact
      // 113-task leaderboard set and fingerprint every discovered task dir.
      assertDeepSweFullTaskSet(discovered.map((task) => task.id));
      const fullTreeFingerprint = await fingerprintFixedPromptTaskTree(discovered);
      assertDeepSweFullTaskTreeFingerprint(fullTreeFingerprint);
      return { tasks: discovered, taskSourceFingerprint: fullTreeFingerprint };
    }
    // The DeepSWE repo tree carries more tasks than the frozen subset; pick
    // the subset (loud on any missing id) instead of asserting the whole tree.
    const tasks = selectTasksByIds(discovered, benchmarkProfile.taskIds, {
      label: benchmarkProfile.label,
    });
    const taskSourceFingerprint = await fingerprintFixedPromptTaskTree(tasks);
    assertDeepSweSubset30TaskTreeFingerprint(taskSourceFingerprint);
    return { tasks, taskSourceFingerprint };
  }
  assertTerminalBench21TaskSet(discovered.map((task) => task.id));
  const taskSourceFingerprint = await fingerprintFixedPromptTaskTree(discovered);
  assertTerminalBench21TaskTreeFingerprint(taskSourceFingerprint);
  return { tasks: discovered, taskSourceFingerprint };
}

/** Compose the run's toolchain identity. The Harbor payload is byte-identical
 * to the historical formula; a Pier benchmark additionally freezes the Pier
 * executor version, so a resume across a Pier upgrade forks instead of mixing
 * cells produced under different execution semantics. */
export function buildHarnessAbToolchainFingerprint({
  hostToolchainFingerprint,
  competitorProfile,
  competitorProfiles = [competitorProfile],
  pierVersion = null,
  makaNodeToolchainFingerprint = null,
}) {
  const competitors = competitorProfiles.map((profile) => ({
    id: profile.id,
    toolchainFingerprint: profile.toolchainFingerprint,
  }));
  return `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        hostToolchainFingerprint,
        ...(competitors.length === 1
          ? {
              competitor: competitors[0].id,
              competitorToolchainFingerprint: competitors[0].toolchainFingerprint,
            }
          : { competitors }),
        ...(pierVersion === null ? {} : { pierVersion }),
        ...(makaNodeToolchainFingerprint === null ? {} : { makaNodeToolchainFingerprint }),
      }),
    )
    .digest('hex')}`;
}

async function readPierVersion() {
  try {
    // stdout only: pier leaks environment-dependent LiteLLM warnings to
    // stderr, which must not enter the frozen resume identity.
    const { stdout } = await execFileAsync('pier', ['--version']);
    const version = stdout.trim();
    if (!version) throw new Error('pier --version printed nothing on stdout');
    return version;
  } catch (error) {
    throw new Error(
      `the DeepSWE benchmark freezes its Pier executor version into the resume identity, but pier --version failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * A competitor profile is the single source of truth for one arm's pinned
 * toolchain: how to prepare it, which env var overrides its cached path, and
 * which runner option carries it. Downstream code reads these fields instead
 * of re-dispatching on the competitor id.
 */
export const HARNESS_COMPETITOR_PROFILES = Object.freeze({
  'kimi-code': Object.freeze({
    id: 'kimi-code',
    version: KIMI_CODE_TOOLCHAIN_SPEC.kimiCode.version,
    toolchainFingerprint: KIMI_CODE_TOOLCHAIN_FINGERPRINT,
    prepareToolchain: prepareKimiCodeToolchain,
    toolchainPathEnvKey: 'MAKA_HARNESS_AB_KIMI_CODE_TOOLCHAIN',
    runnerToolchainOption: 'kimiCodeToolchainPath',
    config: Object.freeze({
      outputFormat: 'stream-json',
      permissions: 'prompt-auto',
      attemptPolicy: 'single',
    }),
  }),
  opencode: Object.freeze({
    id: 'opencode',
    version: OPENCODE_TOOLCHAIN_SPEC.opencode.version,
    toolchainFingerprint: OPENCODE_TOOLCHAIN_FINGERPRINT,
    prepareToolchain: prepareOpenCodeToolchain,
    toolchainPathEnvKey: 'MAKA_HARNESS_AB_OPENCODE_TOOLCHAIN',
    runnerToolchainOption: 'opencodeToolchainPath',
    config: Object.freeze({
      pure: true,
      permissions: 'auto',
      attemptPolicy: 'single',
    }),
  }),
  codex: Object.freeze({
    id: 'codex',
    version: CODEX_TOOLCHAIN_SPEC.codex.version,
    toolchainFingerprint: CODEX_TOOLCHAIN_FINGERPRINT,
    prepareToolchain: prepareCodexToolchain,
    toolchainPathEnvKey: 'MAKA_HARNESS_AB_CODEX_TOOLCHAIN',
    runnerToolchainOption: 'codexToolchainPath',
    config: Object.freeze({
      transport: 'responses-http',
      permissions: 'container-full-access',
      attemptPolicy: 'single',
    }),
  }),
  'claude-code': Object.freeze({
    id: 'claude-code',
    version: CLAUDE_CODE_TOOLCHAIN_SPEC.claudeCode.version,
    toolchainFingerprint: CLAUDE_CODE_TOOLCHAIN_FINGERPRINT,
    prepareToolchain: prepareClaudeCodeToolchain,
    toolchainPathEnvKey: 'MAKA_HARNESS_AB_CLAUDE_CODE_TOOLCHAIN',
    runnerToolchainOption: 'claudeCodeToolchainPath',
    config: Object.freeze({
      transport: 'anthropic-messages',
      permissions: 'bypassPermissions',
      attemptPolicy: 'single',
    }),
  }),
  reasonix: Object.freeze({
    id: 'reasonix',
    version: REASONIX_TOOLCHAIN_SPEC.reasonix.version,
    toolchainFingerprint: REASONIX_TOOLCHAIN_FINGERPRINT,
    prepareToolchain: prepareReasonixToolchain,
    toolchainPathEnvKey: 'MAKA_HARNESS_AB_REASONIX_TOOLCHAIN',
    runnerToolchainOption: 'reasonixToolchainPath',
    config: Object.freeze({
      // stream-json carries real tool names, which the redacted --events-jsonl
      // surface aliases away; the arms are only comparable on tool behaviour if
      // both capture their CLI's native stream.
      outputFormat: 'stream-json',
      permissions: 'auto',
      attemptPolicy: 'single',
    }),
  }),
});

export const HARNESS_RUNTIME_PROFILES = Object.freeze({
  'kimi-coding-plan-k3-max': Object.freeze({
    id: 'kimi-coding-plan-k3-max',
    provider: 'kimi-coding-plan',
    model: 'k3',
    reasoningEffort: 'max',
    baseUrl: 'https://api.kimi.com/coding/v1',
    billingMode: 'account-plan',
    pricing: KIMI_CODING_PLAN_PRICING,
    auth: Object.freeze({
      kind: 'api-key-file',
      keyFileEnv: 'MAKA_HARNESS_AB_KEY_FILE',
      defaultPath: join(homedir(), '.maka/secrets/kimi-coding-plan.key'),
    }),
  }),
  'zai-coding-plan-glm-5.2-max': Object.freeze({
    id: 'zai-coding-plan-glm-5.2-max',
    provider: 'zai-coding-plan',
    model: 'glm-5.2',
    reasoningEffort: 'max',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    billingMode: 'account-plan',
    pricing: ZAI_CODING_PLAN_PRICING,
    auth: Object.freeze({
      kind: 'api-key-file',
      keyFileEnv: 'MAKA_HARNESS_AB_ZAI_KEY_FILE',
    }),
  }),
  'deepseek-v4-flash-max': Object.freeze({
    id: 'deepseek-v4-flash-max',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'max',
    baseUrl: 'https://api.deepseek.com',
    billingMode: 'metered',
    pricing: DEEPSEEK_V4_FLASH_HARNESS_PRICING,
    auth: Object.freeze({
      kind: 'api-key-file',
      keyFileEnv: 'MAKA_HARNESS_AB_DEEPSEEK_KEY_FILE',
      defaultPath: join(homedir(), '.maka/secrets/deepseek.key'),
    }),
  }),
  'openai-codex-gpt-5.6-sol-xhigh': Object.freeze({
    id: 'openai-codex-gpt-5.6-sol-xhigh',
    provider: 'openai-codex',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'xhigh',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    billingMode: 'account-plan',
    pricing: Object.freeze({
      currency: 'USD',
      unit: 'per_1m_tokens',
      input: 0,
      cachedInput: 0,
      output: 0,
      source: 'openai-codex-chatgpt-account-plan',
    }),
    auth: Object.freeze({
      kind: 'codex-oauth',
      defaultConnectionSlug: 'codex-subscription',
    }),
  }),
});

const DEFAULT_RUNTIME_BY_COMPETITOR = Object.freeze({
  'kimi-code': 'kimi-coding-plan-k3-max',
  opencode: 'kimi-coding-plan-k3-max',
  codex: 'openai-codex-gpt-5.6-sol-xhigh',
  'claude-code': 'deepseek-v4-flash-max',
  reasonix: 'deepseek-v4-flash-max',
});

const SUPPORTED_HARNESS_COMPOSITIONS = new Set([
  'terminal-bench-2.1|kimi-coding-plan-k3-max|kimi-code',
  'terminal-bench-2.1|kimi-coding-plan-k3-max|opencode',
  'terminal-bench-2.1|zai-coding-plan-glm-5.2-max|opencode',
  'terminal-bench-2.1|deepseek-v4-flash-max|opencode',
  'terminal-bench-2.1|openai-codex-gpt-5.6-sol-xhigh|codex',
  'terminal-bench-2.1|deepseek-v4-flash-max|codex',
  'terminal-bench-2.1|deepseek-v4-flash-max|claude-code',
  'terminal-bench-2.1|deepseek-v4-flash-max|reasonix',
  'deep-swe-1.1|kimi-coding-plan-k3-max|kimi-code',
  'deep-swe-1.1|openai-codex-gpt-5.6-sol-xhigh|codex',
  'deep-swe-1.1-full|kimi-coding-plan-k3-max|kimi-code',
  'deep-swe-1.1-full|openai-codex-gpt-5.6-sol-xhigh|codex',
  'deep-swe-1.1-full|deepseek-v4-flash-max|opencode',
]);
const RESOLVED_HARNESS_COMPOSITIONS = new WeakSet();

/** Resolve host-proxy hub options from the harness environment. Pier's
 * in-container agents dial the host credential proxy at an advertised host;
 * the default (host.docker.internal) only exists on Docker Desktop, so a
 * native-Linux VM must name a docker-bridge-reachable address explicitly. */
export function resolveHarnessProviderProxyHubOptions(
  raw = process.env.MAKA_HARNESS_AB_PROVIDER_PROXY_ADVERTISED_HOST,
) {
  const advertisedHost = raw?.trim();
  return advertisedHost ? { providerProxyAdvertisedHost: advertisedHost } : {};
}

export function resolveHarnessCompetitorProfile(raw = 'kimi-code') {
  const profile = HARNESS_COMPETITOR_PROFILES[raw];
  if (!profile) {
    throw new Error(
      `MAKA_HARNESS_AB_COMPETITOR must be one of: ${Object.keys(HARNESS_COMPETITOR_PROFILES).join(', ')}`,
    );
  }
  return profile;
}

export function resolveHarnessRuntimeProfile(raw = 'kimi-coding-plan-k3-max') {
  const profile = HARNESS_RUNTIME_PROFILES[raw];
  if (!profile) {
    throw new Error(
      `MAKA_HARNESS_AB_RUNTIME must be one of: ${Object.keys(HARNESS_RUNTIME_PROFILES).join(', ')}`,
    );
  }
  return profile;
}

export function resolveHarnessComposition(input = {}) {
  const env = input.env ?? process.env;
  const benchmarkProfile = resolveHarnessBenchmarkProfile(
    input.benchmark || env.MAKA_HARNESS_AB_BENCHMARK || 'terminal-bench-2.1',
  );
  const competitorIds = (
    input.competitors ||
    env.MAKA_HARNESS_AB_COMPETITORS ||
    input.competitor ||
    env.MAKA_HARNESS_AB_COMPETITOR ||
    'kimi-code'
  )
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (competitorIds.length === 0) throw new Error('harness competitors must not be empty');
  if (new Set(competitorIds).size !== competitorIds.length) {
    throw new Error('harness competitors must be unique');
  }
  const competitorProfiles = competitorIds.map(resolveHarnessCompetitorProfile);
  const competitorProfile = competitorProfiles[0];
  const runtimeProfile = resolveHarnessRuntimeProfile(
    input.runtime ||
      env.MAKA_HARNESS_AB_RUNTIME ||
      (competitorProfiles.length > 1
        ? 'deepseek-v4-flash-max'
        : DEFAULT_RUNTIME_BY_COMPETITOR[competitorProfile.id]),
  );
  for (const profile of competitorProfiles) {
    const compositionKey = `${benchmarkProfile.id}|${runtimeProfile.id}|${profile.id}`;
    if (!SUPPORTED_HARNESS_COMPOSITIONS.has(compositionKey)) {
      throw new Error(
        `unsupported harness composition: benchmark=${benchmarkProfile.id}, runtime=${runtimeProfile.id}, competitor=${profile.id}`,
      );
    }
  }
  const composition = Object.freeze({
    benchmarkProfile,
    runtimeProfile,
    competitorProfile,
    competitorProfiles: Object.freeze(competitorProfiles),
  });
  RESOLVED_HARNESS_COMPOSITIONS.add(composition);
  return composition;
}

function assertResolvedHarnessComposition(composition) {
  if (!composition || !RESOLVED_HARNESS_COMPOSITIONS.has(composition)) {
    throw new Error('composition must come from resolveHarnessComposition');
  }
}

export function buildHarnessExecutionProfile(runtimeProfile) {
  if (
    !thinkingVariantsForModel(runtimeProfile.provider, runtimeProfile.model).includes(
      runtimeProfile.reasoningEffort,
    )
  ) {
    throw new Error(
      `${runtimeProfile.provider}/${runtimeProfile.model} does not support reasoning effort ${runtimeProfile.reasoningEffort}`,
    );
  }
  return {
    modelSpec: `${runtimeProfile.provider}/${runtimeProfile.model}`,
    provider: runtimeProfile.provider,
    model: runtimeProfile.model,
    reasoningEffort: runtimeProfile.reasoningEffort,
    baseUrl: runtimeProfile.baseUrl,
    billingMode: runtimeProfile.billingMode,
    pricing: {
      inputUsdPer1M: runtimeProfile.pricing.input,
      cacheReadUsdPer1M: runtimeProfile.pricing.cachedInput,
      ...(runtimeProfile.pricing.cacheWrite === undefined
        ? {}
        : { cacheWriteUsdPer1M: runtimeProfile.pricing.cacheWrite }),
      outputUsdPer1M: runtimeProfile.pricing.output,
      source: runtimeProfile.pricing.source,
    },
  };
}

export async function resolveHarnessRuntimeCredentials(input) {
  assertResolvedHarnessComposition(input.composition);
  const { auth } = input.composition.runtimeProfile;
  if (auth.kind === 'api-key-file') {
    return {
      apiKeyFile: envPathFrom(input.env, auth.keyFileEnv, auth.defaultPath),
    };
  }
  const credentialsRoot = envPathFrom(
    input.env,
    'MAKA_HARNESS_AB_WORKSPACE_ROOT',
    defaultMakaWorkspaceRoot(),
  );
  const createCredentialBinding =
    input.createCodexOAuthCredentialBinding ?? createCodexOAuthHarnessCredentialBinding;
  return createCredentialBinding({
    credentialsRoot,
    connectionSlug: input.env.MAKA_HARNESS_AB_OAUTH_CONNECTION_SLUG || auth.defaultConnectionSlug,
  });
}

export function resolveHarnessAbRunId(composition, explicitRunId, isolatedTaskId, explicitTaskIds) {
  assertResolvedHarnessComposition(composition);
  if (isolatedTaskId?.trim() && !explicitRunId?.trim()) {
    throw new Error('MAKA_HARNESS_AB_RUN_ID is required with MAKA_HARNESS_AB_TASK_ID');
  }
  if (explicitTaskIds?.trim() && !explicitRunId?.trim()) {
    throw new Error('MAKA_HARNESS_AB_RUN_ID is required with MAKA_HARNESS_AB_TASK_IDS');
  }
  if (explicitRunId) return explicitRunId;
  // Historical name predating the derived template; kept so existing k3
  // Terminal-Bench runs keep resuming into the same run root.
  if (
    composition.benchmarkProfile.dataset === 'terminal-bench' &&
    composition.runtimeProfile.id === 'kimi-coding-plan-k3-max' &&
    composition.competitorProfile.id === 'kimi-code'
  ) {
    return DEFAULT_HARNESS_AB_RUN_ID;
  }
  const { benchmarkProfile, runtimeProfile } = composition;
  const competitorSlug = composition.competitorProfiles.map((profile) => profile.id).join('-vs-');
  return `${runtimeProfile.model}-maka-vs-${competitorSlug}${runtimeProfile.auth.kind === 'codex-oauth' ? '-oauth' : ''}-${benchmarkProfile.runIdSlug}-v1`;
}

export function resolveHarnessCompetitorToolchainPath(runRoot, competitorProfile) {
  const fingerprintPrefix = competitorProfile.toolchainFingerprint.slice(
    'sha256:'.length,
    'sha256:'.length + 12,
  );
  return join(
    runRoot,
    'toolchains',
    `${competitorProfile.id}-${competitorProfile.version}-${fingerprintPrefix}-linux-x64`,
  );
}

export function resolveHarnessCompetitorToolchain(runRoot, competitorProfile, env = process.env) {
  if (!competitorProfile.prepareToolchain) {
    throw new Error(`unsupported harness competitor: ${competitorProfile.id}`);
  }
  const override = env[competitorProfile.toolchainPathEnvKey];
  return {
    path: override
      ? resolve(override)
      : resolveHarnessCompetitorToolchainPath(runRoot, competitorProfile),
    prepare: competitorProfile.prepareToolchain,
  };
}

export function resolveHarnessMakaNodeToolchain(runRoot, env = process.env) {
  const fingerprintPrefix = MAKA_NODE_TOOLCHAIN_FINGERPRINT.slice(
    'sha256:'.length,
    'sha256:'.length + 12,
  );
  return {
    path: env.MAKA_HARNESS_AB_MAKA_NODE_TOOLCHAIN
      ? resolve(env.MAKA_HARNESS_AB_MAKA_NODE_TOOLCHAIN)
      : join(runRoot, 'toolchains', `maka-node-${fingerprintPrefix}-linux-x64`),
    prepare: prepareMakaNodeToolchain,
  };
}

const envPath = (name, fallback) => parseEnvPath(name, process.env[name], fallback);
const envPathFrom = (env, name, fallback) => parseEnvPath(name, env[name], fallback);

function defaultMakaWorkspaceRoot() {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Maka', 'workspaces', 'default');
  }
  if (process.platform === 'win32') {
    return join(
      process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
      'Maka',
      'workspaces',
      'default',
    );
  }
  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
    'Maka',
    'workspaces',
    'default',
  );
}

function runLimit(raw, benchmarkProfile) {
  const fullCount = benchmarkProfile.taskIds.length;
  const parsed = Number(raw ?? CANARY_TASKS);
  if (parsed !== CANARY_TASKS && parsed !== fullCount) {
    throw new Error(`MAKA_HARNESS_AB_LIMIT must be ${CANARY_TASKS} or ${fullCount}`);
  }
  return parsed;
}

function runPairConcurrency(raw) {
  const parsed = Number(raw ?? DEFAULT_PAIR_CONCURRENCY);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_PAIR_CONCURRENCY) {
    throw new Error(
      `MAKA_HARNESS_AB_PAIR_CONCURRENCY must be an integer between 1 and ${MAX_PAIR_CONCURRENCY}`,
    );
  }
  return parsed;
}

function runArmExecution(raw) {
  const parsed = raw?.trim() || DEFAULT_ARM_EXECUTION;
  if (parsed !== 'sequential' && parsed !== 'parallel') {
    throw new Error('MAKA_HARNESS_AB_ARM_EXECUTION must be sequential or parallel');
  }
  return parsed;
}

export function resolveHarnessAbExecutionPolicy(rawPairConcurrency, rawArmExecution, taskCount) {
  if (!Number.isSafeInteger(taskCount) || taskCount < 1) {
    throw new Error('harness A/B execution policy requires at least one task');
  }
  return {
    pairConcurrency: Math.min(runPairConcurrency(rawPairConcurrency), taskCount),
    armExecution: runArmExecution(rawArmExecution),
  };
}

export function resolveHarnessAbTaskSelection(
  rawTaskId,
  rawLimit,
  rawTaskIds,
  benchmarkProfile = resolveHarnessBenchmarkProfile(),
) {
  const taskId = rawTaskId?.trim();
  const explicitTaskIds = rawTaskIds
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (rawTaskIds !== undefined && explicitTaskIds?.length === 0) {
    throw new Error('MAKA_HARNESS_AB_TASK_IDS must contain at least one task id');
  }
  if (taskId && explicitTaskIds?.length) {
    throw new Error('MAKA_HARNESS_AB_TASK_ID and MAKA_HARNESS_AB_TASK_IDS are mutually exclusive');
  }
  if (explicitTaskIds?.length) {
    const uniqueTaskIds = [...new Set(explicitTaskIds)];
    if (uniqueTaskIds.length !== explicitTaskIds.length) {
      throw new Error('MAKA_HARNESS_AB_TASK_IDS must not contain duplicate task ids');
    }
    const invalidTaskIds = uniqueTaskIds.filter(
      (selectedTaskId) => !benchmarkProfile.taskIds.includes(selectedTaskId),
    );
    if (invalidTaskIds.length > 0) {
      throw new Error(
        `MAKA_HARNESS_AB_TASK_IDS contains unknown ${benchmarkProfile.label} tasks: ${invalidTaskIds.join(', ')}`,
      );
    }
    return {
      taskIds: uniqueTaskIds,
      limit: uniqueTaskIds.length,
    };
  }
  if (!taskId) {
    return {
      taskIds: benchmarkProfile.taskIds,
      limit: runLimit(rawLimit, benchmarkProfile),
    };
  }
  if (!benchmarkProfile.taskIds.includes(taskId)) {
    throw new Error(`MAKA_HARNESS_AB_TASK_ID must name a ${benchmarkProfile.label} task`);
  }
  return { taskIds: [taskId], limit: 1 };
}

export function resolveHarnessAdjudicatedInfraRetryRoundIds(raw) {
  if (raw === undefined) return [];
  const roundIds = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (roundIds.length === 0) {
    throw new Error('MAKA_HARNESS_AB_RETRY_ADJUDICATED_INFRA_ROUND_IDS_ONCE must not be empty');
  }
  if (new Set(roundIds).size !== roundIds.length) {
    throw new Error(
      'MAKA_HARNESS_AB_RETRY_ADJUDICATED_INFRA_ROUND_IDS_ONCE must not contain duplicates',
    );
  }
  return roundIds;
}

export function harnessMakaContextBudgetEnv() {
  return {
    MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE: 'on',
    MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MAX_ESTIMATED_TOKENS: String(
      HARNESS_MAKA_CONTEXT_BUDGET.activeToolResultPrune.maxCurrentResultEstimatedTokens,
    ),
    MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MIN_STEP_NUMBER: String(
      HARNESS_MAKA_CONTEXT_BUDGET.activeToolResultPrune.minStepNumber,
    ),
    MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on',
    MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_ESTIMATED_TOKENS: String(
      HARNESS_MAKA_CONTEXT_BUDGET.staleToolResultPrune.maxResultEstimatedTokens,
    ),
    MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS_FULL: String(
      HARNESS_MAKA_CONTEXT_BUDGET.staleToolResultPrune.minRecentTurnsFull,
    ),
    MAKA_CONTEXT_SEMANTIC_COMPACT: 'off',
  };
}

/**
 * Where the Maka arm runs. Pier always places it in the task container; under
 * Harbor it bridges from the host unless the caller asks otherwise.
 *
 * This is opt-in rather than a flipped default because it changes the shape of
 * the experiment, not a parameter of it. Every competitor arm runs in the task
 * container, so a host-side Maka arm is the one arm that cannot be hit by a
 * defect in the container path — and three such defects were found during this
 * benchmark. Moving it is what makes the arms comparable; keeping the old
 * placement reachable is what lets the two topologies be run against each other
 * to show whether a difference came from the agent or from where it ran.
 */
export function harnessMakaPlacement(benchmarkProfile, env = process.env) {
  const requested = (env.MAKA_HARNESS_AB_MAKA_PLACEMENT || '').trim();
  if (requested && requested !== 'task-container' && requested !== 'host-bridge') {
    throw new Error(
      `MAKA_HARNESS_AB_MAKA_PLACEMENT must be task-container or host-bridge, got ${requested}`,
    );
  }
  if (benchmarkProfile.executor === 'pier') {
    if (requested === 'host-bridge') {
      throw new Error('the pier executor always runs the Maka arm in the task container');
    }
    return 'task-container';
  }
  return requested === 'task-container' ? 'task-container' : 'host-bridge';
}

/**
 * The Ubuntu apt hosts a task container reaches, and where they point.
 *
 * Terminal-Bench task images are bare `ubuntu:24.04` plus curl, so most tasks
 * apt-install what they need and the benchmark silently depends on
 * archive.ubuntu.com being reachable from the run host. Where that link is
 * degraded the dependency stops being a constant and becomes noise: the same
 * arm on the same task finished in 479s on one run and hit the 900s deadline on
 * the next, issuing an identical 24 tool calls both times, with the entire
 * difference sitting in how long apt stalled. Noise of that shape does not
 * cancel across arms — it charges whichever agent happened to need more
 * packages, which is not the thing this benchmark is trying to measure.
 *
 * Redirecting is opt-in, and recorded in the manifest, because it changes the
 * environment every task runs in. It changes no task image and no sources list:
 * the container still resolves and requests archive.ubuntu.com, so what an
 * agent observes — and what its trace shows it observed — is unchanged.
 */
export const UBUNTU_APT_HOSTS = ['archive.ubuntu.com', 'security.ubuntu.com'];

export function harnessAptMirror(benchmarkProfile, env = process.env) {
  const name = (env.MAKA_HARNESS_AB_APT_MIRROR || '').trim() || null;
  // Only the harbor runner layers the overlay, so a pier run would record a
  // redirect in its manifest that no cell performed, and fork its identity on
  // that false record. Refuse the combination rather than silently dropping the
  // mirror, the same way the placement guard refuses host-bridge under pier.
  if (name && benchmarkProfile.executor === 'pier') {
    throw new Error('the pier executor does not redirect package hosts');
  }
  return name;
}

/**
 * Compose only accepts a literal address in `extra_hosts`, so the mirror name is
 * resolved once per run rather than per cell. Pinning the address is also what
 * makes the redirect reportable: the manifest records the address every cell
 * actually used, not a name that could have resolved differently under each.
 */
export function aptMirrorComposeContent(address) {
  if (!address) throw new Error('apt mirror address is required');
  const entries = UBUNTU_APT_HOSTS.map((host) => `      - '${host}:${address}'`).join('\n');
  return `services:\n  main:\n    extra_hosts:\n${entries}\n`;
}

export function harnessMakaAgentEnv(benchmarkProfile, env = process.env) {
  return {
    ...(harnessMakaPlacement(benchmarkProfile, env) === 'task-container'
      ? { MAKA_HARBOR_MODE: 'task-run' }
      : {}),
    ...harnessMakaContextBudgetEnv(),
  };
}

function harnessMeasuredTransport(agentId, provider) {
  const protocol = providerProxyUsageProtocol(agentId, provider);
  if (protocol === 'openai-chat-sse') return 'openai-chat';
  if (protocol === 'openai-responses-sse') return 'openai-responses';
  if (protocol === 'anthropic-sse') return 'anthropic-messages';
  throw new Error(`harness arm ${agentId} has no measured protocol for provider ${provider}`);
}

export function buildHarnessAbManifest({
  subjectFingerprint,
  taskSourceFingerprint,
  toolchainFingerprint,
  composition = resolveHarnessComposition(),
  taskIds,
  pairConcurrency,
  armExecution = DEFAULT_ARM_EXECUTION,
  oracleEvidence,
  credentialIdentity,
  pierVersion = null,
  aptMirrorAddress = null,
  env = process.env,
}) {
  assertResolvedHarnessComposition(composition);
  const { benchmarkProfile, runtimeProfile, competitorProfiles } = composition;
  const makaPlacement = harnessMakaPlacement(benchmarkProfile, env);
  const resolvedTaskIds = taskIds ?? benchmarkProfile.taskIds;
  const resolvedPairConcurrency =
    pairConcurrency ?? Math.min(DEFAULT_PAIR_CONCURRENCY, resolvedTaskIds.length);
  const execution = buildHarnessExecutionProfile(runtimeProfile);
  return buildHarnessAbRunManifest({
    benchmark: {
      dataset: benchmarkProfile.dataset,
      version: benchmarkProfile.version,
      revision: benchmarkProfile.revision,
      // Human-readable executor identity for Pier benchmarks; the same
      // version is hashed into the toolchain fingerprint. Absent for Harbor
      // benchmarks so Terminal-Bench manifests stay byte-identical.
      ...(pierVersion === null ? {} : { executor: { id: 'pier', version: pierVersion } }),
      timeoutPolicy: 'task-native',
      timeoutMultiplier: 1,
      // Both executors give the Maka arm this settlement window on top of the
      // task-native model budget, so every arm gets the same model time.
      agentSettlementGraceSec: MAKA_SETTLEMENT_GRACE_SEC,
      outerTimeoutGraceSec: HARBOR_SETUP_TEARDOWN_GRACE_SEC,
      // Recorded only when the run redirects apt, for the same reason the Maka
      // arm records its placement only when it moves: every existing run fetched
      // packages from Ubuntu's own hosts, and saying so explicitly would fork
      // their fingerprints without changing what they ran.
      ...(aptMirrorAddress
        ? {
            packageMirror: {
              hosts: UBUNTU_APT_HOSTS,
              name: harnessAptMirror(benchmarkProfile, env),
              address: aptMirrorAddress,
            },
          }
        : {}),
    },
    taskIds: resolvedTaskIds,
    orderSeed: `${benchmarkProfile.id}:${execution.model}:harness-comparison:v1`,
    pilotTaskCount: Math.min(CANARY_TASKS, resolvedTaskIds.length),
    model: {
      provider: execution.provider,
      id: execution.model,
      reasoningEffort: execution.reasoningEffort,
      ...(credentialIdentity ? { credentialIdentity } : {}),
    },
    pricing: runtimeProfile.pricing,
    arms: [
      {
        id: 'maka',
        version: subjectFingerprint,
        config: {
          adapter: harnessAgentImportPath('maka'),
          ...(competitorProfiles.length > 1
            ? { transport: harnessMeasuredTransport('maka', execution.provider) }
            : {}),
          // The runner hands every arm MAKA_SYSTEM_PROMPT, but only the Maka
          // cell applies it; the native CLIs hash it into their execution
          // identity and drop it. Record what each arm actually runs with.
          externalSystemPrompt: 'default-headless',
          reasoningEffort: execution.reasoningEffort,
          continuation: false,
          attemptPolicy: 'single',
          billingMode: runtimeProfile.billingMode,
          contextBudget: HARNESS_MAKA_CONTEXT_BUDGET,
          // Recorded only where this arm leaves its historical placement. The
          // fingerprint is an experiment's identity, and host-bridge Maka is
          // the experiment every existing run already is: describing it more
          // fully would fork their identity without changing what they ran.
          // Moving into the task container is a different experiment, and gets
          // a different fingerprint because it deserves one.
          ...(makaPlacement === 'task-container'
            ? {
                execution: {
                  placement: 'task-container',
                  isolation: 'harbor-local',
                  nodeToolchainFingerprint: MAKA_NODE_TOOLCHAIN_FINGERPRINT,
                },
              }
            : {}),
        },
      },
      ...competitorProfiles.map((profile) => ({
        id: profile.id,
        version: profile.version,
        config: {
          adapter: harnessAgentImportPath(profile.id),
          ...profile.config,
          ...(competitorProfiles.length > 1
            ? { transport: harnessMeasuredTransport(profile.id, execution.provider) }
            : {}),
          ...(profile.id === 'codex' && runtimeProfile.provider === 'deepseek'
            ? { modelCatalogFingerprint: CODEX_DEEPSEEK_MODEL_CATALOG_FINGERPRINT }
            : {}),
          ...(profile.id === 'opencode' ? { variant: runtimeProfile.reasoningEffort } : {}),
          billingMode: runtimeProfile.billingMode,
          externalSystemPrompt: 'none',
          profile: profile.id,
          // Placement is declared by every arm or by none: the report refuses a
          // manifest where only some arms state where they ran, because a
          // comparison that names one arm's environment and not the others'
          // invites the reader to assume they shared it. These arms have always
          // run in the task container, so the condition is really about the
          // Maka arm — once it joins them the fact is worth stating, and while
          // it bridges from the host no existing manifest states it at all.
          // Pier reaches this through the same door: it forces task-container.
          ...(makaPlacement === 'task-container'
            ? { execution: { placement: 'task-container' } }
            : {}),
        },
      })),
    ],
    taskBudgetSec: null,
    harborTimeoutMs: null,
    subjectFingerprint,
    taskSourceFingerprint,
    toolchainFingerprint,
    pairConcurrency: resolvedPairConcurrency,
    armExecution,
    ...(oracleEvidence ? { oracleEvidence } : {}),
  });
}

export async function resolveHarnessAbManifestForRun({
  manifestPath,
  proposedManifest,
  retryRoundIds,
  expectedExistingFingerprint,
}) {
  if (!expectedExistingFingerprint) {
    return ensureAbRunManifest(manifestPath, proposedManifest);
  }
  if (retryRoundIds.length === 0) {
    throw new Error(
      'MAKA_HARNESS_AB_EXPECTED_EXISTING_MANIFEST_FINGERPRINT requires an explicit adjudicated infra retry',
    );
  }
  const existing = await readAbRunManifest(manifestPath);
  if (!existing) {
    throw new Error('explicit adjudicated infra retry requires an existing run manifest');
  }
  if (existing.fingerprint !== expectedExistingFingerprint) {
    throw new Error(
      `existing run manifest fingerprint does not match MAKA_HARNESS_AB_EXPECTED_EXISTING_MANIFEST_FINGERPRINT: expected ${expectedExistingFingerprint}, found ${existing.fingerprint}`,
    );
  }
  const frozenMakaArm = existing.arms.find((arm) => arm.id === 'maka');
  if (!frozenMakaArm) throw new Error('existing run manifest is missing the Maka arm');
  const { fingerprint: _proposedFingerprint, ...proposedBody } = proposedManifest;
  const normalizedBody = {
    ...proposedBody,
    subjectFingerprint: existing.subjectFingerprint,
    toolchainFingerprint: existing.toolchainFingerprint,
    arms: proposedBody.arms.map((arm) =>
      arm.id === 'maka'
        ? {
            ...arm,
            fingerprint: frozenMakaArm.fingerprint,
            metadata: {
              ...arm.metadata,
              version: frozenMakaArm.metadata.version,
            },
          }
        : arm,
    ),
  };
  if (buildRunManifestFingerprint(normalizedBody) !== existing.fingerprint) {
    throw new Error(
      'adjudicated infra retry manifest differs beyond the frozen subject and toolchain identity',
    );
  }
  return existing;
}

export async function main() {
  const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const makaRepoPath = process.env.MAKA_HARNESS_AB_MAKA_REPO
    ? resolve(process.env.MAKA_HARNESS_AB_MAKA_REPO)
    : repoRoot;
  const outDir = envPath('MAKA_HARNESS_AB_OUT_DIR');
  // Resolve and reject the complete benchmark × runtime × competitor triple
  // before a run root or lock can be created.
  const composition = resolveHarnessComposition();
  const { benchmarkProfile } = composition;
  const tasksRoot = envPath(
    'MAKA_HARNESS_AB_TASKS_ROOT',
    defaultHarnessBenchmarkTasksRoot(benchmarkProfile),
  );
  const runId = resolveHarnessAbRunId(
    composition,
    process.env.MAKA_HARNESS_AB_RUN_ID,
    process.env.MAKA_HARNESS_AB_TASK_ID,
    process.env.MAKA_HARNESS_AB_TASK_IDS,
  );
  const selection = resolveHarnessAbTaskSelection(
    process.env.MAKA_HARNESS_AB_TASK_ID,
    process.env.MAKA_HARNESS_AB_LIMIT,
    process.env.MAKA_HARNESS_AB_TASK_IDS,
    benchmarkProfile,
  );
  const executionPolicy = resolveHarnessAbExecutionPolicy(
    process.env.MAKA_HARNESS_AB_PAIR_CONCURRENCY,
    process.env.MAKA_HARNESS_AB_ARM_EXECUTION,
    selection.taskIds.length,
  );
  const retryAdjudicatedInfraRoundIdsOnce = resolveHarnessAdjudicatedInfraRetryRoundIds(
    process.env.MAKA_HARNESS_AB_RETRY_ADJUDICATED_INFRA_ROUND_IDS_ONCE,
  );
  const runRoot = resolveFixedPromptRunRoot(outDir, runId, 'MAKA_HARNESS_AB_RUN_ID');
  await withHarnessAbRunLock(runRoot, async () => {
    const journal = backgroundJournal(runRoot);
    if (journal) await writeBackgroundJournal(journal.path, { ...journal.base, status: 'running' });
    let exitCode = 0;
    try {
      await runLocked({
        repoRoot,
        makaRepoPath,
        tasksRoot,
        runId,
        selection,
        executionPolicy,
        runRoot,
        composition,
        retryAdjudicatedInfraRoundIdsOnce,
      });
    } catch (error) {
      exitCode = 1;
      throw error;
    } finally {
      if (journal) {
        await writeBackgroundJournal(journal.path, {
          ...journal.base,
          status: exitCode === 0 ? 'completed' : 'failed',
          finishedAt: new Date().toISOString(),
          exitCode,
        });
      }
    }
  });
}

async function runLocked({
  repoRoot,
  makaRepoPath,
  tasksRoot,
  runId,
  selection,
  executionPolicy,
  runRoot,
  composition,
  retryAdjudicatedInfraRoundIdsOnce,
}) {
  const { benchmarkProfile, runtimeProfile, competitorProfile, competitorProfiles } = composition;
  const { tasks: allTasks, taskSourceFingerprint } = await resolveFrozenBenchmarkTasks(
    benchmarkProfile,
    tasksRoot,
  );

  if (process.env.MAKA_HARNESS_AB_DRY_RUN === '1') {
    console.log(
      `dry-run: benchmark=${benchmarkProfile.id} (${benchmarkProfile.taskIds.length} frozen tasks via ${benchmarkProfile.executor}); runtime=${runtimeProfile.id} (${runtimeProfile.provider}/${runtimeProfile.model}, ${runtimeProfile.reasoningEffort}, ${runtimeProfile.billingMode}); competitors=${competitorProfiles.map((profile) => `${profile.id}@${profile.version}`).join(',')}; will run ${selection.limit} synchronized Pass@1 cohorts${benchmarkProfile.oracle ? '; Oracle evidence is advisory' : ''}`,
    );
    return;
  }

  const subjectFingerprint = await buildSubjectFingerprint(
    makaRepoPath,
    process.env.MAKA_HARNESS_AB_EXPLICIT_SUBJECT_FINGERPRINT,
    undefined,
    'MAKA_HARNESS_AB',
  );
  const hostToolchainFingerprint = await buildToolchainFingerprint(
    process.env.MAKA_HARNESS_AB_TOOLCHAIN_FINGERPRINT,
    undefined,
    makaRepoPath,
    'MAKA_HARNESS_AB',
  );
  const tasksById = new Map(allTasks.map((task) => [task.id, task]));
  const manifestPath = join(runRoot, 'harness-ab-manifest.json');
  // Oracle evidence is a Terminal-Bench/Harbor institution (the Maka oracle
  // verifier + advisory registry); DeepSWE grading is each task's own verifier,
  // so there is no oracle to consult.
  let oracleEvidence = null;
  if (benchmarkProfile.oracle) {
    const [verifierImplementationSource, composeImplementationSource] = await Promise.all([
      readFile(join(makaRepoPath, 'packages/headless/harbor/maka_verifier.py')),
      readFile(join(makaRepoPath, 'packages/headless/harbor/docker-compose-linux-amd64.yaml')),
    ]);
    const executionPolicyFingerprint = buildHarnessOracleExecutionPolicyFingerprint({
      verifierImplementationSource,
      composeImplementationSource,
    });
    oracleEvidence = await resolveHarnessOracleEvidenceForRun(manifestPath, () =>
      resolveAdvisoryOracleEvidence({
        allTasks,
        executionPolicyFingerprint,
      }),
    );
    for (const warning of oracleEvidence.warnings) console.warn(`warning: ${warning}`);
  }

  const credentials = await resolveHarnessRuntimeCredentials({
    composition,
    env: process.env,
  });

  const pierVersion = benchmarkProfile.executor === 'pier' ? await readPierVersion() : null;
  const makaPlacement = harnessMakaPlacement(benchmarkProfile);
  const aptMirrorName = harnessAptMirror(benchmarkProfile);
  const aptMirrorAddress = aptMirrorName ? (await lookup(aptMirrorName)).address : null;
  const toolchainFingerprint = buildHarnessAbToolchainFingerprint({
    hostToolchainFingerprint,
    competitorProfile,
    competitorProfiles,
    pierVersion,
    makaNodeToolchainFingerprint:
      makaPlacement === 'task-container' ? MAKA_NODE_TOOLCHAIN_FINGERPRINT : null,
  });
  const proposedManifest = buildHarnessAbManifest({
    subjectFingerprint,
    taskSourceFingerprint,
    toolchainFingerprint,
    composition,
    taskIds: selection.taskIds,
    pairConcurrency: executionPolicy.pairConcurrency,
    armExecution: executionPolicy.armExecution,
    ...(oracleEvidence ? { oracleEvidence } : {}),
    credentialIdentity: credentials.credentialIdentity,
    pierVersion,
    aptMirrorAddress,
  });
  const manifest = await resolveHarnessAbManifestForRun({
    manifestPath,
    proposedManifest,
    retryRoundIds: retryAdjudicatedInfraRoundIdsOnce,
    expectedExistingFingerprint: process.env.MAKA_HARNESS_AB_EXPECTED_EXISTING_MANIFEST_FINGERPRINT,
  });
  const evaluationTasks = manifest.evaluationTaskIds
    .slice(0, selection.limit)
    .map((taskId) => tasksById.get(taskId));
  if (evaluationTasks.some((task) => !task))
    throw new Error('manifest contains a task absent from the frozen task source');

  const competitorToolchains = new Map(
    competitorProfiles.map((profile) => [
      profile.id,
      resolveHarnessCompetitorToolchain(runRoot, profile),
    ]),
  );
  const makaNodeToolchain =
    makaPlacement === 'task-container' ? resolveHarnessMakaNodeToolchain(runRoot) : null;
  const aptMirrorComposePath = aptMirrorAddress ? join(runRoot, 'apt-mirror.compose.yaml') : null;
  await Promise.all([
    ...[...competitorToolchains.values()].map((toolchain) => toolchain.prepare(toolchain.path)),
    makaNodeToolchain?.prepare(makaNodeToolchain.path),
    aptMirrorComposePath
      ? writeFile(aptMirrorComposePath, aptMirrorComposeContent(aptMirrorAddress))
      : null,
  ]);

  const execution = buildHarnessExecutionProfile(runtimeProfile);
  if (
    credentials.apiKeyFile &&
    (await readFile(credentials.apiKeyFile, 'utf8')).trim().length === 0
  )
    throw new Error('harness credential is empty');
  const systemPromptPath = join(runRoot, 'prompts', 'default-system-prompt.txt');
  const evaluatedTaskIds = new Set(evaluationTasks.map((task) => task.id));
  const providerProxyHub =
    benchmarkProfile.executor === 'pier'
      ? await createPierProviderProxyHub(resolveHarnessProviderProxyHubOptions())
      : undefined;

  const report = await runExperiment({
    runRoot,
    prompts: () => [{ path: systemPromptPath, content: DEFAULT_HEADLESS_SYSTEM_PROMPT }],
    run: async ({ jobsDir, resultsJsonlPath }) => {
      // The benchmark owns its executor: Terminal-Bench trials run under plain
      // Harbor, DeepSWE trials under Pier. The two runners share the TaskRunner
      // contract; only the base-URL channel and Docker-platform pin differ
      // (Pier's EnvironmentConfig cannot carry an explicit platform).
      const createBenchmarkRunner =
        benchmarkProfile.executor === 'pier' ? createPierTaskRunner : createHarborTaskRunner;
      const runnerOptions = {
        makaRepoPath,
        jobsDir,
        model: execution.modelSpec,
        provider: execution.provider,
        reasoningEffort: execution.reasoningEffort,
        ...credentials,
        pricing: execution.pricing,
        timeoutMultiplier: 1,
        ...(benchmarkProfile.executor === 'pier'
          ? {
              baseUrl: execution.baseUrl,
              makaNodeToolchainPath: makaNodeToolchain.path,
              providerProxyHub,
            }
          : {
              agentEnv: { MAKA_BASE_URL: execution.baseUrl },
              dockerPlatform: 'linux/amd64',
              ...(aptMirrorComposePath ? { aptMirrorComposePath } : {}),
            }),
      };
      const config = (id) => ({
        id: `harness-ab-${id}`,
        backend: 'ai-sdk',
        llmConnectionSlug: execution.provider,
        model: execution.model,
        thinkingLevel: execution.reasoningEffort,
      });
      const arms = [
        {
          id: 'maka',
          config: config('maka'),
          expectedPricingProfile: execution.pricing.source,
          billingMode: execution.billingMode,
          harborRunner: createBenchmarkRunner({
            ...runnerOptions,
            agent: 'maka',
            agentEnv: { ...runnerOptions.agentEnv, ...harnessMakaAgentEnv(benchmarkProfile) },
            // Harbor needs both to place the arm: the placement decides the
            // provider channel and the loopback address, the toolchain is what
            // the container has to execute the repo mount with.
            ...(benchmarkProfile.executor === 'pier'
              ? {}
              : {
                  makaPlacement,
                  ...(makaNodeToolchain ? { makaNodeToolchainPath: makaNodeToolchain.path } : {}),
                }),
          }),
        },
        ...competitorProfiles.map((profile) => {
          const toolchain = competitorToolchains.get(profile.id);
          if (!toolchain) throw new Error(`missing toolchain for ${profile.id}`);
          return {
            id: profile.id,
            config: config(profile.id),
            expectedPricingProfile: execution.pricing.source,
            billingMode: execution.billingMode,
            harborRunner: createBenchmarkRunner({
              ...runnerOptions,
              agent: profile.id,
              agentVersion: profile.version,
              [profile.runnerToolchainOption]: toolchain.path,
            }),
          };
        }),
      ];
      const runInput = {
        runId,
        runRoot,
        resultsJsonlPath,
        systemPromptPath,
        resumeFingerprint: buildHarnessAbResumeFingerprint(manifest),
        evaluationTasks,
        arms,
        pairConcurrency: manifest.maxConcurrency,
        armExecution: manifest.metadata.execution.armExecution,
        retryAdjudicatedInfraRoundIdsOnce,
      };
      const reportOracleEvidence = oracleEvidence
        ? {
            ...(oracleEvidence.resolvedSnapshotFingerprint
              ? { snapshotFingerprint: oracleEvidence.resolvedSnapshotFingerprint }
              : {}),
            annotations: oracleEvidence.annotations.filter((annotation) =>
              evaluatedTaskIds.has(annotation.taskId),
            ),
            warnings: oracleEvidence.warnings,
          }
        : { annotations: [], warnings: [] };
      if (competitorProfiles.length > 1) {
        const summary = await runHarnessArmCohortUnlocked(runInput);
        return buildHarnessCohortReport(
          summary,
          reportOracleEvidence,
          execution.billingMode,
          manifest,
        );
      }
      const summary = await runHarnessAbComparisonUnlocked(runInput);
      return buildHarnessAbReport(summary, reportOracleEvidence, execution.billingMode, manifest);
    },
    artifacts: (report) => {
      const cohort = report.schemaVersion === 'maka.harness_cohort.report.v1';
      const basename = cohort ? 'harness-cohort-report' : 'harness-ab-report';
      return [
        {
          path: join(runRoot, `${basename}.json`),
          content: `${JSON.stringify(report, null, 2)}\n`,
        },
        {
          path: join(runRoot, `${basename}.csv`),
          content: cohort ? renderHarnessCohortReportCsv(report) : renderHarnessAbReportCsv(report),
        },
        {
          path: join(runRoot, `${basename}.md`),
          content: cohort
            ? renderHarnessCohortReportMarkdown(report)
            : renderHarnessAbReportMarkdown(report),
        },
      ];
    },
  }).finally(() => providerProxyHub?.close());
  if (report.schemaVersion === 'maka.harness_cohort.report.v1') {
    if (report.runStatus !== 'completed') {
      throw new Error(`harness cohort run ${report.runId} ended with status ${report.runStatus}`);
    }
    console.log(
      `${report.runStatus}: ${report.commonCohort.comparableGroups}/${report.commonCohort.groups} common Pass@1 cohorts -> ${runRoot}`,
    );
  } else {
    assertHarnessAbReportCompleted(report);
    console.log(
      `${report.runStatus}: ${report.coverage.attemptedCells}/${report.coverage.scheduledCells} cells attempted; ${report.effectiveness.pairedEvaluated} paired Pass@1 outcomes -> ${runRoot}`,
    );
  }
}

export async function resolveAdvisoryOracleEvidence({
  allTasks,
  executionPolicyFingerprint,
  registryUrl = process.env.MAKA_HARNESS_AB_ORACLE_REGISTRY_URL?.trim(),
  expectedSnapshotFingerprint = process.env.MAKA_HARNESS_AB_ORACLE_REGISTRY_FINGERPRINT?.trim(),
  loadSnapshot = loadHarnessOracleRegistrySnapshot,
  buildAuditTasks = buildHarnessOracleAuditTasks,
  resolveBaseImageDigest = resolveHarnessOracleBaseImageDigest,
  resolutionTimeoutMs = ORACLE_EVIDENCE_RESOLUTION_TIMEOUT_MS,
}) {
  const warnings = [];
  let snapshot = null;
  let annotations;
  if (registryUrl && expectedSnapshotFingerprint) {
    const controller = new AbortController();
    let timeout;
    try {
      const resolution = (async () => {
        snapshot = await loadSnapshot({
          url: registryUrl,
          expectedFingerprint: expectedSnapshotFingerprint,
          signal: controller.signal,
        });
        const digestCache = new Map();
        const auditTasks = await buildAuditTasks({
          tasks: allTasks,
          executionPolicyFingerprint,
          environment: 'docker',
          platform: HARBOR_ORACLE_DOCKER_PLATFORM,
          resolveBaseImageDigest: (reference, platform) =>
            resolveBaseImageDigest(reference, platform, digestCache, controller.signal),
        });
        return resolveHarnessOracleAnnotations(auditTasks, snapshot);
      })();
      annotations = await Promise.race([
        resolution,
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error('Oracle evidence resolution timed out'));
          }, resolutionTimeoutMs);
        }),
      ]);
    } catch {
      snapshot = null;
      warnings.push('Oracle registry could not be resolved; A/B continues without it');
    } finally {
      clearTimeout(timeout);
    }
  } else {
    warnings.push(
      'Oracle registry URL and fingerprint are not both configured; A/B continues without it',
    );
  }
  annotations ??= allTasks.map((task) => ({ taskId: task.id, state: 'missing' }));
  return {
    ...(registryUrl ? { registryUrl } : {}),
    ...(expectedSnapshotFingerprint ? { expectedSnapshotFingerprint } : {}),
    ...(snapshot ? { resolvedSnapshotFingerprint: snapshot.fingerprint } : {}),
    annotations,
    warnings,
  };
}

export async function resolveHarnessOracleEvidenceForRun(manifestPath, resolveEvidence) {
  const stored = await readAbRunManifest(manifestPath);
  if (stored?.experimentKind === 'harness' && stored.metadata?.oracleEvidence) {
    return stored.metadata.oracleEvidence;
  }
  return resolveEvidence();
}

export async function resolveHarnessOracleBaseImageDigest(
  reference,
  platform,
  cache = new Map(),
  signal,
) {
  const key = `${platform}:${reference}`;
  if (!cache.has(key)) {
    cache.set(
      key,
      execFileAsync(
        'docker',
        ['buildx', 'imagetools', 'inspect', reference, '--format', '{{json .Manifest}}'],
        { signal },
      ).then(({ stdout }) => resolvedImageDigestFromInspect(stdout, platform)),
    );
  }
  return cache.get(key);
}

export function resolvedImageDigestFromInspect(raw, platform) {
  const value = JSON.parse(raw);
  const [os, architecture] = platform.split('/');
  const selected = Array.isArray(value.manifests)
    ? value.manifests.find(
        (manifest) =>
          manifest?.platform?.os === os && manifest?.platform?.architecture === architecture,
      )?.digest
    : value.digest;
  if (typeof selected !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(selected)) {
    throw new Error(`Docker image manifest has no ${platform} digest`);
  }
  return selected;
}

function backgroundJournal(runRoot) {
  if (process.env[BACKGROUND_RUN_ENV] !== '1') return null;
  const logPath = join(runRoot, BACKGROUND_LOG_FILENAME);
  return {
    path: join(runRoot, BACKGROUND_JOURNAL_FILENAME),
    base: {
      schemaVersion: 1,
      pid: process.pid,
      startedAt: process.env[BACKGROUND_STARTED_AT_ENV] || new Date().toISOString(),
      logPath,
    },
  };
}

async function writeBackgroundJournal(path, value) {
  const pendingPath = `${path}.${process.pid}.tmp`;
  await writeFile(pendingPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(pendingPath, path);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
