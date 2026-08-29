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

import { createHash } from 'node:crypto';
import type {
  SessionHeader,
  SessionStatus,
  WorkHubDelegationAssignedMessage,
  WorkHubDelegationCreateSpec,
  WorkHubDelegationDisposition,
  WorkHubDelegationReplacementRequestedMessage,
  WorkHubDelegationSupersededMessage,
} from '@maka/core/session';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  isWorkHubCoordinationSessionTarget,
} from '@maka/core/session';
import type {
  WorkHubCoordinationActInput,
  WorkHubCoordinationActResult,
  WorkHubCoordinationCandidate,
  WorkHubCoordinationCandidatesResult,
  WorkspaceTarget,
  WorkspaceProjection,
} from '../protocol/index.js';
import { WORKHUB_COORDINATION_CANDIDATE_MAX_ITEMS } from '../protocol/index.js';
import type { ConnectionContext } from './operation-dispatcher.js';

const SIDE_CONVERSATION_LABEL = 'mode:side_conversation';
const ACTION_REPLAY_MAX_ITEMS = 256;

export type WorkHubActionGateSession = Pick<
  SessionHeader,
  | 'id'
  | 'role'
  | 'cwd'
  | 'projectId'
  | 'createdAt'
  | 'lastMessageAt'
  | 'name'
  | 'labels'
  | 'isArchived'
  | 'status'
  | 'statusUpdatedAt'
  | 'subagentParent'
>;

export interface WorkHubActionGateEffects {
  listSessions(): Promise<readonly WorkHubActionGateSession[]>;
  readAssignment(actionId: string): Promise<WorkHubDelegationAssignedMessage | undefined>;
  readReplacement(
    delegationId: string,
  ): Promise<WorkHubDelegationReplacementRequestedMessage | undefined>;
  readSupersession(delegationId: string): Promise<WorkHubDelegationSupersededMessage | undefined>;
  answer(
    input: { readonly turnId: string; readonly text: string },
    context: ConnectionContext,
  ): Promise<void>;
  clarify(input: {
    readonly turnId: string;
    readonly userText: string;
    readonly assistantText: string;
  }): Promise<void>;
  assign(
    input: WorkHubDelegationAssignmentInput,
    context: ConnectionContext,
  ): Promise<{ readonly turnId: string; readonly steered?: true }>;
  prepareReplacement(
    input: WorkHubDelegationReplacementInput,
  ): Promise<WorkHubDelegationReplacementRequestedMessage>;
  retireDelegation(assignment: WorkHubDelegationAssignedMessage): Promise<void>;
}

export interface WorkHubDelegationAssignmentInput {
  readonly actionId: string;
  readonly actionFingerprint: `sha256:${string}`;
  readonly targetSessionId: string;
  readonly targetSessionName: string;
  readonly disposition: WorkHubDelegationDisposition;
  readonly userText: string;
  readonly create?: WorkHubDelegationCreateSpec;
  readonly replacesActionId?: string;
  readonly replacesDelegationId?: string;
}

export interface WorkHubDelegationReplacementInput extends WorkHubDelegationAssignmentInput {
  readonly replacesActionId: string;
  readonly replacesDelegationId: string;
  readonly replacedTargetSessionId: string;
  readonly replacedTargetMessageId: string;
}

export type WorkHubActionEffectFailureCode =
  | 'host_not_ready'
  | 'host_draining'
  | 'operation_unavailable'
  | 'not_found'
  | 'session_archived'
  | 'session_busy'
  | 'operation_conflict'
  | 'persistence_failed'
  | 'commit_outcome_unknown'
  | 'internal_failure'
  | 'unauthorized';

export class WorkHubActionEffectFailure extends Error {
  constructor(
    readonly code: WorkHubActionEffectFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkHubActionEffectFailure';
  }
}

export type WorkHubActionGateFailureCode =
  | 'candidate_set_stale'
  | 'candidate_unavailable'
  | 'target_waiting_for_user'
  | 'self_route'
  | 'action_conflict';

export class WorkHubActionGateFailure extends Error {
  constructor(
    readonly code: WorkHubActionGateFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkHubActionGateFailure';
  }
}

interface ActionReplay {
  readonly requestFingerprint: string;
  readonly result: Promise<WorkHubCoordinationActResult>;
}

/**
 * The sole admission module between a WorkHub strategy proposal and Session effects.
 *
 * Candidate discovery and fresh-state validation deliberately live behind the
 * same interface as execution. A caller cannot turn a model-selected Session id
 * into a write because proposals carry only an opaque candidateRef.
 */
