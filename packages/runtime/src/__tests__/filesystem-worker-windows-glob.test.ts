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
import { mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  executeFilesystemWorkerRequest,
  type FilesystemWorkerOperationDependencies,
} from '../filesystem-worker/operations.js';
import {
  FILESYSTEM_WORKER_PROTOCOL_VERSION,
  FilesystemWorkerResultSchema,
} from '../filesystem-worker/protocol.js';
import { globFiles } from '../glob-search.js';

// Portable operation tests, not AppContainer/NTFS evidence. The real Windows
// client/broker smoke suite separately owns the native permission boundary.
const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maka-windows-glob-contract-')));
  cleanup.push(root);
  return root;
}

async function run(
  root: string,
  pattern = '**/*.txt',
  limit?: number,
  readDirectory?: FilesystemWorkerOperationDependencies['windowsGlobReadDirectory'],
) {
  return await executeFilesystemWorkerRequest(
    {
      version: FILESYSTEM_WORKER_PROTOCOL_VERSION,
      requestId: 'windows-glob-contract',
      operation: { kind: 'glob', cwd: root, path: root, pattern, ...(limit ? { limit } : {}) },
      operationBoundary: {
        filesystem: { entries: [{ path: root, access: 'read', scope: 'subtree' }] },
      },
      expectedTarget: {
        enforcementPath: root,
        access: 'read',
        scope: 'subtree',
        targetType: 'directory',
        identity: 'unchecked',
      },
    },
    {
      windowsSandboxed: true,
      ...(readDirectory ? { windowsGlobReadDirectory: readDirectory } : {}),
    },
  );
}

for (const count of [0, 199, 200, 201]) {
  test(
    'Windows Glob reports completeness for ' + count + ' matches at the default cap',
    async () => {
      const root = await fixture();
      await Promise.all(
        Array.from({ length: count }, (_, index) =>
          writeFile(join(root, 'file-' + String(index).padStart(3, '0') + '.txt'), ''),
        ),
      );
      const response = await run(root);
      assert.equal(response.ok, true);
      if (!response.ok || response.result.kind !== 'glob') return;
      assert.equal(response.result.files.length, Math.min(count, 200));
      assert.equal(response.result.truncated, count > 200);
      assert.equal(new Set(response.result.files).size, response.result.files.length);
      assert.deepEqual(FilesystemWorkerResultSchema.parse(response.result), response.result);
    },
  );
}

test('Windows Glob counts distinct matches across overlapping branches', async () => {
  const root = await fixture();
  await writeFile(join(root, 'a.txt'), '');
  await writeFile(join(root, 'b.txt'), '');
  const exact = await run(root, '{*.txt,a.txt}', 2);
  assert.equal(exact.ok, true);
  if (!exact.ok || exact.result.kind !== 'glob') return;
  assert.deepEqual([...exact.result.files].sort(), ['a.txt', 'b.txt']);
  assert.equal(exact.result.truncated, false);
  const capped = await run(root, '{*.txt,a.txt}', 1);
  assert.equal(capped.ok, true);
  if (!capped.ok || capped.result.kind !== 'glob') return;
  assert.equal(capped.result.files.length, 1);
  assert.equal(capped.result.truncated, true);
});

for (const pattern of ['.', './.', '././.', '**/.', './**/.', '**/./.', 'visible/**/.']) {
  test('Windows Glob preserves current-directory matches for ' + pattern, async () => {
    const root = await fixture();
    await mkdir(join(root, 'visible', 'nested'), { recursive: true });
    await mkdir(join(root, '.hidden'));
    await writeFile(join(root, 'file.txt'), '');
    const expected = await globFiles({ cwd: root, pattern });
    const response = await run(root, pattern);
    assert.equal(response.ok, true);
    if (!response.ok || response.result.kind !== 'glob') return;
    assert.deepEqual([...response.result.files].sort(), [...expected.files].sort(), pattern);
    assert.equal(response.result.truncated, false);
    for (const limit of [1, expected.files.length]) {
      const capped = await run(root, pattern, limit);
      assert.equal(capped.ok, true);
      if (!capped.ok || capped.result.kind !== 'glob') return;
      assert.equal(capped.result.files.length, Math.min(limit, expected.files.length));
      assert.equal(capped.result.truncated, expected.files.length > limit);
    }
  });
}

test('Windows Glob does not let globstar consume hidden directories', async () => {
  const root = await fixture();
  const hidden = join(root, '.hidden');
  await mkdir(join(hidden, '.nested'), { recursive: true });
  const visited: string[] = [];
  const response = await run(root, '**/.*', 1, async (path) => {
    visited.push(path);
    return await readdir(path, { withFileTypes: true });
  });
  assert.equal(response.ok, true);
  if (!response.ok || response.result.kind !== 'glob') return;
  assert.deepEqual(response.result, { kind: 'glob', files: ['.hidden'], truncated: false });
  assert.deepEqual(visited, [root]);
});

