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

import { connectExistingRuntimeHost, type RuntimeHostConnection } from '@maka/runtime-host/client';
import {
  encodeRuntimeHostPeerMeshManagementFrame,
  type RuntimeHostPeerMeshManagementAction,
  type RuntimeHostPeerMeshManagementFrame,
} from '@maka/runtime-host/operator';
import {
  decodePeerMeshInvitation,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type OperationInput,
  type OperationOutput,
} from '@maka/runtime-host/protocol';
import {
  RuntimeHostServiceManagerError,
  withRuntimeHostManagedServiceDeploymentLock,
  withRuntimeHostManagedServiceLifecycleLock,
  type RuntimeHostManagedServiceTarget,
} from './runtime-host-service-manager.js';
import { resolveRuntimeHostLifecycleProvider } from './runtime-host-service-management-command.js';
import { resolveRecoverableRuntimeHostManagedDeployment } from './runtime-host-lifecycle-transaction.js';
import {
  assertRuntimeHostManagedOperatorConfig,
  assertRuntimeHostManagedOperatorDeployment,
  convergeRuntimeHostManagedOperator,
  resolveRuntimeHostManagedControlRoot,
  verifyRuntimeHostManagedOperator,
} from './runtime-host-managed-deployment.js';

const INPUT_MAX_BYTES = 128 * 1024;
const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

export interface RuntimeHostPeerMeshManagementCliOptions {
  readonly action: RuntimeHostPeerMeshManagementAction;
  readonly json: boolean;
  readonly framed: boolean;
  readonly managedRootId: string;
  readonly operatorDeploymentId: string;
  readonly cliPath: string;
  readonly expectedTarget: RuntimeHostManagedServiceTarget;
  readonly meshId?: string | null;
  readonly peerId?: string;
}

interface RuntimeHostPeerMeshManagementCliDeps {
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
  readonly readInvitation: () => Promise<unknown>;
  readonly connect: (rootPath: string) => Promise<RuntimeHostConnection>;
}

export async function runRuntimeHostPeerMeshManagementCli(
  options: RuntimeHostPeerMeshManagementCliOptions,
  overrides: Partial<RuntimeHostPeerMeshManagementCliDeps> = {},
): Promise<number> {
  const deps: RuntimeHostPeerMeshManagementCliDeps = {
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
    readInvitation: readInvitationFromStdin,
    connect: connectLocalOwner,
    ...overrides,
  };
  try {
    const manualInvitation =
      options.action === 'join' && !options.framed
        ? await readJoinInvitation(options, deps)
        : undefined;
    const controlRoot = resolveRuntimeHostManagedControlRoot(options.managedRootId);
    const result = await withRuntimeHostManagedServiceDeploymentLock(controlRoot, () =>
      withRuntimeHostManagedServiceLifecycleLock(controlRoot, async () => {
        await assertRuntimeHostManagedOperatorDeployment(
          options.managedRootId,
          options.operatorDeploymentId,
          options.cliPath,
        );
        const resolved = await resolveRecoverableRuntimeHostManagedDeployment(
          options.managedRootId,
          {
            convergeOperator: convergeRuntimeHostManagedOperator,
            verifyOperator: verifyRuntimeHostManagedOperator,
            resolveProvider: (requested) =>
              resolveRuntimeHostLifecycleProvider(options.managedRootId, requested),
          },
          { expectedTarget: options.expectedTarget },
        );
        if (resolved.kind === 'absent') {
          throw new RuntimeHostServiceManagerError(
            'not_installed',
            'The managed Runtime Host deployment is not installed',
          );
        }
        assertRuntimeHostManagedOperatorConfig(
          resolved.config,
          options.operatorDeploymentId,
          options.cliPath,
        );
        if (options.action !== 'status' && !resolved.config.listeners.directPeer?.enabled) {
          throw new Error('Direct peer is not enabled for this Runtime Host');
        }
        const connection = await deps.connect(resolved.config.root.path);
        try {
          if (connection.rootId !== options.managedRootId) {
            throw new Error('Runtime Host service is bound to a different State Root');
          }
          const invitation =
            options.action === 'join'
              ? (manualInvitation ?? (await readJoinInvitation(options, deps)))
              : undefined;
          return await executePeerMeshAction(connection, options, invitation);
        } finally {
          await connection.close();
        }
      }),
    );
    writeResult(options, result, deps);
    return 0;
  } catch (error) {
    writeError(options, error, deps);
    return 1;
  }
}

