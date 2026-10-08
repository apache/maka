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

import type {
  SessionBackgroundActivity,
  SessionBackgroundActivitySnapshot,
} from '@maka/core/session';

/**
 * One read projection for initial catalog queries and subsequent invalidations.
 * The execution coordinators own the facts; this only remembers the last
 * published value so handoffs between Graph and supervisor do not churn lists.
 * Its lifetime is one Host epoch and it never persists a running flag.
 */
export class SessionBackgroundActivityProjection {
  readonly #published = new Map<string, SessionBackgroundActivity>();
  // Keep idle tombstones for this Host generation: forgetting a Session's
  // clock would let an older running response outrank its newer idle state.
  // Only Sessions with an activity transition allocate an entry, and the
  // Host-scoped projection releases these clocks when its generation ends.
  readonly #revisions = new Map<string, number>();

  constructor(
    private readonly sources: {
      hostGeneration: string;
      graph(sessionId: string): SessionBackgroundActivity;
      supervisor(sessionId: string): SessionBackgroundActivity;
      publish(sessionId: string): void;
    },
  ) {}

  read(sessionId: string): SessionBackgroundActivity {
    const graph = this.sources.graph(sessionId);
    const supervisor = this.sources.supervisor(sessionId);
    if (graph === 'waiting_for_user' || supervisor === 'waiting_for_user')
      return 'waiting_for_user';
    // A supervisor may be handling a failed child without needing the user.
    if (graph === 'running' || supervisor === 'running') return 'running';
    if (graph === 'blocked' || supervisor === 'blocked') return 'blocked';
    return 'idle';
  }

  snapshot(sessionId: string): SessionBackgroundActivitySnapshot {
    return {
      backgroundActivity: this.read(sessionId),
      backgroundActivityVersion: {
        hostGeneration: this.sources.hostGeneration,
        revision: this.#revisions.get(sessionId) ?? 0,
      },
    };
  }

  changed(sessionId: string): void {
    const next = this.read(sessionId);
    const previous = this.#published.get(sessionId) ?? 'idle';
    if (previous === next) return;
    // Guests can read their shared Session's version, so its clock must not
    // expose transitions in other Sessions on the same Host.
    this.#revisions.set(sessionId, (this.#revisions.get(sessionId) ?? 0) + 1);
    if (next === 'idle') this.#published.delete(sessionId);
    else this.#published.set(sessionId, next);
    this.sources.publish(sessionId);
  }
}
