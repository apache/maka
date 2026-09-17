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
  WORKHUB_COORDINATION_SESSION_ID,
  type WorkHubDelegationAssignedMessage,
} from '@maka/core/session';
import type { AutoReviewUserRequest } from '@maka/runtime/auto-review';
import type { RootTurnAdmission } from '@maka/storage/execution-stores';

/** Limit every durable lookup performed for one proposed action. */
export const AUTO_REVIEW_CONTEXT_MAX_USER_REQUESTS = 256;
export const AUTO_REVIEW_CONTEXT_MAX_WORKHUB_ASSIGNMENTS = 256;

const WORKHUB_TARGET_MESSAGE_PATTERN = /^whm_[a-f0-9]{48}$/u;

export class AutoReviewContextLimitError extends Error {
  readonly name = 'AutoReviewContextLimitError';
}

export interface AutoReviewSessionAuthorization {
  readonly kind: 'session_request';
  readonly request: AutoReviewUserRequest;
}

export interface AutoReviewWorkHubDelegationAuthorization {
  readonly kind: 'workhub_delegation';
  readonly delegationId: string;
  readonly request: AutoReviewUserRequest;
}

export interface AutoReviewWorkHubDelegation {
  readonly sourceSessionId: typeof WORKHUB_COORDINATION_SESSION_ID;
  readonly sourceTurnId: string;
  readonly targetSessionId: string;
  readonly targetTurnId: string;
  readonly targetMessageId: string;
  readonly delegationId: string;
  /** Durable delegated work. This is task context, never authorization by itself. */
  readonly task: string;
}

export type AutoReviewAuthorization =
  | AutoReviewSessionAuthorization
  | AutoReviewWorkHubDelegationAuthorization;

export interface AutoReviewContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly authorizations: readonly AutoReviewAuthorization[];
  readonly delegations: readonly AutoReviewWorkHubDelegation[];
}

export interface AutoReviewContextScope {
  readonly sessionId: string;
  readonly turnId: string;
  readonly userRequests: readonly AutoReviewUserRequest[];
}

export interface AutoReviewContextResolverDeps {
  readRootTurnAdmission(sessionId: string, turnId: string): Promise<RootTurnAdmission | undefined>;
  readActiveWorkHubAssignmentsByTarget(
    targetSessionIds: readonly string[],
    maxAssignmentsPerTarget: number,
  ): Promise<readonly WorkHubDelegationAssignedMessage[]>;
}

interface RequestGroup {
  readonly turnId: string;
  readonly messageId: string;
  readonly kind?: 'question_answer';
  readonly requests: AutoReviewUserRequest[];
}

interface WorkHubTargetGrant {
  readonly targetTurnId: string;
  readonly targetMessageId: string;
  readonly userRequests: readonly AutoReviewUserRequest[];
}

/**
 * Resolve only Host-authenticated requests from this Session. WorkHub task
 * context requires its exact durable source -> assignment -> target relation;
 * its human grants additionally require the related target copy to match.
 */
