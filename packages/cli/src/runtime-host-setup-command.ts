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
  ensureRuntimeHostPeerIdentity,
} from '@maka/runtime-host/client';
import {
  commitRuntimeHostManagedDeployment,
  readRuntimeHostManagedDeploymentAuthorityRecord,
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
import {
  createPlatformRuntimeHostLifecycleProvider,
  createPlatformRuntimeHostServiceBackend,
} from './runtime-host-service-management-command.js';
import {
  allocateRuntimeHostLoopbackPort,
  allocateRuntimeHostPeerPort,
  effectiveRuntimeHostProjectDirectoryRoots,
  manageRuntimeHostService,
  readRuntimeHostManagedServiceConfig,
  removeRuntimeHostServiceFile,
  resolveRuntimeHostManagedServiceConfigPath,
  resolveRuntimeHostManagedServiceId,
  resolveRuntimeHostManagedProjectDirectoryRoots,
  RuntimeHostServiceManagerError,
  withRuntimeHostManagedServiceDeploymentLock,
  withRuntimeHostManagedServiceLifecycleLock,
  type RuntimeHostManagedServiceResult,
  type RuntimeHostManagedServiceConfig,
  type RuntimeHostManagedServiceTarget,
  type RuntimeHostServiceBackend,
} from './runtime-host-service-manager.js';
import { expandWildcardListenAddresses } from './runtime-host-peer-management-command.js';
import {
  applyRuntimeHostLifecycleTransition,
  activateRuntimeHostLifecycle,
  recoverRuntimeHostLifecycleTransition,
  replaceRuntimeHostLifecycle,
  retireRuntimeHostLifecycleOwner,
  runtimeHostReconciliationTriggerDefinition,
  runtimeHostSupervisorDefinition,
  verifyRuntimeHostLifecycleReady,
  type RuntimeHostLifecycleTransactionDeps,
} from './runtime-host-lifecycle-transaction.js';
import type { RuntimeHostLifecycleProvider } from './runtime-host-lifecycle-provider.js';
import {
  resolveRuntimeHostManagedPeerKeyPath,
  resolveRuntimeHostPeerNativePath,
} from './runtime-host-peer-artifact.js';

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
  readonly projectDirectoryRoots?: readonly {
    readonly label: string;
    readonly path: string;
  }[];
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
  readonly createLifecycleProvider: (rootId: string) => RuntimeHostLifecycleProvider;
  readonly applyLifecycleTransition: typeof applyRuntimeHostLifecycleTransition;
  readonly activateLifecycle: typeof activateRuntimeHostLifecycle;
  readonly recoverLifecycleTransition: typeof recoverRuntimeHostLifecycleTransition;
  readonly retireLifecycleOwner: typeof retireRuntimeHostLifecycleOwner;
  readonly replaceLifecycle: typeof replaceRuntimeHostLifecycle;
  readonly verifyLifecycleReady: typeof verifyRuntimeHostLifecycleReady;
  readonly openDeployment: typeof openRuntimeHostManagedPackageDeployment;
  readonly prepareDeployment: typeof prepareRuntimeHostManagedPackageDeployment;
  readonly prepareCredential: typeof prepareRuntimeHostAccessCredential;
  readonly replaceCredential: typeof replaceRuntimeHostAccessCredential;
  readonly revokeCredential: typeof revokeRuntimeHostAccessCredential;
  readonly verifyCredential: typeof verifyRuntimeHostSetupCredential;
  readonly activateManaged: typeof activateRuntimeHostManagedDeployment;
  readonly resolveRegistryCandidate: typeof resolveRuntimeHostRegistryUpdateCandidate;
  readonly withRegistryPackage: typeof withRuntimeHostRegistryUpdatePackage;
  readonly ensurePeerIdentity: typeof ensureRuntimeHostPeerIdentity;
  readonly resolvePeerNativePath: typeof resolveRuntimeHostPeerNativePath;
  readonly allocateLoopbackPort: typeof allocateRuntimeHostLoopbackPort;
  readonly allocatePeerPort: typeof allocateRuntimeHostPeerPort;
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
    createLifecycleProvider: createPlatformRuntimeHostLifecycleProvider,
    applyLifecycleTransition: applyRuntimeHostLifecycleTransition,
    activateLifecycle: activateRuntimeHostLifecycle,
    recoverLifecycleTransition: recoverRuntimeHostLifecycleTransition,
    retireLifecycleOwner: retireRuntimeHostLifecycleOwner,
    replaceLifecycle: replaceRuntimeHostLifecycle,
    verifyLifecycleReady: verifyRuntimeHostLifecycleReady,
    openDeployment: openRuntimeHostManagedPackageDeployment,
    prepareDeployment: prepareRuntimeHostManagedPackageDeployment,
    prepareCredential: prepareRuntimeHostAccessCredential,
    replaceCredential: replaceRuntimeHostAccessCredential,
    revokeCredential: revokeRuntimeHostAccessCredential,
    verifyCredential: verifyRuntimeHostSetupCredential,
    activateManaged: activateRuntimeHostManagedDeployment,
    resolveRegistryCandidate: resolveRuntimeHostRegistryUpdateCandidate,
    withRegistryPackage: withRuntimeHostRegistryUpdatePackage,
    ensurePeerIdentity: ensureRuntimeHostPeerIdentity,
    resolvePeerNativePath: resolveRuntimeHostPeerNativePath,
    allocateLoopbackPort: allocateRuntimeHostLoopbackPort,
    allocatePeerPort: allocateRuntimeHostPeerPort,
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
  const target = await runRuntimeHostSupervisedSetupLocked(options, deps, emit);
  await pairAndVerifyRuntimeHostSetup(options, target, deps, emit);
}

