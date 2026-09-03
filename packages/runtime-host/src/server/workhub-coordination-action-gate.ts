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
  WorkHubActionClaim,
  WorkHubActionClaimOutcome,
  WorkHubActionOperation,
  WorkHubDelegationAssignedMessage,
  WorkHubDelegationCreateSpec,
  WorkHubDelegationDisposition,
  WorkHubDelegationReplacementAbortedMessage,
  WorkHubDelegationReplacementRequestedMessage,
  WorkHubDelegationStopRequestedMessage,
  WorkHubDelegationStopResolvedMessage,
  WorkHubDelegationStopOutcome,
  WorkHubDelegationSupersededMessage,
} from '@maka/core/session';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  isWorkHubCoordinationSessionTarget,
} from '@maka/core/session';
import {
  readWorkHubRequestIntent,
  workHubCorrectionTargetsSession,
  workHubCreationAuthorizesTitle,
} from '@maka/core/workhub-creation-intent';
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
  /**
   * Durably binds this action identity to one exact operation before any
   * effect. Every other WorkHub record is keyed by the delegation or the
   * assignment it describes, so this is the only owner that can reject an
   * action id reused across delegations or across dispositions.
   */
  claimAction(claim: WorkHubActionClaim): Promise<WorkHubActionClaimOutcome>;
  /**
   * The operation this action identity already owns, if any.
   *
   * A stop names its target Session, not the delegation to end — the Host
   * resolves that from its own active links. Resolving again on replay would
   * fail, because a resolved stop takes its delegation out of the active set:
   * the second attempt would find nothing where the first found one. The claim
   * is the durable key that survives that, and it outlives removal of the
   * target Session, so a committed destructive claim still converges.
   */
  readActionClaim(actionId: string): Promise<WorkHubActionClaim | undefined>;
  /**
   * Durable lifetime proof for a delegation target that is no longer readable.
   * `removed` is a tombstone; `absent` is an identity that never existed here.
   */
  probeTargetRemoval(sessionId: string): Promise<'present' | 'removed' | 'absent'>;
  readAssignment(actionId: string): Promise<WorkHubDelegationAssignedMessage | undefined>;
  listActiveAssignments(): Promise<readonly WorkHubDelegationAssignedMessage[]>;
  readReplacement(
    delegationId: string,
  ): Promise<WorkHubDelegationReplacementRequestedMessage | undefined>;
  readReplacementAbort(
    delegationId: string,
  ): Promise<WorkHubDelegationReplacementAbortedMessage | undefined>;
  readSupersession(delegationId: string): Promise<WorkHubDelegationSupersededMessage | undefined>;
  readStopRequest(delegationId: string): Promise<WorkHubDelegationStopRequestedMessage | undefined>;
  readStopResolution(
    delegationId: string,
  ): Promise<WorkHubDelegationStopResolvedMessage | undefined>;
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
  abortReplacement(
    input: WorkHubDelegationReplacementAbortInput,
  ): Promise<WorkHubDelegationReplacementAbortedMessage>;
  prepareStop(input: WorkHubDelegationStopInput): Promise<WorkHubDelegationStopRequestedMessage>;
  resolveStop(
    input: WorkHubDelegationStopResolutionInput,
  ): Promise<WorkHubDelegationStopResolvedMessage>;
  readDelegationRetirement(
    assignment: WorkHubDelegationAssignedMessage,
  ): Promise<'not_retired' | 'retired' | 'recovering'>;
  retireDelegation(
    assignment: WorkHubDelegationAssignedMessage,
    retirement: WorkHubDelegationRetirementClaim,
  ): Promise<WorkHubRetirementResult>;
}

/**
 * Cancellation claim identity and retirement cause are separate concerns.
 *
 * Both a direct stop and a route correction retire a delegation and both need a
 * crash-safe pending-cancellation claim, but only a confirmed direct stop may
 * record direct-stop provenance on the target Turn.
 */
export interface WorkHubDelegationRetirementClaim {
  readonly cancellationClaimId: string;
  readonly cause: 'direct_stop' | 'replacement';
}

