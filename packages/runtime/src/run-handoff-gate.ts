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

/** A reservation of the next durable step boundary, not permission to abort work. */
export interface RunHandoffRequest {
  /** False when execution ends or the request is cancelled before reaching a boundary. */
  readonly ready: Promise<boolean>;
  /** Commits only a currently held boundary; the caller must still await its durable seal. */
  commit(): boolean;
  cancel(): void;
}

interface PendingHandoff {
  readonly reached: Promise<boolean>;
  readonly release: Promise<'continue' | 'pause'>;
  markReached(ready: boolean): void;
  releaseBoundary(decision: 'continue' | 'pause'): void;
  cleanup(): void;
  atBoundary: boolean;
}

/**
 * One physical Run owns one gate. Before commit, cancellation resumes that same
 * Run without a terminal fact. Durable pause/continuation authority lives in the
 * ledger, never in this in-memory gate.
 */
export class RunHandoffGate {
  #pending: PendingHandoff | undefined;
  #closed = false;

  request(signal: AbortSignal): RunHandoffRequest {
    if (this.#pending) throw new Error('This Run already has a handoff reservation');
    if (this.#closed || signal.aborted) {
      return { ready: Promise.resolve(false), commit: () => false, cancel() {} };
    }
    let markReached!: (ready: boolean) => void;
    let releaseBoundary!: (decision: 'continue' | 'pause') => void;
    const cancel = () => {
      this.#settle(pending, 'continue');
    };
    const pending: PendingHandoff = {
      reached: new Promise((resolve) => {
        markReached = resolve;
      }),
      release: new Promise((resolve) => {
        releaseBoundary = resolve;
      }),
      markReached: (ready) => markReached(ready),
      releaseBoundary: (decision) => releaseBoundary(decision),
      cleanup: () => signal.removeEventListener('abort', cancel),
      atBoundary: false,
    };
    this.#pending = pending;
    signal.addEventListener('abort', cancel, { once: true });
    return {
      ready: pending.reached,
      commit: () => pending.atBoundary && this.#settle(pending, 'pause'),
      cancel,
    };
  }

  /** Called only after the preceding step's events and tool outcomes are durable. */
  async reachBoundary(executionSignal: AbortSignal): Promise<'continue' | 'pause'> {
    const pending = this.#pending;
    if (!pending) return 'continue';
    const abort = () => {
      this.#settle(pending, 'continue');
    };
    if (executionSignal.aborted) {
      abort();
      return 'continue';
    }
    executionSignal.addEventListener('abort', abort, { once: true });
    pending.atBoundary = true;
    pending.markReached(true);
    try {
      return await pending.release;
    } finally {
      executionSignal.removeEventListener('abort', abort);
    }
  }

  /** Natural completion, user Stop, or failure must never leave a waiter behind. */
  close(): void {
    this.#closed = true;
    if (this.#pending) this.#settle(this.#pending, 'continue');
  }

  #settle(pending: PendingHandoff, decision: 'continue' | 'pause'): boolean {
    if (this.#pending !== pending) return false;
    this.#pending = undefined;
    if (decision === 'pause') this.#closed = true;
    pending.cleanup();
    pending.markReached(false);
    pending.releaseBoundary(decision);
    return true;
  }
}