test('Windows Glob preserves globstar component transitions against production Glob', async () => {
  const root = await fixture();
  for (const path of [
    ['.hidden', '.nested'],
    ['.hidden', 'visible', '.deep'],
    ['visible', '.hidden', '.nested'],
  ]) {
    await mkdir(join(root, ...path), { recursive: true });
  }
  await writeFile(join(root, '.hidden', 'visible', 'file.txt'), '');
  await writeFile(join(root, 'visible', 'file.txt'), '');
  await writeFile(join(root, 'file.txt'), '');
  for (const pattern of [
    '**/.*',
    './**/.*',
    '**/.*/**',
    '**/.*/.*',
    '**/.hidden/**',
    '**/.hidden/.*',
    '**/.hidden/**/.*',
    'file.txt/**',
    './file.txt/**',
    '**/file.txt/**',
    './**/file.txt/**',
  ]) {
    const expected = await globFiles({ cwd: root, pattern });
    const response = await run(root, pattern);
    assert.equal(response.ok, true);
    if (!response.ok || response.result.kind !== 'glob') return;
    assert.deepEqual([...response.result.files].sort(), [...expected.files].sort(), pattern);
    for (const limit of [1, Math.max(1, expected.files.length)]) {
      const capped = await run(root, pattern, limit);
      assert.equal(capped.ok, true);
      if (!capped.ok || capped.result.kind !== 'glob') return;
      assert.deepEqual(
        capped.result.files,
        response.result.files.slice(0, limit),
        `${pattern} limit=${limit}`,
      );
      assert.equal(capped.result.truncated, expected.files.length > limit);
    }
  }
});

for (const code of ['EACCES', 'EPERM', 'EIO', 'ENOENT', 'ENOTDIR', 'ELOOP']) {
  test('Windows Glob does not swallow an admitted subtree ' + code, async () => {
    const root = await fixture();
    const child = join(root, 'child');
    await mkdir(child);
    await writeFile(join(child, 'hidden.txt'), '');
    const response = await run(root, '**/*.txt', 200, async (path) => {
      if (path === child) throw Object.assign(new Error('injected ' + code), { code });
      return await readdir(path, { withFileTypes: true });
    });
    assert.equal(response.ok, false);
    if (response.ok) return;
    assert.equal(
      response.error.code,
      ['EACCES', 'EPERM'].includes(code)
        ? 'filesystem_denied'
        : ['ENOENT', 'ENOTDIR'].includes(code)
          ? 'not_found'
          : 'filesystem_error',
    );
    const restored = await run(root);
    assert.equal(restored.ok, true);
    if (!restored.ok || restored.result.kind !== 'glob') return;
    assert.equal(restored.result.files.length, 1);
    assert.equal(restored.result.truncated, false);
  });
}

for (const code of ['EACCES', 'ENOENT', 'EIO']) {
  test('Windows Glob reports an incomplete overflow probe after ' + code, async () => {
    const root = await fixture();
    const late = join(root, 'late');
    await mkdir(late);
    await writeFile(join(root, 'a.txt'), '');
    await writeFile(join(root, 'b.txt'), '');
    await writeFile(join(late, 'hidden.txt'), '');
    let injected = false;
    const response = await run(root, '**/*.txt', 2, async (path) => {
      if (path === late) {
        injected = true;
        throw Object.assign(new Error('injected ' + code), { code });
      }
      return await readdir(path, { withFileTypes: true });
    });
    assert.equal(injected, true, 'The probe must actually reach the failing subtree');
    assert.equal(response.ok, true);
    if (!response.ok || response.result.kind !== 'glob') return;
    assert.deepEqual([...response.result.files].sort(), ['a.txt', 'b.txt']);
    assert.equal(response.result.truncated, true);
  });
}

for (const replaceWithFile of [false, true]) {
  test(
    'Windows Glob reports an enumerated directory ' +
      (replaceWithFile ? 'changing type' : 'disappearing'),
    async () => {
      const root = await fixture();
      const child = join(root, 'queued');
      await mkdir(child);
      await writeFile(join(child, 'hidden.txt'), '');
      let changed = false;
      const response = await run(root, '**/*.txt', 200, async (path) => {
        const entries = await readdir(path, { withFileTypes: true });
        if (path === root && !changed) {
          changed = true;
          await rename(child, join(root, 'moved'));
          if (replaceWithFile) await writeFile(child, 'now a file');
        }
        return entries;
      });
      assert.equal(changed, true);
      assert.equal(response.ok, false);
    },
  );
}

test('Windows Glob preserves literal misses without visiting unrelated directories', async () => {
  const root = await fixture();
  const blocked = join(root, 'blocked');
  await mkdir(blocked);
  let entered = false;
  const response = await run(root, 'missing/*.txt', 200, async (path) => {
    if (path === blocked) {
      entered = true;
      throw Object.assign(new Error('unrelated denied directory'), { code: 'EACCES' });
    }
    return await readdir(path, { withFileTypes: true });
  });
  assert.equal(entered, false);
  assert.equal(response.ok, true);
  if (!response.ok || response.result.kind !== 'glob') return;
  assert.deepEqual(response.result, { kind: 'glob', files: [], truncated: false });
});

test('Windows Glob preserves production completeness for small custom caps', async () => {
  const root = await fixture();
  for (const name of ['a.txt', 'b.txt', 'c.txt']) await writeFile(join(root, name), '');
  for (const limit of [1, 2, 3, 4]) {
    const expected = await globFiles({ cwd: root, pattern: '*.txt', limit });
    const response = await run(root, '*.txt', limit);
    assert.equal(response.ok, true);
    if (!response.ok || response.result.kind !== 'glob') return;
    assert.equal(response.result.files.length, expected.files.length);
    assert.equal(response.result.truncated, expected.truncated);
  }
});
