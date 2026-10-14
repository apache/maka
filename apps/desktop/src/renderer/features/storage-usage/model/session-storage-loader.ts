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
  STORAGE_USAGE_SESSION_MAX_ITEMS,
  type SessionStorageUsage,
} from '@maka/runtime-host/protocol';

/** A measured size is reused this long before a remounted row asks again. */
export const SESSION_STORAGE_RESULT_TTL_MS = 60_000;
/** A task that could not be measured is not asked about again this soon. */
export const SESSION_STORAGE_FAILURE_COOLDOWN_MS = 30_000;
/** Settled entries kept at most; the oldest are dropped first. */
export const SESSION_STORAGE_CACHE_MAX_ENTRIES = 1_000;

export interface SessionStorageLoader {
  /** Resolves undefined when the size is unknown: unmeasurable or not on its Host. */
  load(sessionId: string): Promise<SessionStorageUsage | undefined>;
  /** Entries currently cached, settled or in flight. */
  size(): number;
}

interface Entry {
  readonly result: Promise<SessionStorageUsage | undefined>;
  settledAt?: number;
  measured?: boolean;
}

/**
 * Turns row requests into Host queries. Rows that scroll into view together
 * are queued and measured one request at a time, at most
 * `STORAGE_USAGE_SESSION_MAX_ITEMS` per request, so a long list never puts
 * more than one measurement on a Host at once. Results and failures are both remembered for a while, so remounting a
 * list neither re-measures every row nor hammers a Host that just failed.
 */
export function createSessionStorageLoader(
  loadSessionUsage: (
    sessionIds: readonly string[],
  ) => Promise<Readonly<Record<string, SessionStorageUsage>>>,
  options: { readonly now?: () => number } = {},
): SessionStorageLoader {
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const queue = new Map<string, (usage: SessionStorageUsage | undefined) => void>();
  let draining = false;

  const settle = (sessionId: string, usage: SessionStorageUsage | undefined) => {
    const entry = entries.get(sessionId);
    if (entry) {
      entry.settledAt = now();
      entry.measured = usage !== undefined;
    }
  };

  const isFresh = (entry: Entry): boolean => {
    if (entry.settledAt === undefined) return true;
    const ttl = entry.measured ? SESSION_STORAGE_RESULT_TTL_MS : SESSION_STORAGE_FAILURE_COOLDOWN_MS;
    return now() - entry.settledAt < ttl;
  };

  /** Drops expired entries, then the oldest settled ones beyond the cap. */
  const prune = () => {
    for (const [sessionId, entry] of entries) {
      if (!isFresh(entry)) entries.delete(sessionId);
    }
    let excess = entries.size - SESSION_STORAGE_CACHE_MAX_ENTRIES;
    for (const [sessionId, entry] of entries) {
      if (excess <= 0) break;
      if (entry.settledAt === undefined) continue;
      entries.delete(sessionId);
      excess -= 1;
    }
  };

  const drain = async () => {
    prune();
    while (queue.size > 0) {
      const chunk = [...queue.entries()].slice(0, STORAGE_USAGE_SESSION_MAX_ITEMS);
      for (const [sessionId] of chunk) queue.delete(sessionId);
      let usage: Readonly<Record<string, SessionStorageUsage>> = {};
      try {
        usage = await loadSessionUsage(chunk.map(([sessionId]) => sessionId));
      } catch {
        // Every id in the chunk settles as unknown and enters its cooldown.
      }
      for (const [sessionId, resolve] of chunk) {
        const measured = usage[sessionId];
        settle(sessionId, measured);
        resolve(measured);
      }
    }
    draining = false;
    prune();
  };

  return {
    load(sessionId) {
      const existing = entries.get(sessionId);
      if (existing && isFresh(existing)) return existing.result;
      const result = new Promise<SessionStorageUsage | undefined>((resolve) => {
        queue.set(sessionId, resolve);
      });
      entries.set(sessionId, { result });
      if (!draining) {
        draining = true;
        // Wait a microtask so every row mounted in this commit joins the batch.
        void Promise.resolve().then(drain);
      }
      return result;
    },
    size: () => entries.size,
  };
}

/** Everything a task holds on the Host, counting shared context once per task. */
export function sessionStorageBytes(usage: SessionStorageUsage): number {
  const { transcript, runtime, artifacts, context = 0 } = usage.bytes;
  return transcript + runtime + artifacts + context;
}
