import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createProjectCatalog, type ProjectCatalog } from '@maka/storage';
import {
  createProjectManagementService,
  type ProjectManagementCatalog,
} from '../project-management-service.js';

const LOCAL_CAPABILITIES = {
  chooseClientDirectory: true,
  selectNoProject: true,
  setLocalDefault: true,
  viewClientPath: true,
} as const;
const REMOTE_CAPABILITIES = {
  chooseClientDirectory: false,
  selectNoProject: false,
  setLocalDefault: false,
  viewClientPath: false,
} as const;

test('owns Project selection and reversible lifecycle actions in Desktop', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-service-'));
  const firstPath = join(base, 'first');
  const relocatedPath = join(base, 'relocated');
  await Promise.all([mkdir(firstPath), mkdir(relocatedPath)]);
  const selectedPaths: string[] = [];
  let nextDirectory: string | undefined = firstPath;
  const catalog = createProjectCatalog(join(base, 'storage'), {
    now: () => 1_000,
    createId: () => 'project-1',
  });
  const service = createProjectManagementService({
    capabilities: LOCAL_CAPABILITIES,
    catalog: managementCatalog(catalog),
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
    if (!added.ok) assert.fail('Expected an added Project');
    assert.equal(added.project.id, 'project-1');
    assert.equal(added.path, await realpath(firstPath));

    assert.equal((await service.rename('project-1', '  Renamed  ')).name, 'Renamed');
    assert.equal((await service.archive('project-1')).archivedAt, 1_000);
    assert.equal((await service.select('project-1')).project, null);
    await service.restore('project-1');

    nextDirectory = relocatedPath;
    const relinked = await service.relink('project-1');
    assert.equal(relinked.ok, true);
    assert.equal(selectedPaths.at(-1), await realpath(relocatedPath));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('rejects malformed Project identities before catalog access', async () => {
  const service = createProjectManagementService({
    capabilities: LOCAL_CAPABILITIES,
    catalog: {
      list: unexpected,
      register: unexpected,
      relink: unexpected,
      rename: unexpected,
      archive: unexpected,
      restore: unexpected,
    },
    chooseDirectory: async () => undefined,
    selection: {
      currentSelection: async () => ({ projectId: undefined, path: '/workspace' }),
      setSelection() {},
    },
  });

  await assert.rejects(() => service.select(''), /Invalid project id/);
  assert.throws(() => service.rename('project-1', ''), /Invalid project name/);
});

test('keeps an explicit no-Project selection local to Desktop', async () => {
  const selections: Array<{ projectId: string | null; path: string }> = [];
  const service = createProjectManagementService({
    capabilities: LOCAL_CAPABILITIES,
    catalog: {
      list: unexpected,
      register: unexpected,
      relink: unexpected,
      rename: unexpected,
      archive: unexpected,
      restore: unexpected,
    },
    chooseDirectory: async () => undefined,
    selection: {
      currentSelection: async () => ({ projectId: undefined, path: '/workspace' }),
      setSelection: (projectId, path) => selections.push({ projectId, path }),
    },
  });

  assert.deepEqual(await service.select(null), { project: null, path: '/workspace' });
  assert.deepEqual(selections, [{ projectId: null, path: '/workspace' }]);
});

test('does not silently replace a stale Project preference with another Project', async () => {
  const selections: Array<{ projectId: string | null; path: string }> = [];
  const service = createProjectManagementService({
    capabilities: LOCAL_CAPABILITIES,
    catalog: {
      list: async () => [
        { id: 'other', name: 'Other', locations: [], available: true },
      ],
      register: unexpected,
      relink: unexpected,
      rename: unexpected,
      archive: unexpected,
      restore: unexpected,
    },
    chooseDirectory: async () => undefined,
    selection: {
      currentSelection: async () => ({ projectId: 'missing', path: '/last-known' }),
      setSelection: (projectId, path) => selections.push({ projectId, path }),
    },
  });

  assert.deepEqual(await service.current(), { projectId: null, path: '/last-known' });
  assert.deepEqual(selections, [{ projectId: null, path: '/last-known' }]);
});

test('does not expose Client directory actions for a remote Host', async () => {
  let pickerCalls = 0;
  const service = createProjectManagementService({
    capabilities: REMOTE_CAPABILITIES,
    catalog: {
      list: async () => [
        {
          id: 'remote',
          name: 'Remote',
          locations: [],
          available: true,
        },
      ],
      register: unexpected,
      relink: unexpected,
      rename: unexpected,
      archive: unexpected,
      restore: unexpected,
    },
    chooseDirectory: async () => {
      pickerCalls += 1;
      return '/client/path';
    },
    selection: {
      currentSelection: async () => ({ projectId: 'remote', path: '/host/project' }),
      setSelection() {},
    },
  });

  await assert.rejects(() => service.add(), /registered on the Host/);
  await assert.rejects(() => service.relink('remote'), /registered on the Host/);
  await assert.rejects(() => service.select(null), /requires a Project/);
  assert.equal(await service.pathFor('remote'), null);
  assert.deepEqual((await service.getSnapshot()).capabilities, REMOTE_CAPABILITIES);
  assert.deepEqual(await service.select('remote'), {
    project: {
      id: 'remote',
      name: 'Remote',
      locations: [],
      available: true,
    },
    path: '/host/project',
  });
  assert.equal(pickerCalls, 0);
});

function managementCatalog(catalog: ProjectCatalog): ProjectManagementCatalog {
  return {
    list: () => catalog.list(),
    register: (path) => catalog.register(path),
    relink: async (projectId, path) => (await catalog.relinkWithSessions(projectId, path)).project,
    rename: (projectId, name) => catalog.rename(projectId, name),
    archive: (projectId) => catalog.archive(projectId),
    restore: (projectId) => catalog.restore(projectId),
  };
}

async function unexpected(): Promise<never> {
  throw new Error('Unexpected call');
}
