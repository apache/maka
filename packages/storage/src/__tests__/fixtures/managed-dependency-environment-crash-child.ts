import { mkdir, writeFile } from 'node:fs/promises';
import {
  computeManagedDependencyEnvironmentIdentity,
  createManagedDependencyEnvironmentAuthority,
  createManagedDependencyEnvironmentProducerCapability,
  type ManagedDependencyEnvironmentFailpoint,
} from '../../managed-dependency-environment.js';

const storageRoot = process.env.MAKA_DEPENDENCY_CRASH_ROOT;
const failpoint = process.env.MAKA_DEPENDENCY_CRASH_POINT as
  | ManagedDependencyEnvironmentFailpoint
  | 'during_environment_provision'
  | undefined;
if (!storageRoot || !failpoint) throw new Error('Missing dependency crash fixture input');

const producerCapability = createManagedDependencyEnvironmentProducerCapability(
  `sha256:${'a'.repeat(64)}`,
);

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
  producerRuntimeIdentitySha256: producerCapability.runtimeIdentitySha256,
  producerPolicyIdentitySha256: producerCapability.policyIdentitySha256,
  policyVersion: 'managed_dependency_environment_v1' as const,
};
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
      await mkdir(joinPath(input.outputRoot, 'fixture-package'), {
        recursive: true,
      });
      await writeFile(joinPath(input.outputRoot, 'fixture-package', 'index.js'), 'safe\n');
      if (failpoint === 'during_environment_provision') process.exit(73);
    },
  },
  failpoint(point) {
    if (point === failpoint) process.exit(73);
  },
});
await authority.acquire(computeManagedDependencyEnvironmentIdentity(source), source);
throw new Error('Crash failpoint was not reached');

function joinPath(...parts: string[]): string {
  return parts.join(process.platform === 'win32' ? '\\' : '/');
}
