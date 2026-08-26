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
import { createHash } from 'node:crypto';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { runtimeHostAccessCredentialFingerprintFromHash } from '../access-credential-identity.js';
import { readRuntimeHostAccessCredentialMetadata } from '../server/access-credential-metadata.js';
import {
  ACCESS_FILE_NAME,
  createAccessCredentialFile,
  readAccessCredentialFile,
  writeAccessCredentialFile,
  type StoredAccessCredential,
} from '../server/access-credential-store.js';

test('credential metadata inspection does not create missing State Roots', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'maka-access-metadata-'));
  t.after(() => rm(parent, { recursive: true, force: true }));

  for (const expectedRootId of [undefined, 'a'.repeat(64)]) {
    const root = join(parent, expectedRootId ? 'expected' : 'discovered');
    await assert.rejects(readRuntimeHostAccessCredentialMetadata(root, expectedRootId));
    await assert.rejects(access(root));
  }
});

test('credential metadata exposes only usable public access state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-access-metadata-'));
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  t.after(async () => {
    await owner.close();
    await rm(root, { recursive: true, force: true });
  });
  const activeSecret = 'maka_rh_active_secret';
  const pendingSecret = 'maka_rh_pending_secret';
  const expiredSecret = 'maka_rh_expired_secret';
  const revokedSecret = 'maka_rh_revoked_secret';
  const credential = (
    credentialId: string,
    secret: string,
    status: StoredAccessCredential['status'],
    expiresAt?: string,
  ): StoredAccessCredential => ({
    credentialId,
    credentialHash: createHash('sha256').update(secret).digest('hex'),
    principalId: `${credentialId}-client`,
    principalKind: 'remote_owner',
    status,
    operationGrants: ['host.status'],
    canPublishClientCapabilities: false,
    canUseHostPaths: false,
    createdAt: '2026-08-22T00:00:00.000Z',
    ...(expiresAt ? { expiresAt } : {}),
    ...(status === 'revoked' ? { revokedAt: '2026-08-22T00:01:00.000Z' } : {}),
  });
  const active = credential('active', activeSecret, 'active');
  const pending = credential(
    'pending',
    pendingSecret,
    'pending',
    new Date(Date.now() + 60_000).toISOString(),
  );
  const expired = credential(
    'expired',
    expiredSecret,
    'pending',
    new Date(Date.now() - 60_000).toISOString(),
  );
  const revoked = credential('revoked', revokedSecret, 'revoked');
  await writeAccessCredentialFile(
    join(owner.controlDirectory, ACCESS_FILE_NAME),
    createAccessCredentialFile([active, pending, expired, revoked]),
  );

  const metadata = await readRuntimeHostAccessCredentialMetadata(root, capability.rootId);

  assert.deepEqual(
    metadata.credentials.map(({ credentialId, credentialFingerprint, status }) => ({
      credentialId,
      credentialFingerprint,
      status,
    })),
    [
      {
        credentialId: 'active',
        credentialFingerprint: runtimeHostAccessCredentialFingerprintFromHash(
          active.credentialHash,
        ),
        status: 'active',
      },
      {
        credentialId: 'pending',
        credentialFingerprint: runtimeHostAccessCredentialFingerprintFromHash(
          pending.credentialHash,
        ),
        status: 'pending',
      },
    ],
  );
  const serialized = JSON.stringify(metadata);
  for (const sensitive of [
    activeSecret,
    pendingSecret,
    expiredSecret,
    revokedSecret,
    active.credentialHash,
    pending.credentialHash,
    expired.credentialHash,
    revoked.credentialHash,
  ]) {
    assert.equal(serialized.includes(sensitive), false);
  }
});

test('releases a retired execution.inspect.resolve grant from an existing access file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-access-retired-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, ACCESS_FILE_NAME);
  // A file written before the operation was removed still records the grant.
  // Decoding must release it rather than reject the whole file and keep the
  // Host from starting over a capability it can no longer serve.
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 1,
      credentials: [
        {
          credentialId: 'legacy',
          credentialHash: 'a'.repeat(64),
          principalId: 'desktop:legacy',
          principalKind: 'remote_owner',
          status: 'active',
          operationGrants: ['host.status', 'execution.inspect.resolve'],
          canPublishClientCapabilities: false,
          canUseHostPaths: false,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    }),
    'utf8',
  );

  const file = await readAccessCredentialFile(path);
  assert.deepEqual(file.credentials[0]?.operationGrants, ['host.status']);
});
