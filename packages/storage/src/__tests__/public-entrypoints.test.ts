import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const run = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Entrypoints whose module graph reaches `node:sqlite` at load time, so
 * importing one emits Node's SQLite ExperimentalWarning.
 *
 * This list is the package's SQLite boundary, stated out loud. `@maka/storage`
 * publishes no barrel: a consumer that needs a durable store imports the entry
 * that owns it and accepts the warning, and a consumer that needs
 * `workspace-root` or `credential-store` pays nothing. Issue #1257 came from
 * the opposite arrangement, where one `export *` barrel made every consumer —
 * `maka --help` included — load SQLite.
 *
 * Adding an entry here is a deliberate widening of that boundary. Removing one
 * means an entrypoint became SQLite-free. Either way, update this list in the
 * same change and say why.
 */
const SQLITE_BACKED_ENTRYPOINTS = [
  './agent-graph-control-store',
  './agent-run-store',
  './artifact-store',
  './artifact-stores',
  './daily-review-authority',
  './deep-research-authority',
  './deep-research-store',
  './execution-stores',
  './git-worktree-child-executor',
  './goal-authority',
  './interaction-store',
  './managed-workspace-owner',
  './model-call-ledger',
  './operational-state-store',
  './plan-authority',
  './project-catalog',
  './project-catalog-authority',
  './runtime-event-persistence',
  './scheduled-task-store',
  './session-bundle-policy',
  './session-store',
  './settings-store',
  './shell-run-authority',
  './shell-run-store',
  './sqlite-runtime-store',
  './sqlite-session-metadata-store',
  './storage-writer-composition',
  './task-ledger-authority',
  './usage-stores',
  './work-board-store',
];

/**
 * Loads an entrypoint in a child process and reports whether `node:sqlite`
 * entered its module graph, observed through a `module.registerHooks` resolve
 * hook. Matching Node's ExperimentalWarning text instead would tie this guard
 * to a string Node owns and has already reworded once.
 */
async function loadsSqlite(target: string): Promise<boolean> {
  const specifier = pathToFileURL(resolve(packageRoot, target)).href;
  const probe = [
    "import { registerHooks } from 'node:module';",
    'let sawSqlite = false;',
    'registerHooks({',
    '  resolve(request, context, nextResolve) {',
    '    const resolved = nextResolve(request, context);',
    "    if (resolved.url === 'node:sqlite') sawSqlite = true;",
    '    return resolved;',
    '  },',
    '});',
    `await import(${JSON.stringify(specifier)});`,
    "process.stdout.write(sawSqlite ? '\\nSQLITE_IN_GRAPH=yes' : '\\nSQLITE_IN_GRAPH=no');",
  ].join('\n');
  const { stdout } = await run(process.execPath, ['--input-type=module', '--eval', probe], {
    encoding: 'utf8',
  });
  const verdict = /SQLITE_IN_GRAPH=(yes|no)$/u.exec(stdout);
  assert.ok(verdict, `probe for ${target} produced no verdict; stdout was: ${stdout}`);
  return verdict[1] === 'yes';
}

async function publishedEntrypoints(): Promise<Record<string, string>> {
  const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')) as {
    exports: Record<string, string>;
  };
  return manifest.exports;
}

test('the package publishes no barrel entrypoint', async () => {
  const exports = await publishedEntrypoints();
  assert.equal('.' in exports, false);
  const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')) as {
    main?: string;
    types?: string;
  };
  assert.equal(manifest.main, undefined, 'a `main` field would re-advertise the barrel');
  assert.equal(manifest.types, undefined, 'a `types` field would re-advertise the barrel');
});

test('every published entrypoint target is emitted by the build', async () => {
  const exports = await publishedEntrypoints();
  for (const [subpath, target] of Object.entries(exports)) {
    assert.ok(
      existsSync(resolve(packageRoot, target)),
      `"${subpath}" points at ${target}, which the build did not emit`,
    );
  }
});

test('no source file imports the retired bare specifier', { timeout: 60_000 }, async () => {
  const repoRoot = resolve(packageRoot, '../..');
  const barePattern = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]@maka\/storage['"]/u;
  const sourceExtensions = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u;
  const skipped = new Set(['node_modules', 'dist', '.git']);
  const offenders: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        if (skipped.has(entry.name)) return;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return walk(path);
        if (!sourceExtensions.test(entry.name)) return;
        if (barePattern.test(await readFile(path, 'utf8'))) offenders.push(path);
      }),
    );
  }
  await Promise.all(
    ['packages', 'apps', 'scripts'].map((directory) => walk(join(repoRoot, directory))),
  );
  assert.deepEqual(
    offenders,
    [],
    'bare `@maka/storage` imports resolve to the removed `.` entrypoint and fail at runtime',
  );
});

test('only the declared entrypoints load node:sqlite', { timeout: 120_000 }, async () => {
  const exports = await publishedEntrypoints();
  const results = await Promise.all(
    Object.entries(exports).map(async ([subpath, target]) => ({
      subpath,
      sqlite: await loadsSqlite(target),
    })),
  );
  const actual = results
    .filter((entry) => entry.sqlite)
    .map((entry) => entry.subpath)
    .sort();
  assert.deepEqual(actual, [...SQLITE_BACKED_ENTRYPOINTS].sort());
});
