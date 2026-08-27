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
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { truncateUtf8 } from '@maka/core/diagnostic-log';
import {
  activateRuntimeHostManagedDeployment,
  connectRemoteRuntimeHost,
} from '@maka/runtime-host/client';
import {
  commitRuntimeHostManagedDeployment,
  readRuntimeHostManagedDeploymentConfig,
  RuntimeHostManagedDeploymentError as RuntimeHostDeploymentAuthorityError,
  encodeRuntimeHostSetupFrame,
  RUNTIME_HOST_SETUP_ERROR_CODE_MAX_BYTES,
  RUNTIME_HOST_SETUP_ERROR_MESSAGE_MAX_BYTES,
  type RuntimeHostManagedDeploymentConfig,
  type RuntimeHostSetupFrame,
  type RuntimeHostSetupPhase,
} from '@maka/runtime-host/operator';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_PROTOCOL_VERSION,
} from '@maka/runtime-host/protocol';
import {
  prepareRuntimeHostAccessCredential,
  replaceRuntimeHostAccessCredential,
  revokeRuntimeHostAccessCredential,
  type RuntimeHostAccessPreset,
} from './runtime-host-access-command.js';
import {
  isRuntimeHostManagedDeploymentCli,
  isRuntimeHostDevelopmentPackageVersion,
  openRuntimeHostManagedPackageDeployment,
  prepareRuntimeHostManagedPackageDeployment,
  removeRuntimeHostManagedDeployment,
  resolveRuntimeHostManagedPackageCliPath,
  resolveRuntimeHostManagedDeploymentRoot,
  RuntimeHostManagedDeploymentError,
} from './runtime-host-managed-deployment.js';
import {
  RuntimeHostUpdatePackageError,
  withRuntimeHostRegistryUpdatePackage,
} from './runtime-host-update-package.js';
import {
  resolveRuntimeHostRegistryUpdateCandidate,
  RuntimeHostUpdateDiscoveryError,
} from './runtime-host-update-discovery.js';
import { resolveStorageRoot, tryAcquireStateRootOwner } from '@maka/storage/root-authority';
import { createPlatformRuntimeHostServiceBackend } from './runtime-host-service-management-command.js';
import {
  manageRuntimeHostService,
  readRuntimeHostManagedServiceConfig,
  resolveRuntimeHostManagedServiceConfigPath,
  resolveRuntimeHostManagedServiceId,
  RuntimeHostServiceManagerError,
  withRuntimeHostManagedServiceDeploymentLock,
  withRuntimeHostManagedServiceLifecycleLock,
  type RuntimeHostManagedServiceResult,
  type RuntimeHostManagedServiceTarget,
  type RuntimeHostServiceBackend,
} from './runtime-host-service-manager.js';
import { expandWildcardListenAddresses } from './runtime-host-peer-management-command.js';

const SETUP_LOCK_TIMEOUT_MS = 5 * 60_000;

export interface RuntimeHostSetupCliOptions {
  readonly json: boolean;
  readonly clientDataRoot: string;
  readonly defaultRootPath: string;
  readonly sourcePackageRoot: string;
  readonly version: string;
  readonly principalId: string;
  readonly preset: RuntimeHostAccessPreset;
  readonly lifecycle?: 'supervised' | 'on_demand';
  readonly deferPairingCommit?: boolean;
  readonly bindPairingToClient?: boolean;
  readonly rootPath?: string;
  readonly projectDirectoryRoots?: readonly { readonly label: string; readonly path: string }[];
  readonly websocketPort?: number;
  readonly websocketPath?: string;
  readonly directPeer?: {
    readonly coordinationRelays: readonly string[];
  };
  readonly expectedTarget?: RuntimeHostManagedServiceTarget;
}

interface RuntimeHostSetupDeps {
  readonly manageService: typeof manageRuntimeHostService;
  readonly createBackend: (serviceId: string, clientDataRoot: string) => RuntimeHostServiceBackend;
  readonly openDeployment: typeof openRuntimeHostManagedPackageDeployment;
  readonly prepareDeployment: typeof prepareRuntimeHostManagedPackageDeployment;
  readonly prepareCredential: typeof prepareRuntimeHostAccessCredential;
  readonly replaceCredential: typeof replaceRuntimeHostAccessCredential;
  readonly revokeCredential: typeof revokeRuntimeHostAccessCredential;
  readonly verifyCredential: typeof verifyRuntimeHostSetupCredential;
  readonly activateManaged: typeof activateRuntimeHostManagedDeployment;
  readonly resolveRegistryCandidate: typeof resolveRuntimeHostRegistryUpdateCandidate;
  readonly withRegistryPackage: typeof withRuntimeHostRegistryUpdatePackage;
  readonly writeOutput: (value: string) => unknown;
  readonly writeError: (value: string) => unknown;
}

