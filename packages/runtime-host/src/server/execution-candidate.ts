import {
  resolveExistingStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import type { RuntimeHostCandidateOptions } from './candidate.js';
import type { VerifiedGitRuntimeInput } from '@maka/storage/managed-workspace-owner';
import { createExecutionRuntimeHostComposition } from './execution-composition.js';
import { RuntimeHostKernel } from './host-kernel.js';

export type ExecutionRuntimeHostCandidateResult =
  | { kind: 'loser' }
  | { kind: 'winner'; host: RuntimeHostKernel };

export interface ExecutionRuntimeHostCandidateOptions extends RuntimeHostCandidateOptions {
  readonly managedWorkspaceGitRuntime?: VerifiedGitRuntimeInput;
}

export async function startExecutionRuntimeHostCandidate(
  options: ExecutionRuntimeHostCandidateOptions,
): Promise<ExecutionRuntimeHostCandidateResult> {
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
      createExecutionRuntimeHostComposition(context, {
        ...(options.managedWorkspaceGitRuntime
          ? { managedWorkspaceGitRuntime: options.managedWorkspaceGitRuntime }
          : {}),
      }),
  });
  return { kind: 'winner', host };
}
