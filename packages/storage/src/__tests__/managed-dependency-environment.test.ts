import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
    computeManagedDependencyEnvironmentIdentity({ ...input, platform: 'darwin' }).environmentId,
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

test('rejects a published environment whose dependency content was modified', async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-dependency-tamper-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const producer = {
    capability: FIXTURE_PRODUCER_CAPABILITY,
    packageManagerName: 'npm' as const,
    packageManagerVersion: '11.12.1',
    nodeRuntime: fixtureNodeRuntime(),
    async provision(input: { outputRoot: string }) {
      await mkdir(join(input.outputRoot, 'fixture-package'), { recursive: true });
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

  const reopened = await createManagedDependencyEnvironmentAuthority({ storageRoot, producer });
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
  const authority = await createManagedDependencyEnvironmentAuthority({ storageRoot, producer });
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
  const authority = await createManagedDependencyEnvironmentAuthority({ storageRoot, producer });
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

  const reopened = await createManagedDependencyEnvironmentAuthority({ storageRoot, producer });
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
  const authority = await createManagedDependencyEnvironmentAuthority({ storageRoot, producer });
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
  await assert.rejects(access(join(storageRoot, 'escaped')), { code: 'ENOENT' });
  await authority.close();
});

test(
  'rejects an NTFS alternate stream created inside a dependency artifact',
  { skip: process.platform !== 'win32' },
  async (t) => {
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
    const authority = await createManagedDependencyEnvironmentAuthority({ storageRoot, producer });
    await assert.rejects(authority.acquire(identity, source), /alternate data stream/u);
    await authority.close();
  },
);

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
        await mkdir(join(input.outputRoot, 'fixture-package'), { recursive: true });
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
  assert.equal(await readFile(join(second.dependencyRoot, 'payload'), 'utf8'), secondIdentity.lockfileSha256);
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
