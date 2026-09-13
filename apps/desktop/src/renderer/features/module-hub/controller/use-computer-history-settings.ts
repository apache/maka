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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComputerHistoryClearScope, ComputerHistorySettings, ComputerHistoryStatus } from '@maka/core/computer-history';
import { useModuleHubServices } from '../services-context.js';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function useComputerHistorySettings() {
  const { computerHistory: service } = useModuleHubServices();
  const lifecycle = useMemo(() => ({ active: false, generation: 0 }), [service]);
  const sequence = useRef(0);
  const pendingRef = useRef(false);
  const [status, setStatus] = useState<ComputerHistoryStatus | null>(null);
  const [modelLabel, setModelLabel] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<boolean> => {
    if (!lifecycle.active) return false;
    const generation = lifecycle.generation;
    const read = ++sequence.current;
    const [health, model] = await Promise.allSettled([service.status(), service.getAnalysisModel()]);
    if (!lifecycle.active || lifecycle.generation !== generation || read !== sequence.current) return false;
    if (health.status === 'fulfilled') {
      setStatus(health.value);
      setStatusError(null);
    } else {
      setStatusError(message(health.reason));
    }
    if (model.status === 'fulfilled') {
      setModelLabel(model.value);
      setModelError(null);
    } else {
      setModelLabel(null);
      setModelError(message(model.reason));
    }
    setLoading(false);
    return health.status === 'fulfilled';
  }, [service, lifecycle]);

  useEffect(() => {
    lifecycle.active = true;
    ++lifecycle.generation;
    pendingRef.current = false;
    setPending(null);
    setStatus(null);
    setModelLabel(null);
    setStatusError(null);
    setModelError(null);
    setActionError(null);
    setLoading(true);
    void refresh();
    const timer = setInterval(() => {
      if (!pendingRef.current) void refresh();
    }, 15_000);
    const onFocus = () => { if (!pendingRef.current) void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => {
      lifecycle.active = false;
      ++lifecycle.generation;
      ++sequence.current;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh, lifecycle]);

  const run = useCallback(async (key: string, operation: () => Promise<unknown>): Promise<boolean> => {
    if (!lifecycle.active || pendingRef.current) return false;
    const generation = lifecycle.generation;
    const current = () => lifecycle.active && lifecycle.generation === generation;
    pendingRef.current = true;
    ++sequence.current;
    setPending(key);
    setActionError(null);
    try {
      await operation();
      if (!current()) return false;
      // Confirm persisted state before clearing an input or acknowledging deletion.
      return await refresh() && current();
    } catch (error) {
      if (current()) {
        setActionError(message(error));
        await refresh();
      }
      return false;
    } finally {
      if (current()) {
        pendingRef.current = false;
        setPending(null);
      }
    }
  }, [lifecycle, refresh]);

  return {
    status, modelLabel, loading, pending, statusError, modelError, actionError, refresh,
    update: (patch: Partial<ComputerHistorySettings>, key: string) =>
      run(key, () => service.updateSettings(patch)),
    requestPermissions: () => run('permissions', () => service.requestPermissions()),
    clear: (scope: ComputerHistoryClearScope) => run('clear', () => service.clear(scope)),
  };
}

/** Optional discovery only; settings and deletion never wait for this archive read. */
export function useRecentHistoryApplications() {
  const { computerHistory: service } = useModuleHubServices();
  const [applications, setApplications] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let current = true;
    setApplications([]);
    setError(null);
    void service.timeline(2).then(
      (timeline) => {
        if (!current) return;
        const ids = [...new Set(timeline.entries.flatMap((entry) => entry.applications))];
        setApplications(ids.filter((id) =>
          id.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/u.test(id),
        ).slice(0, 256));
        setError(timeline.status.error ?? null);
      },
      (failure: unknown) => { if (current) setError(message(failure)); },
    );
    return () => { current = false; };
  }, [service, revision]);
  return { applications, error, refresh };
}