async function runRuntimeHostSupervisedSetupLocked(
  options: RuntimeHostSetupCliOptions,
  deps: RuntimeHostSetupDeps,
  emit: SetupEmitter,
): Promise<{
  readonly serviceId: string;
  readonly operatorPath: string;
  readonly rootPath: string;
  readonly endpoint: string;
  readonly directPeer?: {
    readonly peerId: string;
    readonly routeHints: readonly string[];
    readonly coordinationRelays: readonly string[];
  };
}> {
  emit({ kind: 'progress', phase: 'checking_environment' });
  const legacyServiceId = resolveRuntimeHostManagedServiceId(options.clientDataRoot);
  const legacyBackend = deps.createBackend(legacyServiceId, options.clientDataRoot);
  const legacyCommon = {
    clientDataRoot: options.clientDataRoot,
    defaultRootPath: options.defaultRootPath,
    nodePath: process.execPath,
    cliPath: join(options.sourcePackageRoot, 'dist', 'cli.js'),
    ...(options.expectedTarget ? { expectedTarget: options.expectedTarget } : {}),
  } as const;
  const legacyStatus = await deps.manageService(
    { ...legacyCommon, action: 'status' },
    legacyBackend,
  );
  const legacyConfig = legacyStatus.service.config;
  const capability = await resolveStorageRoot({
    path: resolve(
      options.rootPath ??
        legacyConfig?.rootPath ??
        options.expectedTarget?.rootPath ??
        options.defaultRootPath,
    ),
    kind: 'interactive',
  });
  const lifecycleProvider = deps.createLifecycleProvider(capability.rootId);
  const lifecycleDeps: RuntimeHostLifecycleTransactionDeps = {
    resolveProvider: (provider) => {
      if (provider !== lifecycleProvider.supervisor.provider) {
        throw new RuntimeHostSetupError(
          'unsupported_lifecycle_configuration',
          `The persisted Runtime Host provider ${provider} is unavailable on this computer`,
        );
      }
      return lifecycleProvider;
    },
    ...(legacyConfig ? legacyMigrationDeps(legacyConfig, legacyBackend) : {}),
  };
  let authority = await readRuntimeHostManagedDeploymentAuthorityRecord(capability);
  if (authority?.schemaVersion === 2) {
    const retirement = await deps.retireLifecycleOwner({
      rootPath: capability.canonicalPath,
      rootId: capability.rootId,
      ...(authority.from?.lifecycle.mode === 'supervised'
        ? {
            supervisor: lifecycleDeps.resolveProvider(authority.from.lifecycle.provider).supervisor,
          }
        : legacyConfig
          ? { supervisor: legacyBackend }
          : {}),
    });
    if (retirement.kind === 'active_tasks') {
      throw new RuntimeHostSetupError(
        'active_tasks',
        'Runtime Host lifecycle recovery is waiting for active work to finish',
      );
    }
    const recovered = await deps.recoverLifecycleTransition(
      retirement.owner,
      authority,
      lifecycleDeps,
    );
    await retirement.owner.close();
    if (recovered) {
      await deps.activateLifecycle(recovered, lifecycleDeps);
      await deps.verifyLifecycleReady(recovered, lifecycleDeps);
    } else if (legacyConfig) {
      await deps.manageService({ ...legacyCommon, action: 'start' }, legacyBackend);
    }
    authority = await readRuntimeHostManagedDeploymentAuthorityRecord(capability);
  }
  const current = authority?.schemaVersion === 1 ? authority : undefined;
  const legacyToMigrate = current ? null : legacyConfig;
  if (current && legacyConfig) await assertLegacyArtifactsAbsent(legacyBackend);
  if (legacyToMigrate) await assertCompatibleExistingVersion(legacyStatus, options.version);
  if (current && current.launch.package.version !== options.version) {
    throw new RuntimeHostSetupError(
      'version_change_requires_update',
      `Runtime Host ${current.launch.package.version} is already installed; changing to ${options.version} requires the update workflow`,
    );
  }

  const candidate = await deps.resolveRegistryCandidate({
    kind: 'exact',
    version: options.version,
  });
  if (current && !sameExactPackage(current, candidate)) {
    throw new RuntimeHostSetupError(
      'version_change_requires_update',
      `Runtime Host ${current.launch.package.version} is already installed; changing its exact package requires the update workflow`,
    );
  }
  return deps.withRegistryPackage(candidate, async (packageRoot) => {
    emit({ kind: 'progress', phase: 'installing_package' });
    const deployment = await deps.prepareDeployment({
      serviceId: capability.rootId,
      clientDataRoot: options.clientDataRoot,
      sourcePackageRoot: packageRoot,
      version: candidate.version,
      packageIntegrity: candidate.integrity,
    });
    const desired = await prepareSupervisedDeploymentConfig(
      options,
      deps,
      capability,
      deployment.cliPath,
      deployment.root,
      candidate,
      current,
      legacyToMigrate,
      lifecycleProvider,
    );
    if (current && !sameDesiredManagedDeployment(current, desired)) {
      if (current.lifecycle.mode === 'supervised') {
        throw new RuntimeHostSetupError(
          'configuration_changed',
          'Change an existing supervised Runtime Host through its explicit configure or update workflow',
        );
      }
    }
    const ownershipChanged = !current || !isDeepStrictEqual(current, desired);
    await deployment.activate();
    emit({ kind: 'progress', phase: 'installing_service' });
    let retirement: Awaited<ReturnType<typeof retireRuntimeHostLifecycleOwner>>;
    if (legacyToMigrate) {
      await legacyBackend.verifyDeployment(legacyToMigrate, {
        acceptLegacyConfigLaunch: true,
      });
      retirement = await deps.retireLifecycleOwner({
        rootPath: capability.canonicalPath,
        rootId: capability.rootId,
        supervisor: legacyBackend,
      });
    } else if (current) {
      retirement = await deps.retireLifecycleOwner({
        rootPath: capability.canonicalPath,
        rootId: capability.rootId,
        ...(current.lifecycle.mode === 'supervised'
          ? {
              supervisor: lifecycleDeps.resolveProvider(current.lifecycle.provider).supervisor,
            }
          : {}),
      });
    } else {
      const owner = await tryAcquireStateRootOwner(capability);
      if (!owner) {
        throw new RuntimeHostSetupError(
          'state_root_owned',
          'The State Root must be idle before supervised setup',
        );
      }
      retirement = { kind: 'retired', owner };
    }
    if (retirement.kind === 'active_tasks') {
      throw new RuntimeHostSetupError(
        'active_tasks',
        'Runtime Host setup is waiting for active work to finish',
      );
    }
    const owner = retirement.owner;
    try {
      if (ownershipChanged) {
        await deps.applyLifecycleTransition(
          owner,
          {
            operation: legacyToMigrate
              ? 'legacy_migration'
              : current
                ? 'lifecycle_change'
                : 'install',
            ...(current ? { current } : {}),
            desired,
          },
          lifecycleDeps,
        );
      } else {
        await lifecycleProvider.supervisor.preflight();
        await lifecycleProvider.supervisor.converge(runtimeHostSupervisorDefinition(desired));
        await lifecycleProvider.reconciliationTrigger.converge(
          runtimeHostReconciliationTriggerDefinition(desired),
        );
      }
    } finally {
      await owner.close();
    }
    try {
      await deps.activateLifecycle(desired, lifecycleDeps);
      await deps.verifyLifecycleReady(desired, lifecycleDeps);
    } catch (error) {
      if (ownershipChanged) {
        await rollbackActivatedManagedSetup(
          current,
          desired,
          legacyToMigrate,
          legacyBackend,
          lifecycleDeps,
          deps,
        ).catch((rollbackError) => {
          throw new RuntimeHostSetupError(
            'deployment_failed',
            'Runtime Host activation failed and the previous lifecycle owner could not be restored',
            { cause: new AggregateError([error, rollbackError]) },
          );
        });
      }
      throw error;
    }
    if (legacyConfig) {
      await removeRuntimeHostServiceFile(
        resolveRuntimeHostManagedServiceConfigPath(options.clientDataRoot),
        'legacy service config',
      );
      if (
        legacyConfig.managedDeploymentRoot &&
        resolve(legacyConfig.managedDeploymentRoot) !== resolve(deployment.root)
      ) {
        await removeRuntimeHostManagedDeployment(
          legacyConfig.managedDeploymentRoot,
          legacyServiceId,
        );
      }
    }
    await deployment.cleanup();
    const websocket = desired.listeners.websocket;
    if (!websocket) {
      throw new RuntimeHostSetupError(
        'service_not_ready',
        'Supervised Runtime Host setup requires a WebSocket listener',
      );
    }
    const directPeer = desired.listeners.directPeer?.enabled
      ? desired.listeners.directPeer
      : undefined;
    return {
      serviceId: capability.rootId,
      operatorPath: deployment.operatorPath,
      rootPath: capability.canonicalPath,
      endpoint: websocketUrl(websocket),
      ...(directPeer
        ? {
            directPeer: {
              peerId: directPeer.peerId,
              routeHints: expandWildcardListenAddresses(directPeer.listenAddresses),
              coordinationRelays: [...directPeer.coordinationRelays],
            },
          }
        : {}),
    };
  });
}

