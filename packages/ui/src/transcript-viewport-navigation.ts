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
 * No geometry or pending range state lives here; detaching invalidates queued callbacks. */
export function createTranscriptViewportNavigation() {
  const listeners = new Set<(sessionId: string) => void>();
  let commitScheduler: { sessionId: string; schedule: (commit: () => void) => void } | undefined;
  return {
    attachCommitScheduler(sessionId: string, schedule: (commit: () => void) => void): () => void {
      const attached = { sessionId, schedule };
      commitScheduler = attached;
      return () => { if (commitScheduler === attached) commitScheduler = undefined; };
    },
    commitRange(sessionId: string, commit: () => void): void {
      const attached = commitScheduler;
      if (attached?.sessionId === sessionId) attached.schedule(() => {
        if (commitScheduler === attached) commit();
      });
      else commit();
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
