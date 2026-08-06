/**
 * Terminal-Bench smoke job-config generation.
 *
 * This is the registry-dataset / external-verifier / host-bridge Harbor config
 * shape used by the local smoke harness (run-terminal-bench-smoke.mjs). It is
 * deliberately distinct from buildHarborJobConfig in harbor-task-runner.ts,
 * which builds the fixed-prompt controller's local-task + custom-verifier +
 * in-container-cell config. The two config schemas do not overlap, so they stay
 * separate rather than being forced through one parameterized builder.
 *
 * Ported verbatim (behaviour-for-behaviour) from the embedded Node generator in
 * the retired terminal-bench-smoke/run-terminal-bench-sample.sh so existing
 * profiles keep producing byte-equivalent configs.
 */

import { lenientPositiveIntEnv } from './headless-run-env.js';
import { agentPhaseTimeoutSec } from './maka-settlement.js';

export interface SmokeManifestDataset {
  name?: string;
  version?: string;
}

export interface SmokeManifestDefaults {
  jobsDir?: string;
  generatedConfigDir?: string;
  dataset?: SmokeManifestDataset;
  taskPattern?: string;
  nAttempts?: number;
  nConcurrentTrials?: number;
  timeoutMultiplier?: number;
  retryMaxRetries?: number;
  modelExtraInstructionPaths?: string[];
}

export interface SmokeManifestAgent {
  name?: string;
  importPath?: string;
  modelName?: string;
  env?: Record<string, string>;
  kwargs?: Record<string, unknown>;
}

export interface SmokeManifestProfile {
  description?: string;
  agentTimeoutMultiplier?: number | null;
  extraInstructionPaths?: string[];
  agent?: SmokeManifestAgent;
}

export interface SmokeManifest {
  schemaVersion?: number;
  description?: string;
  defaults?: SmokeManifestDefaults;
  profiles?: Record<string, SmokeManifestProfile>;
}

export interface SmokeConfigOverrides {
  taskPattern?: string;
  jobName?: string;
  model?: string;
  maxSteps?: string;
  agentTimeoutSec?: string;
  nTasks?: number;
  datasetName?: string;
  datasetVersion?: string;
  benchmarkDataset?: string;
  /** Injectable clock for the generated job-name timestamp (defaults to now). */
  now?: () => Date;
}

export interface SmokeJobConfigResult {
  jobName: string;
  config: Record<string, unknown>;
}

export interface SmokeRunTarget {
  profileName: string;
  /** Empty string means "let buildSmokeJobConfig generate a timestamped name". */
  jobName: string;
}

