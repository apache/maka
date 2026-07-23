import type { SessionHeader } from '@maka/core/session';
import type { ExecutionStoresWriter } from '@maka/storage/execution-stores';
import type {
  SessionContinuitySnapshot,
  SessionContinuityIdentity,
  SessionInteractionProjection,
  SessionMessageQueueProjection,
  TurnSnapshot,
} from '../protocol/index.js';
import {
  decodeSessionContinuitySnapshot,
  SESSION_CONTINUITY_SCHEMA_VERSION,
  SESSION_CONTINUITY_SNAPSHOT_MAX_BYTES,
} from '../protocol/index.js';
import { isMissingFile, readCanonicalTurnSnapshot } from './canonical-turn-snapshot.js';
import type { HostMessageCoordinator } from './message-coordinator.js';
import { projectSessionInteractions } from './interaction-projection.js';
import type { RootAdmissionOwner } from './root-admission-owner.js';

type CanonicalSessionProjectionStores = Pick<
  ExecutionStoresWriter<'interactive'>,
  'sessionStore' | 'agentRunStore' | 'runtimeEventStore' | 'interactionStore'
>;

export interface CanonicalSessionProjection {
  readonly session: SessionContinuityIdentity;
  readonly rootTurn: TurnSnapshot | null;
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
}

export class CanonicalSessionProjectionReader {
  readonly #stores: CanonicalSessionProjectionStores;
  readonly #rootAdmissions: RootAdmissionOwner;
  readonly #messages: Pick<HostMessageCoordinator, 'projection'>;

  constructor(options: CanonicalSessionProjectionReaderOptions) {
    this.#stores = options.stores;
    this.#rootAdmissions = options.rootAdmissions;
    this.#messages = options.messages;
  }

  async read(sessionId: string): Promise<CanonicalSessionProjection | null> {
    const admission = this.#rootAdmissions.latestAdmission(sessionId);
    let header: SessionHeader;
    try {
      header = await this.#stores.sessionStore.readHeaderSnapshot(sessionId);
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
      await this.#stores.interactionStore.listPending({ sessionId }),
    );
    // The Session lane barrier must remain held through this final synchronous read.
    const queue = this.#messages.projection(sessionId);
    const session: SessionContinuityIdentity = {
      sessionId: header.id,
      status: header.status,
      createdAt: header.createdAt,
      lastUsedAt: header.lastUsedAt,
      isArchived: header.isArchived,
      ...(header.archivedAt !== undefined ? { archivedAt: header.archivedAt } : {}),
    };
    return { session, rootTurn, queue, interactions };
  }

  async fitsCandidate(
    sessionId: string,
    candidate: CanonicalSessionProjectionCandidate,
  ): Promise<boolean> {
    const canonical = await this.read(sessionId);
    if (!canonical) return false;
    const candidateProjection = { ...canonical, ...candidate };
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
    queue: canonical.queue,
    interactions: canonical.interactions,
  };
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