export interface WorkHubRetirementResult {
  readonly outcome: WorkHubDelegationStopOutcome | 'recovering';
  readonly targetTurnId?: string;
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

export interface WorkHubDelegationReplacementAbortInput {
  readonly replacement: WorkHubDelegationReplacementRequestedMessage;
  readonly reason: WorkHubDelegationReplacementAbortedMessage['reason'];
}

export interface WorkHubDelegationStopInput {
  readonly actionId: string;
  readonly actionFingerprint: `sha256:${string}`;
  readonly stopsActionId: string;
  readonly stopsDelegationId: string;
  readonly targetSessionId: string;
  readonly targetMessageId: string;
  readonly targetSessionName: string;
  readonly userText: string;
}

export interface WorkHubDelegationStopResolutionInput {
  readonly request: WorkHubDelegationStopRequestedMessage;
  readonly outcome: WorkHubDelegationStopOutcome;
  readonly targetTurnId?: string;
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
    // the slot so a pre-assignment admission can retry; the durable action
    // claim, not this map, is what owns the identity across that retry and
    // across restarts.
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
    const requestIntent = readWorkHubRequestIntent(input.userText);
    if (
      requestIntent.execution === 'ambiguous' &&
      proposal.disposition !== 'answer_here' &&
      proposal.disposition !== 'clarify'
    ) {
      throw new WorkHubActionGateFailure(
        'action_conflict',
        'WorkHub cannot write from an ambiguous instruction',
      );
    }
    const durable = await this.#effects.readAssignment(input.actionId);
    if (durable) {
      const replayFingerprint = durable.replacesActionId
        ? replacementActionFingerprint(input, durable.targetSessionId)
        : fingerprint;
      if (durable.actionFingerprint !== replayFingerprint) {
        throw new WorkHubActionGateFailure(
          'action_conflict',
          'WorkHub action identity belongs to a different proposal',
        );
      }
      if (durable.replacesActionId) {
        await this.#assertReplacementReplayTarget(input, durable.targetSessionId);
      }
      return this.#assign(assignmentInputFromRecord(durable), context);
    }
    if (proposal.disposition === 'answer_here') {
      const turnId = coordinationTurnId(input.actionId, 'answer');
      await this.#claimAction(input.actionId, 'answer_here', fingerprint, turnId);
      await this.#effects.answer({ turnId, text: input.userText }, context);
      return { disposition: 'answer_here', coordinationTurnId: turnId };
    }
    if (proposal.disposition === 'clarify') {
      const turnId = coordinationTurnId(input.actionId, 'clarify');
      await this.#claimAction(input.actionId, 'clarify', fingerprint, turnId);
      await this.#effects.clarify({
        turnId,
        userText: input.userText,
        assistantText: proposal.assistantText,
      });
      return { disposition: 'clarify', coordinationTurnId: turnId };
    }
    if (proposal.disposition === 'stop_work') {
      if (input.confirmation?.kind !== 'user_stop' || !requestIntent.stop.imperative) {
        throw new WorkHubActionGateFailure(
          'action_conflict',
          'WorkHub stop requires an explicit named command in trusted user text',
        );
      }
      const source = await this.#stopSource(input.actionId, proposal.expects.targetSessionId);
      const stopFingerprint = stopActionFingerprint(input, source);
      await this.#claimAction(input.actionId, 'stop', stopFingerprint, source.delegationId);
      const existing = await this.#effects.readStopRequest(source.delegationId);
      if (existing) {
        if (existing.actionId !== input.actionId) {
          // `not_owned` deliberately leaves the delegation active, so the user
          // can and will try again with a fresh request. That later attempt has
          // its own identity and must converge on the immutable non-destructive
          // outcome instead of colliding with the first attempt's stop claim.
          const resolved = await this.#effects.readStopResolution(source.delegationId);
          if (resolved?.outcome === 'not_owned') return stopResult(resolved);
        }
        assertStopReplay(existing, input, source, stopFingerprint);
        return this.#stop(existing, source);
      }
      const sessions = await this.#effects.listSessions();
      const sessionNameById = new Map(sessions.map((session) => [session.id, session.name]));
      // Only this delegation's target has to be visible. A delegation whose
      // Session the user deleted stays in the active set forever — nothing
      // retires it — so proving visibility over the whole set would let one
      // deleted Session block every stop in the system from then on.
      //
      // Sole active delegation is not reproved here. `#stopSource` derived this
      // `source` from the active links a moment ago by that same rule, and the
      // replay branch above returned before reaching this line, so a second
      // pass would re-read the transcript to reach the answer it started from.
      // The proof that decides is the coordinator's, under the admission lease.
      const currentTargetName = sessionNameById.get(source.targetSessionId);
      if (!currentTargetName) {
        throw new WorkHubActionGateFailure('action_conflict', 'WorkHub stop target is unavailable');
      }
      if (await this.#effects.readSupersession(source.delegationId)) {
        throw new WorkHubActionGateFailure(
          'action_conflict',
          'WorkHub delegation has already been superseded',
        );
      }
      if (await this.#effects.readReplacement(source.delegationId)) {
        throw new WorkHubActionGateFailure(
          'action_conflict',
          'WorkHub delegation already has a replacement claim',
        );
      }
      const requested = await this.#effects.prepareStop({
        actionId: input.actionId,
        actionFingerprint: stopFingerprint,
        stopsActionId: source.actionId,
        stopsDelegationId: source.delegationId,
        targetSessionId: source.targetSessionId,
        targetMessageId: source.targetMessageId,
        targetSessionName: currentTargetName,
        userText: input.userText,
      });
      return this.#stop(requested, source);
    }
    if (proposal.disposition === 'create_new') {
      if (!input.create || !workHubCreationAuthorizesTitle(requestIntent, proposal.title)) {
        throw new WorkHubActionGateFailure(
          'action_conflict',
          'WorkHub creation requires an unambiguous instruction and creation context',
        );
      }
      const sessionId = workHubCreatedSessionId(input.actionId);
      return this.#assign(
        delegationAssignment(input, fingerprint, sessionId, proposal.title),
        context,
      );
    }

    if (proposal.disposition === 'replace') {
      if (input.confirmation?.kind !== 'user_correction' || !requestIntent.correction.cue) {
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
        if (
          !isExplicitWorkHubCorrectionText(
            input.userText,
            prepared.disposition,
            prepared.targetSessionName,
          )
        ) {
          throw new WorkHubActionGateFailure(
            'action_conflict',
            'WorkHub replacement target is not affirmed in trusted user text',
          );
        }
        if (
          prepared.actionId !== input.actionId ||
          prepared.actionFingerprint !==
            replacementActionFingerprint(input, prepared.targetSessionId)
        ) {
          throw new WorkHubActionGateFailure(
            'action_conflict',
            'WorkHub delegation already has a different replacement intent',
          );
        }
        await this.#assertReplacementReplayTarget(input, prepared.targetSessionId);
        await this.#claimAction(
          prepared.actionId,
          'replace',
          prepared.actionFingerprint,
          prepared.replacesDelegationId,
        );
        return this.#replace(prepared, context);
      }
      const replacement = await this.#replacementAssignment(input, replaced);
      await this.#claimAction(
        replacement.actionId,
        'replace',
        replacement.actionFingerprint,
        replacement.replacesDelegationId,
      );
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

  /**
   * The delegation a stop names, by the only two keys that can name it.
   *
   * A stop carries its target Session and its own action identity; it never
   * carries the delegation, because a client cannot prove which link is live.
   *
   * Replay reads the claim first. A resolved stop takes its delegation out of
   * the active set, so re-deriving after one succeeded would find nothing and
   * turn a converging replay into a conflict. The claim records the delegation
   * this exact action already bound itself to, and it is written before any
   * effect, so whatever the first attempt reached is reachable again.
   *
   * A first attempt has no claim and resolves from the active links: exactly
   * one delegation on that Session must still hold work a stop could reach.
   * Zero or several is the same refusal admission has always made, from the
   * same durable state, rather than a client's guess about either.
   */
  async #stopSource(
    actionId: string,
    targetSessionId: string,
  ): Promise<WorkHubDelegationAssignedMessage> {
    const claim = await this.#effects.readActionClaim(actionId);
    if (claim?.operation === 'stop') {
      // The request records which delegation this action bound itself to. It is
      // written after the claim, so a crash between the two leaves a claim with
      // nothing to converge on — and nothing destructive happened either, so
      // that case resolves from the active links below, subject to the claim
      // still naming what they resolve to.
      const requested = await this.#effects.readStopRequest(claim.subject);
      if (requested) {
        const claimed = await this.#effects.readAssignment(requested.stopsActionId);
        if (!claimed || claimed.targetSessionId !== targetSessionId) {
          throw new WorkHubActionGateFailure(
            'action_conflict',
            'WorkHub stop identity is already bound to a different delegation',
          );
        }
        return claimed;
      }
    }
    const active = await this.#effects.listActiveAssignments();
    const onTarget = active.filter((assignment) => assignment.targetSessionId === targetSessionId);
    if (onTarget.length === 0) {
      throw new WorkHubActionGateFailure(
        'action_conflict',
        'WorkHub has no active durable delegation to stop on that Session',
      );
    }
    // One link is the answer whatever state its work is in. Whether that work
    // finished, or was never WorkHub's to stop, is what the stop resolves to —
    // `already_terminal` and `not_owned` are outcomes, not reasons to refuse
    // the request before it is recorded.
    //
    // Only several links need separating, and then the rule is the same one
    // competition uses: a delegation whose work already finished is still
    // linked but is no longer a stop target, so it cannot make a Session that
    // was delegated to twice permanently unstoppable.
    let resolved = onTarget[0]!;
    if (onTarget.length > 1) {
      const holdingWork: WorkHubDelegationAssignedMessage[] = [];
      for (const assignment of onTarget) {
        if ((await this.#effects.readDelegationRetirement(assignment)) !== 'retired') {
          holdingWork.push(assignment);
        }
      }
      if (holdingWork.length !== 1) {
        throw new WorkHubActionGateFailure(
          'action_conflict',
          'WorkHub stop target does not identify one active durable delegation',
        );
      }
      resolved = holdingWork[0]!;
    }
    // A claim with no request behind it resolves from the active links like a
    // first attempt, but only while those links still name the delegation it
    // bound itself to. If that one left and another took its place, the
    // fingerprint derived here would no longer match the claim, and since
    // claims are never deleted the refusal would be permanent and unexplained.
    // Say why instead: the identity is spent, and the retry needs a new one.
    if (claim?.operation === 'stop' && resolved.delegationId !== claim.subject) {
      throw new WorkHubActionGateFailure(
        'action_conflict',
        'WorkHub stop identity is already bound to a different delegation',
      );
    }
    return resolved;
  }

  async #stop(
    request: WorkHubDelegationStopRequestedMessage,
    source: WorkHubDelegationAssignedMessage,
  ): Promise<WorkHubCoordinationActResult> {
    const resolved = await this.#effects.readStopResolution(source.delegationId);
    if (resolved) return stopResultFromRecord(resolved, request);
    const retirement = await this.#effects.retireDelegation(source, {
      cancellationClaimId: request.actionId,
      cause: 'direct_stop',
    });
    const outcome =
      retirement.outcome === 'recovering'
        ? await this.#removedTargetOutcome(source)
        : retirement.outcome;
    if (!outcome) {
      throw new WorkHubActionEffectFailure(
        'operation_unavailable',
        'WorkHub is still resolving the delegated Message owner',
      );
    }
    const targetTurnId = retirement.outcome === outcome ? retirement.targetTurnId : undefined;
    const resolution = await this.#effects.resolveStop({
      request,
      outcome,
      ...(targetTurnId ? { targetTurnId } : {}),
    });
    return stopResultFromRecord(resolution, request);
  }

  /**
   * A removed target Session takes its Message-ownership proof with it, so a
   * committed stop claim would otherwise recover forever. The removal tombstone
   * outlives that Session and proves the delegated work ended; a target that is
   * merely unreadable, or an identity that never existed here, stays unresolved
   * rather than being reported as stopped.
   */
  async #removedTargetOutcome(
    source: WorkHubDelegationAssignedMessage,
  ): Promise<'already_terminal' | undefined> {
    const lifetime = await this.#effects.probeTargetRemoval(source.targetSessionId);
    return lifetime === 'removed' ? 'already_terminal' : undefined;
  }

  async #claimAction(
    actionId: string,
    operation: WorkHubActionOperation,
    actionFingerprint: `sha256:${string}`,
    subject: string,
  ): Promise<void> {
    const outcome = await this.#effects.claimAction({
      actionId,
      operation,
      actionFingerprint,
      subject,
    });
    if (outcome === 'conflict') {
      throw new WorkHubActionGateFailure(
        'action_conflict',
        'WorkHub action identity already owns a different operation',
      );
    }
  }

  async #replacementAssignment(
    input: WorkHubCoordinationActInput,
    replaced: WorkHubDelegationAssignedMessage,
  ): Promise<WorkHubDelegationReplacementInput> {
    if (input.proposal.disposition !== 'replace') {
      throw new WorkHubActionGateFailure('action_conflict', 'Invalid WorkHub replacement');
    }
    const target = input.proposal.target;
    if (target.disposition === 'create_new') {
      if (!isExplicitWorkHubCorrectionText(input.userText, 'create_new', target.title)) {
        throw new WorkHubActionGateFailure(
          'action_conflict',
          'WorkHub replacement creation requires explicit non-negated user intent',
        );
      }
      if (!input.create) {
        throw new WorkHubActionGateFailure(
          'action_conflict',
          'WorkHub replacement creation context is unavailable',
        );
      }
      const targetSessionId = workHubCreatedSessionId(input.actionId);
      return {
        actionId: input.actionId,
        actionFingerprint: replacementActionFingerprint(input, targetSessionId),
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
    if (
      !isExplicitWorkHubCorrectionText(input.userText, 'delegate_existing', destination.sessionName)
    ) {
      throw new WorkHubActionGateFailure(
        'action_conflict',
        'WorkHub replacement target is not affirmed in trusted user text',
      );
    }
    if (destination.sessionId === replaced.targetSessionId) {
      throw new WorkHubActionGateFailure(
        'action_conflict',
        'WorkHub replacement must choose a different Session',
      );
    }
    return {
      actionId: input.actionId,
      actionFingerprint: replacementActionFingerprint(input, destination.sessionId),
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
    const aborted = await this.#effects.readReplacementAbort(replacement.replacesDelegationId);
    if (aborted) {
      if (
        aborted.actionId !== replacement.actionId ||
        aborted.actionFingerprint !== replacement.actionFingerprint
      ) {
        throw new WorkHubActionGateFailure(
          'action_conflict',
          'WorkHub delegation replacement has a different terminal outcome',
        );
      }
      throw new WorkHubActionGateFailure(
        'action_conflict',
        'WorkHub replacement was aborted after its source delegation retired',
      );
    }
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
    let assignment = assignmentInputFromReplacement(replacement);
    const retirement = await this.#effects.readDelegationRetirement(source);
    if (retirement === 'recovering') {
      throw new WorkHubActionEffectFailure(
        'operation_unavailable',
        'WorkHub is still resolving the delegated Message owner',
      );
    }
    if (retirement === 'not_retired' && replacement.disposition === 'delegate_existing') {
      await this.#replacementTarget(replacement);
    }
    if (retirement === 'not_retired') {
      const result = await this.#effects.retireDelegation(source, {
        cancellationClaimId: replacement.actionId,
        cause: 'replacement',
      });
      if (result.outcome === 'recovering') {
        throw new WorkHubActionEffectFailure(
          'operation_unavailable',
          'WorkHub is still resolving the delegated Message owner',
        );
      }
    }
    try {
      if (replacement.disposition === 'delegate_existing') {
        // Retirement can await cancellation or Stop long enough for display
        // metadata or lifecycle state to change. Re-read after that destructive
        // boundary and carry the current name into SQLite's identity guard.
        const target = await this.#replacementTarget(replacement);
        assignment = { ...assignment, targetSessionName: target.name };
      }
      return await this.#assign(assignment, context);
    } catch (error) {
      // An assignment may have committed before its caller observed a transport
      // or projection failure. Never append an abort beside a real supersession.
      const [durable, supersession] = await Promise.all([
        this.#effects.readAssignment(replacement.actionId),
        this.#effects.readSupersession(replacement.replacesDelegationId),
      ]);
      if (durable && supersession?.replacementDelegationId === durable.delegationId) {
        return this.#assign(assignmentInputFromRecord(durable), context);
      }
      const reason =
        replacement.disposition === 'delegate_existing'
          ? await this.#replacementAbortReason(replacement)
          : 'target_unavailable';
      if (reason) await this.#effects.abortReplacement({ replacement, reason });
      throw error;
    }
  }

  async #assertReplacementReplayTarget(
    input: WorkHubCoordinationActInput,
    targetSessionId: string,
  ): Promise<void> {
    if (
      input.proposal.disposition !== 'replace' ||
      input.proposal.target.disposition !== 'delegate_existing' ||
      input.candidateSetId === undefined
    ) {
      return;
    }
    const candidateRef = input.proposal.target.candidateRef;
    const candidates = await this.candidates();
    if (candidates.candidateSetId !== input.candidateSetId) return;
    const proposed = candidates.candidates.find(
      (candidate) => candidate.candidateRef === candidateRef,
    );
    if (proposed && proposed.sessionId !== targetSessionId) {
      throw new WorkHubActionGateFailure(
        'action_conflict',
        'WorkHub replacement replay cannot change its durable target Session',
      );
    }
  }

  async #replacementTarget(
    replacement: WorkHubDelegationReplacementRequestedMessage,
  ): Promise<WorkHubActionGateSession> {
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
    return target;
  }

  async #replacementAbortReason(
    replacement: WorkHubDelegationReplacementRequestedMessage,
  ): Promise<WorkHubDelegationReplacementAbortedMessage['reason'] | undefined> {
    try {
      await this.#replacementTarget(replacement);
      return undefined;
    } catch (error) {
      if (!(error instanceof WorkHubActionGateFailure)) return undefined;
      if (error.code === 'candidate_unavailable') return 'target_unavailable';
      if (error.code === 'target_waiting_for_user') return 'target_waiting_for_user';
      return undefined;
    }
  }

  async #assign(
    assignment: WorkHubDelegationAssignmentInput,
    context: ConnectionContext,
  ): Promise<WorkHubCoordinationActResult> {
    await this.#claimAction(
      assignment.actionId,
      assignment.replacesDelegationId ? 'replace' : assignment.disposition,
      assignment.actionFingerprint,
      assignment.replacesDelegationId ?? assignment.targetSessionId,
    );
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
    ...(input.proposal.disposition === 'delegate_existing'
      ? { candidateRef: input.proposal.candidateRef }
      : {}),
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

