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
  requireEntityId,
  requireExactRecord,
  requireId,
  requireRecord,
  requireShapedRecord,
  requireUtf8String,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';
import { decodeTurnStartInput } from './turn.js';

export const COLLABORATION_INVITATION_SCHEMA_VERSION = 1 as const;
export const COLLABORATION_INVITATION_CODE_MAX_BYTES = 16 * 1024;
export const SESSION_COLLABORATION_MAX_GRANTS_PER_INVITATION = 2;

export type SessionCollaborationGrantKind = 'session_observation' | 'session_turn_request';

interface SessionGrantIdentity {
  readonly grantId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly createdAt: string;
}

export interface SessionObservationGrant extends SessionGrantIdentity {
  readonly kind: 'session_observation';
}

export interface SessionTurnRequestGrant extends SessionGrantIdentity {
  readonly kind: 'session_turn_request';
}

export type SessionCollaborationGrant = SessionObservationGrant | SessionTurnRequestGrant;

export interface CollaborationInvitationPrepareInput {
  readonly sessionId: string;
  readonly grantKinds: readonly SessionCollaborationGrantKind[];
}

export interface CollaborationInvitationPayload {
  readonly schemaVersion: typeof COLLABORATION_INVITATION_SCHEMA_VERSION;
  readonly rootId: string;
  readonly credential: string;
}

export interface CollaborationInvitationPrepareResult {
  readonly invitationCode: string;
  readonly principalId: string;
  readonly expiresAt: string;
  readonly grants: readonly SessionCollaborationGrant[];
}

export interface CollaborationAccessQueryInput {
  readonly sessionId?: string;
}

export interface SessionGuestPrincipalProjection {
  readonly principalId: string;
  readonly status: 'pending' | 'active';
  readonly createdAt: string;
  readonly expiresAt?: string;
}

export interface CollaborationAccessQueryResult {
  readonly principals: readonly SessionGuestPrincipalProjection[];
  readonly grants: readonly SessionCollaborationGrant[];
}

export interface CollaborationGrantRevokeInput {
  readonly grantId: string;
}

export interface CollaborationGrantRevokeResult {
  readonly revoked: boolean;
}

export interface CollaborationPrincipalRevokeInput {
  readonly principalId: string;
}

export interface CollaborationPrincipalRevokeResult {
  readonly revoked: boolean;
}

export type SessionTurnAccessRequestState =
  | { readonly kind: 'pending' }
  | {
      readonly kind: 'rejected';
      readonly decidedAt: string;
      readonly decidedBy: string;
    }
  | {
      readonly kind: 'approved';
      readonly decidedAt: string;
      readonly decidedBy: string;
      readonly admission: 'pending' | 'started' | 'blocked' | 'failed';
    };

export interface SessionTurnRequestIntent {
  readonly sessionId: string;
  readonly turnId: string;
  readonly content: { readonly text: string };
}

export interface SessionTurnAccessRequest {
  readonly requestId: string;
  readonly principalId: string;
  readonly grantId: string;
  readonly intent: SessionTurnRequestIntent;
  readonly createdAt: string;
  readonly state: SessionTurnAccessRequestState;
}

export interface CollaborationTurnRequestCreateInput {
  readonly intent: SessionTurnRequestIntent;
}

export interface CollaborationTurnRequestQueryInput {
  readonly sessionId: string;
}

export interface CollaborationTurnRequestQueryResult {
  readonly canRequestTurns: boolean;
  readonly requests: readonly SessionTurnAccessRequest[];
}

export interface CollaborationTurnRequestDecideInput {
  readonly requestId: string;
  readonly decision: 'approve' | 'reject';
}

export type CollaborationTurnRequestDecideResult =
  | { readonly kind: 'not_found' }
  | {
      readonly kind: 'decided' | 'already_decided';
      readonly request: SessionTurnAccessRequest;
    };

export interface CollaborationTurnRequestAcknowledgeInput {
  readonly requestId: string;
}

