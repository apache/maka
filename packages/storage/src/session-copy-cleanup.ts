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

import { randomUUID } from 'node:crypto';
import { acquireOperationalStateDatabase } from './operational-state-store.js';
import {
  isProcessLifetimeOwnerReference,
  type ProcessLifetimeOwner,
  type ProcessLifetimeRecoveryClaim,
} from './process-lifetime-owner.js';

export interface SessionCopyCreationLease {
  sessionId: string;
  kind: 'branch' | 'revision';
  sourceSessionId: string;
  sourceTurnId: string;
  intent?: 'side_conversation';
  ownerId: string;
}

interface PersistedSessionCopyLease {
  version: 1;
  sessionId: string;
  trackedAt: number;
  ownerProcessId?: string;
  ownerLifetimeRef?: string;
  ownerId?: string;
  phase: 'creating' | 'live' | 'cleanup';
  cancelRequested: boolean;
  creation?: Omit<SessionCopyCreationLease, 'sessionId' | 'ownerId'>;
}

interface SessionCopyCleanupStore {
  list(): Promise<PersistedSessionCopyLease[]>;
  read(sessionId: string): Promise<PersistedSessionCopyLease | undefined>;
  beginCreation(
    creation: SessionCopyCreationLease,
    ownerProcessId: string,
    ownerLifetimeRef?: string,
  ): Promise<PersistedSessionCopyLease>;
  markLive(sessionId: string): Promise<PersistedSessionCopyLease | undefined>;
  requestCleanup(sessionId: string): Promise<PersistedSessionCopyLease>;
  markCleanup(sessionId: string): Promise<PersistedSessionCopyLease | undefined>;
  forget(sessionId: string): Promise<void>;
}

export type SessionCopyCleanupDisposition = 'removed' | 'retained';

export interface SessionCopyCleanupRecovery {
  removed: string[];
  failed: Array<{ sessionId: string; error: unknown }>;
}

export interface SessionCopyCleanupAuthority {
  ownCreation<T>(creation: SessionCopyCreationLease, operation: () => Promise<T>): Promise<T>;
  rejectCreation(sessionId: string): Promise<void>;
  cleanup(sessionId: string): Promise<void>;
  schedule(sessionId: string): Promise<void>;
  abandonOwner(ownerId: string): Promise<void>;
  recover(): Promise<SessionCopyCleanupRecovery>;
}

export function createSessionCopyCleanupAuthority(input: {
  workspaceRoot: string;
  removeSession: (sessionId: string) => Promise<SessionCopyCleanupDisposition | void>;
  resumeSessionCopy?: (creation: Omit<SessionCopyCreationLease, 'ownerId'>) => Promise<void>;
  processId?: string;
  isOwnerProcessActive?: (ownerProcessId: string) => boolean | Promise<boolean>;
  processLifetimeOwner?: ProcessLifetimeOwner;
}): SessionCopyCleanupAuthority {
  return new SessionCopyCleanupAuthorityImpl(
    new SqliteSessionCopyCleanupStore(input.workspaceRoot),
    input.removeSession,
    input.resumeSessionCopy,
    input.processId ?? randomUUID(),
    input.isOwnerProcessActive,
    input.processLifetimeOwner,
  );
}

class SessionCopyCleanupAuthorityImpl implements SessionCopyCleanupAuthority {
  private readonly creations = new Map<
    string,
    { creation: SessionCopyCreationLease; operation: Promise<unknown> }
  >();
  private readonly cleanups = new Map<string, Promise<SessionCopyCleanupDisposition>>();

  constructor(
    private readonly store: SessionCopyCleanupStore,
    private readonly removeSession: (
      sessionId: string,
    ) => Promise<SessionCopyCleanupDisposition | void>,
    private readonly resumeSessionCopy:
      | ((creation: Omit<SessionCopyCreationLease, 'ownerId'>) => Promise<void>)
      | undefined,
    private readonly processId: string,
    private readonly isOwnerProcessActive:
      | ((ownerProcessId: string) => boolean | Promise<boolean>)
      | undefined,
    private readonly processLifetimeOwner: ProcessLifetimeOwner | undefined,
  ) {}

  ownCreation<T>(creation: SessionCopyCreationLease, operation: () => Promise<T>): Promise<T> {
    const normalized = normalizeCreationLease(creation);
    const active = this.creations.get(normalized.sessionId);
    if (active) {
      if (!sameCreation(active.creation, normalized)) {
        return Promise.reject(new Error('Session copy identity changed while creation was active'));
      }
      return active.operation as Promise<T>;
    }
    const task = (async () => {
      try {
        await this.store.beginCreation(
          normalized,
          this.processId,
          this.processLifetimeOwner?.reference,
        );
        const result = await operation();
        const record = await this.store.markLive(normalized.sessionId);
        if (record?.cancelRequested) void this.settleCleanup(normalized.sessionId);
        return result;
      } finally {
        this.creations.delete(normalized.sessionId);
      }
    })();
    this.creations.set(normalized.sessionId, { creation: normalized, operation: task });
    return task;
  }

