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
  requireCount,
  requireEntityId,
  requireExactRecord,
  requireRecord,
  requireShapedRecord,
  requireUtf8String,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';
import {
  decodeWorkspaceProjection,
  decodeWorkspaceTarget,
  type WorkspaceProjection,
  type WorkspaceTarget,
} from './workspace.js';

export const WORKHUB_COORDINATION_TEXT_MAX_BYTES = 48 * 1024;
export const WORKHUB_COORDINATION_SUMMARY_MAX_BYTES = 8 * 1024;
const COORDINATION_TITLE_MAX_BYTES = 512;
const CANDIDATE_SET_ID_MAX_BYTES = 96;
export const WORKHUB_COORDINATION_CANDIDATE_MAX_ITEMS = 32;

const RESOLVE_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'operation_conflict',
  'persistence_failed',
  'commit_outcome_unknown',
  'internal_failure',
] as const;

const TURN_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'not_found',
  'session_archived',
  'session_busy',
  'operation_conflict',
  'persistence_failed',
  'commit_outcome_unknown',
  'internal_failure',
] as const;

const CANDIDATE_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'persistence_failed',
  'internal_failure',
] as const;

export type WorkHubCoordinationResolveInput = Record<string, never>;

export interface WorkHubCoordinationResolveResult {
  readonly sessionId: string;
}

export interface WorkHubCoordinationAnswerInput {
  readonly turnId: string;
  readonly text: string;
}

export interface WorkHubCoordinationRecordInput {
  readonly turnId: string;
  readonly userText: string;
  readonly assistantText: string;
}

export interface WorkHubCoordinationTurnResult {
  readonly turnId: string;
}

export type WorkHubCoordinationCandidateState =
  | 'active'
  | 'running'
  | 'waiting_for_user'
  | 'blocked'
  | 'aborted';

export interface WorkHubCoordinationCandidate {
  /** Opaque strategy-facing identity. Proposals never carry a Session id. */
  readonly candidateRef: string;
  /** Presentation/navigation identity; adapters must not expose it to a model strategy. */
  readonly sessionId: string;
  readonly sessionName: string;
  readonly workspace: WorkspaceProjection;
  readonly state: WorkHubCoordinationCandidateState;
  readonly updatedAt: number;
}

export type WorkHubCoordinationCandidatesInput = Record<string, never>;

export interface WorkHubCoordinationCandidatesResult {
  readonly candidateSetId: string;
  readonly candidates: readonly WorkHubCoordinationCandidate[];
}

export type WorkHubCoordinationProposal =
  | { readonly disposition: 'answer_here' }
  | { readonly disposition: 'clarify'; readonly assistantText: string }
  | {
      readonly disposition: 'delegate_existing';
      readonly candidateRef: string;
    }
  | { readonly disposition: 'create_new'; readonly title: string };

export interface WorkHubCoordinationCreateContext {
  /** Trusted desktop context. Model/strategy output never contains a workspace or identity. */
  readonly workspace: WorkspaceTarget;
}

export interface WorkHubCoordinationActInput {
  readonly actionId: string;
  readonly userText: string;
  readonly proposal: WorkHubCoordinationProposal;
  readonly candidateSetId?: string;
  readonly create?: WorkHubCoordinationCreateContext;
}

export type WorkHubCoordinationActResult =
  | { readonly disposition: 'answer_here'; readonly coordinationTurnId: string }
  | { readonly disposition: 'clarify'; readonly coordinationTurnId: string }
  | {
      readonly disposition: 'delegate_existing';
      readonly targetSessionId: string;
      readonly targetTurnId: string;
      readonly steered?: true;
    }
  | {
      readonly disposition: 'create_new';
      readonly targetSessionId: string;
      readonly targetTurnId: string;
      readonly steered?: true;
    };

export const WORKHUB_COORDINATION_OPERATION_SPECS = {
  'workhub.coordination.resolve': defineOperation<
    WorkHubCoordinationResolveInput,
    WorkHubCoordinationResolveResult,
    (typeof RESOLVE_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: RESOLVE_ERRORS,
    decodeInput: decodeWorkHubCoordinationResolveInput,
    decodeOutput: decodeWorkHubCoordinationResolveResult,
  }),
  'workhub.coordination.answer': defineOperation<
    WorkHubCoordinationAnswerInput,
    WorkHubCoordinationTurnResult,
    (typeof TURN_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: TURN_ERRORS,
    decodeInput: decodeWorkHubCoordinationAnswerInput,
    decodeOutput: decodeWorkHubCoordinationTurnResult,
  }),
  'workhub.coordination.record': defineOperation<
    WorkHubCoordinationRecordInput,
    WorkHubCoordinationTurnResult,
    (typeof TURN_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: TURN_ERRORS,
    decodeInput: decodeWorkHubCoordinationRecordInput,
    decodeOutput: decodeWorkHubCoordinationTurnResult,
  }),
  'workhub.coordination.candidates': defineOperation<
    WorkHubCoordinationCandidatesInput,
    WorkHubCoordinationCandidatesResult,
    (typeof CANDIDATE_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: CANDIDATE_ERRORS,
    decodeInput: decodeWorkHubCoordinationCandidatesInput,
    decodeOutput: decodeWorkHubCoordinationCandidatesResult,
  }),
  'workhub.coordination.act': defineOperation<
    WorkHubCoordinationActInput,
    WorkHubCoordinationActResult,
    (typeof TURN_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: TURN_ERRORS,
    decodeInput: decodeWorkHubCoordinationActInput,
    decodeOutput: decodeWorkHubCoordinationActResult,
  }),
} as const;

