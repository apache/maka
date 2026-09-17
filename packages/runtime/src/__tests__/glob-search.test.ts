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
import nodeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { glob, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { globFiles } from '../glob-search.js';
import { LocalWorkspaceExecutor } from '../workspace-executor.js';

test('Glob reports a resolved cwd disappearing before traversal', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-glob-disappeared-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'cwd');
  await mkdir(cwd);
  const local = new LocalWorkspaceExecutor();
  const resolved = await local.resolveExistingPath({
    cwd,
    path: '.',
    label: 'Glob cwd',
    scope: 'workspace',
  });
  await rename(cwd, join(root, 'moved'));
  await assert.rejects(local.globFiles({ cwd: resolved.path, pattern: '**/*' }), {
    code: 'ENOENT',
  });
});

test('Glob reports an enumerated directory disappearing or changing type during traversal', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maka-glob-race-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalReaddir = nodeFs.readdir;
  for (const replaceWithFile of [false, true]) {
    const cwd = join(root, replaceWithFile ? 'replaced' : 'disappeared');
    const queued = join(cwd, 'queued');
    await mkdir(queued, { recursive: true });
    await writeFile(join(queued, 'hidden.txt'), 'hidden');
    let changed = false;
    t.mock.method(nodeFs, 'readdir', ((
      path: string,
      options: { withFileTypes: true },
      callback: (error: NodeJS.ErrnoException | null, entries: nodeFs.Dirent[]) => void,
    ) => {
      originalReaddir(path, options, (error, entries) => {
        if (String(path) === cwd && !error && !changed) {
          changed = true;
          nodeFs.renameSync(queued, join(root, `moved-${replaceWithFile}`));
          if (replaceWithFile) nodeFs.writeFileSync(queued, 'now a file');
        }
        callback(error, entries);
      });
    }) as typeof nodeFs.readdir);
    syncBuiltinESMExports();
    try {
      await assert.rejects(globFiles({ cwd, pattern: '**/*.txt' }), {
        code: replaceWithFile ? 'ENOTDIR' : 'ENOENT',
      });
      assert.equal(changed, true);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  }
});

test('Glob retains native pattern membership, including hidden entries and explicit symlink paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-glob-patterns-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  for (const file of ['a.ts', 'b.js', '.hidden.ts']) await writeFile(join(root, 'src', file), '');
  const patterns = [
    'src/*.*',
    '**/*.ts',
    'src/*.{ts,js}',
    'src/@(a|b).*',
    'src/.*',
    'missing/*.ts',
    'src/a.ts/*.ts',
    'src',
    '**',
  ];
  if (process.platform !== 'win32') {
    await symlink('src', join(root, 'link'));
    await symlink('..', join(root, 'src', 'parent-link'));
    patterns.push('link/*.ts', 'src/**/*.ts', 'src/*/*.ts', '**/parent-link/*.ts');
  }
  for (const pattern of patterns) {
    const expected = [];
    for await (const path of glob(pattern, { cwd: root })) expected.push(path);
    assert.deepEqual(
      (await globFiles({ cwd: root, pattern })).files.sort(),
      expected.sort(),
      pattern,
    );
  }
});
