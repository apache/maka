import type { SessionHeader } from '@maka/core/session';
import type { ExecutionStoresWriter } from '@maka/storage/execution-stores';
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

type CanonicalSessionProjectionStores = Pick<
  ExecutionStoresWriter<'interactive'>,
  'sessionStore' | 'agentRunStore' | 'runtimeEventStore' | 'interactionStore'
>;

export interface CanonicalSessionProjection {
  readonly session: SessionContinuityIdentity;
  readonly rootTurn: TurnSnapshot | null;
  readonly goal: GoalProjection | null;
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
  readonly readGoal?: (sessionId: string) => GoalProjection | null;
}

export class CanonicalSessionProjectionReader {
  readonly #stores: CanonicalSessionProjectionStores;
  readonly #rootAdmissions: RootAdmissionOwner;
  readonly #messages: Pick<HostMessageCoordinator, 'projection'>;
  readonly #readGoal: (sessionId: string) => GoalProjection | null;

  constructor(options: CanonicalSessionProjectionReaderOptions) {
    this.#stores = options.stores;
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
      if (isMissingFile(error)) return null;
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
    // The Session lane barrier must remain held through this final synchronous read.
    const queue = this.#messages.projection(sessionId);
    const goal = this.#readGoal(sessionId);
    const session: SessionContinuityIdentity = {
      sessionId: header.id,
      metadataRevision,
      status: header.status,
      createdAt: header.createdAt,
      lastUsedAt: header.lastUsedAt,
      isArchived: header.isArchived,
      ...(header.archivedAt !== undefined ? { archivedAt: header.archivedAt } : {}),
    };
    return { session, rootTurn, goal, queue, interactions };
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
  return {
    schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
    session: canonical.session,
    projectionRevision,
    rootTurn: canonical.rootTurn,
    goal: canonical.goal,
    queue: canonical.queue,
    interactions: canonical.interactions,
  };
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
