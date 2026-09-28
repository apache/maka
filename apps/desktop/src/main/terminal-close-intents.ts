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

import type { ShellRunUpdate } from '@maka/core/events';
import { isTerminalShellRunStatus } from '@maka/core/shell-run';
import type { TerminalCloseChange, TerminalRecovery } from '../shared/runtime-host-identity.js';

type Identity = Pick<TerminalCloseChange, 'sessionId' | 'ref'>;

/** Target-owned user intent, independent of both the renderer and connection leases. */
export class TerminalCloseIntents {
  readonly #entries = new Map<string, { change: TerminalCloseChange; pending?: Promise<void> }>();

  constructor(private readonly changed: (change: TerminalCloseChange) => void = () => {}) {}

  stop(identity: Identity, stop: () => Promise<void>): Promise<void> {
    const key = JSON.stringify([identity.sessionId, identity.ref]);
    const previous = this.#entries.get(key);
    if (previous?.pending) return previous.pending;
    const entry: { change: TerminalCloseChange; pending?: Promise<void> } = {
      change: { ...identity, status: 'pending' },
    };
    this.#entries.set(key, entry);
    // Register before the operation enters a connection's controller queue.
    entry.pending = Promise.resolve().then(stop).then(() => {
      if (this.#entries.get(key) !== entry) return;
      this.#entries.delete(key);
      this.#publish({ ...identity, status: 'closed' });
    }, (error: unknown) => {
      if (this.#entries.get(key) !== entry) throw error;
      entry.pending = undefined;
      entry.change = { ...identity, status: 'unknown' };
      this.#publish(entry.change);
      throw error;
    });
    this.#publish(entry.change);
    return entry.pending;
  }

  async recover(sessionId: string, read: () => Promise<ShellRunUpdate[]>): Promise<TerminalRecovery> {
    // The renderer subscribes before this read and invalidates its snapshot on
    // Close changes. Keep one retry owner instead of rereading in both layers.
    const resources = await read();
    for (const resource of resources) {
      const key = JSON.stringify([sessionId, resource.result.ref]);
      const entry = this.#entries.get(key);
      if (entry && !entry.pending && isTerminalShellRunStatus(resource.result.status)) {
        this.#entries.delete(key);
        this.#publish({ ...entry.change, status: 'closed' });
      }
    }
    return {
      resources,
      closes: [...this.#entries.values()].filter((entry) => entry.change.sessionId === sessionId)
        .map((entry) => entry.change),
    };
  }

  retireSession(sessionId: string): void {
    for (const [key, entry] of this.#entries) {
      if (entry.change.sessionId !== sessionId) continue;
      this.#entries.delete(key);
      this.#publish({ ...entry.change, status: 'closed' });
    }
  }

  #publish(change: TerminalCloseChange): void {
    // UI delivery cannot change an acknowledged Host operation into a failure.
    try { this.changed(change); } catch { /* A new view recovers from Host and pending intent. */ }
  }
}
