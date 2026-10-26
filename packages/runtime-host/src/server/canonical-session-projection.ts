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

import type { SessionHeader } from '@maka/core/session';
import { isSessionNotFoundError, type ExecutionStoresWriter } from '@maka/storage/execution-stores';
import type {
  SessionContinuitySnapshot,
  SessionContinuityIdentity,
  SessionInteractionProjection,
  SessionMessageQueueProjection,
  GoalProjection,
  TurnSnapshot,
} from '../protocol/index.js';
import {
  decodeSessionContinuitySnapshot,
  SESSION_CONTINUITY_SCHEMA_VERSION,
  SESSION_CONTINUITY_SNAPSHOT_MAX_BYTES,
} from '../protocol/index.js';
import {
  isMissingFile,
  readCanonicalTurnSnapshot,
  worstCaseFailedTurnSnapshot,
} from './canonical-turn-snapshot.js';
import type { HostMessageCoordinator } from './message-coordinator.js';
import { worstCaseMessageQueueProjection } from './message-queue-capacity.js';
import { projectSessionInteractions } from './interaction-projection.js';
import type { RootAdmissionOwner } from './root-admission-owner.js';
import { worstCaseGoalProjection } from './goal-projection.js';

import type { SessionEventWaitsProjection } from '../protocol/event-wait.js';
type CanonicalSessionProjectionStores = Pick<
  ExecutionStoresWriter<'interactive'>,
  'sessionStore' | 'agentRunStore' | 'runtimeEventStore' | 'interactionStore'
>;

export interface CanonicalSessionProjection {
  readonly session: SessionContinuityIdentity;
  readonly rootTurn: TurnSnapshot | null;
  readonly goal: GoalProjection | null;
  readonly eventWaits?: SessionEventWaitsProjection;
  readonly queue: SessionMessageQueueProjection;
  readonly interactions: SessionInteractionProjection;
}

export interface CanonicalSessionProjectionCandidate {
  readonly queue?: SessionMessageQueueProjection;
  readonly interactions?: SessionInteractionProjection;
}

export interface CanonicalSessionProjectionReaderOptions {
  readonly stores: CanonicalSessionProjectionStores;
  readonly rootAdmissions: RootAdmissionOwner;
  readonly messages: Pick<HostMessageCoordinator, 'projection'>;
  readonly readEventWaits?: (sessionId: string) => Promise<SessionEventWaitsProjection>;
  readonly readGoal?: (sessionId: string) => GoalProjection | null | Promise<GoalProjection | null>;
}

export class CanonicalSessionProjectionReader {
  readonly #stores: CanonicalSessionProjectionStores;
  readonly #rootAdmissions: RootAdmissionOwner;
  readonly #messages: Pick<HostMessageCoordinator, 'projection'>;
  readonly #readEventWaits: CanonicalSessionProjectionReaderOptions['readEventWaits'];
  readonly #readGoal: (sessionId: string) => GoalProjection | null | Promise<GoalProjection | null>;

  constructor(options: CanonicalSessionProjectionReaderOptions) {
    this.#stores = options.stores;
    this.#readEventWaits = options.readEventWaits;
    this.#rootAdmissions = options.rootAdmissions;
    this.#messages = options.messages;
    this.#readGoal = options.readGoal ?? (() => null);
  }