async function prepareSupervisedDeploymentConfig(
  options: RuntimeHostSetupCliOptions,
  deps: RuntimeHostSetupDeps,
  capability: Awaited<ReturnType<typeof resolveStorageRoot>>,
  cliPath: string,
  deploymentRoot: string,
  candidate: { readonly version: string; readonly integrity: string },
  current: RuntimeHostManagedDeploymentConfig | undefined,
  legacy: RuntimeHostManagedServiceConfig | null,
  provider: RuntimeHostLifecycleProvider,
): Promise<RuntimeHostManagedDeploymentConfig> {
  const projectDirectoryRoots = await resolveRuntimeHostManagedProjectDirectoryRoots(
    options.projectDirectoryRoots ??
      current?.projectDirectoryRoots ??
      (legacy
        ? effectiveRuntimeHostProjectDirectoryRoots(legacy)
        : [{ label: '~', path: resolve(homedir()) }]),
  );
  const currentWebSocket = current?.listeners.websocket;
  const websocketPort =
    options.websocketPort ??
    (currentWebSocket && currentWebSocket.port > 0
      ? currentWebSocket.port
      : legacy?.websocket.port) ??
    (await deps.allocateLoopbackPort());
  const directPeer = await prepareSupervisedDirectPeer(
    options,
    deps,
    cliPath,
    current?.listeners.directPeer,
    legacy,
  );
  const draft: RuntimeHostManagedDeploymentConfig = {
    schemaVersion: 1,
    deploymentId: current?.deploymentId ?? randomUUID(),
    configRevision: current ? current.configRevision + 1 : 1,
    deploymentRoot,
    root: { path: capability.canonicalPath, id: capability.rootId },
    projectDirectoryRoots: [...projectDirectoryRoots],
    launch: {
      kind: 'exact_package',
      nodePath: current?.launch.nodePath ?? process.execPath,
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
        port: websocketPort,
        path:
          options.websocketPath ??
          currentWebSocket?.path ??
          legacy?.websocket.path ??
          '/runtime-host',
      },
      ...(directPeer ? { directPeer } : {}),
    },
    lifecycle: {
      mode: 'supervised',
      provider: provider.supervisor.provider,
      availability: provider.supervisor.provider === 'systemd_user' ? 'machine' : 'session',
    },
    reconciliation: {
      trigger: 'scheduled',
      provider: provider.reconciliationTrigger.provider,
    },
  };
  return current && sameDesiredManagedDeployment(current, draft)
    ? { ...draft, configRevision: current.configRevision }
    : draft;
}

