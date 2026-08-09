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
    selection: {
      currentSelection: async () => ({
        projectId: 'project-1',
        path: selectedPaths.at(-1) ?? (await realpath(firstPath)),
      }),
      setSelection: (_projectId, path) => selectedPaths.push(path),
    },
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
    assert.ok(selected.project);
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
    selection: {
      currentSelection: async () => ({ projectId: undefined, path: base }),
      setSelection: () => {},
    },
  });

  try {
    await assert.rejects(() => service.select(''), /Invalid project id/);
    assert.throws(() => service.rename('project-1', ''), /Invalid project name/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('project management service resolves a legacy path into one canonical selection', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-service-selection-'));
  const projectPath = join(base, 'project');
  await mkdir(projectPath);
  const catalog = createProjectCatalog(join(base, 'storage'), {
    createId: () => 'project-1',
  });
  await catalog.register(projectPath);
  const savedSelections: Array<{ projectId: string | null; projectPath: string }> = [];
  const service = createProjectManagementService({
    catalog,
    chooseDirectory: async () => undefined,
    selection: {
      currentSelection: async () => ({
        projectId: undefined,
        path: await realpath(projectPath),
      }),
      setSelection: (projectId, path) => {
        savedSelections.push({ projectId, projectPath: path });
      },
    },
  });

  try {
    assert.deepEqual(await service.current(), {
      projectId: 'project-1',
      path: await realpath(projectPath),
    });
    assert.deepEqual(savedSelections, [
      {
        projectId: 'project-1',
        projectPath: await realpath(projectPath),
      },
    ]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('project management service persists an explicit no-project selection in main', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-service-no-project-'));
  const projectPath = join(base, 'project');
  await mkdir(projectPath);
  const savedSelections: Array<{ projectId: string | null; projectPath: string }> = [];
  const service = createProjectManagementService({
    catalog: createProjectCatalog(join(base, 'storage')),
    chooseDirectory: async () => undefined,
    selection: {
      currentSelection: async () => ({
        projectId: undefined,
        path: await realpath(projectPath),
      }),
      setSelection: (projectId, path) => {
        savedSelections.push({ projectId, projectPath: path });
      },
    },
  });

  try {
    assert.deepEqual(await service.select(null), {
      project: null,
      path: await realpath(projectPath),
    });
    assert.deepEqual(savedSelections, [
      {
        projectId: null,
        projectPath: await realpath(projectPath),
      },
    ]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('archiving the current project resolves fallback or no-project inside main', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-service-archive-selection-'));
  const firstPath = join(base, 'first');
  const secondPath = join(base, 'second');
  await mkdir(firstPath);
  await mkdir(secondPath);
  let now = 1_000;
  let id = 0;
  const catalog = createProjectCatalog(join(base, 'storage'), {
    now: () => now,
    createId: () => `project-${++id}`,
  });
  const first = await catalog.register(firstPath);
  now = 2_000;
  const second = await catalog.register(secondPath);
  let selection = {
    projectId: second.id as string | null | undefined,
    path: await realpath(secondPath),
  };
  const service = createProjectManagementService({
    catalog,
    chooseDirectory: async () => undefined,
    selection: {
      currentSelection: async () => selection,
      setSelection: (projectId, path) => {
        selection = { projectId, path };
      },
    },
  });

  try {
    await service.archive(second.id);
    assert.deepEqual(selection, {
      projectId: first.id,
      path: await realpath(firstPath),
    });

    selection = { projectId: second.id, path: await realpath(secondPath) };
    assert.deepEqual(await service.current(), {
      projectId: first.id,
      path: await realpath(firstPath),
    });

    await service.archive(first.id);
    assert.deepEqual(selection, {
      projectId: null,
      path: await realpath(firstPath),
    });

    selection = { projectId: first.id, path: await realpath(firstPath) };
    assert.deepEqual(await service.current(), {
      projectId: null,
      path: await realpath(firstPath),
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
