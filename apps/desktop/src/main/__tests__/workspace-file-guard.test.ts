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
import { test } from 'node:test';
import { resolveWorkspaceFile } from '../workspace-file-guard.js';

test('resolves a workspace-relative Markdown file and rejects escapes', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-workspace-file-'));
  const outsideRoot = await mkdtemp(join(tmpdir(), 'maka-workspace-file-out-'));
  try {
    await mkdir(join(workspaceRoot, 'docs'), { recursive: true });
    await mkdir(join(workspaceRoot, 'docs..'), { recursive: true });
    await writeFile(join(workspaceRoot, 'docs', 'guide.md'), '# Guide\n', 'utf8');
    await writeFile(join(workspaceRoot, 'docs..', 'guide.md'), '# Dotted guide\n', 'utf8');
    await writeFile(join(outsideRoot, 'secret.md'), 'secret', 'utf8');
    await writeFile(join(workspaceRoot, '.env'), 'TOKEN=secret', 'utf8');
    await symlink(join(outsideRoot, 'secret.md'), join(workspaceRoot, 'docs', 'escape.md'));
    await symlink(join(workspaceRoot, '.env'), join(workspaceRoot, 'docs', 'public.md'));

    const resolved = await resolveWorkspaceFile({
      workspaceRoot,
      relativePath: 'docs/guide.md',
    });
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.equal(resolved.path, await realpath(join(workspaceRoot, 'docs', 'guide.md')));
    }

    const dottedDirectory = await resolveWorkspaceFile({
      workspaceRoot,
      relativePath: 'docs../guide.md',
    });
    assert.equal(dottedDirectory.ok, true);

    assert.deepEqual(
      await resolveWorkspaceFile({ workspaceRoot, relativePath: '../secret.md' }),
      { ok: false, reason: 'invalid' },
    );
    assert.deepEqual(
      await resolveWorkspaceFile({ workspaceRoot, relativePath: 'docs/escape.md' }),
      { ok: false, reason: 'not-allowed' },
    );
    assert.deepEqual(
      await resolveWorkspaceFile({ workspaceRoot, relativePath: 'docs/missing.md' }),
      { ok: false, reason: 'missing' },
    );
    assert.deepEqual(
      await resolveWorkspaceFile({ workspaceRoot, relativePath: 'docs/public.md' }),
      { ok: false, reason: 'not-a-file' },
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});
