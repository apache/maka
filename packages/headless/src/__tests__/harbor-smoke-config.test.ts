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
import { type HarborAgentEntry, harborAgentPhaseSec } from './helpers/harbor-agent-phase.js';

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
  });

  // Every deadline assertion below goes through harborAgentPhaseSec — Harbor's
  // own resolution rule, modelled once in ./helpers/harbor-agent-phase.js and
  // shared with the fixed-prompt producer's suite.
  const MAKA_PROFILES = [
    'maka-basic',
    'maka-heavy',
    'maka-heavy-prune',
    'maka-prune-default',
    'maka-stale-off',
    'maka-retrieval-on',
  ];

  // Two declared timeouts that bracket every shipped cell budget from both
  // sides. Naming a pair rather than one is the point: with the phase published
  // absolutely it cannot depend on the declared timeout at all, and one value
  // cannot express independence.
  const DECLARED_BELOW_SEC = 600;
  const DECLARED_ABOVE_SEC = 12_000;

  test('the smoke agent phase outlasts the cell budget by the settlement window', async () => {
    // The regression this pins: publishing budget + grace on max_timeout_sec.
    // For maka-basic on the default 900s task Harbor folded that to
    // min(900, 3630) * 4 = 3600 — the cell budget exactly, so the cell was
    // SIGKILLed at the instant it stopped calling the model and began writing
    // maka-cell-output.json, and a scored trial read as an infra failure.
    const manifest = await loadManifest();
    for (const profileName of MAKA_PROFILES) {
      const { config } = buildSmokeJobConfig({
        manifest,
        profileName,
        overrides: { jobName: 'job' },
      });
      const agent = (config.agents as HarborAgentEntry[])[0]!;
      const budget = Number(agent.env.MAKA_CELL_TIMEOUT_SEC);
      for (const declared of [DECLARED_BELOW_SEC, DECLARED_ABOVE_SEC]) {
        assert.equal(
          harborAgentPhaseSec(config, declared),
          budget + MAKA_SETTLEMENT_GRACE_SEC,
          `${profileName} @ declared=${declared}`,
        );
      }
      // A ceiling cannot raise a base, so leaving one behind can only re-clamp it.
      assert.equal(agent.max_timeout_sec, null, profileName);
      // 1.0, not null: null makes Harbor fall back to the job-level
      // timeout_multiplier, which would rescale the absolute phase we just
      // published. The manifest test below proves the difference is real.
      assert.equal(config.agent_timeout_multiplier, 1.0, profileName);
    }
  });

  test('a job-level timeout multiplier cannot rescale the published smoke phase', async () => {
    // timeoutMultiplier is a supported manifest knob, and Harbor reaches for it
    // whenever agent_timeout_multiplier is null. Pinning agent_timeout_multiplier
    // at 1.0 is what keeps the number we publish the number Harbor kills at;
    // leaving it null here would resolve 3630 * 0.5 = 1815 — under the cell's own
    // 3600s budget, which is the very kill this fix exists to prevent.
    const manifest = await loadManifest();
    const scaled: SmokeManifest = {
      ...manifest,
      defaults: { ...manifest.defaults, timeoutMultiplier: 0.5 },
    };
    const { config } = buildSmokeJobConfig({
      manifest: scaled,
      profileName: 'maka-basic',
      overrides: { jobName: 'job' },
    });
    assert.equal(config.timeout_multiplier, 0.5);
    assert.equal(harborAgentPhaseSec(config, 900), 3600 + MAKA_SETTLEMENT_GRACE_SEC);
  });

  test('an operator-widened settlement window widens the smoke phase', async () => {
    const manifest = await loadManifest();
    const widened = MAKA_SETTLEMENT_GRACE_SEC * 3;
    const profile = manifest.profiles!['maka-basic']!;
    const patched: SmokeManifest = {
      ...manifest,
      profiles: {
        ...manifest.profiles,
        'maka-basic': {
          ...profile,
          agent: {
            ...profile.agent,
            env: {
              ...profile.agent!.env,
              MAKA_CELL_SETTLEMENT_GRACE_SEC: String(widened),
            },
          },
        },
      },
    };
    const { config } = buildSmokeJobConfig({
      manifest: patched,
      profileName: 'maka-basic',
      overrides: { jobName: 'job' },
    });
    const agent = (config.agents as HarborAgentEntry[])[0]!;
    // The cell reads the same env, so both sides of the window move together.
    assert.equal(agent.env.MAKA_CELL_SETTLEMENT_GRACE_SEC, String(widened));
    assert.equal(harborAgentPhaseSec(config, 900), 3600 + widened);
  });

  test('every smoke arm gets the same model budget and only Maka a settlement tail', async () => {
    // The one number that has to be identical across arms for --compare to mean
    // anything is the model budget. opencode has no cell budget of its own, so
    // its multiplier stays the only control that can buy it the same 3600s — and
    // nothing else in the suite ties the two arms together.
    const manifest = await loadManifest();
    const configFor = (profileName: string) =>
      buildSmokeJobConfig({ manifest, profileName, overrides: { jobName: 'job' } }).config;

    const maka = configFor('maka-basic');
    const opencode = configFor('opencode');
    const budget = Number((maka.agents as HarborAgentEntry[])[0]!.env.MAKA_CELL_TIMEOUT_SEC);

    // On the dataset's default task both arms call the model for the same budget.
    assert.equal(harborAgentPhaseSec(opencode, 900), budget);
    assert.equal(opencode.agent_timeout_multiplier, 4);
    assert.equal((opencode.agents as HarborAgentEntry[])[0]!.override_timeout_sec, null);

    // The whole asymmetry: only the Maka cell has artifacts to settle.
    assert.ok(MAKA_SETTLEMENT_GRACE_SEC > 0, 'the settlement window must be a real window');
    assert.equal(
      harborAgentPhaseSec(maka, 900) - harborAgentPhaseSec(opencode, 900),
      MAKA_SETTLEMENT_GRACE_SEC,
    );
  });

  test('the oracle profile gets neither a settlement window nor a multiplier', async () => {
    const manifest = await loadManifest();
    const { config } = buildSmokeJobConfig({
      manifest,
      profileName: 'oracle',
      overrides: { jobName: 'job' },
    });
    const agent = (config.agents as HarborAgentEntry[])[0]!;
    assert.equal(agent.max_timeout_sec, null);
    assert.equal(agent.override_timeout_sec, null);
    // The phase is the task's own declared timeout, untouched.
    assert.equal(harborAgentPhaseSec(config, 900), 900);
  });

  test('--agent-timeout-sec moves the whole phase, not just the cell budget', async () => {
    const manifest = await loadManifest();
    const { config } = buildSmokeJobConfig({
      manifest,
      profileName: 'maka-heavy',
      overrides: { jobName: 'job', agentTimeoutSec: '180' },
    });
    const agent = (config.agents as HarborAgentEntry[])[0]!;
    assert.equal(agent.env.MAKA_CELL_TIMEOUT_SEC, '180');
    // Pre-fix this resolved to min(900, 210) * 8 = 1680 — an operator asking for
    // a 3-minute smoke run got a 28-minute one, and never saw the kill at all.
    assert.equal(harborAgentPhaseSec(config, 900), 180 + MAKA_SETTLEMENT_GRACE_SEC);
  });

  test('a maka profile with an unparseable cell budget falls back to the multiplier', async () => {
    // Nothing absolute to publish, so Harbor's own base has to stand — clamping
    // it to a phase we could not derive would be worse than leaving it alone.
    const manifest = await loadManifest();
    const profile = manifest.profiles!['maka-basic']!;
    const patched: SmokeManifest = {
      ...manifest,
      profiles: {
        ...manifest.profiles,
        'maka-basic': {
          ...profile,
          agent: {
            ...profile.agent,
            env: { ...profile.agent!.env, MAKA_CELL_TIMEOUT_SEC: 'nope' },
          },
        },
      },
    };
    const { config } = buildSmokeJobConfig({
      manifest: patched,
      profileName: 'maka-basic',
      overrides: { jobName: 'job' },
    });
    assert.equal((config.agents as HarborAgentEntry[])[0]!.override_timeout_sec, null);
    assert.equal(config.agent_timeout_multiplier, 4);
    assert.equal(harborAgentPhaseSec(config, 900), 3600);
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