  async rejectCreation(sessionId: string): Promise<void> {
    const normalized = normalizeSessionId(sessionId);
    await this.creations.get(normalized)?.operation.catch(() => undefined);
    const record = await this.store.read(normalized);
    if (!record) return;
    if (record.phase !== 'creating') {
      throw new Error(`Session copy ${normalized} is no longer awaiting creation`);
    }
    await this.store.forget(normalized);
  }

  async cleanup(sessionId: string): Promise<void> {
    const normalized = normalizeSessionId(sessionId);
    const active = this.cleanups.get(normalized);
    if (active) {
      await active;
      return;
    }
    await this.store.requestCleanup(normalized);
    await this.settleCleanup(normalized);
  }

  async schedule(sessionId: string): Promise<void> {
    const normalized = normalizeSessionId(sessionId);
    if (this.cleanups.has(normalized)) return;
    await this.store.requestCleanup(normalized);
    void this.settleCleanup(normalized).catch(() => undefined);
  }

  async abandonOwner(ownerId: string): Promise<void> {
    const normalizedOwnerId = normalizeOwnerId(ownerId);
    const owned = (await this.store.list()).filter((record) => {
      const currentIncarnation = this.processLifetimeOwner
        ? record.ownerLifetimeRef === this.processLifetimeOwner.reference
        : record.ownerProcessId === this.processId;
      return currentIncarnation && record.ownerId === normalizedOwnerId;
    });
    await Promise.all(owned.map((record) => this.schedule(record.sessionId)));
  }

  async recover(): Promise<SessionCopyCleanupRecovery> {
    const removed: string[] = [];
    const failed: SessionCopyCleanupRecovery['failed'] = [];
    const lifetimeGroups = new Map<string, PersistedSessionCopyLease[]>();
    for (const record of await this.store.list()) {
      if (
        record.ownerLifetimeRef &&
        this.processLifetimeOwner &&
        isProcessLifetimeOwnerReference(record.ownerLifetimeRef)
      ) {
        if (record.ownerLifetimeRef === this.processLifetimeOwner.reference) continue;
        const group = lifetimeGroups.get(record.ownerLifetimeRef) ?? [];
        group.push(record);
        lifetimeGroups.set(record.ownerLifetimeRef, group);
        continue;
      }
      if (
        record.ownerLifetimeRef === undefined &&
        (record.phase === 'cleanup' || record.cancelRequested)
      ) {
        await this.recoverRecord(record, removed, failed);
        continue;
      }
      try {
        const staleOwner =
          record.ownerProcessId !== undefined &&
          record.ownerProcessId !== this.processId &&
          !(await this.isOwnerProcessActive?.(record.ownerProcessId));
        if (staleOwner) await this.recoverRecord(record, removed, failed);
      } catch (error) {
        failed.push({ sessionId: record.sessionId, error });
      }
    }
    for (const [reference, records] of lifetimeGroups) {
      let claim: ProcessLifetimeRecoveryClaim | undefined;
      try {
        claim = await this.processLifetimeOwner?.tryClaimReleased(reference);
      } catch (error) {
        for (const record of records) failed.push({ sessionId: record.sessionId, error });
        continue;
      }
      if (!claim) continue;
      try {
        for (const record of records) await this.recoverRecord(record, removed, failed);
        const ownerStillReferenced = await this.store
          .list()
          .then((current) => current.some((record) => record.ownerLifetimeRef === reference))
          .catch(() => true);
        if (!ownerStillReferenced) await claim.retire().catch(() => undefined);
      } finally {
        await claim.close().catch(() => undefined);
      }
    }
    if (this.processLifetimeOwner) {
      const referenced = await this.store
        .list()
        .then(
          (records) =>
            new Set(
              records.flatMap((record) =>
                record.ownerLifetimeRef ? [record.ownerLifetimeRef] : [],
              ),
            ),
        )
        .catch(() => undefined);
      if (referenced) {
        await this.processLifetimeOwner
          .retireUnreferencedReleasedOwners(referenced)
          .catch(() => undefined);
      }
    }
    return { removed, failed };
  }

