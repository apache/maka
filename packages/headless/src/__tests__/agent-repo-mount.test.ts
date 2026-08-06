import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import {
  buildAgentRepoMounts,
  competitorRepoFiles,
  CONTAINER_MAKA_REPO,
  isOptionalRepoPath,
  makaRepoPaths,
  RENDERER_ONLY_WORKSPACES,
} from '../agent-repo-mount.js';
import { type HarnessAgentId, harnessAgentImportPath } from '../harness-agent-registry.js';

const COMPETITORS: readonly Exclude<HarnessAgentId, 'maka'>[] = [
  'opencode',
  'kimi-code',
  'codex',
  'claude-code',
  'reasonix',
];

const AGENTS: readonly HarnessAgentId[] = ['maka', ...COMPETITORS];

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** The repo's own top-level directories: what a container path can start with. */
const REPO_TOP_LEVEL = new Set(
  readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name),
);

/**
 * Every repo file an adapter names at a container path.
 *
 * Two forms carry a container path, and both must be read: the mounted path
 * spelled out in full, and the same path built by joining segments onto some
 * expression for the mount root. Matching a bare filename instead would be
 * neither — it resolves against whichever directory the matcher happens to
 * scan, so a read outside that directory looks like no read at all.
 *
 * The join form is matched by the chain rather than by what it hangs off,
 * because what it hangs off varies: `maka_repo` from the environment in one
 * adapter, a `Path("/opt/maka-agent")` constant in another, and nothing stops a
 * third from binding its own name. The chain is the part that cannot vary — a
 * repo path starts at a repo directory.
 */
function adapterContainerRepoReads(source: string): Set<string> {
  const read = new Set<string>();
  for (const [, literal] of source.matchAll(/["']([^"'\n]+)["']/g)) {
    if (literal.startsWith(`${CONTAINER_MAKA_REPO}/`)) {
      read.add(literal.slice(CONTAINER_MAKA_REPO.length + 1));
    }
  }
  for (const [, head, rest] of source.matchAll(/\/\s*"([^"\n]+)"((?:\s*\/\s*"[^"\n]+")*)/g)) {
    if (!REPO_TOP_LEVEL.has(head)) continue;
    const tail = [...rest.matchAll(/"([^"]+)"/g)].map(([, segment]) => segment);
    read.add([head, ...tail].join('/'));
  }
  return read;
}

const RENDERER_ONLY = new Set(RENDERER_ONLY_WORKSPACES);

/** The workspaces the container is expected to be able to load. */
const MAKA_WORKSPACES = (
  JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { workspaces: string[] }
).workspaces.filter((workspace) => !RENDERER_ONLY.has(workspace));

