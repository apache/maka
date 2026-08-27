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
import { isDeepStrictEqual } from 'node:util';
import {
  WORKHUB_COORDINATION_RECORD_SCHEMA_VERSION,
  WORKHUB_COORDINATION_SESSION_ID,
  isWorkHubCoordinationSession,
  type StoredMessage,
  type WorkHubDelegationAbandonedMessage,
  type WorkHubDelegationCommittedMessage,
  type WorkHubDelegationIntentMessage,
} from '@maka/core/session';
import type { SessionAuthorityStore } from '@maka/storage/session-store';
import type { SessionContinuityCoordinator } from './session-continuity-coordinator.js';
import {
  WorkHubActionEffectFailure,
  type WorkHubDelegationAbandoned,
  type WorkHubDelegationCommit,
  type WorkHubDelegationIntent,
  type WorkHubDelegationRecord,
} from './workhub-coordination-action-gate.js';
import type { SessionAdmissionGate } from './session-admission-gate.js';

const RECORD_KINDS = ['delegation_intent', 'delegation_committed', 'delegation_abandoned'] as const;
// Two records may each repeat the bounded 48 KiB request plus create context;
// JSON escaping can expand one input byte to six encoded bytes.
const RECORD_READ_MAX_BYTES = 768 * 1024;

type JournalStores = Pick<
  SessionAuthorityStore,
  | 'appendMessages'
  | 'readHeaderSnapshot'
  | 'readTranscriptHighWaterSnapshot'
  | 'readTranscriptMessagesSnapshot'
>;

export interface WorkHubDelegationJournalOptions {
  readonly stores: JournalStores;
  readonly admission: SessionAdmissionGate;
  readonly continuity: Pick<SessionContinuityCoordinator, 'refreshCanonical'>;
  readonly requestDrain: () => void;
}

/**
 * Append-only authority for WorkHub action intent and committed delegation links.
 *
 * The interface exposes domain records only. Message identities, transcript
 * snapshots, exact replay checks, and commit-outcome handling stay local here.
 */
export class WorkHubDelegationJournal {
  readonly #stores: JournalStores;
  readonly #admission: SessionAdmissionGate;
  readonly #continuity: Pick<SessionContinuityCoordinator, 'refreshCanonical'>;
  readonly #requestDrain: () => void;

  constructor(options: WorkHubDelegationJournalOptions) {
    this.#stores = options.stores;
    this.#admission = options.admission;
    this.#continuity = options.continuity;
    this.#requestDrain = options.requestDrain;
  }

  async read(actionId: string): Promise<WorkHubDelegationRecord | undefined> {
    await this.#assertCoordinationSession();
    const messages = await this.#readMessages(actionId);
    return this.#projectRecord(actionId, messages);
  }

