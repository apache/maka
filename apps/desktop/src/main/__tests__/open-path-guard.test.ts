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
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { resolveOpenPath } from '../open-path-guard.js';

describe('open path guard', () => {
  test('resolves known allowlisted keys inside workspace', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await mkdir(join(workspaceRoot, 'skills'), { recursive: true });
      await mkdir(join(workspaceRoot, 'memory'), { recursive: true });

      const workspace = await resolveOpenPath({ key: 'workspace', workspaceRoot });
      const skills = await resolveOpenPath({ key: 'skills', workspaceRoot });
      const memory = await resolveOpenPath({ key: 'memory', workspaceRoot });

      assert.equal(workspace.ok, true);
      assert.equal(skills.ok, true);
      assert.equal(memory.ok, true);
    });
  });

  test('resolves the main-owned project directory without accepting renderer paths', async () => {
    await withWorkspace(async (workspaceRoot, projectRoot) => {
      const project = await resolveOpenPath({ key: 'project', workspaceRoot, projectRoot });

      assert.equal(project.ok, true);
      if (project.ok) {
        assert.equal(project.key, 'project');
        assert.equal(project.path, await realpath(projectRoot));
      }

      assert.deepEqual(await resolveOpenPath({ key: 'project', workspaceRoot }), { ok: false, reason: 'missing' });
      assert.deepEqual(await resolveOpenPath({ key: projectRoot, workspaceRoot, projectRoot }), { ok: false, reason: 'unknown-key' });
    });
  });

  test('rejects unknown keys, missing targets, and files', async () => {
    await withWorkspace(async (workspaceRoot) => {
      assert.deepEqual(await resolveOpenPath({ key: 'unknown', workspaceRoot }), { ok: false, reason: 'unknown-key' });
      assert.deepEqual(await resolveOpenPath({ key: 'skills', workspaceRoot }), { ok: false, reason: 'missing' });

      await writeFile(join(workspaceRoot, 'skills'), 'not a directory', 'utf8');
      assert.deepEqual(await resolveOpenPath({ key: 'skills', workspaceRoot }), { ok: false, reason: 'not-a-directory' });
      assert.deepEqual(await resolveOpenPath({ key: 'project', workspaceRoot, projectRoot: join(workspaceRoot, 'skills') }), { ok: false, reason: 'not-a-directory' });
    });
  });

  test('rejects renderer attempts to pass paths or URLs as keys', async () => {
    await withWorkspace(async (workspaceRoot) => {
      for (const key of ['/etc', '../outside', 'file:///tmp', 'http://example.test']) {
        assert.deepEqual(await resolveOpenPath({ key, workspaceRoot }), { ok: false, reason: 'unknown-key' });
      }
    });
  });

  test('rejects symlink escapes from inside an allowed directory', async () => {
    await withWorkspace(async (workspaceRoot, outsideRoot) => {
      await mkdir(outsideRoot, { recursive: true });
      await symlink(outsideRoot, join(workspaceRoot, 'skills'));

      assert.deepEqual(await resolveOpenPath({ key: 'skills', workspaceRoot }), { ok: false, reason: 'not-allowed' });
    });
  });

  test('allows an allowed root that is itself a symlink after realpath normalization', async () => {
    const realRoot = await mkdtemp(join(tmpdir(), 'maka-open-path-real-'));
    const linkRoot = await mkdtemp(join(tmpdir(), 'maka-open-path-link-parent-'));
    const workspaceLink = join(linkRoot, 'workspace-link');
    try {
      await mkdir(join(realRoot, 'skills'), { recursive: true });
      await symlink(realRoot, workspaceLink);

      const result = await resolveOpenPath({ key: 'skills', workspaceRoot: workspaceLink });

      assert.equal(result.ok, true);
    } finally {
      await rm(realRoot, { recursive: true, force: true });
      await rm(linkRoot, { recursive: true, force: true });
    }
  });
});

async function withWorkspace(
  fn: (workspaceRoot: string, outsideRoot: string) => Promise<void>,
): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-open-path-workspace-'));
  const outsideRoot = await mkdtemp(join(tmpdir(), 'maka-open-path-outside-'));
  try {
    await fn(workspaceRoot, outsideRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
}
