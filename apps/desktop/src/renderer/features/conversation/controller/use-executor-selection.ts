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
import type { ExecutorCatalogEntry, ExecutorConfiguration, ExecutorSelection } from '@maka/core/executor-catalog';
import type { SessionSummary } from '@maka/core/session';
import type { ConversationNewTaskTarget } from '../ports.js';
import { useConversationServices } from '../services.js';

export function useExecutorSelection(input: {
  key: string;
  target?: ConversationNewTaskTarget;
  cwd?: string;
  session?: SessionSummary;
  /** Local creation has not yet materialized a Session on the Host. */
  sessionPending?: boolean;
}) {
  const services = useConversationServices();
  const [draft, setDraft] = useState<{ key: string; selection?: ExecutorSelection }>();
  const [snapshot, setSnapshot] = useState<{
    key: string;
    catalog: readonly ExecutorCatalogEntry[];
    loading: boolean;
    error?: string;
  }>();
  const handoff = useRef<typeof snapshot>(undefined);
  const [changingKey, setChangingKey] = useState<string>();
  const [confirmed, setConfirmed] = useState<{
    key: string;
    previous?: ExecutorConfiguration;
    configuration: ExecutorConfiguration;
  }>();
  const inFlight = useRef<string | undefined>(undefined);
  const sessionId = input.session?.id;
  const executorId = input.session?.executorId;
  const key = sessionId ?? JSON.stringify([
    input.key,
    input.target?.hostId,
    input.target?.profileId,
    input.target?.projectId,
    input.cwd,
  ]);
  const current = useRef(key);
  current.current = key;
  const revision = useRef(0);
  const refreshes = useRef(new Map<string, Promise<void>>());
  const pendingInvalidations = useRef(new Set<string>());
  const pendingForce = useRef(new Set<string>());
  const refresh = useCallback((force = false): Promise<void> => {
    const existing = refreshes.current.get(key);
    if (existing) {
      if (force) {
        pendingInvalidations.current.add(key);
        pendingForce.current.add(key);
      }
      return existing;
    }
    const run = (async () => {
      const attempt = ++revision.current;
      if (sessionId && !executorId) {
        setSnapshot({ key, catalog: [], loading: false });
        return;
      }
      if (!sessionId && (!input.target || !input.cwd)) return;
      const inherited = handoff.current?.key === key ? handoff.current : undefined;
      setSnapshot((previous) => {
        const seed = previous?.key === key ? previous : inherited;
        return { key, catalog: seed?.catalog ?? [], loading: true };
      });
      if (sessionId && input.sessionPending) return;
      try {
        const catalog = sessionId
          ? ((await services.sessions.getExecutorState?.(sessionId)) ?? [])
          : ((await services.newTasks.getExecutors?.(input.target!, input.cwd!, force)) ?? []);
        if (current.current === key && revision.current === attempt)
          setSnapshot(previous => {
            const seed = previous?.key === key ? previous : inherited;
            return {
              key, loading: false,
              catalog: catalog.map(entry => {
                const known = seed?.catalog.find(candidate => candidate.id === entry.id);
                // Inspection can expose saved IDs while initialization or a
                // configuration update is pending. Reuse this Session's known
                // presentation, independently of its observed mode capability.
                if (!known || known.readiness !== 'ready' || entry.readiness !== 'ready' ||
                  entry.supportsModelChange || !entry.models.every(model => model.name === model.id))
                  return entry;
                return { ...entry, displayName: known.displayName, models: known.models,
                  modelGroups: known.modelGroups,
                  ...(!entry.supportsModeChange ? {
                    modes: known.modes, currentMode: entry.currentMode ?? known.currentMode,
                  } : {}),
                };
              }),
            };
          });
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
      const forced = pendingForce.current.delete(key);
      if (pendingInvalidations.current.delete(key) && current.current === key) void refresh(forced);
    });
    refreshes.current.set(key, tracked);
    return tracked;
  }, [
    key,
    sessionId,
    executorId,
    input.sessionPending,
    input.session?.executorConfig?.model,
    input.session?.executorConfig?.mode,
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
    if (sessionId && executorId && !input.sessionPending) void poll();
    else void refresh();
    return () => {
      stopped = true;
      revision.current++;
      refreshes.current.delete(key);
      pendingInvalidations.current.delete(key);
      pendingForce.current.delete(key);
      unsubscribe();
      unSession();
      clearTimeout(timer);
    };
  }, [refresh, invalidate, services, sessionId, executorId, key, input.sessionPending]);
  useEffect(() => {
    if (sessionId) setDraft(undefined);
  }, [sessionId]);
  useEffect(() => {
    // Retire a handoff only after its replacement has committed. A superseded
    // request must not erase it before the next inspection can inherit it.
    if (snapshot && handoff.current?.key === snapshot.key) handoff.current = undefined;
  }, [snapshot]);
  useEffect(() => {
    if (confirmed?.key === key &&
      confirmed.configuration.model === input.session?.executorConfig?.model &&
      confirmed.configuration.mode === input.session?.executorConfig?.mode)
      setConfirmed(undefined);
  }, [key, confirmed, input.session?.executorConfig?.model, input.session?.executorConfig?.mode]);
  const currentSnapshot = snapshot?.key === key ? snapshot : handoff.current?.key === key ? handoff.current : undefined;
  const catalog = currentSnapshot?.catalog ?? [];
  const inspected = catalog.find(candidate => candidate.id === executorId);
  // The catalog describes observed Agent state. The saved Session config is the
  // selection that will be applied before the next prompt.
  const savedConfiguration = confirmed?.key === key &&
    confirmed.previous?.model === input.session?.executorConfig?.model &&
    confirmed.previous?.mode === input.session?.executorConfig?.mode
      ? confirmed.configuration
      : {
          ...(input.sessionPending && executorId && input.session?.model && input.session.model !== executorId
            ? { model: input.session.model }
            : {}),
          ...input.session?.executorConfig,
        };
  const selection = executorId
    ? { executorId, configuration: inspected?.readiness === 'ready'
        ? { ...(inspected.currentModel ? { model: inspected.currentModel } : {}),
            ...(inspected.currentMode ? { mode: inspected.currentMode } : {}),
            ...savedConfiguration }
        : savedConfiguration ?? {} }
    : sessionId
      ? undefined
      : draft?.key === key
        ? draft.selection
        : undefined;
  const select = async (next: ExecutorSelection | undefined) => {
    if (inFlight.current === key) throw new Error('Executor configuration is pending');
    if (!sessionId) {
      if (next && !catalog.some(entry => entry.id === next.executorId && entry.readiness === 'ready' &&
        (!next.configuration.model || entry.models.some(model => model.id === next.configuration.model)) &&
        (!next.configuration.mode || entry.modes?.some(mode => mode.id === next.configuration.mode))))
        throw new Error('Executor configuration is unavailable');
      setDraft({ key, selection: next });
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
      if ((next.configuration.model && result.session.executorConfig?.model !== next.configuration.model) ||
        (next.configuration.mode && result.session.executorConfig?.mode !== next.configuration.mode))
        throw new Error('Executor configuration change was not confirmed');
      if (current.current === key) {
        setConfirmed({
          key,
          previous: input.session?.executorConfig,
          configuration: result.session.executorConfig ?? {},
        });
        revision.current++;
        setSnapshot(previous => ({
          key, loading: false,
          catalog: (previous?.key === key ? previous.catalog : []).map(entry => entry.id === executorId
            ? { ...entry, currentModel: result.session.executorConfig?.model, currentMode: result.session.executorConfig?.mode } : entry),
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
  const adoptSession = (session: SessionSummary) => {
    if (sessionId || !selection || !entry || session.executorId !== selection.executorId) return;
    // Only a submitted draft hands its catalog to the new Session. Navigation
    // to another task must still inspect that task's own executor state.
    revision.current++;
    const initial = { ...entry,
      currentModel: session.executorConfig?.model ?? selection.configuration.model ?? entry.currentModel,
      currentMode: session.executorConfig?.mode ?? selection.configuration.mode ?? entry.currentMode,
    };
    handoff.current = { key: session.id, catalog: [initial], loading: true };
  };
  const restore = async () => {
    if (!sessionId || !executorId) throw new Error('Executor Session is unavailable');
    if (inFlight.current === key) throw new Error('Executor configuration is pending');
    let configuration = input.session?.executorConfig ?? {
      ...(inspected?.currentModel ? { model: inspected.currentModel } : {}),
      ...(inspected?.currentMode ? { mode: inspected.currentMode } : {}),
    };
    // A failed restore exposes the last observed model capabilities. Let an
    // explicit retry recover from a removed mode without weakening prompt validation.
    if (inspected?.readiness === 'restore_failed' && configuration.model && configuration.mode &&
      inspected.supportsModelChange && inspected.currentModel === configuration.model &&
      (inspected.supportsModeChange === false || (inspected.supportsModeChange === true &&
        !inspected.modes?.some(mode => mode.id === configuration.mode))))
      configuration = { model: configuration.model };
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
    await select({ executorId, configuration });
  };
  return {
    selection,
    catalog,
    entry,
    select,
    restore,
    refresh,
    adoptSession,
    changing: changingKey === key,
    loading: !currentSnapshot || currentSnapshot.loading,
    error: currentSnapshot?.error,
  };
}