function replacementActionFingerprint(
  input: WorkHubCoordinationActInput,
  targetSessionId: string,
): `sha256:${string}` {
  if (input.proposal.disposition !== 'replace') {
    throw new WorkHubActionGateFailure('action_conflict', 'Invalid WorkHub replacement replay');
  }
  return digest({
    userText: input.userText,
    disposition: input.proposal.disposition,
    replacesActionId: input.proposal.replacesActionId,
    target: {
      disposition: input.proposal.target.disposition,
      targetSessionId,
      ...(input.proposal.target.disposition === 'create_new'
        ? { title: input.proposal.target.title, workspace: input.create?.workspace }
        : {}),
    },
  });
}

function stopActionFingerprint(
  input: WorkHubCoordinationActInput,
  source: WorkHubDelegationAssignedMessage,
): `sha256:${string}` {
  if (input.proposal.disposition !== 'stop_work') {
    throw new WorkHubActionGateFailure('action_conflict', 'Invalid WorkHub stop replay');
  }
  return digest({
    userText: input.userText,
    disposition: 'stop_work',
    stopsActionId: source.actionId,
    stopsDelegationId: source.delegationId,
    targetSessionId: source.targetSessionId,
    targetMessageId: source.targetMessageId,
  });
}

function assertStopReplay(
  request: WorkHubDelegationStopRequestedMessage,
  input: WorkHubCoordinationActInput,
  source: WorkHubDelegationAssignedMessage,
  fingerprint: `sha256:${string}`,
): void {
  if (
    request.actionId !== input.actionId ||
    request.actionFingerprint !== fingerprint ||
    request.stopsActionId !== source.actionId ||
    request.stopsDelegationId !== source.delegationId ||
    request.targetSessionId !== source.targetSessionId ||
    request.targetMessageId !== source.targetMessageId
  ) {
    throw new WorkHubActionGateFailure(
      'action_conflict',
      'WorkHub delegation already has a different stop claim',
    );
  }
}

