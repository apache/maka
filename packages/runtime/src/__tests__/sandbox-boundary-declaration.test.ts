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
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { preflightDeclaredSandboxBoundary } from '../sandbox-boundary-declaration.js';
import { SandboxCommandError } from '../sandbox/errors.js';
import type { MakaToolContext } from '../tool-runtime.js';

describe('declared Bash sandbox boundary error classification', () => {
  test('maps a model-correctable boundary semantic error to invalid_boundary_declaration', async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), 'maka-boundary-declaration-'));
    try {
      await assert.rejects(
        preflightDeclaredSandboxBoundary(
          {
            filesystem: {
              entries: [{ path: cwd, access: 'read', scope: 'exact' }],
            },
          },
          toolContext(cwd),
        ),
        (error: unknown) =>
          error instanceof SandboxCommandError &&
          error.reason === 'invalid_boundary_declaration' &&
          /exact sandbox boundary cannot target a directory/.test(error.message),
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test('preserves an injected filesystem failure instead of calling the declaration invalid', async (t) => {
    const injected = Object.assign(new Error('realpath unavailable'), { code: 'EACCES' });
    t.mock.method(fs, 'realpath', async () => {
      throw injected;
    });

    await assert.rejects(
      preflightDeclaredSandboxBoundary(
        {
          filesystem: {
            entries: [{ path: '/workspace/file.txt', access: 'read', scope: 'exact' }],
          },
        },
        toolContext('/workspace'),
      ),
      (error: unknown) => error === injected && !(error instanceof SandboxCommandError),
    );
  });
});

function toolContext(cwd: string): MakaToolContext {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolCallId: 'tool-1',
    cwd,
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
}

