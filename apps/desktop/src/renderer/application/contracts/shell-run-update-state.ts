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

import { mergeShellRunUpdate, projectShellRunUpdateForSession, ShellRunUpdateBuffer } from '@maka/core/shell-run-result';

import { type ShellRunUpdate } from '@maka/core/events';

export type ShellRunUpdatesBySession = Record<string, Record<string, ShellRunUpdate>>;

export function mergeShellRunUpdates(
  current: ShellRunUpdatesBySession,
  updates: readonly ShellRunUpdate[],
): ShellRunUpdatesBySession {
  let next = current;
  for (const update of updates) {
    const session = next[update.sessionId] ?? {};
    const previous = session[update.sourceToolCallId];
    const merged = mergeShellRunUpdate(
      previous,
      update,
      'desktop.shell-run-update-state',
    );
    if (!merged.changed) continue;
    if (next === current) next = { ...current };
    next[update.sessionId] = {
      ...session,
      [update.sourceToolCallId]: merged.update,
    };
  }
  return next;
}

export function mergeShellRunNotification(
  current: ShellRunUpdatesBySession,
  sessionId: string,
  update: ShellRunUpdate,
): ShellRunUpdatesBySession {
  return mergeShellRunUpdates(
    current,
    projectShellRunUpdateForSession(
      sessionId,
      Object.values(current[sessionId] ?? {}),
      update,
    ),
  );
}

export class ShellRunHydration {
  readonly #pending = new ShellRunUpdateBuffer('desktop.shell-run-hydration-buffer');
  #epoch = 0;
  #hydrated = false;

  begin(): number {
    this.#epoch += 1;
    this.#hydrated = false;
    this.#pending.clear();
    return this.#epoch;
  }

  isCurrent(epoch: number): boolean {
    return epoch === this.#epoch;
  }

  accept(update: ShellRunUpdate): ShellRunUpdate | undefined {
    if (this.#hydrated) return update;
    this.#pending.add(update);
    return undefined;
  }

  commit(epoch: number): { updates: ShellRunUpdate[]; overflowed: boolean } | undefined {
    if (!this.isCurrent(epoch)) return undefined;
    const pending = this.#pending.drain();
    this.#hydrated = !pending.overflowed;
    return pending;
  }
}
