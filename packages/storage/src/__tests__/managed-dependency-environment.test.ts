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
import {
  access,
  chmod,
  type FileHandle,
  mkdtemp,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  computeManagedDependencyEnvironmentIdentity,
  createManagedDependencyEnvironmentAuthority,
  createManagedDependencyEnvironmentProducerCapability,
} from '../managed-dependency-environment.js';

const FIXTURE_PRODUCER_RUNTIME_IDENTITY = `sha256:${'a'.repeat(64)}` as const;
const FIXTURE_PRODUCER_CAPABILITY = createManagedDependencyEnvironmentProducerCapability(
  FIXTURE_PRODUCER_RUNTIME_IDENTITY,
);

test('computes one shared environment identity for equivalent dependency inputs', () => {
  const input = {
    manifestPath: 'package.json',
    manifestBytes: Buffer.from('{"packageManager":"npm@11.12.1"}\n'),
    lockfilePath: 'package-lock.json',
    lockfileBytes: Buffer.from('{"lockfileVersion":3}\n'),
    packageManagerName: 'npm' as const,
    packageManagerVersion: '11.12.1',
    nodeVersion: '24.7.0',
    nodeAbi: '137',
    platform: 'linux' as const,
    arch: 'x64' as const,
    producerRuntimeIdentitySha256: `sha256:${'1'.repeat(64)}` as const,
    producerPolicyIdentitySha256: `sha256:${'2'.repeat(64)}` as const,
    policyVersion: 'managed_dependency_environment_v1' as const,
  };

  const first = computeManagedDependencyEnvironmentIdentity(input);
  const second = computeManagedDependencyEnvironmentIdentity({ ...input });

  assert.match(first.environmentId, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.environmentId, second.environmentId);
  assert.equal(first.manifestSha256, second.manifestSha256);
  assert.equal(first.lockfileSha256, second.lockfileSha256);
  assert.notEqual(
    first.environmentId,
    computeManagedDependencyEnvironmentIdentity({ ...input, nodeAbi: '138' }).environmentId,
  );
  assert.notEqual(
    first.environmentId,
    computeManagedDependencyEnvironmentIdentity({
      ...input,
      platform: 'darwin',
    }).environmentId,
  );
  assert.notEqual(
    first.environmentId,
    computeManagedDependencyEnvironmentIdentity({
      ...input,
      producerRuntimeIdentitySha256: `sha256:${'3'.repeat(64)}`,
    }).environmentId,
  );
  assert.notEqual(
    first.environmentId,
    computeManagedDependencyEnvironmentIdentity({
      ...input,
      producerPolicyIdentitySha256: `sha256:${'4'.repeat(64)}`,
    }).environmentId,
  );
});

test('rejects a producer that does not declare the exact hermetic capability', async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-dependency-capability-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));

  await assert.rejects(
    createManagedDependencyEnvironmentAuthority({
      storageRoot,
      producer: {
        capability: {
          ...FIXTURE_PRODUCER_CAPABILITY,
          network: 'unrestricted' as never,
        },
        packageManagerName: 'npm',
        packageManagerVersion: '11.12.1',
        nodeRuntime: fixtureNodeRuntime(),
        async provision() {},
      },
    }),
    /producer capability is invalid/u,
  );
});

test('rejects a second authority for the same storage root in one process', async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-dependency-single-owner-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const producer = {
    capability: FIXTURE_PRODUCER_CAPABILITY,
    packageManagerName: 'npm' as const,
    packageManagerVersion: '11.12.1',
    nodeRuntime: fixtureNodeRuntime(),
    async provision() {},
  };
  const first = await createManagedDependencyEnvironmentAuthority({ storageRoot, producer });

  const second = await createManagedDependencyEnvironmentAuthority({ storageRoot, producer }).then(
    (authority) => ({ authority }),
    (error: unknown) => ({ error }),
  );
  if ('authority' in second) {
    await second.authority.close();
    assert.fail('a second authority acquired the same storage root');
  }
  assert.match(String(second.error), /already has an active owner/u);
  await first.close();
});

