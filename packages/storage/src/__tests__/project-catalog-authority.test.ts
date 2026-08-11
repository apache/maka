import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  authenticateInteractiveProjectCatalogWriter,
  openInteractiveProjectCatalogForWrite,
} from '../project-catalog-authority.js';
import {
  resolveStorageRoot,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
} from '../root-authority.js';

test('Project Catalog writes require one live interactive root owner', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-catalog-authority-'));
  const dataRoot = join(base, 'data');
  const projectRoot = join(base, 'project');
  await mkdir(projectRoot);
  const capability = await resolveStorageRoot({ path: dataRoot, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  let writer: Awaited<ReturnType<typeof openInteractiveProjectCatalogForWrite>> | undefined;
  try {
    const [first, second] = await Promise.all([
      openInteractiveProjectCatalogForWrite(owner.lease),
      openInteractiveProjectCatalogForWrite(owner.lease),
    ]);
    writer = first;
    assert.equal(first, second);
    assert.equal(authenticateInteractiveProjectCatalogWriter(first), first);
    const project = await first.register(projectRoot);
    assert.equal((await second.list())[0]?.id, project.id);

    await owner.close();
    await assert.rejects(
      () => first.rename(project.id, 'Renamed'),
      (error: unknown) =>
        error instanceof StorageRootAuthorityError && error.code === 'invalid_lease',
    );
  } finally {
    writer?.close();
    if (!owner.closed) await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});