export async function resolveAutoReviewContext(
  scope: AutoReviewContextScope,
  deps: AutoReviewContextResolverDeps,
): Promise<AutoReviewContext> {
  const localRequests = scope.userRequests.filter(
    (request) => request.sessionId === scope.sessionId,
  );
  if (localRequests.length > AUTO_REVIEW_CONTEXT_MAX_USER_REQUESTS) {
    throw new AutoReviewContextLimitError(
      `Auto-review context exceeds ${AUTO_REVIEW_CONTEXT_MAX_USER_REQUESTS} authenticated requests`,
    );
  }
  const groups = groupRequests(localRequests);
  const admissionByTurn = await readAdmissions(scope.sessionId, groups, deps);
  const authorizations: AutoReviewAuthorization[] = [];
  const delegations: AutoReviewWorkHubDelegation[] = [];
  const workHubTargets: WorkHubTargetGrant[] = [];

  for (const group of groups) {
    if (group.kind === 'question_answer') {
      if (group.turnId !== scope.turnId) continue;
      authorizations.push(
        ...group.requests.map((request) => ({
          kind: 'session_request' as const,
          request,
        })),
      );
      continue;
    }

    const admission = admissionByTurn.get(group.turnId);
    if (admission && group.messageId === admittedPromptMessageId(admission)) {
      const proven = admissionUserRequests(admission);
      if (sameRequestTexts(group.requests, proven)) {
        appendProvenRequests(proven, admission.turnId, authorizations, workHubTargets);
      } else if (!admissionHasWorkHubTarget(admission)) {
        appendProvenRequests(group.requests, group.turnId, authorizations, workHubTargets);
      }
      continue;
    }

    appendProvenRequests(group.requests, group.turnId, authorizations, workHubTargets);
  }

  const assignments = await deps.readActiveWorkHubAssignmentsByTarget(
    [scope.sessionId],
    AUTO_REVIEW_CONTEXT_MAX_WORKHUB_ASSIGNMENTS,
  );
  if (assignments.length >= AUTO_REVIEW_CONTEXT_MAX_WORKHUB_ASSIGNMENTS) {
    throw new AutoReviewContextLimitError(
      `Auto-review context reached the ${AUTO_REVIEW_CONTEXT_MAX_WORKHUB_ASSIGNMENTS} WorkHub assignment limit`,
    );
  }
  const activeCurrentAssignments = assignments.filter(
    (assignment) =>
      assignment.targetSessionId === scope.sessionId && assignment.targetTurnId === scope.turnId,
  );
  const targetGrantByMessage = new Map(
    workHubTargets
      .filter(({ targetTurnId }) => targetTurnId === scope.turnId)
      .map((target) => [target.targetMessageId, target] as const),
  );
  const activeByTargetMessage = new Map(
    activeCurrentAssignments.map((assignment) => [assignment.targetMessageId, assignment] as const),
  );
  const seenAssignments = new Set<string>();
  const currentAssignments = [
    ...workHubTargets.flatMap(({ targetMessageId }) => {
      const assignment = activeByTargetMessage.get(targetMessageId);
      if (!assignment || seenAssignments.has(assignment.delegationId)) return [];
      seenAssignments.add(assignment.delegationId);
      return [assignment];
    }),
    ...activeCurrentAssignments.filter((assignment) => {
      if (seenAssignments.has(assignment.delegationId)) return false;
      seenAssignments.add(assignment.delegationId);
      return true;
    }),
  ];
  const sourceAdmissions = await readSourceAdmissions(currentAssignments, deps);

  for (const assignment of currentAssignments) {
    const sourceAdmission = sourceAdmissions.get(assignment.coordinationTurnId);
    const sourceRequests = sourceAdmission ? admissionUserRequests(sourceAdmission) : [];
    const targetGrant = targetGrantByMessage.get(assignment.targetMessageId);
    const userRequests =
      targetGrant && sameRequestTexts(targetGrant.userRequests, sourceRequests)
        ? sourceRequests
        : [];
    delegations.push(
      Object.freeze({
        sourceSessionId: WORKHUB_COORDINATION_SESSION_ID,
        sourceTurnId: assignment.coordinationTurnId,
        targetSessionId: assignment.targetSessionId,
        targetTurnId: assignment.targetTurnId,
        targetMessageId: assignment.targetMessageId,
        delegationId: assignment.delegationId,
        task: assignment.delegationText ?? assignment.userText,
      }),
    );
    authorizations.push(
      ...userRequests.map((request) => ({
        kind: 'workhub_delegation' as const,
        delegationId: assignment.delegationId,
        request,
      })),
    );
  }

  return Object.freeze({
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    authorizations,
    delegations,
  });
}