async function executePeerMeshAction(
  connection: RuntimeHostConnection,
  options: RuntimeHostPeerMeshManagementCliOptions,
  invitation: ReturnType<typeof decodePeerMeshInvitation> | undefined,
): Promise<PeerMeshResultFrame> {
  const request = async <K extends PeerMeshOperation>(
    operation: K,
    input: OperationInput<K>,
  ): Promise<OperationOutput<K>> => connection.request(operation, input);
  switch (options.action) {
    case 'status':
      return { kind: 'result', action: 'status', result: await request('peer.mesh.query', {}) };
    case 'create':
      return { kind: 'result', action: 'create', result: await request('peer.mesh.create', {}) };
    case 'invite':
      return {
        kind: 'result',
        action: 'invite',
        result: await request('peer.mesh.invite', {
          meshId: requiredMeshId(options.meshId),
        }),
      };
    case 'join':
      return {
        kind: 'result',
        action: 'join',
        result: await request('peer.mesh.join', {
          invitation: requiredOption(invitation, 'Peer Mesh invitation'),
        }),
      };
    case 'remove':
      return {
        kind: 'result',
        action: 'remove',
        result: await request('peer.mesh.remove', {
          meshId: requiredMeshId(options.meshId),
          peerId: requiredOption(options.peerId, 'Peer ID'),
        }),
      };
    case 'leave':
      return {
        kind: 'result',
        action: 'leave',
        result: await request('peer.mesh.leave', {
          meshId: requiredMeshId(options.meshId),
        }),
      };
    case 'close':
      return {
        kind: 'result',
        action: 'close',
        result: await request('peer.mesh.close', {
          meshId: requiredMeshId(options.meshId),
        }),
      };
    case 'reconcile':
      return {
        kind: 'result',
        action: 'reconcile',
        result: await request('peer.mesh.reconcile', {}),
      };
    case 'transit':
      return {
        kind: 'result',
        action: 'transit',
        result: await request('peer.mesh.transit.set', {
          meshId: requiredOption(options.meshId, 'Mesh ID'),
        }),
      };
  }
}

function requiredOption<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} is required`);
  return value;
}

function requiredMeshId(value: string | null | undefined): string {
  if (typeof value !== 'string') throw new Error('Mesh ID is required');
  return value;
}

async function readJoinInvitation(
  options: RuntimeHostPeerMeshManagementCliOptions,
  deps: RuntimeHostPeerMeshManagementCliDeps,
): Promise<ReturnType<typeof decodePeerMeshInvitation>> {
  if (options.framed) {
    deps.writeStdout(encodeRuntimeHostPeerMeshManagementFrame({ kind: 'input', action: 'join' }));
  } else if (!options.json) {
    deps.writeStderr('Paste the Peer Mesh invitation and press Enter:\n');
  }
  return decodePeerMeshInvitation(await deps.readInvitation());
}

type PeerMeshOperation = Extract<
  Parameters<RuntimeHostConnection['request']>[0],
  `peer.mesh.${string}`
>;

async function connectLocalOwner(rootPath: string): Promise<RuntimeHostConnection> {
  const result = await connectExistingRuntimeHost({ rootPath, protocol: PROTOCOL });
  if (result.kind !== 'connected') {
    throw new Error(`Runtime Host service is not available (${result.kind})`);
  }
  return result.connection;
}

async function readInvitationFromStdin(): Promise<unknown> {
  const stdin = process.stdin;
  const canSetRawMode = stdin.isTTY && typeof stdin.setRawMode === 'function';
  const wasRaw = stdin.isRaw;
  if (canSetRawMode) stdin.setRawMode(true);
  try {
    let text = '';
    for await (const chunk of stdin) {
      text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (text.includes('\u0003')) throw new Error('Peer Mesh invitation input was cancelled');
      if (Buffer.byteLength(text, 'utf8') > INPUT_MAX_BYTES) {
        throw new Error('Peer Mesh invitation exceeds the input size limit');
      }
      const carriageReturn = text.indexOf('\r');
      const lineFeed = text.indexOf('\n');
      const newline = [carriageReturn, lineFeed]
        .filter((index) => index >= 0)
        .sort((left, right) => left - right)[0];
      if (newline !== undefined) {
        if (
          text
            .slice(newline + 1)
            .replace(/^\n/u, '')
            .trim().length > 0
        ) {
          throw new Error('Peer Mesh invitation input contains trailing data');
        }
        text = text.slice(0, newline);
        break;
      }
    }
    if (!text.trim()) throw new Error('Peer Mesh invitation input is empty');
    return JSON.parse(text.trim()) as unknown;
  } finally {
    if (canSetRawMode) stdin.setRawMode(wasRaw);
  }
}

function writeResult(
  options: RuntimeHostPeerMeshManagementCliOptions,
  result: PeerMeshResultFrame,
  deps: RuntimeHostPeerMeshManagementCliDeps,
): void {
  if (options.framed) {
    deps.writeStdout(encodeRuntimeHostPeerMeshManagementFrame(result));
    return;
  }
  const output = result.action === 'invite' ? result.result.invitation : result.result;
  deps.writeStdout(
    `${JSON.stringify(output, null, options.json || result.action === 'invite' ? undefined : 2)}\n`,
  );
}

type PeerMeshResultFrame = Extract<RuntimeHostPeerMeshManagementFrame, { readonly kind: 'result' }>;

function writeError(
  options: RuntimeHostPeerMeshManagementCliOptions,
  error: unknown,
  deps: RuntimeHostPeerMeshManagementCliDeps,
): void {
  const message = error instanceof Error ? error.message : String(error);
  if (options.framed) {
    deps.writeStdout(
      encodeRuntimeHostPeerMeshManagementFrame({
        kind: 'error',
        action: options.action,
        error: { code: 'peer_mesh_management_failed', message },
      }),
    );
    return;
  }
  if (options.json) {
    deps.writeStdout(`${JSON.stringify({ ok: false, error: { message } })}\n`);
  } else {
    deps.writeStderr(`${message}\n`);
  }
}
