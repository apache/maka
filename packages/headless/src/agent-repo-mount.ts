/**
 * What a graded arm may read out of this repo, and the mounts that enforce it.
 *
 * Both executors bind this repo into the task container. Maka executes out of
 * that tree, so it gets the tree. A competitor runs from its own pinned
 * toolchain and only ever names individual files here, so it gets those files
 * and no directory to walk.
 *
 * The distinction is not tidiness. This repo is not benchmark-neutral cargo:
 * `packages/headless/harbor/run-harness-ab.mjs` carries
 * TERMINAL_BENCH_2_1_REVISION and the upstream repository URL, and `docs/eval`
 * carries per-task results from earlier runs. Handing that to an arm being
 * scored turns scoring into retrieval. In the #1970 three-arm run Codex read
 * the pinned revision out of the mount, fetched the task's reference solution
 * from the public repository at that exact revision, and lifted the expected
 * output out of its test file — a recorded pass that measured retrieval.
 *
 * Both executors resolve their repo mounts here so the two cannot drift: a file
 * added for one arm in one runner is not silently absent in the other.
 */
import { join } from 'node:path';
import type { HarnessAgentId } from './harness-agent-registry.js';

export const CONTAINER_MAKA_REPO = '/opt/maka-agent';

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
 * The repo mounts for one arm. Maka gets the tree it runs from; every other arm
 * gets exactly the files it declared and nothing it could enumerate.
 */
export function buildAgentRepoMounts(
  agent: HarnessAgentId,
  makaRepoPath: string,
): Array<Record<string, unknown>> {
  if (agent === 'maka') {
    return [{ type: 'bind', source: makaRepoPath, target: CONTAINER_MAKA_REPO, read_only: true }];
  }
  return competitorRepoFiles(agent).map((repoFile) => ({
    type: 'bind',
    source: join(makaRepoPath, repoFile),
    target: `${CONTAINER_MAKA_REPO}/${repoFile}`,
    read_only: true,
  }));
}
