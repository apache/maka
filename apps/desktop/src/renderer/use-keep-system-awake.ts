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

import { useCallback, useEffect, useState } from 'react';
import { useMountedRef } from '@maka/ui';

/**
 * Reads + writes the 保持系统唤醒 (`settings.system.keepSystemAwake`) toggle
 * that surfaces on the 定时任务 page. This is a Desktop preference, so it
 * remains available when the selected Runtime Host is offline.
 *
 * `supported` gates the whole capability on bridge presence: when the
 * preload bridge is absent (older main, or a non-Electron host), the caller
 * hides the row entirely rather than rendering a dead control. The
 * optimistic-update / revert-on-error / toast lifecycle lives in the panel;
 * this hook only owns the persisted snapshot and the write that rejects on
 * failure so the panel can revert.
 */
export interface KeepSystemAwakeController {
  /** Whether the settings bridge exposing this toggle exists. */
  supported: boolean;
  /** Last-known persisted value. Undefined until the initial read settles. */
  keepSystemAwake: boolean | undefined;
  /**
   * Persist a new value. Resolves once the store confirms the write (and
   * updates the local snapshot); rejects on failure so the caller can revert
   * its optimistic UI.
   */
  setKeepSystemAwake(next: boolean): Promise<void>;
}

export function useKeepSystemAwake(): KeepSystemAwakeController {
  // Gate on the bridge actually exposing both calls at runtime. `window.maka`
  // is typed as always-present, so a truthiness check trips TS2774; a
  // `typeof … === 'function'` probe is the honest runtime guard for a
  // non-Electron host or an older preload that predates this capability.
  const supported =
    typeof window.maka?.settings?.getClient === 'function' &&
    typeof window.maka?.settings?.updateClient === 'function';
  const [keepSystemAwake, setSnapshot] = useState<boolean>();
  const mountedRef = useMountedRef();

  const refresh = useCallback(async () => {
    if (!supported) return;
    try {
      const settings = await window.maka.settings.getClient();
      if (mountedRef.current) setSnapshot(settings.system.keepSystemAwake);
    } catch {
      // The persisted default is false. Falling back to that known-safe value
      // after an initial failure keeps the control recoverable; later failures
      // must not overwrite a value that was already confirmed.
      if (mountedRef.current) setSnapshot((previous) => previous ?? false);
    }
  }, [supported, mountedRef]);

  useEffect(() => {
    void refresh();
    if (!supported) return;
    // Keep the snapshot honest when settings.json is edited out of band.
    return window.maka.settings.subscribeClientChanged(() => {
      void refresh();
    });
  }, [supported, refresh]);

  const setKeepSystemAwake = useCallback(
    async (next: boolean) => {
      const result = await window.maka.settings.updateClient({ system: { keepSystemAwake: next } });
      if (mountedRef.current) setSnapshot(result.settings.system.keepSystemAwake);
    },
    [mountedRef],
  );

  return { supported, keepSystemAwake, setKeepSystemAwake };
}
