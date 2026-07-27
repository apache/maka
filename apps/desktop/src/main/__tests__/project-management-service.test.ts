import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createProjectCatalog, createSessionStore } from '@maka/storage';
import { createProjectManagementService } from '../project-management-service.js';

test('project management service owns selection and reversible lifecycle actions', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-service-'));
  const firstPath = join(base, 'first');
  const relocatedPath = join(base, 'relocated');
  await mkdir(firstPath);
  await mkdir(relocatedPath);
  const selectedPaths: string[] = [];
  let nextDirectory: string | undefined = firstPath;
  const catalog = createProjectCatalog(join(base, 'storage'), {
    now: () => 1_000,
    createId: () => 'project-1',
  });
  const service = createProjectManagementService({
    catalog,
    sessions: {
      listHeaders: async () => [],
      updateHeader: async () => {
        throw new Error('No sessions expected');
      },
    },
    chooseDirectory: async () => nextDirectory,
    getSelectedPath: async () => selectedPaths.at(-1) ?? (await realpath(firstPath)),
    setSelectedPath: (path) => selectedPaths.push(path),
  });

  try {
    const added = await service.add();
    assert.equal(added.ok, true);
    if (!added.ok) throw new Error('Expected an added project');
    assert.equal(added.project.id, 'project-1');
    assert.equal(added.path, await realpath(firstPath));
    assert.equal(selectedPaths.at(-1), added.project.preferredPath);

    assert.equal((await service.rename('project-1', '  Renamed  ')).name, 'Renamed');
    assert.equal((await service.archive('project-1')).archivedAt, 1_000);
    await assert.rejects(() => service.select('project-1'), /archived/i);
    assert.equal((await service.restore('project-1')).archivedAt, undefined);

    nextDirectory = relocatedPath;
    const selectionCountBeforeRelink = selectedPaths.length;
    const relinked = await service.relink('project-1');
    assert.equal(relinked.ok, true);
    if (!relinked.ok) throw new Error('Expected a relinked project');
    assert.equal(relinked.project.id, 'project-1');
    assert.equal(relinked.project.preferredPath, await realpath(relocatedPath));
    assert.equal(
      selectedPaths.length,
      selectionCountBeforeRelink + 1,
      'relinking the selected project keeps the current working directory usable',
    );
    assert.equal(selectedPaths.at(-1), await realpath(relocatedPath));

    const selected = await service.select('project-1');
    assert.equal(selected.project.id, 'project-1');
    assert.equal(selectedPaths.at(-1), await realpath(relocatedPath));

    nextDirectory = undefined;
    assert.deepEqual(await service.add(), { ok: false, reason: 'cancelled' });
    assert.deepEqual(await service.relink('project-1'), { ok: false, reason: 'cancelled' });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('project management service rejects malformed IPC identities before catalog access', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-service-input-'));
  const service = createProjectManagementService({
    catalog: createProjectCatalog(join(base, 'storage')),
    sessions: {
      listHeaders: async () => [],
      updateHeader: async () => {
        throw new Error('No sessions expected');
      },
    },
    chooseDirectory: async () => undefined,
    getSelectedPath: async () => base,
    setSelectedPath: () => {},
  });

  try {
    await assert.rejects(() => service.select(''), /Invalid project id/);
    assert.throws(() => service.rename('project-1', ''), /Invalid project name/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('relinking merges a project that was accidentally added from its new path', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-service-merge-'));
  const oldPath = join(base, 'old-location');
  const newPath = join(base, 'new-location');
  const storage = join(base, 'storage');
  await mkdir(oldPath);
  let nextDirectory: string | undefined = oldPath;
  let nextId = 0;
  const catalog = createProjectCatalog(storage, {
    now: () => 1_000,
    createId: () => `project-${++nextId}`,
  });
  const sessions = createSessionStore(storage);
  let failUpdateNumber: number | undefined;
  let updateCount = 0;
  const service = createProjectManagementService({
    catalog,
    sessions: {
      listHeaders: () => sessions.listHeaders(),
      updateHeader: async (sessionId, patch) => {
        updateCount += 1;
        if (updateCount === failUpdateNumber) {
          throw new Error('injected session reassignment failure');
        }
        return sessions.updateHeader(sessionId, patch);
      },
    },
    chooseDirectory: async () => nextDirectory,
    getSelectedPath: async () => (nextDirectory ? await realpath(nextDirectory) : base),
    setSelectedPath: () => {},
  });

  try {
    const original = await service.add();
    assert.equal(original.ok, true);
    if (!original.ok) throw new Error('Expected original project');
    await service.rename(original.project.id, 'Original name');
    await rename(oldPath, newPath);

    nextDirectory = newPath;
    const duplicate = await service.add();
    assert.equal(duplicate.ok, true);
    if (!duplicate.ok) throw new Error('Expected duplicate project');
    const oldSession = await sessions.create(
      makeSessionInput(oldPath, original.project.id, 'Old history'),
    );
    const newSession = await sessions.create(
      makeSessionInput(newPath, duplicate.project.id, 'New history'),
    );

    failUpdateNumber = 2;
    await assert.rejects(
      () => service.relink(original.project.id),
      /injected session reassignment failure/,
    );
    assert.deepEqual(
      (await catalog.list()).map((project) => project.id).sort(),
      [original.project.id, duplicate.project.id].sort(),
    );

    failUpdateNumber = undefined;
    updateCount = 0;
    const merged = await service.relink(original.project.id);

    assert.equal(merged.ok, true);
    if (!merged.ok) throw new Error('Expected merged project');
    assert.equal(merged.project.id, original.project.id);
    assert.equal(merged.project.name, 'Original name');
    assert.equal(merged.project.preferredPath, await realpath(newPath));
    assert.deepEqual(
      (await catalog.list()).map((project) => project.id),
      [original.project.id],
    );
    assert.equal(
      (await sessions.readHeaderSnapshot(oldSession.id)).projectId,
      original.project.id,
    );
    assert.equal(
      (await sessions.readHeaderSnapshot(oldSession.id)).cwd,
      await realpath(newPath),
    );
    assert.equal(
      (await sessions.readHeaderSnapshot(newSession.id)).projectId,
      original.project.id,
    );
  } finally {
    await sessions.close?.();
    await rm(base, { recursive: true, force: true });
  }
});

function makeSessionInput(cwd: string, projectId: string, name: string) {
  return {
    cwd,
    projectId,
    backend: 'fake' as const,
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask' as const,
    name,
    labels: [],
  };
}