async function prepareSupervisedDirectPeer(
  options: RuntimeHostSetupCliOptions,
  deps: RuntimeHostSetupDeps,
  cliPath: string,
  current: RuntimeHostManagedDeploymentConfig['listeners']['directPeer'],
  legacy: RuntimeHostManagedServiceConfig | null,
): Promise<RuntimeHostManagedDeploymentConfig['listeners']['directPeer']> {
  const legacyPeer = legacy?.peer?.enabled ? legacy.peer : undefined;
  if (!options.directPeer && !current && !legacyPeer) return undefined;
  const keyPath = current?.keyPath ?? resolveRuntimeHostManagedPeerKeyPath(options.clientDataRoot);
  const peerId = await deps.ensurePeerIdentity({
    nativePath: await deps.resolvePeerNativePath(cliPath),
    keyPath,
  });
  const expectedPeerId = current?.peerId ?? legacyPeer?.peerId;
  if (expectedPeerId && expectedPeerId !== peerId) {
    throw new RuntimeHostSetupError(
      'invalid_config',
      'The Runtime Host peer identity does not match its persisted deployment',
    );
  }
  return {
    enabled: options.directPeer ? true : (current?.enabled ?? true),
    keyPath,
    peerId,
    listenAddresses: [
      ...(current?.listenAddresses ??
        legacyPeer?.listenAddresses ?? [
          `/ip4/0.0.0.0/udp/${String(await deps.allocatePeerPort())}/quic-v1`,
        ]),
    ],
    coordinationRelays: [
      ...(options.directPeer?.coordinationRelays ??
        current?.coordinationRelays ??
        legacyPeer?.coordinationRelays ??
        []),
    ],
  };
}

