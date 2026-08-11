import { useCallback, useEffect, useRef, useState } from 'react';
import { generalizedErrorMessage, generalizedErrorMessageChinese } from '@maka/core/redaction';
import { type UiLocale } from '@maka/core/ui-locale';
import type { SessionTrace } from '@maka/core/session-trace';
import { createTraceRefreshCoalescer } from './session-trace-refresh.js';

interface SessionTraceSnapshot {
  sessionId?: string;
  trace?: SessionTrace;
  loading: boolean;
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
): SessionTraceSnapshot & { retry: () => void } {
  const revisionRef = useRef(0);
  const [snapshot, setSnapshot] = useState<SessionTraceSnapshot>(EMPTY_SNAPSHOT);

  const load = useCallback(
    (targetSessionId: string) => {
      const revision = ++revisionRef.current;
      setSnapshot((current) => ({
        sessionId: targetSessionId,
        // Keep the last trace on screen through every read: a live turn would
        // otherwise blank the timeline on each event, and re-activation would
        // blank it on each glance.
        ...(current.sessionId === targetSessionId ? { trace: current.trace } : {}),
        loading: true,
      }));
      void window.maka.inspector.trace(targetSessionId).then(
        (result) => {
          if (revision !== revisionRef.current) return;
          if (!result.ok) {
            setSnapshot((current) => ({
              sessionId: targetSessionId,
              ...(current.sessionId === targetSessionId ? { trace: current.trace } : {}),
              loading: false,
              error: result.error.message || copy.loadFailed,
            }));
            return;
          }
          setSnapshot({ sessionId: targetSessionId, trace: result.data, loading: false });
        },
        (error: unknown) => {
          if (revision !== revisionRef.current) return;
          setSnapshot((current) => ({
            sessionId: targetSessionId,
            ...(current.sessionId === targetSessionId ? { trace: current.trace } : {}),
            loading: false,
            error:
              copy.locale === 'zh'
                ? generalizedErrorMessageChinese(error, copy.loadFailed)
                : generalizedErrorMessage(error, copy.loadFailed),
          }));
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

  if (snapshot.sessionId !== sessionId) {
    return { ...EMPTY_SNAPSHOT, loading: Boolean(sessionId) && active, retry };
  }
  return { ...snapshot, retry };
}
