/**
 * What a graded arm may read out of this repo, and the mounts that enforce it.
 *
 * Both executors bind this repo into the task container. Every arm gets a
 * declared list and no directory it could walk up out of: a competitor runs
 * from its own pinned toolchain and names individual files, while Maka executes
 * out of this tree and needs whole build outputs.
 *
 * The distinction is not tidiness. This repo is not benchmark-neutral cargo:
 * `packages/headless/harbor/benchmark-identity.json` carries
 * each benchmark's revision, task list and upstream repository URL, and `docs/eval`
 * carries per-task results from earlier runs. Handing that to an arm being
 * scored turns scoring into retrieval. In the #1970 three-arm run Codex read
 * the pinned revision out of the mount, fetched the task's reference solution
 * from the public repository at that exact revision, and lifted the expected
 * output out of its test file — a recorded pass that measured retrieval.
 *
 * The Maka arm used to be exempt on the theory that it runs our own runtime.
 * The model does not know it is ours. In the #2245 two-arm run it grepped the
 * mount and read `docs/eval/terminal-bench-2.1-*.csv` — this benchmark's own
 * per-task pass/fail table from earlier runs — and, on another task, the
 * verifier source at `packages/headless/src/terminal-bench-adapter.ts`. Neither
 * is a file the runtime executes; both were reachable only because the mount
 * was the repo root.
 *
 * Both executors resolve their repo mounts here so the two cannot drift: a file
 * added for one arm in one runner is not silently absent in the other.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessAgentId } from './harness-agent-registry.js';

export const CONTAINER_MAKA_REPO = '/opt/maka-agent';

/**
 * Workspaces that never load in the headless container, and so are the only
 * ones absent below. Exported because the test that cross-checks this list
 * against the root manifest needs the same exclusion, and two copies of it
 * drift into a workspace nobody mounts.
 */
export const RENDERER_ONLY_WORKSPACES: readonly string[] = [
  'packages/ui',
  'packages/cli',
  'apps/desktop',
];

/** Workspaces whose build output the in-container Maka runtime resolves. */
const MAKA_RUNTIME_WORKSPACES: readonly string[] = [
  'packages/code-mode',
  'packages/core',
  'packages/storage',
  'packages/mcp',
  'packages/runtime',
  'packages/runtime-host',
  'packages/computer-use',
  'packages/headless',
];

/**
 * Repo paths the Maka arm executes out of: installed dependencies, workspace
 * manifests so the `@maka/*` symlinks in `node_modules` resolve, each
 * workspace's build output, and the harbor entrypoints the adapter names.
 *
 * Sources are deliberately absent. The container runs `dist`, so shipping `src`
 * adds nothing to run and hands over the verifier and the harness manifest as
 * readable text.
 */
const MAKA_REPO_PATHS: readonly string[] = [
  'node_modules',
  'package.json',
  ...MAKA_RUNTIME_WORKSPACES.flatMap((workspace) => [
    `${workspace}/package.json`,
    `${workspace}/dist`,
    // npm hoists what it can, but a workspace that pins a conflicting version
    // keeps it here. Omitting these resolves fine on the host and then fails in
    // the container on the first import that needs one.
    `${workspace}/node_modules`,
  ]),
  // maka_agent.py `_run_cell_path` and `_run_host_cell_path`. Both are probed
  // by `install()` before either can run, so a missing one aborts the trial
  // rather than degrading it.
  'packages/headless/harbor/run-cell.mjs',
  'packages/headless/harbor/run-host-cell.mjs',
];

export function makaRepoPaths(): readonly string[] {
  return MAKA_REPO_PATHS;
}

/**
 * Repo-relative files each competitor adapter reads at its container path.
 * An empty list is the default and the goal: the arm needs nothing from here.
 */
const COMPETITOR_REPO_FILES: Readonly<Record<Exclude<HarnessAgentId, 'maka'>, readonly string[]>> =
  {
    // opencode_agent.py `_stop_runner_path` and `_opencode_config_path`.
    opencode: [
      'packages/headless/harbor/opencode-stop-runner.mjs',
      'packages/headless/harbor/opencode-benchmark.json',
    ],
    // codex_agent.py `_DEEPSEEK_MODELS_PATH`.
    codex: ['packages/headless/harbor/deepseek-codex-models.json'],
    'kimi-code': [],
    'claude-code': [],
    reasonix: [],
  };

export function competitorRepoFiles(agent: Exclude<HarnessAgentId, 'maka'>): readonly string[] {
  return COMPETITOR_REPO_FILES[agent];
}

/**
 * The repo mounts for one arm: exactly what it declared, and no path from which
 * the rest of the repo can be enumerated.
 *
 * Optional paths are dropped when absent rather than mounted blind, because
 * Docker materialises a missing bind source as a new empty directory — on the
 * host, inside the repo. Which workspaces keep a private `node_modules` depends
 * on what npm managed to hoist, so those are declared and filtered here rather
 * than pinned to one install's outcome.
 */
export function buildAgentRepoMounts(
  agent: HarnessAgentId,
  makaRepoPath: string,
  options: { pathExists?: (path: string) => boolean } = {},
): Array<Record<string, unknown>> {
  const pathExists = options.pathExists ?? existsSync;
  const repoPaths = agent === 'maka' ? makaRepoPaths() : competitorRepoFiles(agent);
  return repoPaths
    .map((repoPath) => ({ repoPath, source: join(makaRepoPath, repoPath) }))
    .filter(({ repoPath, source }) => !isOptionalRepoPath(repoPath) || pathExists(source))
    .map(({ repoPath, source }) => ({
      type: 'bind',
      source,
      target: `${CONTAINER_MAKA_REPO}/${repoPath}`,
      read_only: true,
    }));
}

/** Workspace-private dependency trees exist only where npm could not hoist. */
export function isOptionalRepoPath(repoPath: string): boolean {
  return repoPath.startsWith('packages/') && repoPath.endsWith('/node_modules');
}
