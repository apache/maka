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
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { normalizeMessageContent } from '@maka/core/events';
import type { CreateSessionInput } from '@maka/core/runtime-inputs';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  WORKHUB_COORDINATION_SESSION_ROLE,
  WORKHUB_COORDINATION_REPLACEMENT_SCHEMA_VERSION,
  WORKHUB_COORDINATION_STOP_SCHEMA_VERSION,
  isWorkHubCoordinationSession,
  isWorkHubCoordinationSessionId,
  type SessionHeader,
  type StoredMessage,
  type WorkHubDelegationAssignedMessage,
  type WorkHubDelegationReplacementAbortedMessage,
  type WorkHubDelegationReplacementRequestedMessage,
  type WorkHubDelegationStopRequestedMessage,
  type WorkHubDelegationStopResolvedMessage,
} from '@maka/core/session';
import type { SessionAuthorityStore, SessionHeaderSnapshot } from '@maka/storage/session-store';
import type {
  OperationOutcome,
  WorkHubCoordinationActInput,
  WorkHubCoordinationAnswerInput,
  WorkHubCoordinationRecordInput,
} from '../protocol/index.js';
import {
  WORKHUB_COORDINATION_SUMMARY_MAX_BYTES,
  WORKHUB_COORDINATION_TEXT_MAX_BYTES,
} from '../protocol/index.js';
import type {
  ConnectionContext,
  WorkHubCoordinationOperationHandlerMap,
} from './operation-dispatcher.js';
import type { RootTurnCoordinator } from './root-turn-coordinator.js';
import { SessionAdmissionGate } from './session-admission-gate.js';
import { SessionOperationFailure } from './session-catalog-coordinator.js';
import type { SessionContinuityCoordinator } from './session-continuity-coordinator.js';
import {
  WorkHubActionEffectFailure,
  WorkHubActionGateFailure,
  WorkHubCoordinationActionGate,
  type WorkHubActionGateEffects,
} from './workhub-coordination-action-gate.js';

const CREATE_FINGERPRINT = `sha256:${createHash('sha256')
  .update('maka:workhub-coordination-session:v1', 'utf8')
  .digest('hex')}`;
const COORDINATION_CWD_DIRECTORY = 'workhub-coordination';
const COORDINATION_TOOL_PROFILE = 'workhub-coordination-v1' as const;
const SYNTHETIC_COORDINATION_MODEL_ID = 'maka-workhub-coordination';
const COORDINATION_PERMISSION_MODE = 'explore' as const;
const COORDINATION_COLLABORATION_MODE = 'agent' as const;
const COORDINATION_ORCHESTRATION_MODE = 'default' as const;
const COORDINATION_SUMMARY_MESSAGE_KINDS = ['user', 'assistant', 'state'] as const;
const TURN_IDENTITY_CONFLICT_MESSAGE =
  'WorkHub Coordination Turn identity belongs to a different operation';
// A one-byte control character can occupy six bytes as a JSON `\u0000` escape.
const JSON_ESCAPE_MAX_BYTES_PER_INPUT_BYTE = 6;
const COORDINATION_SUMMARY_READ_MAX_BYTES =
  JSON_ESCAPE_MAX_BYTES_PER_INPUT_BYTE *
    (WORKHUB_COORDINATION_TEXT_MAX_BYTES + WORKHUB_COORDINATION_SUMMARY_MAX_BYTES) +
  16 * 1024;

type CoordinationStores = Pick<
  SessionAuthorityStore,
  | 'appendMessages'
  | 'createStableSession'
  | 'listHeaders'
  | 'claimWorkHubAction'
  | 'readWorkHubActionClaim'
  | 'probeSessionRemoval'
  | 'probeStableSessionCreate'
  | 'readHeaderSnapshot'
  | 'readMessagesSnapshot'
  | 'readWorkHubAssignment'
  | 'readWorkHubReplacement'
  | 'readWorkHubReplacementAbort'
  | 'readWorkHubSupersession'
  | 'readWorkHubStopRequest'
  | 'readWorkHubStopResolution'
  | 'readTranscriptHighWaterSnapshot'
  | 'readTranscriptMessagesSnapshot'
  | 'updateHeaderVersioned'
>;

type CoordinationExecutions = Pick<
  RootTurnCoordinator,
  'startWorkHubCoordinationMessage' | 'hasRootTurnAdmission'
>;

export type CoordinationCreateTarget = Omit<CreateSessionInput, 'cwd' | 'name' | 'projectId'>;

