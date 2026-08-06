import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  computeManagedDependencyEnvironmentIdentity,
  createManagedDependencyEnvironmentAuthority,
} from '../managed-dependency-environment.js';

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
});

test('rejects a published environment whose dependency content was modified', async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-dependency-tamper-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const producer = {
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

test('rejects a receipt with fields outside the v1 envelope', async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-dependency-receipt-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const producer = {
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
    policyVersion: 'managed_dependency_environment_v1' as const,
  };
  const identity = computeManagedDependencyEnvironmentIdentity(source);
  const authority = await createManagedDependencyEnvironmentAuthority({ storageRoot, producer });
  const lease = await authority.acquire(identity, source);
  const receiptPath = join(dirname(lease.dependencyRoot), 'environment-receipt.json');
  await lease.release();
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>;
  receipt.unexpected = true;
  await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, 'utf8');

  await assert.rejects(authority.acquire(identity, source), /Invalid dependency receipt/u);
  await authority.close();
});

test('publishes one Maka-owned artifact for concurrent equivalent acquisitions', async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-dependency-environment-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  let provisionCalls = 0;
  const authority = await createManagedDependencyEnvironmentAuthority({
    storageRoot,
    producer: {
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

function fixtureNodeRuntime() {
  return {
    version: '24.7.0',
    abi: '137',
    platform: process.platform,
    arch: process.arch,
  } as const;
}
