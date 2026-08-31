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

import {
  createFilesystemWorkerLaunchSpecProvider,
  FilesystemWorkerClient,
} from '@maka/runtime/filesystem-worker';
import {
  createBuiltinSandboxManager,
  isBuiltinFilesystemWorkerSandboxAvailable,
} from '@maka/runtime/sandbox';
import {
  createRuntimeHostWorkspaceExecutionComposition,
  RuntimeHostWorkspaceExecutionError,
  type RuntimeHostWorkspaceExecutionComposition,
  type RuntimeHostWorkspaceFilesystemWorker,
} from './workspace-execution-composition.js';

export interface RuntimeHostSandboxComposition {
  readonly sandboxManager: ReturnType<typeof createBuiltinSandboxManager>;
  readonly filesystemWorker: FilesystemWorkerClient | undefined;
  readonly workspaceExecution: RuntimeHostWorkspaceExecutionComposition;
}

export function runtimeHostFilesystemWorkerRuntime(versions: {
  readonly electron?: string;
}): 'electron' | 'node' {
  return versions.electron ? 'electron' : 'node';
}

/** Composes the Host sandbox and the read-only workspace execution adapter it owns. */
export function createRuntimeHostSandboxComposition(
  input: { readonly electronVersion?: string; readonly platform?: NodeJS.Platform } = {},
): RuntimeHostSandboxComposition {
  const sandboxManager = createBuiltinSandboxManager();
  const launchSpecProvider =
    sandboxManager && isBuiltinFilesystemWorkerSandboxAvailable()
      ? createFilesystemWorkerLaunchSpecProvider({
          runtime: runtimeHostFilesystemWorkerRuntime({
            ...(input.electronVersion ? { electron: input.electronVersion } : {}),
          }),
          platform: input.platform ?? process.platform,
          resourceLocation: { kind: 'runtime' },
        })
      : undefined;
  const filesystemWorker =
    sandboxManager && launchSpecProvider
      ? new FilesystemWorkerClient({ sandboxManager, getLaunchSpec: launchSpecProvider })
      : undefined;
  const workspaceExecution = createRuntimeHostWorkspaceExecutionComposition({
    ...(filesystemWorker
      ? { filesystemWorker: adaptWorkspaceFilesystemWorker(filesystemWorker) }
      : {}),
  });
  return Object.freeze({ sandboxManager, filesystemWorker, workspaceExecution });
}

export function adaptWorkspaceFilesystemWorker(
  worker: Pick<FilesystemWorkerClient, 'execute'>,
): RuntimeHostWorkspaceFilesystemWorker {
  return {
    async execute(input) {
      // Read-only operations never participate in CAS; the adapter says so
      // explicitly (#3484) instead of relying on an absent optional field.
      const result = await worker.execute({
        ...input,
        expectedIdentity: 'unchecked',
      });
      switch (result.kind) {
        case 'read':
        case 'read_image':
        case 'glob':
        case 'grep':
          return result;
        default:
          throw new RuntimeHostWorkspaceExecutionError(
            'workspace_operation_denied',
            `Read-only filesystem worker returned mutating result ${result.kind}`,
          );
      }
    },
  };
}
