/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { PublishedProjectDirectoryRoot } from './project-directory-authority.js';
import type { HostManagedFilesHelper } from './execution-model-composition.js';
import type {
  createExecutionRuntimeHostComposition,
  ExecutionRuntimeHostComposition,
} from './execution-composition.js';
import type { RuntimeHostCompositionContext } from './host-kernel.js';
import {
  defineInteractiveRuntimeHostComposition,
  type RuntimeHostCompositionSource,
} from './host-composition.js';

export interface ExecutionRuntimeHostCompositionSourceOptions {
  readonly initialization?: import('../client/connect-or-spawn.js').HostedRuntimeInitialization;
  readonly projectDirectoryRoots?: readonly PublishedProjectDirectoryRoot[];
}

export interface ExecutionRuntimeHostCompositionDependencies {
  readonly managedFilesHelper?: HostManagedFilesHelper;
  readonly prepareManagedFilesHelper?: () => Promise<HostManagedFilesHelper>;
  readonly createComposition?: (
    context: RuntimeHostCompositionContext,
    options: Parameters<typeof createExecutionRuntimeHostComposition>[1],
    dependencies: Parameters<typeof createExecutionRuntimeHostComposition>[2],
  ) => Promise<ExecutionRuntimeHostComposition>;
}

export async function createExecutionRuntimeHostCompositionSource(
  options: ExecutionRuntimeHostCompositionSourceOptions,
  dependencies: ExecutionRuntimeHostCompositionDependencies = {},
): Promise<RuntimeHostCompositionSource> {
  const admittedHelper = dependencies.managedFilesHelper
    ? Object.freeze({ ...dependencies.managedFilesHelper })
    : undefined;
  const prepareHelper = dependencies.prepareManagedFilesHelper;
  if (admittedHelper && prepareHelper)
    throw new Error('Managed helper has multiple startup owners');
  const override = dependencies.createComposition;
  const compositionOptions = {
    ...(options.initialization ? { initialization: options.initialization } : {}),
    ...(options.projectDirectoryRoots
      ? { projectDirectoryRoots: options.projectDirectoryRoots }
      : {}),
  };
  return defineInteractiveRuntimeHostComposition(async (context) => {
    const managedFilesHelper =
      admittedHelper ?? (prepareHelper ? Object.freeze({ ...(await prepareHelper()) }) : undefined);
    if (managedFilesHelper) {
      const startedAt = performance.now();
      const {
        requireGitoxideHelperOperationsInternal,
        verifyGitoxideHelperArtifactForInvocationInternal,
        GITOXIDE_HELPER_OPERATIONS_INTERNAL,
      } = await import('./gitoxide-helper-artifact-authority-internal.js');
      requireGitoxideHelperOperationsInternal(
        managedFilesHelper.invocationOwnerToken,
        managedFilesHelper.helperCapability,
        GITOXIDE_HELPER_OPERATIONS_INTERNAL,
      );
      const {
        runGitoxideOperationWithinDeadlineInternal,
        GITOXIDE_HELPER_OPERATION_TIMEOUTS_INTERNAL,
      } = await import('./gitoxide-helper-invocation-internal.js');
      await runGitoxideOperationWithinDeadlineInternal({
        deadlineAt: startedAt + GITOXIDE_HELPER_OPERATION_TIMEOUTS_INTERNAL.inspectRepositoryMs,
        operation: () =>
          verifyGitoxideHelperArtifactForInvocationInternal(
            managedFilesHelper.invocationOwnerToken,
            managedFilesHelper.helperCapability,
          ),
      });
    }
    // Load the execution graph only after the candidate owns the root and the
    // kernel has published its listener. Cold imports must not hide recovery
    // from connecting clients or delay candidates that lose the owner lock.
    const createComposition =
      override ??
      (await import('./execution-composition.js')).createExecutionRuntimeHostComposition;
    const composition = await createComposition(context, compositionOptions, {
      ...(managedFilesHelper ? { managedFilesHelper } : {}),
    });
    Object.defineProperty(composition, 'managedFilesResume', {
      value: managedFilesHelper !== undefined,
      enumerable: true,
      writable: false,
      configurable: false,
    });
    return composition;
  });
}
