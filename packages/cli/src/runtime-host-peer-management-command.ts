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

import { networkInterfaces } from 'node:os';
import {
  encodeRuntimeHostPeerManagementFrame,
  type RuntimeHostPeerManagementFrame,
  type RuntimeHostPeerStatus,
} from '@maka/runtime-host/operator';
import {
  configureRuntimeHostManagedPeer,
  manageRuntimeHostService,
  assertRuntimeHostManagedPeerMutationComplete,
  resolveRuntimeHostManagedServiceId,
  rotateRuntimeHostManagedPeerIdentity,
  RuntimeHostServiceManagerError,
  withRuntimeHostManagedServiceDeploymentLock,
  withRuntimeHostManagedServiceLifecycleLock,
  type RuntimeHostServiceManagerOverrides,
  type RuntimeHostManagedServiceTarget,
} from './runtime-host-service-manager.js';
import { createPlatformRuntimeHostServiceBackend } from './runtime-host-service-management-command.js';

export interface RuntimeHostPeerManagementCliOptions {
  readonly action: 'enable' | 'disable' | 'status' | 'rotate' | 'descriptor';
  readonly json: boolean;
  readonly framed?: boolean;
  readonly clientDataRoot: string;
  readonly defaultRootPath: string;
  readonly nodePath: string;
  readonly cliPath: string;
  readonly listenAddresses: readonly string[];
  readonly coordinationRelays?: readonly string[];
  readonly expectedTarget?: RuntimeHostManagedServiceTarget;
  readonly allowInterruptActiveTasks?: boolean;
}

interface RuntimeHostPeerManagementCliDeps {
  readonly createBackend: typeof createPlatformRuntimeHostServiceBackend;
  readonly managerOverrides: RuntimeHostServiceManagerOverrides;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
}

export async function runRuntimeHostPeerManagementCli(
  options: RuntimeHostPeerManagementCliOptions,
  overrides: Partial<RuntimeHostPeerManagementCliDeps> = {},
): Promise<number> {
  const deps: RuntimeHostPeerManagementCliDeps = {
    createBackend: createPlatformRuntimeHostServiceBackend,
    managerOverrides: {},
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
    ...overrides,
  };
  try {
    const serviceId = resolveRuntimeHostManagedServiceId(options.clientDataRoot);
    const backend = deps.createBackend(serviceId, options.clientDataRoot);
    return await withRuntimeHostManagedServiceDeploymentLock(options.clientDataRoot, () =>
      withRuntimeHostManagedServiceLifecycleLock(options.clientDataRoot, () =>
        runRuntimeHostPeerManagementLocked(options, backend, deps),
      ),
    );
  } catch (error) {
    writePeerError(options, error, deps);
    return 1;
  }
}

async function runRuntimeHostPeerManagementLocked(
  options: RuntimeHostPeerManagementCliOptions,
  backend: ReturnType<typeof createPlatformRuntimeHostServiceBackend>,
  deps: RuntimeHostPeerManagementCliDeps,
): Promise<number> {
  let restarted: boolean | undefined;
  if (options.action === 'enable' || options.action === 'disable') {
    const result = await configureRuntimeHostManagedPeer(
      {
        clientDataRoot: options.clientDataRoot,
        defaultRootPath: options.defaultRootPath,
        nodePath: options.nodePath,
        cliPath: options.cliPath,
        expectedTarget: options.expectedTarget!,
        allowInterruptActiveTasks: options.allowInterruptActiveTasks ?? false,
        peer:
          options.action === 'disable'
            ? null
            : {
                ...(options.listenAddresses.length > 0
                  ? { listenAddresses: options.listenAddresses }
                  : {}),
                ...(options.coordinationRelays
                  ? { coordinationRelays: options.coordinationRelays }
                  : {}),
              },
      },
      backend,
      deps.managerOverrides,
    );
    if (result.kind === 'active_tasks') {
      return writePeerActiveTasks(
        options,
        'Runtime Host still owns active work; direct-peer configuration was not changed.',
        deps,
      );
    }
    restarted = result.restarted;
  } else if (options.action === 'rotate') {
    const result = await rotateRuntimeHostManagedPeerIdentity(
      {
        clientDataRoot: options.clientDataRoot,
        defaultRootPath: options.defaultRootPath,
        nodePath: options.nodePath,
        cliPath: options.cliPath,
        expectedTarget: options.expectedTarget!,
      },
      backend,
      deps.managerOverrides,
    );
    if (result.kind === 'active_tasks') {
      return writePeerActiveTasks(
        options,
        'Runtime Host still owns active work; its peer identity was not rotated.',
        deps,
      );
    }
    if (options.json) {
      deps.writeStdout(
        `${JSON.stringify({
          schemaVersion: 1,
          ok: true,
          action: options.action,
          previousPeerId: result.previousPeerId,
          peerId: result.peerId,
        })}\n`,
      );
    } else {
      deps.writeStdout(
        `Direct peer identity changed: ${result.previousPeerId} -> ${result.peerId}.\n`,
      );
    }
    return 0;
  }

  const status = await readPeerStatus(options, backend, deps.managerOverrides);
  if (options.action === 'descriptor' && status.state !== 'enabled') {
    throw new RuntimeHostServiceManagerError(
      'not_installed',
      'Direct peer is not enabled for the managed Runtime Host service',
    );
  }
  if (options.framed) {
    if (options.action === 'descriptor') {
      throw new TypeError('Direct-peer descriptor does not support framed output');
    }
    writePeerFrame(
      options.action === 'status'
        ? { kind: 'result', action: options.action, status }
        : { kind: 'result', action: options.action, status, restarted: restarted! },
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

async function readPeerStatus(
  options: RuntimeHostPeerManagementCliOptions,
  backend: ReturnType<typeof createPlatformRuntimeHostServiceBackend>,
  managerOverrides: RuntimeHostServiceManagerOverrides,
): Promise<RuntimeHostPeerStatus> {
  await assertRuntimeHostManagedPeerMutationComplete(options.clientDataRoot);
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
    managerOverrides,
  );
  const peer = result.service.config?.peer;
  if (!peer) {
    return {
      state: 'not_configured',
      serviceState: result.service.state,
      routeHints: [],
      coordinationRelays: [],
    };
  }
  return {
    state: peer.enabled ? 'enabled' : 'disabled',
    serviceState: result.service.state,
    peerId: peer.peerId,
    ...(options.expectedTarget ? { rootId: options.expectedTarget.rootId } : {}),
    routeHints: expandWildcardListenAddresses(peer.listenAddresses),
    coordinationRelays: [...peer.coordinationRelays],
  };
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
