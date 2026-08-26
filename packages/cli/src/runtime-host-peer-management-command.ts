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

import { access } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { ensureRuntimeHostPeerIdentity } from '@maka/runtime-host/client';
import { resolveExistingStorageRoot } from '@maka/storage/root-authority';
import {
  configureRuntimeHostManagedPeer,
  manageRuntimeHostService,
  resolveRuntimeHostManagedServiceId,
  rotateRuntimeHostManagedPeerIdentity,
  RuntimeHostServiceManagerError,
  withRuntimeHostManagedServiceDeploymentLock,
  withRuntimeHostManagedServiceLifecycleLock,
  type RuntimeHostManagedServiceTarget,
} from './runtime-host-service-manager.js';
import { createPlatformRuntimeHostServiceBackend } from './runtime-host-service-management-command.js';

export interface RuntimeHostPeerManagementCliOptions {
  readonly action: 'enable' | 'disable' | 'status' | 'rotate' | 'descriptor';
  readonly json: boolean;
  readonly clientDataRoot: string;
  readonly defaultRootPath: string;
  readonly nodePath: string;
  readonly cliPath: string;
  readonly listenAddresses: readonly string[];
  readonly coordinationRelays: readonly string[];
  readonly expectedTarget?: RuntimeHostManagedServiceTarget;
}

interface RuntimeHostPeerStatus {
  readonly schemaVersion: 1;
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly serviceState: string;
  readonly peerId?: string;
  readonly rootId?: string;
  readonly routeHints: readonly string[];
  readonly coordinationRelays: readonly string[];
}

export async function runRuntimeHostPeerManagementCli(
  options: RuntimeHostPeerManagementCliOptions,
): Promise<number> {
  try {
    const serviceId = resolveRuntimeHostManagedServiceId(options.clientDataRoot);
    const backend = createPlatformRuntimeHostServiceBackend(serviceId);
    if (options.action === 'enable' || options.action === 'disable') {
      const result = await withRuntimeHostManagedServiceDeploymentLock(options.clientDataRoot, () =>
        withRuntimeHostManagedServiceLifecycleLock(options.clientDataRoot, () =>
          configureRuntimeHostManagedPeer(
            {
              clientDataRoot: options.clientDataRoot,
              defaultRootPath: options.defaultRootPath,
              nodePath: options.nodePath,
              cliPath: options.cliPath,
              expectedTarget: options.expectedTarget!,
              peer:
                options.action === 'disable'
                  ? null
                  : {
                      ...(options.listenAddresses.length > 0
                        ? { listenAddresses: options.listenAddresses }
                        : {}),
                      coordinationRelays: options.coordinationRelays,
                    },
            },
            backend,
          ),
        ),
      );
      if (result.kind === 'active_tasks') {
        process.stderr.write(
          'Runtime Host still owns active work; direct-peer configuration was not changed.\n',
        );
        return 1;
      }
    } else if (options.action === 'rotate') {
      const result = await withRuntimeHostManagedServiceDeploymentLock(options.clientDataRoot, () =>
        withRuntimeHostManagedServiceLifecycleLock(options.clientDataRoot, () =>
          rotateRuntimeHostManagedPeerIdentity(
            {
              clientDataRoot: options.clientDataRoot,
              defaultRootPath: options.defaultRootPath,
              nodePath: options.nodePath,
              cliPath: options.cliPath,
              expectedTarget: options.expectedTarget!,
            },
            backend,
          ),
        ),
      );
      if (result.kind === 'active_tasks') {
        process.stderr.write(
          'Runtime Host still owns active work; its peer identity was not rotated.\n',
        );
        return 1;
      }
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({
            schemaVersion: 1,
            previousPeerId: result.previousPeerId,
            peerId: result.peerId,
          })}\n`,
        );
      } else {
        process.stdout.write(
          `Direct peer identity changed: ${result.previousPeerId} -> ${result.peerId}.\n`,
        );
      }
      return 0;
    }

    const status = await readPeerStatus(options, backend);
    if (options.action === 'descriptor' && !status.enabled) {
      throw new RuntimeHostServiceManagerError(
        'not_installed',
        'Direct peer is not enabled for the managed Runtime Host service',
      );
    }
    if (options.json || options.action === 'descriptor') {
      process.stdout.write(`${JSON.stringify(status)}\n`);
    } else {
      process.stdout.write(formatPeerStatus(status));
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function readPeerStatus(
  options: RuntimeHostPeerManagementCliOptions,
  backend: ReturnType<typeof createPlatformRuntimeHostServiceBackend>,
): Promise<RuntimeHostPeerStatus> {
  const result = await manageRuntimeHostService(
    {
      action: 'status',
      clientDataRoot: options.clientDataRoot,
      defaultRootPath: options.defaultRootPath,
      nodePath: options.nodePath,
      cliPath: options.cliPath,
      ...(options.expectedTarget ? { expectedTarget: options.expectedTarget } : {}),
    },
    backend,
  );
  const peer = result.service.config?.peer;
  if (!peer) {
    return {
      schemaVersion: 1,
      configured: false,
      enabled: false,
      serviceState: result.service.state,
      routeHints: [],
      coordinationRelays: [],
    };
  }
  let peerId: string | undefined;
  try {
    await access(peer.keyPath);
    peerId = await ensureRuntimeHostPeerIdentity({
      nativePath: peer.nativePath,
      keyPath: peer.keyPath,
    });
  } catch (error) {
    if (peer.enabled) throw error;
  }
  const root = options.expectedTarget
    ? await resolveExistingStorageRoot({
        path: result.service.config!.rootPath,
        kind: 'interactive',
        expectedRootId: options.expectedTarget.rootId,
      })
    : undefined;
  return {
    schemaVersion: 1,
    configured: true,
    enabled: peer.enabled,
    serviceState: result.service.state,
    ...(peerId ? { peerId } : {}),
    ...(root ? { rootId: root.rootId } : {}),
    routeHints: expandWildcardListenAddresses(peer.listenAddresses),
    coordinationRelays: peer.coordinationRelays,
  };
}

function expandWildcardListenAddresses(addresses: readonly string[]): string[] {
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
  if (!status.configured) return 'Direct peer has not been configured.\n';
  if (!status.enabled) {
    return status.peerId
      ? `Direct peer ${status.peerId} is disabled.\n`
      : 'Direct peer is disabled.\n';
  }
  return `Direct peer ${status.peerId} is enabled; Runtime Host service is ${status.serviceState}.\n`;
}