class RuntimeHostSetupError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RuntimeHostSetupError';
  }
}

export async function runRuntimeHostSetupCli(
  options: RuntimeHostSetupCliOptions,
  overrides: Partial<RuntimeHostSetupDeps> = {},
): Promise<number> {
  const deps: RuntimeHostSetupDeps = {
    manageService: manageRuntimeHostService,
    createBackend: createPlatformRuntimeHostServiceBackend,
    openDeployment: openRuntimeHostManagedPackageDeployment,
    prepareDeployment: prepareRuntimeHostManagedPackageDeployment,
    prepareCredential: prepareRuntimeHostAccessCredential,
    replaceCredential: replaceRuntimeHostAccessCredential,
    revokeCredential: revokeRuntimeHostAccessCredential,
    verifyCredential: verifyRuntimeHostSetupCredential,
    activateManaged: activateRuntimeHostManagedDeployment,
    resolveRegistryCandidate: resolveRuntimeHostRegistryUpdateCandidate,
    withRegistryPackage: withRuntimeHostRegistryUpdatePackage,
    writeOutput: (value) => process.stdout.write(value),
    writeError: (value) => process.stderr.write(value),
    ...overrides,
  };
  const emit = createEmitter(options.json, deps);
  try {
    await withRuntimeHostManagedServiceDeploymentLock(
      options.clientDataRoot,
      () =>
        withRuntimeHostManagedServiceLifecycleLock(
          options.clientDataRoot,
          () => runRuntimeHostSetupLocked(options, deps, emit),
          SETUP_LOCK_TIMEOUT_MS,
        ),
      SETUP_LOCK_TIMEOUT_MS,
    );
    return 0;
  } catch (error) {
    const failure = setupFailure(error);
    emit({ kind: 'error', error: failure });
    return 1;
  }
}

async function runRuntimeHostSetupLocked(
  options: RuntimeHostSetupCliOptions,
  deps: RuntimeHostSetupDeps,
  emit: SetupEmitter,
): Promise<void> {
  if (options.lifecycle === 'on_demand') {
    await runRuntimeHostOnDemandSetupLocked(options, deps, emit);
    return;
  }
  emit({ kind: 'progress', phase: 'checking_environment' });
  const serviceId = resolveRuntimeHostManagedServiceId(options.clientDataRoot);
  const backend = deps.createBackend(serviceId, options.clientDataRoot);
  const common = {
    clientDataRoot: options.clientDataRoot,
    defaultRootPath: options.defaultRootPath,
    nodePath: process.execPath,
    cliPath: join(options.sourcePackageRoot, 'dist', 'cli.js'),
    ...(options.expectedTarget ? { expectedTarget: options.expectedTarget } : {}),
  } as const;
  const status = await deps.manageService({ ...common, action: 'status' }, backend);
  await assertCompatibleExistingVersion(status, options.version);
  const currentPackage = currentManagedPackage(status, serviceId, options.version);

  emit({ kind: 'progress', phase: 'installing_package' });
  const deployment = currentPackage
    ? await deps.openDeployment({
        serviceId,
        clientDataRoot: options.clientDataRoot,
        deploymentRoot: currentPackage.deploymentRoot,
        cliPath: currentPackage.cliPath,
        version: options.version,
      })
    : await deps.prepareDeployment({
        serviceId,
        clientDataRoot: options.clientDataRoot,
        sourcePackageRoot: options.sourcePackageRoot,
        version: options.version,
      });

  emit({ kind: 'progress', phase: 'installing_service' });
  let installed: RuntimeHostManagedServiceResult;
  try {
    installed = await deps.manageService(
      {
        ...common,
        action: 'install',
        cliPath: deployment.cliPath,
        ...(options.rootPath ? { rootPath: options.rootPath } : {}),
        ...(options.projectDirectoryRoots
          ? { projectDirectoryRoots: options.projectDirectoryRoots }
          : {}),
        ...(options.websocketPort === undefined ? {} : { websocketPort: options.websocketPort }),
        ...(options.websocketPath ? { websocketPath: options.websocketPath } : {}),
        ...(options.directPeer
          ? { peer: { coordinationRelays: options.directPeer.coordinationRelays } }
          : {}),
      },
      backend,
    );
  } catch (error) {
    try {
      await deployment.rollback();
    } catch (rollbackError) {
      throw new RuntimeHostSetupError(
        'deployment_failed',
        'Runtime Host setup failed and its staged package could not be removed',
        { cause: new AggregateError([error, rollbackError]) },
      );
    }
    throw error;
  }
  const config = installed.service.config;
  if (!config || !installed.service.active) {
    throw new RuntimeHostSetupError(
      'service_not_ready',
      'Managed Runtime Host service did not become ready',
    );
  }
  await deployment.activate();
  await deployment.cleanup();

  await pairAndVerifyRuntimeHostSetup(
    options,
    {
      serviceId,
      operatorPath: deployment.operatorPath,
      rootPath: config.rootPath,
      endpoint: websocketUrl(config.websocket),
      ...(config.peer?.enabled
        ? {
            directPeer: {
              peerId: config.peer.peerId,
              routeHints: expandWildcardListenAddresses(config.peer.listenAddresses),
              coordinationRelays: [...config.peer.coordinationRelays],
            },
          }
        : {}),
    },
    deps,
    emit,
  );
}

