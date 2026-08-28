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

import { resolveStorageRoot } from '@maka/storage/root-authority';
import {
  createExecutionRuntimeHostCompositionSource,
  type ExecutionRuntimeHostCompositionDependencies,
} from './execution-composition-factory.js';
import {
  currentRuntimeHostProcessLaunch,
  tryAcquireRuntimeHostLaunch,
  type RuntimeHostManagedDeploymentAuthorityOptions,
  type RuntimeHostManagedLaunchClaim,
  type RuntimeHostManagedProcessLaunch,
} from '../operator/managed-deployment.js';
import { RuntimeHostKernel } from './host-kernel.js';
import { openRuntimeHostAccessAuthority } from './access-authority.js';
import { startRuntimeHostAuthenticatedListenerSet } from './listener-set.js';
import type { StartRuntimeHostWebSocketListenerOptions } from './websocket-listener.js';
import type { PublishedProjectDirectoryRoot } from './project-directory-authority.js';
import type { RuntimeHostPeerListenerEndpointOptions } from './peer-listener.js';

export interface ExecutionRuntimeHostServiceOptions {
  readonly rootPath: string;
  readonly projectDirectoryRoots?: readonly PublishedProjectDirectoryRoot[];
  readonly handshakeTimeoutMs?: number;
  readonly shutdownGraceMs?: number;
  readonly managedLaunchClaim?: RuntimeHostManagedLaunchClaim;
  readonly websocket?: Omit<
    StartRuntimeHostWebSocketListenerOptions,
    'accessAuthority' | 'accept' | 'isReady'
  >;
  readonly peer?: RuntimeHostPeerListenerEndpointOptions;
}

export interface ExecutionRuntimeHostServiceDependencies
  extends ExecutionRuntimeHostCompositionDependencies {
  /** Test-only authority-location override. */
  readonly managedDeploymentAuthority?: RuntimeHostManagedDeploymentAuthorityOptions;
  /** Test-only process-identity override. Production derives this from the running process. */
  readonly processLaunch?: RuntimeHostManagedProcessLaunch;
}

export class RuntimeHostRootAlreadyOwnedError extends Error {
  readonly code = 'root_already_owned';

  constructor(readonly rootPath: string) {
    super(`Runtime Host root is already owned: ${rootPath}`);
    this.name = 'RuntimeHostRootAlreadyOwnedError';
  }
}

export async function startExecutionRuntimeHostService(
  options: ExecutionRuntimeHostServiceOptions,
  dependencies: ExecutionRuntimeHostServiceDependencies = {},
): Promise<RuntimeHostKernel> {
  const composition = await createExecutionRuntimeHostCompositionSource(options, dependencies);
  const capability = await resolveStorageRoot({ path: options.rootPath, kind: 'interactive' });
  const ownership = await tryAcquireRuntimeHostLaunch(
    capability,
    {
      lifecycleMode: 'supervised',
      claim: options.managedLaunchClaim,
      processLaunch: dependencies.processLaunch ?? currentRuntimeHostProcessLaunch(),
    },
    dependencies.managedDeploymentAuthority,
  );
  if (!ownership) throw new RuntimeHostRootAlreadyOwnedError(capability.canonicalPath);
  const { owner } = ownership;
  try {
    const accessAuthority = await openRuntimeHostAccessAuthority(owner.controlDirectory);
    return await RuntimeHostKernel.start({
      owner,
      lifecycleMode: 'service',
      handshakeTimeoutMs: options.handshakeTimeoutMs,
      shutdownGraceMs: options.shutdownGraceMs,
      composition,
      accessAuthority,
      ...(options.websocket || options.peer
        ? {
            listenerSetFactory: (input) =>
              startRuntimeHostAuthenticatedListenerSet(input, {
                ...(options.websocket
                  ? { websocket: { ...options.websocket, accessAuthority } }
                  : {}),
                ...(options.peer ? { peer: { ...options.peer, accessAuthority } } : {}),
              }),
          }
        : {}),
    });
  } catch (error) {
    if (!owner.closed) await owner.close();
    throw error;
  }
}
