import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { generalizedErrorMessage, generalizedErrorMessageChinese } from '@maka/core/redaction';
import { type UiLocale } from '@maka/core/ui-locale';
import {
  emptyTraceTotals,
  mergeDisjointTraceCoverage,
  mergeTraceTotals,
  type SessionTrace,
} from '@maka/core/session-trace';
import type { ContextDiagnosticsResult } from '@maka/runtime-host/protocol';
import type {
  DesktopSessionTracePage,
  DesktopSessionUsageSummary,
} from '../preload/bridge-contract.js';
import { createTraceRefreshCoalescer } from './session-trace-refresh.js';

interface SessionTracePageEntry {
  /** `null` is the stable identity of the newest page. */
  requestCursor: string | null;
  response: DesktopSessionTracePage;
}

interface SessionTraceState {
  sessionId?: string;
  tracePages?: readonly SessionTracePageEntry[];
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
  const sessionEpochRef = useRef(0);
  const headRevisionRef = useRef(0);
  const traceWindowRef = useRef<
    { sessionId: string; pages: readonly SessionTracePageEntry[] } | undefined
  >(undefined);
  const [state, setState] = useState<SessionTraceState>(EMPTY_STATE);

  const load = useCallback(
    (targetSessionId: string) => {
      const revision = ++headRevisionRef.current;
      const existingPages =
        traceWindowRef.current?.sessionId === targetSessionId
          ? traceWindowRef.current.pages
          : [];
      setState((current) => ({
        sessionId: targetSessionId,
        // Keep BOTH reads on screen through every refresh. They settle
        // independently, so preserving only the trace left the composition
        // blank from the moment a read started until the second response
        // landed — a flicker on every ledger event, on data that was still
        // valid the whole time.
        ...(current.sessionId === targetSessionId
          ? {
              tracePages: current.tracePages,
              context: current.context,
              summary: current.summary,
              summaryError: current.summaryError,
            }
          : {}),
        loading: true,
        summaryLoading: true,
        summaryError: undefined,
      }));
      void readRefreshedTracePages(targetSessionId, existingPages, copy.loadFailed).then(
        ({ prefix, reconnectCursor }) => {
          if (revision !== headRevisionRef.current) return;
          const latestPages =
            traceWindowRef.current?.sessionId === targetSessionId
              ? traceWindowRef.current.pages
              : [];
          const reconnectIndex =
            reconnectCursor === null
              ? -1
              : latestPages.findIndex((entry) => entry.requestCursor === reconnectCursor);
          const pages =
            reconnectIndex >= 0
              ? [...prefix, ...latestPages.slice(reconnectIndex)]
              : prefix;
          traceWindowRef.current = { sessionId: targetSessionId, pages };
          setState((current) => ({
            sessionId: targetSessionId,
            tracePages: pages,
            ...(current.sessionId === targetSessionId
              ? {
                  context: current.context,
                  summary: current.summary,
                  summaryLoading: current.summaryLoading,
                  summaryError: current.summaryError,
                  loadingEarlier: current.loadingEarlier,
                }
              : {}),
            loading: false,
          }));
        },
        (error: unknown) => {
          if (revision !== headRevisionRef.current) return;
          setState((current) => ({
            sessionId: targetSessionId,
            ...(current.sessionId === targetSessionId
              ? {
                  tracePages: current.tracePages,
                  context: current.context,
                  summary: current.summary,
                  summaryLoading: current.summaryLoading,
                  summaryError: current.summaryError,
                  loadingEarlier: current.loadingEarlier,
                }
              : {}),
            loading: false,
            error:
              copy.locale === 'zh'
                ? generalizedErrorMessageChinese(error, copy.loadFailed)
                : generalizedErrorMessage(error, copy.loadFailed),
          }));
        },
      );
      void window.maka.inspector.summary(targetSessionId).then(
        (result) => {
          if (revision !== headRevisionRef.current) return;
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
          if (revision !== headRevisionRef.current) return;
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
      // Enrichment, and read as such: the context snapshot has its own owner
      // and its own failure modes, so it lands when it lands and its absence
      // costs the composition block, never the trace.
      void window.maka.inspector.context(targetSessionId).then(
        (result) => {
          if (revision !== headRevisionRef.current) return;
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
    },
    [copy.loadFailed, copy.locale],
  );

  useEffect(() => {
    sessionEpochRef.current += 1;
    headRevisionRef.current += 1;
    if (!sessionId || !active) {
      if (!sessionId) {
        traceWindowRef.current = undefined;
        setState(EMPTY_STATE);
      }
      return;
    }
    const coalescer = createTraceRefreshCoalescer({
      refresh: () => load(sessionId),
      delayMs: TRACE_REFRESH_DEBOUNCE_MS,
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
    const unsubscribe = window.maka.sessions.subscribeEvents(sessionId, (event) => {
      coalescer.observe(event);
    });
    load(sessionId);
    return () => {
      sessionEpochRef.current += 1;
      headRevisionRef.current += 1;
      coalescer.cancel();
      unsubscribe();
    };
  }, [active, load, sessionId]);

  const retry = useCallback(() => {
    if (sessionId) load(sessionId);
  }, [load, sessionId]);

  const trace = useMemo(
    () => (state.tracePages ? mergeSessionTracePages(state.tracePages) : undefined),
    [state.tracePages],
  );
  const nextCursor = state.tracePages?.at(-1)?.response.nextCursor;

  const loadEarlier = useCallback(() => {
    const cursor = state.sessionId === sessionId ? nextCursor : undefined;
    if (!sessionId || !cursor || state.loadingEarlier) return;
    const sessionEpoch = sessionEpochRef.current;
    setState((current) => ({ ...current, loadingEarlier: true, error: undefined }));
    void window.maka.inspector.trace(sessionId, cursor).then(
      (result) => {
        if (sessionEpoch !== sessionEpochRef.current) return;
        if (!result.ok) {
          setState((current) => ({
            ...current,
            loadingEarlier: false,
            error: result.error.message || copy.loadFailed,
          }));
          return;
        }
        const currentWindow = traceWindowRef.current;
        if (currentWindow?.sessionId !== sessionId) return;
        const pages = upsertTracePage(currentWindow.pages, cursor, result.data);
        traceWindowRef.current = { sessionId, pages };
        setState((current) =>
          current.sessionId === sessionId
            ? { ...current, tracePages: pages, loadingEarlier: false }
            : current,
        );
      },
      (error: unknown) => {
        if (sessionEpoch !== sessionEpochRef.current) return;
        setState((current) => ({
          ...current,
          loadingEarlier: false,
          error:
            copy.locale === 'zh'
              ? generalizedErrorMessageChinese(error, copy.loadFailed)
              : generalizedErrorMessage(error, copy.loadFailed),
        }));
      },
    );
  }, [copy.loadFailed, copy.locale, nextCursor, sessionId, state.loadingEarlier, state.sessionId]);

  if (state.sessionId !== sessionId) {
    return { ...EMPTY_SNAPSHOT, loading: Boolean(sessionId) && active, retry, loadEarlier };
  }
  const { tracePages: _tracePages, ...snapshot } = state;
  return { ...snapshot, trace, nextCursor, retry, loadEarlier };
}

async function readRefreshedTracePages(
  sessionId: string,
  existingPages: readonly SessionTracePageEntry[],
  loadFailed: string,
): Promise<{
  prefix: SessionTracePageEntry[];
  reconnectCursor: string | null;
}> {
  const prefix: SessionTracePageEntry[] = [];
  const seen = new Set<string>();
  let requestCursor: string | null = null;
  while (true) {
    const result = await window.maka.inspector.trace(
      sessionId,
      requestCursor === null ? undefined : requestCursor,
    );
    if (!result.ok) throw new Error(result.error.message || loadFailed);
    prefix.push({ requestCursor, response: result.data });
    const nextCursor = result.data.nextCursor;
    if (existingPages.length === 0 || nextCursor === null) {
      return { prefix, reconnectCursor: null };
    }
    if (seen.has(nextCursor)) throw new Error(loadFailed);
    const reconnects =
      existingPages.some((entry) => entry.requestCursor === nextCursor) ||
      existingPages.at(-1)?.response.nextCursor === nextCursor;
    if (reconnects) return { prefix, reconnectCursor: nextCursor };
    seen.add(nextCursor);
    requestCursor = nextCursor;
  }
}

function upsertTracePage(
  pages: readonly SessionTracePageEntry[],
  requestCursor: string,
  response: DesktopSessionTracePage,
): readonly SessionTracePageEntry[] {
  const entry = { requestCursor, response };
  const existingIndex = pages.findIndex((page) => page.requestCursor === requestCursor);
  if (existingIndex >= 0) {
    return pages.map((page, index) => (index === existingIndex ? entry : page));
  }
  const parentIndex = pages.findIndex((page) => page.response.nextCursor === requestCursor);
  if (parentIndex < 0) return pages;
  return [...pages.slice(0, parentIndex + 1), entry];
}

function mergeSessionTracePages(pages: readonly SessionTracePageEntry[]): SessionTrace {
  return pages
    .map((entry) => entry.response.trace)
    .reduce((current, page) => mergeSessionTrace(current, page));
}

function mergeSessionTrace(current: SessionTrace, page: SessionTrace): SessionTrace {
  const turns = new Map(current.turns.map((turn) => [`${turn.turnId}\0${turn.runId}`, turn]));
  for (const turn of page.turns) turns.set(`${turn.turnId}\0${turn.runId}`, turn);
  const ordered = [...turns.values()].sort(
    (left, right) => left.startedAt - right.startedAt || left.runId.localeCompare(right.runId),
  );
  return {
    schemaVersion: current.schemaVersion,
    sessionId: current.sessionId,
    turns: ordered,
    totals: ordered.reduce(
      (total, turn) => mergeTraceTotals(total, turn.totals),
      emptyTraceTotals(),
    ),
    coverage: mergeDisjointTraceCoverage(current.coverage, page.coverage),
  };
}