export interface CollaborationTurnRequestAcknowledgeResult {
  readonly acknowledged: boolean;
}
const COLLABORATION_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'persistence_failed',
  'commit_outcome_unknown',
  'internal_failure',
] as const;

export const SESSION_COLLABORATION_OPERATION_SPECS = {
  'collaboration.invitation.prepare': defineOperation<
    CollaborationInvitationPrepareInput,
    CollaborationInvitationPrepareResult,
    (typeof COLLABORATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: COLLABORATION_ERRORS,
    decodeInput: decodeCollaborationInvitationPrepareInput,
    decodeOutput: decodeCollaborationInvitationPrepareResult,
  }),
  'collaboration.access.query': defineOperation<
    CollaborationAccessQueryInput,
    CollaborationAccessQueryResult,
    (typeof COLLABORATION_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: COLLABORATION_ERRORS,
    decodeInput: decodeCollaborationAccessQueryInput,
    decodeOutput: decodeCollaborationAccessQueryResult,
  }),
  'collaboration.grant.revoke': defineOperation<
    CollaborationGrantRevokeInput,
    CollaborationGrantRevokeResult,
    (typeof COLLABORATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: COLLABORATION_ERRORS,
    decodeInput: decodeCollaborationGrantRevokeInput,
    decodeOutput: decodeCollaborationGrantRevokeResult,
  }),
  'collaboration.principal.revoke': defineOperation<
    CollaborationPrincipalRevokeInput,
    CollaborationPrincipalRevokeResult,
    (typeof COLLABORATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: COLLABORATION_ERRORS,
    decodeInput: decodeCollaborationPrincipalRevokeInput,
    decodeOutput: decodeCollaborationPrincipalRevokeResult,
  }),
  'collaboration.turn-request.create': defineOperation<
    CollaborationTurnRequestCreateInput,
    SessionTurnAccessRequest,
    (typeof COLLABORATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: COLLABORATION_ERRORS,
    decodeInput: decodeCollaborationTurnRequestCreateInput,
    decodeOutput: decodeSessionTurnAccessRequest,
  }),
  'collaboration.turn-request.query': defineOperation<
    CollaborationTurnRequestQueryInput,
    CollaborationTurnRequestQueryResult,
    (typeof COLLABORATION_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: COLLABORATION_ERRORS,
    decodeInput: decodeCollaborationTurnRequestQueryInput,
    decodeOutput: decodeCollaborationTurnRequestQueryResult,
  }),
  'collaboration.turn-request.acknowledge': defineOperation<
    CollaborationTurnRequestAcknowledgeInput,
    CollaborationTurnRequestAcknowledgeResult,
    (typeof COLLABORATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: COLLABORATION_ERRORS,
    decodeInput: decodeCollaborationTurnRequestAcknowledgeInput,
    decodeOutput: decodeCollaborationTurnRequestAcknowledgeResult,
  }),
  'collaboration.turn-request.decide': defineOperation<
    CollaborationTurnRequestDecideInput,
    CollaborationTurnRequestDecideResult,
    (typeof COLLABORATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: COLLABORATION_ERRORS,
    decodeInput: decodeCollaborationTurnRequestDecideInput,
    decodeOutput: decodeCollaborationTurnRequestDecideResult,
  }),
} as const;

