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

import { useEffect, useRef, useState, type RefObject } from 'react';
import { useMountedRef } from '@maka/ui';

// Feature-local copy of the settings optimistic last-write-wins draft (#4425).
// Pure controller + React shell. Invariants: a monotonic ticket makes overlapping
// saves last-write-wins; a pending count keeps a persisted-value sync from
// resetting local state mid-save; dispose invalidates an in-flight late write.

export interface OptimisticDraftController<T> {
  readonly draftRef: { current: T };
  activate(): void;
  syncPersisted(persisted: T): void;
  edit(patch: Partial<T>): void;
  update(patch: Partial<T>): Promise<boolean>;
  dispose(): void;
}

interface OptimisticDraftControllerDeps<T> {
  initial: T;
  onUpdate(patch: Partial<T>): Promise<T>;
  onDraftChange(draft: T): void;
  onReconcile?(draft: T): void;
  onError?(error: unknown): void;
  onSavingChange?(saving: boolean): void;
  isMounted(): boolean;
}

function createOptimisticDraftController<T>(
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
    if (pendingSaveCount === 0) reconcile(persisted);
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
    if (pendingSaveCount === 1 && deps.isMounted()) deps.onSavingChange?.(true);
    try {
      const next = await deps.onUpdate(patch);
      if (!disposed && generation === lifecycleGeneration && ticket > confirmedSaveTicket) {
        confirmedSaveTicket = ticket;
        authoritativeRef.current = next;
      }
      if (isCurrent(ticket, generation)) reconcile(next);
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
          if (draftRef.current !== authoritativeRef.current) reconcile(authoritativeRef.current);
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
  return { draftRef, activate, syncPersisted, edit, update, dispose };
}

export interface OptimisticSettingsDraft<T> {
  draft: T;
  draftRef: { current: T };
  mountedRef: RefObject<boolean>;
  saving: boolean;
  edit(patch: Partial<T>): void;
  update(patch: Partial<T>): Promise<boolean>;
}

export function useOptimisticSettingsDraft<T>(
  persisted: T,
  onUpdate: (patch: Partial<T>) => Promise<T>,
  options?: { onError?(error: unknown): void; onReconcile?(persisted: T): void },
): OptimisticSettingsDraft<T> {
  const mountedRef = useMountedRef();
  const [draft, setDraft] = useState<T>(persisted);
  const [saving, setSaving] = useState(false);
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const onErrorRef = useRef(options?.onError);
  onErrorRef.current = options?.onError;
  const onReconcileRef = useRef(options?.onReconcile);
  onReconcileRef.current = options?.onReconcile;

  const controllerRef = useRef<OptimisticDraftController<T> | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createOptimisticDraftController<T>({
      initial: persisted,
      onUpdate: (patch) => onUpdateRef.current(patch),
      onDraftChange: setDraft,
      onError: (error) => onErrorRef.current?.(error),
      onReconcile: (next) => onReconcileRef.current?.(next),
      onSavingChange: setSaving,
      isMounted: () => mountedRef.current === true,
    });
  }
  const controller = controllerRef.current;

  useEffect(() => {
    controller.activate();
    return () => controller.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    controller.syncPersisted(persisted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persisted]);

  return {
    draft,
    draftRef: controller.draftRef,
    mountedRef,
    saving,
    edit: controller.edit,
    update: controller.update,
  };
}
