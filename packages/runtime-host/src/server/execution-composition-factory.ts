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