function slug(value: string): string {
  return (
    String(value)
      .replace(/^\*/, '')
      .replace(/[^A-Za-z0-9_.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'sample'
  );
}

function retryConfig(defaults: SmokeManifestDefaults): Record<string, unknown> {
  return {
    max_retries: Number(defaults.retryMaxRetries || 0),
    include_exceptions: null,
    exclude_exceptions: [
      'AgentTimeoutError',
      'VerifierOutputParseError',
      'VerifierTimeoutError',
      'RewardFileNotFoundError',
      'RewardFileEmptyError',
    ],
    wait_multiplier: 1.0,
    min_wait_sec: 1.0,
    max_wait_sec: 60.0,
  };
}

/** Split a smoke run into ordered profile/job-name targets, matching the
 * retired shell runner's --compare / single-profile semantics. */
export function resolveSmokeRunTargets(input: {
  compare: boolean;
  compareProfiles?: string;
  profile: string;
  jobName?: string;
}): SmokeRunTarget[] {
  if (!input.compare) {
    return [{ profileName: input.profile, jobName: input.jobName ?? '' }];
  }
  const list = (input.compareProfiles ?? 'maka-basic,opencode').split(',');
  const targets: SmokeRunTarget[] = [];
  for (const raw of list) {
    const profileName = raw.trim();
    if (!profileName) continue;
    targets.push({
      profileName,
      jobName: input.jobName ? `${input.jobName}-${profileName}` : '',
    });
  }
  return targets;
}

export function buildSmokeJobConfig(input: {
  manifest: SmokeManifest;
  profileName: string;
  overrides?: SmokeConfigOverrides;
}): SmokeJobConfigResult {
  const { manifest, profileName } = input;
  const overrides = input.overrides ?? {};
  const defaults = manifest.defaults ?? {};
  const profile = manifest.profiles?.[profileName];
  if (!profile) {
    const names = Object.keys(manifest.profiles ?? {}).join(', ');
    throw new Error(`unknown profile "${profileName}". Available profiles: ${names}`);
  }

  // No literal default: the manifest always carries one, and spelling a task
  // name here compiles a Terminal-Bench task id into the build output a graded
  // arm mounts. `harness-ab-manifest.test.ts` holds that shut.
  const taskPattern = overrides.taskPattern || defaults.taskPattern;
  if (!taskPattern) throw new Error('smoke manifest defaults must carry a taskPattern');
  const datasetName = overrides.datasetName || defaults.dataset?.name || 'terminal-bench-sample';
  const datasetVersion = overrides.datasetVersion || defaults.dataset?.version || '2.0';
  const nTasks = overrides.nTasks ?? null;
  if (nTasks !== null && (!Number.isInteger(nTasks) || nTasks <= 0)) {
    throw new Error(`--n-tasks must be a positive integer, got ${nTasks}`);
  }

  const now = overrides.now ?? (() => new Date());
  const jobName =
    overrides.jobName ||
    [
      profileName,
      'terminal-bench-sample',
      nTasks ? `n${nTasks}` : slug(taskPattern),
      now().toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z'),
    ].join('-');

  const agent = profile.agent ?? {};
  const agentEnv: Record<string, string> = { ...(agent.env ?? {}) };
  let agentModelName = agent.modelName ?? null;
  const modelOverride = overrides.model;
  if (modelOverride) {
    if (profileName.startsWith('maka-')) {
      agentEnv.MAKA_MODEL = modelOverride;
    } else {
      agentModelName = modelOverride;
    }
  }

  if (overrides.maxSteps) agentEnv.MAKA_MAX_STEPS = overrides.maxSteps;
  if (overrides.agentTimeoutSec) agentEnv.MAKA_CELL_TIMEOUT_SEC = overrides.agentTimeoutSec;
  // Harbor resolves the agent phase as
  // `min(override_timeout_sec ?? task_declared, max_timeout_sec ?? inf) * multiplier`
  // (harbor/trial/trial.py, _resolve_timeout_sec). Once a maka profile declares a
  // cell budget, that budget plus its settlement window is the phase — on every
  // task, not just the ones whose declared timeout the profile multiplier happens
  // to line up with. So it goes on override_timeout_sec, which replaces the
  // declared base; max_timeout_sec is only a ceiling and could never raise it.
  const smokeModelBudgetSec = profileName.startsWith('maka-')
    ? lenientPositiveIntEnv(agentEnv.MAKA_CELL_TIMEOUT_SEC)
    : undefined;
  const smokeAgentPhaseSec =
    smokeModelBudgetSec === undefined
      ? null
      : agentPhaseTimeoutSec('maka', agentEnv, smokeModelBudgetSec);
  if (profileName.startsWith('maka-') && !agentEnv.MAKA_BENCHMARK_DATASET) {
    agentEnv.MAKA_BENCHMARK_DATASET = overrides.benchmarkDataset || datasetName;
  }

  const extraInstructionPaths = Object.prototype.hasOwnProperty.call(
    profile,
    'extraInstructionPaths',
  )
    ? (profile.extraInstructionPaths ?? [])
    : (defaults.modelExtraInstructionPaths ?? []);

  const config: Record<string, unknown> = {
    job_name: jobName,
    jobs_dir: defaults.jobsDir || 'packages/headless/harbor/smoke-jobs',
    n_attempts: Number(defaults.nAttempts || 1),
    timeout_multiplier: Number(defaults.timeoutMultiplier || 1.0),
    // Harbor applies this multiplier after the min(), so it would scale an
    // absolute phase too. Where we publish one, the multiplier's whole job —
    // stretching a task-declared timeout into the budget this profile wants —
    // is already done, and 1.0 is what keeps the published number the phase.
    // Profiles with no cell budget of their own still lean on the multiplier.
    agent_timeout_multiplier:
      smokeAgentPhaseSec !== null ? 1.0 : (profile.agentTimeoutMultiplier ?? null),
    verifier_timeout_multiplier: null,
    agent_setup_timeout_multiplier: null,
    environment_build_timeout_multiplier: null,
    debug: false,
    n_concurrent_trials: Number(defaults.nConcurrentTrials || 1),
    quiet: false,
    retry: retryConfig(defaults),
    environment: {
      type: 'docker',
      import_path: null,
      force_build: false,
      delete: true,
      cpu_enforcement_policy: 'auto',
      memory_enforcement_policy: 'auto',
      override_cpus: null,
      override_memory_mb: null,
      override_storage_mb: null,
      override_gpus: null,
      override_tpu: null,
      mounts: null,
      extra_docker_compose: [],
      env: {},
      kwargs: {},
      extra_allowed_hosts: [],
    },
    verifier: {
      override_timeout_sec: null,
      max_timeout_sec: null,
      env: {},
      disable: false,
    },
    metrics: [],
    agents: [
      {
        name: agent.name ?? null,
        import_path: agent.importPath ?? null,
        model_name: agentModelName,
        skills: [],
        override_timeout_sec: smokeAgentPhaseSec,
        override_setup_timeout_sec: null,
        max_timeout_sec: null,
        extra_allowed_hosts: [],
        kwargs: agent.kwargs ?? {},
        env: agentEnv,
        mcp_servers: [],
      },
    ],
    datasets: [
      {
        path: null,
        name: datasetName,
        version: datasetVersion,
        ref: null,
        registry_url: null,
        registry_path: null,
        overwrite: false,
        download_dir: null,
        task_names: nTasks ? null : [taskPattern],
        exclude_task_names: null,
        n_tasks: nTasks,
      },
    ],
    tasks: [],
    artifacts: [],
    extra_instruction_paths: extraInstructionPaths,
    plugins: [],
  };

  return { jobName, config };
}