async function runRuntimeHostOnDemandSetupLocked(
  options: RuntimeHostSetupCliOptions,
  deps: RuntimeHostSetupDeps,
  emit: SetupEmitter,
): Promise<void> {
  if (options.expectedTarget) {
    throw new RuntimeHostSetupError(
      'lifecycle_owner_exists',
      'On-demand setup cannot replace an existing managed service',
    );
  }
  if (options.directPeer) {
    throw new RuntimeHostSetupError(
      'unsupported_lifecycle_configuration',
      'On-demand setup does not support a Direct peer listener',
    );
  }
  try {
    await readRuntimeHostManagedServiceConfig(
      resolveRuntimeHostManagedServiceConfigPath(options.clientDataRoot),
    );
    throw new RuntimeHostSetupError(
      'lifecycle_owner_exists',
      'Remove or migrate the existing managed Runtime Host service before on-demand setup',
    );
  } catch (error) {
    if (!(error instanceof RuntimeHostServiceManagerError) || error.code !== 'not_installed') {
      throw error;
    }
  }
  emit({ kind: 'progress', phase: 'checking_environment' });
  const capability = await resolveStorageRoot({
    path: resolve(options.rootPath ?? options.defaultRootPath),
    kind: 'interactive',
  });
  const candidate = await deps.resolveRegistryCandidate({
    kind: 'exact',
    version: options.version,
  });
  const serviceId = capability.rootId;
  const deploymentRoot = resolveRuntimeHostManagedDeploymentRoot(serviceId);
  let config: RuntimeHostManagedDeploymentConfig = {
    schemaVersion: 1,
    deploymentId: randomUUID(),
    configRevision: 1,
    deploymentRoot,
    root: { path: capability.canonicalPath, id: capability.rootId },
    projectDirectoryRoots: options.projectDirectoryRoots?.map(({ label, path }) => ({
      label,
      path: resolve(path),
    })) ?? [{ label: '~', path: resolve(homedir()) }],
    launch: {
      kind: 'exact_package',
      nodePath: process.execPath,
      package: {
        kind: 'npm_registry',
        version: candidate.version,
        integrity: candidate.integrity,
      },
    },
    listeners: {
      localIpc: true,
      websocket: {
        host: '127.0.0.1',
        port: options.websocketPort ?? 0,
        path: options.websocketPath ?? '/runtime-host',
      },
    },
    lifecycle: { mode: 'on_demand', availability: 'activation' },
    reconciliation: { trigger: 'manual' },
  };
  let operatorPath: string | undefined;
  await deps.withRegistryPackage(candidate, async (packageRoot) => {
    const owner = await tryAcquireStateRootOwner(capability);
    if (!owner) {
      throw new RuntimeHostSetupError(
        'state_root_owned',
        'The State Root must be idle before on-demand setup',
      );
    }
    let committed = false;
    let created = false;
    try {
      emit({ kind: 'progress', phase: 'installing_package' });
      const existing = await readRuntimeHostManagedDeploymentConfig(capability);
      if (existing && !sameDesiredOnDemandDeployment(existing, config)) {
        throw new RuntimeHostSetupError(
          'lifecycle_owner_exists',
          'The State Root already has a different managed deployment',
        );
      }
      if (existing) config = existing;
      created = !existing;
      const deployment = existing
        ? await deps.openDeployment({
            serviceId,
            clientDataRoot: options.clientDataRoot,
            deploymentRoot,
            cliPath: resolveRuntimeHostManagedPackageCliPath(
              deploymentRoot,
              candidate.version,
              candidate.integrity,
            ),
            version: candidate.version,
          })
        : await deps.prepareDeployment({
            serviceId,
            clientDataRoot: options.clientDataRoot,
            sourcePackageRoot: packageRoot,
            version: candidate.version,
            packageIntegrity: candidate.integrity,
          });
      operatorPath = deployment.operatorPath;
      emit({ kind: 'progress', phase: 'installing_service' });
      await deployment.activate();
      await commitRuntimeHostManagedDeployment(owner, config);
      committed = true;
      await deployment.cleanup();
    } catch (error) {
      if (
        created &&
        !committed &&
        !(
          error instanceof RuntimeHostDeploymentAuthorityError &&
          error.code === 'deployment_commit_unknown'
        )
      ) {
        await removeRuntimeHostManagedDeployment(deploymentRoot, serviceId).catch(() => undefined);
      }
      throw error;
    } finally {
      await owner.close();
    }
  });
  if (!operatorPath)
    throw new RuntimeHostSetupError('deployment_failed', 'Setup did not install an operator');

  const activation = await deps.activateManaged({ rootId: capability.rootId });
  await pairAndVerifyRuntimeHostSetup(
    options,
    {
      serviceId,
      operatorPath,
      rootPath: capability.canonicalPath,
      endpoint: websocketUrl({
        host: activation.endpoint.host,
        port: activation.endpoint.port,
        path: activation.endpoint.websocketPath,
      }),
    },
    deps,
    emit,
  );
}

