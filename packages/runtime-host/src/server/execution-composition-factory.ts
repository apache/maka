import type { VerifiedGitRuntimeInput } from '@maka/storage/managed-workspace-owner';
import { resolveBundledGitRuntime } from './bundled-git-runtime.js';
import type { PublishedProjectDirectoryRoot } from './project-directory-authority.js';
import {
  createExecutionRuntimeHostComposition,
  type ExecutionRuntimeHostComposition,
} from './execution-composition.js';
import type { RuntimeHostCompositionContext } from './host-kernel.js';
import {
  defineInteractiveRuntimeHostComposition,
  type RuntimeHostCompositionSource,
} from './host-composition.js';

export interface ExecutionRuntimeHostCompositionSourceOptions {
  readonly managedWorkspaceGitRuntime?: VerifiedGitRuntimeInput;
  readonly bundledGitResourcesRoot?: string;
  readonly projectDirectoryRoots?: readonly PublishedProjectDirectoryRoot[];
}

export interface ExecutionRuntimeHostCompositionDependencies {
  readonly createComposition?: (
    context: RuntimeHostCompositionContext,
    options: Parameters<typeof createExecutionRuntimeHostComposition>[1],
  ) => Promise<ExecutionRuntimeHostComposition>;
}

export async function createExecutionRuntimeHostCompositionSource(
  options: ExecutionRuntimeHostCompositionSourceOptions,
  dependencies: ExecutionRuntimeHostCompositionDependencies = {},
): Promise<RuntimeHostCompositionSource> {
  if (options.managedWorkspaceGitRuntime && options.bundledGitResourcesRoot) {
    throw new Error('Managed workspace Git runtime must have exactly one authority');
  }
  const managedWorkspaceGitRuntime = options.bundledGitResourcesRoot
    ? await resolveBundledGitRuntime({ resourcesRoot: options.bundledGitResourcesRoot })
    : options.managedWorkspaceGitRuntime;
  const compositionOptions = {
    ...(managedWorkspaceGitRuntime ? { managedWorkspaceGitRuntime } : {}),
    ...(options.projectDirectoryRoots
      ? { projectDirectoryRoots: options.projectDirectoryRoots }
      : {}),
  };
  const createComposition = dependencies.createComposition ?? createExecutionRuntimeHostComposition;
  return defineInteractiveRuntimeHostComposition((context) =>
    createComposition(context, compositionOptions),
  );
}
