import type { VerifiedGitRuntimeInput } from '@maka/storage/managed-workspace-owner';
import { resolveBundledGitRuntime } from './bundled-git-runtime.js';
import { resolveBundledNpmRuntime } from './bundled-npm-runtime.js';
import {
  createExecutionRuntimeHostComposition,
  type ExecutionRuntimeHostComposition,
} from './execution-composition.js';
import type { RuntimeHostCompositionContext } from './host-kernel.js';
import {
  defineInteractiveRuntimeHostComposition,
  type RuntimeHostCompositionSource,
} from './host-composition.js';
import { createManagedNpmDependencyEnvironmentProducer } from './managed-npm-dependency-producer.js';

export interface ExecutionRuntimeHostCompositionSourceOptions {
  readonly managedWorkspaceGitRuntime?: VerifiedGitRuntimeInput;
  readonly bundledGitResourcesRoot?: string;
  readonly bundledNpmResourcesRoot?: string;
  readonly legacyConfigurationRoot?: string;
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
  if (options.bundledNpmResourcesRoot && !managedWorkspaceGitRuntime) {
    throw new Error('Managed dependency provisioning requires managed workspace Git authority');
  }
  const managedWorkspaceDependencyProducer = options.bundledNpmResourcesRoot
    ? createManagedNpmDependencyEnvironmentProducer(
        await resolveBundledNpmRuntime({ resourcesRoot: options.bundledNpmResourcesRoot }),
      )
    : undefined;
  const compositionOptions = {
    ...(managedWorkspaceGitRuntime ? { managedWorkspaceGitRuntime } : {}),
    ...(options.legacyConfigurationRoot
      ? { legacyConfigurationRoot: options.legacyConfigurationRoot }
      : {}),
    ...(managedWorkspaceDependencyProducer ? { managedWorkspaceDependencyProducer } : {}),
  };
  const createComposition = dependencies.createComposition ?? createExecutionRuntimeHostComposition;
  return defineInteractiveRuntimeHostComposition((context) =>
    createComposition(context, compositionOptions),
  );
}