export class WorkHubCoordinationActionGate {
  readonly #effects: WorkHubActionGateEffects;
  readonly #actions = new Map<string, ActionReplay>();

  constructor(effects: WorkHubActionGateEffects) {
    this.#effects = effects;
  }

  async candidates(): Promise<WorkHubCoordinationCandidatesResult> {
    return candidateSet(await this.#effects.listSessions());
  }

  act(
    input: WorkHubCoordinationActInput,
    context: ConnectionContext,
  ): Promise<WorkHubCoordinationActResult> {
    if (!input.userText.trim()) {
      return Promise.reject(
        new WorkHubActionGateFailure('action_conflict', 'WorkHub action text is empty'),
      );
    }
    if (input.proposal.disposition === 'create_new' && !input.proposal.title.trim()) {
      return Promise.reject(
        new WorkHubActionGateFailure('action_conflict', 'WorkHub creation title is empty'),
      );
    }
    const fingerprint = actionFingerprint(input);
    const requestFingerprint = digest(input);
    const replay = this.#actions.get(input.actionId);
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        return Promise.reject(
          new WorkHubActionGateFailure(
            'action_conflict',
            'WorkHub action identity belongs to a different proposal',
          ),
        );
      }
      return replay.result;
    }

    const result = this.#act(input, fingerprint, context);
    const action = { requestFingerprint, result };
    this.#actions.set(input.actionId, action);
    // Successful actions remain a Host-lifetime fast path. Rejections release
    // the slot so a pre-assignment admission can retry; once assigned, SQLite
    // independently owns the durable action identity.
    void result.catch(() => {
      if (this.#actions.get(input.actionId) === action) {
        this.#actions.delete(input.actionId);
      }
    });
    this.#boundReplays();
    return result;
  }

  async #act(
    input: WorkHubCoordinationActInput,
    fingerprint: `sha256:${string}`,
    context: ConnectionContext,
  ): Promise<WorkHubCoordinationActResult> {
    const proposal = input.proposal;
    const durable = await this.#effects.readAssignment(input.actionId);
    if (durable) {
      if (durable.actionFingerprint !== fingerprint) {
        throw new WorkHubActionGateFailure(
          'action_conflict',
          'WorkHub action identity belongs to a different proposal',
        );
      }
      return this.#assign(assignmentInputFromRecord(durable), context);
    }
    if (proposal.disposition === 'answer_here') {
      const turnId = coordinationTurnId(input.actionId, 'answer');
      await this.#effects.answer({ turnId, text: input.userText }, context);
      return { disposition: 'answer_here', coordinationTurnId: turnId };
    }
    if (proposal.disposition === 'clarify') {
      const turnId = coordinationTurnId(input.actionId, 'clarify');
      await this.#effects.clarify({
        turnId,
        userText: input.userText,
        assistantText: proposal.assistantText,
      });
      return { disposition: 'clarify', coordinationTurnId: turnId };
    }
    if (proposal.disposition === 'create_new') {
      if (!input.create) {
        throw new WorkHubActionGateFailure(
          'action_conflict',
          'WorkHub creation context is unavailable',
        );
      }
      const sessionId = workHubCreatedSessionId(input.actionId);
      return this.#assign(
        delegationAssignment(input, fingerprint, sessionId, proposal.title),
        context,
      );
    }

    if (proposal.disposition === 'replace') {
      if (
        input.confirmation?.kind !== 'user_correction' ||
        !isExplicitWorkHubCorrectionText(input.userText)
      ) {
        throw new WorkHubActionGateFailure(
          'action_conflict',
          'WorkHub replacement requires explicit correction in trusted user text',
        );
      }
      const replaced = await this.#effects.readAssignment(proposal.replacesActionId);
      if (!replaced) {
        throw new WorkHubActionGateFailure(
          'action_conflict',
          'WorkHub can replace only a durable delegation it owns',
        );
      }
      if (await this.#effects.readSupersession(replaced.delegationId)) {
        throw new WorkHubActionGateFailure(
          'action_conflict',
          'WorkHub delegation has already been superseded',
        );
      }
      const prepared = await this.#effects.readReplacement(replaced.delegationId);
      if (prepared) {
        if (prepared.actionId !== input.actionId || prepared.actionFingerprint !== fingerprint) {
          throw new WorkHubActionGateFailure(
            'action_conflict',
            'WorkHub delegation already has a different replacement intent',
          );
        }
        return this.#replace(prepared, context);
      }
      const replacement = await this.#replacementAssignment(input, fingerprint, replaced);
      const intent = await this.#effects.prepareReplacement(replacement);
      return this.#replace(intent, context);
    }

    const candidates = await this.candidates();
    if (candidates.candidateSetId !== input.candidateSetId) {
      throw new WorkHubActionGateFailure(
        'candidate_set_stale',
        'WorkHub Session candidates changed; refresh before delegating',
      );
    }
    const target = candidates.candidates.find(
      (candidate) => candidate.candidateRef === proposal.candidateRef,
    );
    if (!target) {
      throw new WorkHubActionGateFailure(
        'candidate_unavailable',
        'WorkHub target is not in the admitted candidate set',
      );
    }
    this.#assertTarget(target);

    return this.#assign(
      delegationAssignment(input, fingerprint, target.sessionId, target.sessionName),
      context,
    );
  }

  async #replacementAssignment(
    input: WorkHubCoordinationActInput,
    fingerprint: `sha256:${string}`,
    replaced: WorkHubDelegationAssignedMessage,
  ): Promise<WorkHubDelegationReplacementInput> {
    if (input.proposal.disposition !== 'replace') {
      throw new WorkHubActionGateFailure('action_conflict', 'Invalid WorkHub replacement');
    }
    const target = input.proposal.target;
    if (target.disposition === 'create_new') {
      if (!input.create) {
        throw new WorkHubActionGateFailure(
          'action_conflict',
          'WorkHub replacement creation context is unavailable',
        );
      }
      const targetSessionId = workHubCreatedSessionId(input.actionId);
      return {
        actionId: input.actionId,
        actionFingerprint: fingerprint,
        targetSessionId,
        targetSessionName: target.title,
        disposition: 'create_new',
        userText: input.userText,
        create: { title: target.title, workspace: input.create.workspace },
        replacesActionId: replaced.actionId,
        replacesDelegationId: replaced.delegationId,
        replacedTargetSessionId: replaced.targetSessionId,
        replacedTargetMessageId: replaced.targetMessageId,
      };
    }
    const candidates = await this.candidates();
    if (candidates.candidateSetId !== input.candidateSetId) {
      throw new WorkHubActionGateFailure(
        'candidate_set_stale',
        'WorkHub Session candidates changed; refresh before replacing',
      );
    }
    const destination = candidates.candidates.find(
      (candidate) => candidate.candidateRef === target.candidateRef,
    );
    if (!destination) {
      throw new WorkHubActionGateFailure(
        'candidate_unavailable',
        'WorkHub replacement target is not in the admitted candidate set',
      );
    }
    this.#assertTarget(destination);
    if (destination.sessionId === replaced.targetSessionId) {
      throw new WorkHubActionGateFailure(
        'action_conflict',
        'WorkHub replacement must choose a different Session',
      );
    }
    return {
      actionId: input.actionId,
      actionFingerprint: fingerprint,
      targetSessionId: destination.sessionId,
      targetSessionName: destination.sessionName,
      disposition: 'delegate_existing',
      userText: input.userText,
      replacesActionId: replaced.actionId,
      replacesDelegationId: replaced.delegationId,
      replacedTargetSessionId: replaced.targetSessionId,
      replacedTargetMessageId: replaced.targetMessageId,
    };
  }

  async #replace(
    replacement: WorkHubDelegationReplacementRequestedMessage,
    context: ConnectionContext,
  ): Promise<WorkHubCoordinationActResult> {
    const superseded = await this.#effects.readSupersession(replacement.replacesDelegationId);
    if (superseded) {
      throw new WorkHubActionGateFailure(
        'action_conflict',
        'WorkHub delegation has already been superseded',
      );
    }
    const source = await this.#effects.readAssignment(replacement.replacesActionId);
    if (
      !source ||
      source.delegationId !== replacement.replacesDelegationId ||
      source.targetSessionId !== replacement.replacedTargetSessionId ||
      source.targetMessageId !== replacement.replacedTargetMessageId
    ) {
      throw new WorkHubActionGateFailure(
        'action_conflict',
        'WorkHub replacement source identity changed',
      );
    }
    if (replacement.disposition === 'delegate_existing') {
      const target = (await this.#effects.listSessions()).find(
        (session) => session.id === replacement.targetSessionId,
      );
      if (!target || !isCandidateSession(target)) {
        throw new WorkHubActionGateFailure(
          'candidate_unavailable',
          'WorkHub replacement target is unavailable',
        );
      }
      this.#assertTarget({
        candidateRef: 'prepared',
        sessionId: target.id,
        sessionName: target.name,
        workspace: workspaceProjection(target),
        state: candidateState(target.status),
        updatedAt: updatedAt(target),
      });
    }
    await this.#effects.retireDelegation(source);
    return this.#assign(assignmentInputFromReplacement(replacement), context);
  }

  async #assign(
    assignment: WorkHubDelegationAssignmentInput,
    context: ConnectionContext,
  ): Promise<WorkHubCoordinationActResult> {
    const admitted = await this.#effects.assign(assignment, context);
    if (assignment.replacesDelegationId) {
      return {
        disposition: 'replace',
        replacementDisposition: assignment.disposition,
        targetSessionId: assignment.targetSessionId,
        targetTurnId: admitted.turnId,
        ...(admitted.steered ? { steered: true as const } : {}),
      };
    }
    return {
      disposition: assignment.disposition,
      targetSessionId: assignment.targetSessionId,
      targetTurnId: admitted.turnId,
      ...(admitted.steered ? { steered: true as const } : {}),
    } as WorkHubCoordinationActResult;
  }

  #assertTarget(target: WorkHubCoordinationCandidate): void {
    if (target.sessionId === WORKHUB_COORDINATION_SESSION_ID) {
      throw new WorkHubActionGateFailure('self_route', 'WorkHub cannot delegate to itself');
    }
    if (target.state === 'waiting_for_user') {
      throw new WorkHubActionGateFailure(
        'target_waiting_for_user',
        'Target Session is waiting for user input',
      );
    }
  }

  #boundReplays(): void {
    while (this.#actions.size > ACTION_REPLAY_MAX_ITEMS) {
      const oldest = this.#actions.keys().next().value;
      if (oldest === undefined) return;
      this.#actions.delete(oldest);
    }
  }
}

