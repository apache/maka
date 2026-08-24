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
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createBoundaryFilesystemExecutor } from '../filesystem-executor.js';
import { createLocalWorkspaceExecutor } from '../workspace-executor.js';

test('applies one native update operation through the filesystem authority', async (t) => {
  const cwd = await temporaryDirectory(t);
  await writeFile(join(cwd, 'file.txt'), 'before\n', 'utf8');
  const filesystem = localFilesystem();

  const result = await filesystem.applyPatch({
    cwd,
    operation: {
      type: 'update_file',
      path: 'file.txt',
      diff: '@@\n-before\n+after\n',
    },
  });

  assert.deepEqual(result, { status: 'completed' });
  assert.equal(await readFile(join(cwd, 'file.txt'), 'utf8'), 'after\n');
});

test('deletes a self-referential symlink entry without following it', {
  skip: process.platform === 'win32',
}, async (t) => {
  const cwd = await temporaryDirectory(t);
  const link = join(cwd, 'loop');
  await symlink('loop', link);
  const filesystem = localFilesystem();

  assert.deepEqual(
    await filesystem.applyPatch({
      cwd,
      operation: { type: 'delete_file', path: 'loop' },
    }),
    { status: 'completed' },
  );
  await assert.rejects(readFile(link, 'utf8'), { code: 'ENOENT' });
});

test('creates nested files exclusively', async (t) => {
  const cwd = await temporaryDirectory(t);
  await writeFile(join(cwd, 'existing.txt'), 'keep\n', 'utf8');
  const filesystem = localFilesystem();

  assert.deepEqual(
    await filesystem.applyPatch({
      cwd,
      operation: { type: 'create_file', path: 'nested/file.txt', diff: '+created\n' },
    }),
    { status: 'completed' },
  );
  assert.equal(await readFile(join(cwd, 'nested/file.txt'), 'utf8'), 'created');

  await assert.rejects(
    filesystem.applyPatch({
      cwd,
      operation: { type: 'create_file', path: 'existing.txt', diff: '+replacement\n' },
    }),
  );
  assert.equal(await readFile(join(cwd, 'existing.txt'), 'utf8'), 'keep\n');
});

test('does not report an invalid backend result as completed', async (t) => {
  const cwd = await temporaryDirectory(t);
  await writeFile(join(cwd, 'file.txt'), 'before\n', 'utf8');
  const filesystem = createBoundaryFilesystemExecutor({
    workspace: createLocalWorkspaceExecutor(),
    worker: {
      execute: async () => ({ kind: 'read', content: 'wrong operation' }),
    },
  });

  await assert.rejects(
    filesystem.applyPatch({
      cwd,
      operation: {
        type: 'update_file',
        path: 'file.txt',
        diff: '@@\n-before\n+after\n',
      },
    }),
    /backend returned/,
  );
  assert.equal(await readFile(join(cwd, 'file.txt'), 'utf8'), 'before\n');
});

test('reports a rejected diff without changing the file', async (t) => {
  const cwd = await temporaryDirectory(t);
  await writeFile(join(cwd, 'file.txt'), 'before\n', 'utf8');
  const filesystem = localFilesystem();

  await assert.rejects(
    filesystem.applyPatch({
      cwd,
      operation: {
        type: 'update_file',
        path: 'file.txt',
        diff: '@@\n-missing\n+after\n',
      },
    }),
    /context|missing|match|find/i,
  );
  assert.equal(await readFile(join(cwd, 'file.txt'), 'utf8'), 'before\n');
});

test('reports missing mutation targets as rejected operations', async (t) => {
  const cwd = await temporaryDirectory(t);
  const filesystem = localFilesystem();

  for (const operation of [
    { type: 'update_file' as const, path: 'missing.txt', diff: '@@\n-old\n+new\n' },
    { type: 'delete_file' as const, path: 'missing.txt' },
  ]) {
    await assert.rejects(filesystem.applyPatch({ cwd, operation }), { code: 'ENOENT' });
  }
});

async function temporaryDirectory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'maka-native-apply-patch-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function localFilesystem() {
  return createBoundaryFilesystemExecutor({ workspace: createLocalWorkspaceExecutor() });
}
