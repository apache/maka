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

import { assertMaximalJsonPages } from './fixtures/json-pages.js';
import {
  decodeProjectCatalogQueryResult,
  PROJECT_CATALOG_PAGE_MAX_BYTES,
  PROJECT_CATALOG_PAGE_MAX_ITEMS,
  type ProjectCatalogQueryInput,
  type ProjectCatalogQueryResult,
  type ProjectCatalogPageItem,
} from '../protocol/index.js';

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createProjectCatalog } from '@maka/storage/project-catalog';
import { createSessionStore } from '@maka/storage/session-store';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { HostChangeFeed } from '../server/host-change-feed.js';
import { HostProjectCatalogCoordinator } from '../server/project-catalog-coordinator.js';
import { HostProjectMembershipGate } from '../server/project-membership-gate.js';
import { HostWorktreeManager } from '../server/worktree-manager.js';

const execFileAsync = promisify(execFile);

test('Host Project Catalog can register a location without changing the preferred path', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-host-project-register-preference-'));
  const repository = join(base, 'repository');
  const linkedWorktree = join(base, 'linked');
  await createGitRepositoryWithWorktree(repository, linkedWorktree);
  let now = 1_000;
  const catalog = createProjectCatalog(join(base, 'storage'), {
    now: () => now,
    createId: () => 'project-1',
  });
  const coordinator = new HostProjectCatalogCoordinator(
    catalog,
    { publish: () => {} },
    { publish: () => {} },
    new HostProjectMembershipGate(),
    () => assert.fail('ordinary project mutations must not drain the Host'),
  );

  try {
    const original = await catalog.register(repository);
    const repositoryPath = await realpath(repository);
    now = 2_000;
    const input = { kind: 'register' as const, path: linkedWorktree, prefer: false };
    const registered = await coordinator.handlers['project.catalog.mutate'](input, connection());

    assert.equal(registered.ok, true);
    if (!registered.ok || registered.result.kind !== 'project') return;
    assert.equal(registered.result.project.id, original.id);
    assert.equal(registered.result.project.locationCount, 2);
    assert.equal((await catalog.list())[0]?.preferredPath, repositoryPath);
  } finally {
    catalog.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('Host Project Catalog relink merges identities and reassigns every affected Session', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-host-project-catalog-'));
  const storageRoot = join(base, 'storage');
  const oldPath = join(base, 'old-location');
  const newPath = join(base, 'new-location');
  await mkdir(oldPath);
  const catalog = createProjectCatalog(storageRoot, {
    now: () => 1_000,
    createId: (() => {
      let id = 0;
      return () => `project-${++id}`;
    })(),
  });
  const sessions = createSessionStore(storageRoot);
  const worktrees = projectWorktrees(storageRoot, catalog, sessions);
  const hostChanges = new HostChangeFeed();
  const projectFrames: unknown[] = [];
  const sessionFrames: unknown[] = [];
  hostChanges.attachConnection(
    'desktop',
    {
      projectCatalog: true,
      sessionCatalog: true,
    },
    {
      send: async (frame) => {
        if (frame.kind === 'project.catalog.changed') projectFrames.push(frame);
        else sessionFrames.push(frame);
      },
    },
  );
  hostChanges.attachConnection(
    'tui',
    { projectCatalog: true },
    {
      send: async (frame) => {
        projectFrames.push(frame);
      },
    },
  );
  const membership = new HostProjectMembershipGate();
  const coordinator = new HostProjectCatalogCoordinator(
    catalog,
    { publish: () => hostChanges.publishProjectCatalog() },
    { publish: (sessionId: string) => hostChanges.publishSessionCatalog(sessionId) },
    membership,
    () => assert.fail('ordinary project mutations must not drain the Host'),
    undefined,
    {
      listSessions: () => sessions.listHeaders(),
      isBound: (sessionId) => worktrees.isBound(sessionId),
    },
  );

  try {
    const original = await catalog.register(oldPath);
    await rename(oldPath, newPath);
    const destinationPath = await realpath(newPath);
    const duplicate = await catalog.register(newPath);
    const oldSession = await sessions.create(sessionInput(oldPath, original.id));
    const newSession = await sessions.create(sessionInput(destinationPath, duplicate.id));
    await worktrees.bind(newSession.id, destinationPath);

    const relinked = await coordinator.handlers['project.catalog.mutate'](
      { kind: 'relink', projectId: original.id, path: newPath },
      connection(),
    );
    assert.equal(relinked.ok, true);
    if (!relinked.ok || relinked.result.kind !== 'project') return;
    assert.equal(relinked.result.project.id, original.id);
    const [project] = await catalog.list();
    assert.deepEqual(project?.aliases, [duplicate.id]);
    assert.equal(project?.preferredPath, destinationPath);
    assert.deepEqual(
      (await catalog.list()).map(({ id }) => id),
      [original.id],
    );

    for (const sessionId of [oldSession.id, newSession.id]) {
      const header = await sessions.readHeaderSnapshot(sessionId);
      assert.equal(header.projectId, original.id);
      assert.equal(header.cwd, destinationPath);
    }
    await worktrees.assertReady(newSession.id, destinationPath);
    assert.deepEqual(projectFrames, [
      { kind: 'project.catalog.changed', revision: 1 },
      { kind: 'project.catalog.changed', revision: 1 },
    ]);
    assert.deepEqual(
      sessionFrames.map((frame) => (frame as { revision: number }).revision),
      [1, 2],
    );
    assert.deepEqual(
      sessionFrames.map((frame) => (frame as { sessionId: string }).sessionId).sort(),
      [oldSession.id, newSession.id].sort(),
    );

    const listed = await coordinator.handlers['project.catalog.query'](
      { kind: 'list_start', view: 'summary' },
      connection(),
    );
    assert.equal(listed.ok, true);
    assert.equal(listed.ok && listed.result.kind, 'page');
    assert.equal(listed.ok && listed.result.kind === 'page' && listed.result.projectCount, 1);

    const locations = await coordinator.handlers['project.catalog.query'](
      { kind: 'list_start', view: 'locations' },
      connection(),
    );
    assert.equal(locations.ok, true);
    if (!locations.ok || locations.result.kind !== 'page') return;
    assert.deepEqual(
      locations.result.items.filter((item) => item.kind === 'location'),
      [
        {
          kind: 'location',
          projectIndex: 0,
          itemIndex: 0,
          location: { path: destinationPath, isWorktree: false },
        },
      ],
    );
  } finally {
    await worktrees.close();
    catalog.close();
    await sessions.close?.();
    await rm(base, { recursive: true, force: true });
  }
});

for (const workspace of ['folder', 'worktree'] as const) {
  test(`Host Project Catalog rejects relink before changing a fixed ${workspace} Session`, async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'maka-host-fixed-project-')));
    const storageRoot = join(base, 'storage');
    const originalPath = join(base, 'original');
    const targetPath = join(base, 'target');
    const linkedPath = join(base, 'linked');
    if (workspace === 'worktree') {
      await createGitRepositoryWithWorktree(originalPath, linkedPath);
    } else {
      await mkdir(originalPath);
    }
    await mkdir(targetPath);
    const catalog = createProjectCatalog(storageRoot);
    const sessions = createSessionStore(storageRoot);
    const worktrees = projectWorktrees(storageRoot, catalog, sessions);
    let published = 0;
    let drains = 0;
    const coordinator = new HostProjectCatalogCoordinator(
      catalog,
      {
        publish: () => {
          published += 1;
        },
      },
      {
        publish: () => {
          published += 1;
        },
      },
      new HostProjectMembershipGate(),
      () => {
        drains += 1;
      },
      undefined,
      {
        listSessions: () => sessions.listHeaders(),
        isBound: (sessionId) => worktrees.isBound(sessionId),
      },
    );
    try {
      const project = await catalog.register(originalPath);
      const mainSession = await sessions.create(sessionInput(originalPath, project.id));
      if (workspace === 'worktree') {
        await catalog.register(linkedPath, { prefer: false });
        const linkedSession = await sessions.create(sessionInput(linkedPath, project.id));
        await worktrees.bind(linkedSession.id, linkedPath);
      } else {
        await worktrees.bind(mainSession.id, originalPath);
      }
      const beforeProjects = await catalog.list();
      const beforeSessions = await sessions.listHeaders();
      const outcome = await coordinator.handlers['project.catalog.mutate'](
        {
          kind: 'relink',
          projectId: project.id,
          // Even relinking the main checkout to itself must preserve its sibling worktree.
          path: workspace === 'worktree' ? originalPath : targetPath,
        },
        connection(),
      );
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.equal(outcome.error.code, 'operation_conflict');
        assert.match(outcome.error.message, /fixed|bound/i);
      }
      assert.deepEqual(await catalog.list(), beforeProjects);
      assert.deepEqual(await sessions.listHeaders(), beforeSessions);
      assert.equal(published, 0);
      assert.equal(drains, 0);
      for (const header of beforeSessions) await worktrees.assertReady(header.id, header.cwd);
    } finally {
      await worktrees.close();
      catalog.close();
      await sessions.close?.();
      await rm(base, { recursive: true, force: true });
    }
  });
}

