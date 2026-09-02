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
import { generalizedErrorMessage } from '@maka/core/redaction';
import {
  activateRuntimeHostManagedDeployment,
  connectRemoteRuntimeHost,
  ensureRuntimeHostPeerIdentity,
  RuntimeHostOperationError,
} from '@maka/runtime-host/client';
import {
  RuntimeHostManagedDeploymentError as RuntimeHostDeploymentAuthorityError,
  encodeRuntimeHostSetupFrame,
  isSha512PackageIntegrity,
  resolveRuntimeHostManagedDeployment,
  RUNTIME_HOST_SETUP_ERROR_CODE_MAX_BYTES,
  RUNTIME_HOST_SETUP_ERROR_MESSAGE_MAX_BYTES,
  type RuntimeHostManagedDeploymentConfig,
  type RuntimeHostSetupFrame,
  type RuntimeHostSetupPhase,
  type RuntimeHostSupervisorProvider,
} from '@maka/runtime-host/operator';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_PROTOCOL_VERSION,
} from '@maka/runtime-host/protocol';
import {
  prepareRuntimeHostAccessCredential,
  replaceRuntimeHostAccessCredential,
  revokeRuntimeHostAccessCredential,
  RuntimeHostAccessUnavailableError,
  type RuntimeHostAccessPreset,
} from './runtime-host-access-command.js';
import {
  convergeRuntimeHostManagedOperator,
  verifyRuntimeHostManagedOperator,
  isRuntimeHostDevelopmentPackageVersion,
  openRuntimeHostManagedPackageDeployment,
  prepareRuntimeHostManagedPackageDeployment,
  pruneRuntimeHostManagedPackages,
  removeRuntimeHostManagedDeployment,
  resolveRuntimeHostManagedPackageCliPath,
  resolveRuntimeHostManagedControlRoot,
  resolveRuntimeHostManagedDeploymentRoot,
  restoreRuntimeHostLegacyManagedOperator,
  RuntimeHostManagedDeploymentError,
} from './runtime-host-managed-deployment.js';
import {
  RuntimeHostUpdatePackageError,
  withRuntimeHostRegistryUpdatePackage,
} from './runtime-host-update-package.js';
import {
  readRuntimeHostManagedUpdatePolicy,
  writeRuntimeHostManagedUpdatePolicy,
} from './runtime-host-update-policy-store.js';
import {
  resolveRuntimeHostRegistryUpdateCandidate,
  RuntimeHostUpdateDiscoveryError,
  type RuntimeHostUpdateCandidate,
} from './runtime-host-update-discovery.js';
import { repairStorageRootAfterRemount, resolveStorageRoot } from '@maka/storage/root-authority';
import {
  createPlatformRuntimeHostServiceBackend,
  discoverRuntimeHostLifecycleProvider,
  resolveRuntimeHostLifecycleProvider,
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
  canDiscardRuntimeHostLifecycleDesiredArtifacts,
  replaceRuntimeHostLifecycle,
  resolveRecoverableRuntimeHostManagedDeployment,
  RUNTIME_HOST_READY_TIMEOUT_MS,
  RuntimeHostLifecycleTransactionError,
  type RuntimeHostLifecycleTransactionDeps,
} from './runtime-host-lifecycle-transaction.js';
import type {
  RuntimeHostLifecycleProvider,
  RuntimeHostLifecycleProviderOffer,
} from './runtime-host-lifecycle-provider.js';
import {
  resolveRuntimeHostManagedPeerKeyPath,
  resolveRuntimeHostPeerNativePath,
} from './runtime-host-peer-artifact.js';
import { activateRuntimeHostManagedDeploymentWithReconciliation } from './runtime-host-activation-command.js';

const SETUP_LOCK_TIMEOUT_MS = 5 * 60_000;
const PAIRING_AVAILABILITY_POLL_MS = 100;