function stopResult(
  resolution: WorkHubDelegationStopResolvedMessage,
): WorkHubCoordinationActResult {
  return {
    disposition: 'stop_work',
    outcome: resolution.outcome,
    targetSessionId: resolution.targetSessionId,
    ...(resolution.targetTurnId ? { targetTurnId: resolution.targetTurnId } : {}),
  };
}

function stopResultFromRecord(
  resolution: WorkHubDelegationStopResolvedMessage,
  request: WorkHubDelegationStopRequestedMessage,
): WorkHubCoordinationActResult {
  if (
    resolution.actionId !== request.actionId ||
    resolution.actionFingerprint !== request.actionFingerprint ||
    resolution.stopsActionId !== request.stopsActionId ||
    resolution.stopsDelegationId !== request.stopsDelegationId ||
    resolution.targetSessionId !== request.targetSessionId
  ) {
    throw new WorkHubActionGateFailure(
      'action_conflict',
      'WorkHub stop has a different durable resolution',
    );
  }
  return stopResult(resolution);
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
export function isExplicitWorkHubCorrectionText(
  value: string,
  targetDisposition: WorkHubDelegationDisposition,
  targetSessionName?: string,
): boolean {
  const intent = readWorkHubRequestIntent(value);
  if (targetDisposition === 'create_new') {
    return Boolean(
      intent.correction.cue &&
        intent.creation.explicit &&
        targetSessionName &&
        workHubCreationAuthorizesTitle(intent, targetSessionName),
    );
  }
  return Boolean(
    targetSessionName &&
      intent.correction.cue &&
      workHubCorrectionTargetsSession(intent, targetSessionName),
  );
}