export interface HostWorkHubCoordinationCoordinatorOptions {
  readonly stateRoot: string;
  readonly stores: CoordinationStores;
  readonly admission: SessionAdmissionGate;
  readonly continuity: Pick<SessionContinuityCoordinator, 'refreshCanonical'>;
  readonly executions: CoordinationExecutions;
  readonly sessionActions: Pick<
    WorkHubActionGateEffects,
    'assign' | 'readDelegationRetirement' | 'retireDelegation'
  >;
  readonly resolveCreateTarget: () => Promise<CoordinationCreateTarget>;
  readonly requestDrain: () => void;
}

/** Resolves the one durable Coordination Session owned by this Runtime Host. */
export class HostWorkHubCoordinationCoordinator {
  readonly handlers: WorkHubCoordinationOperationHandlerMap = {
    'workhub.coordination.resolve': () => this.#resolve(),
    'workhub.coordination.answer': (input, context) => this.#answer(input, context),
    'workhub.coordination.record': (input) => this.#record(input),
    'workhub.coordination.candidates': () => this.#candidates(),
    'workhub.coordination.act': (input, context) => this.#act(input, context),
  };

  readonly #coordinationCwd: string;
  readonly #stores: CoordinationStores;
  readonly #admission: SessionAdmissionGate;
  readonly #continuity: Pick<SessionContinuityCoordinator, 'refreshCanonical'>;
  readonly #executions: CoordinationExecutions;
  readonly #resolveCreateTarget: () => Promise<CoordinationCreateTarget>;
  readonly #requestDrain: () => void;
  readonly #actionGate: WorkHubCoordinationActionGate;
  readonly #readDelegationRetirement: HostWorkHubCoordinationCoordinatorOptions['sessionActions']['readDelegationRetirement'];

