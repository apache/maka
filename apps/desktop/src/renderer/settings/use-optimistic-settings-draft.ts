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

import { useEffect, useRef, useState } from 'react';
import { useMountedRef } from '@maka/ui';
import type { RefObject } from 'react';
import {
  createOptimisticDraftController,
  type OptimisticDraftController,
} from './optimistic-settings-draft-controller';

/**
 * Shared optimistic last-write-wins draft for Settings pages.
 *
 * Several Settings pages need the same block: a local draft mirrored on a ref, a
 * `persistedRef`, a `pendingSaveCount`, a monotonic `saveTicket`, a
 * `commitDraft` helper, and a prop→state sync effect. This hook owns that
 * machinery once (via `createOptimisticDraftController`) so no page reinvents
 * the async-correctness contract. The pure controller carries the logic and is
 * unit-tested without a React renderer; this hook is the thin shell that wires
 * it to React state + `useMountedRef`.
 */

export interface UseOptimisticSettingsDraftOptions<T> {
  /** Report the current save's failure (typically a scrubbed toast). */
  onError?(error: unknown): void;
  /** Run a page-specific side effect whenever an authoritative value lands. */
  onReconcile?(persisted: T): void;
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
  options?: UseOptimisticSettingsDraftOptions<T>,
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
    return () => {
      controller.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    controller.syncPersisted(persisted);
    // Sync is intentionally keyed on the persisted value alone; callbacks are
    // read from refs so they never re-trigger the effect.
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