test('Host Project Catalog accepts a fixed Session relink through a canonical path and alias', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'maka-host-fixed-project-alias-')));
  const storageRoot = join(base, 'storage');
  const originalPath = join(base, 'original');
  const targetPath = join(base, 'target');
  await mkdir(originalPath);
  await mkdir(targetPath);
  const catalog = createProjectCatalog(storageRoot);
  const sessions = createSessionStore(storageRoot);
  const worktrees = projectWorktrees(storageRoot, catalog, sessions);
  const coordinator = new HostProjectCatalogCoordinator(
    catalog,
    { publish() {} },
    { publish() {} },
    new HostProjectMembershipGate(),
    () => assert.fail('same-directory relink must not drain the Host'),
    undefined,
    {
      listSessions: () => sessions.listHeaders(),
      isBound: (sessionId) => worktrees.isBound(sessionId),
    },
  );
  try {
    const original = await catalog.register(originalPath);
    const duplicate = await catalog.register(targetPath);
    await catalog.relinkWithSessions(original.id, targetPath);
    const session = await sessions.create(sessionInput(targetPath, duplicate.id));
    await worktrees.bind(session.id, targetPath);
    const relinked = await coordinator.handlers['project.catalog.mutate'](
      { kind: 'relink', projectId: duplicate.id, path: `${targetPath}/.` },
      connection(),
    );
    assert.equal(relinked.ok, true, JSON.stringify(relinked));
    const header = await sessions.readHeaderSnapshot(session.id);
    assert.equal(header.cwd, targetPath);
    assert.equal(header.projectId, original.id);
    await worktrees.assertReady(session.id, header.cwd);
  } finally {
    await worktrees.close();
    catalog.close();
    await sessions.close?.();
    await rm(base, { recursive: true, force: true });
  }
});

