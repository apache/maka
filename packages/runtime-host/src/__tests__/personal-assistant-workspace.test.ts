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
import test, { type TestContext } from 'node:test';
import { mkdir, mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createProjectCatalog } from '@maka/storage/project-catalog';
import { resolveMakaClientDataRoot } from '@maka/storage/workspace-root';
import { HostPersonalAssistantWorkspace } from '../server/personal-assistant-workspace.js';
import { HostProjectMembershipGate } from '../server/project-membership-gate.js';

async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'maka-assistant-workspace-'));
  const home = join(base, 'home');
  await mkdir(home);
  const catalog = createProjectCatalog(join(base, 'state'));
  t.after(async () => {
    catalog.close();
    await rm(base, { recursive: true, force: true });
  });
  const make = (stateRoot = join(base, 'state')) =>
    new HostPersonalAssistantWorkspace({
      stateRoot,
      homeDirectory: home,
      projects: catalog,
      membership: new HostProjectMembershipGate(),
      projectChanged() {},
      preflightSessionCreation: async () => {},
    });
  return { base, home, catalog, make };
}

for (const profileName of ['Maka', 'Maka Dev', 'Maka Dev Worktrees']) {
  test(`assistant fallback allocates a fresh task directory in the Host ${profileName} namespace`, async (t) => {
    const f = await fixture(t);
    const business = join(f.home, 'business');
    await mkdir(business);
    const existing = await f.catalog.register(business);
    const stateRoot = join(
      resolveMakaClientDataRoot({ profileName, homeDir: f.home }),
      'workspaces',
      'default',
    );
    const allocator = f.make(stateRoot);
    const first = await allocator.allocate();
    const second = await allocator.allocate();
    assert.notEqual(first.projectId, second.projectId);
    const projects = await f.catalog.list();
    assert.equal(projects.length, 3);
    for (const { projectId } of [first, second]) {
      const project = projects.find((p) => p.id === projectId)!;
      const root = join(
        await realpath(f.home),
        profileName === 'Maka' ? 'Maka' : 'Maka Dev',
        'tasks',
      );
      assert.equal(dirname(project.preferredPath!), root);
      assert.match(basename(project.preferredPath!), /^task-/);
      assert.notEqual(project.id, existing.id);
      assert.equal(project.available, true);
    }
  });
}

test('a redirected managed directory is refused before registering any Project', async (t) => {
  const f = await fixture(t);
  const outside = join(f.base, 'outside');
  await mkdir(outside);
  await symlink(outside, join(f.home, 'Maka'), 'junction');
  await assert.rejects(f.make().allocate(), /real directory/);
  assert.equal((await f.catalog.list()).length, 0);
});

test('Host registration failure is propagated without selecting another Project', async (t) => {
  const f = await fixture(t);
  const failure = Error('Project storage unavailable');
  const allocator = new HostPersonalAssistantWorkspace({
    stateRoot: join(f.base, 'state'),
    homeDirectory: f.home,
    projects: {
      register: async () => {
        throw failure;
      },
    },
    membership: new HostProjectMembershipGate(),
    projectChanged() {
      throw Error('Must not publish');
    },
    preflightSessionCreation: async () => {},
  });
  await assert.rejects(allocator.allocate(), (error) => error === failure);
  assert.equal((await f.catalog.list()).length, 0);
});

test('a failed Session preflight leaves no task directory or registered Project', async (t) => {
  const f = await fixture(t);
  const failure = Error('No default Session model is configured');
  const allocator = new HostPersonalAssistantWorkspace({
    stateRoot: join(f.base, 'state'),
    homeDirectory: f.home,
    projects: f.catalog,
    membership: new HostProjectMembershipGate(),
    projectChanged() {},
    preflightSessionCreation: async () => {
      throw failure;
    },
  });
  await assert.rejects(allocator.allocate(), (error) => error === failure);
  await assert.rejects(stat(join(f.home, 'Maka')));
  assert.equal((await f.catalog.list()).length, 0);
});
