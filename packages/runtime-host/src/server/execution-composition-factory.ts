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
  const compositionOptions = {
    ...(options.projectDirectoryRoots
      ? { projectDirectoryRoots: options.projectDirectoryRoots }
      : {}),
  };
  const createComposition = dependencies.createComposition ?? createExecutionRuntimeHostComposition;
  return defineInteractiveRuntimeHostComposition((context) =>
    createComposition(context, compositionOptions),
  );
}
