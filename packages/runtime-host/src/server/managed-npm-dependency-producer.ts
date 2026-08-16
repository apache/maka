import {
  createManagedDependencyEnvironmentProducerCapability,
  type ManagedDependencyEnvironmentProducer,
  type ManagedDependencyEnvironmentProducerInput,
} from '@maka/storage/managed-dependency-environment';
import {
  runManagedNpmDependencyProvision,
  type ManagedNpmRuntimeCapability,
} from './managed-dependency-producer-process.js';

/**
 * Internal composition seam from an attested bundled npm runtime to the
 * storage-owned dependency artifact publisher. The returned producer cannot
 * weaken the runtime capability: every invocation re-enters the PR3
 * attestation owner before starting npm.
 */
export function createManagedNpmDependencyEnvironmentProducer(
  runtime: ManagedNpmRuntimeCapability,
): ManagedDependencyEnvironmentProducer {
  return Object.freeze({
    capability: createManagedDependencyEnvironmentProducerCapability(runtime.runtimeIdentitySha256),
    packageManagerName: 'npm' as const,
    packageManagerVersion: runtime.npmVersion,
    nodeRuntime: Object.freeze({
      version: runtime.nodeVersion,
      abi: runtime.nodeAbi,
      platform: runtime.platform,
      arch: runtime.arch,
    }),
    provision: (producerInput: ManagedDependencyEnvironmentProducerInput) =>
      runManagedNpmDependencyProvision({ runtime, producerInput }),
  });
}
