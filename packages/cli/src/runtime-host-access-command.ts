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
import { hostname } from 'node:os';
import { truncateUtf8 } from '@maka/core/diagnostic-log';
import {
  connectExistingRuntimeHost,
  consumeAccessCredentialDelivery,
  issueRuntimeHostOwnerConnectionCode,
  REMOTE_DESKTOP_OWNER_ACCESS_POLICY,
} from '@maka/runtime-host/client';
import {
  isOperationKey,
  REMOTE_OWNER_OPERATION_GRANTS,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type AccessCredentialRotationRevokeInput,
  type ManagedAccessCredentialPrincipalKind,
  type OperationKey,
} from '@maka/runtime-host/protocol';
import {
  readRuntimeHostAccessCredentialMetadata,
  type RuntimeHostAccessCredentialMetadata,
} from '@maka/runtime-host/server';
import {
  encodeRuntimeHostAccessManagementFrame,
  RUNTIME_HOST_ACCESS_MANAGEMENT_ERROR_MESSAGE_MAX_BYTES,
  type RuntimeHostAccessManagementAction,
} from '@maka/runtime-host/operator';

const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

export class RuntimeHostAccessUnavailableError extends Error {
  constructor(
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`Runtime Host service is not available (${reason})`, options);
    this.name = 'RuntimeHostAccessUnavailableError';
  }
}

export interface RuntimeHostAccessIssueOptions {
  readonly rootPath: string;
  readonly expectedRootId?: string;
  readonly principalKind: ManagedAccessCredentialPrincipalKind;
  readonly principalId: string;
  readonly operationGrants: readonly string[];
  readonly canPublishClientCapabilities: boolean;
  readonly canUseHostPaths: boolean;
  readonly capabilityOwnerCredentialId?: string;
  readonly preset?: RuntimeHostAccessPreset;
  readonly bindClientInstance?: boolean;
}

export type RuntimeHostAccessPreset = 'desktop-client' | 'terminal-client';

export interface ResolvedRuntimeHostAccessIssue {
  readonly principalKind: ManagedAccessCredentialPrincipalKind;
  readonly operationGrants: readonly OperationKey[];
  readonly canPublishClientCapabilities: boolean;
  readonly canUseHostPaths: boolean;
}

const CLIENT_CAPABILITY_PUBLICATION_OPERATIONS = new Set<OperationKey>([
  'client.capability.replace',
  'client.capability.unregister',
]);

export interface RuntimeHostAccessListOptions {
  readonly rootPath: string;
  readonly expectedRootId?: string;
}

export interface RuntimeHostAccessConnectionCodeOptions extends RuntimeHostAccessListOptions {
  readonly name?: string;
}

export interface RuntimeHostAccessRevokeOptions extends RuntimeHostAccessListOptions {
  readonly credentialId: string;
  readonly currentCredentialFingerprint?: string;
}

export interface RuntimeHostAccessPrepareOptions extends RuntimeHostAccessListOptions {
  readonly currentCredentialFingerprint: string;
}

export interface IssuedRuntimeHostAccessCredential {
  readonly rootId: string;
  readonly credential: string;
  readonly credentialId: string;
  readonly principalKind: ManagedAccessCredentialPrincipalKind;
  readonly principalId: string;
  readonly operationGrants: readonly OperationKey[];
  readonly canPublishClientCapabilities: boolean;
  readonly canUseHostPaths: boolean;
}

export async function runRuntimeHostAccessIssueCli(
  options: RuntimeHostAccessIssueOptions,
): Promise<number> {
  const result = await issueRuntimeHostAccessCredential(options);
  const { rootId: _rootId, ...output } = result;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return 0;
}

export async function runRuntimeHostAccessListCli(
  options: RuntimeHostAccessListOptions,
  framed = false,
): Promise<number> {
  try {
    const result = await listRuntimeHostAccessCredentials(options);
    process.stdout.write(
      framed
        ? encodeRuntimeHostAccessManagementFrame({
            schemaVersion: 1,
            kind: 'result',
            action: 'list',
            credentials: mutableCredentialMetadata(result.credentials),
          })
        : `${JSON.stringify(result, null, 2)}\n`,
    );
    return 0;
  } catch (error) {
    if (!framed) throw error;
    writeAccessManagementError('list', error);
    return 1;
  }
}

export async function runRuntimeHostAccessConnectionCodeCli(
  options: RuntimeHostAccessConnectionCodeOptions,
  framed = false,
): Promise<number> {
  let connection: Awaited<ReturnType<typeof connectLocalOwner>> | undefined;
  try {
    connection = await connectLocalOwner(options.rootPath, options.expectedRootId);
    const connectionCode = await issueRuntimeHostOwnerConnectionCode({
      rootPath: options.rootPath,
      name: options.name?.trim() || truncateUtf8(hostname(), 128) || 'Runtime Host',
      principalId: `connection-code:${randomUUID()}`,
      client: connection,
    });
    process.stdout.write(
      framed
        ? encodeRuntimeHostAccessManagementFrame({
            schemaVersion: 1,
            kind: 'result',
            action: 'connection-code',
            connectionCode,
          })
        : `${connectionCode}\n`,
    );
    return 0;
  } catch (error) {
    if (!framed) throw error;
    writeAccessManagementError('connection-code', error);
    return 1;
  } finally {
    await connection?.close();
  }
}