test('rejects a published environment whose dependency content was modified', async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-dependency-tamper-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const producer = {
    capability: FIXTURE_PRODUCER_CAPABILITY,
    packageManagerName: 'npm' as const,
    packageManagerVersion: '11.12.1',
    nodeRuntime: fixtureNodeRuntime(),
    async provision(input: { outputRoot: string }) {
      await mkdir(join(input.outputRoot, 'fixture-package'), {
        recursive: true,
      });
      await writeFile(join(input.outputRoot, 'fixture-package', 'index.js'), 'trusted\n', 'utf8');
    },
  };
  const identityInput = {
    manifestPath: 'package.json',
    manifestBytes: Buffer.from('{"packageManager":"npm@11.12.1"}\n'),
    lockfilePath: 'package-lock.json',
    lockfileBytes: Buffer.from('{"lockfileVersion":3}\n'),
    packageManagerName: 'npm' as const,
    packageManagerVersion: '11.12.1',
    nodeVersion: '24.7.0',
    nodeAbi: '137',
    platform: process.platform,
    arch: process.arch,
    producerRuntimeIdentitySha256: FIXTURE_PRODUCER_RUNTIME_IDENTITY,
    producerPolicyIdentitySha256: FIXTURE_PRODUCER_CAPABILITY.policyIdentitySha256,
    policyVersion: 'managed_dependency_environment_v1' as const,
  };
  const identity = computeManagedDependencyEnvironmentIdentity(identityInput);
  const firstAuthority = await createManagedDependencyEnvironmentAuthority({
    storageRoot,
    producer,
  });
  const lease = await firstAuthority.acquire(identity, identityInput);
  await writeFile(join(lease.dependencyRoot, 'fixture-package', 'index.js'), 'tampered\n', 'utf8');
  await lease.release();
  await firstAuthority.close();

  const reopened = await createManagedDependencyEnvironmentAuthority({
    storageRoot,
    producer,
  });
  await assert.rejects(reopened.acquire(identity, identityInput), /does not match its receipt/u);
  await reopened.close();
});

test('keeps the receipt in a constrained authority outside the producer-owned artifact domain', async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-dependency-receipt-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const producer = {
    capability: FIXTURE_PRODUCER_CAPABILITY,
    packageManagerName: 'npm' as const,
    packageManagerVersion: '11.12.1',
    nodeRuntime: fixtureNodeRuntime(),
    async provision(input: { outputRoot: string }) {
      await writeFile(join(input.outputRoot, 'index.js'), 'trusted\n', 'utf8');
    },
  };
  const source = {
    manifestPath: 'package.json',
    manifestBytes: Buffer.from('{"packageManager":"npm@11.12.1"}\n'),
    lockfilePath: 'package-lock.json',
    lockfileBytes: Buffer.from('{"lockfileVersion":3}\n'),
    packageManagerName: 'npm' as const,
    packageManagerVersion: '11.12.1',
    nodeVersion: '24.7.0',
    nodeAbi: '137',
    platform: process.platform,
    arch: process.arch,
    producerRuntimeIdentitySha256: FIXTURE_PRODUCER_RUNTIME_IDENTITY,
    producerPolicyIdentitySha256: FIXTURE_PRODUCER_CAPABILITY.policyIdentitySha256,
    policyVersion: 'managed_dependency_environment_v1' as const,
  };
  const identity = computeManagedDependencyEnvironmentIdentity(source);
  const authority = await createManagedDependencyEnvironmentAuthority({
    storageRoot,
    producer,
  });
  const lease = await authority.acquire(identity, source);
  const artifactRoot = dirname(lease.dependencyRoot);
  const authorityDatabasePath = join(
    storageRoot,
    'managed-workspaces',
    'dependency-environment-authority-v1.sqlite',
  );
  await lease.release();
  await assert.rejects(readFile(join(artifactRoot, 'environment-receipt.json'), 'utf8'), {
    code: 'ENOENT',
  });
  await access(authorityDatabasePath);
  const reopened = await authority.acquire(identity, source);
  await reopened.release();
  await authority.close();
});

