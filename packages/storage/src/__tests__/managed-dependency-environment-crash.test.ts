import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  computeManagedDependencyEnvironmentIdentity,
  createManagedDependencyEnvironmentAuthority,
  createManagedDependencyEnvironmentProducerCapability,
  type ManagedDependencyEnvironmentFailpoint,
} from '../managed-dependency-environment.js';

const execFileAsync = promisify(execFile);
const producerCapability = createManagedDependencyEnvironmentProducerCapability(
  `sha256:${'a'.repeat(64)}`,
);
const childEntrypoint = fileURLToPath(
  new URL('./fixtures/managed-dependency-environment-crash-child.js', import.meta.url),
);

for (const failpoint of [
  'during_environment_provision',
  'after_environment_receipt_durable',
  'after_environment_publish',
] as const satisfies readonly (
  | ManagedDependencyEnvironmentFailpoint
  | 'during_environment_provision'
)[]) {
  test(`converges after process exit at ${failpoint}`, async (t) => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'maka-dependency-crash-'));
    t.after(() => rm(storageRoot, { recursive: true, force: true }));
    await assert.rejects(
      execFileAsync(process.execPath, [childEntrypoint], {
        env: {
          ...process.env,
          MAKA_DEPENDENCY_CRASH_ROOT: storageRoot,
          MAKA_DEPENDENCY_CRASH_POINT: failpoint,
        },
        windowsHide: true,
      }),
      (error: unknown) => error instanceof Error && 'code' in error && Number(error.code) === 73,
    );

    let provisionCalls = 0;
    const authority = await createManagedDependencyEnvironmentAuthority({
      storageRoot,
      producer: {
        capability: producerCapability,
        packageManagerName: 'npm',
        packageManagerVersion: '11.12.1',
        nodeRuntime: {
          version: '24.7.0',
          abi: '137',
          platform: process.platform,
          arch: process.arch,
        },
        async provision(input) {
          provisionCalls += 1;
          await mkdir(join(input.outputRoot, 'fixture-package'), { recursive: true });
          await writeFile(join(input.outputRoot, 'fixture-package', 'index.js'), 'safe\n');
        },
      },
    });
    const source = dependencySource();
    const lease = await authority.acquire(
      computeManagedDependencyEnvironmentIdentity(source),
      source,
    );
    assert.equal(
      await readFile(join(lease.dependencyRoot, 'fixture-package', 'index.js'), 'utf8'),
      'safe\n',
    );
    assert.equal(provisionCalls, failpoint === 'after_environment_receipt_durable' ? 0 : 1);
    assert.deepEqual(
      await readdir(join(storageRoot, 'managed-workspaces', 'dependency-environments', '.staging')),
      [],
    );
    await lease.release();
    await authority.close();
  });
}

function dependencySource() {
  return {
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
    producerRuntimeIdentitySha256: producerCapability.runtimeIdentitySha256,
    producerPolicyIdentitySha256: producerCapability.policyIdentitySha256,
    policyVersion: 'managed_dependency_environment_v1' as const,
  };
}
