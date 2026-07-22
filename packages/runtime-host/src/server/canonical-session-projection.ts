import type { SessionHeader } from '@maka/core/session';
import type { ExecutionStoresWriter } from '@maka/storage/execution-stores';
import type {
  SessionContinuityIdentity,
  SessionMessageQueueProjection,
  TurnSnapshot,
} from '../protocol/index.js';
import { isMissingFile, readCanonicalTurnSnapshot } from './canonical-turn-snapshot.js';
import type { HostMessageCoordinator } from './message-coordinator.js';
import type { RootAdmissionOwner } from './root-admission-owner.js';

type CanonicalSessionProjectionStores = Pick<
  ExecutionStoresWriter<'interactive'>,
  'sessionStore' | 'agentRunStore' | 'runtimeEventStore'
>;

export interface CanonicalSessionProjection {
  readonly session: SessionContinuityIdentity;
  readonly rootTurn: TurnSnapshot | null;
  readonly queue: SessionMessageQueueProjection;
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
    return { session, rootTurn, queue };
  }
}
