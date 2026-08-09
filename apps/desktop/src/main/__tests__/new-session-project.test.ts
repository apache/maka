import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createProjectCatalog } from '@maka/storage';
import {
  resolveDesktopSessionSelection,
  resolveNewSessionProjectInput,
  type SessionProjectInput,
} from '../new-session-project.js';

type CreateSessionInput = SessionProjectInput & {
  cwd: string;
  backend: string;
  llmConnectionSlug: string;
  model: string;
  permissionMode: string;
  name: string;
  labels: string[];
};
type DesktopCreateSessionInput = Omit<CreateSessionInput, 'cwd'>;

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

    assert.equal(resolved.cwd, await realpath(cwd));
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
    await catalog.relinkWithSessions(original.id, cwd);

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

const BASE_SESSION: DesktopCreateSessionInput = {
  backend: 'fake',
  llmConnectionSlug: 'fake',
  model: 'fake-model',
  permissionMode: 'ask',
  name: 'Session',
  labels: [],
};

test('the configured default project beats the last-used one', async () => {
  // The point of the setting: something is almost always "last used", so a
  // default that yielded to it would never apply.
  const resolved = await resolveDesktopSessionSelection(
    { ...BASE_SESSION },
    {
      current: async () => ({ projectId: 'last-used', path: '/last/used' }),
      select: async (projectId) => ({
        project: { id: projectId as string },
        path: '/default/project',
      }),
      defaultProjectId: async () => 'default-project',
    },
  );

  assert.equal(resolved.cwd, '/default/project');
  assert.equal(resolved.projectId, 'default-project');
});

test('an explicit project id still overrides the configured default', async () => {
  // The composer picker has to be able to take one conversation elsewhere,
  // otherwise setting a default would trap every new chat in it.
  const resolved = await resolveDesktopSessionSelection(
    { ...BASE_SESSION, projectId: 'picked-for-this-chat' },
    {
      current: async () => {
        throw new Error('current must not be called');
      },
      select: async (projectId) => ({
        project: { id: projectId as string },
        path: `/${projectId as string}`,
      }),
      defaultProjectId: async () => {
        throw new Error('the default must not be consulted for an explicit pick');
      },
    },
  );

  assert.equal(resolved.projectId, 'picked-for-this-chat');
});

test('no configured default leaves the last-used behaviour untouched', async () => {
  const resolved = await resolveDesktopSessionSelection(
    { ...BASE_SESSION },
    {
      current: async () => ({ projectId: 'last-used', path: '/last/used' }),
      select: async () => {
        throw new Error('select must not be called');
      },
      defaultProjectId: async () => undefined,
    },
  );

  assert.equal(resolved.cwd, '/last/used');
  assert.equal(resolved.projectId, 'last-used');
});

test('a default project that no longer resolves falls back instead of failing the create', async () => {
  // Archived, or its folder was deleted after it was chosen. Creating a
  // session must still succeed — refusing to start a conversation because a
  // preference went stale would be the worst possible reading of "default".
  const resolved = await resolveDesktopSessionSelection(
    { ...BASE_SESSION },
    {
      current: async () => ({ projectId: 'last-used', path: '/last/used' }),
      select: async () => {
        throw new Error('No such project: removed-project');
      },
      defaultProjectId: async () => 'removed-project',
    },
  );

  assert.equal(resolved.cwd, '/last/used');
  assert.equal(resolved.projectId, 'last-used');
});