  prepare(intent: WorkHubDelegationIntent): Promise<void> {
    return this.#admission.run(WORKHUB_COORDINATION_SESSION_ID, async (lease) => {
      await this.#assertCoordinationSession();
      const existing = this.#projectRecord(
        intent.actionId,
        await this.#readMessages(intent.actionId),
      );
      if (existing) {
        if (!sameIntent(existing, intent)) throw actionConflict();
        return;
      }
      try {
        await this.#stores.appendMessages(WORKHUB_COORDINATION_SESSION_ID, [intentMessage(intent)]);
        await this.#continuity.refreshCanonical(WORKHUB_COORDINATION_SESSION_ID, lease);
      } catch (error) {
        if (error instanceof WorkHubActionEffectFailure) throw error;
        this.#requestDrain();
        throw new WorkHubActionEffectFailure(
          'commit_outcome_unknown',
          'WorkHub delegation intent outcome is unknown',
        );
      }
    });
  }

  commit(commit: WorkHubDelegationCommit): Promise<void> {
    return this.#admission.run(WORKHUB_COORDINATION_SESSION_ID, async (lease) => {
      await this.#assertCoordinationSession();
      const existing = this.#projectRecord(
        commit.actionId,
        await this.#readMessages(commit.actionId),
      );
      if (existing?.kind === 'delegation_committed') {
        if (!sameCommit(existing, commit)) throw actionConflict();
        return;
      }
      if (existing?.kind === 'delegation_abandoned') throw actionConflict();
      if (!existing || !sameIntent(existing, commit)) throw actionConflict();
      try {
        await this.#stores.appendMessages(WORKHUB_COORDINATION_SESSION_ID, [
          committedMessage(commit),
        ]);
        await this.#continuity.refreshCanonical(WORKHUB_COORDINATION_SESSION_ID, lease);
      } catch (error) {
        if (error instanceof WorkHubActionEffectFailure) throw error;
        this.#requestDrain();
        throw new WorkHubActionEffectFailure(
          'commit_outcome_unknown',
          'WorkHub delegation commit outcome is unknown',
        );
      }
    });
  }

  abandon(abandoned: WorkHubDelegationAbandoned): Promise<void> {
    return this.#admission.run(WORKHUB_COORDINATION_SESSION_ID, async (lease) => {
      await this.#assertCoordinationSession();
      const existing = this.#projectRecord(
        abandoned.actionId,
        await this.#readMessages(abandoned.actionId),
      );
      if (existing?.kind === 'delegation_abandoned') {
        if (!sameAbandoned(existing, abandoned)) throw actionConflict();
        return;
      }
      if (!existing || existing.kind !== 'delegation_intent' || !sameIntent(existing, abandoned)) {
        throw actionConflict();
      }
      try {
        await this.#stores.appendMessages(WORKHUB_COORDINATION_SESSION_ID, [
          abandonedMessage(abandoned),
        ]);
        await this.#continuity.refreshCanonical(WORKHUB_COORDINATION_SESSION_ID, lease);
      } catch (error) {
        if (error instanceof WorkHubActionEffectFailure) throw error;
        this.#requestDrain();
        throw new WorkHubActionEffectFailure(
          'commit_outcome_unknown',
          'WorkHub delegation abandonment outcome is unknown',
        );
      }
    });
  }

  async #assertCoordinationSession(): Promise<void> {
    try {
      const header = await this.#stores.readHeaderSnapshot(WORKHUB_COORDINATION_SESSION_ID);
      if (isWorkHubCoordinationSession(header) && !header.isArchived) return;
      throw new WorkHubActionEffectFailure(
        'operation_conflict',
        'WorkHub Coordination Session identity is unavailable',
      );
    } catch (error) {
      if (error instanceof WorkHubActionEffectFailure) throw error;
      throw new WorkHubActionEffectFailure(
        'persistence_failed',
        'WorkHub Coordination Session state is unavailable',
      );
    }
  }

  async #readMessages(actionId: string): Promise<readonly StoredMessage[]> {
    try {
      const throughSequence = await this.#stores.readTranscriptHighWaterSnapshot(
        WORKHUB_COORDINATION_SESSION_ID,
      );
      if (throughSequence === null) return [];
      return await this.#stores.readTranscriptMessagesSnapshot(WORKHUB_COORDINATION_SESSION_ID, {
        messageIds: RECORD_KINDS.map((kind) => recordMessageId(actionId, kind)),
        throughSequence,
        maxBytes: RECORD_READ_MAX_BYTES,
        maxMessages: RECORD_KINDS.length,
      });
    } catch (error) {
      if (error instanceof WorkHubActionEffectFailure) throw error;
      throw new WorkHubActionEffectFailure(
        'persistence_failed',
        'WorkHub delegation records are unavailable',
      );
    }
  }

  #projectRecord(
    actionId: string,
    messages: readonly StoredMessage[],
  ): WorkHubDelegationRecord | undefined {
    return projectRecord(actionId, messages);
  }
}

function projectRecord(
  actionId: string,
  messages: readonly StoredMessage[],
): WorkHubDelegationRecord | undefined {
  if (messages.length === 0) return undefined;
  const intent = messages.find(
    (message): message is WorkHubDelegationIntentMessage =>
      message.type === 'workhub_coordination' && message.kind === 'delegation_intent',
  );
  const committed = messages.find(
    (message): message is WorkHubDelegationCommittedMessage =>
      message.type === 'workhub_coordination' && message.kind === 'delegation_committed',
  );
  const abandoned = messages.find(
    (message): message is WorkHubDelegationAbandonedMessage =>
      message.type === 'workhub_coordination' && message.kind === 'delegation_abandoned',
  );
  if (
    messages.length !==
      Number(intent !== undefined) +
        Number(committed !== undefined) +
        Number(abandoned !== undefined) ||
    intent?.actionId !== actionId ||
    (committed !== undefined && (!intent || !sameMessageIntent(intent, committed))) ||
    (abandoned !== undefined && (!intent || !sameMessageIntent(intent, abandoned))) ||
    (committed !== undefined && abandoned !== undefined)
  ) {
    throw new WorkHubActionEffectFailure(
      'persistence_failed',
      'WorkHub delegation record chain is invalid',
    );
  }
  return committed
    ? commitRecord(committed)
    : abandoned
      ? abandonedRecord(abandoned)
      : intent
        ? intentRecord(intent)
        : undefined;
}