  constructor(options: HostWorkHubCoordinationCoordinatorOptions) {
    this.#coordinationCwd = join(options.stateRoot, COORDINATION_CWD_DIRECTORY);
    this.#stores = options.stores;
    this.#readDelegationRetirement = options.sessionActions.readDelegationRetirement;
    this.#admission = options.admission;
    this.#continuity = options.continuity;
    this.#executions = options.executions;
    this.#resolveCreateTarget = options.resolveCreateTarget;
    this.#requestDrain = options.requestDrain;
    this.#actionGate = new WorkHubCoordinationActionGate({
      listSessions: () => this.#stores.listHeaders(),
      // The global action owner is committed under the same Coordination
      // admission that serializes every durable Coordination fact, so a
      // concurrent action cannot slip between the claim and the fact it owns.
      claimAction: (claim) =>
        this.#admission.run(WORKHUB_COORDINATION_SESSION_ID, () =>
          this.#stores.claimWorkHubAction(claim),
        ),
      // Read without the admission lease: it is a durable point lookup by
      // primary key, and the claim it finds was committed under that lease.
      readActionClaim: (actionId) => this.#stores.readWorkHubActionClaim(actionId),
      probeTargetRemoval: async (sessionId) =>
        (await this.#stores.probeSessionRemoval(sessionId)).kind,
      readAssignment: (actionId) => this.#stores.readWorkHubAssignment(actionId),
      listActiveAssignments: () => this.#listActiveAssignments(),
      readReplacement: (delegationId) => this.#stores.readWorkHubReplacement(delegationId),
      readReplacementAbort: (delegationId) =>
        this.#stores.readWorkHubReplacementAbort(delegationId),
      readSupersession: (delegationId) => this.#stores.readWorkHubSupersession(delegationId),
      readStopRequest: (delegationId) => this.#stores.readWorkHubStopRequest(delegationId),
      readStopResolution: (delegationId) => this.#stores.readWorkHubStopResolution(delegationId),
      answer: async (input, context) => {
        const outcome = await this.#answer({ turnId: input.turnId, text: input.text }, context);
        if (!outcome.ok) {
          throw new WorkHubActionEffectFailure(outcome.error.code, outcome.error.message);
        }
      },
      clarify: async (input) => {
        const outcome = await this.#record({
          turnId: input.turnId,
          userText: input.userText,
          assistantText: input.assistantText,
        });
        if (!outcome.ok) {
          throw new WorkHubActionEffectFailure(outcome.error.code, outcome.error.message);
        }
      },
      assign: options.sessionActions.assign,
      prepareReplacement: (input) => this.#prepareReplacement(input),
      abortReplacement: (input) => this.#abortReplacement(input),
      prepareStop: (input) => this.#prepareStop(input),
      resolveStop: (input) => this.#resolveStop(input),
      readDelegationRetirement: options.sessionActions.readDelegationRetirement,
      retireDelegation: options.sessionActions.retireDelegation,
    });
  }

  #prepareReplacement(
    input: Parameters<WorkHubActionGateEffects['prepareReplacement']>[0],
  ): Promise<WorkHubDelegationReplacementRequestedMessage> {
    const suffix = workHubDestructiveClaimIdentitySuffix(input.replacesDelegationId);
    return this.#commitCoordinationFact({
      read: () => this.#stores.readWorkHubReplacement(input.replacesDelegationId),
      build: (existing) => ({
        type: 'workhub_coordination',
        id: `whp_${suffix}`,
        turnId: input.actionId,
        ts: existing?.ts ?? Date.now(),
        schemaVersion: WORKHUB_COORDINATION_REPLACEMENT_SCHEMA_VERSION,
        kind: 'delegation_replacement_requested',
        actionId: input.actionId,
        actionFingerprint: input.actionFingerprint,
        coordinationTurnId: input.actionId,
        targetSessionId: input.targetSessionId,
        targetSessionName: input.targetSessionName,
        disposition: input.disposition,
        userText: input.userText,
        replacesActionId: input.replacesActionId,
        replacesDelegationId: input.replacesDelegationId,
        replacedTargetSessionId: input.replacedTargetSessionId,
        replacedTargetMessageId: input.replacedTargetMessageId,
        ...(input.create ? { create: input.create } : {}),
      }),
      conflictMessage: 'WorkHub action identity belongs to a different replacement',
      beforeAppend: async () => {
        const stopRequest = await this.#stores.readWorkHubStopRequest(input.replacesDelegationId);
        if (stopRequest) {
          const resolution = await this.#stores.readWorkHubStopResolution(
            input.replacesDelegationId,
          );
          if (resolution?.outcome !== 'not_owned') {
            throw new WorkHubActionGateFailure(
              'action_conflict',
              'WorkHub delegation already has a stop claim',
            );
          }
        }
        const header = await this.#stores.readHeaderSnapshot(WORKHUB_COORDINATION_SESSION_ID);
        if (!validCoordinationHeader(header)) {
          throw new WorkHubActionEffectFailure(
            'operation_conflict',
            'WorkHub Coordination Session identity is unavailable',
          );
        }
      },
      unknownOutcomeMessage: 'WorkHub replacement intent outcome is unknown',
    });
  }

  async #prepareStop(
    input: Parameters<WorkHubActionGateEffects['prepareStop']>[0],
  ): Promise<WorkHubDelegationStopRequestedMessage> {
    const suffix = workHubDestructiveClaimIdentitySuffix(input.stopsDelegationId);
    return this.#commitCoordinationFact({
      // Only the two Sessions this stop can change: the one whose delegation
      // ends, and the Coordination Session that records it. Holding a lane for
      // every Session with an active delegation would serialize unrelated
      // delegation traffic behind one stop, and the proof below needs no lane
      // it does not already hold.
      admissionSessionIds: [WORKHUB_COORDINATION_SESSION_ID, input.targetSessionId],
      read: () => this.#stores.readWorkHubStopRequest(input.stopsDelegationId),
      build: (existing) => ({
        type: 'workhub_coordination',
        id: `whq_${suffix}`,
        turnId: input.actionId,
        ts: existing?.ts ?? Date.now(),
        schemaVersion: WORKHUB_COORDINATION_STOP_SCHEMA_VERSION,
        kind: 'delegation_stop_requested',
        actionId: input.actionId,
        actionFingerprint: input.actionFingerprint,
        coordinationTurnId: input.actionId,
        stopsActionId: input.stopsActionId,
        stopsDelegationId: input.stopsDelegationId,
        targetSessionId: input.targetSessionId,
        targetMessageId: input.targetMessageId,
        targetSessionName: input.targetSessionName,
        userText: input.userText,
      }),
      conflictMessage: 'WorkHub delegation already has a different stop claim',
      beforeAppend: async () => {
        const [replacement, supersession, messages] = await Promise.all([
          this.#stores.readWorkHubReplacement(input.stopsDelegationId),
          this.#stores.readWorkHubSupersession(input.stopsDelegationId),
          this.#stores.readMessagesSnapshot(WORKHUB_COORDINATION_SESSION_ID),
        ]);
        if (replacement || supersession) {
          throw new WorkHubActionGateFailure(
            'action_conflict',
            'WorkHub delegation is already being replaced',
          );
        }
        const activeAssignments = activeWorkHubAssignments(messages);
        // Held lanes make this the last moment the one-target proof can change.
        // It is proved from opaque delegation identity, so a concurrent rename
        // is harmless while a concurrent delegation to the same Session is not.
        const targetActive = activeAssignments.filter(
          (assignment) => assignment.targetSessionId === input.targetSessionId,
        );
        const source = targetActive.find(
          (assignment) =>
            assignment.actionId === input.stopsActionId &&
            assignment.delegationId === input.stopsDelegationId,
        );
        if (!source) {
          throw new WorkHubActionGateFailure(
            'action_conflict',
            'WorkHub stop target does not identify one active durable delegation',
          );
        }
        // A delegation whose work already finished stays linked but competes
        // for nothing; only work that could still be stopped makes the target
        // ambiguous.
        for (const competitor of targetActive) {
          if (competitor.delegationId === source.delegationId) continue;
          if ((await this.#readDelegationRetirement(competitor)) !== 'retired') {
            throw new WorkHubActionGateFailure(
              'action_conflict',
              'WorkHub stop target does not identify one active durable delegation',
            );
          }
        }
      },
      unknownOutcomeMessage: 'WorkHub stop request outcome is unknown',
    });
  }

  async #listActiveAssignments(): Promise<readonly WorkHubDelegationAssignedMessage[]> {
    return activeWorkHubAssignments(
      await this.#stores.readMessagesSnapshot(WORKHUB_COORDINATION_SESSION_ID),
    );
  }

  #resolveStop(
    input: Parameters<WorkHubActionGateEffects['resolveStop']>[0],
  ): Promise<WorkHubDelegationStopResolvedMessage> {
    const request = input.request;
    const suffix = workHubDestructiveClaimIdentitySuffix(request.stopsDelegationId);
    return this.#commitCoordinationFact({
      read: () => this.#stores.readWorkHubStopResolution(request.stopsDelegationId),
      build: (existing) => ({
        type: 'workhub_coordination',
        id: `whz_${suffix}`,
        turnId: request.actionId,
        ts: existing?.ts ?? Date.now(),
        schemaVersion: WORKHUB_COORDINATION_STOP_SCHEMA_VERSION,
        kind: 'delegation_stop_resolved',
        actionId: request.actionId,
        actionFingerprint: request.actionFingerprint,
        coordinationTurnId: request.coordinationTurnId,
        stopsActionId: request.stopsActionId,
        stopsDelegationId: request.stopsDelegationId,
        targetSessionId: request.targetSessionId,
        outcome: input.outcome,
        ...(input.targetTurnId ? { targetTurnId: input.targetTurnId } : {}),
      }),
      conflictMessage: 'WorkHub stop already has a different resolution',
      beforeAppend: async () => {
        const durable = await this.#stores.readWorkHubStopRequest(request.stopsDelegationId);
        if (!durable || !isDeepStrictEqual(durable, request)) {
          throw new WorkHubActionGateFailure(
            'action_conflict',
            'WorkHub stop request identity changed',
          );
        }
      },
      unknownOutcomeMessage: 'WorkHub stop resolution outcome is unknown',
    });
  }

  #abortReplacement(
    input: Parameters<WorkHubActionGateEffects['abortReplacement']>[0],
  ): Promise<WorkHubDelegationReplacementAbortedMessage> {
    const replacement = input.replacement;
    const suffix = workHubDestructiveClaimIdentitySuffix(replacement.replacesDelegationId);
    return this.#commitCoordinationFact({
      read: () => this.#stores.readWorkHubReplacementAbort(replacement.replacesDelegationId),
      build: (existing) => ({
        type: 'workhub_coordination',
        id: `whb_${suffix}`,
        turnId: replacement.actionId,
        ts: existing?.ts ?? Date.now(),
        schemaVersion: WORKHUB_COORDINATION_REPLACEMENT_SCHEMA_VERSION,
        kind: 'delegation_replacement_aborted',
        actionId: replacement.actionId,
        actionFingerprint: replacement.actionFingerprint,
        coordinationTurnId: replacement.actionId,
        abortedActionId: replacement.replacesActionId,
        abortedDelegationId: replacement.replacesDelegationId,
        targetSessionId: replacement.targetSessionId,
        reason: input.reason,
      }),
      conflictMessage: 'WorkHub replacement already has a different abort outcome',
      beforeAppend: async () => {
        const supersession = await this.#stores.readWorkHubSupersession(
          replacement.replacesDelegationId,
        );
        if (supersession) {
          throw new WorkHubActionGateFailure(
            'action_conflict',
            'WorkHub replacement already committed its supersession',
          );
        }
      },
      unknownOutcomeMessage: 'WorkHub replacement abort outcome is unknown',
    });
  }

  #commitCoordinationFact<T extends StoredMessage>(options: {
    readonly admissionSessionIds?: readonly string[];
    readonly read: () => Promise<T | undefined>;
    readonly build: (existing: T | undefined) => T;
    readonly conflictMessage: string;
    readonly beforeAppend: () => Promise<void>;
    readonly unknownOutcomeMessage: string;
  }): Promise<T> {
    return this.#admission.runMany(
      options.admissionSessionIds ?? [WORKHUB_COORDINATION_SESSION_ID],
      async (lease) => {
        const existing = await options.read();
        const requested = options.build(existing);
        if (existing) {
          if (!isDeepStrictEqual(existing, requested)) {
            throw new WorkHubActionGateFailure('action_conflict', options.conflictMessage);
          }
          return existing;
        }
        await options.beforeAppend();
        try {
          await this.#stores.appendMessages(WORKHUB_COORDINATION_SESSION_ID, [requested]);
          await this.#continuity.refreshCanonical(WORKHUB_COORDINATION_SESSION_ID, lease);
          return requested;
        } catch {
          const replay = await options.read().catch(() => undefined);
          if (replay && isDeepStrictEqual(replay, requested)) return replay;
          this.#requestDrain();
          throw new WorkHubActionEffectFailure(
            'commit_outcome_unknown',
            options.unknownOutcomeMessage,
          );
        }
      },
    );
  }

  async #candidates(): Promise<OperationOutcome<'workhub.coordination.candidates'>> {
    try {
      return { ok: true, result: await this.#actionGate.candidates() };
    } catch {
      return {
        ok: false,
        error: {
          code: 'persistence_failed',
          message: 'WorkHub Session candidates are unavailable',
        },
      };
    }
  }

  async #act(
    input: WorkHubCoordinationActInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'workhub.coordination.act'>> {
    try {
      return { ok: true, result: await this.#actionGate.act(input, context) };
    } catch (error) {
      if (error instanceof WorkHubActionEffectFailure) {
        return {
          ok: false,
          error: {
            code: error.code === 'unauthorized' ? 'operation_unavailable' : error.code,
            message: error.message,
          },
        };
      }
      if (error instanceof WorkHubActionGateFailure) {
        return {
          ok: false,
          error: {
            code: error.code === 'target_waiting_for_user' ? 'session_busy' : 'operation_conflict',
            message: error.message,
          },
        };
      }
      return {
        ok: false,
        error: {
          code: 'persistence_failed',
          message: 'WorkHub action authority is unavailable',
        },
      };
    }
  }

  #resolve(): Promise<OperationOutcome<'workhub.coordination.resolve'>> {
    return this.#admission.run(WORKHUB_COORDINATION_SESSION_ID, async (lease) => {
      // The workspace exists for provisioning and for reuse alike: a directory
      // that was pruned after creation must come back before anyone is handed
      // the identity, and mkdir is idempotent.
      try {
        await mkdir(this.#coordinationCwd, { recursive: true });
      } catch {
        return failure(
          'persistence_failed',
          'WorkHub Coordination Session workspace is unavailable',
        );
      }

      let probe;
      try {
        probe = await this.#stores.probeStableSessionCreate(
          WORKHUB_COORDINATION_SESSION_ID,
          CREATE_FINGERPRINT,
        );
      } catch {
        this.#requestDrain();
        return failure('persistence_failed', 'WorkHub Coordination Session state is unavailable');
      }

      if (probe.kind === 'existing') {
        return validCoordinationIdentityHeader(probe.record.header)
          ? await this.#alignSession(probe.record)
          : identityConflict();
      }
      if (probe.kind === 'conflict') return identityConflict();

      let target: CoordinationCreateTarget;
      try {
        target = await this.#resolveCreateTarget();
      } catch (error) {
        return createTargetFailure(error);
      }

      try {
        const result = await this.#stores.createStableSession({
          sessionId: WORKHUB_COORDINATION_SESSION_ID,
          requestFingerprint: CREATE_FINGERPRINT,
          input: {
            ...target,
            permissionMode: COORDINATION_PERMISSION_MODE,
            collaborationMode: COORDINATION_COLLABORATION_MODE,
            orchestrationMode: COORDINATION_ORCHESTRATION_MODE,
            cwd: this.#coordinationCwd,
            projectId: null,
            name: 'WorkHub',
            role: WORKHUB_COORDINATION_SESSION_ROLE,
            toolProfile: COORDINATION_TOOL_PROFILE,
          },
        });
        if (result.kind === 'conflict') return identityConflict();
        if (
          !validCoordinationHeader(result.record.header) ||
          result.record.header.cwd !== this.#coordinationCwd
        ) {
          return identityConflict();
        }
        await this.#continuity.refreshCanonical(WORKHUB_COORDINATION_SESSION_ID, lease);
        return success();
      } catch {
        this.#requestDrain();
        return failure(
          'commit_outcome_unknown',
          'WorkHub Coordination Session creation outcome is unknown',
        );
      }
    });
  }

  async #answer(
    input: WorkHubCoordinationAnswerInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'workhub.coordination.answer'>> {
    if (!input.text.trim()) {
      return turnFailure(
        'workhub.coordination.answer',
        'operation_conflict',
        'WorkHub answer text is empty',
      );
    }
    const outcome = await this.#executions.startWorkHubCoordinationMessage(
      {
        sessionId: WORKHUB_COORDINATION_SESSION_ID,
        turnId: input.turnId,
        execution: {
          kind: 'workhub_coordination',
          inputDigest: digest({ text: input.text }),
        },
        archivedMessage: 'WorkHub Coordination Session is unavailable',
        // A recorded summary owns its Turn identity durably but is admitted
        // outside this ledger, so the probe runs under the admission lease: a
        // concurrent `record` cannot slip a second triplet into this Turn.
        prepareFreshContent: async () => {
          let recorded: readonly StoredMessage[];
          try {
            recorded = await this.#readSummaryMessages(input.turnId);
          } catch {
            return {
              kind: 'rejected',
              outcome: operationUnavailable(
                'WorkHub Coordination Turn identity could not be verified',
              ),
            };
          }
          return recorded.length > 0
            ? { kind: 'rejected', outcome: turnIdentityConflict() }
            : { kind: 'ready', content: normalizeMessageContent({ text: input.text }) };
        },
      },
      context,
    );
    return outcome.ok ? { ok: true, result: { turnId: input.turnId } } : outcome;
  }

  #record(
    input: WorkHubCoordinationRecordInput,
  ): Promise<OperationOutcome<'workhub.coordination.record'>> {
    if (!input.userText.trim() || !input.assistantText.trim()) {
      return Promise.resolve(
        turnFailure(
          'workhub.coordination.record',
          'operation_conflict',
          'WorkHub Coordination summary text is empty',
        ),
      );
    }
    return this.#admission.run(WORKHUB_COORDINATION_SESSION_ID, async (lease) => {
      let header: SessionHeader;
      try {
        header = await this.#stores.readHeaderSnapshot(WORKHUB_COORDINATION_SESSION_ID);
      } catch {
        return turnFailure(
          'workhub.coordination.record',
          'persistence_failed',
          'WorkHub Coordination Session state is unavailable',
        );
      }
      if (!validCoordinationHeader(header)) {
        return turnFailure(
          'workhub.coordination.record',
          'operation_conflict',
          'WorkHub Coordination Session identity is unavailable',
        );
      }

      const messages = coordinationSummaryMessages(input);
      try {
        const existing = await this.#readSummaryMessages(input.turnId);
        if (existing.length > 0) {
          return coordinationSummaryMatches(existing, input)
            ? { ok: true, result: { turnId: input.turnId } }
            : turnFailure(
                'workhub.coordination.record',
                'operation_conflict',
                'WorkHub Coordination Turn identity belongs to different content',
              );
        }
        // An answer owns its Turn identity in the root admission ledger. Both
        // operations take the same Session admission, so this probe settles the
        // race in one direction and the answer's own probe settles the other.
        if (
          await this.#executions.hasRootTurnAdmission(WORKHUB_COORDINATION_SESSION_ID, input.turnId)
        ) {
          return turnFailure(
            'workhub.coordination.record',
            'operation_conflict',
            TURN_IDENTITY_CONFLICT_MESSAGE,
          );
        }
        await this.#stores.appendMessages(WORKHUB_COORDINATION_SESSION_ID, messages);
        await this.#continuity.refreshCanonical(WORKHUB_COORDINATION_SESSION_ID, lease);
        return { ok: true, result: { turnId: input.turnId } };
      } catch {
        this.#requestDrain();
        return turnFailure(
          'workhub.coordination.record',
          'commit_outcome_unknown',
          'WorkHub Coordination summary outcome is unknown',
        );
      }
    });
  }

  /** Reads the durable summary triplet a `record` would own for this Turn. */
  async #readSummaryMessages(turnId: string): Promise<readonly StoredMessage[]> {
    const throughSequence = await this.#stores.readTranscriptHighWaterSnapshot(
      WORKHUB_COORDINATION_SESSION_ID,
    );
    if (throughSequence === null) return [];
    return this.#stores.readTranscriptMessagesSnapshot(WORKHUB_COORDINATION_SESSION_ID, {
      messageIds: COORDINATION_SUMMARY_MESSAGE_KINDS.map((kind) =>
        coordinationSummaryMessageId(turnId, kind),
      ),
      throughSequence,
      maxBytes: COORDINATION_SUMMARY_READ_MAX_BYTES,
      maxMessages: COORDINATION_SUMMARY_MESSAGE_KINDS.length,
    });
  }

  /**
   * The workspace path is derived from the Host state root, so it moves with the
   * installation. Identity stays in the id/role pair and the durable path is
   * repaired in place — rejecting the drift would strand the one Session no
   * ordinary lifecycle operation is allowed to relocate or retire.
   */
  async #alignSession(
    record: SessionHeaderSnapshot,
  ): Promise<OperationOutcome<'workhub.coordination.resolve'>> {
    if (
      record.header.toolProfile !== undefined &&
      record.header.toolProfile !== COORDINATION_TOOL_PROFILE
    ) {
      return identityConflict();
    }
    if (record.header.cwd === this.#coordinationCwd && validCoordinationHeader(record.header)) {
      return success();
    }
    let repaired: SessionHeaderSnapshot;
    try {
      repaired = await this.#stores.updateHeaderVersioned(
        WORKHUB_COORDINATION_SESSION_ID,
        {
          ...(record.header.cwd === this.#coordinationCwd ? {} : { cwd: this.#coordinationCwd }),
          ...(record.header.toolProfile === COORDINATION_TOOL_PROFILE
            ? {}
            : { toolProfile: COORDINATION_TOOL_PROFILE }),
          ...(record.header.permissionMode === COORDINATION_PERMISSION_MODE
            ? {}
            : { permissionMode: COORDINATION_PERMISSION_MODE }),
          ...((record.header.collaborationMode ?? 'agent') === COORDINATION_COLLABORATION_MODE
            ? {}
            : { collaborationMode: COORDINATION_COLLABORATION_MODE }),
          ...((record.header.orchestrationMode ?? 'default') === COORDINATION_ORCHESTRATION_MODE
            ? {}
            : { orchestrationMode: COORDINATION_ORCHESTRATION_MODE }),
        },
        record.revision,
      );
    } catch {
      return failure(
        'persistence_failed',
        'WorkHub Coordination Session workspace could not be relocated',
      );
    }
    return validCoordinationHeader(repaired.header) && repaired.header.cwd === this.#coordinationCwd
      ? success()
      : identityConflict();
  }
}