  private async recoverRecord(
    record: PersistedSessionCopyLease,
    removed: string[],
    failed: SessionCopyCleanupRecovery['failed'],
  ): Promise<void> {
    try {
      await this.store.requestCleanup(record.sessionId);
      const disposition = await this.settleCleanup(record.sessionId);
      if (disposition === 'removed') removed.push(record.sessionId);
    } catch (error) {
      failed.push({ sessionId: record.sessionId, error });
    }
  }

  private settleCleanup(sessionId: string): Promise<SessionCopyCleanupDisposition> {
    const active = this.cleanups.get(sessionId);
    if (active) return active;
    const operation = this.cleanupOnce(sessionId).finally(() => {
      this.cleanups.delete(sessionId);
    });
    this.cleanups.set(sessionId, operation);
    return operation;
  }

  private async cleanupOnce(sessionId: string): Promise<SessionCopyCleanupDisposition> {
    await this.creations.get(sessionId)?.operation.catch(() => undefined);
    let record = await this.store.read(sessionId);
    if (!record) return 'removed';
    if (record.phase === 'creating') {
      if (!record.creation || !this.resumeSessionCopy) {
        throw new Error(`Session copy ${sessionId} cannot resolve its creating lease`);
      }
      await this.resumeSessionCopy({ sessionId, ...record.creation });
      record = await this.store.markCleanup(sessionId);
    } else if (record.phase === 'live') {
      record = await this.store.markCleanup(sessionId);
    }
    if (!record) return 'removed';
    const disposition = (await this.removeSession(sessionId)) ?? 'removed';
    await this.store.forget(sessionId);
    return disposition;
  }
}

class SqliteSessionCopyCleanupStore implements SessionCopyCleanupStore {
  constructor(private readonly workspaceRoot: string) {}

  async list(): Promise<PersistedSessionCopyLease[]> {
    return this.withDatabase('read', (database) =>
      (
        database
          .prepare(`
            SELECT session_id AS sessionId, tracked_at AS trackedAt, record_json AS recordJson
            FROM workflow_quote_companion_cleanup
            ORDER BY tracked_at, session_id
          `)
          .all() as Array<{ sessionId: string; trackedAt: number; recordJson: string }>
      ).map(decodeLeaseRow),
    );
  }

  async read(sessionId: string): Promise<PersistedSessionCopyLease | undefined> {
    return this.withDatabase('read', (database) => {
      const row = database
        .prepare(`
          SELECT session_id AS sessionId, tracked_at AS trackedAt, record_json AS recordJson
          FROM workflow_quote_companion_cleanup
          WHERE session_id = ?
        `)
        .get(sessionId) as { sessionId: string; trackedAt: number; recordJson: string } | undefined;
      return row ? decodeLeaseRow(row) : undefined;
    });
  }

  async beginCreation(
    creation: SessionCopyCreationLease,
    ownerProcessId: string,
    ownerLifetimeRef?: string,
  ): Promise<PersistedSessionCopyLease> {
    return this.mutate(creation.sessionId, (current) => {
      if (current?.creation && !samePersistedCreation(current.creation, creation)) {
        throw new Error('Session copy target is already bound to another creation');
      }
      if (current?.phase === 'cleanup' || current?.cancelRequested) {
        throw new Error('Session copy target is already scheduled for cleanup');
      }
      return {
        version: 1,
        sessionId: creation.sessionId,
        trackedAt: current?.trackedAt ?? Date.now(),
        ownerProcessId,
        ...(ownerLifetimeRef ? { ownerLifetimeRef } : {}),
        ownerId: creation.ownerId,
        phase: current?.phase ?? 'creating',
        cancelRequested: false,
        creation: {
          kind: creation.kind,
          sourceSessionId: creation.sourceSessionId,
          sourceTurnId: creation.sourceTurnId,
          ...(creation.intent ? { intent: creation.intent } : {}),
        },
      };
    });
  }

  async markLive(sessionId: string): Promise<PersistedSessionCopyLease | undefined> {
    return this.mutateOptional(sessionId, (current) =>
      current.phase === 'creating' ? { ...current, phase: 'live' } : current,
    );
  }

  async requestCleanup(sessionId: string): Promise<PersistedSessionCopyLease> {
    return this.mutate(sessionId, (current) => {
      if (!current) {
        return {
          version: 1,
          sessionId,
          trackedAt: Date.now(),
          phase: 'cleanup',
          cancelRequested: true,
        };
      }
      return current.phase === 'creating'
        ? { ...current, cancelRequested: true }
        : { ...current, phase: 'cleanup', cancelRequested: true };
    });
  }

  async markCleanup(sessionId: string): Promise<PersistedSessionCopyLease | undefined> {
    return this.mutateOptional(sessionId, (current) => ({
      ...current,
      phase: 'cleanup',
      cancelRequested: true,
    }));
  }