describe('linked worktree boundary normalization', () => {
  test('widens a read subtree on a worktree admin dir to the shared git dir', async () => {
    const repo = await linkedWorktreeRepository('../..');
    try {
      const result = await preflightDeclaredSandboxBoundary(
        {
          filesystem: {
            entries: [{ path: repo.adminDir, access: 'read', scope: 'subtree' }],
          },
        },
        toolContext(repo.worktreeDir),
      );

      assert.deepEqual(result?.filesystem?.entries, [
        { path: await fs.realpath(join(repo.root, '.git')), access: 'read', scope: 'subtree' },
      ]);
    } finally {
      await fs.rm(repo.root, { recursive: true, force: true });
    }
  });

  test('leaves a write subtree on the same admin dir exactly as requested', async () => {
    const repo = await linkedWorktreeRepository('../..');
    try {
      const result = await preflightDeclaredSandboxBoundary(
        {
          filesystem: {
            entries: [{ path: repo.adminDir, access: 'write', scope: 'subtree' }],
          },
        },
        toolContext(repo.worktreeDir),
      );

      assert.deepEqual(result?.filesystem?.entries, [
        { path: await fs.realpath(repo.adminDir), access: 'write', scope: 'subtree' },
      ]);
    } finally {
      await fs.rm(repo.root, { recursive: true, force: true });
    }
  });

  test('does not touch a read subtree that has no commondir pointer', async () => {
    const repo = await linkedWorktreeRepository('../..');
    try {
      const result = await preflightDeclaredSandboxBoundary(
        {
          filesystem: {
            entries: [{ path: join(repo.root, 'source'), access: 'read', scope: 'subtree' }],
          },
        },
        toolContext(repo.worktreeDir),
      );

      assert.deepEqual(result?.filesystem?.entries, [
        { path: await fs.realpath(join(repo.root, 'source')), access: 'read', scope: 'subtree' },
      ]);
    } finally {
      await fs.rm(repo.root, { recursive: true, force: true });
    }
  });

  test('refuses to follow a commondir that is not a git common directory', async () => {
    // The pointer is repository-controlled text, so a worktree planted by someone else must not be
    // able to turn one read approval into access to an unrelated directory.
    const repo = await linkedWorktreeRepository('ignored');
    const secrets = join(repo.root, 'secrets');
    await fs.mkdir(secrets, { recursive: true });
    await fs.writeFile(join(secrets, 'id_ed25519'), 'private\n');
    await fs.writeFile(join(repo.adminDir, 'commondir'), `${await fs.realpath(secrets)}\n`);
    try {
      const result = await preflightDeclaredSandboxBoundary(
        {
          filesystem: {
            entries: [{ path: repo.adminDir, access: 'read', scope: 'subtree' }],
          },
        },
        toolContext(repo.worktreeDir),
      );

      assert.deepEqual(result?.filesystem?.entries, [
        { path: await fs.realpath(repo.adminDir), access: 'read', scope: 'subtree' },
      ]);
      const realSecrets = await fs.realpath(secrets);
      assert.ok(!JSON.stringify(result).includes(realSecrets));
    } finally {
      await fs.rm(repo.root, { recursive: true, force: true });
    }
  });

  test('follows an absolute commondir that really owns the admin directory', async () => {
    const commonDir = await fs.mkdtemp(join(tmpdir(), 'maka-boundary-common-dir-'));
    await fs.mkdir(join(commonDir, 'objects'), { recursive: true });
    await fs.mkdir(join(commonDir, 'refs'), { recursive: true });
    const repo = await worktreeAdminInsideCommonDir(commonDir);
    try {
      const result = await preflightDeclaredSandboxBoundary(
        {
          filesystem: {
            entries: [{ path: repo.adminDir, access: 'read', scope: 'subtree' }],
          },
        },
        toolContext(repo.worktreeDir),
      );

      assert.deepEqual(result?.filesystem?.entries, [
        { path: await fs.realpath(commonDir), access: 'read', scope: 'subtree' },
      ]);
    } finally {
      await fs.rm(repo.root, { recursive: true, force: true });
      await fs.rm(commonDir, { recursive: true, force: true });
    }
  });

  test('refuses an absolute pointer to a directory that only looks like a common directory', async () => {
    // A temp directory holding objects/ and refs/ is still not this repository's shared directory:
    // the admin path the caller declared does not live inside it.
    const commonDir = await fs.mkdtemp(join(tmpdir(), 'maka-boundary-look-alike-'));
    await fs.mkdir(join(commonDir, 'objects'), { recursive: true });
    await fs.mkdir(join(commonDir, 'refs'), { recursive: true });
    const repo = await linkedWorktreeRepository(await fs.realpath(commonDir));
    try {
      const result = await preflightDeclaredSandboxBoundary(
        {
          filesystem: {
            entries: [{ path: repo.adminDir, access: 'read', scope: 'subtree' }],
          },
        },
        toolContext(repo.worktreeDir),
      );

      assert.deepEqual(result?.filesystem?.entries, [
        { path: await fs.realpath(repo.adminDir), access: 'read', scope: 'subtree' },
      ]);
      assert.ok(!JSON.stringify(result).includes(await fs.realpath(commonDir)));
    } finally {
      await fs.rm(repo.root, { recursive: true, force: true });
      await fs.rm(commonDir, { recursive: true, force: true });
    }
  });

  test('refuses an ancestor that looks like a common directory', async () => {
    const repo = await linkedWorktreeRepository('../../..');
    await fs.mkdir(join(repo.root, 'objects'), { recursive: true });
    await fs.mkdir(join(repo.root, 'refs'), { recursive: true });
    try {
      const result = await preflightDeclaredSandboxBoundary(
        {
          filesystem: {
            entries: [{ path: repo.adminDir, access: 'read', scope: 'subtree' }],
          },
        },
        toolContext(repo.worktreeDir),
      );

      assert.deepEqual(result?.filesystem?.entries, [
        { path: await fs.realpath(repo.adminDir), access: 'read', scope: 'subtree' },
      ]);
    } finally {
      await fs.rm(repo.root, { recursive: true, force: true });
    }
  });

  test('refuses a commondir pointer that is a symlink', async () => {
    // The pointer has to be the marker itself: a symlink is repository text, not proof that this
    // worktree keeps a commondir.
    const repo = await linkedWorktreeRepository('ignored');
    const realPointer = join(repo.root, 'stashed-commondir');
    await fs.writeFile(realPointer, '../..\n');
    await fs.rm(join(repo.adminDir, 'commondir'));
    await fs.symlink(await fs.realpath(realPointer), join(repo.adminDir, 'commondir'));
    try {
      const result = await preflightDeclaredSandboxBoundary(
        {
          filesystem: {
            entries: [{ path: repo.adminDir, access: 'read', scope: 'subtree' }],
          },
        },
        toolContext(repo.worktreeDir),
      );

      assert.deepEqual(result?.filesystem?.entries, [
        { path: await fs.realpath(repo.adminDir), access: 'read', scope: 'subtree' },
      ]);
    } finally {
      await fs.rm(repo.root, { recursive: true, force: true });
    }
  });

  test('refuses a candidate whose refs entry is a plain file', async () => {
    const fake = await fs.mkdtemp(join(tmpdir(), 'maka-boundary-file-refs-'));
    await fs.mkdir(join(fake, 'objects'), { recursive: true });
    await fs.writeFile(join(fake, 'refs'), 'not-a-directory\n');
    const repo = await worktreeAdminInsideCommonDir(fake);
    try {
      const result = await preflightDeclaredSandboxBoundary(
        {
          filesystem: {
            entries: [{ path: repo.adminDir, access: 'read', scope: 'subtree' }],
          },
        },
        toolContext(repo.worktreeDir),
      );

      assert.deepEqual(result?.filesystem?.entries, [
        { path: await fs.realpath(repo.adminDir), access: 'read', scope: 'subtree' },
      ]);
      assert.ok(!JSON.stringify(result).includes(await fs.realpath(fake)));
    } finally {
      await fs.rm(repo.root, { recursive: true, force: true });
      await fs.rm(fake, { recursive: true, force: true });
    }
  });

  test('refuses a candidate whose objects entry is a symlink', async () => {
    const fake = await fs.mkdtemp(join(tmpdir(), 'maka-boundary-linked-objects-'));
    const outside = await fs.mkdtemp(join(tmpdir(), 'maka-boundary-outside-'));
    await fs.mkdir(join(fake, 'refs'), { recursive: true });
    await fs.symlink(await fs.realpath(outside), join(fake, 'objects'));
    const repo = await worktreeAdminInsideCommonDir(fake);
    try {
      const result = await preflightDeclaredSandboxBoundary(
        {
          filesystem: {
            entries: [{ path: repo.adminDir, access: 'read', scope: 'subtree' }],
          },
        },
        toolContext(repo.worktreeDir),
      );

      assert.deepEqual(result?.filesystem?.entries, [
        { path: await fs.realpath(repo.adminDir), access: 'read', scope: 'subtree' },
      ]);
      assert.ok(!JSON.stringify(result).includes(await fs.realpath(outside)));
    } finally {
      await fs.rm(repo.root, { recursive: true, force: true });
      await fs.rm(fake, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

/**
 * Builds `<root>/source` (a linked worktree whose `.git` file points at the admin directory),
 * `<root>/.git` as the shared directory, and `<root>/.git/worktrees/wt` holding the `commondir`
 * pointer under test. Hand-assembled so the fixture does not depend on the git binary.
 */
async function linkedWorktreeRepository(commonDirPointer: string): Promise<{
  readonly root: string;
  readonly worktreeDir: string;
  readonly adminDir: string;
}> {
  const root = await fs.mkdtemp(join(tmpdir(), 'maka-boundary-worktree-'));
  const worktreeDir = join(root, 'source');
  const adminDir = join(root, '.git', 'worktrees', 'wt');
  await fs.mkdir(join(root, '.git', 'objects'), { recursive: true });
  await fs.mkdir(join(root, '.git', 'refs'), { recursive: true });
  await fs.writeFile(join(root, '.git', 'config'), '[core]\n');
  await fs.mkdir(adminDir, { recursive: true });
  await fs.writeFile(join(adminDir, 'commondir'), `${commonDirPointer}\n`);
  await fs.writeFile(join(adminDir, 'HEAD'), 'ref: refs/heads/boundary-repro\n');
  await fs.mkdir(worktreeDir, { recursive: true });
  await fs.writeFile(join(worktreeDir, '.git'), `gitdir: ${adminDir}\n`);
  return { root, worktreeDir, adminDir };
}

/**
 * Same layout, except the admin directory really does live at `<commonDir>/worktrees/wt`, so an
 * absolute `commondir` pointer naming `commonDir` is the true answer rather than a planted one. The
 * caller creates `objects/` and `refs/` first, so a case can break exactly one of them.
 */
async function worktreeAdminInsideCommonDir(commonDir: string): Promise<{
  readonly root: string;
  readonly worktreeDir: string;
  readonly adminDir: string;
}> {
  const root = await fs.mkdtemp(join(tmpdir(), 'maka-boundary-external-'));
  const worktreeDir = join(root, 'source');
  const adminDir = join(commonDir, 'worktrees', 'wt');
  await fs.mkdir(adminDir, { recursive: true });
  await fs.writeFile(join(adminDir, 'commondir'), `${await fs.realpath(commonDir)}\n`);
  await fs.writeFile(join(adminDir, 'HEAD'), 'ref: refs/heads/boundary-repro\n');
  await fs.mkdir(worktreeDir, { recursive: true });
  await fs.writeFile(join(worktreeDir, '.git'), `gitdir: ${adminDir}\n`);
  return { root, worktreeDir, adminDir };
}
