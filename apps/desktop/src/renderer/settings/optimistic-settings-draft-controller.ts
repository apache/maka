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
 * Pure optimistic last-write-wins draft controller for Settings pages.
 *
 * Holds the ticket/pending/commit bookkeeping that several Settings pages had
 * hand-copied (draftRef + persistedRef + pendingSaveCount + saveTicket +
 * commitDraft + sync effect). It has no React or DOM dependency so the
 * async-correctness contract can be unit-tested directly; the React shell
 * `useOptimisticSettingsDraft` wires it to component state.
 *
 * Invariants:
 * - A monotonic ticket disambiguates overlapping in-flight saves so a stale
 *   earlier response cannot clobber a newer draft (last write wins).
 * - A pending-save count keeps `syncPersisted` from resetting local state out
 *   from under the user while a save is still in flight.
 * - `dispose` invalidates any in-flight save's late write.
 */

export interface OptimisticDraftController<T> {
  readonly draftRef: { current: T };
  /** Re-arm the controller when React replays an effect setup in StrictMode. */
  activate(): void;
  /** Sync immediately when idle, or defer until the final pending save settles. */
  syncPersisted(persisted: T): void;
  /** Apply a local edit without persisting it. */
  edit(patch: Partial<T>): void;
  /** Optimistically apply `patch`, persist it, and reconcile last-write-wins. */
  update(patch: Partial<T>): Promise<boolean>;
  /** Invalidate any in-flight save's late write (call on unmount). */
  dispose(): void;
}

export interface OptimisticDraftControllerDeps<T> {
  initial: T;
  onUpdate(patch: Partial<T>): Promise<T>;
  onDraftChange(draft: T): void;
  onReconcile?(draft: T): void;
  onError?(error: unknown): void;
  onSavingChange?(saving: boolean): void;
  isMounted(): boolean;
}

export function createOptimisticDraftController<T>(
  deps: OptimisticDraftControllerDeps<T>,
): OptimisticDraftController<T> {
  const draftRef = { current: deps.initial };
  const authoritativeRef = { current: deps.initial };
  let pendingSaveCount = 0;
  let saveTicket = 0;
  let confirmedSaveTicket = 0;
  let lifecycleGeneration = 0;
  let disposed = false;

  function commit(next: T): void {
    draftRef.current = next;
    deps.onDraftChange(next);
  }

  function reconcile(next: T): void {
    commit(next);
    deps.onReconcile?.(next);
  }

  function isCurrent(ticket: number, generation: number): boolean {
    return !disposed && generation === lifecycleGeneration && deps.isMounted() && ticket === saveTicket;
  }

  function syncPersisted(persisted: T): void {
    if (disposed) return;
    authoritativeRef.current = persisted;
    if (pendingSaveCount === 0) {
      reconcile(persisted);
    }
  }

  function activate(): void {
    if (!disposed) return;
    disposed = false;
    deps.onSavingChange?.(false);
  }

  function edit(patch: Partial<T>): void {
    if (disposed) return;
    commit({ ...draftRef.current, ...patch } as T);
  }

  async function update(patch: Partial<T>): Promise<boolean> {
    if (disposed) return false;
    const nextDraft = { ...draftRef.current, ...patch } as T;
    saveTicket += 1;
    pendingSaveCount += 1;
    const ticket = saveTicket;
    const generation = lifecycleGeneration;
    commit(nextDraft);
    if (pendingSaveCount === 1 && deps.isMounted()) {
      deps.onSavingChange?.(true);
    }
    try {
      const next = await deps.onUpdate(patch);
      if (!disposed && generation === lifecycleGeneration && ticket > confirmedSaveTicket) {
        confirmedSaveTicket = ticket;
        authoritativeRef.current = next;
      }
      if (isCurrent(ticket, generation)) {
        reconcile(next);
      }
      return isCurrent(ticket, generation);
    } catch (error) {
      if (isCurrent(ticket, generation)) {
        reconcile(authoritativeRef.current);
        deps.onError?.(error);
      }
      return false;
    } finally {
      if (generation === lifecycleGeneration) {
        pendingSaveCount = Math.max(0, pendingSaveCount - 1);
        if (!disposed && pendingSaveCount === 0 && deps.isMounted()) {
          if (draftRef.current !== authoritativeRef.current) {
            reconcile(authoritativeRef.current);
          }
          deps.onSavingChange?.(false);
        }
      }
    }
  }

  function dispose(): void {
    disposed = true;
    lifecycleGeneration += 1;
    pendingSaveCount = 0;
    saveTicket += 1;
  }

  return {
    draftRef,
    activate,
    syncPersisted,
    edit,
    update,
    dispose,
  };
}
