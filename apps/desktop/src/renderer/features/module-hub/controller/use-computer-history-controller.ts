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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { computerHistorySearchTerms } from '@maka/core/computer-history';
import type {
  ComputerHistoryDetail,
  ComputerHistoryStatus,
  ComputerHistoryTimelineEntry,
} from '@maka/core/computer-history';
import { useModuleHubServices } from '../services-context.js';

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const EMPTY_DETAIL: {
  value: ComputerHistoryDetail | null;
  loading: boolean;
  error: string | null;
} = { value: null, loading: false, error: null };

export function useComputerHistoryController(selectedId: string | null, query = '') {
  const { computerHistory: service } = useModuleHubServices();
  const request = useMemo(() => {
    try {
      return { query: computerHistorySearchTerms(query).join(' '), error: null };
    } catch (error) {
      return { query: '', error: errorMessage(error) };
    }
  }, [query]);
  const requestRef = useRef(request);
  const [searchState, setSearchState] = useState<{
    completed: typeof request | null;
    result: typeof request | null;
  }>({ completed: null, result: null });
  const completedRequest = useRef<typeof request | null>(null);
  const queryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [entries, setEntries] = useState<readonly ComputerHistoryTimelineEntry[]>([]);
  const [status, setStatus] = useState<ComputerHistoryStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [detailState, setDetailState] = useState(EMPTY_DETAIL);
  const [revision, setRevision] = useState(0);
  const lifecycle = useMemo(() => ({ active: false, generation: 0 }), [service]);
  const refreshSequence = useRef(0);
  const detailSequence = useRef(0);
  const busyRef = useRef(false);

  useLayoutEffect(() => {
    requestRef.current = request;
    // Fence immediately, including responses arriving during the debounce window.
    ++refreshSequence.current;
  }, [request]);

  const refresh = useCallback(async (background = false) => {
    if (!lifecycle.active) return;
    const requested = requestRef.current;
    if (queryTimer.current !== null) {
      clearTimeout(queryTimer.current);
      queryTimer.current = null;
    }
    const generation = lifecycle.generation;
    const sequence = ++refreshSequence.current;
    if (!background && !requested.error) setLoading(true);
    // Status remains independently readable when the timeline archive is damaged.
    const [timeline, health] = await Promise.allSettled([
      requested.error ? Promise.resolve(null) : service.timeline(30, requested.query || undefined), service.status(),
    ]);
    if (!lifecycle.active || generation !== lifecycle.generation || sequence !== refreshSequence.current) return;
    if (timeline.status === 'fulfilled' && timeline.value) {
      setEntries(timeline.value.entries);
      setStatus(timeline.value.status);
    }
    if (health.status === 'fulfilled') setStatus(health.value);
    const failed = [timeline, health].find((result) => result.status === 'rejected');
    completedRequest.current = requested;
    setSearchState((current) => ({
      completed: requested,
      result: timeline.status === 'fulfilled' && timeline.value ? requested : current.result,
    }));
    setLoadError(failed?.status === 'rejected' ? errorMessage(failed.reason) : null);
    setLoading(false);
    setRevision((value) => value + 1);
  }, [service, lifecycle]);

  useEffect(() => {
    lifecycle.active = true;
    ++lifecycle.generation;
    busyRef.current = false;
    setBusy(false);
    setEntries([]);
    setStatus(null);
    setLoadError(null);
    setActionError(null);
    setDetailState(EMPTY_DETAIL);
    completedRequest.current = null;
    setSearchState({ completed: null, result: null });
    const timer = setInterval(() => {
      if (!busyRef.current && queryTimer.current === null) void refresh(true);
    }, 15_000);
    return () => {
      lifecycle.active = false;
      ++lifecycle.generation;
      ++refreshSequence.current;
      ++detailSequence.current;
      clearInterval(timer);
    };
  }, [refresh, lifecycle]);

  useEffect(() => {
    if (busy || completedRequest.current === request) return;
    setLoadError(null);
    if (request.error) {
      setLoading(false);
      void refresh(true);
      return;
    }
    if (!request.query) {
      void refresh();
      return;
    }
    setLoading(true);
    queryTimer.current = setTimeout(() => {
      queryTimer.current = null;
      void refresh();
    }, 200);
    return () => {
      if (queryTimer.current !== null) clearTimeout(queryTimer.current);
      queryTimer.current = null;
    };
  }, [request, refresh, lifecycle, busy]);

  useEffect(() => {
    const sequence = ++detailSequence.current;
    const generation = lifecycle.generation;
    const isCurrent = () => lifecycle.active && generation === lifecycle.generation && sequence === detailSequence.current;
    setDetailState((current) => {
      const value = current.value?.entry.id === selectedId ? current.value : null;
      return {
        value,
        loading: selectedId !== null && value === null,
        error: value ? current.error : null,
      };
    });
    if (selectedId === null || busy) return;
    void service.detail(selectedId).then(
      (next) => {
        if (isCurrent()) setDetailState({ value: next, loading: false, error: null });
      },
      (error: unknown) => {
        if (isCurrent()) setDetailState((current) => ({ ...current, loading: false, error: errorMessage(error) }));
      },
    );
    return () => { ++detailSequence.current; };
  }, [service, lifecycle, selectedId, revision, busy]);

  const run = useCallback(async (
    operation: () => Promise<unknown>,
    { preserveDetail = false }: { preserveDetail?: boolean } = {},
  ): Promise<boolean> => {
    if (!lifecycle.active || busyRef.current) return false;
    const generation = lifecycle.generation;
    const isCurrent = () => lifecycle.active && generation === lifecycle.generation;
    busyRef.current = true;
    setBusy(true);
    setActionError(null);
    ++refreshSequence.current;
    ++detailSequence.current;
    setLoading(false);
    if (!preserveDetail) setDetailState(EMPTY_DETAIL);
    try {
      await operation();
      if (!isCurrent()) return false;
      if (!preserveDetail) setEntries([]);
      await refresh();
      return isCurrent();
    } catch (error) {
      if (isCurrent()) setActionError(errorMessage(error));
      return false;
    } finally {
      if (isCurrent()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }, [refresh, lifecycle]);

  return {
    service, entries, status, loading, busy,
    searchReady: !request.error && searchState.result === request,
    searchPending: !request.error && searchState.completed !== request,
    queryError: request.error,
    detail: detailState.value, detailLoading: detailState.loading, detailError: detailState.error,
    error: actionError ?? request.error ?? loadError, refresh, run,
  };
}