function projectWorktrees(
  storageRoot: string,
  catalog: ReturnType<typeof createProjectCatalog>,
  sessions: ReturnType<typeof createSessionStore>,
): HostWorktreeManager {
  return new HostWorktreeManager({
    stateRoot: storageRoot,
    catalog,
    listSessions: () => sessions.listHeaders(),
    isSessionActive: () => false,
    hasLiveSessionResources: async () => false,
    generateName: async () => undefined,
    withSessions: (_ids, operation) => operation(),
    changed() {},
  });
}

test('directory resolution failures cannot enter the unknown-commit drain path', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-host-project-directory-failure-'));
  const catalog = createProjectCatalog(join(base, 'storage'));
  let drains = 0;
  const hostChanges = new HostChangeFeed();
  const coordinator = new HostProjectCatalogCoordinator(
    catalog,
    { publish: () => hostChanges.publishProjectCatalog() },
    { publish: (sessionId: string) => hostChanges.publishSessionCatalog(sessionId) },
    new HostProjectMembershipGate(),
    () => {
      drains += 1;
    },
    {
      resolveRegistration: async () => {
        throw Object.assign(new Error('Path is too long'), { code: 'ENAMETOOLONG' });
      },
    } as never,
  );

  try {
    assert.deepEqual(
      await coordinator.handlers['project.catalog.mutate'](
        { kind: 'register_directory', rootId: 'home', segments: ['project'] },
        connection(),
      ),
      {
        ok: false,
        error: { code: 'invalid_request', message: 'Project directory is unavailable' },
      },
    );
    assert.equal(drains, 0);
  } finally {
    catalog.close();
    await rm(base, { recursive: true, force: true });
  }
});

