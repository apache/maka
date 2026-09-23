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

import { resolveExistingStorageRoot } from '@maka/storage/root-authority';
import {
  currentRuntimeHostProcessLaunch,
  tryAcquireRuntimeHostLaunch,
  type RuntimeHostManagedDeploymentAuthorityOptions,
  type RuntimeHostManagedDeploymentConfig,
  type RuntimeHostManagedLaunchClaim,
  type RuntimeHostManagedProcessLaunch,
} from '../operator/managed-deployment.js';
import type { RuntimeHostCompositionSource } from './host-composition-source.js';
import type { RuntimeHostKernel } from './host-kernel.js';

export interface InteractiveRuntimeHostCandidateOptions {
  rootPath: string;
  expectedRootId: string;
  initialConnectionTimeoutMs?: number;
  idleGraceMs?: number;
  handshakeTimeoutMs?: number;
  generation?: string;
  managedLaunchClaim?: RuntimeHostManagedLaunchClaim;
  /** Limits pre-commit admission for a launch-owner-supervised Candidate. */
  initialClientAdmission?: {
    isClientAdmitted(clientInstanceId: string): boolean;
  };
}

export interface InteractiveRuntimeHostCandidateDependencies {
  /** Test-only authority-location override. */
  readonly managedDeploymentAuthority?: RuntimeHostManagedDeploymentAuthorityOptions;
  /** Test-only process-identity override. Production derives this from the running process. */
  readonly processLaunch?: RuntimeHostManagedProcessLaunch;
}

export type InteractiveRuntimeHostCandidateResult =
  | { kind: 'loser' }
  | { kind: 'winner'; host: RuntimeHostKernel };

export type InteractiveRuntimeHostCompositionFactory = (
  managedConfig: RuntimeHostManagedDeploymentConfig | undefined,
) => RuntimeHostCompositionSource | Promise<RuntimeHostCompositionSource>;

export async function startInteractiveRuntimeHostCandidate(
  options: InteractiveRuntimeHostCandidateOptions,
  createComposition: InteractiveRuntimeHostCompositionFactory,
  dependencies: InteractiveRuntimeHostCandidateDependencies = {},
): Promise<InteractiveRuntimeHostCandidateResult> {
  const kernelModule = import('./host-kernel.js').then(
    (module) => ({ kind: 'loaded' as const, module }),
    (error: unknown) => ({ kind: 'failed' as const, error }),
  );
  const capability = await resolveExistingStorageRoot({
    path: options.rootPath,
    kind: 'interactive',
    expectedRootId: options.expectedRootId,
  });
  const ownership = await tryAcquireRuntimeHostLaunch(
    capability,
    {
      lifecycleMode: 'on_demand',
      claim: options.managedLaunchClaim,
      processLaunch: dependencies.processLaunch ?? currentRuntimeHostProcessLaunch(),
    },
    dependencies.managedDeploymentAuthority,
  );
  if (!ownership) return { kind: 'loser' };
  const { owner, managedConfig } = ownership;
  try {
    const composition = await createComposition(managedConfig);
    const loadedKernel = await kernelModule;
    if (loadedKernel.kind === 'failed') throw loadedKernel.error;
    const { RuntimeHostKernel } = loadedKernel.module;
    const websocket = managedConfig?.listeners.websocket;
    const accessAuthority = websocket
      ? await import('./access-authority.js').then(({ openRuntimeHostAccessAuthority }) =>
          openRuntimeHostAccessAuthority(owner.controlDirectory),
        )
      : undefined;
    const host = await RuntimeHostKernel.start({
      owner,
      lifecycleMode: 'ephemeral',
      initialConnectionTimeoutMs: options.initialConnectionTimeoutMs,
      idleGraceMs: options.idleGraceMs,
      handshakeTimeoutMs: options.handshakeTimeoutMs,
      generation: options.generation,
      composition,
      ...(options.initialClientAdmission
        ? { initialClientAdmission: options.initialClientAdmission }
        : {}),
      ...(accessAuthority ? { accessAuthority } : {}),
      ...(websocket && accessAuthority
        ? {
            listenerSetFactory: async (input) => {
              const { startRuntimeHostAuthenticatedListenerSet } = await import(
                './listener-set.js'
              );
              return startRuntimeHostAuthenticatedListenerSet(input, {
                websocket: { ...websocket, accessAuthority },
              });
            },
          }
        : {}),
    });
    return { kind: 'winner', host };
  } catch (error) {
    if (!owner.closed) await owner.close();
    throw error;
  }
}