export async function runRuntimeHostAccessPrepareCli(
  options: RuntimeHostAccessPrepareOptions,
): Promise<number> {
  try {
    const before = await listRuntimeHostAccessCredentials(options);
    const current = requireCurrentDesktopCredential(
      before.credentials,
      options.currentCredentialFingerprint,
    );
    const prepared = await prepareRuntimeHostAccessCredentialReplacement(
      options,
      current.credentialId,
    );
    const listed = await listRuntimeHostAccessCredentials(options);
    if (
      !listed.credentials.some((credential) => credential.credentialId === prepared.credentialId)
    ) {
      throw new Error('Prepared Runtime Host credential metadata is unavailable');
    }
    process.stdout.write(
      encodeRuntimeHostAccessManagementFrame({
        schemaVersion: 1,
        kind: 'result',
        action: 'prepare',
        credential: prepared.credential,
        credentials: mutableCredentialMetadata(listed.credentials),
      }),
    );
    return 0;
  } catch (error) {
    writeAccessManagementError('prepare', error);
    return 1;
  }
}

export function issueRuntimeHostAccessCredential(
  options: RuntimeHostAccessIssueOptions,
): Promise<IssuedRuntimeHostAccessCredential> {
  return mutateRuntimeHostAccessCredential(options, 'access.credential.issue');
}

export function prepareRuntimeHostAccessCredential(
  options: RuntimeHostAccessIssueOptions,
): Promise<IssuedRuntimeHostAccessCredential> {
  return mutateRuntimeHostAccessCredential(options, 'access.credential.prepare');
}

export function replaceRuntimeHostAccessCredential(
  options: RuntimeHostAccessIssueOptions,
): Promise<ReplacedRuntimeHostAccessCredential> {
  return mutateRuntimeHostAccessCredential(options, 'access.credential.replace');
}

export type ReplacedRuntimeHostAccessCredential = IssuedRuntimeHostAccessCredential;

async function prepareRuntimeHostAccessCredentialReplacement(
  options: RuntimeHostAccessListOptions,
  replacementOfCredentialId: string,
): Promise<IssuedRuntimeHostAccessCredential> {
  const connection = await connectLocalOwner(options.rootPath, options.expectedRootId);
  try {
    const result = await connection.request('access.credential.rotation.prepare', {
      replacementOfCredentialId,
    });
    const credential = await consumeAccessCredentialDelivery(
      options.rootPath,
      result.deliveryId,
      result.credentialId,
    );
    const { deliveryId: _deliveryId, ...metadata } = result;
    return { rootId: connection.rootId, credential, ...metadata };
  } finally {
    await connection.close();
  }
}

async function mutateRuntimeHostAccessCredential(
  options: RuntimeHostAccessIssueOptions,
  operation: 'access.credential.issue' | 'access.credential.prepare' | 'access.credential.replace',
): Promise<IssuedRuntimeHostAccessCredential> {
  const resolved = resolveRuntimeHostAccessIssue(options);
  const connection = await connectLocalOwner(options.rootPath, options.expectedRootId);
  try {
    const result = await connection.request(operation, {
      principalKind: resolved.principalKind,
      principalId: options.principalId,
      operationGrants: resolved.operationGrants,
      canPublishClientCapabilities: resolved.canPublishClientCapabilities,
      canUseHostPaths: resolved.canUseHostPaths,
      ...(operation !== 'access.credential.prepare' && options.capabilityOwnerCredentialId
        ? { capabilityOwnerCredentialId: options.capabilityOwnerCredentialId }
        : {}),
      ...(operation === 'access.credential.prepare' && options.bindClientInstance
        ? { bindClientInstance: true }
        : {}),
    });
    const credential = await consumeAccessCredentialDelivery(
      options.rootPath,
      result.deliveryId,
      result.credentialId,
    );
    const { deliveryId: _deliveryId, ...metadata } = result;
    return { rootId: connection.rootId, credential, ...metadata };
  } finally {
    await connection.close();
  }
}

export async function listRuntimeHostAccessCredentials(
  options: RuntimeHostAccessListOptions,
): Promise<{ readonly credentials: readonly RuntimeHostAccessCredentialMetadata[] }> {
  return readRuntimeHostAccessCredentialMetadata(options.rootPath, options.expectedRootId);
}

