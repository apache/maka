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

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMountedRef } from '@maka/ui';
import type { ModuleHubServices } from '../ports.js';

export interface KeepSystemAwakeController {
  /** False for a non-Electron surface or older preload without this bridge. */
  readonly supported: boolean;
  /** Last confirmed persisted value; undefined until the first read settles. */
  readonly keepSystemAwake: boolean | undefined;
  /** Rejects on persistence failure so the Scheduled Tasks panel can revert. */
  setKeepSystemAwake(next: boolean): Promise<void>;
}

/**
 * Owns the Desktop client setting surfaced by Scheduled Tasks. The UI owns its
 * short-lived optimistic checkbox; this hook owns the confirmed snapshot and
 * makes rejected writes observable so that UI can revert.
 */
export function useKeepSystemAwakeController(
  services: ModuleHubServices,
): KeepSystemAwakeController {
  const settings = services.clientSettings;
  const supported = settings.supported;
  const [keepSystemAwake, setSnapshot] = useState<boolean>();
  const mountedRef = useMountedRef();
  // Reads, writes and external-change refreshes share a generation. A slow
  // older completion cannot overwrite the newest confirmed client setting.
  const generationRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!supported) return;
    const generation = ++generationRef.current;
    try {
      const next = await settings.getKeepSystemAwake();
      if (mountedRef.current && generation === generationRef.current) {
        setSnapshot(next);
      }
    } catch {
      // `false` is the persisted default and the only safe fallback. Preserve
      // a snapshot that was already confirmed by an earlier successful read.
      if (mountedRef.current && generation === generationRef.current) {
        setSnapshot((previous) => previous ?? false);
      }
    }
  }, [mountedRef, settings, supported]);

  useEffect(() => {
    if (!supported) return;
    void refresh();
    const dispose = settings.subscribeChanges(() => {
      void refresh();
    });
    return () => {
      generationRef.current += 1;
      dispose();
    };
  }, [refresh, settings, supported]);

  const setKeepSystemAwake = useCallback(
    async (next: boolean) => {
      if (!supported) throw new Error('Keep-system-awake settings are unavailable');
      const generation = ++generationRef.current;
      // Do not catch: the Scheduled Tasks panel needs the rejection to revert
      // its optimistic checkbox and surface the existing localized toast.
      const confirmed = await settings.setKeepSystemAwake(next);
      if (mountedRef.current && generation === generationRef.current) {
        setSnapshot(confirmed);
      }
    },
    [mountedRef, settings, supported],
  );

  return { supported, keepSystemAwake, setKeepSystemAwake };
}