test('rejects a coordinated artifact and co-located receipt rewrite', async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-dependency-coordinated-tamper-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const producer = {
    capability: FIXTURE_PRODUCER_CAPABILITY,
    packageManagerName: 'npm' as const,
    packageManagerVersion: '11.12.1',
    nodeRuntime: fixtureNodeRuntime(),
    async provision(input: { outputRoot: string }) {
      await writeFile(join(input.outputRoot, 'index.js'), 'trusted\n', 'utf8');
    },
  };
  const source = {
    manifestPath: 'package.json',
    manifestBytes: Buffer.from('{"packageManager":"npm@11.12.1"}\n'),
    lockfilePath: 'package-lock.json',
    lockfileBytes: Buffer.from('{"lockfileVersion":3}\n'),
    packageManagerName: 'npm' as const,
    packageManagerVersion: '11.12.1',
    nodeVersion: '24.7.0',
    nodeAbi: '137',
    platform: process.platform,
    arch: process.arch,
    producerRuntimeIdentitySha256: FIXTURE_PRODUCER_RUNTIME_IDENTITY,
    producerPolicyIdentitySha256: FIXTURE_PRODUCER_CAPABILITY.policyIdentitySha256,
    policyVersion: 'managed_dependency_environment_v1' as const,
  };
  const identity = computeManagedDependencyEnvironmentIdentity(source);
  const authority = await createManagedDependencyEnvironmentAuthority({
    storageRoot,
    producer,
  });
  const lease = await authority.acquire(identity, source);
  const artifactRoot = dirname(lease.dependencyRoot);
  await lease.release();
  await authority.close();

  await writeFile(join(lease.dependencyRoot, 'index.js'), 'malicious\n', 'utf8');
  await writeFile(
    join(artifactRoot, 'environment-receipt.json'),
    `${JSON.stringify({ environmentId: identity.environmentId, contentTreeSha256: 'forged' })}\n`,
    'utf8',
  );

  const reopened = await createManagedDependencyEnvironmentAuthority({
    storageRoot,
    producer,
  });
  await assert.rejects(
    reopened.acquire(identity, source),
    /artifact contains an unowned entry|content does not match its receipt/u,
  );
  await reopened.close();
});

test('rejects an environment id that is not the digest of the requested identity', async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-dependency-identity-forgery-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const producer = {
    capability: FIXTURE_PRODUCER_CAPABILITY,
    packageManagerName: 'npm' as const,
    packageManagerVersion: '11.12.1',
    nodeRuntime: fixtureNodeRuntime(),
    async provision() {},
  };
  const source = {
    manifestPath: 'package.json',
    manifestBytes: Buffer.from('{"packageManager":"npm@11.12.1"}\n'),
    lockfilePath: 'package-lock.json',
    lockfileBytes: Buffer.from('{"lockfileVersion":3}\n'),
    packageManagerName: 'npm' as const,
    packageManagerVersion: '11.12.1',
    nodeVersion: '24.7.0',
    nodeAbi: '137',
    platform: process.platform,
    arch: process.arch,
    producerRuntimeIdentitySha256: FIXTURE_PRODUCER_RUNTIME_IDENTITY,
    producerPolicyIdentitySha256: FIXTURE_PRODUCER_CAPABILITY.policyIdentitySha256,
    policyVersion: 'managed_dependency_environment_v1' as const,
  };
  const identity = computeManagedDependencyEnvironmentIdentity(source);
  const authority = await createManagedDependencyEnvironmentAuthority({
    storageRoot,
    producer,
  });
  await assert.rejects(
    authority.acquire({ ...identity, environmentId: `sha256:${'f'.repeat(64)}` }, source),
    /identity is not canonical/u,
  );
  await assert.rejects(
    authority.acquire(
      { ...identity, environmentId: 'sha256:../../escaped' } as typeof identity,
      source,
    ),
    /identity is not canonical/u,
  );
  await assert.rejects(access(join(storageRoot, 'escaped')), {
    code: 'ENOENT',
  });
  await authority.close();
});

