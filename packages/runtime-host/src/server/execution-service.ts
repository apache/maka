import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import type { VerifiedGitRuntimeInput } from '@maka/storage/managed-workspace-owner';
import {
  createExecutionRuntimeHostCompositionFactory,
  type ExecutionRuntimeHostCompositionDependencies,
} from './execution-composition-factory.js';
import { RuntimeHostKernel } from './host-kernel.js';

export interface ExecutionRuntimeHostServiceOptions {
  readonly rootPath: string;
  readonly legacyConfigurationRoot?: string;
  readonly managedWorkspaceGitRuntime?: VerifiedGitRuntimeInput;
  readonly bundledGitResourcesRoot?: string;
  readonly handshakeTimeoutMs?: number;
  readonly shutdownGraceMs?: number;
}

export type ExecutionRuntimeHostServiceDependencies = ExecutionRuntimeHostCompositionDependencies;

export class RuntimeHostRootAlreadyOwnedError extends Error {
  readonly code = 'root_already_owned';

  constructor(readonly rootPath: string) {
    super(`Runtime Host root is already owned: ${rootPath}`);
    this.name = 'RuntimeHostRootAlreadyOwnedError';
  }
}

export async function startExecutionRuntimeHostService(
  options: ExecutionRuntimeHostServiceOptions,
  dependencies: ExecutionRuntimeHostServiceDependencies = {},
): Promise<RuntimeHostKernel> {
  const compositionFactory = await createExecutionRuntimeHostCompositionFactory(
    options,
    dependencies,
  );
  const capability = await resolveStorageRoot({ path: options.rootPath, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  if (!owner) throw new RuntimeHostRootAlreadyOwnedError(capability.canonicalPath);
  return RuntimeHostKernel.start({
    owner,
    lifecycleMode: 'service',
    handshakeTimeoutMs: options.handshakeTimeoutMs,
    shutdownGraceMs: options.shutdownGraceMs,
    compositionFactory,
  });
}
