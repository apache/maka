import { invalidProtocolFrame } from './errors.js';
import { requireExactRecord, requireId, requireString, requireUtf8String } from './codec.js';
import { defineOperation } from './operation-spec.js';
import type { OperationKey } from './operations.js';

export const ACCESS_CREDENTIAL_MAX_GRANTS = 256;

const ACCESS_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'persistence_failed',
  'internal_failure',
] as const;

export interface AccessCredentialIssueInput {
  readonly principalId: string;
  readonly operationGrants: readonly OperationKey[];
  readonly canPublishClientCapabilities: boolean;
  readonly canUseHostPaths: boolean;
}

export interface AccessCredentialIssueResult {
  readonly credentialId: string;
  readonly deliveryId: string;
  readonly principalId: string;
  readonly operationGrants: readonly OperationKey[];
  readonly canPublishClientCapabilities: boolean;
  readonly canUseHostPaths: boolean;
}

export interface AccessCredentialRevokeInput {
  readonly credentialId: string;
}

export interface AccessCredentialRevokeResult {
  readonly credentialId: string;
  readonly revoked: boolean;
}

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
} as const;

export function decodeAccessCredentialIssueInput(value: unknown): AccessCredentialIssueInput {
  const record = requireExactRecord(value, 'access credential issue input', [
    'principalId',
    'operationGrants',
    'canPublishClientCapabilities',
    'canUseHostPaths',
  ]);
  return {
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
    'principalId',
    'operationGrants',
    'canPublishClientCapabilities',
    'canUseHostPaths',
  ]);
  return {
    credentialId: requireId(record.credentialId, 'credentialId'),
    deliveryId: requireId(record.deliveryId, 'deliveryId'),
    principalId: principalId(record.principalId),
    operationGrants: operationGrants(record.operationGrants),
    canPublishClientCapabilities: boolean(
      record.canPublishClientCapabilities,
      'canPublishClientCapabilities',
    ),
    canUseHostPaths: boolean(record.canUseHostPaths, 'canUseHostPaths'),
  };
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
