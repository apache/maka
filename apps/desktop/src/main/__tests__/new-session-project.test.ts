import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createProjectCatalog } from '@maka/storage';
import {
  resolveDesktopSessionSelection,
  resolveNewSessionProjectInput,
} from '../new-session-project.js';

test('default sessions inherit and register the current Desktop project', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-new-session-project-'));
  const cwd = join(base, 'project');
  await mkdir(cwd);
  const catalog = createProjectCatalog(join(base, 'storage'), {
    createId: () => 'project-1',
  });

  try {
    const selected = await resolveDesktopSessionSelection(
      {},
      {
        current: async () => ({ projectId: undefined, path: cwd }),
        select: async () => {
          throw new Error('select must not be called');
        },
      },
    );
    const resolved = await resolveNewSessionProjectInput(selected, catalog);

    assert.equal(resolved.cwd, cwd);
    assert.equal(resolved.projectId, 'project-1');
    assert.equal((await catalog.list()).length, 1);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('an explicit project selection resolves its path before Session creation', async () => {
  const selected = await resolveDesktopSessionSelection(
    { projectId: 'project-2' },
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

  assert.deepEqual(selected, {
    cwd: '/project-2/root',
    projectId: 'project-2',
  });
});

test('an explicit no-project Session keeps its directory unassigned', async () => {
  const input = { cwd: '/standalone', projectId: null } as const;
  const resolved = await resolveNewSessionProjectInput(input, {
    list: async () => {
      throw new Error('list must not be called');
    },
    register: async () => {
      throw new Error('register must not be called');
    },
    touch: async () => {
      throw new Error('touch must not be called');
    },
  });

  assert.equal(resolved, input);
});

test('a Session cannot associate a project with a different directory', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-new-session-project-mismatch-'));
  const first = join(base, 'first');
  const second = join(base, 'second');
  await mkdir(first);
  await mkdir(second);
  const catalog = createProjectCatalog(join(base, 'storage'), {
    createId: () => 'project-1',
  });

  try {
    await catalog.register(first);
    await assert.rejects(
      () =>
        resolveNewSessionProjectInput(
          { cwd: second, projectId: 'project-1' },
          catalog,
        ),
      /does not match/i,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