export function candidateSet(
  sessions: readonly WorkHubActionGateSession[],
): WorkHubCoordinationCandidatesResult {
  const eligible = sessions
    .filter(isCandidateSession)
    .sort((left, right) => updatedAt(right) - updatedAt(left) || left.id.localeCompare(right.id))
    .slice(0, WORKHUB_COORDINATION_CANDIDATE_MAX_ITEMS);
  const candidateSetId = digest(
    eligible.map((session) => ({
      id: session.id,
      name: session.name,
      workspace: workspaceProjection(session),
      status: session.status,
      updatedAt: updatedAt(session),
    })),
  );
  return {
    candidateSetId,
    candidates: eligible.map((session) => ({
      candidateRef: candidateRef(candidateSetId, session.id),
      sessionId: session.id,
      sessionName: session.name,
      workspace: workspaceProjection(session),
      state: candidateState(session.status),
      updatedAt: updatedAt(session),
    })),
  };
}

function isCandidateSession(session: WorkHubActionGateSession): boolean {
  return (
    !session.isArchived &&
    !isWorkHubCoordinationSessionTarget(session) &&
    session.role === undefined &&
    session.subagentParent === undefined &&
    !session.labels.includes(SIDE_CONVERSATION_LABEL)
  );
}

function candidateRef(candidateSetId: string, sessionId: string): string {
  return `whc_${hash(`${candidateSetId}\0${sessionId}`).slice(0, 48)}`;
}

