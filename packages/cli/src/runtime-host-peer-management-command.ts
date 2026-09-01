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
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { networkInterfaces } from 'node:os';
import {
  encodeRuntimeHostPeerManagementFrame,
  resolveRuntimeHostManagedDeployment,
  resolveRuntimeHostNpmDeploymentLayout,
  type RuntimeHostPeerManagementFrame,
  type RuntimeHostPeerStatus,
  type RuntimeHostWebRtcStunPolicy,
} from '@maka/runtime-host/operator';
import { ensureRuntimeHostPeerIdentity } from '@maka/runtime-host/client';
import { hasPeerMeshIdentityObligations } from '@maka/runtime-host/peer-mesh';
import {
  allocateRuntimeHostPeerPort,
  RuntimeHostServiceManagerError,
  withRuntimeHostManagedServiceDeploymentLock,
  withRuntimeHostManagedServiceLifecycleLock,
  type RuntimeHostManagedServiceTarget,
} from './runtime-host-service-manager.js';
import { resolveRuntimeHostLifecycleProvider } from './runtime-host-service-management-command.js';
import {
  canDiscardRuntimeHostLifecycleDesiredArtifacts,
  replaceRuntimeHostLifecycle,
  resolveRecoverableRuntimeHostManagedDeployment,
  activateRuntimeHostLifecycle,
  verifyRuntimeHostLifecycleReady,
  type RuntimeHostLifecycleTransactionDeps,
} from './runtime-host-lifecycle-transaction.js';
import { manageRuntimeHostManagedLifecycle } from './runtime-host-managed-lifecycle-manager.js';
import {
  resolveRuntimeHostManagedPeerKeyPath,
  resolveRuntimeHostPeerNativePath,
} from './runtime-host-peer-artifact.js';
import {
  assertRuntimeHostManagedOperatorConfig,
  assertRuntimeHostManagedOperatorDeployment,
  convergeRuntimeHostManagedOperator,
  pruneRuntimeHostManagedPeerKeys,
  resolveRuntimeHostManagedControlRoot,
  verifyRuntimeHostManagedOperator,
} from './runtime-host-managed-deployment.js';

export interface RuntimeHostPeerManagementCliOptions {
  readonly action: 'enable' | 'disable' | 'status' | 'rotate' | 'descriptor';
  readonly json: boolean;
  readonly framed?: boolean;
  readonly clientDataRoot: string;
  readonly defaultRootPath: string;
  readonly nodePath: string;
  readonly cliPath: string;
  readonly managedRootId: string;
  readonly operatorDeploymentId: string;
  readonly listenAddresses: readonly string[];
  readonly coordinationRelays?: readonly string[];
  readonly automaticRelayDiscovery?: boolean;
  readonly relayDiscoveryStatus?: boolean;
  readonly webRtcStunPolicy?: RuntimeHostWebRtcStunPolicy;
  readonly webRtcStunStatus?: boolean;
  readonly expectedTarget?: RuntimeHostManagedServiceTarget;
  readonly allowInterruptActiveTasks?: boolean;
}

interface RuntimeHostPeerManagementCliDeps {
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
}

export async function runRuntimeHostPeerManagementCli(
  options: RuntimeHostPeerManagementCliOptions,
  overrides: Partial<RuntimeHostPeerManagementCliDeps> = {},
): Promise<number> {
  const deps: RuntimeHostPeerManagementCliDeps = {
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
    ...overrides,
  };
  try {
    const controlRoot = resolveRuntimeHostManagedControlRoot(options.managedRootId);
    return await withRuntimeHostManagedServiceDeploymentLock(controlRoot, () =>
      withRuntimeHostManagedServiceLifecycleLock(controlRoot, () =>
        assertRuntimeHostManagedOperatorDeployment(
          options.managedRootId,
          options.operatorDeploymentId,
          options.cliPath,
        ).then(() => runCanonicalRuntimeHostPeerManagementLocked(options, deps)),
      ),
    );
  } catch (error) {
    writePeerError(options, error, deps);
    return 1;
  }
}

