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

export type GoalSessionCloseKind = 'archive' | 'remove';

interface GoalSessionCloseState {
  durable: 'open' | 'archived' | 'removed';
  readonly holders: Set<symbol>;
}

export interface GoalSessionCloseOperation {
  /** Commit the archive/removal after the host's persistent operation succeeds. */
  commit(): void;
  /**
   * Release this operation's pending fence. If every close rolls back, the
   * owner must leave any revoked Goal in a truthful, non-running state.
   */
  rollback(): void;
}

export interface GoalSessionCloseFenceDeps {
  onReopenedAfterRollback: (sessionId: string, kind: GoalSessionCloseKind) => void;
}

const inertOperation: GoalSessionCloseOperation = Object.freeze({
  commit() {},
  rollback() {},
});

/** Owns pending and durable session-close admission state. */
export class GoalSessionCloseFence {
  private readonly sessions = new Map<string, GoalSessionCloseState>();
  private disposed = false;

  constructor(private readonly deps: GoalSessionCloseFenceDeps) {}

  isClosed(sessionId: string): boolean {
    const state = this.sessions.get(sessionId);
    return state !== undefined && (state.durable !== 'open' || state.holders.size > 0);
  }

  begin(sessionId: string, kind: GoalSessionCloseKind): GoalSessionCloseOperation {
    if (this.disposed) return inertOperation;
    const state = this.stateFor(sessionId);
    const holder = Symbol(kind);
    state.holders.add(holder);

    let settled = false;
    const finish = (commit: boolean): void => {
      if (settled) return;
      settled = true;
      if (this.disposed || this.sessions.get(sessionId) !== state) return;

      if (commit) {
        if (kind === 'remove') state.durable = 'removed';
        else if (state.durable !== 'removed') state.durable = 'archived';
      }
      state.holders.delete(holder);

      const reopened = !commit && state.durable === 'open' && state.holders.size === 0;
      this.cleanup(sessionId, state);
      if (reopened) this.deps.onReopenedAfterRollback(sessionId, kind);
    };

    return Object.freeze({
      commit: () => finish(true),
      rollback: () => finish(false),
    });
  }

  /** Clear only a committed archive fence; removal and pending holders remain. */
  unarchive(sessionId: string): void {
    if (this.disposed) return;
    const state = this.sessions.get(sessionId);
    if (!state || state.durable !== 'archived') return;
    state.durable = 'open';
    this.cleanup(sessionId, state);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sessions.clear();
  }

  private stateFor(sessionId: string): GoalSessionCloseState {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const created: GoalSessionCloseState = { durable: 'open', holders: new Set() };
    this.sessions.set(sessionId, created);
    return created;
  }

  private cleanup(sessionId: string, state: GoalSessionCloseState): void {
    if (state.durable === 'open' && state.holders.size === 0) {
      this.sessions.delete(sessionId);
    }
  }
}
