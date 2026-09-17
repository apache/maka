/* Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See the NOTICE file distributed with this
 * work for additional information regarding copyright ownership. The ASF
 * licenses this file to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  prepareStorageRootControlDirectory,
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import { prepareManagedFilesDevHelper } from '../test-only/managed-files-dev-bootstrap.js';
import { requireGitoxideHelperArtifactIdentityInternal } from '../server/gitoxide-helper-artifact-authority-internal.js';

test('explicit development bootstrap pins the selected helper bytes', async (t) => {
  if (!process.env.MAKA_GITOXIDE_HELPER_PATH) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required');
    return;
  }
  const executablePath = await realpath(process.env.MAKA_GITOXIDE_HELPER_PATH);
  const bytes = await readFile(executablePath);
  const expectedSha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const manifest = {
    schemaVersion: 1,
    executablePath,
    expectedBytes: bytes.length,
    expectedSha256,
    platform: process.platform,
    arch: process.arch,
  };
  const helper = await prepareManagedFilesDevHelper(JSON.stringify(manifest));
  assert.equal(
    requireGitoxideHelperArtifactIdentityInternal(
      helper.invocationOwnerToken,
      helper.helperCapability,
    ).sha256,
    expectedSha256,
  );
  await assert.rejects(
    prepareManagedFilesDevHelper(
      JSON.stringify({ ...manifest, expectedSha256: `sha256:${'0'.repeat(64)}` }),
    ),
    /identity|match/i,
  );
});

test('development bootstrap rejects absent or malformed configuration', async () => {
  for (const value of [undefined, '', '{}', 'null', '[]', 'x'.repeat(8193)]) {
    await assert.rejects(
      prepareManagedFilesDevHelper(value),
      /Invalid development helper manifest/,
    );
  }
});

test('development candidate admits configuration only after winning root ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-dev-candidate-'));
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
  const entry = fileURLToPath(
    new URL('../test-only/managed-files-candidate-main.js', import.meta.url),
  );
  const run = () =>
    spawnSync(
      process.execPath,
      [
        entry,
        '--root',
        root,
        '--expected-root-id',
        capability.rootId,
        '--startup-attempt-id',
        randomUUID(),
      ],
      {
        encoding: 'utf8',
        timeout: 20_000,
        windowsHide: true,
        env: { ...process.env, MAKA_MANAGED_FILES_DEV_HELPER: '{}' },
      },
    );
  try {
    const winner = run();
    assert.equal(winner.status, 70, winner.stderr);
    assert.match(winner.stderr, /Invalid development helper manifest/);
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    try {
      const loser = run();
      assert.equal(loser.status, 2, loser.stderr);
      assert.equal(loser.stderr, '');
    } finally {
      await owner.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(controlDirectory, { recursive: true, force: true });
  }
});
