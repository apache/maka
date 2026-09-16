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
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { CreateSessionInput } from '@maka/core/runtime-inputs';
import { acquireProcessLifetimeOwner } from '../process-lifetime-owner.js';
import {
  createFileProductionSessionSnapshotService,
  SESSION_SNAPSHOT_STATE_IDENTITY_MEDIA_TYPE,
} from '../production-session-snapshot.js';
import {
  SessionSnapshotError,
  type SessionSnapshotQuiescenceAuthority,
  type SessionSnapshotWorkspaceConfirmationAuthority,
} from '../quiescent-session-snapshot.js';
import type { PackQuiescentSessionBundleInput } from '../production-session-snapshot.js';
import type { SessionBundleFileService, SessionBundleLimits } from '../session-bundle-contract.js';
import { createSessionBundleFileService } from '../session-bundle-file-service.js';
import { createSessionStore } from '../session-store.js';

const limits: SessionBundleLimits = {
  maxCompressedBytes: 4 * 1024 * 1024,
  maxDecompressedTarBytes: 8 * 1024 * 1024,
  maxPayloadBytes: 4 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
  maxEntryCount: 100,
  maxManifestBytes: 256 * 1024,
  maxStateIdentityBytes: 64 * 1024,
  maxPathBytes: 255,
  maxPathDepth: 16,
};

const immediateQuiescence: SessionSnapshotQuiescenceAuthority = {
  async runQuiescent(_input, operation) {
    return await operation();
  },
};

test('prepares real Session state and a policy-filtered workspace, then packs and hydrates it', async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.workspaceRoot, 'README.md'), 'portable workspace\n');
    await writeFile(join(fixture.workspaceRoot, 'package-lock.json'), '{"lockfileVersion":3}\n');
    await mkdir(join(fixture.workspaceRoot, 'node_modules', 'dep'), { recursive: true });
    await writeFile(join(fixture.workspaceRoot, 'node_modules', 'dep', 'index.js'), 'excluded');
    await mkdir(join(fixture.workspaceRoot, '.git'), { recursive: true });
    await writeFile(join(fixture.workspaceRoot, '.git', 'config'), 'excluded');
    await mkdir(join(fixture.workspaceRoot, '.cache'), { recursive: true });
    await writeFile(join(fixture.workspaceRoot, '.cache', 'result'), 'excluded');
    await mkdir(join(fixture.workspaceRoot, 'logs'), { recursive: true });
    await writeFile(join(fixture.workspaceRoot, 'logs', 'runtime.log'), 'excluded');

    const service = await fixture.createService();
    const archivePath = join(fixture.root, 'bundle.tar.zst');
    const artifact = await service.pack({ destination: archivePath });
    assert.deepEqual(artifact.snapshotCleanup, { state: 'released' });

    const hydratedRoot = join(fixture.root, 'hydrated');
    const hydrated = await createSessionBundleFileService().hydrate({
      source: { path: archivePath, expectedArchiveDigest: artifact.archiveDigest },
      expectedSessionId: fixture.cloudSessionId,
      destinationRoot: hydratedRoot,
      limits,
    });
    assert.equal(
      await readFile(join(hydrated.workspaceRoot, 'README.md'), 'utf8'),
      'portable workspace\n',
    );
    assert.equal(
      await readFile(join(hydrated.workspaceRoot, 'package-lock.json'), 'utf8'),
      '{"lockfileVersion":3}\n',
    );
    await assert.rejects(readFile(join(hydrated.workspaceRoot, 'node_modules', 'dep', 'index.js')));
    await assert.rejects(readFile(join(hydrated.workspaceRoot, '.git', 'config')));
    await assert.rejects(readFile(join(hydrated.workspaceRoot, '.cache', 'result')));
    await assert.rejects(readFile(join(hydrated.workspaceRoot, 'logs', 'runtime.log')));
    assert.equal((await readFile(join(hydrated.stateRoot, 'runtime.sqlite'))).byteLength > 0, true);

    const inspection = await createSessionBundleFileService().inspect({
      source: { path: archivePath, expectedArchiveDigest: artifact.archiveDigest },
      limits,
    });
    assert.equal(inspection.stateIdentity.mediaType, SESSION_SNAPSHOT_STATE_IDENTITY_MEDIA_TYPE);
    assert.deepEqual(JSON.parse(Buffer.from(inspection.stateIdentity.bytes).toString('utf8')), {
      schemaVersion: 1,
      makaSessionId: fixture.sessionId,
    });
    assert.deepEqual(
      (await readdir(fixture.stagingParent)).filter((name) => name.startsWith('.snapshot-')),
      [],
    );
    assert.deepEqual(
      (await readdir(fixture.stagingParent)).filter((name) => name.startsWith('snapshot-')),
      [],
    );
  } finally {
    await fixture.close();
  }
});

