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
import {
  createBoundaryFilesystemExecutor,
  type FilesystemWorkspaceExecutor,
} from '../filesystem-executor.js';
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
      execute: async () => ({
        kind: 'read',
        content: 'wrong operation',
        offset: 0,
        returnedLines: 1,
        totalLines: 1,
        next: null,
      }),
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

test('a failed pinned read fails update with a read error, not a patch rejection', async (t) => {
  const cwd = await temporaryDirectory(t);
  await writeFile(join(cwd, 'file.txt'), 'before\n', 'utf8');
  const filesystem = createBoundaryFilesystemExecutor({
    workspace: workspaceWithUnreadablePinnedTarget(),
  });

  // #6401: the pinned read failed (content: null), so the update never saw
  // any content. The operation must report the read failure — folding null
  // into '' made the patch look rejected against text that was never read.
  await assert.rejects(
    filesystem.applyPatch({
      cwd,
      operation: { type: 'update_file', path: 'file.txt', diff: '@@\n-before\n+after\n' },
    }),
    /could not read the current file contents/i,
  );
  assert.equal(await readFile(join(cwd, 'file.txt'), 'utf8'), 'before\n');
});

test('a failed pinned read fails Edit with a read error, not old_string-not-found', async (t) => {
  const cwd = await temporaryDirectory(t);
  await writeFile(join(cwd, 'file.txt'), 'before\n', 'utf8');
  const filesystem = createBoundaryFilesystemExecutor({
    workspace: workspaceWithUnreadablePinnedTarget(),
  });

  // #6401: with the read folded to '', Edit reported "old_string not found",
  // inviting the documented-but-wrong recovery of Writing over the whole
  // unread file. It must fail with the read error instead.
  await assert.rejects(
    filesystem.execute({
      cwd,
      operation: { kind: 'edit', path: 'file.txt', oldString: 'before', newString: 'after' },
    }),
    /could not read the current file contents/i,
  );
  assert.equal(await readFile(join(cwd, 'file.txt'), 'utf8'), 'before\n');
});

test('a failed pinned read fails FormatJson with a read error, not invalid JSON', async (t) => {
  const cwd = await temporaryDirectory(t);
  await writeFile(join(cwd, 'data.json'), '{"keep":true}\n', 'utf8');
  const filesystem = createBoundaryFilesystemExecutor({
    workspace: workspaceWithUnreadablePinnedTarget(),
  });

  // #6401: with the read folded to '', FormatJson resolved with
  // ok:false "invalid JSON" against content it never saw.
  await assert.rejects(
    filesystem.execute({
      cwd,
      operation: { kind: 'format_json', path: 'data.json', sortKeys: false },
    }),
    /could not read the current file contents/i,
  );
  assert.equal(await readFile(join(cwd, 'data.json'), 'utf8'), '{"keep":true}\n');
});

async function temporaryDirectory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'maka-native-apply-patch-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function localFilesystem() {
  return createBoundaryFilesystemExecutor({ workspace: createLocalWorkspaceExecutor() });
}

/**
 * A workspace whose pinned read-modify-write simulates a failed pinned read
 * (#6401): exactly what the local executor hands its transform when the
 * descriptor read cannot produce content (e.g. a write-only target whose
 * `r+` open was retried as `O_WRONLY` — file-stable-write.ts reports the
 * previous state as 'unknown' and the transform receives content: null).
 * Nothing may be written from a read that never happened.
 */
function workspaceWithUnreadablePinnedTarget(): FilesystemWorkspaceExecutor {
  const host = createLocalWorkspaceExecutor();
  const pinned = host.readModifyWrite;
  if (!pinned) {
    throw new Error('LocalWorkspaceExecutor must provide readModifyWrite');
  }
  return Object.assign(Object.create(host), {
    readModifyWrite: async (
      input: Parameters<typeof pinned>[0],
    ): Promise<Awaited<ReturnType<typeof pinned>>> => {
      const replacement = input.transform({ content: null, existed: true });
      if (replacement === null) {
        return { path: input.path, previous: 'unknown', finalContent: null, written: false };
      }
      throw new Error('the pinned read failed; refusing to write unread content');
    },
  });
}
