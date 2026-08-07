import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { BENCHMARK_IDENTITY } from './benchmark-identity.js';
import { buildHarborJobConfig } from '../harbor-task-runner.js';

const execFileAsync = promisify(execFile);

test('harness A/B CLI rejects an unsupported composition before creating a run root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-composition-'));
  try {
    const outDir = join(dir, 'out');
    const scriptPath = new URL('../../harbor/run-harness-ab.mjs', import.meta.url);
    await assert.rejects(
      execFileAsync(process.execPath, [scriptPath.pathname], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAKA_HARNESS_AB_OUT_DIR: outDir,
          MAKA_HARNESS_AB_RUNTIME: 'zai-coding-plan-glm-5.2-max',
          MAKA_HARNESS_AB_COMPETITOR: 'kimi-code',
          MAKA_HARNESS_AB_TASKS_ROOT: join(dir, 'missing-tasks'),
          MAKA_HARNESS_AB_DRY_RUN: '1',
        },
      }),
      /unsupported harness composition/,
    );
    await assert.rejects(readdir(outDir), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('harness A/B runtime keeps pruning enabled and semantic compact disabled', async () => {
  const { harnessMakaAgentEnv, harnessMakaContextBudgetEnv, resolveHarnessBenchmarkProfile } =
    await import(new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href);

  assert.deepEqual(harnessMakaContextBudgetEnv(), {
    MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE: 'on',
    MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MAX_ESTIMATED_TOKENS: '2048',
    MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MIN_STEP_NUMBER: '1',
    MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on',
    MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_ESTIMATED_TOKENS: '2048',
    MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS_FULL: '0',
    MAKA_CONTEXT_SEMANTIC_COMPACT: 'off',
  });
  assert.equal(
    harnessMakaAgentEnv(resolveHarnessBenchmarkProfile('deep-swe-1.1')).MAKA_HARBOR_MODE,
    'task-run',
  );
  assert.equal(
    'MAKA_HARBOR_MODE' in harnessMakaAgentEnv(resolveHarnessBenchmarkProfile('terminal-bench-2.1')),
    false,
  );
});

test('harness A/B uses one safe execution default and accepts per-run overrides', async () => {
  const { resolveHarnessAbExecutionPolicy } = await import(
    new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href
  );

  assert.deepEqual(resolveHarnessAbExecutionPolicy(undefined, undefined, 30), {
    pairConcurrency: 1,
    armExecution: 'sequential',
  });
  assert.deepEqual(resolveHarnessAbExecutionPolicy('1', 'parallel', 30), {
    pairConcurrency: 1,
    armExecution: 'parallel',
  });
  assert.deepEqual(resolveHarnessAbExecutionPolicy('4', 'sequential', 2), {
    pairConcurrency: 2,
    armExecution: 'sequential',
  });
  assert.throws(
    () => resolveHarnessAbExecutionPolicy('17', undefined, 30),
    /MAKA_HARNESS_AB_PAIR_CONCURRENCY must be an integer between 1 and 16/,
  );
  assert.throws(
    () => resolveHarnessAbExecutionPolicy(undefined, 'together', 30),
    /MAKA_HARNESS_AB_ARM_EXECUTION must be sequential or parallel/,
  );
  assert.throws(
    () => resolveHarnessAbExecutionPolicy(undefined, undefined, 0),
    /harness A\/B execution policy requires at least one task/,
  );
});

test('harness A/B parses an explicit one-shot adjudicated infra retry', async () => {
  const { resolveHarnessAdjudicatedInfraRetryRoundIds } = await import(
    new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href
  );

  assert.deepEqual(resolveHarnessAdjudicatedInfraRetryRoundIds(undefined), []);
  assert.deepEqual(
    resolveHarnessAdjudicatedInfraRetryRoundIds(' ab-maka-r0-winning-avg-corewars '),
    ['ab-maka-r0-winning-avg-corewars'],
  );
  assert.throws(() => resolveHarnessAdjudicatedInfraRetryRoundIds(' , '), /must not be empty/);
  assert.throws(
    () => resolveHarnessAdjudicatedInfraRetryRoundIds('ab-maka-r0-a,ab-maka-r0-a'),
    /must not contain duplicates/,
  );
});

test('harness A/B resumes an explicit infra retry from the frozen manifest identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-frozen-resume-'));
  try {
    const { buildHarnessAbManifest, resolveHarnessAbManifestForRun, resolveHarnessComposition } =
      await import(new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href);
    const manifestPath = join(dir, 'harness-ab-manifest.json');
    const composition = resolveHarnessComposition({
      runtime: 'deepseek-v4-flash-max',
      competitor: 'opencode',
    });
    const taskIds = ['winning-avg-corewars'];
    const frozen = buildHarnessAbManifest({
      subjectFingerprint: `sha256:${'1'.repeat(64)}`,
      taskSourceFingerprint: `sha256:${'2'.repeat(64)}`,
      toolchainFingerprint: `sha256:${'3'.repeat(64)}`,
      composition,
      taskIds,
      pairConcurrency: 1,
      armExecution: 'parallel',
    });
    await writeFile(manifestPath, `${JSON.stringify(frozen)}\n`, 'utf8');
    const current = buildHarnessAbManifest({
      subjectFingerprint: `sha256:${'4'.repeat(64)}`,
      taskSourceFingerprint: frozen.taskSourceFingerprint,
      toolchainFingerprint: `sha256:${'5'.repeat(64)}`,
      composition,
      taskIds,
      pairConcurrency: 1,
      armExecution: 'parallel',
    });

    assert.deepEqual(
      await resolveHarnessAbManifestForRun({
        manifestPath,
        proposedManifest: current,
        retryRoundIds: ['ab-maka-r0-winning-avg-corewars'],
        expectedExistingFingerprint: frozen.fingerprint,
      }),
      frozen,
    );
    await assert.rejects(
      resolveHarnessAbManifestForRun({
        manifestPath,
        proposedManifest: current,
        retryRoundIds: [],
        expectedExistingFingerprint: frozen.fingerprint,
      }),
      /requires an explicit adjudicated infra retry/,
    );

    const changedSchedule = buildHarnessAbManifest({
      subjectFingerprint: current.subjectFingerprint,
      taskSourceFingerprint: current.taskSourceFingerprint,
      toolchainFingerprint: current.toolchainFingerprint,
      composition,
      taskIds,
      pairConcurrency: 1,
      armExecution: 'sequential',
    });
    await assert.rejects(
      resolveHarnessAbManifestForRun({
        manifestPath,
        proposedManifest: changedSchedule,
        retryRoundIds: ['ab-maka-r0-winning-avg-corewars'],
        expectedExistingFingerprint: frozen.fingerprint,
      }),
      /differs beyond the frozen subject and toolchain identity/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('harness A/B selects one named task only with an explicit run identity', async () => {
  const {
    buildHarnessAbManifest,
    resolveHarnessAbTaskSelection,
    resolveHarnessAbRunId,
    resolveHarnessComposition,
  } = await import(new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href);
  const taskId = 'extract-moves-from-video';
  const selection = resolveHarnessAbTaskSelection(taskId, undefined, undefined);

  assert.deepEqual(selection, { taskIds: [taskId], limit: 1 });
  assert.throws(
    () => resolveHarnessAbTaskSelection('not-a-terminal-bench-task', undefined, undefined),
    /MAKA_HARNESS_AB_TASK_ID must name a Terminal-Bench 2\.1 task/,
  );
  assert.throws(
    () => resolveHarnessAbRunId(resolveHarnessComposition(), undefined, taskId),
    /MAKA_HARNESS_AB_RUN_ID is required with MAKA_HARNESS_AB_TASK_ID/,
  );

  const manifest = buildHarnessAbManifest({
    subjectFingerprint: 'subject',
    taskSourceFingerprint: 'tasks',
    toolchainFingerprint: 'tools',
    taskIds: selection.taskIds,
  });
  assert.deepEqual(manifest.evaluationTaskIds, [taskId]);
  assert.equal(manifest.metadata.order.pilotTaskCount, 1);
  assert.equal(manifest.maxConcurrency, 1);
  assert.equal(manifest.maxConcurrentAttempts, 1);
});

test('harness A/B resumes a run at a different concurrency', async () => {
  // Pacing is not identity, and the layer that decides identity is the manifest
  // gate: it compares the whole manifest, pacing included, and refuses with
  // "A/B run manifest does not match existing run id". Recovering three
  // infra-failed cells out of an 89-task sweep therefore meant reproducing the
  // sweep's concurrency number, on pain of not recovering the data at all —
  // while the arms, the model and the task order were identical.
  const { buildHarnessAbManifest, buildHarnessAbRunInput, resolveHarnessAbManifestForRun } =
    await import(new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href);
  const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-resume-pace-'));
  try {
    const manifestPath = join(dir, 'run-manifest.json');
    const taskIds = ['bn-fit-modify', 'write-compressor'];
    const base = {
      subjectFingerprint: 'subject',
      taskSourceFingerprint: 'tasks',
      toolchainFingerprint: 'tools',
      taskIds,
    };
    const sweep = buildHarnessAbManifest({ ...base, pairConcurrency: 2 });
    const recovery = buildHarnessAbManifest({ ...base, pairConcurrency: 1 });
    assert.notEqual(sweep.fingerprint, recovery.fingerprint);

    const created = await resolveHarnessAbManifestForRun({
      manifestPath,
      proposedManifest: sweep,
      retryRoundIds: [],
    });
    assert.equal(created.fingerprint, sweep.fingerprint);

    const resumed = await resolveHarnessAbManifestForRun({
      manifestPath,
      proposedManifest: recovery,
      retryRoundIds: [],
    });
    // Same run: the operator gets the run they were resuming, still recording
    // the pace it was created with.
    assert.equal(resumed.fingerprint, sweep.fingerprint);
    assert.equal(resumed.maxConcurrency, 2);

    // And the pace the operator asked for is the pace that runs. The gate hands
    // back the run's original manifest, so reading pace from it would let the
    // resume pass and then silently run at the old pace.
    const runInput = buildHarnessAbRunInput({
      runId: 'run',
      runRoot: dir,
      resultsJsonlPath: join(dir, 'results.jsonl'),
      systemPromptPath: join(dir, 'prompt.txt'),
      manifest: resumed,
      evaluationTasks: [],
      arms: [],
      executionPolicy: { pairConcurrency: 1, armExecution: 'parallel' },
      retryAdjudicatedInfraRoundIdsOnce: [],
    });
    assert.equal(resumed.maxConcurrency, 2);
    assert.equal(runInput.pairConcurrency, 1);

    // Identity itself still holds. A different task set is a different run.
    await assert.rejects(
      resolveHarnessAbManifestForRun({
        manifestPath,
        proposedManifest: buildHarnessAbManifest({
          ...base,
          taskIds: ['bn-fit-modify', 'adaptive-rejection-sampler'],
          pairConcurrency: 2,
        }),
        retryRoundIds: [],
      }),
      /A\/B run manifest does not match existing run id/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('harness A/B selects an explicit task subset in one resumable run', async () => {
  const { resolveHarnessAbRunId, resolveHarnessAbTaskSelection, resolveHarnessComposition } =
    await import(new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href);
  const taskIds = ['bn-fit-modify', 'write-compressor'];
  const composition = resolveHarnessComposition({ competitor: 'codex' });
  const selection = resolveHarnessAbTaskSelection(undefined, undefined, taskIds.join(','));

  assert.deepEqual(selection, { taskIds, limit: 2 });
  assert.throws(
    () => resolveHarnessAbRunId(composition, undefined, undefined, taskIds.join(',')),
    /MAKA_HARNESS_AB_RUN_ID is required with MAKA_HARNESS_AB_TASK_IDS/,
  );
  assert.throws(
    () => resolveHarnessAbTaskSelection(taskIds[0], undefined, taskIds.join(',')),
    /MAKA_HARNESS_AB_TASK_ID and MAKA_HARNESS_AB_TASK_IDS are mutually exclusive/,
  );
  assert.throws(
    () => resolveHarnessAbTaskSelection(undefined, undefined, `${taskIds[0]},${taskIds[0]}`),
    /MAKA_HARNESS_AB_TASK_IDS must not contain duplicate task ids/,
  );
  assert.throws(
    () => resolveHarnessAbTaskSelection(undefined, undefined, ' , '),
    /MAKA_HARNESS_AB_TASK_IDS must contain at least one task id/,
  );
  assert.throws(
    () => resolveHarnessAbTaskSelection(undefined, undefined, 'not-a-terminal-bench-task'),
    /MAKA_HARNESS_AB_TASK_IDS contains unknown Terminal-Bench 2\.1 tasks/,
  );
});

test('harness A/B records its configured execution policy in the manifest', async () => {
  const { buildHarnessAbManifest, resolveHarnessAbExecutionPolicy, resolveHarnessAbTaskSelection } =
    await import(new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href);
  const selection = resolveHarnessAbTaskSelection(undefined, '89', undefined);
  const executionPolicy = resolveHarnessAbExecutionPolicy(
    '2',
    'parallel',
    selection.taskIds.length,
  );
  const manifest = buildHarnessAbManifest({
    subjectFingerprint: 'subject',
    taskSourceFingerprint: 'tasks',
    toolchainFingerprint: 'tools',
    taskIds: selection.taskIds,
    ...executionPolicy,
  });

  assert.equal(selection.limit, 89);
  assert.equal(manifest.maxConcurrency, 2);
  assert.equal(manifest.maxConcurrentAttempts, 4);
});

test('harness Oracle environment selects the linux/amd64 image manifest digest', async () => {
  const { resolvedImageDigestFromInspect } = await import(
    new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href
  );
  const digest = resolvedImageDigestFromInspect(
    JSON.stringify({
      digest: `sha256:${'0'.repeat(64)}`,
      manifests: [
        { digest: `sha256:${'a'.repeat(64)}`, platform: { os: 'linux', architecture: 'arm64' } },
        { digest: `sha256:${'b'.repeat(64)}`, platform: { os: 'linux', architecture: 'amd64' } },
      ],
    }),
    'linux/amd64',
  );

  assert.equal(digest, `sha256:${'b'.repeat(64)}`);
});

test('harness A/B degrades identity resolution failures to missing advisory evidence', async () => {
  const { resolveAdvisoryOracleEvidence } = await import(
    new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href
  );
  const evidence = await resolveAdvisoryOracleEvidence({
    allTasks: [{ id: 'task-a', path: '/tasks/task-a' }],
    executionPolicyFingerprint: `sha256:${'a'.repeat(64)}`,
    registryUrl: 'https://example.invalid/oracle-registry.json',
    expectedSnapshotFingerprint: `sha256:${'b'.repeat(64)}`,
    loadSnapshot: async () => ({ fingerprint: `sha256:${'b'.repeat(64)}` }),
    buildAuditTasks: async () => {
      throw new Error('registry unavailable');
    },
  });

  assert.deepEqual(evidence.annotations, [{ taskId: 'task-a', state: 'missing' }]);
  assert.deepEqual(evidence.warnings, [
    'Oracle registry could not be resolved; A/B continues without it',
  ]);
});

test('harness A/B keeps advisory task states structured instead of duplicating corpus warnings', async () => {
  const { resolveAdvisoryOracleEvidence } = await import(
    new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href
  );
  const evidence = await resolveAdvisoryOracleEvidence({
    allTasks: [
      { id: 'task-a', path: '/tasks/task-a' },
      { id: 'task-b', path: '/tasks/task-b' },
    ],
    executionPolicyFingerprint: `sha256:${'a'.repeat(64)}`,
    registryUrl: undefined,
    expectedSnapshotFingerprint: undefined,
  });

  assert.deepEqual(evidence.annotations, [
    { taskId: 'task-a', state: 'missing' },
    { taskId: 'task-b', state: 'missing' },
  ]);
  assert.deepEqual(evidence.warnings, [
    'Oracle registry URL and fingerprint are not both configured; A/B continues without it',
  ]);
});

test('harness A/B bounds a stalled advisory evidence lookup', async () => {
  const { resolveAdvisoryOracleEvidence } = await import(
    new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href
  );
  const resolution = resolveAdvisoryOracleEvidence({
    allTasks: [{ id: 'task-a', path: '/tasks/task-a' }],
    executionPolicyFingerprint: `sha256:${'a'.repeat(64)}`,
    registryUrl: 'https://example.invalid/oracle-registry.json',
    expectedSnapshotFingerprint: `sha256:${'b'.repeat(64)}`,
    resolutionTimeoutMs: 10,
    loadSnapshot: async () => new Promise(() => {}),
  });

  const evidence = await Promise.race([
    resolution,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('advisory lookup remained pending')), 100),
    ),
  ]);

  assert.deepEqual(evidence.annotations, [{ taskId: 'task-a', state: 'missing' }]);
});

test('harness A/B freezes the stored advisory evidence when resuming a run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-evidence-resume-'));
  try {
    const { buildHarnessAbManifest, resolveHarnessOracleEvidenceForRun } = await import(
      new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href
    );
    const oracleEvidence = {
      annotations: [{ taskId: 'task-a', state: 'missing' }],
      warnings: ['frozen warning'],
    };
    const manifest = buildHarnessAbManifest({
      subjectFingerprint: 'subject',
      taskSourceFingerprint: 'tasks',
      toolchainFingerprint: 'tools',
      oracleEvidence,
    });
    const path = join(dir, 'harness-ab-manifest.json');
    await writeFile(path, `${JSON.stringify(manifest)}\n`, 'utf8');
    let resolved = false;

    const evidence = await resolveHarnessOracleEvidenceForRun(path, async () => {
      resolved = true;
      return { annotations: [], warnings: [] };
    });

    assert.deepEqual(evidence, oracleEvidence);
    assert.equal(resolved, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('harness A/B defaults to pinned Kimi Code and keeps OpenCode selectable', async () => {
  const {
    buildHarnessAbManifest,
    resolveHarnessAbRunId,
    resolveHarnessComposition,
    resolveHarnessCompetitorProfile,
    resolveHarnessCompetitorToolchainPath,
  } = await import(new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href);

  const manifest = buildHarnessAbManifest({
    subjectFingerprint: 'subject',
    taskSourceFingerprint: 'tasks',
    toolchainFingerprint: 'tools',
  });

  const competitor = manifest.arms.find((arm: { id: string }) => arm.id === 'kimi-code');
  assert.equal(competitor?.metadata.version, '0.26.0');
  assert.equal(competitor?.metadata.config.profile, 'kimi-code');
  assert.equal(competitor?.metadata.config.permissions, 'prompt-auto');
  assert.equal(resolveHarnessCompetitorProfile('opencode').version, '1.17.18');
  const codexProfile = resolveHarnessCompetitorProfile('codex');
  const codexComposition = resolveHarnessComposition({ competitor: 'codex' });
  assert.equal(codexProfile.version, '0.146.0');
  assert.deepEqual(codexComposition.runtimeProfile, {
    id: 'openai-codex-gpt-5.6-sol-xhigh',
    provider: 'openai-codex',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'xhigh',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    billingMode: 'account-plan',
    pricing: {
      currency: 'USD',
      unit: 'per_1m_tokens',
      input: 0,
      cachedInput: 0,
      output: 0,
      source: 'openai-codex-chatgpt-account-plan',
    },
    auth: {
      kind: 'codex-oauth',
      defaultConnectionSlug: 'codex-subscription',
    },
  });
  assert.equal(codexProfile.config.permissions, 'container-full-access');
  assert.equal(codexProfile.config.transport, 'responses-http');
  assert.equal('armExecution' in codexProfile, false);
  assert.equal('maxPairConcurrency' in codexProfile, false);
  const codexManifest = buildHarnessAbManifest({
    subjectFingerprint: 'subject',
    taskSourceFingerprint: 'tasks',
    toolchainFingerprint: 'tools',
    composition: codexComposition,
  });
  assert.deepEqual(codexManifest.metadata.execution, { armExecution: 'sequential' });
  assert.equal(codexManifest.arms[1]?.metadata?.config.adapter, 'codex_agent:MakaCodexAgent');
  assert.equal(codexManifest.maxConcurrency, 1);
  assert.equal(codexManifest.maxConcurrentAttempts, 1);
  assert.throws(() => resolveHarnessCompetitorProfile('unknown'), /MAKA_HARNESS_AB_COMPETITOR/);
  assert.deepEqual(manifest.metadata.model, {
    provider: 'kimi-coding-plan',
    id: 'k3',
    reasoningEffort: 'max',
  });
  assert.deepEqual(manifest.metadata.pricing, {
    currency: 'USD',
    unit: 'per_1m_tokens',
    input: 0,
    cachedInput: 0,
    output: 0,
    source: 'kimi-coding-plan-account-plan',
  });
  assert.equal(manifest.metadata.order.pilotTaskCount, 5);
  assert.equal(manifest.maxConcurrency, 1);
  assert.equal(manifest.maxConcurrentAttempts, 1);
  const kimiProfile = resolveHarnessCompetitorProfile('kimi-code');
  assert.equal(
    resolveHarnessAbRunId(resolveHarnessComposition()),
    'k3-maka-vs-kimi-code-tbench-2.1-full-v2',
  );
  assert.match(
    resolveHarnessCompetitorToolchainPath('/run', kimiProfile),
    new RegExp(`kimi-code-0\\.26\\.0-${kimiProfile.toolchainFingerprint.slice(7, 19)}-linux-x64$`),
  );
  for (const arm of manifest.arms) {
    assert.equal(arm.metadata.config.billingMode, 'account-plan');
  }
});

test('harness A/B resolves an explicit GLM 5.2 runtime independently from OpenCode', async () => {
  const {
    buildHarnessAbManifest,
    buildHarnessExecutionProfile,
    resolveHarnessAbRunId,
    resolveHarnessComposition,
  } = await import(new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href);
  const composition = resolveHarnessComposition({
    env: {
      MAKA_HARNESS_AB_BENCHMARK: 'terminal-bench-2.1',
      MAKA_HARNESS_AB_RUNTIME: 'zai-coding-plan-glm-5.2-max',
      MAKA_HARNESS_AB_COMPETITOR: 'opencode',
    },
  });

  assert.deepEqual(buildHarnessExecutionProfile(composition.runtimeProfile), {
    modelSpec: 'zai-coding-plan/glm-5.2',
    provider: 'zai-coding-plan',
    model: 'glm-5.2',
    reasoningEffort: 'max',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    billingMode: 'account-plan',
    pricing: {
      inputUsdPer1M: 0,
      cacheReadUsdPer1M: 0,
      outputUsdPer1M: 0,
      source: 'zai-coding-plan-account-plan',
    },
  });

  const manifest = buildHarnessAbManifest({
    subjectFingerprint: 'subject',
    taskSourceFingerprint: 'tasks',
    toolchainFingerprint: 'tools',
    composition,
  });
  assert.deepEqual(manifest.metadata.model, {
    provider: 'zai-coding-plan',
    id: 'glm-5.2',
    reasoningEffort: 'max',
  });
  assert.deepEqual(manifest.metadata.pricing, {
    currency: 'USD',
    unit: 'per_1m_tokens',
    input: 0,
    cachedInput: 0,
    output: 0,
    source: 'zai-coding-plan-account-plan',
  });
  assert.equal(manifest.arms[1].id, 'opencode');
  assert.equal(manifest.arms[1].metadata.config.variant, 'max');
  assert.equal(manifest.arms[1].metadata.config.billingMode, 'account-plan');
  assert.equal(resolveHarnessAbRunId(composition), 'glm-5.2-maka-vs-opencode-tbench-2.1-full-v1');
});

test('harness A/B freezes current DeepSeek V4 Flash metered pricing', async () => {
  const {
    buildHarnessAbManifest,
    buildHarnessExecutionProfile,
    resolveHarnessAbRunId,
    resolveHarnessComposition,
    resolveHarnessRuntimeCredentials,
  } = await import(new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href);
  const composition = resolveHarnessComposition({
    runtime: 'deepseek-v4-flash-max',
    competitor: 'opencode',
  });

  assert.deepEqual(buildHarnessExecutionProfile(composition.runtimeProfile), {
    modelSpec: 'deepseek/deepseek-v4-flash',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'max',
    baseUrl: 'https://api.deepseek.com',
    billingMode: 'metered',
    pricing: {
      inputUsdPer1M: 0.14,
      cacheReadUsdPer1M: 0.0028,
      cacheWriteUsdPer1M: 0,
      outputUsdPer1M: 0.28,
      source: 'deepseek-v4-flash',
    },
  });
  assert.deepEqual(
    await resolveHarnessRuntimeCredentials({
      composition,
      env: { MAKA_HARNESS_AB_DEEPSEEK_KEY_FILE: '/secrets/deepseek.key' },
    }),
    { apiKeyFile: '/secrets/deepseek.key' },
  );

  const manifest = buildHarnessAbManifest({
    subjectFingerprint: 'subject',
    taskSourceFingerprint: 'tasks',
    toolchainFingerprint: 'tools',
    composition,
  });
  assert.deepEqual(manifest.metadata.pricing, {
    currency: 'USD',
    unit: 'per_1m_tokens',
    input: 0.14,
    cachedInput: 0.0028,
    cacheWrite: 0,
    output: 0.28,
    source: 'deepseek-v4-flash',
  });
  assert.equal(manifest.arms[1].id, 'opencode');
  assert.equal(manifest.arms[1].metadata.config.billingMode, 'metered');
  assert.equal(
    resolveHarnessAbRunId(composition),
    'deepseek-v4-flash-maka-vs-opencode-tbench-2.1-full-v1',
  );
});

test('harness A/B composition defaults preserve existing routes and reject unsupported triples', async () => {
  const {
    buildHarnessAbManifest,
    resolveHarnessAbRunId,
    resolveHarnessComposition,
    resolveHarnessCompetitorProfile,
    resolveHarnessRuntimeCredentials,
  } = await import(new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href);

  assert.equal(
    resolveHarnessComposition({ competitor: 'opencode' }).runtimeProfile.id,
    'kimi-coding-plan-k3-max',
  );
  assert.equal(
    resolveHarnessComposition({ competitor: 'codex' }).runtimeProfile.id,
    'openai-codex-gpt-5.6-sol-xhigh',
  );
  assert.equal(
    resolveHarnessComposition({
      env: {
        MAKA_HARNESS_AB_BENCHMARK: '',
        MAKA_HARNESS_AB_RUNTIME: '',
        MAKA_HARNESS_AB_COMPETITOR: '',
      },
    }).runtimeProfile.id,
    'kimi-coding-plan-k3-max',
  );
  assert.throws(
    () =>
      resolveHarnessComposition({
        runtime: 'zai-coding-plan-glm-5.2-max',
        competitor: 'kimi-code',
      }),
    /unsupported harness composition: benchmark=terminal-bench-2\.1, runtime=zai-coding-plan-glm-5\.2-max, competitor=kimi-code/,
  );
  assert.throws(
    () => resolveHarnessComposition({ benchmark: 'deep-swe-1.1', competitor: 'opencode' }),
    /unsupported harness composition: benchmark=deep-swe-1\.1, runtime=kimi-coding-plan-k3-max, competitor=opencode/,
  );
  assert.throws(
    () => resolveHarnessComposition({ runtime: 'unknown' }),
    /MAKA_HARNESS_AB_RUNTIME must be one of: kimi-coding-plan-k3-max, zai-coding-plan-glm-5\.2-max, deepseek-v4-flash-max, openai-codex-gpt-5\.6-sol-xhigh/,
  );

  const glmComposition = resolveHarnessComposition({
    runtime: 'zai-coding-plan-glm-5.2-max',
    competitor: 'opencode',
  });
  const forgedComposition = {
    ...glmComposition,
    competitorProfile: resolveHarnessCompetitorProfile('kimi-code'),
  };
  assert.throws(
    () =>
      buildHarnessAbManifest({
        subjectFingerprint: 'subject',
        taskSourceFingerprint: 'tasks',
        toolchainFingerprint: 'tools',
        composition: forgedComposition,
      }),
    /composition must come from resolveHarnessComposition/,
  );
  assert.throws(
    () => resolveHarnessAbRunId(forgedComposition),
    /composition must come from resolveHarnessComposition/,
  );
  await assert.rejects(
    resolveHarnessRuntimeCredentials({
      composition: forgedComposition,
      env: { MAKA_HARNESS_AB_KEY_FILE: '/secrets/zai.key' },
    }),
    /composition must come from resolveHarnessComposition/,
  );
});

test('harness CLI freezes the synchronized DeepSeek three-way composition', async () => {
  const {
    buildHarnessAbManifest,
    resolveHarnessAbRunId,
    resolveHarnessComposition,
    resolveHarnessCompetitorToolchain,
  } = await import(new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href);
  const composition = resolveHarnessComposition({ competitors: 'codex,claude-code' });
  assert.equal(composition.runtimeProfile.id, 'deepseek-v4-flash-max');
  assert.deepEqual(
    composition.competitorProfiles.map((profile: { id: string }) => profile.id),
    ['codex', 'claude-code'],
  );
  assert.equal(
    resolveHarnessAbRunId(composition),
    'deepseek-v4-flash-maka-vs-codex-vs-claude-code-tbench-2.1-full-v1',
  );
  const manifest = buildHarnessAbManifest({
    subjectFingerprint: 'subject',
    taskSourceFingerprint: 'tasks',
    toolchainFingerprint: 'tools',
    composition,
    taskIds: ['a', 'b', 'c', 'd', 'e'],
    pairConcurrency: 2,
    armExecution: 'parallel',
  });
  assert.deepEqual(
    manifest.arms.map((arm: { id: string }) => arm.id),
    ['maka', 'codex', 'claude-code'],
  );
  assert.equal(
    manifest.arms[1]?.metadata?.config.modelCatalogFingerprint,
    'sha256:faac5d862e0ce0bf5bcaccd515de04cf2dcd33cd38a53f0332fe2e8620ab7caa',
  );
  assert.deepEqual(
    manifest.arms.map(
      (arm: { metadata?: { config?: { transport?: string } } }) => arm.metadata?.config?.transport,
    ),
    // The Maka arm records the wire its runtime actually dials: deepseek-v4-flash
    // resolves to Responses, so a manifest claiming Chat here would describe a
    // run that never happened — and the proxy parsing it that way measured none
    // of it.
    ['openai-responses', 'openai-responses', 'anthropic-messages'],
  );
  assert.equal(manifest.maxConcurrentAttempts, 6);
  assert.equal(
    resolveHarnessCompetitorToolchain('/run', composition.competitorProfiles[1], {
      MAKA_HARNESS_AB_CLAUDE_CODE_TOOLCHAIN: '/prepared/claude-code',
    }).path,
    '/prepared/claude-code',
  );
});

// Baselines move only when arm identity genuinely changes; the current values
// cover the settlement-grace and externalSystemPrompt corrections, which both
// alter what an arm actually runs with.
test('harness composition preserves historical manifest fingerprints', async () => {
  const { buildHarnessAbManifest, resolveHarnessComposition } = await import(
    new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href
  );
  const cases = [
    {
      name: 'Terminal-Bench Kimi Code',
      composition: { competitor: 'kimi-code' },
      pierVersion: null,
      fingerprint: 'sha256:6469fb00ceeec168799d67bb84d73a288cd7b68e118f36398185a298278fe2ab',
    },
    {
      name: 'Terminal-Bench OpenCode',
      composition: { competitor: 'opencode' },
      pierVersion: null,
      fingerprint: 'sha256:375894a49ddfe2a2ce2c195c2b0f14075be4416135bb63e2382b400efc9f460b',
    },
    {
      name: 'Terminal-Bench Codex',
      composition: { competitor: 'codex' },
      pierVersion: null,
      fingerprint: 'sha256:d8907d44340a1ee4b2f35b015ce78faa527b6b6c4fcefb553556eb9011f54bb6',
    },
    {
      name: 'DeepSWE Kimi Code',
      composition: { benchmark: 'deep-swe-1.1', competitor: 'kimi-code' },
      pierVersion: '0.3.0',
      fingerprint: 'sha256:4e4b8fb414b9f3ba9ebe0697592cdc4f9cf20c2bad46d73a6f11c35670e9266a',
    },
    {
      name: 'DeepSWE Codex',
      composition: { benchmark: 'deep-swe-1.1', competitor: 'codex' },
      pierVersion: '0.3.0',
      fingerprint: 'sha256:afb6a70de939312d998a613a62647842dff85addcd265fdfd4bceadf42ec1688',
    },
  ] as const;

  for (const expected of cases) {
    const manifest = buildHarnessAbManifest({
      subjectFingerprint: 'subject',
      taskSourceFingerprint: 'tasks',
      toolchainFingerprint: 'tools',
      composition: resolveHarnessComposition(expected.composition),
      pierVersion: expected.pierVersion,
    });
    assert.equal(manifest.fingerprint, expected.fingerprint, expected.name);
  }
});

test('task-container placement is declared by every arm, or by none', async () => {
  // The report throws on a manifest where only some arms declare placement, so
  // this is not a documentation preference: leaving the competitors silent once
  // the Maka arm moved is what made four-arm-canary-v1 finish all four cells
  // and produce no report at all.
  const { buildHarnessAbManifest, resolveHarnessComposition } = await import(
    new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href
  );
  const args = {
    subjectFingerprint: 'subject',
    taskSourceFingerprint: 'tasks',
    toolchainFingerprint: 'tools',
    composition: resolveHarnessComposition({ competitor: 'codex' }),
  };
  const placements = (manifest: { arms: { metadata?: { config?: { execution?: unknown } } }[] }) =>
    manifest.arms.map(
      (arm) => (arm.metadata?.config?.execution as { placement?: string } | undefined)?.placement,
    );

  assert.deepEqual(
    placements(
      buildHarnessAbManifest({
        ...args,
        env: { MAKA_HARNESS_AB_MAKA_PLACEMENT: 'task-container' },
      }),
    ),
    ['task-container', 'task-container'],
  );
  assert.deepEqual(placements(buildHarnessAbManifest({ ...args, env: {} })), [
    undefined,
    undefined,
  ]);
});

test('redirecting apt is recorded, and leaves runs that do not redirect untouched', async () => {
  const {
    aptMirrorComposeContent,
    buildHarnessAbManifest,
    resolveHarnessComposition,
    UBUNTU_APT_HOSTS,
  } = await import(new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href);
  const composition = resolveHarnessComposition({ competitor: 'reasonix' });
  const args = {
    subjectFingerprint: 'subject',
    taskSourceFingerprint: 'tasks',
    toolchainFingerprint: 'tools',
    composition,
    env: { MAKA_HARNESS_AB_APT_MIRROR: 'mirrors.example.com' },
  };

  const plain = buildHarnessAbManifest({ ...args, env: {} });
  const redirected = buildHarnessAbManifest({ ...args, aptMirrorAddress: '10.0.0.7' });

  assert.equal(plain.metadata.benchmark.packageMirror, undefined);
  assert.deepEqual(redirected.metadata.benchmark.packageMirror, {
    hosts: UBUNTU_APT_HOSTS,
    name: 'mirrors.example.com',
    address: '10.0.0.7',
  });
  // Where packages came from is part of what a run was, so the two must not be
  // resumable as each other. Recording it without forking the fingerprint would
  // let a redirected run continue a manifest that fetched from Ubuntu's hosts.
  assert.notEqual(plain.fingerprint, redirected.fingerprint);

  // Both hosts the base image's sources list names have to move together: apt
  // reads noble-security from security.ubuntu.com, and leaving it behind puts
  // every security-pocket fetch back on the link the redirect exists to avoid.
  const overlay = aptMirrorComposeContent('10.0.0.7');
  for (const host of UBUNTU_APT_HOSTS)
    assert.match(overlay, new RegExp(`'${host}:10\\.0\\.0\\.7'`));
  assert.match(overlay, /^services:\n {2}main:\n {4}extra_hosts:\n/);
  assert.throws(() => aptMirrorComposeContent(''), /apt mirror address is required/);
});

test('only the executor that applies the mirror is allowed to name one', async () => {
  const { harnessAptMirror, resolveHarnessComposition } = await import(
    new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href
  );
  const harbor = resolveHarnessComposition({ competitor: 'reasonix' }).benchmarkProfile;
  const pier = resolveHarnessComposition({
    benchmark: 'deep-swe-1.1',
    competitor: 'kimi-code',
  }).benchmarkProfile;
  const env = { MAKA_HARNESS_AB_APT_MIRROR: 'mirrors.example.com' };

  assert.equal(harnessAptMirror(harbor, env), 'mirrors.example.com');
  // Only the harbor runner receives the compose overlay, so a pier run that
  // accepted the name would publish a redirect its cells never performed and
  // fork its resume identity on that false record. A shared shell env carrying
  // the variable across both benchmarks is the way this actually happens, which
  // is why it has to fail at launch rather than be dropped quietly.
  assert.throws(
    () => harnessAptMirror(pier, env),
    /the pier executor does not redirect package hosts/,
  );
  assert.equal(harnessAptMirror(pier, {}), null);
});

test('Reasonix comparison freezes the DeepSeek runtime, toolchain, and run identity', async () => {
  const {
    buildHarnessAbManifest,
    buildHarnessExecutionProfile,
    resolveHarnessAbRunId,
    resolveHarnessComposition,
    resolveHarnessCompetitorToolchain,
    resolveHarnessCompetitorToolchainPath,
  } = await import(new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href);
  const composition = resolveHarnessComposition({ competitor: 'reasonix' });
  const { competitorProfile, runtimeProfile } = composition;
  // The competitor axis alone selects the DeepSeek runtime; both arms then
  // share one model, effort, pricing source, and execution policy.
  assert.equal(runtimeProfile.id, 'deepseek-v4-flash-max');
  const manifest = buildHarnessAbManifest({
    subjectFingerprint: 'subject',
    taskSourceFingerprint: 'tasks',
    toolchainFingerprint: 'tools',
    composition,
  });
  assert.deepEqual(manifest.metadata.model, {
    provider: 'deepseek',
    id: 'deepseek-v4-flash',
    reasoningEffort: 'max',
  });
  assert.equal(manifest.arms[0].id, 'maka');
  assert.equal(manifest.arms[1].id, 'reasonix');
  assert.equal(manifest.arms[1].metadata.config.adapter, 'reasonix_agent:MakaReasonixAgent');
  assert.equal(manifest.arms[1].metadata.config.billingMode, 'metered');
  assert.equal(manifest.metadata.pricing.source, runtimeProfile.pricing.source);
  assert.equal(
    resolveHarnessAbRunId(composition),
    'deepseek-v4-flash-maka-vs-reasonix-tbench-2.1-full-v1',
  );
  assert.match(
    resolveHarnessCompetitorToolchainPath('/run', competitorProfile),
    new RegExp(
      `reasonix-1\\.19\\.4-${competitorProfile.toolchainFingerprint.slice(7, 19)}-linux-x64$`,
    ),
  );
  const toolchain = resolveHarnessCompetitorToolchain('/run', competitorProfile, {
    MAKA_HARNESS_AB_REASONIX_TOOLCHAIN: '/prepared/reasonix',
  });
  assert.equal(toolchain.path, '/prepared/reasonix');
  assert.equal(toolchain.prepare.name, 'prepareReasonixToolchain');
  assert.equal(competitorProfile.runnerToolchainOption, 'reasonixToolchainPath');
  assert.equal(
    buildHarnessExecutionProfile(runtimeProfile).modelSpec,
    'deepseek/deepseek-v4-flash',
  );
});

test('Codex comparison freezes the OpenAI model, pricing, and run identity', async () => {
  const {
    buildHarnessAbManifest,
    buildHarnessExecutionProfile,
    resolveHarnessAbRunId,
    resolveHarnessComposition,
    resolveHarnessCompetitorToolchain,
  } = await import(new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href);
  const composition = resolveHarnessComposition({ competitor: 'codex' });
  const { competitorProfile, runtimeProfile } = composition;
  const credentialIdentity = {
    connectionSlug: 'codex-subscription',
    accountIdHash: `sha256:${'a'.repeat(64)}`,
  };
  const manifest = buildHarnessAbManifest({
    subjectFingerprint: 'subject',
    taskSourceFingerprint: 'tasks',
    toolchainFingerprint: 'tools',
    composition,
    credentialIdentity,
  });
  const otherAccountManifest = buildHarnessAbManifest({
    subjectFingerprint: 'subject',
    taskSourceFingerprint: 'tasks',
    toolchainFingerprint: 'tools',
    composition,
    credentialIdentity: {
      ...credentialIdentity,
      accountIdHash: `sha256:${'b'.repeat(64)}`,
    },
  });
  assert.notEqual(manifest.fingerprint, otherAccountManifest.fingerprint);

  assert.deepEqual(manifest.metadata.model, {
    provider: 'openai-codex',
    id: 'gpt-5.6-sol',
    reasoningEffort: 'xhigh',
    credentialIdentity,
  });
  assert.deepEqual(manifest.metadata.pricing, runtimeProfile.pricing);
  assert.equal(manifest.arms[1].id, 'codex');
  assert.equal(manifest.arms[1].metadata.config.billingMode, 'account-plan');
  assert.equal(
    resolveHarnessAbRunId(composition),
    'gpt-5.6-sol-maka-vs-codex-oauth-tbench-2.1-full-v1',
  );
  const toolchain = resolveHarnessCompetitorToolchain('/run', competitorProfile, {
    MAKA_HARNESS_AB_CODEX_TOOLCHAIN: '/prepared/codex',
  });
  assert.equal(toolchain.path, '/prepared/codex');
  assert.equal(toolchain.prepare.name, 'prepareCodexToolchain');
  assert.deepEqual(buildHarnessExecutionProfile(runtimeProfile), {
    modelSpec: 'openai-codex/gpt-5.6-sol',
    provider: 'openai-codex',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'xhigh',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    billingMode: 'account-plan',
    pricing: {
      inputUsdPer1M: 0,
      cacheReadUsdPer1M: 0,
      outputUsdPer1M: 0,
      source: 'openai-codex-chatgpt-account-plan',
    },
  });
});

test('harness execution profile rejects a reasoning effort unsupported by model metadata', async () => {
  const { buildHarnessExecutionProfile, resolveHarnessComposition } = await import(
    new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href
  );
  const composition = resolveHarnessComposition({ competitor: 'codex' });
  const invalidRuntimeProfile = {
    ...composition.runtimeProfile,
    reasoningEffort: 'minimal',
  };

  assert.throws(
    () => buildHarnessExecutionProfile(invalidRuntimeProfile),
    /does not support reasoning effort minimal/,
  );
});

test('DeepSWE resolves a dedicated pinned Maka Node toolchain', async () => {
  const { resolveHarnessMakaNodeToolchain } = await import(
    new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href
  );
  const { MAKA_NODE_TOOLCHAIN_FINGERPRINT } = await import('../maka-node-toolchain.js');

  const defaultToolchain = resolveHarnessMakaNodeToolchain('/run', {});
  assert.match(
    defaultToolchain.path,
    new RegExp(`maka-node-${MAKA_NODE_TOOLCHAIN_FINGERPRINT.slice(7, 19)}-linux-x64$`),
  );
  assert.equal(defaultToolchain.prepare.name, 'prepareMakaNodeToolchain');

  const overridden = resolveHarnessMakaNodeToolchain('/run', {
    MAKA_HARNESS_AB_MAKA_NODE_TOOLCHAIN: '/prepared/maka-node',
  });
  assert.equal(overridden.path, '/prepared/maka-node');
});

test('Codex comparison resolves both arms from one OAuth account workflow', async () => {
  const { resolveHarnessComposition, resolveHarnessRuntimeCredentials } = await import(
    new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href
  );
  const calls: unknown[] = [];
  const resolveProviderCredential = async () => ({ value: 'current-oauth-token' });
  const credentialIdentity = {
    connectionSlug: 'codex-subscription',
    accountIdHash: `sha256:${'a'.repeat(64)}`,
  };
  const result = await resolveHarnessRuntimeCredentials({
    composition: resolveHarnessComposition({ competitor: 'codex' }),
    env: {
      MAKA_HARNESS_AB_WORKSPACE_ROOT: '/workspace',
      MAKA_HARNESS_AB_OAUTH_CONNECTION_SLUG: 'codex-subscription',
    },
    createCodexOAuthCredentialBinding: async (input: unknown) => {
      calls.push(input);
      return { credentialIdentity, resolveProviderCredential };
    },
  });

  assert.equal(result.resolveProviderCredential, resolveProviderCredential);
  assert.deepEqual(result.credentialIdentity, credentialIdentity);
  assert.deepEqual(calls, [
    {
      credentialsRoot: '/workspace',
      connectionSlug: 'codex-subscription',
    },
  ]);
});

test('plan runtimes resolve only their own key-file environment', async () => {
  const { resolveHarnessComposition, resolveHarnessRuntimeCredentials } = await import(
    new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href
  );
  const glmComposition = resolveHarnessComposition({
    runtime: 'zai-coding-plan-glm-5.2-max',
    competitor: 'opencode',
  });
  const kimiComposition = resolveHarnessComposition({ competitor: 'opencode' });

  await assert.rejects(
    resolveHarnessRuntimeCredentials({
      composition: glmComposition,
      env: { MAKA_HARNESS_AB_KEY_FILE: '/secrets/kimi.key' },
    }),
    /MAKA_HARNESS_AB_ZAI_KEY_FILE is required/,
  );
  assert.deepEqual(
    await resolveHarnessRuntimeCredentials({
      composition: glmComposition,
      env: {
        MAKA_HARNESS_AB_KEY_FILE: '/secrets/kimi.key',
        MAKA_HARNESS_AB_ZAI_KEY_FILE: '/secrets/zai.key',
      },
    }),
    { apiKeyFile: '/secrets/zai.key' },
  );
  assert.deepEqual(
    await resolveHarnessRuntimeCredentials({
      composition: kimiComposition,
      env: {
        MAKA_HARNESS_AB_KEY_FILE: '/secrets/kimi.key',
        MAKA_HARNESS_AB_ZAI_KEY_FILE: '/secrets/zai.key',
      },
    }),
    { apiKeyFile: '/secrets/kimi.key' },
  );
  assert.deepEqual(
    await resolveHarnessRuntimeCredentials({
      composition: kimiComposition,
      env: { MAKA_HARNESS_AB_ZAI_KEY_FILE: '/secrets/zai.key' },
    }),
    { apiKeyFile: join(homedir(), '.maka/secrets/kimi-coding-plan.key') },
  );
});

test('detached named-task launcher requires a run id before creating artifacts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-detached-identity-'));
  try {
    const outDir = join(dir, 'out');
    const scriptPath = new URL('../../harbor/run-harness-ab-detached.mjs', import.meta.url);
    await assert.rejects(
      execFileAsync(process.execPath, [scriptPath.pathname], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAKA_HARNESS_AB_OUT_DIR: outDir,
          MAKA_HARNESS_AB_RUN_ID: '',
          MAKA_HARNESS_AB_TASK_ID: 'extract-moves-from-video',
          MAKA_HARNESS_AB_TASKS_ROOT: join(dir, 'missing-tasks'),
          MAKA_HARNESS_AB_DRY_RUN: '1',
        },
      }),
      /MAKA_HARNESS_AB_RUN_ID is required with MAKA_HARNESS_AB_TASK_ID/,
    );
    await assert.rejects(
      readFile(join(outDir, 'k3-maka-vs-kimi-code-tbench-2.1-full-v2', 'background-run.log')),
      { code: 'ENOENT' },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detached harness launcher persists a terminal failed journal after the worker exits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-detached-'));
  try {
    const outDir = join(dir, 'out');
    const runId = 'detached-smoke';
    const scriptPath = new URL('../../harbor/run-harness-ab-detached.mjs', import.meta.url);
    await execFileAsync(process.execPath, [scriptPath.pathname], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MAKA_HARNESS_AB_OUT_DIR: outDir,
        MAKA_HARNESS_AB_RUN_ID: runId,
        MAKA_HARNESS_AB_TASKS_ROOT: join(dir, 'missing-tasks'),
        MAKA_HARNESS_AB_LIMIT: '5',
        MAKA_HARNESS_AB_DRY_RUN: '1',
      },
    });

    const journalPath = join(outDir, runId, 'background-run.json');
    const journal = await waitForJournal(journalPath, (value) => value.status === 'failed');
    assert.equal(journal.exitCode, 1);
    assert.equal(typeof journal.pid, 'number');
    assert.equal(typeof journal.startedAt, 'string');
    assert.equal(typeof journal.finishedAt, 'string');
    await waitForFileMatch(
      join(outDir, runId, 'background-run.log'),
      /Terminal-Bench 2\.1 task set mismatch/,
    );
    assert.match(
      await readFile(join(outDir, runId, 'background-run.log'), 'utf8'),
      /Terminal-Bench 2\.1 task set mismatch/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detached OpenCode launcher and worker share the competitor default run id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-detached-opencode-'));
  try {
    const outDir = join(dir, 'out');
    const runId = 'k3-maka-vs-opencode-tbench-2.1-full-v1';
    const scriptPath = new URL('../../harbor/run-harness-ab-detached.mjs', import.meta.url);
    await execFileAsync(process.execPath, [scriptPath.pathname], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MAKA_HARNESS_AB_OUT_DIR: outDir,
        MAKA_HARNESS_AB_COMPETITOR: 'opencode',
        MAKA_HARNESS_AB_TASKS_ROOT: join(dir, 'missing-tasks'),
        MAKA_HARNESS_AB_LIMIT: '5',
        MAKA_HARNESS_AB_DRY_RUN: '1',
      },
    });

    const journal = await waitForJournal(
      join(outDir, runId, 'background-run.json'),
      (value) => value.status === 'failed',
    );
    assert.equal(journal.exitCode, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detached GLM OpenCode launcher and worker share the resolved composition run id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-detached-glm-opencode-'));
  try {
    const outDir = join(dir, 'out');
    const runId = 'glm-5.2-maka-vs-opencode-tbench-2.1-full-v1';
    const scriptPath = new URL('../../harbor/run-harness-ab-detached.mjs', import.meta.url);
    await execFileAsync(process.execPath, [scriptPath.pathname], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MAKA_HARNESS_AB_OUT_DIR: outDir,
        MAKA_HARNESS_AB_RUNTIME: 'zai-coding-plan-glm-5.2-max',
        MAKA_HARNESS_AB_COMPETITOR: 'opencode',
        MAKA_HARNESS_AB_TASKS_ROOT: join(dir, 'missing-tasks'),
        MAKA_HARNESS_AB_LIMIT: '5',
        MAKA_HARNESS_AB_DRY_RUN: '1',
      },
    });

    const journal = await waitForJournal(
      join(outDir, runId, 'background-run.json'),
      (value) => value.status === 'failed',
    );
    assert.equal(journal.exitCode, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('duplicate detached launch does not overwrite the active run journal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-detached-'));
  try {
    const outDir = join(dir, 'out');
    const runId = 'detached-active';
    const runRoot = join(outDir, runId);
    const lockDir = join(runRoot, '.ab-run.lock');
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, 'owner.json'),
      `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`,
      'utf8',
    );
    const journal = {
      schemaVersion: 1,
      pid: process.pid,
      startedAt: '2026-07-14T00:00:00.000Z',
      logPath: join(runRoot, 'background-run.log'),
      status: 'running',
    };
    await writeFile(
      join(runRoot, 'background-run.json'),
      `${JSON.stringify(journal, null, 2)}\n`,
      'utf8',
    );

    const scriptPath = new URL('../../harbor/run-harness-ab-detached.mjs', import.meta.url);
    await assert.rejects(
      execFileAsync(process.execPath, [scriptPath.pathname], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAKA_HARNESS_AB_OUT_DIR: outDir,
          MAKA_HARNESS_AB_RUN_ID: runId,
          MAKA_HARNESS_AB_TASKS_ROOT: join(dir, 'missing-tasks'),
          MAKA_HARNESS_AB_LIMIT: '5',
          MAKA_HARNESS_AB_DRY_RUN: '1',
        },
      }),
      /before acquiring the run lock/,
    );

    await waitForFileMatch(
      join(runRoot, 'background-run.log'),
      /Terminal-Bench 2\.1 task set mismatch|A\/B run is already active/,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(runRoot, 'background-run.json'), 'utf8')),
      journal,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('harness A/B CLI rejects the superseded 30-task pilot checkpoint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-cli-'));
  try {
    const scriptPath = new URL('../../harbor/run-harness-ab.mjs', import.meta.url);
    await assert.rejects(
      execFileAsync(process.execPath, [scriptPath.pathname], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAKA_HARNESS_AB_OUT_DIR: join(dir, 'out'),
          MAKA_HARNESS_AB_TASKS_ROOT: join(dir, 'missing-tasks'),
          MAKA_HARNESS_AB_LIMIT: '30',
          MAKA_HARNESS_AB_DRY_RUN: '1',
        },
      }),
      /MAKA_HARNESS_AB_LIMIT must be 5 or 89/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('harness A/B CLI accepts the complete 89-task profile limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-cli-'));
  try {
    const scriptPath = new URL('../../harbor/run-harness-ab.mjs', import.meta.url);
    await assert.rejects(
      execFileAsync(process.execPath, [scriptPath.pathname], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAKA_HARNESS_AB_OUT_DIR: join(dir, 'out'),
          MAKA_HARNESS_AB_TASKS_ROOT: join(dir, 'missing-tasks'),
          MAKA_HARNESS_AB_LIMIT: '89',
          MAKA_HARNESS_AB_DRY_RUN: '1',
        },
      }),
      /Terminal-Bench 2\.1 task set mismatch/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('harness A/B CLI rejects modified task contents before reading credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-cli-'));
  try {
    const tasksRoot = join(dir, 'tasks');
    for (const id of BENCHMARK_IDENTITY.terminalBench21.taskIds) {
      const taskDir = join(tasksRoot, `hash-${id}`, id);
      await mkdir(taskDir, { recursive: true });
      await writeFile(join(taskDir, 'task.toml'), '[agent]\ntimeout_sec = 900\n', 'utf8');
    }
    const outDir = join(dir, 'out');
    const scriptPath = new URL('../../harbor/run-harness-ab.mjs', import.meta.url);
    await assert.rejects(
      execFileAsync(process.execPath, [scriptPath.pathname], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAKA_HARNESS_AB_OUT_DIR: outDir,
          MAKA_HARNESS_AB_TASKS_ROOT: tasksRoot,
          MAKA_HARNESS_AB_RUN_ID: 'dry-run',
          MAKA_HARNESS_AB_LIMIT: '5',
          MAKA_HARNESS_AB_DRY_RUN: '1',
          MAKA_HARNESS_AB_KEY_FILE: join(dir, 'must-not-be-read'),
          MAKA_HARNESS_AB_EXPLICIT_SUBJECT_FINGERPRINT: `sha256:${'a'.repeat(64)}`,
          MAKA_HARNESS_AB_TOOLCHAIN_FINGERPRINT: `sha256:${'b'.repeat(64)}`,
        },
      }),
      /Terminal-Bench 2\.1 task tree fingerprint mismatch/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('harness A/B forwards an explicit host-proxy advertised host for native-Linux Pier runs', async () => {
  const { resolveHarnessProviderProxyHubOptions } = await import(
    new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href
  );
  // Native Linux Docker injects no host.docker.internal; the VM operator
  // names the docker-bridge-reachable host address explicitly.
  assert.deepEqual(resolveHarnessProviderProxyHubOptions('172.17.0.1'), {
    providerProxyAdvertisedHost: '172.17.0.1',
  });
  // Unset or blank keeps the hub default (host.docker.internal).
  assert.deepEqual(resolveHarnessProviderProxyHubOptions(undefined), {});
  assert.deepEqual(resolveHarnessProviderProxyHubOptions('   '), {});
});

