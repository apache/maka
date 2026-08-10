import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRuntimeHostProjectCatalog } from '../runtime-host-project-catalog.js';

test('reads every Project location through one stable Host catalog view', async () => {
  const project = {
    id: 'project-1',
    aliases: [],
    name: 'Project',
    locationCount: 2,
    archivedAt: null,
    available: true,
    locations: [
      { path: '/workspace/project', isWorktree: false },
      { path: '/workspace/worktree', isWorktree: true },
    ],
    preferredPath: '/workspace/project',
  } as const;
  let listCalls = 0;
  const catalog = createRuntimeHostProjectCatalog(() =>
    ({
      listProjects: async () => {
        listCalls += 1;
        return [project];
      },
      registerProject: async () => project,
    }) as never,
  );

  const expected = {
    id: 'project-1',
    name: 'Project',
    locations: [
      { path: '/workspace/project', isWorktree: false },
      { path: '/workspace/worktree', isWorktree: true },
    ],
    preferredPath: '/workspace/project',
    available: true,
  };
  assert.deepEqual(await catalog.list(), [expected]);
  assert.equal(listCalls, 1);
  assert.deepEqual(await catalog.register('/workspace/project'), expected);
  assert.equal(listCalls, 2);
});
