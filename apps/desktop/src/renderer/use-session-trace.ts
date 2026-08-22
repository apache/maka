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
import { generalizedErrorMessage, generalizedErrorMessageChinese } from '@maka/core/redaction';
import { type UiLocale } from '@maka/core/ui-locale';
import {
  mergeSessionTraces,
  type SessionTrace,
} from '@maka/core/session-trace';
import type { ContextDiagnosticsResult } from '@maka/runtime-host/protocol';
import type {
  DesktopSessionTracePage,
  DesktopSessionUsageSummary,
} from '../preload/bridge-contract.js';
import {
  createRefreshCoalescer,
  createTraceRefreshCoalescer,
} from './session-trace-refresh.js';

interface SessionTraceState {
  sessionId?: string;
  tracePages?: readonly DesktopSessionTracePage[];
  /**
   * What the context is made of right now, from the Host operation that owns
   * that question (#2323). Read on the same signal as the trace but kept
   * separate: it is a different fact from a different owner, and a failure to
   * answer it must not blank the causal record beside it.
   */
  context?: ContextDiagnosticsResult;
  summary?: DesktopSessionUsageSummary;
  loading: boolean;
  summaryLoading?: boolean;
  summaryError?: boolean;
  loadingEarlier?: boolean;
  error?: string;
}

interface SessionTraceSnapshot extends Omit<SessionTraceState, 'tracePages'> {
  trace?: SessionTrace;
  nextCursor?: string | null;
}

const EMPTY_STATE: SessionTraceState = { loading: false };
const EMPTY_SNAPSHOT: SessionTraceSnapshot = { loading: false };

/** Long enough to absorb a turn's closing burst, short enough to feel live. */
export const TRACE_REFRESH_DEBOUNCE_MS = 400;

/**
 * Reads the per-session causal trace (#1625).
 *
 * Reloads on the session's own event stream rather than on a timer: the trace
 * is a projection of the two ledgers, so the moment worth re-reading is when
 * one of them gained an event. Which events those are, and how a burst is
 * coalesced into one read, is `session-trace-refresh.ts`.
 *
 * Subscribes only while the panel is visible, and unsubscribes with it: a
 * hidden panel that keeps re-projecting a long session is a cost with no
 * reader.
 */