  async read(sessionId: string): Promise<CanonicalSessionProjection | null> {
    const admission = this.#rootAdmissions.latestAdmission(sessionId);
    let header: SessionHeader;
    let metadataRevision: number;
    try {
      const record = await this.#stores.sessionStore.readHeaderRecordSnapshot(sessionId);
      header = record.header;
      metadataRevision = record.revision;
    } catch (error) {
      if (isMissingFile(error) || isSessionNotFoundError(error)) return null;
      throw error;
    }
    if (header.id !== sessionId) {
      throw new Error('Durable Session identity does not match the requested Session');
    }

    let rootTurn: TurnSnapshot | null = null;
    if (admission) {
      const durableAdmission = await this.#stores.agentRunStore.readRootTurnAdmission(
        sessionId,
        admission.turnId,
      );
      if (!durableAdmission) {
        throw new Error('Owned Root Turn admission is missing from durable storage');
      }
      this.#rootAdmissions.assertKnownAdmission(durableAdmission);
      rootTurn = await readCanonicalTurnSnapshot(this.#stores, durableAdmission);
    }

    const interactions = projectSessionInteractions(
      await this.#stores.interactionStore.listSessionPending(sessionId),
      await this.#stores.sessionStore.listPendingSandboxBoundaryRequests(sessionId),
    );
    // Keep the Session lane across the asynchronous Goal/wait read and the
    // final queue projection; neither read can authorize a second admission.
    const goal = await this.#readGoal(sessionId);
    const queue = this.#messages.projection(sessionId);
    const session: SessionContinuityIdentity = {
      sessionId: header.id,
      metadataRevision,
      status: header.status,
      createdAt: header.createdAt,
      isArchived: header.isArchived,
    };
    const eventWaits = await this.#readEventWaits?.(sessionId);
    return { session, rootTurn, goal, queue, interactions, ...(eventWaits ? { eventWaits } : {}) };
  }

  async fitsCandidate(
    sessionId: string,
    candidate: CanonicalSessionProjectionCandidate,
  ): Promise<boolean> {
    const canonical = await this.read(sessionId);
    if (!canonical) return false;
    const candidateProjection = {
      ...canonical,
      ...candidate,
      rootTurn:
        canonical.rootTurn &&
        canonical.rootTurn.status !== 'completed' &&
        canonical.rootTurn.status !== 'failed' &&
        canonical.rootTurn.status !== 'cancelled'
          ? worstCaseFailedTurnSnapshot(canonical.rootTurn)
          : canonical.rootTurn,
      goal: worstCaseGoalProjection(sessionId),
      queue: worstCaseMessageQueueProjection(candidate.queue ?? canonical.queue),
    };
    const snapshotInput = sessionContinuitySnapshotInput(
      candidateProjection,
      Number.MAX_SAFE_INTEGER,
    );
    try {
      createSessionContinuitySnapshot(candidateProjection, Number.MAX_SAFE_INTEGER);
      return true;
    } catch (error) {
      let encoded: string | undefined;
      try {
        encoded = JSON.stringify(snapshotInput);
      } catch {
        throw error;
      }
      if (
        encoded !== undefined &&
        Buffer.byteLength(encoded, 'utf8') > SESSION_CONTINUITY_SNAPSHOT_MAX_BYTES
      ) {
        return false;
      }
      throw error;
    }
  }
}

export function createSessionContinuitySnapshot(
  canonical: CanonicalSessionProjection,
  projectionRevision: number,
): SessionContinuitySnapshot {
  return deepFreeze(
    decodeSessionContinuitySnapshot(sessionContinuitySnapshotInput(canonical, projectionRevision)),
  );
}

function sessionContinuitySnapshotInput(
  canonical: CanonicalSessionProjection,
  projectionRevision: number,
): SessionContinuitySnapshot {
  const snapshot: SessionContinuitySnapshot = {
    schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
    session: canonical.session,
    projectionRevision,
    rootTurn: canonical.rootTurn,
    goal: canonical.goal,
    ...(canonical.eventWaits ? { eventWaits: canonical.eventWaits } : {}),
    queue: canonical.queue,
    interactions: canonical.interactions,
  };
  // Waits are independently paginated and invalidated. Their optional preview
  // must not consume capacity already promised to admitted messages, interactions,
  // or a later terminal Root/Goal projection. Keep the required facts strict.
  if (
    snapshot.eventWaits &&
    Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > SESSION_CONTINUITY_SNAPSHOT_MAX_BYTES
  ) {
    const { eventWaits: _preview, ...required } = snapshot;
    return required;
  }
  return snapshot;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
