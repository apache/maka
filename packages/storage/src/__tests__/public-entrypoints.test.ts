import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
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
  './task-ledger-authority',
  './usage-stores',
  './work-board-store',
];

async function loadsSqlite(target: string): Promise<boolean> {
  const specifier = pathToFileURL(resolve(packageRoot, target)).href;
  const { stderr } = await run(
    process.execPath,
    ['--input-type=module', '--eval', `await import(${JSON.stringify(specifier)})`],
    { encoding: 'utf8' },
  );
  return stderr.includes('SQLite is an experimental feature');
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
});

test('only the declared entrypoints load node:sqlite', { timeout: 120_000 }, async () => {
  const exports = await publishedEntrypoints();
  const results = await Promise.all(
    Object.entries(exports).map(async ([subpath, target]) => ({
      subpath,
      sqlite: await loadsSqlite(target),
    })),
  );
  const actual = results.filter((entry) => entry.sqlite).map((entry) => entry.subpath).sort();
  assert.deepEqual(actual, [...SQLITE_BACKED_ENTRYPOINTS].sort());
});
