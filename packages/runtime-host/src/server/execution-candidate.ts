import type { VerifiedGitRuntimeInput } from '@maka/storage/managed-workspace-owner';
import {
  startInteractiveRuntimeHostCandidate,
  type InteractiveRuntimeHostCandidateOptions,
  type InteractiveRuntimeHostCandidateResult,
} from './candidate.js';
import {
  createExecutionRuntimeHostCompositionSource,
  type ExecutionRuntimeHostCompositionDependencies,
} from './execution-composition-factory.js';

export type ExecutionRuntimeHostCandidateResult = InteractiveRuntimeHostCandidateResult;

export interface ExecutionRuntimeHostCandidateOptions
  extends InteractiveRuntimeHostCandidateOptions {
  readonly managedWorkspaceGitRuntime?: VerifiedGitRuntimeInput;
  /** Packaged resource root containing bundled-git.json and the Git toolchain. */
  readonly bundledGitResourcesRoot?: string;
  /** Packaged resource root containing bundled-npm.json and the npm runtime. */
  readonly bundledNpmResourcesRoot?: string;
}

export type ExecutionRuntimeHostCandidateDependencies = ExecutionRuntimeHostCompositionDependencies;

export async function startExecutionRuntimeHostCandidate(
  options: ExecutionRuntimeHostCandidateOptions,
  dependencies: ExecutionRuntimeHostCandidateDependencies = {},
): Promise<ExecutionRuntimeHostCandidateResult> {
  const composition = await createExecutionRuntimeHostCompositionSource(options, dependencies);
  return startInteractiveRuntimeHostCandidate(
    {
      ...options,
      ...(options.bundledNpmResourcesRoot
        ? { hostCapabilities: ['managed_workspace_inspection_v1'] as const }
        : {}),
    },
    composition,
  );
}
