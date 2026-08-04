import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CreateSessionInput } from '@maka/core';
import { createProjectCatalog } from '@maka/storage';
import {
  resolveDesktopSessionSelection,
  resolveNewSessionProjectInput,
} from '../new-session-project.js';

test('default sessions inherit the main-owned project selection', async () => {
  const resolved = await resolveDesktopSessionSelection(
    {
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
      name: 'Session',
      labels: [],
    },
    {
      current: async () => ({ projectId: null, path: '/current/root' }),
      select: async () => {
        throw new Error('select must not be called');
      },
    },
  );

  assert.equal(resolved.cwd, '/current/root');
  assert.equal(resolved.projectId, null);
});

test('an explicit project id resolves its matching path before session creation', async () => {
  const resolved = await resolveDesktopSessionSelection(
    {
      projectId: 'project-2',
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
      name: 'Session',
      labels: [],
    },
    {
      current: async () => {
        throw new Error('current must not be called');
      },
      select: async (projectId) => ({
        project: { id: projectId as string },
        path: '/project-2/root',
      }),
    },
  );

  assert.equal(resolved.cwd, '/project-2/root');
  assert.equal(resolved.projectId, 'project-2');
});

test('new sessions auto-register a project while explicit no-project sessions stay unassigned', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-new-session-project-'));
  const cwd = join(base, 'project');
  await mkdir(cwd);
  const catalog = createProjectCatalog(join(base, 'storage'), {
    createId: () => 'project-1',
  });

  try {
    const automatic = await resolveNewSessionProjectInput(makeInput(cwd), catalog);
    assert.equal(automatic.projectId, 'project-1');
    assert.equal((await catalog.list()).length, 1);

    const explicit = await resolveNewSessionProjectInput(
      makeInput(cwd, { projectId: 'project-1' }),
      catalog,
    );
    assert.equal(explicit.projectId, 'project-1');

    const unassigned = await resolveNewSessionProjectInput(
      makeInput(cwd, { projectId: null }),
      catalog,
    );
    assert.equal(unassigned.projectId, null);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('new sessions reject a project id that does not own the selected directory', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-new-session-project-mismatch-'));
  const cwd = join(base, 'project');
  await mkdir(cwd);
  const catalog = createProjectCatalog(join(base, 'storage'), {
    createId: () => 'project-1',
  });

  try {
    await catalog.register(cwd);
    await assert.rejects(
      () => resolveNewSessionProjectInput(makeInput(cwd, { projectId: 'project-2' }), catalog),
      /does not match/i,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('new sessions preserve unexpected catalog failures', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-new-session-project-storage-failure-'));
  const cwd = join(base, 'project');
  await mkdir(cwd);
  const catalog = createProjectCatalog(join(base, 'storage'), {
    createId: () => 'project-1',
  });

  try {
    await catalog.register(cwd);
    const storageFailure = new Error('catalog write failed');
    await assert.rejects(
      () =>
        resolveNewSessionProjectInput(makeInput(cwd, { projectId: 'project-1' }), {
          list: () => catalog.list(),
          register: (path) => catalog.register(path),
          touch: async () => {
            throw storageFailure;
          },
        }),
      (error) => error === storageFailure,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('new sessions persist the catalog canonical path instead of a symlink alias', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-new-session-project-canonical-'));
  const projectPath = join(base, 'project');
  const aliasPath = join(base, 'project-alias');
  await mkdir(projectPath);
  await symlink(projectPath, aliasPath, 'dir');
  const catalog = createProjectCatalog(join(base, 'storage'), {
    createId: () => 'project-1',
  });

  try {
    const project = await catalog.register(projectPath);
    const resolved = await resolveNewSessionProjectInput(
      makeInput(aliasPath, { projectId: project.id }),
      catalog,
    );

    assert.equal(resolved.cwd, await realpath(projectPath));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('new sessions resolve a merged project alias to the surviving project id', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-new-session-project-merged-alias-'));
  const cwd = join(base, 'relocated');
  await mkdir(cwd);
  let id = 0;
  const catalog = createProjectCatalog(join(base, 'storage'), {
    createId: () => `project-${++id}`,
  });

  try {
    const originalPath = join(base, 'original');
    await mkdir(originalPath);
    const original = await catalog.register(originalPath);
    await rm(originalPath, { recursive: true, force: true });
    const duplicate = await catalog.register(cwd);
    await catalog.relink(original.id, cwd, async () => {});

    const resolved = await resolveNewSessionProjectInput(
      makeInput(cwd, { projectId: duplicate.id }),
      catalog,
    );

    assert.equal(resolved.projectId, original.id);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

function makeInput(
  cwd: string,
  overrides: Partial<CreateSessionInput> = {},
): CreateSessionInput {
  return {
    cwd,
    backend: 'fake',
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask',
    name: 'Session',
    labels: [],
    ...overrides,
  };
}
