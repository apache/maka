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
import type { ExecutorCatalogEntry, ExecutorSelection } from '@maka/core/executor-catalog';
import type { SessionSummary } from '@maka/core/session';
import type { ConversationNewTaskTarget } from '../ports.js';
import { useConversationServices } from '../services.js';

export function useExecutorSelection(input: {
  key: string;
  target?: ConversationNewTaskTarget;
  cwd?: string;
  session?: SessionSummary;
}) {
  const services = useConversationServices();
  const [draft, setDraft] = useState<{ key: string; selection?: ExecutorSelection }>();
  const [snapshot, setSnapshot] = useState<{
    key: string;
    catalog: readonly ExecutorCatalogEntry[];
    loading: boolean;
    error?: string;
  }>();
  const [changingKey, setChangingKey] = useState<string>();
  const inFlight = useRef<string | undefined>(undefined);
  const sessionId = input.session?.id;
  const executorId = input.session?.executorId;
  const key = sessionId ?? input.key;
  const current = useRef(key);
  current.current = key;
  const revision = useRef(0);
  const refreshes = useRef(new Map<string, Promise<void>>());
  const pendingInvalidations = useRef(new Set<string>());
  const refresh = useCallback((): Promise<void> => {
    const existing = refreshes.current.get(key);
    if (existing) return existing;
    const run = (async () => {
      const attempt = ++revision.current;
      if (sessionId && !executorId) {
        setSnapshot({ key, catalog: [], loading: false });
        return;
      }
      if (!sessionId && (!input.target || !input.cwd)) return;
      setSnapshot((previous) => ({
        key,
        catalog: previous?.key === key ? previous.catalog : [],
        loading: true,
      }));
      try {
        const catalog = sessionId
          ? ((await services.sessions.getExecutorState?.(sessionId)) ?? [])
          : ((await services.newTasks.getExecutors?.(input.target!, input.cwd!)) ?? []);
        if (current.current === key && revision.current === attempt)
          setSnapshot({ key, catalog, loading: false });
      } catch (error) {
        if (current.current === key && revision.current === attempt)
          setSnapshot({
            key,
            catalog: [],
            loading: false,
            error: error instanceof Error ? error.message : 'Executor unavailable',
          });
      }
    })();
    let tracked!: Promise<void>;
    tracked = run.finally(() => {
      if (refreshes.current.get(key) !== tracked) return;
      refreshes.current.delete(key);
      if (pendingInvalidations.current.delete(key) && current.current === key) void refresh();
    });
    refreshes.current.set(key, tracked);
    return tracked;
  }, [
    key,
    sessionId,
    executorId,
    input.session?.executorConfig?.model,
    input.target?.hostId,
    input.target?.profileId,
    input.target?.projectId,
    input.cwd,
    services,
  ]);
  const invalidate = useCallback(() => {
    if (refreshes.current.has(key)) pendingInvalidations.current.add(key);
    else void refresh();
  }, [key, refresh]);
  useEffect(() => {
    const unsubscribe = services.newTasks.subscribeChanges(() => {
      invalidate();
    });
    const unSession = services.subscribeChanges((changedSessionId) => {
      if (sessionId && changedSessionId === sessionId) invalidate();
    });
    // Conversation inspection is process-free, including while a retained process is idle.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const poll = async () => {
      await refresh();
      if (!stopped) timer = setTimeout(() => void poll(), 3000);
    };
    if (sessionId && executorId) void poll();
    else void refresh();
    return () => {
      stopped = true;
      revision.current++;
      refreshes.current.delete(key);
      pendingInvalidations.current.delete(key);
      unsubscribe();
      unSession();
      clearTimeout(timer);
    };
  }, [refresh, invalidate, services, sessionId, executorId, key]);
  useEffect(() => {
    if (sessionId) setDraft(undefined);
  }, [sessionId]);
  const catalog = snapshot?.key === key ? snapshot.catalog : [];
  const inspected = catalog.find(candidate => candidate.id === executorId);
  const selection = executorId
    ? { executorId, configuration: inspected?.readiness === 'ready' && inspected.currentModel
        ? { model: inspected.currentModel } : input.session?.executorConfig ?? {} }
    : sessionId
      ? undefined
      : draft?.key === input.key
        ? draft.selection
        : undefined;
  const select = async (next: ExecutorSelection | undefined) => {
    if (inFlight.current === key) throw new Error('Executor configuration is pending');
    if (!sessionId) {
      if (next && !catalog.some(entry => entry.id === next.executorId && entry.readiness === 'ready' &&
        entry.models.some(model => model.id === next.configuration.model))) throw new Error('Executor model is unavailable');
      setDraft({ key: input.key, selection: next });
      return;
    }
    if (!next || next.executorId !== executorId || !services.sessions.setExecutorModelConfiguration)
      throw new Error('Executor configuration is unavailable');
    inFlight.current = key;
    setChangingKey(key);
    try {
      const result = await services.sessions.setExecutorModelConfiguration(
        sessionId,
        next.configuration,
      );
      if (!result.ok) throw new Error(result.code);
      if (result.session.executorConfig?.model !== next.configuration.model)
        throw new Error('Executor model change was not confirmed');
      if (current.current === key) {
        revision.current++;
        setSnapshot(previous => ({
          key, loading: false,
          catalog: (previous?.key === key ? previous.catalog : []).map(entry => entry.id === executorId
            ? { ...entry, currentModel: result.session.executorConfig!.model } : entry),
        }));
        await refresh();
      }
    } catch (error) {
      if (current.current === key) await refresh();
      if (current.current === key)
        setSnapshot((previous) => ({
          key,
          catalog: previous?.key === key ? previous.catalog : [],
          loading: false,
          error: error instanceof Error ? error.message : 'Executor configuration failed',
        }));
      throw error;
    } finally {
      if (inFlight.current === key) inFlight.current = undefined;
      setChangingKey(previous => previous === key ? undefined : previous);
    }
  };
  const entry = catalog.find((candidate) => candidate.id === selection?.executorId);
  const restore = async () => {
    if (!sessionId || !executorId) throw new Error('Executor Session is unavailable');
    const model = input.session?.executorConfig?.model ?? inspected?.currentModel;
    if (!model) throw new Error('Executor model is unavailable');
    setSnapshot((previous) =>
      previous?.key === key
        ? {
            ...previous,
            catalog: previous.catalog.map((entry) =>
              entry.id === executorId ? { ...entry, readiness: 'restoring' } : entry,
            ),
          }
        : previous,
    );
    await select({ executorId, configuration: { model } });
  };
  return {
    selection,
    catalog,
    entry,
    select,
    restore,
    refresh,
    changing: changingKey === key,
    loading: snapshot?.key !== key || snapshot.loading,
    error: snapshot?.key === key ? snapshot.error : undefined,
  };
}