export function encodeCollaborationInvitationCode(payload: CollaborationInvitationPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCollaborationInvitationCode(code: string): CollaborationInvitationPayload {
  const bounded = requireUtf8String(
    code,
    'collaboration invitation code',
    COLLABORATION_INVITATION_CODE_MAX_BYTES,
  );
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(bounded, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw invalidProtocolFrame('Invalid collaboration invitation code');
  }
  const record = requireExactRecord(decoded, 'collaboration invitation', [
    'schemaVersion',
    'rootId',
    'credential',
  ]);
  if (record.schemaVersion !== COLLABORATION_INVITATION_SCHEMA_VERSION) {
    throw invalidProtocolFrame('Unsupported collaboration invitation');
  }
  return {
    schemaVersion: COLLABORATION_INVITATION_SCHEMA_VERSION,
    rootId: requireId(record.rootId, 'rootId'),
    credential: requireUtf8String(record.credential, 'credential', 1024),
  };
}

function decodeCollaborationInvitationPrepareInput(
  value: unknown,
): CollaborationInvitationPrepareInput {
  const record = requireExactRecord(value, 'collaboration invitation prepare input', [
    'sessionId',
    'grantKinds',
  ]);
  if (
    !Array.isArray(record.grantKinds) ||
    record.grantKinds.length === 0 ||
    record.grantKinds.length > SESSION_COLLABORATION_MAX_GRANTS_PER_INVITATION
  ) {
    throw invalidProtocolFrame('Invalid collaboration invitation grant kinds');
  }
  const grantKinds = record.grantKinds.map(decodeGrantKind);
  if (new Set(grantKinds).size !== grantKinds.length) {
    throw invalidProtocolFrame('Duplicate collaboration invitation grant kind');
  }
  return {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    grantKinds,
  };
}

function decodeCollaborationInvitationPrepareResult(
  value: unknown,
): CollaborationInvitationPrepareResult {
  const record = requireExactRecord(value, 'collaboration invitation prepare result', [
    'invitationCode',
    'principalId',
    'expiresAt',
    'grants',
  ]);
  if (!Array.isArray(record.grants)) {
    throw invalidProtocolFrame('Invalid collaboration invitation grants');
  }
  return {
    invitationCode: requireUtf8String(
      record.invitationCode,
      'invitationCode',
      COLLABORATION_INVITATION_CODE_MAX_BYTES,
    ),
    principalId: decodePrincipalId(record.principalId),
    expiresAt: decodeIsoTimestamp(record.expiresAt, 'expiresAt'),
    grants: record.grants.map(decodeSessionCollaborationGrant),
  };
}

function decodeCollaborationAccessQueryInput(value: unknown): CollaborationAccessQueryInput {
  const record = requireShapedRecord(value, 'collaboration access query input', [], ['sessionId']);
  return record.sessionId === undefined
    ? {}
    : { sessionId: requireEntityId(record.sessionId, 'sessionId') };
}

function decodeCollaborationAccessQueryResult(value: unknown): CollaborationAccessQueryResult {
  const record = requireExactRecord(value, 'collaboration access query result', [
    'principals',
    'grants',
  ]);
  if (!Array.isArray(record.principals) || !Array.isArray(record.grants)) {
    throw invalidProtocolFrame('Invalid collaboration access result');
  }
  return {
    principals: record.principals.map(decodeSessionGuestPrincipal),
    grants: record.grants.map(decodeSessionCollaborationGrant),
  };
}

function decodeSessionGuestPrincipal(value: unknown): SessionGuestPrincipalProjection {
  const record = requireShapedRecord(
    value,
    'Session Guest principal',
    ['principalId', 'status', 'createdAt'],
    ['expiresAt'],
  );
  if (record.status !== 'pending' && record.status !== 'active') {
    throw invalidProtocolFrame('Invalid Session Guest principal status');
  }
  return {
    principalId: decodePrincipalId(record.principalId),
    status: record.status,
    createdAt: decodeIsoTimestamp(record.createdAt, 'createdAt'),
    ...(record.expiresAt === undefined
      ? {}
      : { expiresAt: decodeIsoTimestamp(record.expiresAt, 'expiresAt') }),
  };
}

function decodeCollaborationGrantRevokeInput(value: unknown): CollaborationGrantRevokeInput {
  const record = requireExactRecord(value, 'collaboration grant revoke input', ['grantId']);
  return { grantId: requireId(record.grantId, 'grantId') };
}

function decodeCollaborationGrantRevokeResult(value: unknown): CollaborationGrantRevokeResult {
  const record = requireExactRecord(value, 'collaboration grant revoke result', ['revoked']);
  if (typeof record.revoked !== 'boolean') {
    throw invalidProtocolFrame('Invalid collaboration grant revoke result');
  }
  return { revoked: record.revoked };
}

function decodeCollaborationPrincipalRevokeInput(
  value: unknown,
): CollaborationPrincipalRevokeInput {
  const record = requireExactRecord(value, 'collaboration principal revoke input', ['principalId']);
  return { principalId: decodePrincipalId(record.principalId) };
}

function decodeCollaborationPrincipalRevokeResult(
  value: unknown,
): CollaborationPrincipalRevokeResult {
  const record = requireExactRecord(value, 'collaboration principal revoke result', ['revoked']);
  if (typeof record.revoked !== 'boolean') {
    throw invalidProtocolFrame('Invalid collaboration principal revoke result');
  }
  return { revoked: record.revoked };
}

function decodeCollaborationTurnRequestCreateInput(
  value: unknown,
): CollaborationTurnRequestCreateInput {
  const record = requireExactRecord(value, 'collaboration Turn request input', ['intent']);
  return { intent: decodeSessionTurnRequestIntent(record.intent) };
}

function decodeCollaborationTurnRequestQueryInput(
  value: unknown,
): CollaborationTurnRequestQueryInput {
  const record = requireExactRecord(value, 'collaboration Turn request query', ['sessionId']);
  return { sessionId: requireEntityId(record.sessionId, 'sessionId') };
}

function decodeCollaborationTurnRequestQueryResult(
  value: unknown,
): CollaborationTurnRequestQueryResult {
  const record = requireExactRecord(value, 'collaboration Turn request query result', [
    'canRequestTurns',
    'requests',
  ]);
  if (!Array.isArray(record.requests)) {
    throw invalidProtocolFrame('Invalid collaboration Turn request query result');
  }
  if (typeof record.canRequestTurns !== 'boolean') {
    throw invalidProtocolFrame('Invalid collaboration Turn request authority');
  }
  return {
    canRequestTurns: record.canRequestTurns,
    requests: record.requests.map(decodeSessionTurnAccessRequest),
  };
}

function decodeCollaborationTurnRequestAcknowledgeInput(
  value: unknown,
): CollaborationTurnRequestAcknowledgeInput {
  const record = requireExactRecord(value, 'collaboration Turn request acknowledgement input', [
    'requestId',
  ]);
  return { requestId: requireId(record.requestId, 'requestId') };
}

function decodeCollaborationTurnRequestAcknowledgeResult(
  value: unknown,
): CollaborationTurnRequestAcknowledgeResult {
  const record = requireExactRecord(value, 'collaboration Turn request acknowledgement result', [
    'acknowledged',
  ]);
  if (typeof record.acknowledged !== 'boolean') {
    throw invalidProtocolFrame('Invalid collaboration Turn request acknowledgement result');
  }
  return { acknowledged: record.acknowledged };
}

function decodeCollaborationTurnRequestDecideInput(
  value: unknown,
): CollaborationTurnRequestDecideInput {
  const record = requireExactRecord(value, 'collaboration Turn request decision', [
    'requestId',
    'decision',
  ]);
  if (record.decision !== 'approve' && record.decision !== 'reject') {
    throw invalidProtocolFrame('Invalid collaboration Turn request decision');
  }
  return {
    requestId: requireId(record.requestId, 'requestId'),
    decision: record.decision,
  };
}

function decodeCollaborationTurnRequestDecideResult(
  value: unknown,
): CollaborationTurnRequestDecideResult {
  const candidate = requireRecord(value, 'collaboration Turn request decision result');
  const record = requireExactRecord(
    value,
    'collaboration Turn request decision result',
    candidate.kind === 'not_found' ? ['kind'] : ['kind', 'request'],
  );
  if (
    record.kind !== 'decided' &&
    record.kind !== 'already_decided' &&
    record.kind !== 'not_found'
  ) {
    throw invalidProtocolFrame('Invalid collaboration Turn request decision result');
  }
  return record.kind === 'not_found'
    ? { kind: record.kind }
    : { kind: record.kind, request: decodeSessionTurnAccessRequest(record.request) };
}

export function decodeSessionTurnAccessRequest(value: unknown): SessionTurnAccessRequest {
  const record = requireExactRecord(value, 'Session Turn access request', [
    'requestId',
    'principalId',
    'grantId',
    'intent',
    'createdAt',
    'state',
  ]);
  return {
    requestId: requireId(record.requestId, 'requestId'),
    principalId: decodePrincipalId(record.principalId),
    grantId: requireId(record.grantId, 'grantId'),
    intent: decodeSessionTurnRequestIntent(record.intent),
    createdAt: decodeIsoTimestamp(record.createdAt, 'createdAt'),
    state: decodeSessionTurnAccessRequestState(record.state),
  };
}

function decodeSessionTurnRequestIntent(value: unknown): SessionTurnRequestIntent {
  const record = requireExactRecord(value, 'Session Turn request intent', [
    'sessionId',
    'turnId',
    'content',
  ]);
  const content = requireExactRecord(record.content, 'Session Turn request content', ['text']);
  const decoded = decodeTurnStartInput({
    sessionId: record.sessionId,
    turnId: record.turnId,
    content: { text: content.text },
  });
  return {
    sessionId: decoded.sessionId,
    turnId: decoded.turnId,
    content: { text: decoded.content.text },
  };
}

function decodeSessionTurnAccessRequestState(value: unknown): SessionTurnAccessRequestState {
  const kind = requireShapedRecord(
    value,
    'Session Turn access request state',
    ['kind'],
    ['decidedAt', 'decidedBy', 'admission'],
  ).kind;
  if (kind === 'pending') {
    requireExactRecord(value, 'pending Session Turn access request', ['kind']);
    return { kind };
  }
  if (kind === 'rejected') {
    const record = requireExactRecord(value, 'rejected Session Turn access request', [
      'kind',
      'decidedAt',
      'decidedBy',
    ]);
    return {
      kind,
      decidedAt: decodeIsoTimestamp(record.decidedAt, 'decidedAt'),
      decidedBy: decodePrincipalId(record.decidedBy),
    };
  }
  if (kind !== 'approved') {
    throw invalidProtocolFrame('Invalid Session Turn access request state');
  }
  const candidate = requireExactRecord(value, 'approved Session Turn access request', [
    'kind',
    'decidedAt',
    'decidedBy',
    'admission',
  ]);
  if (
    candidate.admission !== 'pending' &&
    candidate.admission !== 'started' &&
    candidate.admission !== 'blocked' &&
    candidate.admission !== 'failed'
  ) {
    throw invalidProtocolFrame('Invalid Session Turn access request admission');
  }
  return {
    kind,
    decidedAt: decodeIsoTimestamp(candidate.decidedAt, 'decidedAt'),
    decidedBy: decodePrincipalId(candidate.decidedBy),
    admission: candidate.admission,
  };
}

export function decodeSessionCollaborationGrant(value: unknown): SessionCollaborationGrant {
  const record = requireExactRecord(value, 'Session collaboration grant', [
    'kind',
    'grantId',
    'principalId',
    'sessionId',
    'createdAt',
  ]);
  const kind = decodeGrantKind(record.kind);
  return {
    kind,
    grantId: requireId(record.grantId, 'grantId'),
    principalId: decodePrincipalId(record.principalId),
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    createdAt: decodeIsoTimestamp(record.createdAt, 'createdAt'),
  };
}

function decodeGrantKind(value: unknown): SessionCollaborationGrantKind {
  if (value !== 'session_observation' && value !== 'session_turn_request') {
    throw invalidProtocolFrame('Invalid Session collaboration grant kind');
  }
  return value;
}

function decodePrincipalId(value: unknown): string {
  const principalId = requireUtf8String(value, 'principalId', 128);
  if (!/^[A-Za-z0-9_.:-]+$/u.test(principalId)) {
    throw invalidProtocolFrame('Invalid principalId');
  }
  return principalId;
}

function decodeIsoTimestamp(value: unknown, label: string): string {
  const timestamp = requireUtf8String(value, label, 64);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return timestamp;
}
