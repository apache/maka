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
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';
import type { WorktreeSnapshot } from '@maka/core/worktree';
import type { IpcHandler } from '../ipc-reconnect-policy.js';
import type { registerWorkspaceSearchIpc } from '../workspace-search-ipc-main.js';

const exec = promisify(execFile);

test('file search uses the selected Host worktree and rejects unavailable or foreign paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-worktree-search-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const main = join(root, 'main');
  const checkout = join(root, 'feature');
  await mkdir(main);
  const git = (...args: string[]) => exec('git', ['-C', main, ...args]);
  await git('init', '-b', 'main');
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial');
  await git('worktree', 'add', '-b', 'feature', checkout);
  await writeFile(join(main, 'main-only.ts'), 'main');
  await writeFile(join(checkout, 'feature-only.ts'), 'feature');
  const snapshot: WorktreeSnapshot = {
    config: { rootDirectory: root, projects: {} },
    projects: [{ id: 'project', name: 'Project', mainPath: main, config: {}, worktrees: [{
      projectId: 'project', path: checkout, name: 'feature', head: '', isMain: false,
      managed: true, available: true, locked: false, sessionCount: 0,
    }] }],
  };
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../../../src/main/workspace-search-ipc-main.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
  });
  const require = createRequire(import.meta.url);
  const module = { exports: {} as { registerWorkspaceSearchIpc: typeof registerWorkspaceSearchIpc } };
  runInNewContext(bundle.outputFiles[0]!.text, {
    module, exports: module.exports,
    require: (id: string) => id === 'electron' ? { ipcMain: {} } : require(id),
    process, Buffer, console, setTimeout, clearTimeout,
  });
  let handler!: IpcHandler;
  let defaultReads = 0;
  module.exports.registerWorkspaceSearchIpc({
    ipcMain: { handle(channel, listener) {
      assert.equal(channel, 'workspace:searchFiles');
      handler = listener;
    } },
    getProjectRoot: async (_sessionId, projectId) => {
      defaultReads++;
      // The last-used checkout is the preferred Project path, not its main path.
      return projectId === 'folder' ? main : checkout;
    },
    queryWorktrees: async (projectId) => {
      if (projectId === 'folder') return { ...snapshot, projects: [] };
      assert.equal(projectId, 'project');
      return snapshot;
    },
  });
  const search = (input: unknown) => handler({} as Parameters<IpcHandler>[0], input);
  const files = async (input: unknown) => JSON.parse(JSON.stringify(await search(input)));
  assert.deepEqual(await files({ projectId: 'project', worktreePath: checkout, query: '.ts' }), {
    ok: true, files: [{ relativePath: 'feature-only.ts' }],
  });
  assert.equal(defaultReads, 0);
  assert.deepEqual(await files({ projectId: 'project', query: '.ts' }), {
    ok: true, files: [{ relativePath: 'main-only.ts' }],
  });
  assert.equal(defaultReads, 0, 'main selection must not use the last-used checkout');
  assert.deepEqual(await files({ projectId: 'folder', query: '.ts' }), {
    ok: true, files: [{ relativePath: 'main-only.ts' }],
  });
  // Existing sessions always search their persisted cwd, ignoring draft selections.
  assert.deepEqual(await files({ sessionId: 'feature-session', worktreePath: '/foreign', query: '.ts' }), {
    ok: true, files: [{ relativePath: 'feature-only.ts' }],
  });
  await assert.rejects(search({ projectId: 'project', worktreePath: '/foreign' }), /unavailable/);
  await assert.rejects(search({ worktreePath: checkout }), /Invalid/);
  snapshot.projects[0]!.worktrees[0]!.available = false;
  await assert.rejects(search({ projectId: 'project', worktreePath: checkout }), /unavailable/);
  snapshot.projects[0]!.worktrees[0]!.available = true;
  snapshot.projects[0]!.worktrees[0]!.locked = true;
  await assert.rejects(search({ projectId: 'project', worktreePath: checkout }), /unavailable/);
  assert.equal(defaultReads, 2, 'invalid selections must not fall back to the main directory');
});
