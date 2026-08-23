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
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HostProjectDirectoryAuthority } from '../server/project-directory-authority.js';

test('Project directory authority exposes folders without crossing its published root', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-directory-'));
  const home = join(base, 'home');
  const project = join(home, 'work', 'project');
  const hidden = join(home, '.hidden');
  const doubleDot = join(home, '..project');
  const tripleDot = join(home, '...cache');
  const outside = join(base, 'outside');
  const shared = join(outside, 'shared');
  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(hidden, { recursive: true }),
    mkdir(doubleDot, { recursive: true }),
    mkdir(tripleDot, { recursive: true }),
    mkdir(shared, { recursive: true }),
  ]);
  await symlink(outside, join(home, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const authority = new HostProjectDirectoryAuthority([
    { label: 'Home', path: home },
    { label: 'Shared', path: outside },
  ]);

  try {
    const roots = await authority.query({ kind: 'directory_roots' });
    assert.equal(roots.kind, 'directory_roots');
    assert.deepEqual(
      roots.roots.map((root) => root.label),
      ['Home', 'Shared'],
    );
    const rootIds = roots.roots.map((root) => root.id);
    assert.ok(rootIds.every((id) => id.length > 0));
    assert.equal(new Set(rootIds).size, rootIds.length);
    const homeRoot = roots.roots[0];
    const sharedRoot = roots.roots[1];
    assert.ok(homeRoot && sharedRoot);
    assert.deepEqual(
      await authority.query({
        kind: 'directory_list_start',
        rootId: homeRoot.id,
        segments: [],
      }),
      {
        kind: 'directory_page',
        rootId: homeRoot.id,
        segments: [],
        entries: [
          { name: '...cache' },
          { name: '..project' },
          { name: '.hidden' },
          { name: 'work' },
        ],
        nextCursor: null,
      },
    );
    assert.equal(
      (
        await authority.resolveRegistration({
          rootId: homeRoot.id,
          segments: ['work', 'project'],
        })
      ).path,
      await realpath(project),
    );
    assert.equal(
      (
        await authority.resolveRegistration({
          rootId: sharedRoot.id,
          segments: ['shared'],
        })
      ).path,
      await realpath(shared),
    );
    await assert.rejects(
      () => authority.resolveRegistration({ rootId: homeRoot.id, segments: ['escape'] }),
      TypeError,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('Project directory authority can publish no roots without disabling the Host', async () => {
  const authority = new HostProjectDirectoryAuthority([]);
  assert.deepEqual(await authority.query({ kind: 'directory_roots' }), {
    kind: 'directory_roots',
    roots: [],
  });
});

test('Project directory continuation returns each contained folder once', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-directory-page-'));
  const root = join(base, 'root');
  const names = Array.from(
    { length: 130 },
    (_, index) => `folder-${String(index).padStart(3, '0')}`,
  );
  await Promise.all(names.map((name) => mkdir(join(root, name), { recursive: true })));
  const authority = new HostProjectDirectoryAuthority([{ label: 'Root', path: root }]);

  try {
    const roots = await authority.query({ kind: 'directory_roots' });
    assert.equal(roots.kind, 'directory_roots');
    const rootId = roots.roots[0]?.id;
    assert.ok(rootId);
    const first = await authority.query({
      kind: 'directory_list_start',
      rootId,
      segments: [],
    });
    assert.equal(first.kind, 'directory_page');
    assert.ok(first.nextCursor);
    const second = await authority.query({
      kind: 'directory_list_continue',
      rootId,
      segments: [],
      cursor: first.nextCursor,
    });
    assert.equal(second.kind, 'directory_page');
    assert.equal(second.nextCursor, null);
    assert.deepEqual(
      [...first.entries, ...second.entries].map((entry) => entry.name),
      names,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
