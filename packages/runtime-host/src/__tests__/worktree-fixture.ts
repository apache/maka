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
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectRecord } from '@maka/core/project';
import type { WorktreeInfo } from '@maka/core/worktree';
import { HostWorktreeManager } from '../server/worktree-manager.js';
import type { WorktreeName } from '../server/worktree-naming.js';
const exec = promisify(execFile);
export async function createWorktree(
  manager: HostWorktreeManager,
  projectId: string,
  operationId: string = randomUUID(),
): Promise<WorktreeInfo> {
  const result = await manager.mutate({
    kind: 'create',
    projectId,
    operationId,
    description: 'Add a search field',
  });
  assert.equal(result.kind, 'worktree');
  if (result.kind !== 'worktree') throw new Error('Expected a worktree');
  return result.worktree;
}
export async function testScript(root: string, source: string): Promise<string> {
  const path = join(root, `script-${randomUUID()}.cjs`);
  await writeFile(path, source);
  return `node "${path.replaceAll('\\', '/')}"`;
}
export async function fixture(
  t: { after(fn: () => Promise<void>): void },
  name?: string,
  type: WorktreeName['type'] = 'feat',
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maka-worktrees-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'source repo');
  await mkdir(repo);
  const git = async (...args: string[]) => (await exec('git', ['-C', repo, ...args])).stdout.trim();
  await git('init', '-b', 'main');
  await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'user.name', 'Worktree Test');
  await writeFile(join(repo, 'tracked.txt'), 'committed\n');
  await git('add', '.');
  await git('commit', '-m', 'initial');
  const project: ProjectRecord = {
    id: 'test-project',
    name: 'Example',
    available: true,
    preferredPath: repo,
    locations: [{ path: repo, isWorktree: false }],
  };
  const sessions: Array<{ id: string; cwd: string }> = [];
  const liveResources = new Set<string>();
  let active = false;
  let calls = 0;
  const options = {
    stateRoot: join(root, 'state'),
    catalog: {
      list: async () => [project],
      register: async (path: string) => {
        if (!project.locations.some((entry) => entry.path === path))
          project.locations.push({ path, isWorktree: true });
        return project;
      },
    },
    listSessions: async () => sessions,
    isSessionActive: () => active,
    hasLiveSessionResources: async (sessionId: string) => liveResources.has(sessionId),
    generateName: async (): Promise<WorktreeName | undefined> => {
      calls++;
      return name ? { type, slug: name } : undefined;
    },
    withSessions: async <T>(_ids: readonly string[], operation: () => Promise<T>) => operation(),
    changed: () => {},
  };
  const manager = new HostWorktreeManager(options);
  await manager.mutate({ kind: 'configure', config: { rootDirectory: join(root, 'worktrees') } });
  const create = async (id = 'operation-1') => {
    const result = await manager.mutate({
      kind: 'create',
      operationId: id,
      projectId: project.id,
      description: 'Add a search field',
    });
    assert.equal(result.kind, 'worktree');
    return (result as { kind: 'worktree'; worktree: WorktreeInfo }).worktree;
  };
  return {
    root,
    repo,
    git,
    manager,
    project,
    sessions,
    liveResources,
    options,
    create,
    calls: () => calls,
    setActive: (value: boolean) => {
      active = value;
    },
  };
}
