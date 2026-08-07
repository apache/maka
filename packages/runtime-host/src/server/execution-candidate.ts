import {
  resolveExistingStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import type { RuntimeHostCandidateOptions } from './candidate.js';
import type { VerifiedGitRuntimeInput } from '@maka/storage/managed-workspace-owner';
import { resolveBundledGitRuntime } from './bundled-git-runtime.js';
import {
  createExecutionRuntimeHostComposition,
  type CreateExecutionRuntimeHostCompositionOptions,
  type ExecutionRuntimeHostComposition,
} from './execution-composition.js';
import type { RuntimeHostCompositionContext } from './host-kernel.js';
import { RuntimeHostKernel } from './host-kernel.js';

export type ExecutionRuntimeHostCandidateResult =
  | { kind: 'loser' }
  | { kind: 'winner'; host: RuntimeHostKernel };

export interface ExecutionRuntimeHostCandidateOptions extends RuntimeHostCandidateOptions {
  readonly managedWorkspaceGitRuntime?: VerifiedGitRuntimeInput;
  /** Packaged resource root containing bundled-git.json and the Git toolchain. */
  readonly bundledGitResourcesRoot?: string;
}

export interface ExecutionRuntimeHostCandidateDependencies {
  readonly createComposition?: (
    context: RuntimeHostCompositionContext,
    options: CreateExecutionRuntimeHostCompositionOptions,
  ) => Promise<ExecutionRuntimeHostComposition>;
}

export async function startExecutionRuntimeHostCandidate(
  options: ExecutionRuntimeHostCandidateOptions,
  dependencies: ExecutionRuntimeHostCandidateDependencies = {},
): Promise<ExecutionRuntimeHostCandidateResult> {
  if (options.managedWorkspaceGitRuntime && options.bundledGitResourcesRoot) {
    throw new Error('Managed workspace Git runtime must have exactly one authority');
  }
  const managedWorkspaceGitRuntime = options.bundledGitResourcesRoot
    ? await resolveBundledGitRuntime({ resourcesRoot: options.bundledGitResourcesRoot })
    : options.managedWorkspaceGitRuntime;
  const capability = await resolveExistingStorageRoot({
    path: options.rootPath,
    kind: 'interactive',
    expectedRootId: options.expectedRootId,
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  if (!owner) return { kind: 'loser' };
  const host = await RuntimeHostKernel.start({
    owner,
    idleGraceMs: options.idleGraceMs,
    handshakeTimeoutMs: options.handshakeTimeoutMs,
    compositionFactory: (context) =>
      (dependencies.createComposition ?? createExecutionRuntimeHostComposition)(context, {
        ...(managedWorkspaceGitRuntime ? { managedWorkspaceGitRuntime } : {}),
        ...(options.legacyConfigurationRoot
          ? { legacyConfigurationRoot: options.legacyConfigurationRoot }
          : {}),
      }),
  });
  return { kind: 'winner', host };
}