function intentMessage(intent: WorkHubDelegationIntent): WorkHubDelegationIntentMessage {
  return {
    type: 'workhub_coordination',
    id: recordMessageId(intent.actionId, 'delegation_intent'),
    turnId: intent.coordinationTurnId,
    ts: Date.now(),
    schemaVersion: WORKHUB_COORDINATION_RECORD_SCHEMA_VERSION,
    ...intent,
  };
}

function committedMessage(commit: WorkHubDelegationCommit): WorkHubDelegationCommittedMessage {
  return {
    type: 'workhub_coordination',
    id: recordMessageId(commit.actionId, 'delegation_committed'),
    turnId: commit.coordinationTurnId,
    ts: Date.now(),
    schemaVersion: WORKHUB_COORDINATION_RECORD_SCHEMA_VERSION,
    ...commit,
  };
}

function abandonedMessage(
  abandoned: WorkHubDelegationAbandoned,
): WorkHubDelegationAbandonedMessage {
  return {
    type: 'workhub_coordination',
    id: recordMessageId(abandoned.actionId, 'delegation_abandoned'),
    turnId: abandoned.coordinationTurnId,
    ts: Date.now(),
    schemaVersion: WORKHUB_COORDINATION_RECORD_SCHEMA_VERSION,
    ...abandoned,
  };
}

function intentRecord(message: WorkHubDelegationIntentMessage): WorkHubDelegationIntent {
  return {
    kind: message.kind,
    actionId: message.actionId,
    actionFingerprint: message.actionFingerprint,
    coordinationTurnId: message.coordinationTurnId,
    targetSessionId: message.targetSessionId,
    disposition: message.disposition,
    userText: message.userText,
    ...(message.create ? { create: message.create } : {}),
  };
}

function commitRecord(message: WorkHubDelegationCommittedMessage): WorkHubDelegationCommit {
  return {
    kind: 'delegation_committed',
    actionId: message.actionId,
    actionFingerprint: message.actionFingerprint,
    coordinationTurnId: message.coordinationTurnId,
    targetSessionId: message.targetSessionId,
    disposition: message.disposition,
    userText: message.userText,
    ...(message.create ? { create: message.create } : {}),
    delegationId: message.delegationId,
    targetTurnId: message.targetTurnId,
    ...(message.steered ? { steered: true as const } : {}),
  };
}

function abandonedRecord(message: WorkHubDelegationAbandonedMessage): WorkHubDelegationAbandoned {
  return {
    kind: 'delegation_abandoned',
    actionId: message.actionId,
    actionFingerprint: message.actionFingerprint,
    coordinationTurnId: message.coordinationTurnId,
    targetSessionId: message.targetSessionId,
    disposition: message.disposition,
    userText: message.userText,
    ...(message.create ? { create: message.create } : {}),
    reason: message.reason,
  };
}

function sameMessageIntent(
  intent: WorkHubDelegationIntentMessage,
  terminal: WorkHubDelegationCommittedMessage | WorkHubDelegationAbandonedMessage,
): boolean {
  return sameIntent(
    intentRecord(intent),
    terminal.kind === 'delegation_committed' ? commitRecord(terminal) : abandonedRecord(terminal),
  );
}

function sameIntent(
  left: WorkHubDelegationRecord,
  right: Omit<WorkHubDelegationIntent, 'kind'>,
): boolean {
  return (
    left.actionId === right.actionId &&
    left.actionFingerprint === right.actionFingerprint &&
    left.coordinationTurnId === right.coordinationTurnId &&
    left.targetSessionId === right.targetSessionId &&
    left.disposition === right.disposition &&
    left.userText === right.userText &&
    isDeepStrictEqual(left.create, right.create)
  );
}

function sameCommit(left: WorkHubDelegationCommit, right: WorkHubDelegationCommit): boolean {
  return (
    sameIntent(left, right) &&
    left.delegationId === right.delegationId &&
    left.targetTurnId === right.targetTurnId &&
    left.steered === right.steered
  );
}

function sameAbandoned(
  left: WorkHubDelegationAbandoned,
  right: WorkHubDelegationAbandoned,
): boolean {
  return left.reason === right.reason && sameIntent(left, right);
}

function recordMessageId(actionId: string, kind: (typeof RECORD_KINDS)[number]): string {
  return `whj_${createHash('sha256')
    .update(`${actionId}\0${kind}`, 'utf8')
    .digest('hex')
    .slice(0, 48)}`;
}

function actionConflict(): WorkHubActionEffectFailure {
  return new WorkHubActionEffectFailure(
    'operation_conflict',
    'WorkHub action identity belongs to different durable delegation content',
  );
}
