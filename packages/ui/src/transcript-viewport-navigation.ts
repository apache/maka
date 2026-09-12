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

/** Bridge the active surface's scroll authority to conversation commands and publication.
 * Publication outlives a viewport: only the source owner can invalidate its data. */
export function createTranscriptViewportNavigation() {
  const listeners = new Set<(sessionId: string) => void>();
  let viewport: { sessionId: string; commitIfIdle: (commit: () => void) => boolean } | undefined;
  let pending: { sessionId: string; commit: () => void } | undefined;
  const drain = (): void => {
    const update = pending;
    if (!update) return;
    const commit = () => {
      pending = undefined;
      update.commit();
    };
    if (viewport?.sessionId === update.sessionId) viewport.commitIfIdle(commit);
    else commit();
  };
  return {
    attachCommitScheduler(sessionId: string, authority: {
      commitIfIdle(commit: () => void): boolean;
      subscribeToIdle(listener: () => void): () => void;
    }): () => void {
      const attached = { sessionId, commitIfIdle: authority.commitIfIdle };
      viewport = attached;
      const unsubscribe = authority.subscribeToIdle(drain);
      queueMicrotask(drain);
      return () => {
        unsubscribe();
        if (viewport !== attached) return;
        viewport = undefined;
        // React cleanup may be running. Publish after it, without depending
        // on a future source emission or a replacement viewport mounting.
        queueMicrotask(drain);
      };
    },
    commitRange(sessionId: string, commit: () => void): void {
      pending = { sessionId, commit };
      queueMicrotask(drain);
    },
    followLatest(sessionId: string): void {
      for (const listener of [...listeners]) listener(sessionId);
    },
    subscribe(listener: (sessionId: string) => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export type TranscriptViewportNavigation = ReturnType<typeof createTranscriptViewportNavigation>;