function sameDesiredManagedDeployment(
  current: RuntimeHostManagedDeploymentConfig,
  desired: RuntimeHostManagedDeploymentConfig,
): boolean {
  const { configRevision: _currentRevision, ...currentState } = current;
  const { configRevision: _desiredRevision, ...desiredState } = desired;
  return isDeepStrictEqual(currentState, desiredState);
}

async function rollbackActivatedManagedSetup(
  previous: RuntimeHostManagedDeploymentConfig | undefined,
  desired: RuntimeHostManagedDeploymentConfig,
  legacy: RuntimeHostManagedServiceConfig | null,
  legacyBackend: RuntimeHostServiceBackend,
  lifecycleDeps: RuntimeHostLifecycleTransactionDeps,
  deps: RuntimeHostSetupDeps,
): Promise<void> {
  const provider =
    desired.lifecycle.mode === 'supervised'
      ? lifecycleDeps.resolveProvider(desired.lifecycle.provider)
      : undefined;
  const retirement = await deps.retireLifecycleOwner({
    rootPath: desired.root.path,
    rootId: desired.root.id,
    ...(provider ? { supervisor: provider.supervisor } : {}),
    allowInterruptActiveTasks: true,
  });
  if (retirement.kind === 'active_tasks') {
    throw new Error('Runtime Host activation rollback could not retire active work');
  }
  let restored: RuntimeHostManagedDeploymentConfig | undefined;
  try {
    if (previous) {
      restored = { ...previous, configRevision: desired.configRevision + 1 };
      await deps.applyLifecycleTransition(
        retirement.owner,
        {
          operation:
            previous.lifecycle.mode === desired.lifecycle.mode &&
            previous.lifecycle.mode === 'supervised' &&
            desired.lifecycle.mode === 'supervised' &&
            previous.lifecycle.provider !== desired.lifecycle.provider
              ? 'provider_change'
              : 'lifecycle_change',
          current: desired,
          desired: restored,
        },
        lifecycleDeps,
      );
    } else {
      await deps.applyLifecycleTransition(
        retirement.owner,
        { operation: 'uninstall', current: desired },
        lifecycleDeps,
      );
      if (legacy) {
        const restoration = await legacyBackend.stageDeployment();
        await restoration.apply(legacy, false);
      }
    }
  } finally {
    await retirement.owner.close();
  }
  if (restored) {
    await deps.activateLifecycle(restored, lifecycleDeps);
    await deps.verifyLifecycleReady(restored, lifecycleDeps);
  } else if (legacy) {
    await legacyBackend.start();
  }
}

