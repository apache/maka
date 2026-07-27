import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CreateSessionInput } from '@maka/core';
import { createProjectCatalog } from '@maka/storage';
import { resolveNewSessionProjectInput } from '../new-session-project.js';

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
    assert.equal(Object.hasOwn(unassigned, 'projectId'), false);
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
