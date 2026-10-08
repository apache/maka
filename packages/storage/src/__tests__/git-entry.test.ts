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
import fsPromises, {
  access,
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { hasEnclosingGitEntry } from '../git-entry.js';
import { createProjectCatalog, resolveProjectLocation } from '../project-catalog.js';
import {
  resolveWorkspaceIdentity,
  WORKSPACE_MARKER_FILE,
  WorkspaceIdentityError,
} from '../workspace-identity.js';
import {
  BROKEN_GIT_DIRECTORY_SHAPES,
  BROKEN_GIT_SHAPES,
  createBrokenGitMetadata,
  createGitRepositoryWithWorktree,
} from './fixtures/git-repository.js';

const execFileAsync = promisify(execFile);

for (const shape of BROKEN_GIT_SHAPES) {
  test(`own ${shape} metadata cannot be hidden by a valid outer repository`, async () => {
    const base = await mkdtemp(join(tmpdir(), 'maka-git-own-entry-'));
    const catalog = createProjectCatalog(join(base, 'state'));
    try {
      const repository = join(base, 'repository');
      const selected = join(repository, 'selected');
      await mkdir(selected, { recursive: true });
      await execFileAsync('git', ['init', '--quiet'], { cwd: repository });
      await createBrokenGitMetadata(selected, shape);

      await assert.rejects(resolveProjectLocation({ path: selected, intent: 'selected' }));
      await assert.rejects(catalog.register(selected));
      assert.deepEqual(await catalog.list(), []);
      await assert.rejects(resolveWorkspaceIdentity({ path: selected }), {
        code: 'workspace_io_failed',
      });
      await assert.rejects(access(join(selected, WORKSPACE_MARKER_FILE)), { code: 'ENOENT' });
    } finally {
      catalog.close();
      await rm(base, { recursive: true, force: true });
    }
  });
}

const permissionCases = [
  { name: 'HEAD', linked: false, target: 'HEAD', mode: 0o000, restore: 0o644 },
  { name: 'gitdir', linked: false, target: '', mode: 0o000, restore: 0o755 },
  { name: 'objects traversal', linked: false, target: 'objects', mode: 0o444, restore: 0o755 },
  { name: 'refs traversal', linked: false, target: 'refs', mode: 0o444, restore: 0o755 },
  { name: 'commondir', linked: true, target: 'commondir', mode: 0o000, restore: 0o644 },
  { name: 'shared objects', linked: true, target: 'objects', mode: 0o000, restore: 0o755 },
];

for (const fixture of permissionCases) {
  test(`inaccessible ${fixture.name} cannot downgrade identity or publish a marker`, {
    skip:
      process.platform === 'win32' || process.getuid?.() === 0
        ? 'Requires enforced POSIX permissions'
        : false,
  }, async () => {
    const base = await mkdtemp(join(tmpdir(), 'maka-git-permissions-'));
    const catalog = createProjectCatalog(join(base, 'state'));
    let restrictedPath: string | undefined;
    try {
      const repository = join(base, 'repository');
      const linked = join(base, 'linked');
      await createGitRepositoryWithWorktree(repository, linked, 'permissions');
      const root = fixture.linked ? linked : repository;
      const workspace = join(root, 'nested');
      await mkdir(workspace);
      const expected = await resolveProjectLocation({ path: workspace });
      const { stdout } = await execFileAsync('git', ['rev-parse', '--absolute-git-dir'], {
        cwd: root,
        encoding: 'utf8',
      });
      restrictedPath =
        fixture.target === 'objects'
          ? join(repository, '.git', 'objects')
          : join(stdout.trim(), fixture.target);
      await chmod(restrictedPath, fixture.mode);

      await assert.rejects(resolveProjectLocation({ path: workspace }));
      await assert.rejects(catalog.register(workspace));
      assert.deepEqual(await catalog.list(), []);
      await assert.rejects(
        resolveWorkspaceIdentity({ path: workspace }),
        (error: unknown) =>
          error instanceof WorkspaceIdentityError && error.code === 'workspace_io_failed',
      );
      await assert.rejects(access(join(workspace, WORKSPACE_MARKER_FILE)), { code: 'ENOENT' });

      await chmod(restrictedPath, fixture.restore);
      assert.deepEqual(await resolveProjectLocation({ path: workspace }), expected);
      await resolveWorkspaceIdentity({ path: workspace });
      await access(join(workspace, WORKSPACE_MARKER_FILE));
      const { stdout: status } = await execFileAsync(
        'git',
        ['status', '--porcelain=v1', '--untracked-files=all'],
        { cwd: root },
      );
      assert.equal(status, '');
    } finally {
      if (restrictedPath) await chmod(restrictedPath, fixture.restore);
      catalog.close();
      await rm(base, { recursive: true, force: true });
    }
  });
}

test('a dangling HEAD symlink is not evidence that HEAD is absent', {
  skip: process.platform === 'win32' ? 'Requires POSIX symlink support' : false,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-git-head-symlink-'));
  try {
    const workspace = join(base, 'workspace');
    await mkdir(workspace);
    await mkdir(join(base, '.git'));
    await symlink('missing-target', join(base, '.git', 'HEAD'));
    await assert.rejects(hasEnclosingGitEntry(workspace));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

for (const shape of BROKEN_GIT_DIRECTORY_SHAPES) {
  test(`ancestor ${shape} still discovers and excludes through an outer repository`, async () => {
    const base = await mkdtemp(join(tmpdir(), 'maka-git-outer-entry-'));
    const catalog = createProjectCatalog(join(base, 'state'));
    try {
      const repository = join(base, 'repository');
      const broken = join(repository, 'broken');
      const workspace = join(broken, 'workspace');
      await mkdir(workspace, { recursive: true });
      await execFileAsync('git', ['init', '--quiet'], { cwd: repository });
      await createBrokenGitMetadata(broken, shape);

      const resolved = await resolveProjectLocation({ path: workspace });
      assert.equal(resolved.kind, 'git');
      assert.equal(resolved.git?.worktreeRoot, await realpath(repository));
      // Explicit selection keeps folder identity, but Git still owns exclusion.
      const project = await catalog.register(workspace);
      assert.deepEqual(project.locations, [{ path: await realpath(workspace), isWorktree: false }]);
      await resolveWorkspaceIdentity({ path: workspace });
      const { stdout: ignored } = await execFileAsync(
        'git',
        ['check-ignore', WORKSPACE_MARKER_FILE],
        { cwd: workspace },
      );
      assert.equal(ignored.trim(), WORKSPACE_MARKER_FILE);
      const { stdout: status } = await execFileAsync(
        'git',
        ['status', '--porcelain=v1', '--untracked-files=all'],
        { cwd: repository },
      );
      assert.equal(status, '');
    } finally {
      catalog.close();
      await rm(base, { recursive: true, force: true });
    }
  });
}

for (const shape of ['gitfile-garbage-head', 'gitdir-symlink', 'commondir'] as const) {
  test(`failed ancestor ${shape} is not treated as an ordinary broken directory`, {
    skip: shape === 'gitdir-symlink' && process.platform === 'win32',
  }, async () => {
    const base = await mkdtemp(join(tmpdir(), 'maka-git-indirect-entry-'));
    const catalog = createProjectCatalog(join(base, 'state'));
    try {
      const workspace = join(base, 'workspace');
      await mkdir(workspace);
      if (shape === 'gitfile-garbage-head') {
        await createBrokenGitMetadata(base, shape);
      } else if (shape === 'gitdir-symlink') {
        const target = join(base, 'metadata');
        await mkdir(target);
        await symlink(target, join(base, '.git'));
      } else {
        await createBrokenGitMetadata(base, 'head-garbage');
        await writeFile(join(base, '.git', 'commondir'), '../shared\n');
      }
      await assert.rejects(resolveProjectLocation({ path: workspace }));
      await assert.rejects(catalog.register(workspace));
      assert.deepEqual(await catalog.list(), []);
      await assert.rejects(resolveWorkspaceIdentity({ path: workspace }), {
        code: 'workspace_io_failed',
      });
      await assert.rejects(access(join(workspace, WORKSPACE_MARKER_FILE)), { code: 'ENOENT' });
    } finally {
      catalog.close();
      await rm(base, { recursive: true, force: true });
    }
  });
}

test('a HEAD read failure is not a format verdict even when access checks succeed', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-git-read-failure-'));
  const originalOpen = fsPromises.open;
  try {
    const workspace = join(base, 'workspace');
    const head = join(base, '.git', 'HEAD');
    await mkdir(workspace);
    await createBrokenGitMetadata(base, 'head-garbage');
    const failure = Object.assign(new Error('Injected HEAD read failure'), { code: 'EIO' });
    t.mock.method(fsPromises, 'open', async (path: string, flags: number) => {
      const file = await originalOpen(path, flags);
      if (path === head) {
        t.mock.method(file, 'read', async () => {
          throw failure;
        });
      }
      return file;
    });
    syncBuiltinESMExports();
    await assert.rejects(hasEnclosingGitEntry(workspace), (error: unknown) => error === failure);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(base, { recursive: true, force: true });
  }
});

test('metadata changed during validation cannot inherit an earlier rejection', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-git-changing-head-'));
  const originalStat = fsPromises.lstat;
  try {
    const workspace = join(base, 'workspace');
    const head = join(base, '.git', 'HEAD');
    await mkdir(workspace);
    await createBrokenGitMetadata(base, 'head-garbage');
    let observations = 0;
    t.mock.method(fsPromises, 'lstat', async (path: string) => {
      if (path === head && ++observations === 2) {
        await writeFile(head, 'ref: refs/heads/repaired\n');
      }
      return originalStat(path);
    });
    syncBuiltinESMExports();
    await assert.rejects(hasEnclosingGitEntry(workspace), /Git metadata changed during discovery/);
    assert.equal(observations, 2);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(base, { recursive: true, force: true });
  }
});

test('an object-directory override cannot be mistaken for local metadata corruption', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-git-object-override-'));
  try {
    const workspace = join(base, 'workspace');
    await mkdir(workspace);
    await execFileAsync('git', ['init', '--quiet'], { cwd: base });
    const moduleUrl = new URL('../git-entry.js', import.meta.url).href;
    await execFileAsync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import assert from 'node:assert/strict';
         import { hasEnclosingGitEntry } from ${JSON.stringify(moduleUrl)};
         await assert.rejects(hasEnclosingGitEntry(${JSON.stringify(workspace)}));`,
      ],
      { env: { ...process.env, GIT_OBJECT_DIRECTORY: join(base, 'missing-objects') } },
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