test('rejects an NTFS alternate stream created inside a dependency artifact', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-dependency-ads-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const producer = {
    capability: FIXTURE_PRODUCER_CAPABILITY,
    packageManagerName: 'npm' as const,
    packageManagerVersion: '11.12.1',
    nodeRuntime: fixtureNodeRuntime(),
    async provision(input: { outputRoot: string }) {
      const target = join(input.outputRoot, 'index.js');
      await writeFile(target, 'trusted\n', 'utf8');
      await writeFile(`${target}:unhashed`, 'malicious\n', 'utf8');
    },
  };
  const source = dependencySourceForName('ads');
  const identity = computeManagedDependencyEnvironmentIdentity(source);
  const authority = await createManagedDependencyEnvironmentAuthority({
    storageRoot,
    producer,
  });
  await assert.rejects(authority.acquire(identity, source), /alternate data stream/u);
  await authority.close();
});

test('accepts a POSIX package bin symlink whose target remains inside the dependency root', {
  skip: process.platform === 'win32',
}, async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-dependency-bin-link-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const producer = {
    capability: FIXTURE_PRODUCER_CAPABILITY,
    packageManagerName: 'npm' as const,
    packageManagerVersion: '11.12.1',
    nodeRuntime: fixtureNodeRuntime(),
    async provision(input: { outputRoot: string }) {
      await mkdir(join(input.outputRoot, 'fixture-package'), {
        recursive: true,
      });
      await mkdir(join(input.outputRoot, '.bin'), { recursive: true });
      await writeFile(join(input.outputRoot, 'fixture-package', 'cli.js'), 'trusted\n', 'utf8');
      await symlink('../fixture-package/cli.js', join(input.outputRoot, '.bin', 'fixture-cli'));
    },
  };
  const source = dependencySourceForName('posix-bin-link');
  const identity = computeManagedDependencyEnvironmentIdentity(source);
  const authority = await createManagedDependencyEnvironmentAuthority({
    storageRoot,
    producer,
  });

  const lease = await authority.acquire(identity, source);
  assert.equal(
    await readFile(join(lease.dependencyRoot, '.bin', 'fixture-cli'), 'utf8'),
    'trusted\n',
  );
  await lease.release();
  await authority.close();
});

test('publishes authority-owned file inodes instead of producer-owned inodes', async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-dependency-inode-handoff-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  let producerFileIdentity: { dev: bigint; ino: bigint } | undefined;
  const producer = {
    capability: FIXTURE_PRODUCER_CAPABILITY,
    packageManagerName: 'npm' as const,
    packageManagerVersion: '11.12.1',
    nodeRuntime: fixtureNodeRuntime(),
    async provision(input: { outputRoot: string }) {
      const producerFile = join(input.outputRoot, 'payload');
      await writeFile(producerFile, 'trusted\n', 'utf8');
      const producerInfo = await stat(producerFile, { bigint: true });
      producerFileIdentity = { dev: producerInfo.dev, ino: producerInfo.ino };
    },
  };
  const source = dependencySourceForName('inode-handoff');
  const identity = computeManagedDependencyEnvironmentIdentity(source);
  const authority = await createManagedDependencyEnvironmentAuthority({ storageRoot, producer });

  const lease = await authority.acquire(identity, source);
  const publishedInfo = await stat(join(lease.dependencyRoot, 'payload'), { bigint: true });
  assert.notDeepEqual(
    { dev: publishedInfo.dev, ino: publishedInfo.ino },
    producerFileIdentity,
    'published content retained the producer-owned inode',
  );
  await lease.release();
  await authority.close();
});

test('seals the complete authority-owned tree before publishing its receipt', async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-dependency-durable-tree-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const observedBoundaries: string[] = [];
  const producer = {
    capability: FIXTURE_PRODUCER_CAPABILITY,
    packageManagerName: 'npm' as const,
    packageManagerVersion: '11.12.1',
    nodeRuntime: fixtureNodeRuntime(),
    async provision(input: { outputRoot: string }) {
      await mkdir(join(input.outputRoot, 'nested', 'package'), { recursive: true });
      await writeFile(join(input.outputRoot, 'root.js'), 'root\n', 'utf8');
      await writeFile(join(input.outputRoot, 'nested', 'package', 'index.js'), 'nested\n', 'utf8');
    },
  };
  const source = dependencySourceForName('durable-tree');
  const identity = computeManagedDependencyEnvironmentIdentity(source);
  const authority = await createManagedDependencyEnvironmentAuthority({
    storageRoot,
    producer,
    failpoint(point) {
      observedBoundaries.push(point);
    },
  });

  const lease = await authority.acquire(identity, source);
  assert.deepEqual(observedBoundaries, [
    'after_environment_tree_durable',
    'after_environment_publish',
    'after_environment_receipt_durable',
    'before_environment_lease',
  ]);
  await lease.release();
  await authority.close();
});

