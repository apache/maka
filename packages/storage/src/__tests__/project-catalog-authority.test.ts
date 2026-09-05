/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  authenticateInteractiveProjectCatalogWriter,
  openInteractiveProjectCatalogForWrite,
} from '../project-catalog-authority.js';
import {
  resolveStorageRoot,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
} from '../root-authority.js';
import {
  removeTrackedControlDirectories,
  trackControlDirectory,
} from './fixtures/control-directory-hygiene.js';

// The control directory of each resolved root lives outside that root, so a
// temporary root's removal leaves it behind; reclaim the recorded rootIds here.
after(removeTrackedControlDirectories);

test('Project Catalog writes require one live interactive root owner', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-catalog-authority-'));
  const dataRoot = join(base, 'data');
  const projectRoot = join(base, 'project');
  await mkdir(projectRoot);
  const capability = trackControlDirectory(
    await resolveStorageRoot({ path: dataRoot, kind: 'interactive' }),
  );
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
