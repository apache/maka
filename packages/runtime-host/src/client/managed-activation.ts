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

import { randomUUID } from 'node:crypto';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_PROTOCOL_VERSION,
} from '../protocol/index.js';
import {
  resolveRuntimeHostManagedDeployment,
  resolveRuntimeHostNpmDeploymentLayout,
  runtimeHostManagedLaunchClaim,
  type RuntimeHostActivationResult,
  type RuntimeHostManagedDeploymentAuthorityOptions,
  type RuntimeHostManagedDeploymentConfig,
} from '../operator/index.js';
import {
  connectOrSpawnRuntimeHost,
  type ConnectOrSpawnRuntimeHostResult,
} from './connect-or-spawn.js';

export type RuntimeHostManagedActivationErrorCode =
  | 'deployment_not_on_demand'
  | 'activation_listener_missing'
  | 'activation_reconciliation_unavailable'
  | 'activation_failed'
  | 'activation_result_mismatch';

export class RuntimeHostManagedActivationError extends Error {
  constructor(
    readonly code: RuntimeHostManagedActivationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RuntimeHostManagedActivationError';
  }
}

export interface ActivateRuntimeHostManagedDeploymentInput {
  readonly rootId: string;
  readonly signal?: AbortSignal;
  readonly electionDeadlineMs?: number;
  readonly authority?: RuntimeHostManagedDeploymentAuthorityOptions;
}

interface ActivateRuntimeHostManagedDeploymentDependencies {
  readonly resolveDeployment: typeof resolveRuntimeHostManagedDeployment;
  readonly connectOrSpawn: typeof connectOrSpawnRuntimeHost;
  readonly reconcileActivation?: (
    config: RuntimeHostManagedDeploymentConfig,
    signal?: AbortSignal,
  ) => Promise<void>;
}

const DEFAULT_DEPENDENCIES: ActivateRuntimeHostManagedDeploymentDependencies = {
  resolveDeployment: resolveRuntimeHostManagedDeployment,
  connectOrSpawn: connectOrSpawnRuntimeHost,
};

export async function activateRuntimeHostManagedDeployment(
  input: ActivateRuntimeHostManagedDeploymentInput,
  overrides: Partial<ActivateRuntimeHostManagedDeploymentDependencies> = {},
): Promise<RuntimeHostActivationResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  input.signal?.throwIfAborted();
  let resolved = await dependencies.resolveDeployment(input.rootId, input.authority);
  let config = resolved.config;
  if (config.lifecycle.mode !== 'on_demand') {
    throw new RuntimeHostManagedActivationError(
      'deployment_not_on_demand',
      'The Runtime Host deployment is not configured for on-demand activation',
    );
  }
  if (!config.listeners.websocket) {
    throw new RuntimeHostManagedActivationError(
      'activation_listener_missing',
      'The on-demand Runtime Host deployment has no loopback WebSocket listener',
    );
  }
  if (config.reconciliation.trigger === 'activation') {
    if (!dependencies.reconcileActivation) {
      throw new RuntimeHostManagedActivationError(
        'activation_reconciliation_unavailable',
        'Activation-triggered reconciliation is not installed for this deployment',
      );
    }
    await dependencies.reconcileActivation(config, input.signal);
    input.signal?.throwIfAborted();
    resolved = await dependencies.resolveDeployment(input.rootId, input.authority);
    config = resolved.config;
    if (config.lifecycle.mode !== 'on_demand' || !config.listeners.websocket) {
      throw new RuntimeHostManagedActivationError(
        'activation_result_mismatch',
        'The Runtime Host deployment changed during activation reconciliation',
      );
    }
  }

  const layout = resolveRuntimeHostNpmDeploymentLayout(
    config.deploymentRoot,
    config.launch.package.integrity,
  );
  const result = await dependencies.connectOrSpawn({
    rootPath: resolved.capability.canonicalPath,
    protocol: {
      min: RUNTIME_HOST_PROTOCOL_VERSION,
      max: RUNTIME_HOST_PROTOCOL_VERSION,
    },
    compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    clientInstanceId: randomUUID(),
    candidateEntrypoint: layout.candidateEntrypoint,
    candidateExecutable: config.launch.nodePath,
    managedLaunchClaim: runtimeHostManagedLaunchClaim(config),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.electionDeadlineMs === undefined
      ? {}
      : { electionDeadlineMs: input.electionDeadlineMs }),
  });
  if (result.kind !== 'connected') throw activationConnectionError(result);
  try {
    const diagnostics = await result.connection.request('host.diagnostics.query', {});
    const registration = result.registration;
    if (
      registration.rootId !== config.root.id ||
      registration.lifecycleMode !== 'ephemeral' ||
      diagnostics.hostEpoch !== registration.hostEpoch ||
      diagnostics.pid !== registration.pid ||
      diagnostics.protocolVersion !== RUNTIME_HOST_PROTOCOL_VERSION
    ) {
      throw new RuntimeHostManagedActivationError(
        'activation_result_mismatch',
        'The activated Runtime Host identity does not match its registration',
      );
    }
    const endpoint = requireActivationEndpoint(
      registration.websocketEndpoints,
      config.listeners.websocket,
    );
    return {
      schemaVersion: 1,
      kind: 'result',
      deploymentId: config.deploymentId,
      configRevision: config.configRevision,
      rootId: config.root.id,
      hostEpoch: registration.hostEpoch,
      pid: registration.pid,
      protocolVersion: RUNTIME_HOST_PROTOCOL_VERSION,
      endpoint,
    };
  } finally {
    await result.connection.close().catch(() => undefined);
  }
}

function activationConnectionError(
  result: Exclude<ConnectOrSpawnRuntimeHostResult, { kind: 'connected' }>,
): RuntimeHostManagedActivationError {
  const reason = result.kind === 'failed' ? result.reason : result.kind;
  return new RuntimeHostManagedActivationError(
    'activation_failed',
    `The Runtime Host could not be activated (${reason})`,
  );
}

function requireActivationEndpoint(
  endpoints: readonly string[] | undefined,
  configured: { readonly port: number; readonly path: string },
): RuntimeHostActivationResult['endpoint'] {
  if (endpoints?.length !== 1) {
    throw new RuntimeHostManagedActivationError(
      'activation_result_mismatch',
      'The activated Runtime Host did not publish exactly one WebSocket endpoint',
    );
  }
  const url = new URL(endpoints[0]);
  const port = Number(url.port);
  if (
    url.protocol !== 'ws:' ||
    url.hostname !== '127.0.0.1' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    url.pathname !== configured.path ||
    (configured.port !== 0 && port !== configured.port)
  ) {
    throw new RuntimeHostManagedActivationError(
      'activation_result_mismatch',
      'The activated Runtime Host published an unexpected WebSocket endpoint',
    );
  }
  return { host: '127.0.0.1', port, websocketPath: url.pathname };
}
