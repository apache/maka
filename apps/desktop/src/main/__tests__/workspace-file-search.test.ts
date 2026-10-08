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
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { ExecFileException } from 'node:child_process';
import {
  createWorkspaceFileSearcher,
  searchWorkspaceFiles,
} from '../workspace-file-search.js';

type ExecFileCallback = (
  file: string,
  args: readonly string[],
  options: { cwd: string; timeout: number; windowsHide: boolean; maxBuffer: number },
  cb: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => void;

/** Fake `git ls-files -z` returning a fixed NUL-delimited path list. */
function fakeGit(stdout: string, error: ExecFileException | null = null): ExecFileCallback {
  return (_file, args, _options, cb) => {
    assert.deepEqual(args, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
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
  it('reuses one workspace enumeration across consecutive queries', async () => {
    await withGitRepo(async (root) => {
      let enumerations = 0;
      const hundredThousandFiles = `${Array.from(
        { length: 100_000 },
        (_value, index) => `src/generated/file-${String(index).padStart(5, '0')}.ts`,
      ).join('\0')}\0`;
      const listed = fakeGit(hundredThousandFiles);
      const searcher = createWorkspaceFileSearcher({
        execFileImpl(file, args, options, callback) {
          enumerations += 1;
          listed(file, args, options, callback);
        },
      });

      for (const query of Array.from(
        { length: 20 },
        (_value, index) => `file-${String(index).padStart(5, '0')}`,
      )) {
        const result = await searcher.search(root, { query });
        assert.ok(result.ok);
        assert.equal(result.ok ? result.files.length : 0, 1);
      }

      assert.equal(enumerations, 1);
    });
  });

  it('shares an in-flight enumeration between concurrent queries', async () => {
    await withGitRepo(async (root) => {
      let enumerations = 0;
      let finishEnumeration!: () => void;
      const enumerationReady = new Promise<void>((resolve) => {
        finishEnumeration = resolve;
      });
      const searcher = createWorkspaceFileSearcher({
        canonicalizeRoot: async (projectRoot) => projectRoot,
        execFileImpl(_file, _args, _options, callback) {
          enumerations += 1;
          void enumerationReady.then(() => callback(null, 'src/app.tsx\0docs/readme.md\0', ''));
        },
      });

      const sourceSearch = searcher.search(root, { query: 'src' });
      const docsSearch = searcher.search(root, { query: 'docs' });
      while (enumerations === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.equal(enumerations, 1);

      finishEnumeration();
      const [sourceResult, docsResult] = await Promise.all([sourceSearch, docsSearch]);
      assert.deepEqual(sourceResult, {
        ok: true,
        files: [{ relativePath: 'src/app.tsx' }],
      });
      assert.deepEqual(docsResult, {
        ok: true,
        files: [{ relativePath: 'docs/readme.md' }],
      });
    });
  });

  it('refreshes the workspace after the cache TTL expires', async () => {
    await withGitRepo(async (root) => {
      let now = 1_000;
      let enumerations = 0;
      const searcher = createWorkspaceFileSearcher({
        now: () => now,
        ttlMs: 100,
        execFileImpl(_file, _args, _options, callback) {
          enumerations += 1;
          const files = enumerations === 1
            ? 'src/app.tsx\0'
            : 'src/app.tsx\0src/new-file.ts\0';
          callback(null, files, '');
        },
      });

      assert.deepEqual(await searcher.search(root, { query: 'new-file' }), {
        ok: true,
        files: [],
      });
      now += 99;
      assert.deepEqual(await searcher.search(root, { query: 'new-file' }), {
        ok: true,
        files: [],
      });
      assert.equal(enumerations, 1);

      now += 1;
      assert.deepEqual(await searcher.search(root, { query: 'new-file' }), {
        ok: true,
        files: [{ relativePath: 'src/new-file.ts' }],
      });
      assert.equal(enumerations, 2);
    });
  });

  it('refreshes a non-git directory after the cache TTL expires', async () => {
    await withPlainDir(async (root) => {
      let now = 1_000;
      await writeFile(join(root, 'existing.ts'), '', 'utf8');
      const searcher = createWorkspaceFileSearcher({ now: () => now, ttlMs: 100 });

      await searcher.search(root);
      await writeFile(join(root, 'new-file.ts'), '', 'utf8');
      assert.deepEqual(await searcher.search(root, { query: 'new-file' }), {
        ok: true,
        files: [],
      });

      now += 100;
      assert.deepEqual(await searcher.search(root, { query: 'new-file' }), {
        ok: true,
        files: [{ relativePath: 'new-file.ts' }],
      });
    });
  });

  it('does not cache a fallback result after git enumeration fails', async () => {
    await withGitRepo(async (root) => {
      await writeFile(join(root, 'walked.ts'), '', 'utf8');
      let enumerations = 0;
      const searcher = createWorkspaceFileSearcher({
        execFileImpl(_file, _args, _options, callback) {
          enumerations += 1;
          if (enumerations === 1) {
            callback(new Error('temporary failure') as ExecFileException, '', 'fatal');
            return;
          }
          callback(null, 'from-git.ts\0', '');
        },
      });

      assert.deepEqual(await searcher.search(root, { query: 'walked' }), {
        ok: true,
        files: [{ relativePath: 'walked.ts' }],
      });
      assert.deepEqual(await searcher.search(root, { query: 'from-git' }), {
        ok: true,
        files: [{ relativePath: 'from-git.ts' }],
      });
      assert.equal(enumerations, 2);
    });
  });

  it('keeps cached file lists isolated by canonical project root', async () => {
    await withGitRepo(async (firstRoot) => {
      await withGitRepo(async (secondRoot) => {
        const enumerations = new Map<string, number>();
        const searcher = createWorkspaceFileSearcher({
          canonicalizeRoot: async (projectRoot) => projectRoot,
          execFileImpl(_file, _args, options, callback) {
            enumerations.set(options.cwd, (enumerations.get(options.cwd) ?? 0) + 1);
            callback(
              null,
              options.cwd === firstRoot ? 'first-only.ts\0' : 'second-only.ts\0',
              '',
            );
          },
        });

        assert.deepEqual(await searcher.search(firstRoot, { query: 'first' }), {
          ok: true,
          files: [{ relativePath: 'first-only.ts' }],
        });
        assert.deepEqual(await searcher.search(secondRoot, { query: 'second' }), {
          ok: true,
          files: [{ relativePath: 'second-only.ts' }],
        });
        assert.deepEqual(await searcher.search(firstRoot, { query: 'second' }), {
          ok: true,
          files: [],
        });
        assert.equal(enumerations.get(firstRoot), 1);
        assert.equal(enumerations.get(secondRoot), 1);
      });
    });
  });

  it('shares a cache entry for equivalent project-root paths', async () => {
    await withGitRepo(async (root) => {
      let enumerations = 0;
      let canonicalizations = 0;
      const searcher = createWorkspaceFileSearcher({
        async canonicalizeRoot(projectRoot) {
          canonicalizations += 1;
          return projectRoot;
        },
        execFileImpl(_file, _args, _options, callback) {
          enumerations += 1;
          callback(null, 'src/app.tsx\0', '');
        },
      });

      await searcher.search(root);
      await searcher.search(join(root, '.'));
      await searcher.search(join(root, 'src', '..'));

      assert.equal(resolve(join(root, 'src', '..')), root);
      assert.equal(canonicalizations, 1);
      assert.equal(enumerations, 1);
    });
  });

  it('shares an in-flight canonical-root lookup', async () => {
    await withGitRepo(async (root) => {
      let canonicalizations = 0;
      let finishCanonicalization!: () => void;
      const canonicalizationReady = new Promise<void>((resolve) => {
        finishCanonicalization = resolve;
      });
      const searcher = createWorkspaceFileSearcher({
        async canonicalizeRoot(projectRoot) {
          canonicalizations += 1;
          await canonicalizationReady;
          return projectRoot;
        },
        execFileImpl: fakeGit('src/app.tsx\0'),
      });

      const firstSearch = searcher.search(root);
      const secondSearch = searcher.search(root);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(canonicalizations, 1);

      finishCanonicalization();
      await Promise.all([firstSearch, secondSearch]);
    });
  });

  it('refreshes the canonical-root mapping after the cache TTL expires', async () => {
    await withGitRepo(async (root) => {
      let now = 1_000;
      let canonicalizations = 0;
      const searcher = createWorkspaceFileSearcher({
        now: () => now,
        ttlMs: 100,
        async canonicalizeRoot(projectRoot) {
          canonicalizations += 1;
          return projectRoot;
        },
        execFileImpl: fakeGit('src/app.tsx\0'),
      });

      await searcher.search(root);
      now += 99;
      await searcher.search(root);
      assert.equal(canonicalizations, 1);

      now += 1;
      await searcher.search(root);
      assert.equal(canonicalizations, 2);
    });
  });

  it('keeps caches isolated between workspace searcher instances', async () => {
    await withGitRepo(async (root) => {
      let enumerations = 0;
      const createSearcher = () => createWorkspaceFileSearcher({
        execFileImpl(_file, _args, _options, callback) {
          enumerations += 1;
          callback(null, 'shared-path.ts\0', '');
        },
      });

      await createSearcher().search(root);
      await createSearcher().search(root);

      assert.equal(enumerations, 2);
    });
  });

  it('evicts the least recently used ready workspace', async () => {
    await withGitRepo(async (firstRoot) => {
      await withGitRepo(async (secondRoot) => {
        await withGitRepo(async (thirdRoot) => {
          const enumerations = new Map<string, number>();
          const searcher = createWorkspaceFileSearcher({
            maxEntries: 2,
            canonicalizeRoot: async (projectRoot) => projectRoot,
            execFileImpl(_file, _args, options, callback) {
              enumerations.set(options.cwd, (enumerations.get(options.cwd) ?? 0) + 1);
              callback(null, `${options.cwd}.ts\0`, '');
            },
          });

          await searcher.search(firstRoot);
          await searcher.search(secondRoot);
          await searcher.search(firstRoot);
          await searcher.search(thirdRoot);
          await searcher.search(secondRoot);

          assert.equal(enumerations.get(firstRoot), 1);
          assert.equal(enumerations.get(secondRoot), 2);
          assert.equal(enumerations.get(thirdRoot), 1);
        });
      });
    });
  });

  it('evicts ready workspaces when the cached path-byte budget is exceeded', async () => {
    await withGitRepo(async (firstRoot) => {
      await withGitRepo(async (secondRoot) => {
        const enumerations = new Map<string, number>();
        const searcher = createWorkspaceFileSearcher({
          maxEntries: 10,
          maxPathBytes: 30,
          canonicalizeRoot: async (projectRoot) => projectRoot,
          execFileImpl(_file, _args, options, callback) {
            enumerations.set(options.cwd, (enumerations.get(options.cwd) ?? 0) + 1);
            callback(null, '1234567890.ts\0', '');
          },
        });

        await searcher.search(firstRoot);
        await searcher.search(secondRoot);
        await searcher.search(firstRoot);

        assert.equal(enumerations.get(firstRoot), 2);
        assert.equal(enumerations.get(secondRoot), 1);
      });
    });
  });

  it('filters with AND-of-substring tokens, case-insensitively', async () => {
    await withGitRepo(async (root) => {
      const execFileImpl = fakeGit('src/app.tsx\0src/main.tsx\0docs/app.md\0');
      const result = await searchWorkspaceFiles(root, { query: 'SRC app', execFileImpl });
      assert.ok(result.ok);
      const paths = result.ok ? result.files.map((f) => f.relativePath) : [];
      assert.deepEqual(paths, ['src/app.tsx']);
    });
  });

  it('ranks shorter paths first, then lexicographically', async () => {
    await withGitRepo(async (root) => {
      const execFileImpl = fakeGit('a/b/c/app.tsx\0app.tsx\0lib/app.tsx\0');
      const result = await searchWorkspaceFiles(root, { query: 'app', execFileImpl });
      assert.ok(result.ok);
      const paths = result.ok ? result.files.map((f) => f.relativePath) : [];
      assert.deepEqual(paths, ['app.tsx', 'lib/app.tsx', 'a/b/c/app.tsx']);
    });
  });

  it('preserves Git filenames that require an unambiguous delimiter', async () => {
    await withGitRepo(async (root) => {
      const execFileImpl = fakeGit('普通.md\0 leading.txt\0trailing.txt \0line\nbreak.txt\0');
      const result = await searchWorkspaceFiles(root, { query: '', limit: 10, execFileImpl });
      assert.ok(result.ok);
      const paths = result.ok ? result.files.map((file) => file.relativePath) : [];
      assert.deepEqual(paths, ['普通.md', ' leading.txt', 'trailing.txt ', 'line\nbreak.txt']);
    });
  });

  it('caps the result count at the requested limit', async () => {
    await withGitRepo(async (root) => {
      const many = `${Array.from({ length: 200 }, (_v, i) => `file-${i}.ts`).join('\0')}\0`;
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
