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
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  createEncryptedFileManagedSecretStore,
  type EncryptedFileManagedSecretKey,
  type EncryptedFileManagedSecretKeyProvider,
  MANAGED_SECRET_DOCUMENT_FILE,
  MANAGED_SECRET_DOCUMENT_SCHEMA_VERSION,
} from '../encrypted-file-managed-secret-store.js';
import {
  InMemoryManagedSecretStore,
  ManagedSecretError,
  type ManagedSecretStore,
} from '../managed-secret-store.js';

const PRINCIPAL = 'user-1';
const SOURCE_SESSION = 'cloud-session-source';
const TARGET_SESSION = 'cloud-session-target';
const ACTIVATION = 'activation-1';
const SECRET_ONE = '00000000-0000-4000-8000-000000000001';
const SECRET_TWO = '00000000-0000-4000-8000-000000000002';

interface StoreHarness {
  readonly store: ManagedSecretStore;
  close(): Promise<void>;
}

const harnesses: readonly [string, () => Promise<StoreHarness>][] = [
  [
    'in-memory',
    async () => ({
      store: new InMemoryManagedSecretStore({ newSecretId: sequenceIds() }),
      async close() {},
    }),
  ],
  [
    'encrypted-file',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'maka-managed-secrets-'));
      return {
        store: createEncryptedFileManagedSecretStore({
          controlPlaneRoot: root,
          keyProvider: new TestKeyProvider(),
          newSecretId: sequenceIds(),
        }),
        close: () => rm(root, { recursive: true, force: true }),
      };
    },
  ],
];

for (const [name, createHarness] of harnesses) {
  describe(`${name} ManagedSecretStore`, () => {
    test('requires an explicit target-Session authorization for copied references', async () => {
      await withHarness(createHarness, async ({ store }) => {
        const secret = await store.createSecret({ principalId: PRINCIPAL, value: 'source-value' });

        await assertRejectCode(
          store.resolveForActivation({
            context: activationContext(SOURCE_SESSION),
            references: [secret.reference],
          }),
          'unauthorized',
        );

        await store.authorizeSession({
          principalId: PRINCIPAL,
          reference: secret.reference,
          cloudSessionId: SOURCE_SESSION,
        });
        assert.equal(
          (
            await store.resolveForActivation({
              context: activationContext(SOURCE_SESSION),
              references: [secret.reference],
            })
          )[0]?.value,
          'source-value',
        );

        // A Fork may copy this reference, but the target has no implicit grant.
        await assertRejectCode(
          store.resolveForActivation({
            context: activationContext(TARGET_SESSION),
            references: [secret.reference],
          }),
          'unauthorized',
        );
        await store.authorizeSession({
          principalId: PRINCIPAL,
          reference: secret.reference,
          cloudSessionId: TARGET_SESSION,
        });
        assert.equal(
          (
            await store.resolveForActivation({
              context: activationContext(TARGET_SESSION),
              references: [secret.reference],
            })
          )[0]?.value,
          'source-value',
        );
      });
    });

    test('rotates behind a stable reference and rejects a stale CAS basis', async () => {
      await withHarness(createHarness, async ({ store }) => {
        const created = await store.createSecret({ principalId: PRINCIPAL, value: 'version-one' });
        await store.authorizeSession({
          principalId: PRINCIPAL,
          reference: created.reference,
          cloudSessionId: SOURCE_SESSION,
        });

        const rotated = await store.rotateSecret({
          principalId: PRINCIPAL,
          reference: created.reference,
          expectedRevision: created.revision,
          value: 'version-two',
        });
        assert.equal(rotated.kind, 'committed');
        if (rotated.kind !== 'committed') return;
        assert.deepEqual(rotated.secret.reference, created.reference);
        assert.equal(rotated.secret.revision, 2);

        assert.deepEqual(
          await store.rotateSecret({
            principalId: PRINCIPAL,
            reference: created.reference,
            expectedRevision: created.revision,
            value: 'stale-write',
          }),
          { kind: 'revision_conflict', actualRevision: 2 },
        );
        const resolved = await store.resolveForActivation({
          context: activationContext(SOURCE_SESSION),
          references: [created.reference],
        });
        assert.equal(resolved[0]?.revision, 2);
        assert.equal(resolved[0]?.value, 'version-two');
      });
    });

    test('revocation and grant removal affect later Activations without changing references', async () => {
      await withHarness(createHarness, async ({ store }) => {
        const first = await store.createSecret({ principalId: PRINCIPAL, value: 'revocable' });
        await store.authorizeSession({
          principalId: PRINCIPAL,
          reference: first.reference,
          cloudSessionId: SOURCE_SESSION,
        });
        await store.revokeSessionAuthorization({
          principalId: PRINCIPAL,
          reference: first.reference,
          cloudSessionId: SOURCE_SESSION,
        });
        await assertRejectCode(
          store.resolveForActivation({
            context: activationContext(SOURCE_SESSION),
            references: [first.reference],
          }),
          'unauthorized',
        );

        await store.authorizeSession({
          principalId: PRINCIPAL,
          reference: first.reference,
          cloudSessionId: SOURCE_SESSION,
        });
        const revoked = await store.revokeSecret({
          principalId: PRINCIPAL,
          reference: first.reference,
          expectedRevision: first.revision,
        });
        assert.equal(revoked.kind, 'committed');
        await assertRejectCode(
          store.resolveForActivation({
            context: activationContext(SOURCE_SESSION),
            references: [first.reference],
          }),
          'secret_revoked',
        );
      });
    });

    test('deletion removes material and target grants without retaining a tombstone', async () => {
      await withHarness(createHarness, async ({ store }) => {
        const first = await store.createSecret({ principalId: PRINCIPAL, value: 'delete-me' });
        await store.authorizeSession({
          principalId: PRINCIPAL,
          reference: first.reference,
          cloudSessionId: SOURCE_SESSION,
        });
        const deleted = await store.deleteSecret({
          principalId: PRINCIPAL,
          reference: first.reference,
          expectedRevision: first.revision,
        });
        assert.equal(deleted.kind, 'committed');
        if (deleted.kind === 'committed') assert.equal(deleted.secret.status, 'deleted');
        assert.equal(
          await store.getSecretMetadata({ principalId: PRINCIPAL, reference: first.reference }),
          null,
        );
        await assertRejectCode(
          store.resolveForActivation({
            context: activationContext(SOURCE_SESSION),
            references: [first.reference],
          }),
          'secret_not_found',
        );
      });
    });

    test('does not expose secret material through metadata or unauthorized principals', async () => {
      await withHarness(createHarness, async ({ store }) => {
        const value = 'metadata-must-not-contain-this';
        const created = await store.createSecret({ principalId: PRINCIPAL, value });
        assert.equal(JSON.stringify(created).includes(value), false);
        assert.equal(
          JSON.stringify(
            await store.getSecretMetadata({ principalId: PRINCIPAL, reference: created.reference }),
          ).includes(value),
          false,
        );
        await assertRejectCode(
          store.getSecretMetadata({
            principalId: 'another-user',
            reference: created.reference,
          }),
          'unauthorized',
        );
      });
    });
  });
}

