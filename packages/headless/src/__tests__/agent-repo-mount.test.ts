import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import {
  buildAgentRepoMounts,
  competitorRepoFiles,
  CONTAINER_MAKA_REPO,
} from '../agent-repo-mount.js';
import { type HarnessAgentId, harnessAgentImportPath } from '../harness-agent-registry.js';

const COMPETITORS: readonly Exclude<HarnessAgentId, 'maka'>[] = [
  'opencode',
  'kimi-code',
  'codex',
  'claude-code',
  'reasonix',
];

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('agent repo mounts', () => {
  test('gives Maka the tree it executes out of', () => {
    assert.deepEqual(buildAgentRepoMounts('maka', '/repo'), [
      { type: 'bind', source: '/repo', target: CONTAINER_MAKA_REPO, read_only: true },
    ]);
  });

  for (const agent of COMPETITORS) {
    test(`hands ${agent} files, never a directory it can walk`, () => {
      const mounts = buildAgentRepoMounts(agent, '/repo') as Array<{
        source: string;
        target: string;
        read_only: boolean;
      }>;
      // The whole point: no target is the repo root, so there is nothing to
      // enumerate. A directory mount here is how Codex reached the benchmark's
      // pinned revision and retrieved a task's reference solution.
      assert.ok(
        mounts.every((mount) => mount.target !== CONTAINER_MAKA_REPO),
        `${agent} must not receive the repo root`,
      );
      assert.deepEqual(
        mounts.map((mount) => mount.target),
        competitorRepoFiles(agent).map((file) => `${CONTAINER_MAKA_REPO}/${file}`),
      );
      assert.ok(
        mounts.every((mount) => mount.read_only),
        `${agent} must not receive a writable repo path`,
      );
    });

    test(`every file ${agent} declares exists in the repo`, () => {
      // A declared-but-missing path is worse than a missing mount: Docker
      // materialises the target as an empty directory, so the adapter reads a
      // directory where it expected its config and fails inside the container
      // rather than here.
      for (const file of competitorRepoFiles(agent)) {
        assert.ok(existsSync(join(REPO_ROOT, file)), `${agent} declares missing ${file}`);
      }
    });
  }

  test('declares every repo file the adapters read at a container path', () => {
    // Every assertion above derives its expectation from competitorRepoFiles(),
    // so none of them can tell a wrong list from a right one. The adapters are
    // the authority for what is read at a container path, so read them instead:
    // a repo read added there without an entry here mounts nothing, and the arm
    // fails inside the container partway through a graded run.
    const harborDir = join(REPO_ROOT, 'packages/headless/harbor');
    const repoFileByBasename = new Map(
      readdirSync(harborDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const absolute = join(entry.parentPath, entry.name);
          return [entry.name, relative(REPO_ROOT, absolute)] as const;
        }),
    );

    for (const agent of COMPETITORS) {
      const adapterModule = harnessAgentImportPath(agent).split(':')[0];
      const source = readFileSync(join(harborDir, `${adapterModule}.py`), 'utf8');
      const read = new Set<string>();
      for (const [, literal] of source.matchAll(/["']([^"'\n]+)["']/g)) {
        // Adapters name a file either by its absolute container path or by
        // joining MAKA_REPO_ROOT with the path segments, so match both.
        if (literal.startsWith(`${CONTAINER_MAKA_REPO}/`)) {
          read.add(literal.slice(CONTAINER_MAKA_REPO.length + 1));
          continue;
        }
        const repoFile = repoFileByBasename.get(literal);
        if (repoFile) read.add(repoFile);
      }
      for (const repoFile of read) {
        assert.ok(
          competitorRepoFiles(agent).includes(repoFile),
          `${adapterModule}.py reads ${repoFile}, which ${agent} is not mounted`,
        );
      }
    }
  });

  test('keeps the benchmark identity out of every competitor container', () => {
    // run-harness-ab.mjs carries TERMINAL_BENCH_2_1_REVISION and the upstream
    // repository URL; docs/eval carries earlier per-task results. Neither is a
    // file any arm needs, and both convert a graded run into retrieval.
    for (const agent of COMPETITORS) {
      for (const file of competitorRepoFiles(agent)) {
        assert.ok(
          !file.startsWith('docs/'),
          `${agent} must not be handed evaluation records (${file})`,
        );
        assert.notEqual(
          file,
          'packages/headless/harbor/run-harness-ab.mjs',
          `${agent} must not be handed the harness manifest source`,
        );
      }
    }
  });
});
