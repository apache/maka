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

import {
  connectExistingRuntimeHost,
  consumeAccessCredentialDelivery,
} from '@maka/runtime-host/client';
import {
  isOperationKey,
  REMOTE_OWNER_OPERATION_GRANTS,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type AccessCredentialPrincipalKind,
  type OperationKey,
} from '@maka/runtime-host/protocol';

const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

export interface RuntimeHostAccessIssueOptions {
  readonly rootPath: string;
  readonly principalKind: AccessCredentialPrincipalKind;
  readonly principalId: string;
  readonly operationGrants: readonly string[];
  readonly canPublishClientCapabilities: boolean;
  readonly canUseHostPaths: boolean;
  readonly preset?: RuntimeHostAccessPreset;
}

export type RuntimeHostAccessPreset = 'desktop-client' | 'terminal-client';

export interface ResolvedRuntimeHostAccessIssue {
  readonly principalKind: AccessCredentialPrincipalKind;
  readonly operationGrants: readonly OperationKey[];
  readonly canPublishClientCapabilities: boolean;
  readonly canUseHostPaths: boolean;
}

const CLIENT_CAPABILITY_PUBLICATION_OPERATIONS = new Set<OperationKey>([
  'client.capability.replace',
  'client.capability.unregister',
]);

export interface RuntimeHostAccessRevokeOptions {
  readonly rootPath: string;
  readonly credentialId: string;
}

export interface IssuedRuntimeHostAccessCredential {
  readonly rootId: string;
  readonly credential: string;
  readonly credentialId: string;
  readonly principalKind: AccessCredentialPrincipalKind;
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

export async function replaceRuntimeHostAccessCredential(
  options: RuntimeHostAccessIssueOptions,
): Promise<ReplacedRuntimeHostAccessCredential> {
  return mutateRuntimeHostAccessCredential(options, 'access.credential.replace');
}

export type ReplacedRuntimeHostAccessCredential = IssuedRuntimeHostAccessCredential;

async function mutateRuntimeHostAccessCredential(
  options: RuntimeHostAccessIssueOptions,
  operation: 'access.credential.issue' | 'access.credential.prepare' | 'access.credential.replace',
): Promise<IssuedRuntimeHostAccessCredential> {
  const resolved = resolveRuntimeHostAccessIssue(options);
  const connection = await connectLocalOwner(options.rootPath);
  try {
    const credentialInput = {
      principalKind: resolved.principalKind,
      principalId: options.principalId,
      operationGrants: resolved.operationGrants,
      canPublishClientCapabilities: resolved.canPublishClientCapabilities,
      canUseHostPaths: resolved.canUseHostPaths,
    };
    const result = await connection.request(operation, credentialInput);
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
  const canPublishClientCapabilities = options.preset === 'desktop-client';
  const operationGrants = REMOTE_OWNER_OPERATION_GRANTS.filter(
    (operation) =>
      canPublishClientCapabilities || !CLIENT_CAPABILITY_PUBLICATION_OPERATIONS.has(operation),
  );
  return {
    principalKind: 'remote_owner',
    operationGrants,
    canPublishClientCapabilities,
    canUseHostPaths: false,
  };
}

export async function runRuntimeHostAccessRevokeCli(
  options: RuntimeHostAccessRevokeOptions,
): Promise<number> {
  const result = await revokeRuntimeHostAccessCredential(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.revoked ? 0 : 1;
}

export async function revokeRuntimeHostAccessCredential(options: RuntimeHostAccessRevokeOptions) {
  const connection = await connectLocalOwner(options.rootPath);
  try {
    return await connection.request('access.credential.revoke', {
      credentialId: options.credentialId,
    });
  } finally {
    await connection.close();
  }
}

async function connectLocalOwner(rootPath: string) {
  const result = await connectExistingRuntimeHost({
    rootPath,
    protocol: PROTOCOL,
  });
  if (result.kind !== 'connected') {
    throw new Error(`Runtime Host service is not available (${result.kind})`);
  }
  return result.connection;
}

function requireOperationGrants(values: readonly string[]): readonly OperationKey[] {
  const grants = values.flatMap((value) => value.split(',')).filter((value) => value.length > 0);
  if (grants.length === 0) throw new Error('At least one --grant is required');
  for (const grant of grants) {
    if (!isOperationKey(grant)) throw new Error(`Unknown Runtime Host operation grant: ${grant}`);
  }
  return [...new Set(grants)] as OperationKey[];
}
