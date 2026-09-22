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

import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useMountedRef, useToast } from '@maka/ui';
import { resolveUsageRange } from '@maka/core/model-call-usage-projection';
import type {
  UsageRange,
  UsageStats,
  UsageScreenFailure,
  UsageScreenQuery,
} from '@maka/core/settings';
import type { UsageServices } from './ports.js';

interface UsageSnapshot {
  readonly installation: number;
  readonly value: UsageStats | null;
}
export interface UsageScopeHandle {
  fenceTarget(): void;
}
type Filters = Pick<UsageScreenQuery, 'search' | 'status'>;
type CapacityFailure = Extract<UsageScreenFailure, { kind: 'screen_response_too_large' }>;
export interface UsagePagingProgress {
  readonly loadedRecords: number;
  readonly targetRecords: number;
}
interface UsageScopeValue {
  readonly services: UsageServices;
  readonly snapshot: UsageSnapshot | null;
  readonly targetKey: string;
  readonly state: 'ready' | 'loading' | 'stale' | 'error';
  readonly error: string | null;
  readonly failure: CapacityFailure | null;
  readonly paging: boolean;
  readonly pagingProgress: UsagePagingProgress | null;
  reload(range: UsageRange, filters?: Filters, preserveRange?: boolean): Promise<void>;
  loadMore(minimumRecords?: number): Promise<boolean>;
}
const UsageScopeContext = createContext<UsageScopeValue | null>(null);

/** One complete visible screen. Request tickets fence both loads and pages,
 * including equal-revision filter changes and synchronous Host replacement. */
export const UsageFeatureScope = forwardRef<
  UsageScopeHandle,
  {
    readonly targetKey: string;
    readonly services: UsageServices;
    readonly loadErrorTitle: string;
    describeError(error: unknown): string;
    readonly children?: ReactNode;
  }
>(function UsageFeatureScope(props, ref) {
  const toast = useToast();
  const mountedRef = useMountedRef();
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [state, setState] = useState<UsageScopeValue['state']>('ready');
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<CapacityFailure | null>(null);
  const [paging, setPaging] = useState(false);
  const [pagingProgress, setPagingProgress] = useState<UsagePagingProgress | null>(null);
  const [renderedTargetKey, setRenderedTargetKey] = useState(props.targetKey);
  const ticketRef = useRef(0);
  const blockedRef = useRef(false);
  const pagingRef = useRef(false);
  const resolvedRef = useRef<{ range: UsageRange; query: UsageScreenQuery } | null>(null);
  const { targetKey, services, loadErrorTitle, describeError } = props;
  const clear = () => {
    ticketRef.current += 1;
    blockedRef.current = true;
    pagingRef.current = false;
    resolvedRef.current = null;
    setSnapshot(null);
    setState('ready');
    setError(null);
    setFailure(null);
    setPaging(false);
    setPagingProgress(null);
  };
  if (targetKey !== renderedTargetKey) {
    setRenderedTargetKey(targetKey);
    clear();
  }

  const reload = useCallback(
    async (
      range: UsageRange,
      filters: Filters = { search: '', status: 'all' },
      preserveRange = false,
    ) => {
      const ticket = ++ticketRef.current;
      blockedRef.current = true;
      pagingRef.current = false;
      setState('loading');
      setError(null);
      setFailure(null);
      setPaging(false);
      setPagingProgress(null);
      const query: UsageScreenQuery = {
        range:
          preserveRange && resolvedRef.current?.range === range
            ? resolvedRef.current.query.range
            : resolveUsageRange(range, Date.now()),
        search: filters.search.trim().toLowerCase(),
        status: filters.status,
      };
      resolvedRef.current = { range, query };
      try {
        const value = await services.loadUsageStats(range, query);
        if (!mountedRef.current || ticket !== ticketRef.current) return;
        if (value && 'kind' in value) {
          setState('error');
          setFailure(value);
          return;
        }
        setSnapshot({ value, installation: ticket });
        setState('ready');
        blockedRef.current = false;
      } catch (error) {
        if (!mountedRef.current || ticket !== ticketRef.current) return;
        setState('error');
        const message = describeError(error);
        setError(message);
        toast.error(loadErrorTitle, message);
      }
    },
    [services, loadErrorTitle, describeError, toast, mountedRef],
  );

  const loadMore = useCallback(
    async (minimumRecords = 0) => {
      const current = snapshot?.value;
      const navigation = current?.navigation;
      if (
        !snapshot ||
        !current ||
        blockedRef.current ||
        pagingRef.current ||
        !navigation?.nextCursor ||
        !services.loadUsageActivity
      )
        return false;
      const ticket = ticketRef.current;
      const targetRecords = Math.max(minimumRecords, current.logs.length + 1);
      pagingRef.current = true;
      setPaging(true);
      setPagingProgress({ loadedRecords: current.logs.length, targetRecords });
      try {
        const logs = [...current.logs];
        let nextCursor: string | null = navigation.nextCursor;
        do {
          const result = await services.loadUsageActivity({
            kind: 'activity',
            query: navigation.query,
            revision: navigation.revision,
            queryIdentity: navigation.queryIdentity,
            cursor: nextCursor,
          });
          if (!mountedRef.current || ticket !== ticketRef.current) return false;
          if (result.kind === 'revision_changed') {
            blockedRef.current = true;
            setState('stale');
            return false;
          }
          if (result.kind === 'screen_response_too_large') {
            blockedRef.current = true;
            setState('error');
            setFailure(result);
            return false;
          }
          if (
            result.kind !== 'activity' ||
            result.page.revision !== navigation.revision ||
            result.page.queryIdentity !== navigation.queryIdentity ||
            result.page.nextCursor === nextCursor
          )
            throw new Error('Invalid Usage continuation');
          logs.push(...result.page.logs);
          nextCursor = result.page.nextCursor;
          setPagingProgress({ loadedRecords: logs.length, targetRecords });
        } while (nextCursor && logs.length < minimumRecords);
        setSnapshot({
          ...snapshot,
          value: {
            ...current,
            logs,
            navigation: { ...navigation, nextCursor },
          },
        });
        return true;
      } catch (error) {
        if (!mountedRef.current || ticket !== ticketRef.current) return false;
        blockedRef.current = true;
        setState('error');
        setError(describeError(error));
        return false;
      } finally {
        if (mountedRef.current && ticket === ticketRef.current) {
          pagingRef.current = false;
          setPaging(false);
          setPagingProgress(null);
        }
      }
    },
    [snapshot, services, mountedRef, describeError],
  );

  useImperativeHandle(ref, () => ({ fenceTarget: clear }));
  const value = useMemo<UsageScopeValue>(
    () => ({
      services,
      snapshot,
      targetKey,
      state,
      error,
      failure,
      paging,
      pagingProgress,
      reload,
      loadMore,
    }),
    [
      services,
      snapshot,
      targetKey,
      state,
      error,
      failure,
      paging,
      pagingProgress,
      reload,
      loadMore,
    ],
  );
  return <UsageScopeContext.Provider value={value}>{props.children}</UsageScopeContext.Provider>;
});
function useUsageScope(): UsageScopeValue {
  const value = useContext(UsageScopeContext);
  if (!value) throw new Error('UsageFeatureScope is missing');
  return value;
}
export function useUsageServices(): UsageServices {
  return useUsageScope().services;
}
export function useUsageStats(_range: UsageRange) {
  const { snapshot, ...scope } = useUsageScope();
  return {
    ...scope,
    stats: snapshot?.value ?? null,
    screenVersion: snapshot?.installation ?? 0,
  };
}