describe('encrypted file ManagedSecretStore security boundary', () => {
  test('keeps mutation timestamps monotonic when the wall clock moves backwards', async () => {
    await withTempRoot(async (root) => {
      let now = 1_000;
      const ids = [generatedSecretId(1), generatedSecretId(2), generatedSecretId(3)];
      const store = createEncryptedFileManagedSecretStore({
        controlPlaneRoot: root,
        keyProvider: new TestKeyProvider(),
        now: () => now,
        newSecretId: () => ids.shift()!,
      });
      const rotating = await store.createSecret({ principalId: PRINCIPAL, value: 'rotate' });
      const revoking = await store.createSecret({ principalId: PRINCIPAL, value: 'revoke' });
      const deleting = await store.createSecret({ principalId: PRINCIPAL, value: 'delete' });

      now = 900;
      const rotated = await store.rotateSecret({
        principalId: PRINCIPAL,
        reference: rotating.reference,
        expectedRevision: rotating.revision,
        value: 'rotated',
      });
      const revoked = await store.revokeSecret({
        principalId: PRINCIPAL,
        reference: revoking.reference,
        expectedRevision: revoking.revision,
      });
      const deleted = await store.deleteSecret({
        principalId: PRINCIPAL,
        reference: deleting.reference,
        expectedRevision: deleting.revision,
      });
      for (const result of [rotated, revoked, deleted]) {
        assert.equal(result.kind, 'committed');
        if (result.kind === 'committed') assert.equal(result.secret.updatedAt, 1_000);
      }

      const reopened = createEncryptedFileManagedSecretStore({
        controlPlaneRoot: root,
        keyProvider: new TestKeyProvider(),
      });
      assert.equal(
        (
          await reopened.getSecretMetadata({
            principalId: PRINCIPAL,
            reference: rotating.reference,
          })
        )?.updatedAt,
        1_000,
      );
      assert.equal(
        (
          await reopened.getSecretMetadata({
            principalId: PRINCIPAL,
            reference: revoking.reference,
          })
        )?.updatedAt,
        1_000,
      );
      assert.equal(
        await reopened.getSecretMetadata({
          principalId: PRINCIPAL,
          reference: deleting.reference,
        }),
        null,
      );
    });
  });

  test('physically removes deleted records and grants so capacity is reusable', async () => {
    await withTempRoot(async (root) => {
      const ids = [SECRET_ONE, SECRET_TWO];
      const path = join(root, MANAGED_SECRET_DOCUMENT_FILE);
      const store = createEncryptedFileManagedSecretStore({
        controlPlaneRoot: root,
        keyProvider: new TestKeyProvider(),
        newSecretId: () => ids.shift()!,
      });

      const first = await store.createSecret({ principalId: PRINCIPAL, value: 'first' });
      await store.authorizeSession({
        principalId: PRINCIPAL,
        reference: first.reference,
        cloudSessionId: SOURCE_SESSION,
      });
      await store.deleteSecret({
        principalId: PRINCIPAL,
        reference: first.reference,
        expectedRevision: first.revision,
      });
      const second = await store.createSecret({ principalId: PRINCIPAL, value: 'second' });
      const document = JSON.parse(await readFile(path, 'utf8')) as {
        secrets: Array<{ secretId: string }>;
        grants: Array<{ secretId: string }>;
      };
      assert.deepEqual(
        document.secrets.map((record) => record.secretId),
        [second.reference.secretId],
      );
      assert.deepEqual(document.grants, []);
    });
  });

  test('persists only authenticated ciphertext in a private control-plane root', async () => {
    await withTempRoot(async (root) => {
      const value = 'never-write-this-in-plaintext';
      const store = createEncryptedFileManagedSecretStore({
        controlPlaneRoot: root,
        keyProvider: new TestKeyProvider(),
        newSecretId: () => SECRET_ONE,
      });
      await store.createSecret({ principalId: PRINCIPAL, value });

      const path = join(root, MANAGED_SECRET_DOCUMENT_FILE);
      const raw = await readFile(path, 'utf8');
      assert.equal(raw.includes(value), false);
      assert.match(raw, /"algorithm": "A256GCM"/u);
      if (process.platform !== 'win32') {
        assert.equal((await stat(root)).mode & 0o777, 0o700);
        assert.equal((await stat(path)).mode & 0o777, 0o600);
      }
    });
  });

  test('reopens with the external key and fails closed when the key is unavailable', async () => {
    await withTempRoot(async (root) => {
      const provider = new TestKeyProvider();
      const writer = createEncryptedFileManagedSecretStore({
        controlPlaneRoot: root,
        keyProvider: provider,
        newSecretId: () => SECRET_ONE,
      });
      const secret = await writer.createSecret({ principalId: PRINCIPAL, value: 'persisted' });
      await writer.authorizeSession({
        principalId: PRINCIPAL,
        reference: secret.reference,
        cloudSessionId: SOURCE_SESSION,
      });

      const reader = createEncryptedFileManagedSecretStore({
        controlPlaneRoot: root,
        keyProvider: provider,
      });
      assert.equal(
        (
          await reader.resolveForActivation({
            context: activationContext(SOURCE_SESSION),
            references: [secret.reference],
          })
        )[0]?.value,
        'persisted',
      );

      provider.keys.clear();
      await assertRejectCode(
        reader.resolveForActivation({
          context: activationContext(SOURCE_SESSION),
          references: [secret.reference],
        }),
        'key_unavailable',
      );
    });
  });

  test('uses the provider active key on rotation without changing the portable reference', async () => {
    await withTempRoot(async (root) => {
      const provider = new TestKeyProvider();
      const store = createEncryptedFileManagedSecretStore({
        controlPlaneRoot: root,
        keyProvider: provider,
        newSecretId: () => SECRET_ONE,
      });
      const secret = await store.createSecret({ principalId: PRINCIPAL, value: 'before' });
      await store.authorizeSession({
        principalId: PRINCIPAL,
        reference: secret.reference,
        cloudSessionId: SOURCE_SESSION,
      });

      provider.keys.set('test-key-2', Buffer.alloc(32, 9));
      provider.activeKeyId = 'test-key-2';
      const rotated = await store.rotateSecret({
        principalId: PRINCIPAL,
        reference: secret.reference,
        expectedRevision: secret.revision,
        value: 'after',
      });
      assert.equal(rotated.kind, 'committed');
      if (rotated.kind !== 'committed') return;
      assert.deepEqual(rotated.secret.reference, secret.reference);

      provider.keys.delete('test-key-1');
      assert.equal(
        (
          await store.resolveForActivation({
            context: activationContext(SOURCE_SESSION),
            references: [secret.reference],
          })
        )[0]?.value,
        'after',
      );
      const raw = await readFile(join(root, MANAGED_SECRET_DOCUMENT_FILE), 'utf8');
      assert.match(raw, /"keyId": "test-key-2"/u);
      assert.doesNotMatch(raw, /"keyId": "test-key-1"/u);
    });
  });

  test('binds ciphertext to identity, owner, and revision with AEAD authentication', async () => {
    await withTempRoot(async (root) => {
      const store = createEncryptedFileManagedSecretStore({
        controlPlaneRoot: root,
        keyProvider: new TestKeyProvider(),
        newSecretId: () => SECRET_ONE,
      });
      const secret = await store.createSecret({ principalId: PRINCIPAL, value: 'authenticated' });
      await store.authorizeSession({
        principalId: PRINCIPAL,
        reference: secret.reference,
        cloudSessionId: SOURCE_SESSION,
      });
      const path = join(root, MANAGED_SECRET_DOCUMENT_FILE);
      const document = JSON.parse(await readFile(path, 'utf8')) as {
        secrets: Array<{ envelope: { ciphertext: string } }>;
      };
      const ciphertext = document.secrets[0]!.envelope.ciphertext;
      document.secrets[0]!.envelope.ciphertext =
        `${ciphertext.startsWith('A') ? 'B' : 'A'}${ciphertext.slice(1)}`;
      await writeFile(path, `${JSON.stringify(document)}\n`, 'utf8');

      await assertRejectCode(
        store.resolveForActivation({
          context: activationContext(SOURCE_SESSION),
          references: [secret.reference],
        }),
        'integrity_failure',
      );
    });
  });

  test('serializes two store owners so concurrent creates do not lose records', async () => {
    await withTempRoot(async (root) => {
      const provider = new TestKeyProvider();
      const first = createEncryptedFileManagedSecretStore({
        controlPlaneRoot: root,
        keyProvider: provider,
        newSecretId: () => SECRET_ONE,
      });
      const second = createEncryptedFileManagedSecretStore({
        controlPlaneRoot: root,
        keyProvider: provider,
        newSecretId: () => SECRET_TWO,
      });
      const [one, two] = await Promise.all([
        first.createSecret({ principalId: PRINCIPAL, value: 'one' }),
        second.createSecret({ principalId: PRINCIPAL, value: 'two' }),
      ]);
      const reader = createEncryptedFileManagedSecretStore({
        controlPlaneRoot: root,
        keyProvider: provider,
      });
      assert.equal(
        (await reader.getSecretMetadata({ principalId: PRINCIPAL, reference: one.reference }))
          ?.revision,
        1,
      );
      assert.equal(
        (await reader.getSecretMetadata({ principalId: PRINCIPAL, reference: two.reference }))
          ?.revision,
        1,
      );
    });
  });

  test('fails closed on an unknown document schema', async () => {
    await withTempRoot(async (root) => {
      await writeFile(
        join(root, MANAGED_SECRET_DOCUMENT_FILE),
        JSON.stringify({
          schemaVersion: MANAGED_SECRET_DOCUMENT_SCHEMA_VERSION + 1,
          revision: 0,
          secrets: [],
          grants: [],
        }),
        'utf8',
      );
      const store = createEncryptedFileManagedSecretStore({
        controlPlaneRoot: root,
        keyProvider: new TestKeyProvider(),
      });
      await assertRejectCode(
        store.getSecretMetadata({
          principalId: PRINCIPAL,
          reference: {
            schemaVersion: 1,
            secretId: SECRET_ONE,
          },
        }),
        'integrity_failure',
      );
    });
  });
});