async function runCanonicalRuntimeHostPeerManagementLocked(
  options: RuntimeHostPeerManagementCliOptions,
  deps: RuntimeHostPeerManagementCliDeps,
): Promise<number> {
  const rootId = options.managedRootId;
  const lifecycleDeps: RuntimeHostLifecycleTransactionDeps = {
    convergeOperator: (currentConfig, desiredConfig) =>
      convergeRuntimeHostManagedOperator(currentConfig, desiredConfig),
    verifyOperator: verifyRuntimeHostManagedOperator,
    resolveProvider: (requested) => resolveRuntimeHostLifecycleProvider(rootId, requested),
  };
  const resolved = await resolveRecoverableRuntimeHostManagedDeployment(rootId, lifecycleDeps, {
    ...(options.expectedTarget ? { expectedTarget: options.expectedTarget } : {}),
  });
  if (resolved.kind === 'absent') {
    throw new RuntimeHostServiceManagerError(
      'not_installed',
      'The managed Runtime Host deployment is not installed',
    );
  }
  const config = resolved.config;
  assertRuntimeHostManagedOperatorConfig(config, options.operatorDeploymentId, options.cliPath);
  if (config.lifecycle.mode !== 'supervised') {
    throw new RuntimeHostServiceManagerError(
      'target_mismatch',
      'Direct peer management requires a supervised Runtime Host deployment',
    );
  }
  await pruneRuntimeHostManagedPeerKeys(config);
  let desired = config;
  let stagedKeyPath: string | undefined;
  let previousPeerId: string | undefined;
  let validateRetiredState: (() => Promise<void>) | undefined;
  let restarted: boolean | undefined;
  if (options.action === 'enable') {
    const peer = await prepareCanonicalPeer(options, config, config.listeners.directPeer);
    if (!isDeepStrictEqual(peer, config.listeners.directPeer)) {
      desired = {
        ...config,
        configRevision: config.configRevision + 1,
        listeners: { ...config.listeners, directPeer: peer },
      };
    }
  } else if (options.action === 'disable' && config.listeners.directPeer?.enabled) {
    desired = {
      ...config,
      configRevision: config.configRevision + 1,
      listeners: {
        ...config.listeners,
        directPeer: { ...config.listeners.directPeer, enabled: false },
      },
    };
  } else if (options.action === 'rotate') {
    const current = config.listeners.directPeer;
    if (!current?.enabled) {
      throw new RuntimeHostServiceManagerError(
        'not_installed',
        'Direct peer is not enabled for the managed Runtime Host deployment',
      );
    }
    validateRetiredState = async () => {
      if (
        !(await hasPeerMeshIdentityObligations(
          join(config.deploymentRoot, 'peer-mesh', current.peerId),
          current.peerId,
        ))
      ) {
        return;
      }
      throw new RuntimeHostServiceManagerError(
        'invalid_config',
        'Close or finish leaving every Peer Mesh before rotating the Direct peer identity',
      );
    };
    await validateRetiredState();
    previousPeerId = current.peerId;
    stagedKeyPath = join(dirname(current.keyPath), `runtime-host-peer.${randomUUID()}.key`);
    const layout = resolveRuntimeHostNpmDeploymentLayout(
      config.deploymentRoot,
      config.launch.package.integrity,
    );
    const peerId = await ensureRuntimeHostPeerIdentity({
      nativePath: await resolveRuntimeHostPeerNativePath(layout.cliPath),
      keyPath: stagedKeyPath,
    });
    desired = {
      ...config,
      configRevision: config.configRevision + 1,
      listeners: {
        ...config.listeners,
        directPeer: { ...current, keyPath: stagedKeyPath, peerId },
      },
    };
  }

  if (!isDeepStrictEqual(desired, config)) {
    const replacement = await replaceRuntimeHostLifecycle({
      operation: 'configure',
      current: config,
      desired,
      allowInterruptActiveTasks: options.allowInterruptActiveTasks ?? false,
      deps: lifecycleDeps,
      ...(validateRetiredState ? { validateRetiredState } : {}),
    }).catch(async (error: unknown) => {
      if (stagedKeyPath && canDiscardRuntimeHostLifecycleDesiredArtifacts(error)) {
        await rm(stagedKeyPath, { force: true }).catch(() => undefined);
      }
      throw error;
    });
    if (replacement.kind === 'active_tasks') {
      if (stagedKeyPath) await rm(stagedKeyPath, { force: true }).catch(() => undefined);
      return writePeerActiveTasks(
        options,
        options.action === 'rotate'
          ? 'Runtime Host still owns active work; its peer identity was not rotated.'
          : 'Runtime Host still owns active work; direct-peer configuration was not changed.',
        deps,
      );
    }
    restarted = true;
    await pruneRuntimeHostManagedPeerKeys(desired);
  } else if (options.action === 'enable' || options.action === 'disable') {
    await activateRuntimeHostLifecycle(config, lifecycleDeps);
    await verifyRuntimeHostLifecycleReady(config, lifecycleDeps);
    restarted = false;
  }

  const status = await readCanonicalPeerStatus(options, desired);
  if (options.action === 'descriptor' && status.state !== 'enabled') {
    throw new RuntimeHostServiceManagerError(
      'not_installed',
      'Direct peer is not enabled for the managed Runtime Host deployment',
    );
  }
  if (options.action === 'rotate') {
    if (options.framed) throw new TypeError('Direct-peer rotation does not support framed output');
    if (options.json) {
      deps.writeStdout(
        `${JSON.stringify({ schemaVersion: 1, ok: true, action: options.action, previousPeerId, peerId: status.peerId })}\n`,
      );
    } else {
      deps.writeStdout(`Direct peer identity changed: ${previousPeerId} -> ${status.peerId}.\n`);
    }
    return 0;
  }
  if (options.framed) {
    if (options.action === 'descriptor') {
      throw new TypeError('Direct-peer descriptor does not support framed output');
    }
    const framedStatus = omitUnrequestedPeerStatus(status, options);
    writePeerFrame(
      options.action === 'status'
        ? { kind: 'result', action: options.action, status: framedStatus }
        : {
            kind: 'result',
            action: options.action,
            status: framedStatus,
            restarted: restarted!,
          },
      deps,
    );
  } else if (options.json) {
    deps.writeStdout(
      `${JSON.stringify({ schemaVersion: 1, ...status, ok: true, action: options.action })}\n`,
    );
  } else if (options.action === 'descriptor') {
    deps.writeStdout(`${JSON.stringify({ schemaVersion: 1, ...status })}\n`);
  } else {
    deps.writeStdout(formatPeerStatus(status));
  }
  return 0;
}

