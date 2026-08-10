import {
  createManagedDependencyEnvironmentAuthority,
  createManagedDependencyEnvironmentProducerCapability,
} from '../../managed-dependency-environment.js';

const storageRoot = process.env.MAKA_DEPENDENCY_OWNER_ROOT;
if (!storageRoot) throw new Error('Missing dependency owner fixture root');

const producerCapability = createManagedDependencyEnvironmentProducerCapability(
  `sha256:${'a'.repeat(64)}`,
);
await createManagedDependencyEnvironmentAuthority({
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
    async provision() {},
  },
});
process.stdout.write('READY\n');
setInterval(() => undefined, 1_000);
