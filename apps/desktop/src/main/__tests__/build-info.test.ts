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

/**
 * The build stamp exists to tell a locally built tree apart from a release.
 * A linked worktree is the checkout where that matters most — it is the one
 * whose HEAD differs from the tree a developer thinks they are running — and
 * it is also the one whose `.git` is a file rather than a directory, so a
 * resolver that only reads `<root>/.git/HEAD` finds nothing there and the
 * stamp falls back to a bare version number.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { resolveBuildInfo } from '../build-info.js';

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const SHA = '4d223d05beea1bfa8af3b4bb4fe1211a9e93acfe';

test('a packaged build reports no commit and does not read the filesystem for one', () => {
  // `app.isPackaged` is the whole answer: a packaged tree has no repository,
  // and a commit resolved from one next to it would describe the wrong thing.
  assert.deepEqual(resolveBuildInfo(true, process.cwd()), { mode: 'packaged', commit: null });
});

test('an ordinary clone resolves the commit through a ref', async () => {
  const root = await makeRoot();
  await seedGitDir(join(root, '.git'), { head: 'ref: refs/heads/main', refs: { 'refs/heads/main': SHA } });
  assert.deepEqual(resolveBuildInfo(false, root), { mode: 'dev', commit: SHA.slice(0, 7) });
});

test('a linked worktree reads HEAD privately and the branch ref from commondir', async () => {
  // The real layout, reproduced from `git worktree add`: `.git` is a FILE
  // holding `gitdir: <admin dir>`; the admin directory holds this worktree's
  // own HEAD plus a `commondir` pointer, and NOTHING under `refs/heads`. The
  // branch ref lives in the common Git directory shared with the main
  // checkout. A resolver that looks for the ref beside HEAD finds nothing.
  const root = await makeRoot();
  const commonDir = join(root, 'main-repo', '.git');
  const adminDir = join(commonDir, 'worktrees', 'linked');
  await seedGitDir(commonDir, { head: 'ref: refs/heads/main', refs: { 'refs/heads/main': SHA } });
  await mkdir(adminDir, { recursive: true });
  await writeFile(join(adminDir, 'HEAD'), 'ref: refs/heads/feature\n');
  await writeFile(join(adminDir, 'commondir'), '../..\n');
  // The branch ref exists only in the common directory, as Git writes it.
  await mkdir(join(commonDir, 'refs', 'heads'), { recursive: true });
  await writeFile(join(commonDir, 'refs', 'heads', 'feature'), `${SHA}\n`);
  const checkout = join(root, 'linked');
  await mkdir(checkout, { recursive: true });
  await writeFile(join(checkout, '.git'), `gitdir: ${adminDir}\n`);
  assert.deepEqual(resolveBuildInfo(false, checkout), { mode: 'dev', commit: SHA.slice(0, 7) });
});

test('a worktree finds a packed branch ref in the common directory', async () => {
  // Same split, but the ref is packed. `packed-refs` is shared too.
  const root = await makeRoot();
  const commonDir = join(root, 'main-repo', '.git');
  const adminDir = join(commonDir, 'worktrees', 'linked');
  await mkdir(commonDir, { recursive: true });
  await writeFile(join(commonDir, 'packed-refs'), `# pack-refs with: peeled\n${SHA} refs/heads/feature\n`);
  await mkdir(adminDir, { recursive: true });
  await writeFile(join(adminDir, 'HEAD'), 'ref: refs/heads/feature\n');
  await writeFile(join(adminDir, 'commondir'), '../..\n');
  const checkout = join(root, 'linked');
  await mkdir(checkout, { recursive: true });
  await writeFile(join(checkout, '.git'), `gitdir: ${adminDir}\n`);
  assert.deepEqual(resolveBuildInfo(false, checkout), { mode: 'dev', commit: SHA.slice(0, 7) });
});

test('a worktree pointer relative to the checkout resolves', async () => {
  // Git writes a relative pointer for a worktree created inside the repo.
  const root = await makeRoot();
  await seedGitDir(join(root, 'nested', 'git-dir'), {
    head: 'ref: refs/heads/main',
    refs: { 'refs/heads/main': SHA },
  });
  await writeFile(join(root, '.git'), 'gitdir: nested/git-dir\n');
  assert.deepEqual(resolveBuildInfo(false, root), { mode: 'dev', commit: SHA.slice(0, 7) });
});

test('a detached HEAD is already the sha', async () => {
  const root = await makeRoot();
  await seedGitDir(join(root, '.git'), { head: SHA, refs: {} });
  assert.deepEqual(resolveBuildInfo(false, root), { mode: 'dev', commit: SHA.slice(0, 7) });
});

test('a packed ref resolves when no loose ref file exists', async () => {
  const root = await makeRoot();
  const gitDir = join(root, '.git');
  await seedGitDir(gitDir, { head: 'ref: refs/heads/main', refs: {} });
  await writeFile(join(gitDir, 'packed-refs'), `# pack-refs with: peeled\n${SHA} refs/heads/main\n`);
  assert.deepEqual(resolveBuildInfo(false, root), { mode: 'dev', commit: SHA.slice(0, 7) });
});

test('an unreadable checkout reports dev with no commit rather than throwing', async () => {
  // Absence is a supported answer: the stamp shows the version alone. A throw
  // here would fail `app:info`, which carries far more than the commit.
  const root = await makeRoot();
  assert.deepEqual(resolveBuildInfo(false, root), { mode: 'dev', commit: null });

  const dangling = await makeRoot();
  await writeFile(join(dangling, '.git'), 'gitdir: /nowhere/that/exists\n');
  assert.deepEqual(resolveBuildInfo(false, dangling), { mode: 'dev', commit: null });
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'maka-build-info-'));
  roots.push(root);
  return root;
}

async function seedGitDir(
  gitDir: string,
  input: { head: string; refs: Readonly<Record<string, string>> },
): Promise<void> {
  await mkdir(gitDir, { recursive: true });
  await writeFile(join(gitDir, 'HEAD'), `${input.head}\n`);
  for (const [ref, sha] of Object.entries(input.refs)) {
    const refPath = join(gitDir, ...ref.split('/'));
    await mkdir(join(refPath, '..'), { recursive: true });
    await writeFile(refPath, `${sha}\n`);
  }
}