function omitUnrequestedPeerStatus(
  status: RuntimeHostPeerStatus,
  options: Pick<RuntimeHostPeerManagementCliOptions, 'relayDiscoveryStatus' | 'webRtcStunStatus'>,
): RuntimeHostPeerStatus {
  const { automaticRelayDiscovery, webRtcStunPolicy, ...legacy } = status;
  return {
    ...legacy,
    ...(options.relayDiscoveryStatus ? { automaticRelayDiscovery } : {}),
    ...(options.webRtcStunStatus ? { webRtcStunPolicy } : {}),
  };
}

async function prepareCanonicalPeer(
  options: RuntimeHostPeerManagementCliOptions,
  config: Awaited<ReturnType<typeof resolveRuntimeHostManagedDeployment>>['config'],
  current: Awaited<
    ReturnType<typeof resolveRuntimeHostManagedDeployment>
  >['config']['listeners']['directPeer'],
): Promise<NonNullable<typeof current>> {
  const layout = resolveRuntimeHostNpmDeploymentLayout(
    config.deploymentRoot,
    config.launch.package.integrity,
  );
  const keyPath = current?.keyPath ?? resolveRuntimeHostManagedPeerKeyPath(config.deploymentRoot);
  const peerId = await ensureRuntimeHostPeerIdentity({
    nativePath: await resolveRuntimeHostPeerNativePath(layout.cliPath),
    keyPath,
  });
  if (current && current.peerId !== peerId) {
    throw new RuntimeHostServiceManagerError(
      'invalid_config',
      'The managed Runtime Host peer identity does not match its deployment',
    );
  }
  return {
    enabled: true,
    keyPath,
    peerId,
    listenAddresses: [
      ...new Set(
        options.listenAddresses.length > 0
          ? options.listenAddresses
          : (current?.listenAddresses ?? [
              `/ip4/0.0.0.0/udp/${String(await allocateRuntimeHostPeerPort())}/quic-v1`,
            ]),
      ),
    ],
    coordinationRelays: [
      ...new Set(options.coordinationRelays ?? current?.coordinationRelays ?? []),
    ],
    automaticRelayDiscovery:
      options.automaticRelayDiscovery ?? current?.automaticRelayDiscovery ?? true,
    webRtcStunPolicy: canonicalWebRtcStunPolicy(
      options.webRtcStunPolicy ?? current?.webRtcStunPolicy ?? { kind: 'default' },
    ),
  };
}

function canonicalWebRtcStunPolicy(
  policy: RuntimeHostWebRtcStunPolicy,
): { kind: 'default' } | { kind: 'disabled' } | { kind: 'custom'; urls: string[] } {
  return policy.kind === 'custom'
    ? { kind: 'custom', urls: [...policy.urls] }
    : { kind: policy.kind };
}

