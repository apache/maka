import type { VerifiedGitRuntimeInput } from '@maka/storage/managed-workspace-owner';
import { resolveBundledGitRuntime } from './bundled-git-runtime.js';
import {
  createExecutionRuntimeHostComposition,
  type ExecutionRuntimeHostComposition,
} from './execution-composition.js';
import type {
  RuntimeHostCompositionContext,
  RuntimeHostCompositionFactory,
} from './host-kernel.js';

export interface ExecutionRuntimeHostCompositionSourceOptions {
  readonly managedWorkspaceGitRuntime?: VerifiedGitRuntimeInput;
  readonly bundledGitResourcesRoot?: string;
  readonly legacyConfigurationRoot?: string;
}

export interface ExecutionRuntimeHostCompositionDependencies {
  readonly createComposition?: (
    context: RuntimeHostCompositionContext,
    options: Parameters<typeof createExecutionRuntimeHostComposition>[1],
  ) => Promise<ExecutionRuntimeHostComposition>;
}

export async function createExecutionRuntimeHostCompositionFactory(
  options: ExecutionRuntimeHostCompositionSourceOptions,
  dependencies: ExecutionRuntimeHostCompositionDependencies = {},
): Promise<RuntimeHostCompositionFactory> {
  if (options.managedWorkspaceGitRuntime && options.bundledGitResourcesRoot) {
    throw new Error('Managed workspace Git runtime must have exactly one authority');
  }
  const managedWorkspaceGitRuntime = options.bundledGitResourcesRoot
    ? await resolveBundledGitRuntime({ resourcesRoot: options.bundledGitResourcesRoot })
    : options.managedWorkspaceGitRuntime;
  const compositionOptions = {
    ...(managedWorkspaceGitRuntime ? { managedWorkspaceGitRuntime } : {}),
    ...(options.legacyConfigurationRoot
      ? { legacyConfigurationRoot: options.legacyConfigurationRoot }
      : {}),
  };
  const createComposition = dependencies.createComposition ?? createExecutionRuntimeHostComposition;
  return (context) => createComposition(context, compositionOptions);
}