async function runRuntimeHostOnDemandSetupLocked(
  options: RuntimeHostSetupCliOptions,
  deps: RuntimeHostSetupDeps,
  emit: SetupEmitter,
): Promise<void> {
  if (options.directPeer) {
    throw new RuntimeHostSetupError(
      'unsupported_lifecycle_configuration',
      'On-demand setup does not support a Direct peer listener',
    );
  }
  emit({ kind: 'progress', phase: 'checking_environment' });
  const legacyServiceId = resolveRuntimeHostManagedServiceId(options.clientDataRoot);
  const legacyConfigPath = resolveRuntimeHostManagedServiceConfigPath(options.clientDataRoot);
  let legacyConfig: RuntimeHostManagedServiceConfig | null = null;
  try {
    legacyConfig = await readRuntimeHostManagedServiceConfig(legacyConfigPath);
  } catch (error) {
    if (!(error instanceof RuntimeHostServiceManagerError) || error.code !== 'not_installed') {
      throw error;
    }
  }
  const legacyBackend = legacyConfig
    ? deps.createBackend(legacyServiceId, options.clientDataRoot)
    : undefined;
  let legacyStatus: RuntimeHostManagedServiceResult | undefined;
  if (legacyBackend) {
    legacyStatus = await deps.manageService(
      {
        action: 'status',
        clientDataRoot: options.clientDataRoot,
        defaultRootPath: options.defaultRootPath,
        nodePath: process.execPath,
        cliPath: join(options.sourcePackageRoot, 'dist', 'cli.js'),
        ...(options.expectedTarget ? { expectedTarget: options.expectedTarget } : {}),
      },
      legacyBackend,
    );
  }
  const capability = await resolveStorageRoot({
    path: resolve(
      options.rootPath ??
        legacyConfig?.rootPath ??
        options.expectedTarget?.rootPath ??
        options.defaultRootPath,
    ),
    kind: 'interactive',
  });
  if (
    !legacyConfig &&
    options.expectedTarget &&
    (options.expectedTarget.serviceId !== capability.rootId ||
      options.expectedTarget.rootId !== capability.rootId ||
      options.expectedTarget.rootPath !== capability.canonicalPath)
  ) {
    throw new RuntimeHostSetupError(
      'target_mismatch',
      'The managed Runtime Host does not match the expected deployment identity',
    );
  }
  let authority = await readRuntimeHostManagedDeploymentAuthorityRecord(capability);
  if (authority?.schemaVersion === 2) {
    const previous = authority.from;
    const provider =
      previous?.lifecycle.mode === 'supervised'
        ? deps.createLifecycleProvider(capability.rootId)
        : undefined;
    const lifecycleDeps: RuntimeHostLifecycleTransactionDeps = {
      resolveProvider: (requested) => {
        if (!provider || requested !== provider.supervisor.provider) {
          throw new RuntimeHostSetupError(
            'unsupported_lifecycle_configuration',
            `The persisted Runtime Host provider ${requested} is unavailable on this computer`,
          );
        }
        return provider;
      },
    };
    const retirement = await deps.retireLifecycleOwner({
      rootPath: capability.canonicalPath,
      rootId: capability.rootId,
      ...(provider ? { supervisor: provider.supervisor } : {}),
    });
    if (retirement.kind === 'active_tasks') {
      throw new RuntimeHostSetupError(
        'active_tasks',
        'Runtime Host lifecycle recovery is waiting for active work to finish',
      );
    }
    let recovered: RuntimeHostManagedDeploymentConfig | undefined;
    try {
      recovered = await deps.recoverLifecycleTransition(retirement.owner, authority, lifecycleDeps);
    } finally {
      await retirement.owner.close();
    }
    if (recovered) {
      await deps.activateLifecycle(recovered, lifecycleDeps);
      await deps.verifyLifecycleReady(recovered, lifecycleDeps);
    }
    authority = await readRuntimeHostManagedDeploymentAuthorityRecord(capability);
  }
  const current = authority?.schemaVersion === 1 ? authority : undefined;
  const legacyToMigrate = current ? null : legacyConfig;
  if (current && legacyBackend) await assertLegacyArtifactsAbsent(legacyBackend);
  if (legacyToMigrate && legacyStatus) {
    await assertCompatibleExistingVersion(legacyStatus, options.version);
  }
  if (
    current &&
    options.expectedTarget &&
    (options.expectedTarget.serviceId !== capability.rootId ||
      options.expectedTarget.rootId !== capability.rootId ||
      options.expectedTarget.rootPath !== capability.canonicalPath)
  ) {
    throw new RuntimeHostSetupError(
      'target_mismatch',
      'The managed Runtime Host does not match the expected deployment identity',
    );
  }
  const candidate = await deps.resolveRegistryCandidate({
    kind: 'exact',
    version: options.version,
  });
  const serviceId = capability.rootId;
  const deploymentRoot =
    current?.deploymentRoot ?? resolveRuntimeHostManagedDeploymentRoot(serviceId);
  if (current && !sameExactPackage(current, candidate)) {
    throw new RuntimeHostSetupError(
      'version_change_requires_update',
      `Runtime Host ${current.launch.package.version} is already installed; changing its exact package requires the update workflow`,
    );
  }
  let config: RuntimeHostManagedDeploymentConfig = {
    schemaVersion: 1,
    deploymentId: current?.deploymentId ?? randomUUID(),
    configRevision: current ? current.configRevision + 1 : 1,
    deploymentRoot,
    root: { path: capability.canonicalPath, id: capability.rootId },
    projectDirectoryRoots: options.projectDirectoryRoots?.map(({ label, path }) => ({
      label,
      path: resolve(path),
    })) ??
      current?.projectDirectoryRoots ?? [{ label: '~', path: resolve(homedir()) }],
    launch: {
      kind: 'exact_package',
      nodePath: current?.launch.nodePath ?? process.execPath,
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
        path: options.websocketPath ?? current?.listeners.websocket?.path ?? '/runtime-host',
      },
      ...(current?.listeners.directPeer
        ? { directPeer: { ...current.listeners.directPeer, enabled: false } }
        : {}),
    },
    lifecycle: { mode: 'on_demand', availability: 'activation' },
    reconciliation: { trigger: 'activation' },
  };
  if (current && sameDesiredOnDemandDeployment(current, config)) config = current;
  let operatorPath: string | undefined;
  let migratedLegacy = false;
  await deps.withRegistryPackage(candidate, async (packageRoot) => {
    let committed = false;
    const created = !current;
    try {
      emit({ kind: 'progress', phase: 'installing_package' });
      const deployment = current
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
      if (legacyToMigrate && legacyBackend) {
        await legacyBackend.verifyDeployment(legacyToMigrate, {
          acceptLegacyConfigLaunch: true,
        });
        const retirement = await deps.retireLifecycleOwner({
          rootPath: capability.canonicalPath,
          rootId: capability.rootId,
          supervisor: legacyBackend,
        });
        if (retirement.kind === 'active_tasks') {
          throw new RuntimeHostSetupError(
            'active_tasks',
            'Runtime Host setup is waiting for active work to finish',
          );
        }
        try {
          await deps.applyLifecycleTransition(
            retirement.owner,
            { operation: 'legacy_migration', desired: config },
            {
              resolveProvider: () => {
                throw new Error('On-demand deployment has no supervisor provider');
              },
              ...legacyMigrationDeps(legacyToMigrate, legacyBackend),
            },
          );
        } finally {
          await retirement.owner.close();
        }
        migratedLegacy = true;
      } else if (!current) {
        const owner = await tryAcquireStateRootOwner(capability);
        if (!owner) {
          throw new RuntimeHostSetupError(
            'state_root_owned',
            'The State Root must be idle before on-demand setup',
          );
        }
        try {
          await commitRuntimeHostManagedDeployment(owner, config);
        } finally {
          await owner.close();
        }
      } else if (!isDeepStrictEqual(current, config)) {
        const provider =
          current.lifecycle.mode === 'supervised'
            ? deps.createLifecycleProvider(serviceId)
            : undefined;
        const replacement = await deps.replaceLifecycle({
          operation:
            current.lifecycle.mode === config.lifecycle.mode ? 'configure' : 'lifecycle_change',
          current,
          desired: config,
          deps: {
            resolveProvider: (requested) => {
              if (!provider || requested !== provider.supervisor.provider) {
                throw new RuntimeHostSetupError(
                  'unsupported_lifecycle_configuration',
                  `The persisted Runtime Host provider ${requested} is unavailable on this computer`,
                );
              }
              return provider;
            },
          },
        });
        if (replacement.kind === 'active_tasks') {
          throw new RuntimeHostSetupError(
            'active_tasks',
            'Runtime Host setup is waiting for active work to finish',
          );
        }
      }
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
    }
  });
  if (!operatorPath)
    throw new RuntimeHostSetupError('deployment_failed', 'Setup did not install an operator');

  let activation: Awaited<ReturnType<typeof activateRuntimeHostManagedDeployment>>;
  try {
    activation = await deps.activateManaged({ rootId: capability.rootId });
  } catch (error) {
    if (migratedLegacy && legacyToMigrate && legacyBackend) {
      await rollbackActivatedManagedSetup(
        undefined,
        config,
        legacyToMigrate,
        legacyBackend,
        {
          resolveProvider: () => {
            throw new Error('On-demand deployment has no supervisor provider');
          },
          ...legacyMigrationDeps(legacyToMigrate, legacyBackend),
        },
        deps,
      ).catch((rollbackError) => {
        throw new RuntimeHostSetupError(
          'deployment_failed',
          'Runtime Host activation failed and the previous lifecycle owner could not be restored',
          { cause: new AggregateError([error, rollbackError]) },
        );
      });
      await removeRuntimeHostManagedDeployment(config.deploymentRoot, serviceId).catch(
        () => undefined,
      );
    }
    throw error;
  }
  if (legacyConfig) {
    await removeRuntimeHostServiceFile(legacyConfigPath, 'legacy service config');
    if (
      legacyConfig.managedDeploymentRoot &&
      resolve(legacyConfig.managedDeploymentRoot) !== resolve(config.deploymentRoot)
    ) {
      await removeRuntimeHostManagedDeployment(legacyConfig.managedDeploymentRoot, legacyServiceId);
    }
  }
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