export interface RuntimeHostSetupCliOptions {
  readonly json: boolean;
  readonly clientDataRoot: string;
  readonly defaultRootPath: string;
  readonly sourcePackageRoot: string;
  readonly version: string;
  readonly sourcePackageIntegrity?: string;
  readonly principalId: string;
  readonly preset: RuntimeHostAccessPreset;
  readonly lifecycle?: 'supervised' | 'on_demand';
  readonly deferPairingCommit?: boolean;
  readonly bindPairingToClient?: boolean;
  readonly repairRootAfterRemount?: true;
  readonly updateExisting?: boolean;
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
  readonly discoverLifecycleProvider: (
    rootId: string,
  ) => Promise<RuntimeHostLifecycleProviderOffer>;
  readonly resolveLifecycleProvider: (
    rootId: string,
    provider: RuntimeHostSupervisorProvider,
  ) => RuntimeHostLifecycleProvider;
  readonly replaceLifecycle: typeof replaceRuntimeHostLifecycle;
  readonly openDeployment: typeof openRuntimeHostManagedPackageDeployment;
  readonly prepareDeployment: typeof prepareRuntimeHostManagedPackageDeployment;
  readonly prunePackages: typeof pruneRuntimeHostManagedPackages;
  readonly prepareCredential: typeof prepareRuntimeHostAccessCredential;
  readonly replaceCredential: typeof replaceRuntimeHostAccessCredential;
  readonly revokeCredential: typeof revokeRuntimeHostAccessCredential;
  readonly verifyCredential: typeof verifyRuntimeHostSetupCredential;
  readonly activateDesired: typeof activateRuntimeHostManagedDeployment;
  readonly activateManaged: typeof activateRuntimeHostManagedDeployment;
  readonly convergeOperator: typeof convergeRuntimeHostManagedOperator;
  readonly verifyOperator: typeof verifyRuntimeHostManagedOperator;
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

interface ResolvedRuntimeHostSetupPackage {
  readonly candidate: RuntimeHostUpdateCandidate;
  use<T>(operation: (packageRoot: string) => Promise<T>): Promise<T>;
}

async function resolveRuntimeHostSetupPackage(
  options: RuntimeHostSetupCliOptions,
  deps: Pick<RuntimeHostSetupDeps, 'resolveRegistryCandidate' | 'withRegistryPackage'>,
): Promise<ResolvedRuntimeHostSetupPackage> {
  if (isRuntimeHostDevelopmentPackageVersion(options.version)) {
    const integrity = options.sourcePackageIntegrity;
    if (typeof integrity !== 'string' || !isSha512PackageIntegrity(integrity)) {
      throw new RuntimeHostSetupError(
        'development_package_unverified',
        'The Runtime Host development package is missing exact artifact evidence',
      );
    }
    return {
      candidate: {
        kind: 'npm_registry',
        version: options.version,
        integrity,
      },
      use: (operation) => operation(options.sourcePackageRoot),
    };
  }
  const candidate = await deps.resolveRegistryCandidate({
    kind: 'exact',
    version: options.version,
  });
  return {
    candidate,
    use: (operation) => deps.withRegistryPackage(candidate, operation),
  };
}

export async function runRuntimeHostSetupCli(
  options: RuntimeHostSetupCliOptions,
  overrides: Partial<RuntimeHostSetupDeps> = {},
): Promise<number> {
  const deps: RuntimeHostSetupDeps = {
    manageService: manageRuntimeHostService,
    createBackend: createPlatformRuntimeHostServiceBackend,
    discoverLifecycleProvider: discoverRuntimeHostLifecycleProvider,
    resolveLifecycleProvider: resolveRuntimeHostLifecycleProvider,
    replaceLifecycle: replaceRuntimeHostLifecycle,
    openDeployment: openRuntimeHostManagedPackageDeployment,
    prepareDeployment: prepareRuntimeHostManagedPackageDeployment,
    prunePackages: pruneRuntimeHostManagedPackages,
    prepareCredential: prepareRuntimeHostAccessCredential,
    replaceCredential: replaceRuntimeHostAccessCredential,
    revokeCredential: revokeRuntimeHostAccessCredential,
    verifyCredential: verifyRuntimeHostSetupCredential,
    activateDesired: (input) =>
      activateRuntimeHostManagedDeployment(input, {
        reconcileActivation: async () => undefined,
      }),
    activateManaged: (input) =>
      activateRuntimeHostManagedDeploymentWithReconciliation(input, {
        deploymentLockHeld: true,
      }),
    convergeOperator: convergeRuntimeHostManagedOperator,
    verifyOperator: verifyRuntimeHostManagedOperator,
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
    const rootId = await resolveRuntimeHostSetupRootId(options);
    const controlRoot = resolveRuntimeHostManagedControlRoot(rootId);
    await withRuntimeHostManagedServiceDeploymentLock(
      options.clientDataRoot,
      () =>
        withRuntimeHostManagedServiceLifecycleLock(
          options.clientDataRoot,
          () =>
            withRuntimeHostManagedServiceDeploymentLock(
              controlRoot,
              () =>
                withRuntimeHostManagedServiceLifecycleLock(
                  controlRoot,
                  () => runRuntimeHostSetupLocked(options, deps, emit),
                  SETUP_LOCK_TIMEOUT_MS,
                ),
              SETUP_LOCK_TIMEOUT_MS,
            ),
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

async function resolveRuntimeHostSetupRootId(options: RuntimeHostSetupCliOptions): Promise<string> {
  let legacyRootPath: string | undefined;
  try {
    legacyRootPath = (
      await readRuntimeHostManagedServiceConfig(
        resolveRuntimeHostManagedServiceConfigPath(options.clientDataRoot),
      )
    ).rootPath;
  } catch (error) {
    if (!(error instanceof RuntimeHostServiceManagerError) || error.code !== 'not_installed') {
      throw error;
    }
  }
  const path = resolve(
    options.rootPath ??
      legacyRootPath ??
      options.expectedTarget?.rootPath ??
      options.defaultRootPath,
  );
  if (options.repairRootAfterRemount) {
    await repairStorageRootAfterRemount({ path, kind: 'interactive' });
  }
  return (await resolveStorageRoot({ path, kind: 'interactive' })).rootId;
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
  readonly deploymentId: string;
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
    ...(options.expectedTarget
      ? { expectedTarget: legacyManagedTarget(options.expectedTarget, legacyServiceId) }
      : {}),
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
  assertCanonicalSetupTarget(options.expectedTarget, capability.rootId, capability.canonicalPath);
  const lifecycleDeps: RuntimeHostLifecycleTransactionDeps = {
    convergeOperator: (currentConfig, desiredConfig) =>
      deps.convergeOperator(currentConfig, desiredConfig),
    verifyOperator: deps.verifyOperator,
    resolveProvider: (provider) => deps.resolveLifecycleProvider(capability.rootId, provider),
    ...(legacyConfig
      ? legacyMigrationDeps(legacyConfig, legacyBackend, legacyServiceId, options.clientDataRoot)
      : {}),
  };
  const recovered = await resolveRecoverableRuntimeHostManagedDeployment(
    capability.rootId,
    lifecycleDeps,
    {
      ...(legacyConfig ? { retirementSupervisor: legacyBackend } : {}),
      ...(legacyConfig
        ? {
            activatePrevious: () =>
              deps
                .manageService({ ...legacyCommon, action: 'start' }, legacyBackend)
                .then(() => undefined),
          }
        : {}),
      ...(options.expectedTarget ? { expectedTarget: options.expectedTarget } : {}),
    },
  );
  const current = recovered.kind === 'active' ? recovered.config : undefined;
  assertExpectedDeploymentGeneration(options.expectedTarget, current);
  const legacyToMigrate = current ? null : legacyConfig;
  if (current && legacyConfig) await assertLegacyArtifactsAbsent(legacyBackend);
  if (legacyToMigrate) await assertCompatibleExistingVersion(legacyStatus, options.version);
  if (current && current.launch.package.version !== options.version && !options.updateExisting) {
    throw new RuntimeHostSetupError(
      'version_change_requires_update',
      `Runtime Host ${current.launch.package.version} is already installed; changing to ${options.version} requires the update workflow`,
    );
  }

  const resolvedPackage = await resolveRuntimeHostSetupPackage(options, deps);
  const { candidate } = resolvedPackage;
  const packageChanged = current !== undefined && !sameExactPackage(current, candidate);
  if (current && packageChanged && !options.updateExisting) {
    throw new RuntimeHostSetupError(
      'version_change_requires_update',
      `Runtime Host ${current.launch.package.version} is already installed; changing its exact package requires the update workflow`,
    );
  }
  const lifecycleOffer: RuntimeHostLifecycleProviderOffer =
    current?.lifecycle.mode === 'supervised'
      ? {
          provider: deps.resolveLifecycleProvider(capability.rootId, current.lifecycle.provider),
          availability: current.lifecycle.availability,
        }
      : await deps.discoverLifecycleProvider(capability.rootId);
  return resolvedPackage.use(async (packageRoot) => {
    emit({ kind: 'progress', phase: 'installing_package' });
    const deployment = await deps.prepareDeployment({
      serviceId: capability.rootId,
      clientDataRoot: options.clientDataRoot,
      sourcePackageRoot: packageRoot,
      version: candidate.version,
      packageIntegrity: candidate.integrity,
      ...(current ? { deploymentRoot: current.deploymentRoot } : {}),
    });
    let committed = false;
    try {
      const desired = await prepareSupervisedDeploymentConfig(
        options,
        deps,
        capability,
        deployment.cliPath,
        deployment.root,
        candidate,
        current,
        legacyToMigrate,
        lifecycleOffer,
      );
      if (
        current &&
        !sameDesiredManagedDeployment(current, desired) &&
        !options.updateExisting &&
        current.lifecycle.mode === 'supervised'
      ) {
        throw new RuntimeHostSetupError(
          'configuration_changed',
          'Change an existing supervised Runtime Host through its explicit configure or update workflow',
        );
      }
      emit({ kind: 'progress', phase: 'installing_service' });
      if (legacyToMigrate) {
        await legacyBackend.verifyDeployment(legacyToMigrate, {
          acceptLegacyConfigLaunch: true,
        });
      }
      const replacement = await deps.replaceLifecycle({
        operation: legacyToMigrate
          ? 'legacy_migration'
          : current
            ? packageChanged
              ? 'update'
              : isDeepStrictEqual(current.lifecycle, desired.lifecycle)
                ? 'configure'
                : 'lifecycle_change'
            : 'install',
        ...(current ? { current } : {}),
        desired,
        ...(legacyToMigrate ? { retirementSupervisor: legacyBackend } : {}),
        ...(legacyToMigrate
          ? {
              activatePrevious: () =>
                deps
                  .manageService({ ...legacyCommon, action: 'start' }, legacyBackend)
                  .then(() => undefined),
            }
          : {}),
        allowInterruptActiveTasks: Boolean(current && packageChanged && options.updateExisting),
        deps: lifecycleDeps,
      });
      if (replacement.kind === 'active_tasks') {
        throw new RuntimeHostSetupError(
          'active_tasks',
          'Runtime Host setup is waiting for active work to finish',
        );
      }
      committed = true;
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
      await deps.prunePackages(desired);
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
        deploymentId: desired.deploymentId,
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
    } catch (error) {
      if (!committed && canDiscardRuntimeHostLifecycleDesiredArtifacts(error)) {
        if (current && packageChanged) {
          await deployment.rollback().catch(() => undefined);
        } else if (!current) {
          await removeRuntimeHostManagedDeployment(deployment.root, capability.rootId).catch(
            () => undefined,
          );
        }
      }
      throw error;
    }
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
  offer: RuntimeHostLifecycleProviderOffer,
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
    deploymentRoot,
    current?.listeners.directPeer,
  );
  const draft: RuntimeHostManagedDeploymentConfig = {
    schemaVersion: 1,
    state: 'active',
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
      provider: offer.provider.supervisor.provider,
      availability: offer.availability,
    },
    reconciliation: {
      trigger: 'scheduled',
      provider: offer.provider.reconciliationTrigger.provider,
    },
  };
  return draft;
}

async function prepareSupervisedDirectPeer(
  options: RuntimeHostSetupCliOptions,
  deps: RuntimeHostSetupDeps,
  cliPath: string,
  deploymentRoot: string,
  current: RuntimeHostManagedDeploymentConfig['listeners']['directPeer'],
): Promise<RuntimeHostManagedDeploymentConfig['listeners']['directPeer']> {
  if (!options.directPeer && !current) return undefined;
  const keyPath = current?.keyPath ?? resolveRuntimeHostManagedPeerKeyPath(deploymentRoot);
  const peerId = await deps.ensurePeerIdentity({
    nativePath: await deps.resolvePeerNativePath(cliPath),
    keyPath,
  });
  const expectedPeerId = current?.peerId;
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
      ...(current?.listenAddresses ?? [
        `/ip4/0.0.0.0/udp/${String(await deps.allocatePeerPort())}/quic-v1`,
      ]),
    ],
    coordinationRelays: [
      ...(options.directPeer?.coordinationRelays ?? current?.coordinationRelays ?? []),
    ],
    automaticRelayDiscovery: current?.automaticRelayDiscovery ?? true,
    webRtcStunPolicy: current?.webRtcStunPolicy ?? { kind: 'default' },
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
        ...(options.expectedTarget
          ? { expectedTarget: legacyManagedTarget(options.expectedTarget, legacyServiceId) }
          : {}),
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
  assertCanonicalSetupTarget(options.expectedTarget, capability.rootId, capability.canonicalPath);
  const recoveryDeps: RuntimeHostLifecycleTransactionDeps = {
    convergeOperator: (currentConfig, desiredConfig) =>
      deps.convergeOperator(currentConfig, desiredConfig),
    verifyOperator: deps.verifyOperator,
    resolveProvider: (requested) => deps.resolveLifecycleProvider(capability.rootId, requested),
    ...(legacyConfig && legacyBackend
      ? legacyMigrationDeps(legacyConfig, legacyBackend, legacyServiceId, options.clientDataRoot)
      : {}),
  };
  const recovered = await resolveRecoverableRuntimeHostManagedDeployment(
    capability.rootId,
    recoveryDeps,
    {
      ...(legacyBackend ? { retirementSupervisor: legacyBackend } : {}),
      ...(legacyBackend ? { activatePrevious: () => legacyBackend.start() } : {}),
      ...(options.expectedTarget ? { expectedTarget: options.expectedTarget } : {}),
    },
  );
  const current = recovered.kind === 'active' ? recovered.config : undefined;
  const legacyToMigrate = current ? null : legacyConfig;
  if (current && legacyBackend) await assertLegacyArtifactsAbsent(legacyBackend);
  if (legacyToMigrate && legacyStatus) {
    await assertCompatibleExistingVersion(legacyStatus, options.version);
  }
  assertExpectedDeploymentGeneration(options.expectedTarget, current);
  const resolvedPackage = await resolveRuntimeHostSetupPackage(options, deps);
  const { candidate } = resolvedPackage;
  const serviceId = capability.rootId;
  const deploymentRoot =
    current?.deploymentRoot ?? resolveRuntimeHostManagedDeploymentRoot(serviceId);
  const packageChanged = current !== undefined && !sameExactPackage(current, candidate);
  if (current && packageChanged && !options.updateExisting) {
    throw new RuntimeHostSetupError(
      'version_change_requires_update',
      `Runtime Host ${current.launch.package.version} is already installed; changing its exact package requires the update workflow`,
    );
  }
  const draft: RuntimeHostManagedDeploymentConfig = {
    schemaVersion: 1,
    state: 'active',
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
  const reuseCurrent =
    current?.lifecycle.mode === 'on_demand' && sameDesiredManagedDeployment(current, draft);
  const config = reuseCurrent ? current : draft;
  let operatorPath: string | undefined;
  let activation: Awaited<ReturnType<typeof activateRuntimeHostManagedDeployment>> | undefined;
  const lifecycleDeps: RuntimeHostLifecycleTransactionDeps = {
    convergeOperator: (currentConfig, desiredConfig) =>
      deps.convergeOperator(currentConfig, desiredConfig),
    verifyOperator: deps.verifyOperator,
    resolveProvider: (requested) => deps.resolveLifecycleProvider(serviceId, requested),
    ...(legacyToMigrate && legacyBackend
      ? legacyMigrationDeps(legacyToMigrate, legacyBackend, legacyServiceId, options.clientDataRoot)
      : {}),
  };
  await resolvedPackage.use(async (packageRoot) => {
    let committed = false;
    const created = !current;
    let deployment: Awaited<ReturnType<typeof deps.prepareDeployment>> | undefined;
    try {
      emit({ kind: 'progress', phase: 'installing_package' });
      deployment =
        current && !packageChanged
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
              ...(current ? { deploymentRoot } : {}),
            });
      const desiredConfig: RuntimeHostManagedDeploymentConfig = current
        ? config
        : { ...config, deploymentRoot: deployment.root };
      operatorPath = deployment.operatorPath;
      emit({ kind: 'progress', phase: 'installing_service' });
      if (legacyToMigrate && legacyBackend) {
        await legacyBackend.verifyDeployment(legacyToMigrate, {
          acceptLegacyConfigLaunch: true,
        });
      }
      if (reuseCurrent) {
        await deps.convergeOperator(current, current);
        await deps.verifyOperator(current);
      } else {
        const replacement = await deps.replaceLifecycle({
          operation: legacyToMigrate
            ? 'legacy_migration'
            : packageChanged
              ? 'update'
              : current
                ? isDeepStrictEqual(current.lifecycle, config.lifecycle)
                  ? 'configure'
                  : 'lifecycle_change'
                : 'install',
          ...(current ? { current } : {}),
          desired: desiredConfig,
          ...(legacyToMigrate && legacyBackend ? { retirementSupervisor: legacyBackend } : {}),
          ...(legacyToMigrate && legacyBackend
            ? { activatePrevious: () => legacyBackend.start() }
            : {}),
          activateDesired: async () => {
            await deps.activateDesired({ rootId: capability.rootId });
          },
          allowInterruptActiveTasks: Boolean(current && packageChanged && options.updateExisting),
          deps: lifecycleDeps,
        });
        if (replacement.kind === 'active_tasks') {
          throw new RuntimeHostSetupError(
            'active_tasks',
            'Runtime Host setup is waiting for active work to finish',
          );
        }
      }
      committed = true;
      await deps.prunePackages(
        (await resolveRuntimeHostManagedDeployment(capability.rootId)).config,
      );
    } catch (error) {
      if (!committed && canDiscardRuntimeHostLifecycleDesiredArtifacts(error)) {
        if (packageChanged && deployment) await deployment.rollback().catch(() => undefined);
        else if (created) {
          await removeRuntimeHostManagedDeployment(deploymentRoot, serviceId).catch(
            () => undefined,
          );
        }
      }
      throw error;
    }
  });
  if (!operatorPath)
    throw new RuntimeHostSetupError('deployment_failed', 'Setup did not install an operator');

  activation = await deps.activateManaged({ rootId: capability.rootId });
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
      deploymentId: config.deploymentId,
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
  legacyServiceId: string,
  clientDataRoot: string,
): Pick<RuntimeHostLifecycleTransactionDeps, 'uninstallLegacy' | 'restoreLegacy'> {
  return {
    uninstallLegacy: async (transition) => {
      await projectLegacyUpdatePolicy(config, legacyServiceId, transition.to ?? transition.from);
      await backend.uninstall();
    },
    restoreLegacy: async (transition) => {
      await removeProjectedLegacyUpdatePolicy(config, transition.to ?? transition.from);
      if (config.managedDeploymentRoot) {
        await restoreRuntimeHostLegacyManagedOperator({
          deploymentRoot: config.managedDeploymentRoot,
          nodePath: config.launch.nodePath,
          cliPath: config.launch.cliPath,
          clientDataRoot,
          serviceId: legacyServiceId,
        });
      }
      const restoration = await backend.stageDeployment();
      await restoration.apply(config, false);
    },
  };
}

async function projectLegacyUpdatePolicy(
  config: RuntimeHostManagedServiceConfig,
  legacyServiceId: string,
  desired: RuntimeHostManagedDeploymentConfig | null,
): Promise<void> {
  if (!config.managedDeploymentRoot || !desired) return;
  const record = await readRuntimeHostManagedUpdatePolicy(config.managedDeploymentRoot);
  if (record) {
    if (
      record.target.serviceId !== legacyServiceId ||
      record.target.rootId !== desired.root.id ||
      resolve(record.target.rootPath) !== resolve(desired.root.path)
    ) {
      throw new RuntimeHostSetupError(
        'target_mismatch',
        'The legacy automatic update policy does not match the Runtime Host migration target',
      );
    }
    await writeRuntimeHostManagedUpdatePolicy(desired.deploymentRoot, {
      ...record,
      target: {
        serviceId: desired.root.id,
        rootId: desired.root.id,
        rootPath: desired.root.path,
        deploymentId: desired.deploymentId,
      },
    });
  } else {
    await writeRuntimeHostManagedUpdatePolicy(desired.deploymentRoot, null);
  }
}

async function removeProjectedLegacyUpdatePolicy(
  config: RuntimeHostManagedServiceConfig,
  desired: RuntimeHostManagedDeploymentConfig | null,
): Promise<void> {
  if (
    config.managedDeploymentRoot &&
    desired &&
    resolve(config.managedDeploymentRoot) !== resolve(desired.deploymentRoot)
  ) {
    await writeRuntimeHostManagedUpdatePolicy(desired.deploymentRoot, null);
  }
}

function legacyManagedTarget(
  target: RuntimeHostManagedServiceTarget,
  legacyServiceId: string,
): RuntimeHostManagedServiceTarget {
  return {
    serviceId: legacyServiceId,
    rootPath: target.rootPath,
    rootId: target.rootId,
  };
}

function assertCanonicalSetupTarget(
  target: RuntimeHostManagedServiceTarget | undefined,
  rootId: string,
  rootPath: string,
): void {
  if (
    target &&
    (target.serviceId !== rootId || target.rootId !== rootId || target.rootPath !== rootPath)
  ) {
    throw new RuntimeHostSetupError(
      'target_mismatch',
      'The managed Runtime Host does not match the expected deployment identity',
    );
  }
}

function assertExpectedDeploymentGeneration(
  target: RuntimeHostManagedServiceTarget | undefined,
  current: RuntimeHostManagedDeploymentConfig | undefined,
): void {
  if (
    target?.deploymentId !== undefined &&
    (!current || target.deploymentId !== current.deploymentId)
  ) {
    throw new RuntimeHostSetupError(
      'target_mismatch',
      'The managed Runtime Host deployment generation changed before setup',
    );
  }
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
    readonly deploymentId: string;
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
    const credentialInput = {
      rootPath: target.rootPath,
      principalKind: 'remote_owner' as const,
      principalId: options.principalId,
      operationGrants: [],
      canPublishClientCapabilities: false,
      canUseHostPaths: false,
      preset: options.preset,
      ...(options.bindPairingToClient ? { bindClientInstance: true } : {}),
    };
    const deadline = Date.now() + RUNTIME_HOST_READY_TIMEOUT_MS;
    while (true) {
      try {
        paired = await pairCredential(credentialInput);
        break;
      } catch (error) {
        if (!isTransientPairingAvailabilityError(error) || Date.now() >= deadline) {
          throw error;
        }
        await new Promise<void>((resolveWait) =>
          setTimeout(resolveWait, Math.min(PAIRING_AVAILABILITY_POLL_MS, deadline - Date.now())),
        );
      }
    }
  } catch (error) {
    const reason =
      error instanceof RuntimeHostAccessUnavailableError
        ? error.message
        : generalizedErrorMessage(error, 'Runtime Host access service is unavailable');
    throw new RuntimeHostSetupError(
      'pairing_failed',
      `Runtime Host could not pair the requested Client identity: ${reason}`,
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
      deploymentId: target.deploymentId,
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

function isTransientPairingAvailabilityError(error: unknown): boolean {
  return (
    error instanceof RuntimeHostAccessUnavailableError ||
    (error instanceof RuntimeHostOperationError &&
      (error.code === 'host_not_ready' || error.code === 'host_draining'))
  );
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
    error instanceof RuntimeHostUpdatePackageError ||
    error instanceof RuntimeHostLifecycleTransactionError
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