export function decodeWorkHubCoordinationResolveInput(
  value: unknown,
): WorkHubCoordinationResolveInput {
  requireExactRecord(value, 'WorkHub Coordination resolve input', []);
  return {};
}

export function decodeWorkHubCoordinationResolveResult(
  value: unknown,
): WorkHubCoordinationResolveResult {
  const result = requireExactRecord(value, 'WorkHub Coordination resolve result', ['sessionId']);
  return {
    sessionId: requireEntityId(result.sessionId, 'WorkHub Coordination Session id'),
  };
}

export function decodeWorkHubCoordinationAnswerInput(
  value: unknown,
): WorkHubCoordinationAnswerInput {
  const input = requireExactRecord(value, 'WorkHub Coordination answer input', ['turnId', 'text']);
  return {
    turnId: requireEntityId(input.turnId, 'WorkHub Coordination Turn id'),
    text: requireUtf8String(
      input.text,
      'WorkHub Coordination answer text',
      WORKHUB_COORDINATION_TEXT_MAX_BYTES,
    ),
  };
}

export function decodeWorkHubCoordinationRecordInput(
  value: unknown,
): WorkHubCoordinationRecordInput {
  const input = requireExactRecord(value, 'WorkHub Coordination record input', [
    'turnId',
    'userText',
    'assistantText',
  ]);
  return {
    turnId: requireEntityId(input.turnId, 'WorkHub Coordination Turn id'),
    userText: requireUtf8String(
      input.userText,
      'WorkHub Coordination user text',
      WORKHUB_COORDINATION_TEXT_MAX_BYTES,
    ),
    assistantText: requireUtf8String(
      input.assistantText,
      'WorkHub Coordination assistant text',
      WORKHUB_COORDINATION_SUMMARY_MAX_BYTES,
    ),
  };
}

export function decodeWorkHubCoordinationTurnResult(value: unknown): WorkHubCoordinationTurnResult {
  const result = requireExactRecord(value, 'WorkHub Coordination Turn result', ['turnId']);
  return {
    turnId: requireEntityId(result.turnId, 'WorkHub Coordination Turn id'),
  };
}

export function decodeWorkHubCoordinationCandidatesInput(
  value: unknown,
): WorkHubCoordinationCandidatesInput {
  requireExactRecord(value, 'WorkHub Coordination candidates input', []);
  return {};
}

export function decodeWorkHubCoordinationCandidatesResult(
  value: unknown,
): WorkHubCoordinationCandidatesResult {
  const result = requireExactRecord(value, 'WorkHub Coordination candidates result', [
    'candidateSetId',
    'candidates',
  ]);
  if (!Array.isArray(result.candidates)) {
    throw invalidProtocolFrame('Invalid WorkHub Coordination candidates');
  }
  if (result.candidates.length > WORKHUB_COORDINATION_CANDIDATE_MAX_ITEMS) {
    throw invalidProtocolFrame('Too many WorkHub Coordination candidates');
  }
  return {
    candidateSetId: candidateSetId(result.candidateSetId),
    candidates: result.candidates.map(decodeWorkHubCoordinationCandidate),
  };
}

export function decodeWorkHubCoordinationActInput(value: unknown): WorkHubCoordinationActInput {
  const input = requireShapedRecord(
    value,
    'WorkHub Coordination action input',
    ['actionId', 'userText', 'proposal'],
    ['candidateSetId', 'create'],
  );
  const proposal = decodeWorkHubCoordinationProposal(input.proposal);
  const base = {
    actionId: requireEntityId(input.actionId, 'WorkHub Coordination action id'),
    userText: requireUtf8String(
      input.userText,
      'WorkHub Coordination action text',
      WORKHUB_COORDINATION_TEXT_MAX_BYTES,
    ),
    proposal,
  };
  if (proposal.disposition === 'delegate_existing') {
    if (input.create !== undefined || input.candidateSetId === undefined) {
      throw invalidProtocolFrame('Invalid WorkHub delegation context');
    }
    return { ...base, candidateSetId: candidateSetId(input.candidateSetId) };
  }
  if (proposal.disposition === 'create_new') {
    if (input.candidateSetId !== undefined || input.create === undefined) {
      throw invalidProtocolFrame('Invalid WorkHub creation context');
    }
    return { ...base, create: decodeWorkHubCoordinationCreateContext(input.create) };
  }
  if (input.candidateSetId !== undefined || input.create !== undefined) {
    throw invalidProtocolFrame('Unexpected WorkHub action context');
  }
  return base;
}

