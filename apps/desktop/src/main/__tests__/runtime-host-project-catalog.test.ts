import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRuntimeHostProjectCatalog } from '../runtime-host-project-catalog.js';

test('adds Host-authorized paths only in the Desktop adapter', async () => {
  const project = {
    id: 'project-1',
    aliases: [],
    name: 'Project',
    locationCount: 2,
    archivedAt: null,
    available: true,
  } as const;
  const catalog = createRuntimeHostProjectCatalog(() =>
    ({
      listProjects: async () => [project],
      registerProject: async () => project,
      projectLocations: async () => ({
        projectId: 'project-1',
        locations: [
          { path: '/workspace/project', isWorktree: false },
          { path: '/workspace/worktree', isWorktree: true },
        ],
        preferredPath: '/workspace/project',
      }),
    }) as never,
  );

  assert.deepEqual(await catalog.list(), [
    {
      id: 'project-1',
      name: 'Project',
      locations: [
        { path: '/workspace/project', isWorktree: false },
        { path: '/workspace/worktree', isWorktree: true },
      ],
      preferredPath: '/workspace/project',
      available: true,
    },
  ]);
  assert.deepEqual(await catalog.register('/workspace/project'), (await catalog.list())[0]);
});
