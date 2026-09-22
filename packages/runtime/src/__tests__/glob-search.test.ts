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
import {
  chmod,
  glob,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { executeFilesystemOperation } from '../filesystem-worker/operations.js';
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

test('both Glob paths report permission failures and recover after permissions are restored', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maka-glob-permissions-')));
  const blocked = join(root, 'blocked');
  await mkdir(blocked);
  t.after(async () => {
    await chmod(blocked, 0o700);
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, 'visible.txt'), 'visible');
  await writeFile(join(blocked, 'hidden.txt'), 'hidden');
  const boundary = {
    filesystem: { entries: [{ path: root, access: 'read' as const, scope: 'subtree' as const }] },
  };
  const local = new LocalWorkspaceExecutor();
  const searchers = [
    async (path: string, pattern = '**/*.txt') => {
      const resolved = await local.resolveExistingPath({
        cwd: root,
        path,
        label: 'Glob cwd',
        scope: 'workspace',
      });
      return local.globFiles({ cwd: resolved.path, pattern, limit: 200 });
    },
    async (path: string, pattern = '**/*.txt') =>
      executeFilesystemOperation({ kind: 'glob', cwd: root, path, pattern, limit: 200 }, boundary),
  ];
  await chmod(blocked, 0);
  const denied = (error: unknown) =>
    ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '');
  await assert.rejects(readdir(blocked), denied, 'permission fixture must actually deny reads');
  for (const search of searchers) {
    await assert.rejects(search(blocked), denied);
    await assert.rejects(search(root), denied);
    await assert.rejects(search(root, 'blocked/hidden.txt'), denied);
    await assert.rejects(search(join(root, 'missing')), { code: 'ENOENT' });
    const shallow = await search(root, '*.txt');
    assert.deepEqual('files' in shallow && shallow.files, ['visible.txt']);
  }
  await chmod(blocked, 0o700);
  for (const search of searchers) {
    const result = await search(root);
    assert.deepEqual('files' in result && result.files.sort(), [
      'blocked/hidden.txt',
      'visible.txt',
    ]);
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

test('Glob reports truncation when the pattern matched more files than the limit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-glob-truncated-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) await writeFile(join(root, name), '');

  const result = await globFiles({ cwd: root, pattern: '*.txt', limit: 3 });

  assert.equal(result.files.length, 3);
  assert.equal(result.truncated, true);
});

test('Glob reports a complete result when the limit is met exactly', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-glob-exact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['a.txt', 'b.txt', 'c.txt']) await writeFile(join(root, name), '');

  const result = await globFiles({ cwd: root, pattern: '*.txt', limit: 3 });

  assert.equal(result.files.length, 3);
  assert.equal(result.truncated, false);
});

test('Glob does not fail a capped result over an error the walk only reaches past the cap', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maka-glob-capped-error-')));
  const blocked = join(root, 'zblocked');
  await mkdir(blocked);
  t.after(async () => {
    await chmod(blocked, 0o700);
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, 'a.txt'), 'a');
  await writeFile(join(root, 'b.txt'), 'b');
  await writeFile(join(blocked, 'hidden.txt'), 'hidden');
  await chmod(blocked, 0);
  await assert.rejects(
    readdir(blocked),
    (error: unknown) => ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? ''),
    'permission fixture must actually deny reads',
  );

  // The cap fills from the root entries before the walk descends into the
  // unreadable directory, so this error is only observable past the cap.
  const result = await globFiles({ cwd: root, pattern: '**/*.txt', limit: 2 });

  assert.deepEqual(result.files, ['b.txt', 'a.txt']);
  assert.equal(result.truncated, false);
});
