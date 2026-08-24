/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
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

/**
 * Published entrypoints no file outside this package imports today. Every one
 * of them predates this change, so retiring them is a separate compatibility
 * decision. The assertion is exact in both directions — gaining a consumer
 * means removing the entry, and publishing a *new* consumer-less entrypoint
 * fails outright, which is the direction this guard exists to hold.
 *
 * `./model-call-ledger` is on the list without this change touching it: it was
 * already published, and `repairPendingModelCallProjections` lost its last
 * caller when `canonical-usage-reader` was rewritten on `main`. It is listed
 * here rather than unpublished for the same reason as the rest — retiring a
 * subpath that already shipped is a compatibility call of its own.
 */
const PREEXISTING_UNCONSUMED_ENTRYPOINTS = [
  './activation-secret-injector',
  './encrypted-file-managed-secret-store',
  './managed-secret-store',
  './model-call-ledger',
  './write-queue',
];

interface StorageImportScan {
  bareImporters: string[];
  subpathImporters: Map<string, string[]>;
  externalSubpaths: Set<string>;
}

let storageImportScan: Promise<StorageImportScan> | undefined;

/** Collects every `@maka/storage` import specifier in the repository's sources, once. */
function scanStorageImports(): Promise<StorageImportScan> {
  storageImportScan ??= runStorageImportScan();
  return storageImportScan;
}

async function runStorageImportScan(): Promise<StorageImportScan> {
  const repoRoot = resolve(packageRoot, '../..');
  const specifierPattern =
    /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]@maka\/storage(\/[^'"]*)?['"]/gu;
  const sourceExtensions = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u;
  const skipped = new Set(['node_modules', 'dist', '.git']);
  const scan: StorageImportScan = {
    bareImporters: [],
    subpathImporters: new Map(),
    externalSubpaths: new Set(),
  };
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        if (skipped.has(entry.name)) return;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return walk(path);
        if (!sourceExtensions.test(entry.name)) return;
        const source = await readFile(path, 'utf8');
        for (const match of source.matchAll(specifierPattern)) {
          if (!match[1]) {
            scan.bareImporters.push(path);
            continue;
          }
          const subpath = `.${match[1]}`;
          const importers = scan.subpathImporters.get(subpath) ?? [];
          importers.push(path);
          scan.subpathImporters.set(subpath, importers);
          if (relative(packageRoot, path).startsWith('..')) scan.externalSubpaths.add(subpath);
        }
      }),
    );
  }
  await Promise.all(
    ['packages', 'apps', 'scripts'].map((directory) => walk(join(repoRoot, directory))),
  );
  return scan;
}

test('no source file imports the retired bare specifier', { timeout: 60_000 }, async () => {
  const { bareImporters } = await scanStorageImports();
  assert.deepEqual(
    bareImporters,
    [],
    'bare `@maka/storage` imports resolve to the removed `.` entrypoint and fail at runtime',
  );
});

test('published entrypoints and their consumers match exactly', { timeout: 60_000 }, async () => {
  const exports = await publishedEntrypoints();
  const { subpathImporters, externalSubpaths } = await scanStorageImports();
  const unpublished = [...subpathImporters.keys()].filter((subpath) => !(subpath in exports));
  assert.deepEqual(unpublished.sort(), [], 'imported subpaths missing from the exports map');
  const unconsumed = Object.keys(exports).filter((subpath) => !externalSubpaths.has(subpath));
  assert.deepEqual(
    unconsumed.sort(),
    PREEXISTING_UNCONSUMED_ENTRYPOINTS,
    'each published subpath is a compatibility promise — publish it when a consumer exists',
  );
});

/** Caps concurrent probe children at `limit`; the outer test runner is already concurrent. */
async function mapWithConcurrency<Item, Result>(
  items: Item[],
  limit: number,
  task: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await task(items[index]);
      }
    }),
  );
  return results;
}

test('only the declared entrypoints load node:sqlite', { timeout: 120_000 }, async () => {
  const exports = await publishedEntrypoints();
  const results = await mapWithConcurrency(
    Object.entries(exports),
    4,
    async ([subpath, target]) => ({
      subpath,
      sqlite: await loadsSqlite(target),
    }),
  );
  const actual = results
    .filter((entry) => entry.sqlite)
    .map((entry) => entry.subpath)
    .sort();
  assert.deepEqual(actual, [...SQLITE_BACKED_ENTRYPOINTS].sort());
});
