import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createProjectCatalog, createSessionStore } from '@maka/storage';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { HostProjectCatalogChangeService } from '../server/project-catalog-change-service.js';
import { HostProjectCatalogCoordinator } from '../server/project-catalog-coordinator.js';
import { HostProjectMembershipGate } from '../server/project-membership-gate.js';
import { HostSessionCatalogChangeService } from '../server/session-catalog-change-service.js';

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
  const projectChanges = new HostProjectCatalogChangeService();
  const sessionChanges = new HostSessionCatalogChangeService();
  const projectFrames: unknown[] = [];
  const sessionFrames: unknown[] = [];
  projectChanges.attachConnection('desktop', {
    send: async (frame) => {
      projectFrames.push(frame);
    },
  });
  projectChanges.attachConnection('tui', {
    send: async (frame) => {
      projectFrames.push(frame);
    },
  });
  sessionChanges.attachConnection('desktop', {
    send: async (frame) => {
      sessionFrames.push(frame);
    },
  });
  const membership = new HostProjectMembershipGate();
  const coordinator = new HostProjectCatalogCoordinator(
    catalog,
    projectChanges,
    sessionChanges,
    membership,
    () => assert.fail('ordinary project mutations must not drain the Host'),
  );

  try {
    const original = await catalog.register(oldPath);
    await rename(oldPath, newPath);
    const destinationPath = await realpath(newPath);
    const duplicate = await catalog.register(newPath);
    const oldSession = await sessions.create(sessionInput(oldPath, original.id));
    const newSession = await sessions.create(sessionInput(destinationPath, duplicate.id));

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
    catalog.close();
    await sessions.close?.();
    await rm(base, { recursive: true, force: true });
  }
});

function sessionInput(cwd: string, projectId: string) {
  return {
    cwd,
    projectId,
    backend: 'fake' as const,
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask' as const,
  };
}

function connection(): ConnectionContext {
  return {
    hostEpoch: 'host-1',
    connectionId: 'desktop',
    surface: 'desktop',
    principal: 'local_os_user',
    acquireResidency: () => ({ release: () => {} }),
  };
}
