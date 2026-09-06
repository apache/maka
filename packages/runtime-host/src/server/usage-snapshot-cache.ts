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
import type { UsageSummaryV2 } from '@maka/core/usage-stats/types';
import type { UsageProvenance } from '@maka/core/usage-ledger-merge';
import {
  USAGE_SNAPSHOT_ACTIVITY_MAX_ITEMS,
  type EffectivePricingEntry,
  type LlmUsageLogProjection,
  type ToolUsageLogProjection,
} from '../protocol/index.js';

export const USAGE_SNAPSHOT_TTL_MS = 5 * 60 * 1_000;
export const USAGE_SNAPSHOT_HARD_TTL_MS = 30 * 60 * 1_000;
export const USAGE_SNAPSHOT_CAPACITY = 4;
// Admit one current and one replacement load without letting one connection
// occupy every globally available lease.
const USAGE_SNAPSHOT_CONNECTION_CAPACITY = 2;

export class UsageSnapshotCapacityError extends Error {
  constructor() {
    super('Usage snapshot capacity is occupied');
    this.name = 'UsageSnapshotCapacityError';
  }
}

export interface UsageSnapshotCacheOptions {
  readonly now?: () => number;
  readonly createRevision?: () => string;
  readonly ttlMs?: number;
  readonly hardTtlMs?: number;
  readonly capacity?: number;
  readonly activityLimit?: number;
}

export interface UsageSnapshotContents {
  readonly summary: UsageSummaryV2;
  readonly provenance: UsageProvenance;
  readonly llmRows: readonly LlmUsageLogProjection[];
  readonly llmTruncated: boolean;
  readonly toolRows: readonly ToolUsageLogProjection[];
  readonly toolTruncated: boolean;
  readonly pricingEntries: readonly EffectivePricingEntry[];
}

export interface RetainedUsageSnapshot extends UsageSnapshotContents {
  readonly revision: string;
}

export interface UsageSnapshotReservation {
  readonly revision: string;
}

interface BaseCacheEntry extends UsageSnapshotReservation {
  readonly connectionId: string;
  idleExpiresAt: number;
  readonly hardExpiresAt: number;
}

interface PendingCacheEntry extends BaseCacheEntry {
  readonly state: 'pending';
}

interface RetainedCacheEntry extends BaseCacheEntry, RetainedUsageSnapshot {
  readonly state: 'retained';
}

type CacheEntry = PendingCacheEntry | RetainedCacheEntry;

/** Host-epoch-local, connection-owned lease cache for coherent Settings Usage reads. */
export class UsageSnapshotCache {
  readonly activityLimit: number;
  readonly #now: () => number;
  readonly #createRevision: () => string;
  readonly #ttlMs: number;
  readonly #hardTtlMs: number;
  readonly #capacity: number;
  readonly #connectionCapacity: number;
  readonly #entries = new Map<string, CacheEntry>();

  constructor(options: UsageSnapshotCacheOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#createRevision = options.createRevision ?? randomUUID;
    this.#ttlMs = options.ttlMs ?? USAGE_SNAPSHOT_TTL_MS;
    this.#hardTtlMs = options.hardTtlMs ?? USAGE_SNAPSHOT_HARD_TTL_MS;
    this.#capacity = options.capacity ?? USAGE_SNAPSHOT_CAPACITY;
    this.#connectionCapacity = Math.min(USAGE_SNAPSHOT_CONNECTION_CAPACITY, this.#capacity);
    this.activityLimit = options.activityLimit ?? USAGE_SNAPSHOT_ACTIVITY_MAX_ITEMS;
    if (
      !Number.isSafeInteger(this.#ttlMs) ||
      this.#ttlMs <= 0 ||
      !Number.isSafeInteger(this.#hardTtlMs) ||
      this.#hardTtlMs <= 0 ||
      !Number.isSafeInteger(this.#capacity) ||
      this.#capacity <= 0 ||
      !Number.isSafeInteger(this.activityLimit) ||
      this.activityLimit <= 0 ||
      this.activityLimit > USAGE_SNAPSHOT_ACTIVITY_MAX_ITEMS
    ) {
      throw new TypeError('Invalid Usage snapshot cache limits');
    }
  }

  reserve(connectionId: string): UsageSnapshotReservation {
    const now = this.#now();
    this.#pruneExpired(now);
    let connectionEntries = 0;
    for (const entry of this.#entries.values()) {
      if (entry.connectionId === connectionId) connectionEntries += 1;
    }
    if (connectionEntries >= this.#connectionCapacity) {
      throw new UsageSnapshotCapacityError();
    }
    if (this.#entries.size >= this.#capacity) throw new UsageSnapshotCapacityError();
    const revision = this.#createRevision();
    if (revision.length === 0 || revision.length > 128 || this.#entries.has(revision)) {
      throw new Error('Usage snapshot revision generator returned an invalid revision');
    }
    const hardExpiresAt = now + this.#hardTtlMs;
    const entry: PendingCacheEntry = {
      revision,
      connectionId,
      state: 'pending',
      // Both deadlines begin at reservation so capture and projection time can
      // never escape either the renewable idle bound or the hard lifetime.
      idleExpiresAt: Math.min(now + this.#ttlMs, hardExpiresAt),
      hardExpiresAt,
    };
    this.#entries.set(revision, entry);
    return entry;
  }

  finalize(
    connectionId: string,
    revision: string,
    contents: UsageSnapshotContents,
  ): RetainedUsageSnapshot | undefined {
    const now = this.#now();
    this.#pruneExpired(now);
    const reservation = this.#entries.get(revision);
    if (
      !reservation ||
      reservation.state !== 'pending' ||
      reservation.connectionId !== connectionId
    ) {
      return undefined;
    }
    const retained: RetainedCacheEntry = {
      revision,
      ...contents,
      connectionId,
      state: 'retained',
      idleExpiresAt: reservation.idleExpiresAt,
      hardExpiresAt: reservation.hardExpiresAt,
    };
    this.#entries.set(revision, retained);
    return retained;
  }

  get(connectionId: string, revision: string): RetainedUsageSnapshot | undefined {
    const now = this.#now();
    this.#pruneExpired(now);
    const entry = this.#entries.get(revision);
    if (!entry || entry.state !== 'retained' || entry.connectionId !== connectionId) {
      return undefined;
    }
    entry.idleExpiresAt = Math.min(now + this.#ttlMs, entry.hardExpiresAt);
    return entry;
  }

  abort(connectionId: string, revision: string): void {
    this.release(connectionId, revision);
  }

  release(connectionId: string, revision: string): void {
    const entry = this.#entries.get(revision);
    if (entry?.connectionId === connectionId) this.#entries.delete(revision);
  }

  releaseConnection(connectionId: string): void {
    for (const [revision, entry] of this.#entries) {
      if (entry.connectionId === connectionId) this.#entries.delete(revision);
    }
  }

  #pruneExpired(now: number): void {
    for (const [revision, entry] of this.#entries) {
      if (entry.idleExpiresAt <= now || entry.hardExpiresAt <= now) {
        this.#entries.delete(revision);
      }
    }
  }
}