function coordinationTurnId(actionId: string, kind: 'answer' | 'clarify'): string {
  return `wha_${hash(`${actionId}\0${kind}`).slice(0, 48)}`;
}

function delegationAssignment(
  input: WorkHubCoordinationActInput,
  actionFingerprint: `sha256:${string}`,
  targetSessionId: string,
  targetSessionName: string,
): WorkHubDelegationAssignmentInput {
  const create = input.create;
  if (
    input.proposal.disposition !== 'delegate_existing' &&
    input.proposal.disposition !== 'create_new'
  ) {
    throw new WorkHubActionGateFailure(
      'action_conflict',
      'WorkHub local action cannot create a delegation intent',
    );
  }
  const base = {
    actionId: input.actionId,
    actionFingerprint,
    targetSessionId,
    targetSessionName,
    disposition: input.proposal.disposition,
    userText: input.userText,
  } as const;
  if (input.proposal.disposition === 'delegate_existing') return base;
  if (!create) {
    throw new WorkHubActionGateFailure(
      'action_conflict',
      'WorkHub creation context is unavailable',
    );
  }
  return {
    ...base,
    create: {
      title: input.proposal.title,
      workspace: create.workspace,
    },
  };
}

function workHubCreatedSessionId(actionId: string): string {
  return `whs_${hash(`create\0${actionId}`).slice(0, 48)}`;
}

