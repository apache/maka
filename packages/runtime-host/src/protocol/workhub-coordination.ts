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

import type { AttachmentRef } from '@maka/core/events';
import { decodeMessageContent } from './turn.js';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  isWorkHubCreateDefaults,
  type WorkHubCreateDefaults,
} from '@maka/core/session';
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
import {
  decodeSessionConfigurationUpdateInput,
  decodeSessionUpdateResult,
  decodeSessionCatalogItem,
  SESSION_CATALOG_OPERATION_SPECS,
  type SessionModelTarget,
  type SessionUpdateResult,
  type SessionCatalogItem,
} from './session-catalog.js';

export interface WorkHubCoordinationConfigureModelInput {
  readonly expectedRevision: number;
  readonly modelTarget: Extract<SessionModelTarget, { readonly kind: 'explicit' }>;
}

export function decodeWorkHubCoordinationConfigureModelInput(
  value: unknown,
): WorkHubCoordinationConfigureModelInput {
  const input = requireExactRecord(value, 'WorkHub model configuration', [
    'expectedRevision',
    'modelTarget',
  ]);
  const decoded = decodeSessionConfigurationUpdateInput({
    sessionId: WORKHUB_COORDINATION_SESSION_ID,
    expectedRevision: input.expectedRevision,
    patch: { modelTarget: input.modelTarget },
  });
  return {
    expectedRevision: decoded.expectedRevision,
    modelTarget: decoded.patch.modelTarget!,
  };
}

export const WORKHUB_COORDINATION_TEXT_MAX_BYTES = 48 * 1024;
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
  readonly attachments?: AttachmentRef[];
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
  /** Latest durable linkage for compare-and-swap correction; never model-facing. */
  readonly latestDelegationActionId?: string;
}

export type WorkHubCoordinationCandidatesInput = Record<string, never>;

export interface WorkHubCoordinationCandidatesResult {
  readonly candidateSetId: string;
  readonly candidates: readonly WorkHubCoordinationCandidate[];
}

export type WorkHubCoordinationProposal =
  | {
      readonly disposition: 'delegate_existing';
      readonly candidateRef: string;
    }
  | { readonly disposition: 'create_new'; readonly title: string }
  | {
      readonly disposition: 'replace';
      /** Action identity of the exact durable delegation link being corrected. */
      readonly replacesActionId: string;
      readonly target:
        | { readonly disposition: 'delegate_existing'; readonly candidateRef: string }
        | { readonly disposition: 'create_new'; readonly title: string };
    }
  | {
      readonly disposition: 'stop_work';
      /**
       * The expected state the Action Policy resolved against. It carries no
       * authority of its own; the Action Gate revalidates it against current
       * durable facts, so a resolution that has gone stale fails closed instead
       * of stopping work the user never resolved.
       *
       * Which delegation the stop ends is not stated here. A client cannot
       * prove which link is live, so the Gate resolves it from its own active
       * links, and on replay from the durable claim this action already owns.
       */
      readonly expects: WorkHubCoordinationStopPreconditions;
    }
  | {
      readonly disposition: 'resume_work';
      /** Bound reference from candidate discovery; the Gate checks current ownership. */
      readonly resumesActionId: string;
      readonly expects: WorkHubCoordinationStopPreconditions;
    };

export interface WorkHubCoordinationStopPreconditions {
  /**
   * Session the resolved delegation was proposed against. Sole-active-delegation
   * is proved by the Host from durable state under the admission lease, so the
   * proposal states only what it resolved, never its own proof.
   */
  readonly targetSessionId: string;
}

export interface WorkHubCoordinationCreateContext {
  /** Trusted desktop context. Model/strategy output never contains a workspace or identity. */
  readonly workspace: WorkspaceTarget;
}

/** A model action can name its active Turn, never supply user-originated authority. */
export interface WorkHubCoordinationActFromTurnInput {
  readonly turnId: string;
  readonly actionId: string;
  readonly proposal: WorkHubCoordinationProposal;
  readonly candidateSetId?: string;
  readonly create?: WorkHubCoordinationCreateContext;
  readonly newWorkDefaults?: WorkHubCreateDefaults;
  /** Work content prepared by the coordination model for a delegated task. */
  readonly delegationText?: string;
}

