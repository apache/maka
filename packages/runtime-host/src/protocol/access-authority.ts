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

import { invalidProtocolFrame } from './errors.js';
import { requireExactRecord, requireId, requireString, requireUtf8String } from './codec.js';
import { defineOperation } from './operation-spec.js';
import type { OperationKey } from './operations.js';

export const ACCESS_CREDENTIAL_MAX_GRANTS = 256;

export type AccessCredentialPrincipalKind = 'remote_owner' | 'capability_provider';

const ACCESS_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'persistence_failed',
  'commit_outcome_unknown',
  'internal_failure',
] as const;

export interface AccessCredentialIssueInput {
  readonly principalKind: AccessCredentialPrincipalKind;
  readonly principalId: string;
  readonly operationGrants: readonly OperationKey[];
  readonly canPublishClientCapabilities: boolean;
  readonly canUseHostPaths: boolean;
}

export interface AccessCredentialIssueResult {
  readonly credentialId: string;
  readonly deliveryId: string;
  readonly principalKind: AccessCredentialPrincipalKind;
  readonly principalId: string;
  readonly operationGrants: readonly OperationKey[];
  readonly canPublishClientCapabilities: boolean;
  readonly canUseHostPaths: boolean;
}

export type AccessCredentialReplaceInput = AccessCredentialIssueInput;
export type AccessCredentialReplaceResult = AccessCredentialIssueResult;
export type AccessCredentialPrepareInput = AccessCredentialIssueInput;
export type AccessCredentialPrepareResult = AccessCredentialIssueResult;

export interface AccessCredentialRevokeInput {
  readonly credentialId: string;
}

export interface AccessCredentialRevokeResult {
  readonly credentialId: string;
  readonly revoked: boolean;
}

export type AccessCredentialFinalizeInput = Record<string, never>;
export type AccessCredentialFinalizeResult = Record<string, never>;

export const ACCESS_AUTHORITY_OPERATION_SPECS = {
  'access.credential.issue': defineOperation<
    AccessCredentialIssueInput,
    AccessCredentialIssueResult,
    (typeof ACCESS_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: ACCESS_ERRORS,
    decodeInput: decodeAccessCredentialIssueInput,
    decodeOutput: decodeAccessCredentialIssueResult,
  }),
  'access.credential.replace': defineOperation<
    AccessCredentialReplaceInput,
    AccessCredentialReplaceResult,
    (typeof ACCESS_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: ACCESS_ERRORS,
    decodeInput: decodeAccessCredentialIssueInput,
    decodeOutput: decodeAccessCredentialIssueResult,
  }),
  'access.credential.prepare': defineOperation<
    AccessCredentialPrepareInput,
    AccessCredentialPrepareResult,
    (typeof ACCESS_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: ACCESS_ERRORS,
    decodeInput: decodeAccessCredentialIssueInput,
    decodeOutput: decodeAccessCredentialIssueResult,
  }),
  'access.credential.revoke': defineOperation<
    AccessCredentialRevokeInput,
    AccessCredentialRevokeResult,
    (typeof ACCESS_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: ACCESS_ERRORS,
    decodeInput: decodeAccessCredentialRevokeInput,
    decodeOutput: decodeAccessCredentialRevokeResult,
  }),
  'access.credential.finalize': defineOperation<
    AccessCredentialFinalizeInput,
    AccessCredentialFinalizeResult,
    (typeof ACCESS_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: ACCESS_ERRORS,
    decodeInput: decodeAccessCredentialFinalizeInput,
    decodeOutput: decodeAccessCredentialFinalizeResult,
  }),
} as const;

export function decodeAccessCredentialIssueInput(value: unknown): AccessCredentialIssueInput {
  const record = requireExactRecord(value, 'access credential issue input', [
    'principalKind',
    'principalId',
    'operationGrants',
    'canPublishClientCapabilities',
    'canUseHostPaths',
  ]);
  return {
    principalKind: principalKind(record.principalKind),
    principalId: principalId(record.principalId),
    operationGrants: operationGrants(record.operationGrants),
    canPublishClientCapabilities: boolean(
      record.canPublishClientCapabilities,
      'canPublishClientCapabilities',
    ),
    canUseHostPaths: boolean(record.canUseHostPaths, 'canUseHostPaths'),
  };
}

export function decodeAccessCredentialIssueResult(value: unknown): AccessCredentialIssueResult {
  const record = requireExactRecord(value, 'access credential issue result', [
    'credentialId',
    'deliveryId',
    'principalKind',
    'principalId',
    'operationGrants',
    'canPublishClientCapabilities',
    'canUseHostPaths',
  ]);
  return {
    credentialId: requireId(record.credentialId, 'credentialId'),
    deliveryId: requireId(record.deliveryId, 'deliveryId'),
    principalKind: principalKind(record.principalKind),
    principalId: principalId(record.principalId),
    operationGrants: operationGrants(record.operationGrants),
    canPublishClientCapabilities: boolean(
      record.canPublishClientCapabilities,
      'canPublishClientCapabilities',
    ),
    canUseHostPaths: boolean(record.canUseHostPaths, 'canUseHostPaths'),
  };
}

function principalKind(value: unknown): AccessCredentialPrincipalKind {
  if (value !== 'remote_owner' && value !== 'capability_provider') {
    throw invalidProtocolFrame('Invalid access credential principalKind');
  }
  return value;
}

export function decodeAccessCredentialRevokeInput(value: unknown): AccessCredentialRevokeInput {
  const record = requireExactRecord(value, 'access credential revoke input', ['credentialId']);
  return { credentialId: requireId(record.credentialId, 'credentialId') };
}

export function decodeAccessCredentialRevokeResult(value: unknown): AccessCredentialRevokeResult {
  const record = requireExactRecord(value, 'access credential revoke result', [
    'credentialId',
    'revoked',
  ]);
  return {
    credentialId: requireId(record.credentialId, 'credentialId'),
    revoked: boolean(record.revoked, 'revoked'),
  };
}

export function decodeAccessCredentialFinalizeInput(value: unknown): AccessCredentialFinalizeInput {
  requireExactRecord(value, 'access credential finalize input', []);
  return {};
}

export function decodeAccessCredentialFinalizeResult(
  value: unknown,
): AccessCredentialFinalizeResult {
  requireExactRecord(value, 'access credential finalize result', []);
  return {};
}

function operationGrants(value: unknown): readonly OperationKey[] {
  if (!Array.isArray(value) || value.length > ACCESS_CREDENTIAL_MAX_GRANTS) {
    throw invalidProtocolFrame('Invalid access credential operation grants');
  }
  const grants = value.map((grant) =>
    requireString(grant, 'access credential operation grant', 128),
  );
  if (new Set(grants).size !== grants.length) {
    throw invalidProtocolFrame('Duplicate access credential operation grant');
  }
  return grants as OperationKey[];
}

function principalId(value: unknown): string {
  const principal = requireUtf8String(value, 'access credential principalId', 128);
  if (!/^[A-Za-z0-9_.:-]+$/u.test(principal)) {
    throw invalidProtocolFrame('Invalid access credential principalId');
  }
  return principal;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalidProtocolFrame(`Invalid ${label}`);
  return value;
}