export function useSessionTrace(
  sessionId: string | undefined,
  active: boolean,
  // Handed in rather than read from the locale context, so this hook — the one
  // whose comment once outran its code — is renderable in a test without the
  // UI package behind it.
  copy: { loadFailed: string; locale: UiLocale },
): SessionTraceSnapshot & { retry: () => void; loadEarlier: () => void } {
  const traceRevisionRef = useRef(0);
  const summaryRevisionRef = useRef(0);
  const contextRevisionRef = useRef(0);
  const desiredPageCountRef = useRef<{ sessionId: string; count: number } | undefined>(undefined);
  const traceWindowRef = useRef<
    { sessionId: string; pages: readonly DesktopSessionTracePage[] } | undefined
  >(undefined);
  const [state, setState] = useState<SessionTraceState>(EMPTY_STATE);

  const readTraceWindow = useCallback(
    (targetSessionId: string) => {
      const revision = ++traceRevisionRef.current;
      const desired = desiredPageCountRef.current;
      const pageCount = desired?.sessionId === targetSessionId ? desired.count : 1;
      setState((current) =>
        current.sessionId === targetSessionId
          ? {
              ...current,
              loading: true,
              error: undefined,
            }
          : {
              sessionId: targetSessionId,
              loading: true,
            },
      );
      void readTracePageWindow(
        targetSessionId,
        pageCount,
        copy.loadFailed,
        () => revision === traceRevisionRef.current,
      ).then(
        (pages) => {
          if (revision !== traceRevisionRef.current) return;
          traceWindowRef.current = { sessionId: targetSessionId, pages };
          setState((current) =>
            current.sessionId === targetSessionId
              ? {
                  ...current,
                  tracePages: pages,
                  loading: false,
                  loadingEarlier: false,
                }
              : current,
          );
        },
        (error: unknown) => {
          if (revision !== traceRevisionRef.current) return;
          setState((current) =>
            current.sessionId === targetSessionId
              ? {
                  ...current,
                  loading: false,
                  loadingEarlier: false,
                  error:
                    copy.locale === 'zh'
                      ? generalizedErrorMessageChinese(error, copy.loadFailed)
                      : generalizedErrorMessage(error, copy.loadFailed),
                }
              : current,
          );
        },
      );
    },
    [copy.loadFailed, copy.locale],
  );

  const readEarlierPage = useCallback(
    (targetSessionId: string, requestCursor: string) => {
      const revision = ++traceRevisionRef.current;
      setState((current) =>
        current.sessionId === targetSessionId
          ? { ...current, loadingEarlier: true, error: undefined }
          : current,
      );
      void (async () => {
        try {
          const result = await window.maka.inspector.trace(targetSessionId, requestCursor);
          if (revision !== traceRevisionRef.current) return;
          const loaded = traceWindowRef.current;
          if (loaded?.sessionId !== targetSessionId) return;
          if (!result.ok) throw new Error(result.error.message || copy.loadFailed);
          const nextCursor = result.data.nextCursor;
          if (
            nextCursor !== null &&
            (nextCursor === requestCursor ||
              loaded.pages.some((page) => page.nextCursor === nextCursor))
          ) {
            throw new Error(copy.loadFailed);
          }
          const pages = [...loaded.pages, result.data];
          traceWindowRef.current = { sessionId: targetSessionId, pages };
          desiredPageCountRef.current = { sessionId: targetSessionId, count: pages.length };
          setState((current) =>
            current.sessionId === targetSessionId
              ? { ...current, tracePages: pages, loading: false, loadingEarlier: false }
              : current,
          );
        } catch (error) {
          if (revision !== traceRevisionRef.current) return;
          const loaded = traceWindowRef.current;
          desiredPageCountRef.current = {
            sessionId: targetSessionId,
            count: loaded?.sessionId === targetSessionId ? Math.max(loaded.pages.length, 1) : 1,
          };
          setState((current) =>
            current.sessionId === targetSessionId
              ? {
                  ...current,
                  loading: false,
                  loadingEarlier: false,
                  error:
                    copy.locale === 'zh'
                      ? generalizedErrorMessageChinese(error, copy.loadFailed)
                      : generalizedErrorMessage(error, copy.loadFailed),
                }
              : current,
          );
        }
      })();
    },
    [copy.loadFailed, copy.locale],
  );

  const readSummary = useCallback((targetSessionId: string) => {
      const summaryRevision = ++summaryRevisionRef.current;
      setState((current) =>
        current.sessionId === targetSessionId
          ? { ...current, summaryLoading: true, summaryError: undefined }
          : { sessionId: targetSessionId, loading: false, summaryLoading: true },
      );
      void window.maka.inspector.summary(targetSessionId).then(
        (result) => {
          if (summaryRevision !== summaryRevisionRef.current) return;
          setState((current) =>
            current.sessionId === targetSessionId
              ? {
                  ...current,
                  ...(result.ok
                    ? { summary: result.data, summaryError: undefined }
                    : { summary: undefined, summaryError: true }),
                  summaryLoading: false,
                }
              : current,
          );
        },
        () => {
          if (summaryRevision !== summaryRevisionRef.current) return;
          setState((current) =>
            current.sessionId === targetSessionId
              ? {
                  ...current,
                  summary: undefined,
                  summaryLoading: false,
                  summaryError: true,
                }
              : current,
          );
        },
      );
    }, []);

  const readContext = useCallback((targetSessionId: string) => {
      const contextRevision = ++contextRevisionRef.current;
      // Enrichment, and read as such: the context snapshot has its own owner
      // and its own failure modes, so it lands when it lands and its absence
      // costs the composition block, never the trace.
      void window.maka.inspector.context(targetSessionId).then(
        (result) => {
          if (contextRevision !== contextRevisionRef.current) return;
          setState((current) =>
            current.sessionId === targetSessionId && result.ok
              ? { ...current, context: result.data }
              : current,
          );
        },
        () => {
          // A refresh that could not reach the snapshot leaves the last one
          // standing: it is still the newest answer anyone has, and blanking it
          // would report "no composition" for a read that simply failed.
        },
      );
    }, []);

  const load = useCallback(
    (targetSessionId: string) => {
      readTraceWindow(targetSessionId);
      readSummary(targetSessionId);
      readContext(targetSessionId);
    },
    [readContext, readSummary, readTraceWindow],
  );

  useEffect(() => {
    traceRevisionRef.current += 1;
    summaryRevisionRef.current += 1;
    contextRevisionRef.current += 1;
    if (!sessionId || !active) {
      if (!sessionId) {
        traceWindowRef.current = undefined;
        desiredPageCountRef.current = undefined;
        setState(EMPTY_STATE);
      }
      return;
    }
    if (desiredPageCountRef.current?.sessionId !== sessionId) {
      desiredPageCountRef.current = { sessionId, count: 1 };
    }
    const traceCoalescer = createTraceRefreshCoalescer({
      refresh: () => {
        readTraceWindow(sessionId);
        readContext(sessionId);
      },
      delayMs: TRACE_REFRESH_DEBOUNCE_MS,
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
    const summaryCoalescer = createRefreshCoalescer({
      refresh: () => readSummary(sessionId),
      delayMs: TRACE_REFRESH_DEBOUNCE_MS,
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
    const unsubscribe = window.maka.sessions.subscribeEvents(sessionId, (event) => {
      traceCoalescer.observe(event);
    });
    const unsubscribeUsage = window.maka.inspector.subscribeUsageChanges(sessionId, () =>
      summaryCoalescer.request(),
    );
    load(sessionId);
    return () => {
      traceRevisionRef.current += 1;
      summaryRevisionRef.current += 1;
      contextRevisionRef.current += 1;
      traceCoalescer.cancel();
      summaryCoalescer.cancel();
      unsubscribe();
      unsubscribeUsage();
    };
  }, [active, load, readContext, readSummary, readTraceWindow, sessionId]);

  const retry = useCallback(() => {
    if (sessionId) load(sessionId);
  }, [load, sessionId]);

  const trace = useMemo(
    () => (state.tracePages ? mergeSessionTracePages(state.tracePages) : undefined),
    [state.tracePages],
  );
  const nextCursor = state.tracePages?.at(-1)?.nextCursor;

  const loadEarlier = useCallback(() => {
    if (!sessionId || !nextCursor || state.loading || state.loadingEarlier) return;
    const desired = desiredPageCountRef.current;
    desiredPageCountRef.current = {
      sessionId,
      count: (desired?.sessionId === sessionId ? desired.count : 1) + 1,
    };
    readEarlierPage(sessionId, nextCursor);
  }, [nextCursor, readEarlierPage, sessionId, state.loading, state.loadingEarlier]);

  if (state.sessionId !== sessionId) {
    return { ...EMPTY_SNAPSHOT, loading: Boolean(sessionId) && active, retry, loadEarlier };
  }
  const { tracePages: _tracePages, ...snapshot } = state;
  return { ...snapshot, trace, nextCursor, retry, loadEarlier };
}

async function readTracePageWindow(
  sessionId: string,
  pageCount: number,
  loadFailed: string,
  isCurrent: () => boolean,
): Promise<DesktopSessionTracePage[]> {
  const pages: DesktopSessionTracePage[] = [];
  const seen = new Set<string>();
  let requestCursor: string | null = null;
  while (pages.length < pageCount) {
    const result = await window.maka.inspector.trace(
      sessionId,
      requestCursor === null ? undefined : requestCursor,
    );
    if (!result.ok) throw new Error(result.error.message || loadFailed);
    pages.push(result.data);
    if (!isCurrent()) return pages;
    const nextCursor = result.data.nextCursor;
    if (nextCursor === null) return pages;
    if (seen.has(nextCursor)) throw new Error(loadFailed);
    seen.add(nextCursor);
    requestCursor = nextCursor;
  }
  return pages;
}

function mergeSessionTracePages(pages: readonly DesktopSessionTracePage[]): SessionTrace {
  return mergeSessionTraces(pages.map((page) => page.trace));
}