export function decodeWorkHubCoordinationActResult(value: unknown): WorkHubCoordinationActResult {
  const result = requireRecord(value, 'WorkHub Coordination action result');
  if (result.disposition === 'answer_here' || result.disposition === 'clarify') {
    const exact = requireExactRecord(result, 'WorkHub Coordination local action result', [
      'disposition',
      'coordinationTurnId',
    ]);
    return {
      disposition: result.disposition,
      coordinationTurnId: requireEntityId(exact.coordinationTurnId, 'WorkHub Coordination Turn id'),
    };
  }
  if (result.disposition === 'delegate_existing' || result.disposition === 'create_new') {
    const exact = requireShapedRecord(
      result,
      'WorkHub Coordination execution action result',
      ['disposition', 'targetSessionId', 'targetTurnId'],
      ['steered'],
    );
    if (exact.steered !== undefined && exact.steered !== true) {
      throw invalidProtocolFrame('Invalid WorkHub Coordination steering result');
    }
    return {
      disposition: result.disposition,
      targetSessionId: requireEntityId(exact.targetSessionId, 'WorkHub target Session id'),
      targetTurnId: requireEntityId(exact.targetTurnId, 'WorkHub target Turn id'),
      ...(exact.steered === true ? { steered: true as const } : {}),
    };
  }
  throw invalidProtocolFrame('Invalid WorkHub Coordination action disposition');
}

function decodeWorkHubCoordinationCandidate(value: unknown): WorkHubCoordinationCandidate {
  const candidate = requireExactRecord(value, 'WorkHub Coordination candidate', [
    'candidateRef',
    'sessionId',
    'sessionName',
    'workspace',
    'state',
    'updatedAt',
  ]);
  return {
    candidateRef: requireEntityId(candidate.candidateRef, 'WorkHub candidate ref'),
    sessionId: requireEntityId(candidate.sessionId, 'WorkHub candidate Session id'),
    sessionName: requireUtf8String(candidate.sessionName, 'WorkHub candidate name', 512),
    workspace: decodeWorkspaceProjection(candidate.workspace),
    state: candidateState(candidate.state),
    updatedAt: requireCount(candidate.updatedAt, 'WorkHub candidate update time'),
  };
}

function decodeWorkHubCoordinationProposal(value: unknown): WorkHubCoordinationProposal {
  const proposal = requireRecord(value, 'WorkHub Coordination proposal');
  if (proposal.disposition === 'answer_here') {
    requireExactRecord(proposal, 'WorkHub answer proposal', ['disposition']);
    return { disposition: 'answer_here' };
  }
  if (proposal.disposition === 'clarify') {
    const exact = requireExactRecord(proposal, 'WorkHub clarification proposal', [
      'disposition',
      'assistantText',
    ]);
    return {
      disposition: 'clarify',
      assistantText: requireUtf8String(
        exact.assistantText,
        'WorkHub clarification text',
        WORKHUB_COORDINATION_SUMMARY_MAX_BYTES,
      ),
    };
  }
  if (proposal.disposition === 'delegate_existing') {
    const exact = requireExactRecord(proposal, 'WorkHub delegation proposal', [
      'disposition',
      'candidateRef',
    ]);
    return {
      disposition: 'delegate_existing',
      candidateRef: requireEntityId(exact.candidateRef, 'WorkHub candidate ref'),
    };
  }
  if (proposal.disposition === 'create_new') {
    const exact = requireExactRecord(proposal, 'WorkHub creation proposal', [
      'disposition',
      'title',
    ]);
    return {
      disposition: 'create_new',
      title: requireUtf8String(exact.title, 'WorkHub Session title', COORDINATION_TITLE_MAX_BYTES),
    };
  }
  throw invalidProtocolFrame('Invalid WorkHub Coordination proposal disposition');
}

function decodeWorkHubCoordinationCreateContext(value: unknown): WorkHubCoordinationCreateContext {
  const context = requireExactRecord(value, 'WorkHub creation context', ['workspace']);
  return {
    workspace: decodeWorkspaceTarget(context.workspace),
  };
}

function candidateSetId(value: unknown): string {
  const id = requireUtf8String(value, 'WorkHub candidate set id', CANDIDATE_SET_ID_MAX_BYTES);
  if (!/^sha256:[a-f0-9]{64}$/u.test(id)) {
    throw invalidProtocolFrame('Invalid WorkHub candidate set id');
  }
  return id;
}

function candidateState(value: unknown): WorkHubCoordinationCandidateState {
  if (
    value === 'active' ||
    value === 'running' ||
    value === 'waiting_for_user' ||
    value === 'blocked' ||
    value === 'aborted'
  ) {
    return value;
  }
  throw invalidProtocolFrame('Invalid WorkHub candidate state');
}