test('fails closed for a known user-authored secret and removes private staging', async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.workspaceRoot, '.env'), 'TOKEN=not-portable\n');
    const service = await fixture.createService();
    await assert.rejects(service.prepare({}), (error) => {
      assert.ok(error instanceof SessionSnapshotError);
      assert.equal(error.code, 'policy_rejected');
      assert.deepEqual(error.details, {
        phase: 'workspace',
        policyCategory: 'known_secret_file',
      });
      return true;
    });
    assert.deepEqual(
      (await readdir(fixture.stagingParent)).filter((name) => name.includes('snapshot')),
      [],
    );
  } finally {
    await fixture.close();
  }
});

test('binds the configured Maka Session and Cloud envelope despite untrusted call fields', async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.workspaceRoot, 'README.md'), 'bound workspace\n');
    const service = await fixture.createService();
    const archivePath = join(fixture.root, 'bound.tar.zst');
    const artifact = await service.pack({
      destination: archivePath,
      makaSessionId: 'other-session',
      sessionId: 'other-cloud-session',
    } as unknown as PackQuiescentSessionBundleInput);
    const inspection = await createSessionBundleFileService().inspect({
      source: { path: archivePath, expectedArchiveDigest: artifact.archiveDigest },
      limits,
    });
    assert.equal(inspection.manifest.envelope.sessionId, fixture.cloudSessionId);
    assert.deepEqual(JSON.parse(Buffer.from(inspection.stateIdentity.bytes).toString('utf8')), {
      schemaVersion: 1,
      makaSessionId: fixture.sessionId,
    });
  } finally {
    await fixture.close();
  }
});

test('rejects a production root nested under the workspace before copying', async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      fixture.createService({ stagingParent: join(fixture.workspaceRoot, 'staging') }),
      (error) => error instanceof SessionSnapshotError && error.code === 'unsafe_source',
    );
  } finally {
    await fixture.close();
  }
});

test('uses an authenticated confirmation authority for suspected secret directories', async () => {
  const fixture = await createFixture();
  try {
    await mkdir(join(fixture.workspaceRoot, 'secrets'));
    await writeFile(
      join(fixture.workspaceRoot, 'secrets', 'reference.txt'),
      'not a secret value\n',
    );
    const confirmations: string[] = [];
    const confirmationAuthority: SessionSnapshotWorkspaceConfirmationAuthority = {
      async resolveConfirmation(input) {
        confirmations.push(`${input.makaSessionId}:${input.confirmationPath}`);
        assert.equal(input.confirmationGrantId, 'grant-1');
        return { action: 'include' };
      },
    };
    const service = await fixture.createService({ confirmationAuthority });
    const prepared = await service.prepare({ confirmationGrantId: 'grant-1' });
    try {
      assert.equal(
        await readFile(join(prepared.snapshot.workspaceRoot, 'secrets', 'reference.txt'), 'utf8'),
        'not a secret value\n',
      );
      assert.deepEqual(confirmations, [`${fixture.sessionId}:secrets`]);
    } finally {
      await prepared.release();
    }
  } finally {
    await fixture.close();
  }
});

test('reserves state entries before admitting workspace entries', async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.workspaceRoot, 'README.md'), 'would exceed bundle entry quota\n');
    const service = await fixture.createService({
      limits: { ...limits, maxEntryCount: 4 },
    });
    await assert.rejects(service.prepare({}), (error) => {
      assert.ok(error instanceof SessionSnapshotError);
      assert.equal(error.code, 'quota_exceeded');
      assert.deepEqual(error.details, { phase: 'workspace' });
      return true;
    });
  } finally {
    await fixture.close();
  }
});

