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
import {
  chmod,
  glob,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
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
    'src',
    '**',
  ];
  if (process.platform !== 'win32') {
    await symlink('src', join(root, 'link'));
    patterns.push('link/*.ts');
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