describe('agent repo mounts', () => {
  test('gives Maka its build outputs, not the repo root', () => {
    const mounts = buildAgentRepoMounts('maka', '/repo', { pathExists: () => true }) as Array<{
      source: string;
      target: string;
      read_only: boolean;
    }>;
    assert.ok(
      mounts.every((mount) => mount.target !== CONTAINER_MAKA_REPO),
      'Maka must not receive the repo root',
    );
    assert.deepEqual(
      mounts.map((mount) => mount.target),
      makaRepoPaths().map((repoPath) => `${CONTAINER_MAKA_REPO}/${repoPath}`),
    );
    assert.ok(
      mounts.every((mount) => mount.read_only),
      'Maka must not receive a writable repo path',
    );
  });

  test('every required path Maka declares exists in the repo', () => {
    for (const repoPath of makaRepoPaths()) {
      if (isOptionalRepoPath(repoPath)) continue;
      assert.ok(existsSync(join(REPO_ROOT, repoPath)), `Maka declares missing ${repoPath}`);
    }
  });

  test('declares every workspace dependency tree npm could not hoist away', () => {
    // This is the direction that actually broke: `packages/runtime/node_modules`
    // exists — npm could not hoist `@slack/socket-mode` past a version conflict
    // — and omitting it resolved fine on the host, then failed in the container
    // on the first import that needed it. Nothing but a live container run
    // caught that. The repo already knows the answer, so ask it here.
    const mounted = new Set(makaRepoPaths());
    for (const workspace of MAKA_WORKSPACES) {
      const repoPath = `${workspace}/node_modules`;
      if (!existsSync(join(REPO_ROOT, repoPath))) continue;
      assert.ok(
        mounted.has(repoPath),
        `${workspace} keeps a private ${repoPath} that is not mounted`,
      );
    }
  });

  test('drops a workspace dependency tree npm managed to hoist away', () => {
    // Mounting it blind would have Docker create the directory on the host,
    // inside the repo, as a side effect of starting a graded run.
    const absent = `${CONTAINER_MAKA_REPO}/packages/runtime/node_modules`;
    const mounts = buildAgentRepoMounts('maka', '/repo', {
      pathExists: (path) => !path.endsWith('packages/runtime/node_modules'),
    }) as Array<{ target: string }>;
    assert.ok(!mounts.some((mount) => mount.target === absent));
    assert.ok(mounts.some((mount) => mount.target.endsWith('/packages/runtime/dist')));
  });

  test('keeps sources and evaluation records out of the Maka container', () => {
    // What the #2245 run actually reached through the old repo-root mount: the
    // benchmark's own per-task results under docs/eval, and the verifier source
    // under packages/headless/src. The container executes dist, so neither is
    // needed to run — only to look up what this benchmark expects.
    //
    // Read the produced mounts, not the declaration. A declaration that names
    // no forbidden path still leaks every one of them if the builder mounts the
    // root anyway, and asserting the list cannot tell those apart.
    const mounts = buildAgentRepoMounts('maka', '/repo', { pathExists: () => true }) as Array<{
      target: string;
    }>;
    for (const mount of mounts) {
      assert.notEqual(mount.target, CONTAINER_MAKA_REPO, 'Maka must not receive the repo root');
    }
    for (const repoPath of mounts.map((mount) =>
      mount.target.slice(CONTAINER_MAKA_REPO.length + 1),
    )) {
      assert.ok(!repoPath.startsWith('docs'), `Maka must not be handed evaluation records`);
      assert.ok(!/(^|\/)src(\/|$)/.test(repoPath), `Maka must not be handed sources (${repoPath})`);
      assert.ok(!/(^|\/)\.git(\/|$)/.test(repoPath), `Maka must not be handed repo history`);
      assert.notEqual(
        repoPath,
        'packages/headless/harbor/run-harness-ab.mjs',
        'Maka must not be handed the harness manifest source',
      );
    }
  });

  test('mounts the build output of every workspace the container CLI can reach', () => {
    // The declared list is the authority for what exists in the container, and
    // nothing else checks it against the workspaces that actually ship. A new
    // runtime workspace added without an entry here resolves at build time and
    // fails inside the container partway through a graded run.
    const mounted = new Set(makaRepoPaths());
    for (const workspace of MAKA_WORKSPACES) {
      assert.ok(
        mounted.has(`${workspace}/dist`),
        `${workspace} ships but its dist is not mounted for Maka`,
      );
      assert.ok(
        mounted.has(`${workspace}/package.json`),
        `${workspace} ships but its manifest is not mounted for Maka`,
      );
    }
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

  test('declares every repo file an adapter names at a container path', () => {
    // Every assertion above derives its expectation from the declaration lists,
    // so none of them can tell a wrong list from a right one. The adapters are
    // the authority for what is read at a container path, so read them instead:
    // a repo read added there without an entry in the list mounts nothing.
    // `run-host-cell.mjs` is what that costs — `install()` probes for it in
    // every cell-mode branch, it was left out of the declaration, and a missing
    // probe target aborts the trial before the arm runs at all.
    for (const agent of AGENTS) {
      const adapterModule = harnessAgentImportPath(agent).split(':')[0];
      const source = readFileSync(
        join(REPO_ROOT, 'packages/headless/harbor', `${adapterModule}.py`),
        'utf8',
      );
      const mounted = agent === 'maka' ? makaRepoPaths() : competitorRepoFiles(agent);
      const reads = adapterContainerRepoReads(source);
      // A reader that matches nothing passes everything. An adapter with files
      // declared for it is one whose source names them, so an empty read set
      // here is the reader having stopped reading — the way a regex guard
      // rots, and the way the form it replaced rotted.
      if (mounted.length > 0) {
        assert.ok(reads.size > 0, `no container paths were found in ${adapterModule}.py`);
      }
      for (const repoFile of reads) {
        // A file may be mounted directly or inside a mounted directory.
        const covered = mounted.some(
          (repoPath) => repoPath === repoFile || repoFile.startsWith(`${repoPath}/`),
        );
        assert.ok(covered, `${adapterModule}.py names ${repoFile}, which ${agent} is not mounted`);
      }
    }
  });

  test('the container-path reader sees both ways an adapter names a file', () => {
    // The check above is worth exactly what this reader sees, and what it saw
    // was narrower than it looked: competitor adapters used to be scanned for
    // bare filenames resolved against `harbor/`, so a read of any repo file
    // outside that one directory — `dist/index.js`, say — matched nothing and
    // passed. Both forms below appear in adapters today.
    assert.deepEqual(
      [...adapterContainerRepoReads(`_P = Path("${CONTAINER_MAKA_REPO}/packages/a/b.json")`)],
      ['packages/a/b.json'],
    );
    assert.deepEqual(
      [
        ...adapterContainerRepoReads(
          'p = (\n    Path(maka_repo)\n    / "packages"\n    / "headless"\n    / "dist"\n    / "index.js"\n)',
        ),
      ],
      ['packages/headless/dist/index.js'],
    );
    // The same chain hung off a different name for the mount root. Both
    // spellings are in the adapters today, and reading only the first left the
    // second — `_CONTAINER_MAKA_REPO / "packages" / …` — unseen.
    assert.deepEqual(
      [...adapterContainerRepoReads('_CLI = _CONTAINER_MAKA_REPO / "packages" / "a" / "cli.js"')],
      ['packages/a/cli.js'],
    );
  });

  test('keeps the benchmark identity out of every graded container', () => {
    // harbor/benchmark-identity.json carries each benchmark's revision, task
    // list and upstream repository URL; docs/eval carries earlier per-task
    // results. Neither is a file any arm needs, and both convert a graded run
    // into retrieval.
    const declarations: Array<readonly [string, readonly string[]]> = [
      ['maka', makaRepoPaths()],
      ...COMPETITORS.map((agent) => [agent, competitorRepoFiles(agent)] as const),
    ];
    for (const [agent, files] of declarations) {
      for (const file of files) {
        assert.ok(
          !file.startsWith('docs/'),
          `${agent} must not be handed evaluation records (${file})`,
        );
        assert.ok(
          !file.startsWith('packages/headless/harbor/benchmark-identity'),
          `${agent} must not be handed the benchmark identity (${file})`,
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
