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

/**
 * Coalesced refresh scheduling for the Agent Graph panel (#2991).
 *
 * A `graphs:changed` notification must NOT invalidate an in-flight read: a
 * busy graph publishes continuously, and advancing the fence on every
 * notification discards each valid snapshot until the graph goes quiet,
 * leaving the panel blank. Notifications therefore only queue one follow-up
 * read while the in-flight read for the same session and selection commits.
 *
 * The fence advances only on an explicit invalidation — the user picking a
 * different epoch or the effect re-running for another session — so a stale
 * in-flight read for a superseded selection is still discarded.
 */
export interface AgentGraphRefreshScheduler {
  /** Notification-driven: queue a follow-up read; never invalidates in-flight. */
  requestRefresh(): void;
  /** Selection/session change: invalidate any in-flight read and re-read. */
  invalidateAndRefresh(): void;
  /** Whether a read started with `fence` may still commit its result. */
  isCurrent(fence: number): boolean;
  dispose(): void;
}

export function createAgentGraphRefreshScheduler(
  read: (fence: number) => Promise<void>,
): AgentGraphRefreshScheduler {
  let disposed = false;
  let queued = false;
  let fence = 0;
  let running = false;

  const start = (): void => {
    running = true;
    const current = fence;
    const settle = (): void => {
      running = false;
      if (disposed) return;
      if (queued) {
        queued = false;
        start();
      }
    };
    void read(current).then(settle, settle);
  };

  return {
    requestRefresh() {
      if (disposed) return;
      if (running) {
        queued = true;
        return;
      }
      start();
    },
    invalidateAndRefresh() {
      if (disposed) return;
      fence += 1;
      if (running) {
        queued = true;
        return;
      }
      start();
    },
    isCurrent(candidate: number): boolean {
      return !disposed && candidate === fence;
    },
    dispose() {
      disposed = true;
      queued = false;
    },
  };
}
