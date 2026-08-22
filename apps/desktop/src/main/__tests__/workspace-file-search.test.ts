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

import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ExecFileException } from 'node:child_process';
import { searchWorkspaceFiles } from '../workspace-file-search.js';

type ExecFileCallback = (
  file: string,
  args: readonly string[],
  options: { cwd: string; timeout: number; windowsHide: boolean; maxBuffer: number },
  cb: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => void;

/** Fake `git ls-files` returning a fixed newline-joined path list. */
function fakeGit(stdout: string, error: ExecFileException | null = null): ExecFileCallback {
  return (_file, args, _options, cb) => {
    assert.deepEqual(args, ['ls-files', '--cached', '--others', '--exclude-standard']);
    cb(error, stdout, '');
  };
}

async function withGitRepo(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-wfs-git-'));
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withPlainDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-wfs-plain-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('searchWorkspaceFiles', () => {
  it('filters with AND-of-substring tokens, case-insensitively', async () => {
    await withGitRepo(async (root) => {
      const execFileImpl = fakeGit('src/app.tsx\nsrc/main.tsx\ndocs/app.md\n');
      const result = await searchWorkspaceFiles(root, { query: 'SRC app', execFileImpl });
      assert.ok(result.ok);
      const paths = result.ok ? result.files.map((f) => f.relativePath) : [];
      assert.deepEqual(paths, ['src/app.tsx']);
    });
  });

  it('ranks shorter paths first, then lexicographically', async () => {
    await withGitRepo(async (root) => {
      const execFileImpl = fakeGit('a/b/c/app.tsx\napp.tsx\nlib/app.tsx\n');
      const result = await searchWorkspaceFiles(root, { query: 'app', execFileImpl });
      assert.ok(result.ok);
      const paths = result.ok ? result.files.map((f) => f.relativePath) : [];
      assert.deepEqual(paths, ['app.tsx', 'lib/app.tsx', 'a/b/c/app.tsx']);
    });
  });

  it('caps the result count at the requested limit', async () => {
    await withGitRepo(async (root) => {
      const many = Array.from({ length: 200 }, (_v, i) => `file-${i}.ts`).join('\n');
      const execFileImpl = fakeGit(many);
      const result = await searchWorkspaceFiles(root, { query: '', limit: 5, execFileImpl });
      assert.ok(result.ok);
      assert.equal(result.ok ? result.files.length : -1, 5);
    });
  });

  it('falls back to a readdir walk when the tree is not a git repo', async () => {
    await withPlainDir(async (root) => {
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'src', 'index.ts'), '', 'utf8');
      await writeFile(join(root, 'top.md'), '', 'utf8');
      // Should be skipped by the walk.
      await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
      await writeFile(join(root, 'node_modules', 'pkg', 'ignored.js'), '', 'utf8');

      const result = await searchWorkspaceFiles(root, { query: '' });
      assert.ok(result.ok);
      const paths = result.ok ? result.files.map((f) => f.relativePath) : [];
      assert.ok(paths.includes('src/index.ts'));
      assert.ok(paths.includes('top.md'));
      assert.ok(!paths.some((p) => p.includes('node_modules')), 'node_modules must be skipped');
    });
  });

  it('never returns paths outside the root and does not follow symlinked dirs', async () => {
    await withPlainDir(async (root) => {
      const outside = await mkdtemp(join(tmpdir(), 'maka-wfs-outside-'));
      try {
        await writeFile(join(outside, 'secret.txt'), '', 'utf8');
        await writeFile(join(root, 'inside.txt'), '', 'utf8');
        try {
          await symlink(outside, join(root, 'link'), 'dir');
        } catch {
          // Some sandboxes disallow symlinks — the containment assertion below
          // still holds for the real files.
        }
        const result = await searchWorkspaceFiles(root, { query: '' });
        assert.ok(result.ok);
        const paths = result.ok ? result.files.map((f) => f.relativePath) : [];
        assert.ok(paths.includes('inside.txt'));
        assert.ok(!paths.some((p) => p.includes('secret') || p.startsWith('..')), 'must not escape root via symlink');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('falls back to the walk when git ls-files errors', async () => {
    await withGitRepo(async (root) => {
      await writeFile(join(root, 'walked.ts'), '', 'utf8');
      const failing: ExecFileCallback = (_f, _a, _o, cb) => {
        const err = new Error('boom') as ExecFileException;
        cb(err, '', 'fatal');
      };
      const result = await searchWorkspaceFiles(root, { query: 'walked', execFileImpl: failing });
      assert.ok(result.ok);
      assert.ok(result.ok && result.files.some((f) => f.relativePath === 'walked.ts'));
    });
  });

});
