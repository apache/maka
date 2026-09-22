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

import type { DesktopSessionSummary } from '../../../preload/bridge-contract.js';

export type SessionCatalogSource = {
  sessions: Pick<typeof window.maka.sessions, 'get'>;
};

export interface SessionPatchDrain {
  /** Resolves with the committed row, or null when it left the catalog. */
  request(sessionId: string): Promise<DesktopSessionSummary | null>;
}

/**
 * `sessions:changed` carries the changed row's id, so the hot path reads and
 * commits only that row. Calls arriving while a batch is in flight fold into
 * the next drain instead of queueing one IPC per event.
 */
export function createSessionPatchDrain(
  options: {
    normalize(session: DesktopSessionSummary): DesktopSessionSummary;
    commitPatch(sessionId: string, summary: DesktopSessionSummary | null): void;
    /** A failed row read must not evict the row; the caller falls back to a full refresh. */
    onReadFailure(): void;
  },
  source: SessionCatalogSource = window.maka,
): SessionPatchDrain {
  const pending = new Map<string, { resolve: (s: DesktopSessionSummary | null) => void }[]>();
  let draining = false;

  async function drain(): Promise<void> {
    try {
      while (pending.size > 0) {
        const batch = [...pending.entries()];
        pending.clear();
        await Promise.all(batch.map(async ([sessionId, waiters]) => {
          try {
            const summary = await source.sessions.get(sessionId);
            const normalized = summary === null ? null : options.normalize(summary);
            options.commitPatch(sessionId, normalized);
            waiters.forEach(({ resolve }) => resolve(normalized));
          } catch {
            waiters.forEach(({ resolve }) => resolve(null));
            options.onReadFailure();
          }
        }));
      }
    } finally {
      draining = false;
    }
  }

  return {
    request(sessionId) {
      const promise = new Promise<DesktopSessionSummary | null>((resolve) => {
        const waiters = pending.get(sessionId);
        if (waiters) waiters.push({ resolve });
        else pending.set(sessionId, [{ resolve }]);
      });
      if (!draining) {
        draining = true;
        void drain();
      }
      return promise;
    },
  };
}