async function pairAndVerifyRuntimeHostSetup(
  options: RuntimeHostSetupCliOptions,
  target: {
    readonly serviceId: string;
    readonly operatorPath: string;
    readonly rootPath: string;
    readonly endpoint: string;
    readonly directPeer?: {
      readonly peerId: string;
      readonly routeHints: readonly string[];
      readonly coordinationRelays: readonly string[];
    };
  },
  deps: RuntimeHostSetupDeps,
  emit: SetupEmitter,
): Promise<void> {
  emit({ kind: 'progress', phase: 'pairing_client' });
  let paired: Awaited<ReturnType<typeof prepareRuntimeHostAccessCredential>>;
  try {
    const pairCredential = options.deferPairingCommit
      ? deps.prepareCredential
      : deps.replaceCredential;
    paired = await pairCredential({
      rootPath: target.rootPath,
      principalKind: 'remote_owner',
      principalId: options.principalId,
      operationGrants: [],
      canPublishClientCapabilities: false,
      canUseHostPaths: false,
      preset: options.preset,
      ...(options.bindPairingToClient ? { bindClientInstance: true } : {}),
    });
  } catch (error) {
    throw new RuntimeHostSetupError(
      'pairing_failed',
      'Runtime Host could not pair the requested Client identity',
      { cause: error },
    );
  }

  emit({ kind: 'progress', phase: 'verifying_connection' });
  try {
    await deps.verifyCredential({
      endpoint: target.endpoint,
      rootId: paired.rootId,
      credential: paired.credential,
    });
    emit({
      kind: 'complete',
      version: options.version,
      serviceId: target.serviceId,
      operatorPath: target.operatorPath,
      rootPath: target.rootPath,
      rootId: paired.rootId,
      endpoint: target.endpoint,
      credentialId: paired.credentialId,
      credential: paired.credential,
      ...(target.directPeer
        ? {
            directPeer: {
              peerId: target.directPeer.peerId,
              routeHints: [...target.directPeer.routeHints],
              coordinationRelays: [...target.directPeer.coordinationRelays],
            },
          }
        : {}),
    });
  } catch (error) {
    if (options.deferPairingCommit) {
      try {
        await deps.revokeCredential({
          rootPath: target.rootPath,
          credentialId: paired.credentialId,
        });
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Runtime Host pairing failed and its candidate credential could not be revoked',
        );
      }
    }
    throw error;
  }
}

function sameDesiredOnDemandDeployment(
  current: RuntimeHostManagedDeploymentConfig,
  requested: RuntimeHostManagedDeploymentConfig,
): boolean {
  const { deploymentId: _currentId, ...currentDesiredState } = current;
  const { deploymentId: _requestedId, ...requestedDesiredState } = requested;
  return isDeepStrictEqual(currentDesiredState, requestedDesiredState);
}

function currentManagedPackage(
  status: RuntimeHostManagedServiceResult,
  serviceId: string,
  version: string,
):
  | {
      readonly deploymentRoot: string;
      readonly cliPath: string;
    }
  | undefined {
  const config = status.service.config;
  if (
    status.service.installedVersion !== version ||
    !config?.managedDeploymentRoot ||
    !isRuntimeHostManagedDeploymentCli(
      config.managedDeploymentRoot,
      serviceId,
      config.launch.cliPath,
    )
  ) {
    return undefined;
  }
  return {
    deploymentRoot: config.managedDeploymentRoot,
    cliPath: config.launch.cliPath,
  };
}