function legacyMigrationDeps(
  config: RuntimeHostManagedServiceConfig,
  backend: RuntimeHostServiceBackend,
): Pick<RuntimeHostLifecycleTransactionDeps, 'uninstallLegacy' | 'restoreLegacy'> {
  return {
    uninstallLegacy: () => backend.uninstall(),
    restoreLegacy: async () => {
      const restoration = await backend.stageDeployment();
      await restoration.apply(config, false);
    },
  };
}

async function assertLegacyArtifactsAbsent(backend: RuntimeHostServiceBackend): Promise<void> {
  const status = await backend.status();
  if (status.installed || status.enabled || status.active) {
    throw new RuntimeHostSetupError(
      'lifecycle_owner_exists',
      'The canonical deployment is active but its legacy lifecycle artifact can still start',
    );
  }
}

function sameExactPackage(
  config: RuntimeHostManagedDeploymentConfig,
  candidate: { readonly version: string; readonly integrity: string },
): boolean {
  return (
    config.launch.package.version === candidate.version &&
    config.launch.package.integrity === candidate.integrity
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
    protocol: {
      min: RUNTIME_HOST_PROTOCOL_VERSION,
      max: RUNTIME_HOST_PROTOCOL_VERSION,
    },
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
    const frame = {
      schemaVersion: 1,
      sequence: sequence++,
      ...input,
    } as RuntimeHostSetupFrame;
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
