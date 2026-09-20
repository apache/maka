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
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeSkillRuntimeState } from '@maka/runtime/skills';
import { listSkillLocations, resolveSkillLocation } from '../skill-locations.js';

test('lists every standard Skill location with availability and inventory counts', async () => {
  await withFixture(async ({ projectRoot, workspaceRoot, homeDirectory }) => {
    await writeSkill(join(projectRoot, '.agents', 'skills'), 'project-tool');
    await writeSkill(join(homeDirectory, '.agents', 'skills'), 'user-tool');

    const locations = await listSkillLocations({ projectRoot, workspaceRoot, homeDirectory });

    assert.deepEqual(
      locations.map(({ ref, status, skillCount }) => ({ ref, status, skillCount })),
      [
        { ref: 'project:maka', status: 'missing', skillCount: 0 },
        { ref: 'project:agents', status: 'available', skillCount: 1 },
        { ref: 'workspace:legacy', status: 'missing', skillCount: 0 },
        { ref: 'user:maka', status: 'missing', skillCount: 0 },
        { ref: 'user:agents', status: 'available', skillCount: 1 },
      ],
    );
  });
});

test('creates and resolves only an allowlisted missing Skill location', async () => {
  await withFixture(async ({ projectRoot, workspaceRoot, homeDirectory }) => {
    const context = { projectRoot, workspaceRoot, homeDirectory };

    assert.deepEqual(await resolveSkillLocation(context, 'workspace:legacy', false), {
      ok: false,
      reason: 'missing',
    });
    const created = await resolveSkillLocation(context, 'workspace:legacy', true);
    assert.equal(created.ok, true);
    if (created.ok) {
      assert.equal(created.path, await realpath(join(workspaceRoot, 'skills')));
      assert.equal((await lstat(created.path)).isDirectory(), true);
    }
    assert.deepEqual(await resolveSkillLocation(context, '../outside', true), {
      ok: false,
      reason: 'unknown_location',
    });
  });
});

test('location counts include disabled, shadowed and rejected Skill copies', async () => {
  await withFixture(async (context) => {
    const projectDirectory = join(context.projectRoot, '.agents', 'skills');
    const userDirectory = join(context.homeDirectory, '.agents', 'skills');
    await writeSkill(projectDirectory, 'shared-tool');
    await writeSkill(userDirectory, 'shared-tool');
    await writeSkill(userDirectory, 'disabled-tool');
    await mkdir(join(userDirectory, 'invalid-tool'));
    await writeFile(join(userDirectory, 'invalid-tool', 'SKILL.md'), '# Missing metadata\n');
    assert.deepEqual(await writeSkillRuntimeState(context.workspaceRoot, new Map([
      ['user:agents:disabled-tool', false],
    ])), { ok: true });

    const locations = await listSkillLocations(context);
    assert.equal(locations.find(({ ref }) => ref === 'project:agents')?.skillCount, 1);
    assert.equal(locations.find(({ ref }) => ref === 'user:agents')?.skillCount, 3);
  });
});

test('reports an unreadable Skill directory instead of an available empty location', {
  skip: process.platform === 'win32'
    ? 'POSIX permissions are required to make the Skill directory unreadable'
    : process.getuid?.() === 0,
}, async () => {
  await withFixture(async (context) => {
    const directory = join(context.projectRoot, '.agents', 'skills');
    await mkdir(directory, { recursive: true });
    await chmod(directory, 0o111);
    try {
      const location = (await listSkillLocations(context))
        .find(({ ref }) => ref === 'project:agents');
      assert.equal(location?.status, 'read_failed');
      assert.deepEqual(await resolveSkillLocation(context, 'project:agents', false), {
        ok: false,
        reason: 'read_failed',
      });
    } finally {
      await chmod(directory, 0o700);
    }
  });
});

test('refuses to create through a symlinked Skill location ancestor', async () => {
  await withFixture(async ({ projectRoot, workspaceRoot, homeDirectory, root }) => {
    const outside = join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(projectRoot, '.maka'));

    assert.deepEqual(
      await resolveSkillLocation(
        { projectRoot, workspaceRoot, homeDirectory },
        'project:maka',
        true,
      ),
      { ok: false, reason: 'blocked_path' },
    );
  });
});

test('accepts a Skill location whose ancestor symlink stays inside the containment root', async () => {
  await withFixture(async ({ projectRoot, workspaceRoot, homeDirectory }) => {
    const contained = join(projectRoot, 'contained');
    await mkdir(contained);
    await symlink(contained, join(projectRoot, '.maka'));

    const created = await resolveSkillLocation(
      { projectRoot, workspaceRoot, homeDirectory },
      'project:maka',
      true,
    );

    assert.equal(created.ok, true);
    if (created.ok) {
      assert.equal(created.path, await realpath(join(contained, 'skills')));
    }
  });
});

async function withFixture(
  run: (fixture: {
    root: string;
    projectRoot: string;
    workspaceRoot: string;
    homeDirectory: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-skill-locations-'));
  const projectRoot = join(root, 'project');
  const workspaceRoot = join(root, 'workspace');
  const homeDirectory = join(root, 'home');
  await Promise.all([
    mkdir(projectRoot),
    mkdir(workspaceRoot),
    mkdir(homeDirectory),
  ]);
  try {
    await run({ root, projectRoot, workspaceRoot, homeDirectory });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeSkill(root: string, id: string): Promise<void> {
  const directory = join(root, id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'SKILL.md'),
    `---\nname: ${id}\ndescription: ${id} description\n---\n# ${id}\n`,
    'utf8',
  );
}