async function assertCompatibleExistingVersion(
  status: RuntimeHostManagedServiceResult,
  version: string,
): Promise<void> {
  if (!status.service.config) {
    if (!status.service.installed) return;
    throw new RuntimeHostSetupError(
      'existing_installation_unknown',
      'The installed Runtime Host configuration is unavailable; repair it before setup',
    );
  }
  const existingVersion = status.service.installedVersion;
  if (!existingVersion) {
    throw new RuntimeHostSetupError(
      'existing_installation_unknown',
      'The installed Runtime Host version could not be identified; repair it before setup',
    );
  }
  if (
    existingVersion !== version &&
    !(
      isRuntimeHostDevelopmentPackageVersion(existingVersion) &&
      isRuntimeHostDevelopmentPackageVersion(version)
    )
  ) {
    throw new RuntimeHostSetupError(
      'version_change_requires_update',
      `Runtime Host ${String(existingVersion)} is already installed; changing to ${version} requires the update workflow`,
    );
  }
}

async function verifyRuntimeHostSetupCredential(input: {
  readonly endpoint: string;
  readonly rootId: string;
  readonly credential: string;
}): Promise<void> {
  const result = await connectRemoteRuntimeHost({
    url: input.endpoint,
    credential: input.credential,
    expectedRootId: input.rootId,
    compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
  });
  if (result.kind !== 'connected') {
    throw new RuntimeHostSetupError(
      'verification_failed',
      `The paired Runtime Host connection could not be verified (${result.kind})`,
    );
  }
  try {
    const status = await result.connection.status();
    if (status.state !== 'ready') {
      throw new RuntimeHostSetupError(
        'verification_failed',
        `The paired Runtime Host is ${status.state}`,
      );
    }
  } finally {
    await result.connection.close();
  }
}

type SetupEmitter = (
  frame:
    | Omit<Extract<RuntimeHostSetupFrame, { kind: 'progress' }>, 'schemaVersion' | 'sequence'>
    | Omit<Extract<RuntimeHostSetupFrame, { kind: 'complete' }>, 'schemaVersion' | 'sequence'>
    | Omit<Extract<RuntimeHostSetupFrame, { kind: 'error' }>, 'schemaVersion' | 'sequence'>,
) => void;

function createEmitter(json: boolean, deps: RuntimeHostSetupDeps): SetupEmitter {
  let sequence = 0;
  return (input) => {
    const frame = { schemaVersion: 1, sequence: sequence++, ...input } as RuntimeHostSetupFrame;
    if (json) {
      deps.writeOutput(encodeRuntimeHostSetupFrame(frame));
      return;
    }
    if (frame.kind === 'progress') {
      deps.writeOutput(`${humanPhase(frame.phase)}\n`);
    } else if (frame.kind === 'complete') {
      deps.writeOutput(`${JSON.stringify(frame, null, 2)}\n`);
    } else {
      deps.writeError(`${frame.error.message}\n`);
    }
  };
}

function setupFailure(error: unknown): { code: string; message: string } {
  let code = 'internal_setup_failure';
  let message = 'Runtime Host setup failed';
  if (
    error instanceof RuntimeHostSetupError ||
    error instanceof RuntimeHostServiceManagerError ||
    error instanceof RuntimeHostManagedDeploymentError ||
    error instanceof RuntimeHostDeploymentAuthorityError ||
    error instanceof RuntimeHostUpdateDiscoveryError ||
    error instanceof RuntimeHostUpdatePackageError
  ) {
    code = error.code;
    message = error.message;
  }
  return {
    code: truncateUtf8(code, RUNTIME_HOST_SETUP_ERROR_CODE_MAX_BYTES) || 'internal_setup_failure',
    message:
      truncateUtf8(message, RUNTIME_HOST_SETUP_ERROR_MESSAGE_MAX_BYTES) ||
      'Runtime Host setup failed',
  };
}

function websocketUrl(input: {
  readonly host: string;
  readonly port: number;
  readonly path: string;
}) {
  return `ws://${input.host}:${input.port}${input.path}`;
}

function humanPhase(phase: RuntimeHostSetupPhase): string {
  switch (phase) {
    case 'checking_environment':
      return 'Checking the remote environment...';
    case 'installing_package':
      return 'Installing the managed Maka package...';
    case 'installing_service':
      return 'Installing the Runtime Host deployment...';
    case 'pairing_client':
      return 'Pairing the Client...';
    case 'verifying_connection':
      return 'Verifying the Runtime Host connection...';
  }
}
