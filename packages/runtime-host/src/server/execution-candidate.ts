import {
  resolveExistingStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import type { RuntimeHostCandidateOptions } from './candidate.js';
import type { VerifiedGitRuntimeInput } from '@maka/storage/managed-workspace-owner';
import {
  createExecutionRuntimeHostCompositionFactory,
  type ExecutionRuntimeHostCompositionDependencies,
} from './execution-composition-factory.js';
import { RuntimeHostKernel } from './host-kernel.js';

export type ExecutionRuntimeHostCandidateResult =
  | { kind: 'loser' }
  | { kind: 'winner'; host: RuntimeHostKernel };

export interface ExecutionRuntimeHostCandidateOptions extends RuntimeHostCandidateOptions {
  readonly managedWorkspaceGitRuntime?: VerifiedGitRuntimeInput;
  /** Packaged resource root containing bundled-git.json and the Git toolchain. */
  readonly bundledGitResourcesRoot?: string;
}

export type ExecutionRuntimeHostCandidateDependencies = ExecutionRuntimeHostCompositionDependencies;

export async function startExecutionRuntimeHostCandidate(
  options: ExecutionRuntimeHostCandidateOptions,
  dependencies: ExecutionRuntimeHostCandidateDependencies = {},
): Promise<ExecutionRuntimeHostCandidateResult> {
  const compositionFactory = await createExecutionRuntimeHostCompositionFactory(
    options,
    dependencies,
  );
  const capability = await resolveExistingStorageRoot({
    path: options.rootPath,
    kind: 'interactive',
    expectedRootId: options.expectedRootId,
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  if (!owner) return { kind: 'loser' };
  const host = await RuntimeHostKernel.start({
    owner,
    lifecycleMode: 'ephemeral',
    idleGraceMs: options.idleGraceMs,
    handshakeTimeoutMs: options.handshakeTimeoutMs,
    compositionFactory,
  });
  return { kind: 'winner', host };
}