class TestKeyProvider implements EncryptedFileManagedSecretKeyProvider {
  activeKeyId = 'test-key-1';
  readonly keys = new Map<string, Uint8Array>([['test-key-1', Buffer.alloc(32, 7)]]);

  async activeKey(): Promise<EncryptedFileManagedSecretKey> {
    const key = this.keys.get(this.activeKeyId);
    if (!key) throw new Error('missing test key');
    return { keyId: this.activeKeyId, key };
  }

  async keyById(keyId: string): Promise<EncryptedFileManagedSecretKey | null> {
    const key = this.keys.get(keyId);
    return key ? { keyId, key } : null;
  }
}

function sequenceIds(): () => string {
  const ids = [SECRET_ONE, SECRET_TWO];
  return () => {
    const value = ids.shift();
    if (!value) throw new Error('test secret ids exhausted');
    return value;
  };
}

function generatedSecretId(index: number): string {
  return `10000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function activationContext(cloudSessionId: string) {
  return { principalId: PRINCIPAL, cloudSessionId, activationId: ACTIVATION };
}

async function assertRejectCode(
  promise: Promise<unknown>,
  code: ManagedSecretError['code'],
): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof ManagedSecretError && error.code === code,
  );
}

async function withHarness(
  createHarness: () => Promise<StoreHarness>,
  operation: (harness: StoreHarness) => Promise<void>,
): Promise<void> {
  const harness = await createHarness();
  try {
    await operation(harness);
  } finally {
    await harness.close();
  }
}

async function withTempRoot(operation: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-managed-secrets-'));
  try {
    await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
