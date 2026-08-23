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

interface SettingIntent<Value> {
  desired: Value;
  committed?: Value;
  inFlight: boolean;
}

interface SessionSettingIntentOptions<Value> {
  catalogRevision: unknown;
  readCatalogValue(sessionId: string): Value | undefined;
  write(sessionId: string, value: Value): Promise<boolean>;
  refreshCatalog(): Promise<unknown>;
  onWriteError(sessionId: string, error: unknown): void;
}

interface SessionSettingIntentController<Value> {
  overlayBySession: Readonly<Record<string, Value>>;
  request(sessionId: string, value: Value): Promise<boolean>;
  clear(sessionId: string): void;
}

/**
 * Owns the gap between a renderer setting intent, its Host commit, and the
 * later catalog snapshot that observes that commit. Only the latest desired
 * value is written; a committed overlay remains until the catalog confirms it.
 */
export function useSessionSettingIntent<Value>(
  options: SessionSettingIntentOptions<Value>,
): SessionSettingIntentController<Value> {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const intentsRef = useRef(new Map<string, SettingIntent<Value>>());
  const [overlayBySession, setOverlayBySession] = useState<Record<string, Value>>({});

  const setOverlay = useCallback((sessionId: string, value: Value | undefined): void => {
    setOverlayBySession((current) => {
      if (value !== undefined) {
        if (Object.is(current[sessionId], value)) return current;
        return { ...current, [sessionId]: value };
      }
      if (!(sessionId in current)) return current;
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }, []);

  const reconcile = useCallback((sessionId: string): void => {
    const intent = intentsRef.current.get(sessionId);
    if (!intent || intent.inFlight || intent.committed === undefined) return;
    if (!Object.is(optionsRef.current.readCatalogValue(sessionId), intent.committed)) return;
    intentsRef.current.delete(sessionId);
    setOverlay(sessionId, undefined);
  }, [setOverlay]);

  useEffect(() => {
    for (const sessionId of intentsRef.current.keys()) reconcile(sessionId);
  }, [options.catalogRevision, reconcile]);

  const request = useCallback(async (sessionId: string, value: Value): Promise<boolean> => {
    const existing = intentsRef.current.get(sessionId);
    if (existing) {
      existing.desired = value;
      setOverlay(sessionId, value);
      if (existing.inFlight) return true;
    }

    const intent = existing ?? { desired: value, inFlight: false };
    intentsRef.current.set(sessionId, intent);
    intent.desired = value;
    intent.inFlight = true;
    setOverlay(sessionId, value);

    let succeeded = true;
    while (intentsRef.current.get(sessionId) === intent) {
      const attempted = intent.desired;
      let committed = false;
      try {
        committed = await optionsRef.current.write(sessionId, attempted);
      } catch (error) {
        optionsRef.current.onWriteError(sessionId, error);
      }

      if (intentsRef.current.get(sessionId) !== intent) return false;
      if (committed) {
        intent.committed = attempted;
        setOverlay(sessionId, attempted);
        // Refresh is only a convergence nudge. A read failure cannot undo a
        // Host commit or strand the latest-intent worker.
        try {
          await optionsRef.current.refreshCatalog();
        } catch {}
      } else {
        succeeded = false;
        if (Object.is(intent.desired, attempted)) {
          setOverlay(sessionId, intent.committed);
          break;
        }
      }
      if (Object.is(intent.desired, attempted)) break;
    }

    if (intentsRef.current.get(sessionId) === intent) {
      intent.inFlight = false;
      reconcile(sessionId);
    }
    return succeeded;
  }, [reconcile, setOverlay]);

  const clear = useCallback((sessionId: string): void => {
    intentsRef.current.delete(sessionId);
    setOverlay(sessionId, undefined);
  }, [setOverlay]);

  return { overlayBySession, request, clear };
}
