import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { createProjectCatalog, type ProjectCatalog } from '@maka/storage';
import {
  createProjectManagementService,
  type ProjectManagementCatalog,
} from '../project-management-service.js';

const LOCAL_CAPABILITIES = {
  chooseClientDirectory: true,
  chooseHostDirectory: false,
  selectNoProject: true,
  setLocalDefault: true,
  viewClientPath: true,
} as const;
const REMOTE_CAPABILITIES = {
  chooseClientDirectory: false,
  chooseHostDirectory: true,
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

test('adding a nested folder selects that folder instead of the parent project', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-nested-add-'));
  const parentPath = join(base, 'parent-project');
  const childPath = join(parentPath, 'child-project');
  await mkdir(childPath, { recursive: true });
  await execFileAsync('git', ['init', '--quiet'], { cwd: parentPath });

  const selected: string[] = [];
  let nextDirectory = parentPath;
  let nextId = 0;
  const catalog = createProjectCatalog(join(base, 'storage'), {
    now: () => 1_000,
    createId: () => `project-${++nextId}`,
  });
  const service = createProjectManagementService({
    capabilities: LOCAL_CAPABILITIES,
    catalog: managementCatalog(catalog),
    chooseDirectory: async () => nextDirectory,
    selection: {
      currentSelection: async () => ({ projectId: undefined, path: parentPath }),
      setSelection: (_projectId, path) => selected.push(path),
    },
  });

  try {
    const parent = await service.add();
    assert.equal(parent.ok, true);
    if (!parent.ok) return;
    assert.equal(parent.path, await realpath(parentPath));

    nextDirectory = childPath;
    const child = await service.add();
    assert.equal(child.ok, true);
    if (!child.ok) return;
    assert.notEqual(child.project.id, parent.project.id);
    assert.equal(child.path, await realpath(childPath));
    assert.equal(selected.at(-1), await realpath(childPath));
  } finally {
    catalog.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('can register a draft Project without changing the Host selection', async () => {
  let selected = false;
  const service = createProjectManagementService({
    capabilities: LOCAL_CAPABILITIES,
    catalog: {
      list: unexpected,
      register: async (path) => ({
        id: 'project-1',
        name: 'Project',
        locations: [{ path, available: true, isWorktree: false }],
        preferredPath: path,
        available: true,
      }),
      relink: unexpected,
      rename: unexpected,
      archive: unexpected,
      restore: unexpected,
    },
    chooseDirectory: async () => '/workspace',
    selection: {
      currentSelection: async () => ({ projectId: undefined, path: '/current' }),
      setSelection: () => {
        selected = true;
      },
    },
  });

  assert.equal((await service.add({ select: false })).ok, true);
  assert.equal(selected, false);
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
      list: async () => [{ id: 'other', name: 'Other', locations: [], available: true }],
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
  const directoryRequests: unknown[] = [];
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
    directoryCatalog: {
      listDirectoryRoots: async () => [{ id: 'home', label: '~' }],
      listDirectories: async (rootId, segments) => {
        directoryRequests.push({ rootId, segments });
        return [{ name: 'project' }];
      },
      registerDirectory: async (rootId, segments) => {
        directoryRequests.push({ rootId, segments, register: true });
        return { id: 'added', name: 'Added', locations: [], available: true };
      },
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
  assert.deepEqual(await service.directoryRoots(), [{ id: 'home', label: '~' }]);
  assert.deepEqual(
    await service.listDirectory({ rootId: 'home', segments: ['work'] }),
    [{ name: 'project' }],
  );
  assert.equal(
    (await service.registerDirectory({ rootId: 'home', segments: ['work', 'project'] })).id,
    'added',
  );
  assert.deepEqual(directoryRequests, [
    { rootId: 'home', segments: ['work'] },
    { rootId: 'home', segments: ['work', 'project'], register: true },
  ]);
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
