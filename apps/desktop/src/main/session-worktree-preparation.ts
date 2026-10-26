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

import type { WorktreePreparation } from '@maka/core/worktree';
import type { DesktopLocalMessage } from '../shared/session-local-contract.js';

type Progress = NonNullable<DesktopLocalMessage['worktreePreparation']>;

/** Observes one Host operation. Discovery and delivery policy stay outside this observer. */
export class SessionWorktreePreparation {
  private readonly values = new Map<string, Progress>();
  private readonly stops = new Set<() => void>();
  get(key: string): Progress | undefined { return this.values.get(key); }
  has(key: string): boolean { return this.values.has(key); }
  close(): void { for (const stop of this.stops) stop(); }

  watch(input: {
    key: string;
    query(): Promise<WorktreePreparation>;
    current(): boolean;
    changed(): void;
    explicit: boolean;
  }): () => void {
    const startedAt = Date.now();
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (!active) return;
      active = false;
      clearTimeout(timer);
      this.stops.delete(stop);
      this.values.delete(input.key);
      input.changed();
    };
    this.stops.add(stop);
    const current = () => active && input.current();
    const publish = (progress: Omit<Progress, 'elapsedSeconds'>) => {
      if (!current()) return;
      this.values.set(input.key, { ...progress, elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000) });
      input.changed();
    };
    if (input.explicit) publish({ phase: 'preparing' });
    const poll = async () => {
      try {
        const progress = await input.query();
        if (progress.phase !== 'inactive' && progress.phase !== 'blocked') publish(progress);
      } catch {
        // Progress is best-effort. A failed observation cannot change delivery.
        const previous = this.values.get(input.key);
        if (previous) publish(previous);
      } finally {
        if (current()) {
          timer = setTimeout(() => void poll(), 1000);
          timer.unref();
        } else stop();
      }
    };
    void poll();
    return stop;
  }
}
