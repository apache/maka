import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createProjectCatalog } from '@maka/storage';
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
    chooseDirectory: async () => nextDirectory,
    setSelectedPath: (path) => selectedPaths.push(path),
  });

  try {
    const added = await service.add();
    assert.equal(added.ok, true);
    if (!added.ok) throw new Error('Expected an added project');
    assert.equal(added.project.id, 'project-1');
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
      selectionCountBeforeRelink,
      'relinking updates the catalog without silently changing the selected project',
    );

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
    chooseDirectory: async () => undefined,
    setSelectedPath: () => {},
  });

  try {
    await assert.rejects(() => service.select(''), /Invalid project id/);
    assert.throws(() => service.rename('project-1', ''), /Invalid project name/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