test('returns the written Bundle and reports recoverable staging cleanup failure', async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.workspaceRoot, 'README.md'), 'durable artifact\n');
    const codec = createSessionBundleFileService();
    const bundleFileService: SessionBundleFileService = {
      async pack(input) {
        const artifact = await codec.pack(input);
        const snapshotRoot = dirname(input.snapshot.stateRoot);
        await rename(snapshotRoot, `${snapshotRoot}.displaced`);
        await mkdir(snapshotRoot, { mode: 0o700 });
        await writeFile(join(snapshotRoot, 'unrelated.txt'), 'do not remove\n');
        return artifact;
      },
      inspect: codec.inspect.bind(codec),
      hydrate: codec.hydrate.bind(codec),
      cleanupHydrationStaging: codec.cleanupHydrationStaging.bind(codec),
    };
    const service = await fixture.createService({ bundleFileService });
    const archivePath = join(fixture.root, 'bundle-with-pending-cleanup.tar.zst');

    const artifact = await service.pack({ destination: archivePath });

    assert.equal((await readFile(archivePath)).byteLength > 0, true);
    const inspection = await codec.inspect({
      source: { path: archivePath, expectedArchiveDigest: artifact.archiveDigest },
      limits,
    });
    assert.equal(inspection.verified, true);
    assert.equal(artifact.snapshotCleanup.state, 'pending_recovery');
    if (artifact.snapshotCleanup.state === 'pending_recovery') {
      assert.equal(artifact.snapshotCleanup.error.code, 'cleanup_failed');
      assert.deepEqual(artifact.snapshotCleanup.error.details, { phase: 'cleanup' });
    }
  } finally {
    await fixture.close();
  }
});

test('rejects a POSIX-only workspace name with a bounded portability diagnostic', {
  skip: process.platform === 'win32',
}, async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.workspaceRoot, 'name.'), 'not portable\n');
    const service = await fixture.createService();
    await assert.rejects(service.prepare({}), (error) => {
      assert.ok(error instanceof SessionSnapshotError);
      assert.equal(error.code, 'unsafe_source');
      assert.deepEqual(error.details, {
        phase: 'workspace',
        policyCategory: 'unsupported_portable_path',
        observed: 1,
      });
      return true;
    });
  } finally {
    await fixture.close();
  }
});

async function createFixture(): Promise<{
  readonly root: string;
  readonly stateRoot: string;
  readonly configRoot: string;
  readonly workspaceRoot: string;
  readonly stagingParent: string;
  readonly cleanupStateRoot: string;
  readonly sessionId: string;
  readonly cloudSessionId: string;
  createService: (overrides?: {
    readonly workspaceRoot?: string;
    readonly stagingParent?: string;
    readonly cleanupStateRoot?: string;
    readonly limits?: SessionBundleLimits;
    readonly confirmationAuthority?: SessionSnapshotWorkspaceConfirmationAuthority;
    readonly bundleFileService?: SessionBundleFileService;
  }) => ReturnType<typeof createFileProductionSessionSnapshotService>;
  close(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'maka-production-snapshot-'));
  const stateRoot = join(root, 'state');
  const configRoot = join(root, 'config');
  const workspaceRoot = join(root, 'workspace');
  const stagingParent = join(root, 'staging');
  const cleanupStateRoot = join(root, 'cleanup-state');
  await Promise.all([
    mkdir(configRoot),
    mkdir(workspaceRoot),
    mkdir(stagingParent, { mode: 0o700 }),
  ]);
  const sessions = createSessionStore(stateRoot);
  const session = await sessions.create(sessionInput());
  await sessions.appendMessage(session.id, {
    type: 'user',
    id: 'message-1',
    turnId: 'turn-1',
    ts: 1,
    text: 'durable message',
  });
  await sessions.close?.();
  const owner = await acquireProcessLifetimeOwner(cleanupStateRoot);
  const cloudSessionId = 'cloud-session-1';
  return {
    root,
    stateRoot,
    configRoot,
    workspaceRoot,
    stagingParent,
    cleanupStateRoot,
    sessionId: session.id,
    cloudSessionId,
    createService: (overrides = {}) =>
      createFileProductionSessionSnapshotService({
        session: { makaSessionId: session.id, cloudSessionId },
        stateRoot,
        configRoot,
        workspaceRoot: overrides.workspaceRoot ?? workspaceRoot,
        stagingParent: overrides.stagingParent ?? stagingParent,
        cleanupStateRoot: overrides.cleanupStateRoot ?? cleanupStateRoot,
        processLifetimeOwner: owner,
        quiescence: immediateQuiescence,
        limits: overrides.limits ?? limits,
        confirmationAuthority: overrides.confirmationAuthority,
        bundleFileService: overrides.bundleFileService,
      }),
    async close(): Promise<void> {
      await owner.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function sessionInput(): CreateSessionInput {
  return {
    cwd: '/tmp/workspace',
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask',
    name: 'Portable Session',
    labels: [],
  };
}