function workspaceProjection(session: WorkHubActionGateSession): WorkspaceProjection {
  return {
    target:
      typeof session.projectId === 'string'
        ? { kind: 'project', projectId: session.projectId }
        : { kind: 'host_path', path: session.cwd },
    hostCwd: session.cwd,
  };
}

function candidateState(status: SessionStatus): WorkHubCoordinationCandidate['state'] {
  return status;
}

function updatedAt(session: WorkHubActionGateSession): number {
  return session.lastMessageAt ?? session.statusUpdatedAt ?? session.createdAt;
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${hash(JSON.stringify(value))}`;
}

function actionFingerprint(input: WorkHubCoordinationActInput): `sha256:${string}` {
  return digest({
    userText: input.userText,
    disposition: input.proposal.disposition,
    ...(input.proposal.disposition === 'create_new'
      ? {
          title: input.proposal.title,
          workspace: input.create?.workspace,
        }
      : {}),
    ...(input.proposal.disposition === 'clarify'
      ? { assistantText: input.proposal.assistantText }
      : {}),
    ...(input.proposal.disposition === 'replace'
      ? {
          replacesActionId: input.proposal.replacesActionId,
          target: input.proposal.target,
          ...(input.proposal.target.disposition === 'create_new'
            ? { workspace: input.create?.workspace }
            : {}),
        }
      : {}),
  });
}

function assignmentInputFromRecord(
  assignment: WorkHubDelegationAssignedMessage,
): WorkHubDelegationAssignmentInput {
  return {
    actionId: assignment.actionId,
    actionFingerprint: assignment.actionFingerprint,
    targetSessionId: assignment.targetSessionId,
    targetSessionName: assignment.targetSessionName,
    disposition: assignment.disposition,
    userText: assignment.userText,
    ...(assignment.create ? { create: assignment.create } : {}),
    ...(assignment.replacesActionId && assignment.replacesDelegationId
      ? {
          replacesActionId: assignment.replacesActionId,
          replacesDelegationId: assignment.replacesDelegationId,
        }
      : {}),
  };
}

function assignmentInputFromReplacement(
  replacement: WorkHubDelegationReplacementRequestedMessage,
): WorkHubDelegationAssignmentInput {
  return {
    actionId: replacement.actionId,
    actionFingerprint: replacement.actionFingerprint,
    targetSessionId: replacement.targetSessionId,
    targetSessionName: replacement.targetSessionName,
    disposition: replacement.disposition,
    userText: replacement.userText,
    ...(replacement.create ? { create: replacement.create } : {}),
    replacesActionId: replacement.replacesActionId,
    replacesDelegationId: replacement.replacesDelegationId,
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Destructive replacement needs evidence in the user-originated text itself;
 * a strategy-provided replacement proposal and confirmation marker are not
 * sufficient authority. Keep this deliberately narrower than route inference.
 */
export function isExplicitWorkHubCorrectionText(value: string): boolean {
  return (
    /(?:^|[，,。；;\s])(?:不是|不要再继续)\s*(?:这个|那个|当前这个|刚才那个)(?:工作|任务|Session|会话)?/iu.test(
      value,
    ) ||
    /(?:^|[，,。；;\s])(?:这个|那个|当前这个|刚才那个)(?:工作|任务|Session|会话)?\s*(?:不对|搞错了|弄错了)/iu.test(
      value,
    ) ||
    /^\s*(?:不对|错了|搞错了|弄错了)[\s\p{P}\p{S}]+(?:(?:请|麻烦|帮我)\s*)?(?:应该|而是|改成|改为|换成|换到|切到|转到|用|创建|新建|新开|开一个)/iu.test(
      value,
    ) ||
    /^\s*(?:no|nope)\b[^.\n]{0,40}\b(?:use|switch|change|move|send|create|start|open)\b/iu.test(
      value,
    ) ||
    /\b(?:not\s+(?:this|that|the\s+current)(?:\s+(?:one|session|work|task))?|wrong\s+(?:one|session|work|task))\b/iu.test(
      value,
    )
  );
}