test('harness A/B supports the DeepSeek-metered OpenCode composition on full DeepSWE', async () => {
  const { resolveHarnessAbRunId, resolveHarnessComposition } = await import(
    new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href
  );
  const composition = resolveHarnessComposition({
    benchmark: 'deep-swe-1.1-full',
    runtime: 'deepseek-v4-flash-max',
    competitor: 'opencode',
  });
  assert.equal(composition.benchmarkProfile.executor, 'pier');
  assert.equal(composition.runtimeProfile.model, 'deepseek-v4-flash');
  assert.equal(composition.runtimeProfile.billingMode, 'metered');
  assert.equal(composition.competitorProfile.id, 'opencode');
  assert.equal(
    resolveHarnessAbRunId(composition),
    'deepseek-v4-flash-maka-vs-opencode-deepswe-full-v1',
  );
});

test('harness A/B resolves the full DeepSWE benchmark as a sibling profile', async () => {
  const {
    resolveHarnessAbRunId,
    resolveHarnessAbTaskSelection,
    resolveHarnessBenchmarkProfile,
    resolveHarnessComposition,
  } = await import(new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href);
  const benchmarkProfile = resolveHarnessBenchmarkProfile('deep-swe-1.1-full');

  // Same frozen task source and Pier executor as the subset profile; the
  // frozen task list is the whole 113-task leaderboard set, not the 30-task
  // discriminative subset.
  assert.equal(benchmarkProfile.executor, 'pier');
  assert.equal(benchmarkProfile.dataset, 'deep-swe');
  assert.equal(benchmarkProfile.version, '1.1');
  assert.equal(benchmarkProfile.taskIds.length, 113);

  const selection = resolveHarnessAbTaskSelection(undefined, '113', undefined, benchmarkProfile);
  assert.equal(selection.taskIds.length, 113);
  assert.throws(
    () => resolveHarnessAbTaskSelection(undefined, '30', undefined, benchmarkProfile),
    /MAKA_HARNESS_AB_LIMIT must be 5 or 113/,
  );
  assert.throws(
    () =>
      resolveHarnessAbTaskSelection(
        'extract-moves-from-video',
        undefined,
        undefined,
        benchmarkProfile,
      ),
    /MAKA_HARNESS_AB_TASK_ID must name a DeepSWE full-113 task/,
  );

  assert.equal(
    resolveHarnessAbRunId(resolveHarnessComposition({ benchmark: benchmarkProfile.id })),
    'k3-maka-vs-kimi-code-deepswe-full-v1',
  );
  assert.equal(
    resolveHarnessAbRunId(
      resolveHarnessComposition({ benchmark: benchmarkProfile.id, competitor: 'codex' }),
    ),
    'gpt-5.6-sol-maka-vs-codex-oauth-deepswe-full-v1',
  );
  assert.throws(
    () => resolveHarnessComposition({ benchmark: benchmarkProfile.id, competitor: 'opencode' }),
    /unsupported harness composition: benchmark=deep-swe-1\.1-full/,
  );

  // The full profile freezes its own manifest identity: distinct order seed,
  // auditable Pier executor metadata, the 113-task evaluation set, and a
  // manifest fingerprint that cannot collide with the subset profile's.
  const { buildHarnessAbManifest } = await import(
    new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href
  );
  const fullManifest = buildHarnessAbManifest({
    subjectFingerprint: 'subject',
    taskSourceFingerprint: 'tasks',
    toolchainFingerprint: 'tools',
    composition: resolveHarnessComposition({ benchmark: benchmarkProfile.id, competitor: 'codex' }),
    pierVersion: '0.3.0',
  });
  assert.equal(
    fullManifest.metadata.order.seed,
    'deep-swe-1.1-full:gpt-5.6-sol:harness-comparison:v1',
  );
  assert.deepEqual(fullManifest.metadata.benchmark.executor, { id: 'pier', version: '0.3.0' });
  assert.equal(fullManifest.evaluationTaskIds.length, 113);
  const subsetManifest = buildHarnessAbManifest({
    subjectFingerprint: 'subject',
    taskSourceFingerprint: 'tasks',
    toolchainFingerprint: 'tools',
    composition: resolveHarnessComposition({ benchmark: 'deep-swe-1.1', competitor: 'codex' }),
    pierVersion: '0.3.0',
  });
  assert.notEqual(fullManifest.fingerprint, subsetManifest.fingerprint);
});