function groupRequests(requests: readonly AutoReviewUserRequest[]): RequestGroup[] {
  const groups = new Map<string, RequestGroup>();
  for (const request of requests) {
    const key = JSON.stringify([request.turnId, request.messageId, request.kind ?? null]);
    const group = groups.get(key);
    if (group) {
      group.requests.push(request);
      continue;
    }
    groups.set(key, {
      turnId: request.turnId,
      messageId: request.messageId,
      ...(request.kind ? { kind: request.kind } : {}),
      requests: [request],
    });
  }
  return [...groups.values()];
}

async function readAdmissions(
  sessionId: string,
  groups: readonly RequestGroup[],
  deps: AutoReviewContextResolverDeps,
): Promise<ReadonlyMap<string, RootTurnAdmission | undefined>> {
  const turns = [
    ...new Set(
      groups.filter((group) => group.kind !== 'question_answer').map(({ turnId }) => turnId),
    ),
  ];
  const admissions = await Promise.all(
    turns.map((turnId) => deps.readRootTurnAdmission(sessionId, turnId)),
  );
  return new Map(turns.map((turnId, index) => [turnId, admissions[index]]));
}

async function readSourceAdmissions(
  assignments: readonly WorkHubDelegationAssignedMessage[],
  deps: AutoReviewContextResolverDeps,
): Promise<ReadonlyMap<string, RootTurnAdmission | undefined>> {
  const turns = [...new Set(assignments.map(({ coordinationTurnId }) => coordinationTurnId))];
  const admissions = await Promise.all(
    turns.map((turnId) => deps.readRootTurnAdmission(WORKHUB_COORDINATION_SESSION_ID, turnId)),
  );
  return new Map(turns.map((turnId, index) => [turnId, admissions[index]]));
}

function admittedPromptMessageId(admission: RootTurnAdmission): string {
  return admission.userMessageId ?? `${admission.runId}-admitted-prompt`;
}

function admissionUserRequests(admission: RootTurnAdmission): AutoReviewUserRequest[] {
  const directMessageId = admittedPromptMessageId(admission);
  return [
    ...(admission.authenticatedUserRequests ?? []).map((text) => ({
      sessionId: admission.sessionId,
      turnId: admission.turnId,
      messageId: directMessageId,
      text,
    })),
    ...admission.sourceMessages.flatMap((source) =>
      (source.authenticatedUserRequests ?? []).map((text) => ({
        sessionId: admission.sessionId,
        turnId: admission.turnId,
        messageId: source.messageId,
        text,
      })),
    ),
  ];
}

function admissionHasWorkHubTarget(admission: RootTurnAdmission): boolean {
  return (
    WORKHUB_TARGET_MESSAGE_PATTERN.test(admittedPromptMessageId(admission)) ||
    admission.sourceMessages.some((source) => WORKHUB_TARGET_MESSAGE_PATTERN.test(source.messageId))
  );
}

function appendProvenRequests(
  requests: readonly AutoReviewUserRequest[],
  targetTurnId: string,
  authorizations: AutoReviewAuthorization[],
  workHubTargets: WorkHubTargetGrant[],
): void {
  const byMessage = new Map<string, AutoReviewUserRequest[]>();
  for (const request of requests) {
    if (!WORKHUB_TARGET_MESSAGE_PATTERN.test(request.messageId)) {
      authorizations.push({ kind: 'session_request', request });
      continue;
    }
    const existing = byMessage.get(request.messageId);
    if (existing) existing.push(request);
    else byMessage.set(request.messageId, [request]);
  }
  for (const [targetMessageId, userRequests] of byMessage) {
    workHubTargets.push({ targetTurnId, targetMessageId, userRequests });
  }
}

function sameRequestTexts(
  left: readonly AutoReviewUserRequest[],
  right: readonly AutoReviewUserRequest[],
): boolean {
  return (
    left.length === right.length &&
    left.every((request, index) => request.text === right[index]?.text)
  );
}
