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
  WorkHubDelegationCommittedMessage,
  WorkHubDelegationIntentMessage,
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
  answer(
    input: { readonly turnId: string; readonly text: string },
    context: ConnectionContext,
  ): Promise<void>;
  clarify(input: {
    readonly turnId: string;
    readonly userText: string;
    readonly assistantText: string;
  }): Promise<void>;
  create(input: {
    readonly sessionId: string;
    readonly workspace: WorkspaceTarget;
    readonly title: string;
  }): Promise<void>;
  submit(
    input: {
      readonly sessionId: string;
      readonly messageId: string;
      readonly text: string;
    },
    context: ConnectionContext,
  ): Promise<{ readonly turnId: string; readonly steered?: true }>;
  recoverSubmission(input: {
    readonly sessionId: string;
    readonly messageId: string;
    readonly text: string;
  }): Promise<{ readonly turnId: string; readonly steered?: true } | undefined>;
  readDelegation(actionId: string): Promise<WorkHubDelegationRecord | undefined>;
  prepareDelegation(intent: WorkHubDelegationIntent): Promise<void>;
  commitDelegation(commit: WorkHubDelegationCommit): Promise<void>;
}

type StoredDelegationEnvelopeKeys = 'type' | 'id' | 'turnId' | 'ts' | 'schemaVersion';

export type WorkHubDelegationIntent = Omit<
  WorkHubDelegationIntentMessage,
  StoredDelegationEnvelopeKeys
>;

export type WorkHubDelegationCommit = Omit<
  WorkHubDelegationCommittedMessage,
  StoredDelegationEnvelopeKeys
>;

export type WorkHubDelegationRecord = WorkHubDelegationIntent | WorkHubDelegationCommit;

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
  readonly fingerprint: string;
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
    const fingerprint = actionFingerprint(input);
    const replay = this.#actions.get(input.actionId);
    if (replay) {
      if (replay.fingerprint !== fingerprint) {
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
    const action = { fingerprint, result };
    this.#actions.set(input.actionId, action);
    // Successful actions remain a Host-lifetime fast path. Rejections leave the
    // in-memory slot so a pre-intent admission can retry; once an intent is
    // durable, the journal independently keeps that action identity owned.
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
    const durable = await this.#effects.readDelegation(input.actionId);
    if (durable) {
      if (durable.actionFingerprint !== fingerprint) {
        throw new WorkHubActionGateFailure(
          'action_conflict',
          'WorkHub action identity belongs to a different proposal',
        );
      }
      if (durable.kind === 'delegation_committed') {
        return committedResult(durable);
      }
      return this.#executeDelegation(durable, context);
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
      const intent = delegationIntent(input, fingerprint, sessionId);
      await this.#effects.prepareDelegation(intent);
      return this.#executeDelegation(intent, context);
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

    const intent = delegationIntent(input, fingerprint, target.sessionId);
    await this.#effects.prepareDelegation(intent);
    return this.#executeDelegation(intent, context);
  }

  async #executeDelegation(
    intent: WorkHubDelegationIntent,
    context: ConnectionContext,
  ): Promise<WorkHubCoordinationActResult> {
    if (intent.disposition === 'create_new') {
      if (!intent.create) {
        throw new WorkHubActionGateFailure(
          'action_conflict',
          'WorkHub durable creation intent is incomplete',
        );
      }
      await this.#effects.create({
        sessionId: intent.targetSessionId,
        workspace: intent.create.workspace,
        title: intent.create.title,
      });
    } else if (intent.create) {
      throw new WorkHubActionGateFailure(
        'action_conflict',
        'WorkHub durable delegation intent contains creation context',
      );
    }

    const message = {
      sessionId: intent.targetSessionId,
      messageId: actionMessageId(intent.actionId),
      text: intent.userText,
    };
    let submitted: { readonly turnId: string; readonly steered?: true };
    try {
      submitted = await this.#effects.submit(message, context);
    } catch (error) {
      if (
        !(error instanceof WorkHubActionEffectFailure) ||
        error.code !== 'commit_outcome_unknown'
      ) {
        throw error;
      }
      const recovered = await this.#effects.recoverSubmission(message);
      if (!recovered) throw error;
      submitted = recovered;
    }
    const commit: WorkHubDelegationCommit = {
      ...intent,
      kind: 'delegation_committed',
      delegationId: delegationId(intent.actionId),
      targetTurnId: submitted.turnId,
      ...(submitted.steered ? { steered: true as const } : {}),
    };
    await this.#effects.commitDelegation(commit);
    return committedResult(commit);
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

function actionMessageId(actionId: string): string {
  return `whm_${hash(actionId).slice(0, 48)}`;
}

function delegationId(actionId: string): string {
  return `whd_${hash(`delegation\0${actionId}`).slice(0, 48)}`;
}

function delegationIntent(
  input: WorkHubCoordinationActInput,
  actionFingerprint: `sha256:${string}`,
  targetSessionId: string,
): WorkHubDelegationIntent {
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
    kind: 'delegation_intent',
    actionId: input.actionId,
    actionFingerprint,
    coordinationTurnId: input.actionId,
    targetSessionId,
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

function committedResult(commit: WorkHubDelegationCommit): WorkHubCoordinationActResult {
  return {
    disposition: commit.disposition,
    targetSessionId: commit.targetSessionId,
    targetTurnId: commit.targetTurnId,
    ...(commit.steered ? { steered: true as const } : {}),
  } as WorkHubCoordinationActResult;
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${hash(JSON.stringify(value))}`;
}

function actionFingerprint(input: WorkHubCoordinationActInput): `sha256:${string}` {
  return digest({
    userText: input.userText,
    disposition: input.proposal.disposition,
    ...(input.proposal.disposition === 'clarify'
      ? { assistantText: input.proposal.assistantText }
      : {}),
  });
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
