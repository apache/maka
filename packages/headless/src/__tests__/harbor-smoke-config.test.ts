import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildSmokeJobConfig,
  resolveSmokeRunTargets,
  type SmokeManifest,
} from '../harbor-smoke-config.js';
import { MAKA_SETTLEMENT_GRACE_SEC } from '../maka-settlement.js';

const repoRoot = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));

async function loadManifest(): Promise<SmokeManifest> {
  const path = resolve(repoRoot, 'packages/headless/harbor/terminal-bench-smoke-profiles.json');
  return JSON.parse(await readFile(path, 'utf8')) as SmokeManifest;
}

const fixedNow = () => new Date('2026-07-16T12:34:56.000Z');

describe('harbor smoke config generation', () => {
  test('unknown profile throws with available names', async () => {
    const manifest = await loadManifest();
    assert.throws(
      () => buildSmokeJobConfig({ manifest, profileName: 'does-not-exist' }),
      /unknown profile "does-not-exist"\. Available profiles: .*maka-basic/,
    );
  });

  test('maka profiles drive maka_agent:MakaAgent in task-run mode and tag the dataset', async () => {
    const manifest = await loadManifest();
    for (const profileName of [
      'maka-basic',
      'maka-heavy',
      'maka-heavy-prune',
      'maka-prune-default',
      'maka-stale-off',
      'maka-retrieval-on',
    ]) {
      const { config } = buildSmokeJobConfig({
        manifest,
        profileName,
        overrides: { jobName: `job-${profileName}` },
      });
      const agent = (config.agents as Array<Record<string, unknown>>)[0]!;
      const env = agent.env as Record<string, string>;
      assert.equal(agent.import_path, 'maka_agent:MakaAgent', profileName);
      assert.equal(env.MAKA_HARBOR_MODE, 'task-run', profileName);
      assert.equal(env.MAKA_BENCHMARK_DATASET, 'terminal-bench-sample', profileName);
      const datasets = config.datasets as Array<Record<string, unknown>>;
      assert.equal(datasets[0]!.name, 'terminal-bench-sample', profileName);
    }
  });

  test('heavy profile preserves heavy-task env verbatim', async () => {
    const manifest = await loadManifest();
    const { config } = buildSmokeJobConfig({
      manifest,
      profileName: 'maka-heavy',
      overrides: { jobName: 'job' },
    });
    const env = (config.agents as Array<Record<string, unknown>>)[0]!.env as Record<string, string>;
    assert.equal(env.MAKA_HEAVY_TASK_MODE, '1');
    assert.equal(env.MAKA_HARBOR_USE_TASK_RUN, '1');
    assert.equal(env.MAKA_MAX_STEPS, '100');
    assert.equal(env.MAKA_CELL_TIMEOUT_SEC, '7200');
    assert.equal(env.MAKA_HARBOR_AGENT_TIMEOUT_SEC, undefined);
    assert.equal(config.agent_timeout_multiplier, 8);
  });

  test('the smoke agent phase outlasts the cell budget by the settlement window', async () => {
    // The maka profiles tune agent_timeout_multiplier so the task-native budget
    // times the multiplier equals the cell budget. Leaving max_timeout_sec null
    // therefore makes Harbor kill the cell at the exact moment it stops calling
    // the model and starts writing, turning a scored result into an infra failure.
    const manifest = await loadManifest();
    for (const profileName of ['maka-basic', 'maka-heavy']) {
      const { config } = buildSmokeJobConfig({
        manifest,
        profileName,
        overrides: { jobName: 'job' },
      });
      const agent = (config.agents as Array<Record<string, unknown>>)[0]!;
      const env = agent.env as Record<string, string>;
      assert.equal(
        agent.max_timeout_sec,
        Number(env.MAKA_CELL_TIMEOUT_SEC) + MAKA_SETTLEMENT_GRACE_SEC,
        profileName,
      );
    }
  });

  test('a non-maka smoke profile gets no settlement window', async () => {
    const manifest = await loadManifest();
    const { config } = buildSmokeJobConfig({
      manifest,
      profileName: 'oracle',
      overrides: { jobName: 'job' },
    });
    const agent = (config.agents as Array<Record<string, unknown>>)[0]!;
    assert.equal(agent.max_timeout_sec, null);
  });

  test('--model override targets MAKA_MODEL for maka and model_name for non-maka', async () => {
    const manifest = await loadManifest();
    const maka = buildSmokeJobConfig({
      manifest,
      profileName: 'maka-basic',
      overrides: { jobName: 'j', model: 'deepseek/deepseek-vX' },
    });
    const makaAgent = (maka.config.agents as Array<Record<string, unknown>>)[0]!;
    assert.equal((makaAgent.env as Record<string, string>).MAKA_MODEL, 'deepseek/deepseek-vX');
    assert.equal(makaAgent.model_name, null);

    const opencode = buildSmokeJobConfig({
      manifest,
      profileName: 'opencode',
      overrides: { jobName: 'j', model: 'deepseek/other' },
    });
    const ocAgent = (opencode.config.agents as Array<Record<string, unknown>>)[0]!;
    assert.equal(ocAgent.model_name, 'deepseek/other');
    assert.equal(ocAgent.import_path, 'opencode_title_harbor_agent:OpenCodeTitleAgent');
    assert.deepEqual(ocAgent.env, {});
  });

  test('n-tasks replaces task_names with a task count', async () => {
    const manifest = await loadManifest();
    const withPattern = buildSmokeJobConfig({
      manifest,
      profileName: 'oracle',
      overrides: { jobName: 'j', taskPattern: '*foo' },
    });
    const withCount = buildSmokeJobConfig({
      manifest,
      profileName: 'oracle',
      overrides: { jobName: 'j', nTasks: 3 },
    });
    const dsPattern = (withPattern.config.datasets as Array<Record<string, unknown>>)[0]!;
    const dsCount = (withCount.config.datasets as Array<Record<string, unknown>>)[0]!;
    assert.deepEqual(dsPattern.task_names, ['*foo']);
    assert.equal(dsPattern.n_tasks, null);
    assert.equal(dsCount.task_names, null);
    assert.equal(dsCount.n_tasks, 3);
  });

  test('rejects non-positive n-tasks', async () => {
    const manifest = await loadManifest();
    assert.throws(
      () =>
        buildSmokeJobConfig({
          manifest,
          profileName: 'oracle',
          overrides: { jobName: 'j', nTasks: 0 },
        }),
      /--n-tasks must be a positive integer/,
    );
  });

  test('dataset name/version overrides flow into the dataset and MAKA_BENCHMARK_DATASET', async () => {
    const manifest = await loadManifest();
    const { config } = buildSmokeJobConfig({
      manifest,
      profileName: 'maka-basic',
      overrides: { jobName: 'j', datasetName: 'terminal-bench', datasetVersion: '3.1' },
    });
    const ds = (config.datasets as Array<Record<string, unknown>>)[0]!;
    assert.equal(ds.name, 'terminal-bench');
    assert.equal(ds.version, '3.1');
    const env = (config.agents as Array<Record<string, unknown>>)[0]!.env as Record<string, string>;
    assert.equal(env.MAKA_BENCHMARK_DATASET, 'terminal-bench');
  });

  test('oracle profile keeps the built-in agent and null import path', async () => {
    const manifest = await loadManifest();
    const { config } = buildSmokeJobConfig({
      manifest,
      profileName: 'oracle',
      overrides: { jobName: 'j' },
    });
    const agent = (config.agents as Array<Record<string, unknown>>)[0]!;
    assert.equal(agent.name, 'oracle');
    assert.equal(agent.import_path, null);
    assert.equal(config.agent_timeout_multiplier, null);
  });

  test('generated job name uses the injected clock when no explicit name is given', () => {
    const manifest: SmokeManifest = {
      defaults: { taskPattern: '*sqlite-with-gcov' },
      profiles: { 'maka-basic': { agent: { importPath: 'maka_agent:MakaAgent', env: {} } } },
    };
    const { jobName } = buildSmokeJobConfig({
      manifest,
      profileName: 'maka-basic',
      overrides: { now: fixedNow },
    });
    assert.equal(jobName, 'maka-basic-terminal-bench-sample-sqlite-with-gcov-20260716T123456Z');
  });

  test('resolveSmokeRunTargets returns a single target without compare', () => {
    assert.deepEqual(
      resolveSmokeRunTargets({ compare: false, profile: 'maka-heavy', jobName: 'run1' }),
      [{ profileName: 'maka-heavy', jobName: 'run1' }],
    );
  });

  test('resolveSmokeRunTargets splits compare profiles and suffixes job names', () => {
    assert.deepEqual(
      resolveSmokeRunTargets({
        compare: true,
        compareProfiles: 'maka-heavy, opencode',
        profile: 'x',
        jobName: 'run1',
      }),
      [
        { profileName: 'maka-heavy', jobName: 'run1-maka-heavy' },
        { profileName: 'opencode', jobName: 'run1-opencode' },
      ],
    );
  });

  test('resolveSmokeRunTargets leaves job names blank when none is supplied', () => {
    assert.deepEqual(
      resolveSmokeRunTargets({
        compare: true,
        compareProfiles: 'maka-basic,opencode',
        profile: 'x',
      }),
      [
        { profileName: 'maka-basic', jobName: '' },
        { profileName: 'opencode', jobName: '' },
      ],
    );
  });
});
