import type { SessionEvent } from '@maka/core/events';

/**
 * When a live session's trace is worth re-reading (#1625).
 *
 * The trace is a projection of two durable ledgers, so the only events that can
 * change it are the ones that mean something was appended to one of them. That
 * is deliberately not "every event": a streaming turn emits text and tool-output
 * deltas continuously, and re-projecting a whole session per delta would spend
 * the session's own latency budget on watching it.
 */
const TRACE_RELEVANT_EVENT_TYPES: ReadonlySet<SessionEvent['type']> = new Set([
  'tool_start',
  'tool_result',
  'token_usage',
  'provider_retry',
  'error',
  'complete',
  'abort',
]);

export function isTraceRelevantEvent(event: SessionEvent): boolean {
  return TRACE_RELEVANT_EVENT_TYPES.has(event.type);
}

export interface TraceRefreshCoalescer {
  /** Records an event; schedules a refresh when the event can change the trace. */
  observe(event: SessionEvent): void;
  /** Drops any scheduled refresh. */
  cancel(): void;
}

/**
 * Coalesces a burst of relevant events into one re-read.
 *
 * A finishing turn emits several relevant events within milliseconds
 * (`tool_result`, `token_usage`, `complete`). Each one alone justifies a
 * re-read; three re-reads of the same session do not. The timer is injected so
 * the policy is testable without a clock or a DOM.
 */
export function createTraceRefreshCoalescer(input: {
  refresh: () => void;
  delayMs: number;
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancel: (handle: unknown) => void;
}): TraceRefreshCoalescer {
  let handle: unknown;
  const cancel = (): void => {
    if (handle === undefined) return;
    input.cancel(handle);
    handle = undefined;
  };
  return {
    observe(event) {
      if (!isTraceRelevantEvent(event)) return;
      // Restart rather than stack: the last event of a burst is the one whose
      // state the reader wants, and an earlier timer would read before it.
      cancel();
      handle = input.schedule(() => {
        handle = undefined;
        input.refresh();
      }, input.delayMs);
    },
    cancel,
  };
}