/** Keeps a model-authority gap distinguishable from a failed authority read. */
function createTargetFailure(error: unknown): OperationOutcome<'workhub.coordination.resolve'> {
  if (error instanceof SessionOperationFailure && error.code === 'persistence_failed') {
    return failure('persistence_failed', error.message);
  }
  return failure(
    'operation_conflict',
    'WorkHub Coordination Session requires an available default model',
  );
}

function validCoordinationIdentityHeader(header: SessionHeader): boolean {
  return (
    isWorkHubCoordinationSessionId(header.id) &&
    isWorkHubCoordinationSession(header) &&
    header.projectId === null &&
    !header.isArchived &&
    header.parentSessionId === undefined &&
    header.subagentParent === undefined &&
    header.conversationCopy === undefined &&
    header.revisionRootSessionId === undefined
  );
}

function validCoordinationHeader(header: SessionHeader): boolean {
  return (
    validCoordinationIdentityHeader(header) &&
    header.toolProfile === COORDINATION_TOOL_PROFILE &&
    header.permissionMode === COORDINATION_PERMISSION_MODE &&
    (header.collaborationMode ?? 'agent') === COORDINATION_COLLABORATION_MODE &&
    (header.orchestrationMode ?? 'default') === COORDINATION_ORCHESTRATION_MODE
  );
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function activeWorkHubAssignments(
  messages: readonly StoredMessage[],
): WorkHubDelegationAssignedMessage[] {
  const terminalDelegationIds = new Set<string>();
  const assignments: WorkHubDelegationAssignedMessage[] = [];
  for (const message of messages) {
    if (message.type !== 'workhub_coordination') continue;
    if (message.kind === 'delegation_assigned') {
      assignments.push(message);
    } else if (message.kind === 'delegation_superseded') {
      terminalDelegationIds.add(message.supersededDelegationId);
    } else if (message.kind === 'delegation_replacement_aborted') {
      terminalDelegationIds.add(message.abortedDelegationId);
    } else if (message.kind === 'delegation_stop_resolved' && message.outcome !== 'not_owned') {
      terminalDelegationIds.add(message.stopsDelegationId);
    }
  }
  return assignments.filter(({ delegationId }) => !terminalDelegationIds.has(delegationId));
}

function workHubDestructiveClaimIdentitySuffix(delegationId: string): string {
  return createHash('sha256').update(delegationId, 'utf8').digest('hex').slice(0, 48);
}

function coordinationSummaryMessageId(
  turnId: string,
  kind: (typeof COORDINATION_SUMMARY_MESSAGE_KINDS)[number],
): string {
  return `workhub_${createHash('sha256')
    .update(`${turnId}\0${kind}`, 'utf8')
    .digest('hex')
    .slice(0, 48)}`;
}

function coordinationSummaryMessages(input: WorkHubCoordinationRecordInput): StoredMessage[] {
  const ts = Date.now();
  const messageId = (kind: (typeof COORDINATION_SUMMARY_MESSAGE_KINDS)[number]) =>
    coordinationSummaryMessageId(input.turnId, kind);
  return [
    {
      type: 'user',
      id: messageId('user'),
      turnId: input.turnId,
      ts,
      text: input.userText,
    },
    {
      type: 'assistant',
      id: messageId('assistant'),
      turnId: input.turnId,
      ts: ts + 1,
      text: input.assistantText,
      modelId: SYNTHETIC_COORDINATION_MODEL_ID,
    },
    {
      type: 'turn_state',
      id: messageId('state'),
      turnId: input.turnId,
      ts: ts + 2,
      status: 'completed',
      partialOutputRetained: false,
    },
  ];
}

function coordinationSummaryMatches(
  existing: readonly StoredMessage[],
  input: WorkHubCoordinationRecordInput,
): boolean {
  if (existing.length !== 3) return false;
  const user = existing.find((message) => message.type === 'user');
  const assistant = existing.find((message) => message.type === 'assistant');
  const state = existing.find((message) => message.type === 'turn_state');
  return (
    user?.turnId === input.turnId &&
    user.text === input.userText &&
    assistant?.turnId === input.turnId &&
    assistant.text === input.assistantText &&
    assistant.modelId === SYNTHETIC_COORDINATION_MODEL_ID &&
    state?.turnId === input.turnId &&
    state.status === 'completed'
  );
}

function success(): OperationOutcome<'workhub.coordination.resolve'> {
  return {
    ok: true,
    result: { sessionId: WORKHUB_COORDINATION_SESSION_ID },
  };
}

function identityConflict(): OperationOutcome<'workhub.coordination.resolve'> {
  return failure('operation_conflict', 'WorkHub Coordination Session identity is unavailable');
}

function failure(
  code: Extract<
    OperationOutcome<'workhub.coordination.resolve'>,
    { readonly ok: false }
  >['error']['code'],
  message: string,
): OperationOutcome<'workhub.coordination.resolve'> {
  return { ok: false, error: { code, message } };
}

/** Fresh-admission rejections for the answer's lease-scoped identity probe. */
function turnIdentityConflict() {
  return {
    ok: false,
    error: { code: 'operation_conflict', message: TURN_IDENTITY_CONFLICT_MESSAGE },
  } as const;
}

function operationUnavailable(message: string) {
  return { ok: false, error: { code: 'operation_unavailable', message } } as const;
}

function turnFailure<K extends 'workhub.coordination.answer' | 'workhub.coordination.record'>(
  _operation: K,
  code: Extract<OperationOutcome<K>, { readonly ok: false }>['error']['code'],
  message: string,
): OperationOutcome<K> {
  return { ok: false, error: { code, message } } as OperationOutcome<K>;
}
