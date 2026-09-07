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
import {
  startRuntimeHostAuthenticatedListenerSet,
  type RuntimeHostListenerSet,
} from './listener-set.js';
import type { StartRuntimeHostWebSocketListenerOptions } from './websocket-listener.js';
import type { PublishedProjectDirectoryRoot } from './project-directory-authority.js';
import type { RuntimeHostPeerListenerConfiguration } from './peer-listener.js';
import {
  openRuntimeHostPeerMeshComponent,
  type RuntimeHostPeerMeshComponent,
} from '../peer-mesh/owner.js';
import {
  openRuntimeHostPeerEndpointOwner,
  type RuntimeHostPeerEndpointOwner,
} from '../peer-reachability/owner.js';

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
  readonly peer?: RuntimeHostPeerListenerConfiguration & {
    readonly meshDataRoot?: string;
  };
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
  const capability = await resolveStorageRoot({
    path: options.rootPath,
    kind: 'interactive',
  });
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
  let peerEndpointOwner: RuntimeHostPeerEndpointOwner | undefined;
  let peerMesh: RuntimeHostPeerMeshComponent | undefined;
  let host: RuntimeHostKernel | undefined;
  try {
    if (options.peer) {
      peerEndpointOwner = await openRuntimeHostPeerEndpointOwner({
        ...options.peer,
        dataRoot: options.peer.meshDataRoot ?? `${options.peer.keyPath}.state`,
        onBackgroundReachabilityError: (error) => {
          console.error('[runtime-host] peer reachability publication failed:', error);
        },
      });
      if (options.peer.meshDataRoot)
        try {
          peerMesh = await openRuntimeHostPeerMeshComponent({
            dataRoot: options.peer.meshDataRoot,
            endpoint: peerEndpointOwner,
            endpointKind: 'host',
            onBackgroundReconcileError: (error) => {
              console.error('[runtime-host] Peer Mesh background synchronization failed:', error);
            },
          });
        } catch (error) {
          console.error(
            '[runtime-host] Peer Mesh is unavailable; continuing with Direct peer:',
            error,
          );
        }
    }
    let peerTermination: { readonly error: unknown } | undefined;
    if (peerEndpointOwner) {
      const terminate = (error: unknown) => {
        peerTermination ??= { error };
        void host?.close().catch(() => undefined);
      };
      void peerEndpointOwner.closed.then(
        () => terminate(new Error('Runtime Host peer endpoint stopped unexpectedly')),
        terminate,
      );
    }
    if (peerMesh) {
      void peerMesh.closed.catch((error: unknown) => {
        console.error('[runtime-host] Peer Mesh stopped; Direct peer remains available:', error);
      });
    }
    const accessAuthority = await openRuntimeHostAccessAuthority(owner.controlDirectory);
    host = await RuntimeHostKernel.start({
      owner,
      lifecycleMode: 'service',
      handshakeTimeoutMs: options.handshakeTimeoutMs,
      shutdownGraceMs: options.shutdownGraceMs,
      composition,
      accessAuthority,
      ...(peerMesh ? { peerMesh: peerMesh.mesh } : {}),
      ...(options.websocket || peerEndpointOwner
        ? {
            listenerSetFactory: (input) =>
              startRuntimeHostAuthenticatedListenerSet(input, {
                ...(options.websocket
                  ? { websocket: { ...options.websocket, accessAuthority } }
                  : {}),
                ...(peerEndpointOwner
                  ? {
                      peer: {
                        client: peerEndpointOwner.client,
                        reachability: peerEndpointOwner.reachability,
                        accessAuthority,
                      },
                    }
                  : {}),
              }).then((listeners) =>
                peerEndpointOwner
                  ? attachPeerOwnerCleanup(listeners, peerEndpointOwner, peerMesh)
                  : listeners,
              ),
          }
        : {}),
    });
    if (peerTermination) {
      await host.close().catch(() => undefined);
      throw peerTermination.error;
    }
    return host;
  } catch (error) {
    await host?.close().catch(() => undefined);
    await peerMesh?.close().catch(() => undefined);
    await peerEndpointOwner?.close().catch(() => undefined);
    if (!owner.closed) await owner.close();
    throw error;
  }
}

export function attachPeerOwnerCleanup(
  listeners: RuntimeHostListenerSet,
  endpoint: RuntimeHostPeerEndpointOwner,
  mesh?: RuntimeHostPeerMeshComponent,
): RuntimeHostListenerSet {
  return {
    ...listeners,
    cleanup: async () => {
      const errors: unknown[] = [];
      await listeners.cleanup().catch((error: unknown) => errors.push(error));
      await mesh?.close().catch((error: unknown) => errors.push(error));
      await endpoint.close().catch((error: unknown) => errors.push(error));
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, 'Unable to close Runtime Host Direct peer resources');
      }
    },
  };
}