test('publishes Windows read-only dependency files without changing their final mode', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-dependency-readonly-file-'));
  let publishedFile: string | undefined;
  t.after(async () => {
    if (publishedFile) await chmod(publishedFile, 0o644).catch(() => undefined);
    await rm(storageRoot, { recursive: true, force: true });
  });
  const producer = {
    capability: FIXTURE_PRODUCER_CAPABILITY,
    packageManagerName: 'npm' as const,
    packageManagerVersion: '11.12.1',
    nodeRuntime: fixtureNodeRuntime(),
    async provision(input: { outputRoot: string }) {
      const path = join(input.outputRoot, 'readonly.js');
      await writeFile(path, 'readonly dependency\n', 'utf8');
      await chmod(path, 0o444);
    },
  };
  const source = dependencySourceForName('readonly-file');
  const identity = computeManagedDependencyEnvironmentIdentity(source);
  const authority = await createManagedDependencyEnvironmentAuthority({ storageRoot, producer });

  const lease = await authority.acquire(identity, source);
  publishedFile = join(lease.dependencyRoot, 'readonly.js');
  assert.equal(await readFile(publishedFile, 'utf8'), 'readonly dependency\n');
  assert.equal((await stat(publishedFile)).mode & 0o222, 0);
  await lease.release();
  await authority.close();
});

test('isolates published POSIX content from a producer-retained writable handle', {
  skip: process.platform === 'win32',
}, async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-dependency-retained-handle-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  let retainedHandle: FileHandle | undefined;
  t.after(async () => retainedHandle?.close().catch(() => undefined));
  const producer = {
    capability: FIXTURE_PRODUCER_CAPABILITY,
    packageManagerName: 'npm' as const,
    packageManagerVersion: '11.12.1',
    nodeRuntime: fixtureNodeRuntime(),
    async provision(input: { outputRoot: string }) {
      retainedHandle = await open(join(input.outputRoot, 'payload'), 'w+');
      await retainedHandle.writeFile('trusted\n', 'utf8');
      await retainedHandle.sync();
    },
  };
  const source = dependencySourceForName('retained-handle');
  const identity = computeManagedDependencyEnvironmentIdentity(source);
  const authority = await createManagedDependencyEnvironmentAuthority({ storageRoot, producer });

  const lease = await authority.acquire(identity, source);
  const malicious = Buffer.from('MALICIOUS\n', 'utf8');
  await retainedHandle?.write(malicious, 0, malicious.length, 0);
  await retainedHandle?.truncate(malicious.length);
  await retainedHandle?.sync();
  assert.equal(await readFile(join(lease.dependencyRoot, 'payload'), 'utf8'), 'trusted\n');
  await retainedHandle?.close();
  retainedHandle = undefined;
  await lease.release();
  await authority.close();
});

