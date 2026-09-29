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

import type { SessionStorageUsage } from '@maka/runtime-host/protocol';

/** One Host query measures at most this many Sessions. */
const BATCH_SIZE = 100;

export interface SessionStorageLoader {
  /** Resolves undefined when the size could not be measured. */
  load(sessionId: string): Promise<SessionStorageUsage | undefined>;
}

/**
 * Coalesces the size requests of rows that mount together into one query, so
 * a list asks for exactly the rows it renders. Results live as long as the
 * loader; a failed measurement is forgotten so a later row can retry it.
 */
export function createSessionStorageLoader(
  loadSessionUsage: (
    sessionIds: readonly string[],
  ) => Promise<Readonly<Record<string, SessionStorageUsage>>>,
): SessionStorageLoader {
  const results = new Map<string, Promise<SessionStorageUsage | undefined>>();
  let pending = new Map<string, (usage: SessionStorageUsage | undefined) => void>();
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    const batch = pending;
    pending = new Map();
    const ids = [...batch.keys()];
    for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
      const chunk = ids.slice(offset, offset + BATCH_SIZE);
      loadSessionUsage(chunk).then(
        (usage) => {
          for (const id of chunk) {
            const measured = usage[id];
            if (!measured) results.delete(id);
            batch.get(id)?.(measured);
          }
        },
        () => {
          for (const id of chunk) {
            results.delete(id);
            batch.get(id)?.(undefined);
          }
        },
      );
    }
  };

  return {
    load(sessionId) {
      const existing = results.get(sessionId);
      if (existing) return existing;
      const result = new Promise<SessionStorageUsage | undefined>((resolve) => {
        pending.set(sessionId, resolve);
      });
      results.set(sessionId, result);
      if (!scheduled) {
        scheduled = true;
        void Promise.resolve().then(flush);
      }
      return result;
    },
  };
}

/** Everything a task holds on the Host, counting shared context once per task. */
export function sessionStorageBytes(usage: SessionStorageUsage): number {
  const { transcript, runtime, artifacts, context = 0 } = usage.bytes;
  return transcript + runtime + artifacts + context;
}
