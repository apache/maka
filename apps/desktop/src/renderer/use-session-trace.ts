import { useCallback, useEffect, useRef, useState } from 'react';
import { generalizedErrorMessage, generalizedErrorMessageChinese } from '@maka/core/redaction';
import { type UiLocale } from '@maka/core/ui-locale';
import type { SessionTrace, SessionTraceCoverage, TraceTotals } from '@maka/core/session-trace';
import type { ContextDiagnosticsResult } from '@maka/runtime-host/protocol';
import type { DesktopSessionUsageSummary } from '../preload/bridge-contract.js';
import { createTraceRefreshCoalescer } from './session-trace-refresh.js';

interface SessionTraceSnapshot {
  sessionId?: string;
  trace?: SessionTrace;
  /**
   * What the context is made of right now, from the Host operation that owns
   * that question (#2323). Read on the same signal as the trace but kept
   * separate: it is a different fact from a different owner, and a failure to
   * answer it must not blank the causal record beside it.
   */
  context?: ContextDiagnosticsResult;
  summary?: DesktopSessionUsageSummary;
  nextCursor?: string | null;
  loading: boolean;
  summaryLoading?: boolean;
  summaryError?: boolean;
  loadingEarlier?: boolean;
  error?: string;
}

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
  const revisionRef = useRef(0);
  const [snapshot, setSnapshot] = useState<SessionTraceSnapshot>(EMPTY_SNAPSHOT);

  const load = useCallback(
    (targetSessionId: string) => {
      const revision = ++revisionRef.current;
      setSnapshot((current) => ({
        sessionId: targetSessionId,
        // Keep BOTH reads on screen through every refresh. They settle
        // independently, so preserving only the trace left the composition
        // blank from the moment a read started until the second response
        // landed — a flicker on every ledger event, on data that was still
        // valid the whole time.
        ...(current.sessionId === targetSessionId
          ? {
              trace: current.trace,
              context: current.context,
              summary: current.summary,
              summaryError: current.summaryError,
              nextCursor: current.nextCursor,
            }
          : {}),
        loading: true,
        summaryLoading: true,
        summaryError: undefined,
      }));
      void window.maka.inspector.trace(targetSessionId).then(
        (result) => {
          if (revision !== revisionRef.current) return;
          if (!result.ok) {
            setSnapshot((current) => ({
              sessionId: targetSessionId,
              ...(current.sessionId === targetSessionId
                ? {
                    trace: current.trace,
                    context: current.context,
                    summary: current.summary,
                    summaryLoading: current.summaryLoading,
                    summaryError: current.summaryError,
                    nextCursor: current.nextCursor,
                  }
                : {}),
              loading: false,
              error: result.error.message || copy.loadFailed,
            }));
            return;
          }
          setSnapshot((current) => ({
            sessionId: targetSessionId,
            trace:
              current.sessionId === targetSessionId && current.trace
                ? mergeSessionTrace(current.trace, result.data.trace)
                : result.data.trace,
            nextCursor:
              current.sessionId === targetSessionId && current.trace
                ? current.nextCursor
                : result.data.nextCursor,
            ...(current.sessionId === targetSessionId
              ? {
                  context: current.context,
                  summary: current.summary,
                  summaryLoading: current.summaryLoading,
                  summaryError: current.summaryError,
                }
              : {}),
            loading: false,
          }));
        },
        (error: unknown) => {
          if (revision !== revisionRef.current) return;
          setSnapshot((current) => ({
            sessionId: targetSessionId,
            ...(current.sessionId === targetSessionId
              ? {
                  trace: current.trace,
                  context: current.context,
                  summary: current.summary,
                  summaryLoading: current.summaryLoading,
                  summaryError: current.summaryError,
                  nextCursor: current.nextCursor,
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
          if (revision !== revisionRef.current) return;
          setSnapshot((current) =>
            current.sessionId === targetSessionId
              ? {
                  ...current,
                  ...(result.ok
                    ? { summary: result.data, summaryError: undefined }
                    : { summaryError: true }),
                  summaryLoading: false,
                }
              : current,
          );
        },
        () => {
          if (revision !== revisionRef.current) return;
          setSnapshot((current) =>
            current.sessionId === targetSessionId
              ? { ...current, summaryLoading: false, summaryError: true }
              : current,
          );
        },
      );
      // Enrichment, and read as such: the context snapshot has its own owner
      // and its own failure modes, so it lands when it lands and its absence
      // costs the composition block, never the trace.
      void window.maka.inspector.context(targetSessionId).then(
        (result) => {
          if (revision !== revisionRef.current) return;
          setSnapshot((current) =>
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
    revisionRef.current += 1;
    if (!sessionId || !active) {
      if (!sessionId) setSnapshot(EMPTY_SNAPSHOT);
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
      revisionRef.current += 1;
      coalescer.cancel();
      unsubscribe();
    };
  }, [active, load, sessionId]);

  const retry = useCallback(() => {
    if (sessionId) load(sessionId);
  }, [load, sessionId]);

  const loadEarlier = useCallback(() => {
    const cursor = snapshot.sessionId === sessionId ? snapshot.nextCursor : undefined;
    if (!sessionId || !cursor || snapshot.loadingEarlier) return;
    const revision = revisionRef.current;
    setSnapshot((current) => ({ ...current, loadingEarlier: true, error: undefined }));
    void window.maka.inspector.trace(sessionId, cursor).then(
      (result) => {
        if (revision !== revisionRef.current) return;
        if (!result.ok) {
          setSnapshot((current) => ({
            ...current,
            loadingEarlier: false,
            error: result.error.message || copy.loadFailed,
          }));
          return;
        }
        setSnapshot((current) => ({
          ...current,
          trace: current.trace
            ? mergeSessionTrace(current.trace, result.data.trace)
            : result.data.trace,
          nextCursor: result.data.nextCursor,
          loadingEarlier: false,
        }));
      },
      (error: unknown) => {
        if (revision !== revisionRef.current) return;
        setSnapshot((current) => ({
          ...current,
          loadingEarlier: false,
          error:
            copy.locale === 'zh'
              ? generalizedErrorMessageChinese(error, copy.loadFailed)
              : generalizedErrorMessage(error, copy.loadFailed),
        }));
      },
    );
  }, [copy.loadFailed, copy.locale, sessionId, snapshot.loadingEarlier, snapshot.nextCursor, snapshot.sessionId]);

  if (snapshot.sessionId !== sessionId) {
    return { ...EMPTY_SNAPSHOT, loading: Boolean(sessionId) && active, retry, loadEarlier };
  }
  return { ...snapshot, retry, loadEarlier };
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
    totals: ordered.reduce<TraceTotals>((total, turn) => mergeTotals(total, turn.totals), emptyTotals()),
    coverage: mergeCoverage(current.coverage, page.coverage),
  };
}

function emptyTotals(): TraceTotals {
  return {
    durationMs: 0,
    modelAttempts: 0,
    retries: 0,
    compactions: 0,
    inputTokens: 0,
    outputTokens: 0,
    unpricedAttempts: 0,
  };
}

function mergeTotals(left: TraceTotals, right: TraceTotals): TraceTotals {
  return {
    durationMs: left.durationMs + right.durationMs,
    modelAttempts: left.modelAttempts + right.modelAttempts,
    retries: left.retries + right.retries,
    compactions: left.compactions + right.compactions,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...(left.costUsd !== undefined || right.costUsd !== undefined
      ? { costUsd: (left.costUsd ?? 0) + (right.costUsd ?? 0) }
      : {}),
    unpricedAttempts: left.unpricedAttempts + right.unpricedAttempts,
  };
}

function mergeCoverage(
  left: SessionTraceCoverage,
  right: SessionTraceCoverage,
): SessionTraceCoverage {
  const rank = { none: 0, no_known_gap: 1, partial: 2, absent: 3 } as const;
  const modelCalls = rank[left.modelCalls] >= rank[right.modelCalls] ? left.modelCalls : right.modelCalls;
  return {
    modelCalls,
    turnsMissingModelCalls: [...new Set([...left.turnsMissingModelCalls, ...right.turnsMissingModelCalls])],
    turnsWithFewerModelCallsThanSteps: [
      ...new Set([
        ...left.turnsWithFewerModelCallsThanSteps,
        ...right.turnsWithFewerModelCallsThanSteps,
      ]),
    ],
    unreadableRecords: Math.max(left.unreadableRecords, right.unreadableRecords),
  };
}