test('publishes one Maka-owned artifact for concurrent equivalent acquisitions', async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-dependency-environment-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  let provisionCalls = 0;
  const authority = await createManagedDependencyEnvironmentAuthority({
    storageRoot,
    producer: {
      capability: FIXTURE_PRODUCER_CAPABILITY,
      packageManagerName: 'npm',
      packageManagerVersion: '11.12.1',
      nodeRuntime: fixtureNodeRuntime(),
      async provision(input) {
        provisionCalls += 1;
        await mkdir(join(input.outputRoot, 'fixture-package'), {
          recursive: true,
        });
        await writeFile(
          join(input.outputRoot, 'fixture-package', 'index.js'),
          'export const source = "maka-owned";\n',
          'utf8',
        );
      },
    },
  });
  const identityInput = {
    manifestPath: 'package.json',
    manifestBytes: Buffer.from('{"packageManager":"npm@11.12.1"}\n'),
    lockfilePath: 'package-lock.json',
    lockfileBytes: Buffer.from('{"lockfileVersion":3}\n'),
    packageManagerName: 'npm' as const,
    packageManagerVersion: '11.12.1',
    nodeVersion: '24.7.0',
    nodeAbi: '137',
    platform: process.platform,
    arch: process.arch,
    producerRuntimeIdentitySha256: FIXTURE_PRODUCER_RUNTIME_IDENTITY,
    producerPolicyIdentitySha256: FIXTURE_PRODUCER_CAPABILITY.policyIdentitySha256,
    policyVersion: 'managed_dependency_environment_v1' as const,
  };
  const identity = computeManagedDependencyEnvironmentIdentity(identityInput);

  const [first, second] = await Promise.all([
    authority.acquire(identity, {
      manifestBytes: identityInput.manifestBytes,
      lockfileBytes: identityInput.lockfileBytes,
    }),
    authority.acquire(identity, {
      manifestBytes: identityInput.manifestBytes,
      lockfileBytes: identityInput.lockfileBytes,
    }),
  ]);

  assert.equal(provisionCalls, 1);
  assert.equal(first.environmentId, second.environmentId);
  assert.equal(first.dependencyRoot, second.dependencyRoot);
  await first.release();
  await second.release();
  await authority.close();
});

test('close drains an acquisition through lease installation before deciding its outcome', async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-dependency-close-drain-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  let acknowledgeLeaseBoundary!: () => void;
  const leaseBoundary = new Promise<void>((resolve) => {
    acknowledgeLeaseBoundary = resolve;
  });
  let continueLeaseInstallation!: () => void;
  const leaseInstallationAllowed = new Promise<void>((resolve) => {
    continueLeaseInstallation = resolve;
  });
  const producer = {
    capability: FIXTURE_PRODUCER_CAPABILITY,
    packageManagerName: 'npm' as const,
    packageManagerVersion: '11.12.1',
    nodeRuntime: fixtureNodeRuntime(),
    async provision(input: { outputRoot: string }) {
      await writeFile(join(input.outputRoot, 'payload'), 'trusted\n', 'utf8');
    },
  };
  const authority = await createManagedDependencyEnvironmentAuthority({
    storageRoot,
    producer,
    async failpoint(point) {
      if (point !== 'before_environment_lease') return;
      acknowledgeLeaseBoundary();
      await leaseInstallationAllowed;
    },
  });
  const source = dependencySourceForName('close-drain');
  const identity = computeManagedDependencyEnvironmentIdentity(source);
  const acquireTask = authority.acquire(identity, source);
  await leaseBoundary;

  const closeTask = authority.close().then(
    () => ({ closed: true as const }),
    (error: unknown) => ({ error }),
  );
  await Promise.resolve();
  continueLeaseInstallation();
  const [lease, closeResult] = await Promise.all([acquireTask, closeTask]);
  if ('closed' in closeResult) {
    await assert.rejects(lease.release(), /receipt authority is closed/u);
    assert.fail('close succeeded while an acquisition was still installing its lease');
  }
  assert.match(String(closeResult.error), /still has active leases/u);
  await lease.release();
  await authority.close();
});

