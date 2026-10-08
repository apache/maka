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
import { mkdir, mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  createManagedTaskDirectoryAuthority,
} from '../managed-task-directory.js';

test('allocates a fresh task directory under the managed root', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-task-dir-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'tasks');
  const authority = createManagedTaskDirectoryAuthority({ root });

  const directory = await authority.allocate();

  assert.equal(dirname(directory), await realpath(root));
  assert.match(basename(directory), /^task-/u);
  assert.ok((await stat(directory)).isDirectory());
});

test('allocations never share a directory', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-task-dir-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const authority = createManagedTaskDirectoryAuthority({ root: join(base, 'tasks') });

  const [first, second] = await Promise.all([authority.allocate(), authority.allocate()]);

  assert.notEqual(first, second);
});

test('refuses a symlinked managed root', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-task-dir-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const real = join(base, 'real');
  await mkdir(real);
  await symlink(real, join(base, 'tasks'), process.platform === 'win32' ? 'junction' : 'dir');
  const authority = createManagedTaskDirectoryAuthority({ root: join(base, 'tasks') });

  await assert.rejects(() => authority.allocate(), /managed task directory/i);
});

test('refuses a managed root redirected into a reserved location', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-task-dir-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const reserved = join(base, 'userdata');
  const parent = join(base, 'link-parent');
  await mkdir(reserved, { recursive: true });
  await mkdir(parent);
  await symlink(reserved, join(parent, 'Maka'), process.platform === 'win32' ? 'junction' : 'dir');
  const authority = createManagedTaskDirectoryAuthority({
    root: join(parent, 'Maka', 'tasks'),
    reservedRoots: [reserved],
  });

  await assert.rejects(() => authority.allocate(), /managed task directory/i);
});

test('refuses a managed root owned by another user', { skip: process.platform === 'win32' }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-task-dir-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const authority = createManagedTaskDirectoryAuthority({
    root: join(base, 'tasks'),
    ownerUid: () => Number.MAX_SAFE_INTEGER,
  });

  await assert.rejects(() => authority.allocate(), /managed task directory/i);
});

test('classifies managed, suspicious, and other bindings', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-task-dir-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const reserved = join(base, 'userdata');
  const root = join(base, 'Maka', 'tasks');
  const authority = createManagedTaskDirectoryAuthority({
    root,
    reservedRoots: [reserved],
  });

  const managed = await authority.allocate();
  assert.equal(await authority.classify(managed), 'managed');
  assert.equal(await authority.classify(join(reserved, 'deep', 'dir')), 'suspicious');
  assert.equal(await authority.classify('/'), 'suspicious');
  assert.equal(await authority.classify(join(base, 'elsewhere')), 'other');
});