async function createGitRepositoryWithWorktree(
  repository: string,
  linkedWorktree: string,
): Promise<void> {
  await mkdir(repository);
  await execFileAsync('git', ['init', '--quiet'], { cwd: repository });
  await writeFile(join(repository, 'tracked.txt'), 'tracked\n', 'utf8');
  await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repository });
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=Maka Test',
      '-c',
      'user.email=test@maka.invalid',
      'commit',
      '--quiet',
      '-m',
      'init',
    ],
    { cwd: repository },
  );
  await execFileAsync('git', ['worktree', 'add', '--quiet', '-b', 'linked', linkedWorktree], {
    cwd: repository,
  });
}

function sessionInput(cwd: string, projectId: string) {
  return {
    cwd,
    projectId,
    backend: 'fake' as const,
    llmConnectionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask' as const,
  };
}

function connection(): ConnectionContext {
  return {
    hostEpoch: 'host-1',
    connectionId: 'desktop',
    principal: 'local_os_user',
    acquireResidency: () => ({ release: () => {} }),
  };
}

test('Project catalog includes mixed item kinds and its header in byte-limited pages', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-project-pages-'));
  const catalog = createProjectCatalog(join(root, 'storage'));
  try {
    const seed = await catalog.register(root);
    const records = Array.from({ length: 20 }, (_, index) => ({
      ...seed,
      id: `project-${index}`,
      name: `Project ${index} ${'文"\\🙂'.repeat(700)}`,
      aliases: [`old-${index}`],
    }));
    context.mock.method(catalog, 'list', async () => records);
    const expected: ProjectCatalogPageItem[] = records.flatMap((record, projectIndex) => [
      {
        kind: 'project' as const,
        projectIndex,
        id: record.id,
        name: record.name,
        aliasCount: 1,
        locationCount: record.locations.length,
        preferredLocationIndex: 0,
        archivedAt: null,
        available: record.available,
      },
      { kind: 'alias' as const, projectIndex, itemIndex: 0, alias: record.aliases[0]! },
      ...record.locations.map((location, itemIndex) => ({
        kind: 'location' as const,
        projectIndex,
        itemIndex,
        location: { path: location.path, isWorktree: location.isWorktree },
      })),
    ]);
    const coordinator = new HostProjectCatalogCoordinator(
      catalog,
      { publish() {} },
      { publish() {} },
      new HostProjectMembershipGate(),
      () => assert.fail('query must not drain'),
    );
    const pages: Extract<ProjectCatalogQueryResult, { kind: 'page' }>[] = [];
    let input: ProjectCatalogQueryInput = { kind: 'list_start', view: 'locations' };
    let end = 0;
    do {
      const outcome = await coordinator.handlers['project.catalog.query'](input, null as never);
      assert.ok(outcome.ok && outcome.result.kind === 'page');
      const page = outcome.result;
      assert.deepEqual(decodeProjectCatalogQueryResult(page), page);
      assert.equal(page.projectCount, records.length);
      assert.ok(page.items.length > 0);
      pages.push(page);
      end += page.items.length;
      assert.equal(page.nextCursor, end < expected.length ? String(end) : null);
      if (page.nextCursor === null) break;
      input = {
        kind: 'list_continue',
        view: 'locations',
        revision: page.revision,
        cursor: page.nextCursor,
      };
    } while (end < expected.length);
    assert.ok(pages.length > 1);
    assert.ok(pages[0]!.items.length < PROJECT_CATALOG_PAGE_MAX_ITEMS);
    assertMaximalJsonPages(pages, expected, {
      maxBytes: PROJECT_CATALOG_PAGE_MAX_BYTES,
      maxItems: PROJECT_CATALOG_PAGE_MAX_ITEMS,
      items: (page) => page.items,
      candidate: (page, items, end) => ({
        ...page,
        items,
        nextCursor: end < expected.length ? String(end) : null,
      }),
    });
  } finally {
    catalog.close();
    await rm(root, { recursive: true, force: true });
  }
});