test('collects the least-recently-used unleased environment under the cache quota', async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-dependency-gc-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  let provisionCalls = 0;
  const producer = {
    capability: FIXTURE_PRODUCER_CAPABILITY,
    packageManagerName: 'npm' as const,
    packageManagerVersion: '11.12.1',
    nodeRuntime: fixtureNodeRuntime(),
    async provision(input: { outputRoot: string; identity: { lockfileSha256: string } }) {
      provisionCalls += 1;
      await writeFile(input.outputRoot + '/payload', input.identity.lockfileSha256.slice(-8));
    },
  };
  const authority = await createManagedDependencyEnvironmentAuthority({
    storageRoot,
    producer,
    maxCacheBytes: 8,
  });
  const source = {
    manifestPath: 'package.json',
    manifestBytes: Buffer.from('{"packageManager":"npm@11.12.1"}\n'),
    lockfilePath: 'package-lock.json',
    lockfileBytes: Buffer.from('{"lockfileVersion":3,"name":"first"}\n'),
    packageManagerName: 'npm' as const,
    packageManagerVersion: '11.12.1',
    nodeVersion: '24.7.0',
    nodeAbi: '137',
    platform: process.platform,
    arch: process.arch,
    producerRuntimeIdentitySha256: FIXTURE_PRODUCER_RUNTIME_IDENTITY,
    producerPolicyIdentitySha256: FIXTURE_PRODUCER_CAPABILITY.policyIdentitySha256,
    policyVersion: 'managed_dependency_environment_v1' as const,
  };
  const firstIdentity = computeManagedDependencyEnvironmentIdentity(source);
  const first = await authority.acquire(firstIdentity, source);
  await first.release();

  const secondSource = {
    ...source,
    lockfileBytes: Buffer.from('{"lockfileVersion":3,"name":"second"}\n'),
  };
  const secondIdentity = computeManagedDependencyEnvironmentIdentity(secondSource);
  const second = await authority.acquire(secondIdentity, secondSource);
  await second.release();

  const firstAgain = await authority.acquire(firstIdentity, source);
  assert.equal(provisionCalls, 3);
  await firstAgain.release();
  await authority.close();
});

test('does not collect a published environment while its acquisition is still pending', async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-dependency-pending-gc-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  let releasePendingPublish!: () => void;
  const pendingPublish = new Promise<void>((resolve) => {
    releasePendingPublish = resolve;
  });
  let acknowledgeReceiptDurable!: () => void;
  const receiptDurable = new Promise<void>((resolve) => {
    acknowledgeReceiptDurable = resolve;
  });
  let pendingDigest: string | undefined;
  const producer = {
    capability: FIXTURE_PRODUCER_CAPABILITY,
    packageManagerName: 'npm' as const,
    packageManagerVersion: '11.12.1',
    nodeRuntime: fixtureNodeRuntime(),
    async provision(input: { outputRoot: string; identity: { lockfileSha256: string } }) {
      await writeFile(join(input.outputRoot, 'payload'), input.identity.lockfileSha256, 'utf8');
    },
  };
  const authority = await createManagedDependencyEnvironmentAuthority({
    storageRoot,
    producer,
    maxCacheBytes: 0,
    async failpoint(point) {
      if (point === 'after_environment_receipt_durable' && pendingDigest) {
        acknowledgeReceiptDurable();
        await pendingPublish;
      }
    },
  });
  const firstSource = dependencySourceForName('first');
  const firstIdentity = computeManagedDependencyEnvironmentIdentity(firstSource);
  const first = await authority.acquire(firstIdentity, firstSource);
  const secondSource = dependencySourceForName('second');
  const secondIdentity = computeManagedDependencyEnvironmentIdentity(secondSource);
  pendingDigest = secondIdentity.environmentId;
  const secondTask = authority.acquire(secondIdentity, secondSource);
  await receiptDurable;
  await first.release();
  releasePendingPublish();
  const second = await secondTask;
  assert.equal(
    await readFile(join(second.dependencyRoot, 'payload'), 'utf8'),
    secondIdentity.lockfileSha256,
  );
  await second.release();
  await authority.close();
});

function dependencySourceForName(name: string) {
  return {
    manifestPath: 'package.json',
    manifestBytes: Buffer.from('{"packageManager":"npm@11.12.1"}\n'),
    lockfilePath: 'package-lock.json',
    lockfileBytes: Buffer.from(`{"lockfileVersion":3,"name":"${name}"}\n`),
    packageManagerName: 'npm' as const,
    packageManagerVersion: '11.12.1',
    nodeVersion: '24.7.0',
    nodeAbi: '137',
    platform: process.platform,
    arch: process.arch,
    producerRuntimeIdentitySha256: FIXTURE_PRODUCER_RUNTIME_IDENTITY,
    producerPolicyIdentitySha256: FIXTURE_PRODUCER_CAPABILITY.policyIdentitySha256,
    policyVersion: 'managed_dependency_environment_v1' as const,
  };
}

function fixtureNodeRuntime() {
  return {
    version: '24.7.0',
    abi: '137',
    platform: process.platform,
    arch: process.arch,
  } as const;
}