  async forget(sessionId: string): Promise<void> {
    this.withDatabase('write', (database) => {
      database
        .prepare('DELETE FROM workflow_quote_companion_cleanup WHERE session_id = ?')
        .run(sessionId);
    });
  }

  private mutate(
    sessionId: string,
    update: (current: PersistedSessionCopyLease | undefined) => PersistedSessionCopyLease,
  ): PersistedSessionCopyLease {
    return this.withDatabase('write', (database) => {
      const current = readLease(database, sessionId);
      const next = update(current);
      writeLease(database, next);
      return next;
    });
  }

  private mutateOptional(
    sessionId: string,
    update: (current: PersistedSessionCopyLease) => PersistedSessionCopyLease,
  ): PersistedSessionCopyLease | undefined {
    return this.withDatabase('write', (database) => {
      const current = readLease(database, sessionId);
      if (!current) return undefined;
      const next = update(current);
      writeLease(database, next);
      return next;
    });
  }

  private withDatabase<T>(
    mode: 'read' | 'write',
    operation: (database: import('node:sqlite').DatabaseSync) => T,
  ): T {
    const lease = acquireOperationalStateDatabase(this.workspaceRoot);
    try {
      return lease.transaction(mode, () => operation(lease.database));
    } finally {
      lease.close();
    }
  }
}

function readLease(
  database: import('node:sqlite').DatabaseSync,
  sessionId: string,
): PersistedSessionCopyLease | undefined {
  const row = database
    .prepare(`
      SELECT session_id AS sessionId, tracked_at AS trackedAt, record_json AS recordJson
      FROM workflow_quote_companion_cleanup
      WHERE session_id = ?
    `)
    .get(sessionId) as { sessionId: string; trackedAt: number; recordJson: string } | undefined;
  return row ? decodeLeaseRow(row) : undefined;
}

function writeLease(
  database: import('node:sqlite').DatabaseSync,
  record: PersistedSessionCopyLease,
): void {
  database
    .prepare(`
      INSERT INTO workflow_quote_companion_cleanup(session_id, tracked_at, record_json)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        tracked_at = excluded.tracked_at,
        record_json = excluded.record_json
    `)
    .run(record.sessionId, record.trackedAt, JSON.stringify(record));
}

function decodeLeaseRow(row: {
  sessionId: string;
  trackedAt: number;
  recordJson: string;
}): PersistedSessionCopyLease {
  const value = JSON.parse(row.recordJson) as Partial<PersistedSessionCopyLease>;
  if (
    value.version !== 1 ||
    value.sessionId !== row.sessionId ||
    (value.phase !== 'creating' && value.phase !== 'live' && value.phase !== 'cleanup') ||
    typeof value.cancelRequested !== 'boolean' ||
    (value.ownerLifetimeRef !== undefined && typeof value.ownerLifetimeRef !== 'string')
  ) {
    throw new Error(`Invalid Session copy lease: ${row.sessionId}`);
  }
  return { ...value, trackedAt: row.trackedAt } as PersistedSessionCopyLease;
}

function normalizeCreationLease(creation: SessionCopyCreationLease): SessionCopyCreationLease {
  return {
    sessionId: normalizeSessionId(creation.sessionId),
    kind: creation.kind,
    sourceSessionId: normalizeSessionId(creation.sourceSessionId),
    sourceTurnId: normalizeSessionId(creation.sourceTurnId),
    ...(creation.intent === 'side_conversation' ? { intent: creation.intent } : {}),
    ownerId: normalizeOwnerId(creation.ownerId),
  };
}

function sameCreation(left: SessionCopyCreationLease, right: SessionCopyCreationLease): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.kind === right.kind &&
    left.sourceSessionId === right.sourceSessionId &&
    left.sourceTurnId === right.sourceTurnId &&
    left.intent === right.intent &&
    left.ownerId === right.ownerId
  );
}

function samePersistedCreation(
  left: NonNullable<PersistedSessionCopyLease['creation']>,
  right: SessionCopyCreationLease,
): boolean {
  return (
    left.kind === right.kind &&
    left.sourceSessionId === right.sourceSessionId &&
    left.sourceTurnId === right.sourceTurnId &&
    left.intent === right.intent
  );
}

function normalizeSessionId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid Session copy id');
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(normalized)) {
    throw new Error('Invalid Session copy id');
  }
  return normalized;
}

function normalizeOwnerId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid Session copy owner id');
  const normalized = value.trim();
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(normalized)) {
    throw new Error('Invalid Session copy owner id');
  }
  return normalized;
}