export type WorkHubCoordinationActResult =
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
    }
  | {
      readonly disposition: 'replace';
      readonly replacementDisposition: 'delegate_existing' | 'create_new';
      readonly targetSessionId: string;
      readonly targetTurnId: string;
      readonly steered?: true;
    }
  | {
      readonly disposition: 'stop_work';
      readonly outcome: 'cancelled_pending' | 'stop_delivered' | 'already_terminal' | 'not_owned';
      readonly targetSessionId: string;
      readonly targetTurnId?: string;
    }
  | {
      readonly disposition: 'resume_work';
      readonly outcome: 'resume_started' | 'already_running';
      readonly targetSessionId: string;
      readonly targetTurnId?: string;
    };

export const WORKHUB_COORDINATION_OPERATION_SPECS = {
  'workhub.coordination.configureModel': defineOperation<
    WorkHubCoordinationConfigureModelInput,
    SessionUpdateResult,
    (typeof SESSION_CATALOG_OPERATION_SPECS)['session.configuration.update']['errors'][number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: SESSION_CATALOG_OPERATION_SPECS['session.configuration.update'].errors,
    decodeInput: decodeWorkHubCoordinationConfigureModelInput,
    decodeOutput: decodeSessionUpdateResult,
    assertOutputForInput: (input, output) =>
      SESSION_CATALOG_OPERATION_SPECS['session.configuration.update'].assertOutputForInput?.(
        {
          sessionId: WORKHUB_COORDINATION_SESSION_ID,
          expectedRevision: input.expectedRevision,
          patch: { modelTarget: input.modelTarget },
        },
        output,
      ),
  }),
  'workhub.coordination.query': defineOperation<
    Record<string, never>,
    SessionCatalogItem,
    (typeof RESOLVE_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: RESOLVE_ERRORS,
    decodeInput: decodeWorkHubCoordinationResolveInput,
    decodeOutput: decodeSessionCatalogItem,
  }),
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

  'workhub.coordination.actFromTurn': defineOperation<
    WorkHubCoordinationActFromTurnInput,
    WorkHubCoordinationActResult,
    (typeof TURN_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: TURN_ERRORS,
    decodeInput: decodeWorkHubCoordinationActFromTurnInput,
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
  const input = requireShapedRecord(
    value,
    'WorkHub Coordination answer input',
    ['turnId', 'text'],
    ['attachments'],
  );
  return {
    ...(input.attachments !== undefined
      ? {
          attachments: decodeMessageContent({ text: input.text, attachments: input.attachments })
            .attachments!,
        }
      : {}),
    turnId: requireEntityId(input.turnId, 'WorkHub Coordination Turn id'),
    text: requireUtf8String(
      input.text,
      'WorkHub Coordination answer text',
      WORKHUB_COORDINATION_TEXT_MAX_BYTES,
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

export function decodeWorkHubCoordinationActFromTurnInput(
  value: unknown,
): WorkHubCoordinationActFromTurnInput {
  const input = requireShapedRecord(
    value,
    'WorkHub active Turn action input',
    ['turnId', 'actionId', 'proposal'],
    ['candidateSetId', 'create', 'newWorkDefaults', 'delegationText'],
  );
  const fields = decodeWorkHubCoordinationActionFields(input);

  return {
    ...fields,
    proposal: fields.proposal,
    turnId: requireEntityId(input.turnId, 'WorkHub Coordination Turn id'),
  };
}

function decodeWorkHubCoordinationActionFields(
  input: Record<string, unknown>,
): Omit<WorkHubCoordinationActFromTurnInput, 'turnId'> {
  const proposal = decodeWorkHubCoordinationProposal(input.proposal);
  if (
    input.newWorkDefaults !== undefined &&
    (!isWorkHubCreateDefaults(input.newWorkDefaults) ||
      !(
        proposal.disposition === 'create_new' ||
        (proposal.disposition === 'replace' && proposal.target.disposition === 'create_new')
      ))
  ) {
    throw invalidProtocolFrame('Invalid WorkHub creation defaults');
  }
  const delegationText =
    input.delegationText === undefined
      ? undefined
      : requireUtf8String(
          input.delegationText,
          'WorkHub delegation text',
          WORKHUB_COORDINATION_TEXT_MAX_BYTES,
        );
  if (
    delegationText !== undefined &&
    (!delegationText.trim() ||
      (proposal.disposition !== 'delegate_existing' &&
        proposal.disposition !== 'create_new' &&
        proposal.disposition !== 'replace'))
  ) {
    throw invalidProtocolFrame('Invalid WorkHub delegation text');
  }
  const base = {
    actionId: requireEntityId(input.actionId, 'WorkHub Coordination action id'),
    proposal,
    ...(input.newWorkDefaults !== undefined
      ? { newWorkDefaults: input.newWorkDefaults as WorkHubCreateDefaults }
      : {}),
    ...(delegationText === undefined ? {} : { delegationText }),
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
  if (proposal.disposition === 'replace') {
    if (proposal.target.disposition === 'delegate_existing') {
      if (input.candidateSetId === undefined || input.create !== undefined) {
        throw invalidProtocolFrame('Invalid WorkHub replacement context');
      }
      return {
        ...base,
        candidateSetId: candidateSetId(input.candidateSetId),
      };
    }
    if (input.candidateSetId !== undefined || input.create === undefined) {
      throw invalidProtocolFrame('Invalid WorkHub replacement creation context');
    }
    return {
      ...base,
      create: decodeWorkHubCoordinationCreateContext(input.create),
    };
  }
  if (input.candidateSetId !== undefined || input.create !== undefined) {
    throw invalidProtocolFrame('Unexpected WorkHub action context');
  }
  return base;
}

export function decodeWorkHubCoordinationActResult(value: unknown): WorkHubCoordinationActResult {
  const result = requireRecord(value, 'WorkHub Coordination action result');

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
  if (result.disposition === 'replace') {
    const exact = requireShapedRecord(
      result,
      'WorkHub Coordination replacement result',
      ['disposition', 'replacementDisposition', 'targetSessionId', 'targetTurnId'],
      ['steered'],
    );
    if (
      exact.replacementDisposition !== 'delegate_existing' &&
      exact.replacementDisposition !== 'create_new'
    ) {
      throw invalidProtocolFrame('Invalid WorkHub replacement disposition');
    }
    if (exact.steered !== undefined && exact.steered !== true) {
      throw invalidProtocolFrame('Invalid WorkHub Coordination steering result');
    }
    return {
      disposition: 'replace',
      replacementDisposition: exact.replacementDisposition,
      targetSessionId: requireEntityId(exact.targetSessionId, 'WorkHub target Session id'),
      targetTurnId: requireEntityId(exact.targetTurnId, 'WorkHub target Turn id'),
      ...(exact.steered === true ? { steered: true as const } : {}),
    };
  }
  if (result.disposition === 'stop_work') {
    const exact = requireShapedRecord(
      result,
      'WorkHub Coordination stop result',
      ['disposition', 'outcome', 'targetSessionId'],
      ['targetTurnId'],
    );
    if (
      exact.outcome !== 'cancelled_pending' &&
      exact.outcome !== 'stop_delivered' &&
      exact.outcome !== 'already_terminal' &&
      exact.outcome !== 'not_owned'
    ) {
      throw invalidProtocolFrame('Invalid WorkHub stop outcome');
    }
    if (
      ((exact.outcome === 'stop_delivered' || exact.outcome === 'not_owned') &&
        exact.targetTurnId === undefined) ||
      (exact.outcome === 'cancelled_pending' && exact.targetTurnId !== undefined)
    ) {
      throw invalidProtocolFrame('Invalid WorkHub stop target Turn');
    }
    return {
      disposition: 'stop_work',
      outcome: exact.outcome,
      targetSessionId: requireEntityId(exact.targetSessionId, 'WorkHub target Session id'),
      ...(exact.targetTurnId === undefined
        ? {}
        : {
            targetTurnId: requireEntityId(exact.targetTurnId, 'WorkHub target Turn id'),
          }),
    };
  }
  if (result.disposition === 'resume_work') {
    const exact = requireShapedRecord(
      result,
      'WorkHub Coordination resume result',
      ['disposition', 'outcome', 'targetSessionId'],
      ['targetTurnId'],
    );
    if (exact.outcome !== 'resume_started' && exact.outcome !== 'already_running') {
      throw invalidProtocolFrame('Invalid WorkHub resume outcome');
    }
    // Only a started continuation names a Turn: the Host has one to name, and
    // the other two outcomes changed nothing that could carry an identity.
    if ((exact.outcome === 'resume_started') !== (exact.targetTurnId !== undefined)) {
      throw invalidProtocolFrame('Invalid WorkHub resume target Turn');
    }
    return {
      disposition: 'resume_work',
      outcome: exact.outcome,
      targetSessionId: requireEntityId(exact.targetSessionId, 'WorkHub target Session id'),
      ...(exact.targetTurnId === undefined
        ? {}
        : {
            targetTurnId: requireEntityId(exact.targetTurnId, 'WorkHub target Turn id'),
          }),
    };
  }
  throw invalidProtocolFrame('Invalid WorkHub Coordination action disposition');
}

function decodeWorkHubCoordinationCandidate(value: unknown): WorkHubCoordinationCandidate {
  const candidate = requireShapedRecord(
    value,
    'WorkHub Coordination candidate',
    ['candidateRef', 'sessionId', 'sessionName', 'workspace', 'state', 'updatedAt'],
    ['latestDelegationActionId'],
  );
  return {
    candidateRef: requireEntityId(candidate.candidateRef, 'WorkHub candidate ref'),
    sessionId: requireEntityId(candidate.sessionId, 'WorkHub candidate Session id'),
    sessionName: requireUtf8String(candidate.sessionName, 'WorkHub candidate name', 512),
    workspace: decodeWorkspaceProjection(candidate.workspace),
    state: candidateState(candidate.state),
    updatedAt: requireCount(candidate.updatedAt, 'WorkHub candidate update time'),
    ...(candidate.latestDelegationActionId === undefined
      ? {}
      : {
          latestDelegationActionId: requireEntityId(
            candidate.latestDelegationActionId,
            'WorkHub latest delegation action id',
          ),
        }),
  };
}

function decodeWorkHubCoordinationProposal(value: unknown): WorkHubCoordinationProposal {
  const proposal = requireRecord(value, 'WorkHub Coordination proposal');

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
  if (proposal.disposition === 'replace') {
    const exact = requireExactRecord(proposal, 'WorkHub replacement proposal', [
      'disposition',
      'replacesActionId',
      'target',
    ]);
    const target = requireRecord(exact.target, 'WorkHub replacement target');
    if (target.disposition === 'delegate_existing') {
      const targetExact = requireExactRecord(target, 'WorkHub replacement delegation target', [
        'disposition',
        'candidateRef',
      ]);
      return {
        disposition: 'replace',
        replacesActionId: requireEntityId(exact.replacesActionId, 'WorkHub replaced action id'),
        target: {
          disposition: 'delegate_existing',
          candidateRef: requireEntityId(targetExact.candidateRef, 'WorkHub candidate ref'),
        },
      };
    }
    if (target.disposition === 'create_new') {
      const targetExact = requireExactRecord(target, 'WorkHub replacement creation target', [
        'disposition',
        'title',
      ]);
      return {
        disposition: 'replace',
        replacesActionId: requireEntityId(exact.replacesActionId, 'WorkHub replaced action id'),
        target: {
          disposition: 'create_new',
          title: requireUtf8String(
            targetExact.title,
            'WorkHub Session title',
            COORDINATION_TITLE_MAX_BYTES,
          ),
        },
      };
    }
    throw invalidProtocolFrame('Invalid WorkHub replacement target');
  }
  if (proposal.disposition === 'stop_work') {
    const exact = requireExactRecord(proposal, 'WorkHub stop proposal', ['disposition', 'expects']);
    return {
      disposition: 'stop_work',
      expects: decodeWorkHubCoordinationStopPreconditions(exact.expects),
    };
  }
  if (proposal.disposition === 'resume_work') {
    const exact = requireExactRecord(proposal, 'WorkHub resume proposal', [
      'disposition',
      'expects',
      'resumesActionId',
    ]);
    return {
      disposition: 'resume_work',
      resumesActionId: requireEntityId(exact.resumesActionId, 'WorkHub resume assignment'),
      expects: decodeWorkHubCoordinationStopPreconditions(exact.expects),
    };
  }
  throw invalidProtocolFrame('Invalid WorkHub Coordination proposal disposition');
}

function decodeWorkHubCoordinationStopPreconditions(
  value: unknown,
): WorkHubCoordinationStopPreconditions {
  const expects = requireExactRecord(value, 'WorkHub stop preconditions', ['targetSessionId']);
  return {
    targetSessionId: requireEntityId(expects.targetSessionId, 'WorkHub target Session id'),
  };
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