export function resolveRuntimeHostAccessIssue(
  options: RuntimeHostAccessIssueOptions,
): ResolvedRuntimeHostAccessIssue {
  if (!options.preset) {
    return {
      principalKind: options.principalKind,
      operationGrants: requireOperationGrants(options.operationGrants),
      canPublishClientCapabilities: options.canPublishClientCapabilities,
      canUseHostPaths: options.canUseHostPaths,
    };
  }
  if (options.preset === 'desktop-client') return REMOTE_DESKTOP_OWNER_ACCESS_POLICY;
  const operationGrants = REMOTE_OWNER_OPERATION_GRANTS.filter(
    (operation) => !CLIENT_CAPABILITY_PUBLICATION_OPERATIONS.has(operation),
  );
  return {
    principalKind: 'remote_owner',
    operationGrants,
    canPublishClientCapabilities: false,
    canUseHostPaths: false,
  };
}

export async function runRuntimeHostAccessRevokeCli(
  options: RuntimeHostAccessRevokeOptions,
  framed = false,
): Promise<number> {
  try {
    const before = await listRuntimeHostAccessCredentials(options);
    const target = before.credentials.find(
      (credential) => credential.credentialId === options.credentialId,
    );
    const current = options.currentCredentialFingerprint
      ? requireCurrentDesktopCredential(before.credentials, options.currentCredentialFingerprint)
      : undefined;
    if (target?.credentialFingerprint === options.currentCredentialFingerprint) {
      throw new Error('Rotate this Desktop credential instead of revoking it');
    }
    const result = await revokeRuntimeHostAccessCredential(
      options,
      current
        ? {
            credentialId: options.credentialId,
            requiredActiveCredentialId: current.credentialId,
          }
        : undefined,
    );
    const listed = await listRuntimeHostAccessCredentials(options);
    process.stdout.write(
      framed
        ? encodeRuntimeHostAccessManagementFrame({
            schemaVersion: 1,
            kind: 'result',
            action: 'revoke',
            ...result,
            credentials: mutableCredentialMetadata(listed.credentials),
          })
        : `${JSON.stringify(result)}\n`,
    );
    return result.revoked ? 0 : 1;
  } catch (error) {
    if (!framed) throw error;
    writeAccessManagementError('revoke', error);
    return 1;
  }
}

function requireCurrentDesktopCredential(
  credentials: readonly RuntimeHostAccessCredentialMetadata[],
  fingerprint: string,
): RuntimeHostAccessCredentialMetadata {
  const current = credentials.find(
    (credential) => credential.credentialFingerprint === fingerprint,
  );
  if (
    !current ||
    current.status !== 'active' ||
    current.principalKind !== 'remote_owner' ||
    !current.canPublishClientCapabilities ||
    current.canUseHostPaths
  ) {
    throw new Error('The current Desktop credential is not active on this Runtime Host');
  }
  return current;
}

function mutableCredentialMetadata(credentials: readonly RuntimeHostAccessCredentialMetadata[]) {
  return credentials.map((credential) => ({
    ...credential,
    operationGrants: [...credential.operationGrants],
  }));
}

export async function revokeRuntimeHostAccessCredential(
  options: RuntimeHostAccessRevokeOptions,
  guardedInput?: AccessCredentialRotationRevokeInput,
) {
  const connection = await connectLocalOwner(options.rootPath, options.expectedRootId);
  try {
    return await connection.request(
      guardedInput ? 'access.credential.rotation.revoke' : 'access.credential.revoke',
      guardedInput ?? { credentialId: options.credentialId },
    );
  } finally {
    await connection.close();
  }
}

async function connectLocalOwner(rootPath: string, expectedRootId?: string) {
  const result = await connectExistingRuntimeHost({ rootPath, protocol: PROTOCOL }).catch(
    (error: unknown) => {
      throw new RuntimeHostAccessUnavailableError('connection_failed', { cause: error });
    },
  );
  if (result.kind !== 'connected') {
    throw new RuntimeHostAccessUnavailableError(
      result.kind === 'unavailable' ? result.reason : result.kind,
    );
  }
  if (expectedRootId && result.connection.rootId !== expectedRootId) {
    await result.connection.close();
    throw new Error('Runtime Host service is bound to a different State Root');
  }
  return result.connection;
}

function writeAccessManagementError(
  action: RuntimeHostAccessManagementAction,
  error: unknown,
): void {
  process.stdout.write(
    encodeRuntimeHostAccessManagementFrame({
      schemaVersion: 1,
      kind: 'error',
      action,
      error: {
        code: 'access_management_failed',
        message:
          truncateUtf8(
            error instanceof Error ? error.message : String(error),
            RUNTIME_HOST_ACCESS_MANAGEMENT_ERROR_MESSAGE_MAX_BYTES,
          ) || 'Runtime Host access management failed',
      },
    }),
  );
}

function requireOperationGrants(values: readonly string[]): readonly OperationKey[] {
  const grants = values.flatMap((value) => value.split(',')).filter((value) => value.length > 0);
  if (grants.length === 0) throw new Error('At least one --grant is required');
  for (const grant of grants) {
    if (!isOperationKey(grant)) throw new Error(`Unknown Runtime Host operation grant: ${grant}`);
  }
  return [...new Set(grants)] as OperationKey[];
}