async function readCanonicalPeerStatus(
  options: RuntimeHostPeerManagementCliOptions & {
    readonly managedRootId: string;
  },
  config: Awaited<ReturnType<typeof resolveRuntimeHostManagedDeployment>>['config'],
): Promise<RuntimeHostPeerStatus> {
  const result = await manageRuntimeHostManagedLifecycle(
    options.managedRootId,
    {
      action: 'status',
      clientDataRoot: options.clientDataRoot,
      defaultRootPath: options.defaultRootPath,
      nodePath: options.nodePath,
      cliPath: options.cliPath,
      ...(options.expectedTarget ? { expectedTarget: options.expectedTarget } : {}),
    },
    { resolveProvider: resolveRuntimeHostLifecycleProvider },
  );
  const peer = config.listeners.directPeer;
  if (!peer) {
    return {
      state: 'not_configured',
      serviceState: result.service.state,
      routeHints: [],
      coordinationRelays: [],
      automaticRelayDiscovery: true,
      webRtcStunPolicy: { kind: 'default' },
    };
  }
  return {
    state: peer.enabled ? 'enabled' : 'disabled',
    serviceState: result.service.state,
    peerId: peer.peerId,
    rootId: config.root.id,
    routeHints: expandWildcardListenAddresses(peer.listenAddresses),
    coordinationRelays: [...peer.coordinationRelays],
    automaticRelayDiscovery: peer.automaticRelayDiscovery,
    webRtcStunPolicy: peer.webRtcStunPolicy,
  };
}

function writePeerActiveTasks(
  options: RuntimeHostPeerManagementCliOptions,
  message: string,
  deps: RuntimeHostPeerManagementCliDeps,
): 1 {
  writePeerFailure(options, 'active_tasks', message, deps);
  return 1;
}

function writePeerError(
  options: RuntimeHostPeerManagementCliOptions,
  error: unknown,
  deps: RuntimeHostPeerManagementCliDeps,
): void {
  const code =
    error instanceof RuntimeHostServiceManagerError ? error.code : 'internal_service_error';
  const message = error instanceof Error ? error.message : String(error);
  writePeerFailure(options, code, message, deps);
}

function writePeerFailure(
  options: RuntimeHostPeerManagementCliOptions,
  code: string,
  message: string,
  deps: RuntimeHostPeerManagementCliDeps,
): void {
  if (options.framed) {
    if (options.action === 'rotate' || options.action === 'descriptor') {
      throw new TypeError('Direct-peer action does not support framed output');
    }
    writePeerFrame({ kind: 'error', action: options.action, error: { code, message } }, deps);
    return;
  }
  if (options.json) {
    deps.writeStdout(
      `${JSON.stringify({
        schemaVersion: 1,
        ok: false,
        action: options.action,
        error: { code, message },
      })}\n`,
    );
    return;
  }
  deps.writeStderr(`${message}\n`);
}

function writePeerFrame(
  frame: RuntimeHostPeerManagementFrame,
  deps: Pick<RuntimeHostPeerManagementCliDeps, 'writeStdout'>,
): void {
  deps.writeStdout(encodeRuntimeHostPeerManagementFrame(frame));
}

export function expandWildcardListenAddresses(addresses: readonly string[]): string[] {
  const interfaces = Object.values(networkInterfaces()).flatMap((entries) => entries ?? []);
  const ipv4 = interfaces
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
  const ipv6 = interfaces
    .filter((entry) => entry.family === 'IPv6' && !entry.internal && !entry.address.includes('%'))
    .map((entry) => entry.address);
  return [
    ...new Set(
      addresses.flatMap((address) => {
        const ipv4Wildcard = /^\/ip4\/0\.0\.0\.0(\/.*)$/u.exec(address);
        if (ipv4Wildcard) return ipv4.map((local) => `/ip4/${local}${ipv4Wildcard[1]}`);
        const ipv6Wildcard = /^\/ip6\/::(\/.*)$/u.exec(address);
        if (ipv6Wildcard) return ipv6.map((local) => `/ip6/${local}${ipv6Wildcard[1]}`);
        return [address];
      }),
    ),
  ];
}

function formatPeerStatus(status: RuntimeHostPeerStatus): string {
  if (status.state === 'not_configured') return 'Direct peer has not been configured.\n';
  if (status.state === 'disabled') {
    return status.peerId
      ? `Direct peer ${status.peerId} is disabled.\n`
      : 'Direct peer is disabled.\n';
  }
  return `Direct peer ${status.peerId} is enabled; Runtime Host service is ${status.serviceState}.\n`;
}