test('harness A/B frozen task resolution dispatches full vs subset DeepSWE profiles', async () => {
  const { resolveFrozenBenchmarkTasks, resolveHarnessBenchmarkProfile } = await import(
    new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href
  );
  const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-deepswe-dispatch-'));
  try {
    const tasksRoot = join(dir, 'tasks');
    await mkdir(join(tasksRoot, 'fixture-task'), { recursive: true });
    await writeFile(join(tasksRoot, 'fixture-task', 'task.toml'), '[agent]\ntimeout_sec = 900\n');

    // The full profile asserts the whole tree against the 113-task leaderboard
    // set — a partial tree is a set mismatch, not a subset pick.
    await assert.rejects(
      resolveFrozenBenchmarkTasks(resolveHarnessBenchmarkProfile('deep-swe-1.1-full'), tasksRoot),
      /DeepSWE full-113 task set mismatch/,
    );
    // The subset profile keeps picking its 30 ids out of the same tree and
    // fails loudly when none of them are present.
    await assert.rejects(
      resolveFrozenBenchmarkTasks(resolveHarnessBenchmarkProfile('deep-swe-1.1'), tasksRoot),
      /DeepSWE subset-30 contains unknown task id/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('harness A/B resolves the DeepSWE benchmark axis orthogonally to competitors', async () => {
  const {
    buildHarnessAbManifest,
    resolveHarnessAbRunId,
    resolveHarnessAbTaskSelection,
    resolveHarnessBenchmarkProfile,
    resolveHarnessComposition,
  } = await import(new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href);
  const { MAKA_NODE_TOOLCHAIN_FINGERPRINT } = await import('../maka-node-toolchain.js');
  const benchmarkProfile = resolveHarnessBenchmarkProfile('deep-swe-1.1');

  assert.throws(
    () => resolveHarnessBenchmarkProfile('swe-bench'),
    /MAKA_HARNESS_AB_BENCHMARK must be one of: terminal-bench-2\.1, deep-swe-1\.1/,
  );

  // Task identity comes from the benchmark: a Terminal-Bench task id is
  // unknown here, and the 30-task subset replaces the 89-task full set.
  const selection = resolveHarnessAbTaskSelection(undefined, '30', undefined, benchmarkProfile);
  assert.equal(selection.taskIds.length, 30);
  assert.throws(
    () =>
      resolveHarnessAbTaskSelection(
        'extract-moves-from-video',
        undefined,
        undefined,
        benchmarkProfile,
      ),
    /MAKA_HARNESS_AB_TASK_ID must name a DeepSWE subset-30 task/,
  );
  assert.throws(
    () => resolveHarnessAbTaskSelection(undefined, '89', undefined, benchmarkProfile),
    /MAKA_HARNESS_AB_LIMIT must be 5 or 30/,
  );

  // The derived run id carries model, competitor, credential mode, benchmark.
  assert.equal(
    resolveHarnessAbRunId(resolveHarnessComposition({ benchmark: benchmarkProfile.id })),
    'k3-maka-vs-kimi-code-deepswe-subset30-v1',
  );
  assert.equal(
    resolveHarnessAbRunId(
      resolveHarnessComposition({ benchmark: benchmarkProfile.id, competitor: 'codex' }),
    ),
    'gpt-5.6-sol-maka-vs-codex-oauth-deepswe-subset30-v1',
  );

  const manifest = buildHarnessAbManifest({
    subjectFingerprint: 'subject',
    taskSourceFingerprint: 'tasks',
    toolchainFingerprint: 'tools',
    composition: resolveHarnessComposition({
      benchmark: benchmarkProfile.id,
      competitor: 'codex',
    }),
  });
  assert.deepEqual(manifest.metadata.benchmark.dataset, 'deep-swe');
  assert.equal(manifest.metadata.benchmark.version, '1.1');
  assert.equal(manifest.metadata.benchmark.agentSettlementGraceSec, 30);
  assert.equal(manifest.metadata.order.seed, 'deep-swe-1.1:gpt-5.6-sol:harness-comparison:v1');
  assert.equal(manifest.evaluationTaskIds.length, 30);
  assert.deepEqual(manifest.arms[0].metadata.config.execution, {
    placement: 'task-container',
    isolation: 'harbor-local',
    nodeToolchainFingerprint: MAKA_NODE_TOOLCHAIN_FINGERPRINT,
  });
  assert.deepEqual(manifest.arms[1].metadata.config.execution, {
    placement: 'task-container',
  });

  // The Pier executor identity is auditable in the manifest, not only hashed
  // into the toolchain fingerprint.
  const pierManifest = buildHarnessAbManifest({
    subjectFingerprint: 'subject',
    taskSourceFingerprint: 'tasks',
    toolchainFingerprint: 'tools',
    composition: resolveHarnessComposition({
      benchmark: benchmarkProfile.id,
      competitor: 'codex',
    }),
    pierVersion: '0.3.0',
  });
  assert.deepEqual(pierManifest.metadata.benchmark.executor, { id: 'pier', version: '0.3.0' });

  // The Terminal-Bench default keeps its historical order seed byte-for-byte.
  const tbenchManifest = buildHarnessAbManifest({
    subjectFingerprint: 'subject',
    taskSourceFingerprint: 'tasks',
    toolchainFingerprint: 'tools',
  });
  assert.equal(tbenchManifest.metadata.order.seed, 'terminal-bench-2.1:k3:harness-comparison:v1');
  assert.equal('execution' in tbenchManifest.arms[0].metadata.config, false);
  assert.equal('execution' in tbenchManifest.arms[1].metadata.config, false);
  // No executor key for Harbor benchmarks: the manifest payload (and with it
  // the resume fingerprint) must stay byte-identical to historical runs.
  assert.equal('executor' in tbenchManifest.metadata.benchmark, false);
  // The settlement grace is executor-independent: both runners give the Maka arm
  // the same window on top of the task-native model budget, so both manifests
  // must record it.
  assert.equal(tbenchManifest.metadata.benchmark.agentSettlementGraceSec, 30);
  // Anchor the declared window to what the runner actually hands out. Recording
  // the constant alone would stay green even if every arm got no window at all.
  const anchorBudgetSec = 1800;
  const anchorAgent = (
    buildHarborJobConfig(
      {
        runId: 'run-1',
        roundId: 'round-1',
        task: {
          id: 'task-1',
          path: '/tasks/task-1',
          metadata: { agentTimeoutSec: anchorBudgetSec },
        },
        config: {
          id: 'cfg',
          backend: 'ai-sdk',
          llmConnectionSlug: 'deepseek',
          model: 'deepseek-v4-flash',
        },
        systemPrompt: 'PROMPT\n',
      },
      { makaRepoPath: '/repo', jobsDir: '/jobs/x', jobName: 'trial', model: 'deepseek/v4' },
    ).agents as Array<{ env: Record<string, string>; override_timeout_sec?: number }>
  )[0]!;
  // override_timeout_sec, not max_timeout_sec: Harbor folds the latter in as
  // `min(base, max)`, so a tail published there resolves back to the task's own
  // declared timeout and the settlement window never exists.
  assert.equal(
    anchorAgent.override_timeout_sec! - Number(anchorAgent.env.MAKA_CELL_TIMEOUT_SEC),
    tbenchManifest.metadata.benchmark.agentSettlementGraceSec,
  );
  // Every arm is handed MAKA_SYSTEM_PROMPT but only the Maka cell applies it, so
  // the arm identity has to say so in a readable field rather than only inside a
  // hash. Asserting both arms keeps the asymmetry itself under test.
  for (const manifestUnderTest of [manifest, pierManifest, tbenchManifest]) {
    assert.equal(
      manifestUnderTest.arms[0].metadata.config.externalSystemPrompt,
      'default-headless',
    );
    for (const competitor of manifestUnderTest.arms.slice(1)) {
      assert.equal(competitor.metadata.config.externalSystemPrompt, 'none');
    }
  }
});

test('harness A/B benchmark profiles bind their executor and resolve from env', async () => {
  const { HARNESS_BENCHMARK_PROFILES, resolveHarnessBenchmarkProfile } = await import(
    new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href
  );

  // A benchmark is a bound task-source + executor pair; the executor field is
  // what selects the runner and what freezes the Pier version into resume
  // identity.
  assert.equal(HARNESS_BENCHMARK_PROFILES['terminal-bench-2.1'].executor, 'harbor');
  assert.equal(HARNESS_BENCHMARK_PROFILES['deep-swe-1.1'].executor, 'pier');

  // The no-argument default reads MAKA_HARNESS_AB_BENCHMARK, so every
  // defaulted call site agrees with the production entry points.
  const saved = process.env.MAKA_HARNESS_AB_BENCHMARK;
  try {
    delete process.env.MAKA_HARNESS_AB_BENCHMARK;
    assert.equal(resolveHarnessBenchmarkProfile().id, 'terminal-bench-2.1');
    process.env.MAKA_HARNESS_AB_BENCHMARK = 'deep-swe-1.1';
    assert.equal(resolveHarnessBenchmarkProfile().id, 'deep-swe-1.1');
  } finally {
    if (saved === undefined) delete process.env.MAKA_HARNESS_AB_BENCHMARK;
    else process.env.MAKA_HARNESS_AB_BENCHMARK = saved;
  }
});

test('harness A/B toolchain identity freezes the Pier version only for Pier benchmarks', async () => {
  const { buildHarnessAbToolchainFingerprint, resolveHarnessCompetitorProfile } = await import(
    new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href
  );
  const { createHash } = await import('node:crypto');
  const competitorProfile = resolveHarnessCompetitorProfile('kimi-code');

  // Harbor benchmarks (pierVersion null) must reproduce the historical
  // payload byte-for-byte, or every existing Terminal-Bench run loses resume.
  const legacy = `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        hostToolchainFingerprint: 'host',
        competitor: competitorProfile.id,
        competitorToolchainFingerprint: competitorProfile.toolchainFingerprint,
      }),
    )
    .digest('hex')}`;
  assert.equal(
    buildHarnessAbToolchainFingerprint({ hostToolchainFingerprint: 'host', competitorProfile }),
    legacy,
  );

  // A Pier executor version change forks the resume identity.
  const pier030 = buildHarnessAbToolchainFingerprint({
    hostToolchainFingerprint: 'host',
    competitorProfile,
    pierVersion: 'pier 0.3.0',
    makaNodeToolchainFingerprint: `sha256:${'a'.repeat(64)}`,
  });
  const pier040 = buildHarnessAbToolchainFingerprint({
    hostToolchainFingerprint: 'host',
    competitorProfile,
    pierVersion: 'pier 0.4.0',
    makaNodeToolchainFingerprint: `sha256:${'a'.repeat(64)}`,
  });
  const otherMakaNode = buildHarnessAbToolchainFingerprint({
    hostToolchainFingerprint: 'host',
    competitorProfile,
    pierVersion: 'pier 0.3.0',
    makaNodeToolchainFingerprint: `sha256:${'b'.repeat(64)}`,
  });
  assert.notEqual(pier030, legacy);
  assert.notEqual(pier030, pier040);
  assert.notEqual(pier030, otherMakaNode);
});

async function waitForJournal(
  path: string,
  predicate: (value: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      if (predicate(value)) return value;
    } catch {
      // The detached worker may not have created the journal yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for detached journal ${path}`);
}

async function waitForFileMatch(path: string, pattern: RegExp): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if (pattern.test(await readFile(path, 'utf8'))) return;
    } catch {
      // The detached worker may not have written its log yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${path} to match ${pattern}`);
}
