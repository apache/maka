import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { act, createElement } from 'react';
import {
  SESSION_TRACE_SCHEMA_VERSION,
  emptyTraceTotals,
  type SessionTrace,
} from '@maka/core/session-trace';
import type { SessionEvent } from '@maka/core/events';
import type { Result } from '@maka/core/result';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import {
  TRACE_REFRESH_DEBOUNCE_MS,
  useSessionTrace,
} from '../../renderer/use-session-trace.js';

/**
 * The hook whose doc comment once described a subscription it did not have.
 * These render it for real, because that drift is invisible to every other
 * kind of test.
 */
const COPY = { loadFailed: 'failed', locale: 'en' } as const;

function trace(sessionId: string): SessionTrace {
  return {
    schemaVersion: SESSION_TRACE_SCHEMA_VERSION,
    sessionId,
    turns: [],
    totals: emptyTraceTotals(),
    coverage: {
      modelCalls: 'none',
      turnsMissingModelCalls: [],
      turnsWithFewerModelCallsThanSteps: [],
      unreadableRecords: 0,
    },
  };
}

interface TraceHarness {
  reads: string[];
  contextReads: string[];
  emit: (event: SessionEvent) => void;
  subscriptions: number;
  unsubscribes: number;
}

function installMakaBridge(): TraceHarness {
  const handlers = new Set<(event: SessionEvent) => void>();
  const harness: TraceHarness = {
    reads: [],
    contextReads: [],
    emit: (event) => {
      for (const handler of [...handlers]) handler(event);
    },
    subscriptions: 0,
    unsubscribes: 0,
  };
  // Attached to the fake window the renderer already installed: `installFakeDom`
  // replaces `globalThis.window`, so building one here first would be clobbered.
  (globalThis.window as unknown as { maka: unknown }).maka = {
      inspector: {
        trace: async (sessionId: string): Promise<Result<SessionTrace>> => {
          harness.reads.push(sessionId);
          return { ok: true, data: trace(sessionId) };
        },
        // The hook reads the context snapshot on the same signal (#2323). It
        // is counted separately: the assertions below are about how often the
        // TRACE is re-read, and an enrichment read must not move them.
        context: async (sessionId: string) => {
          harness.contextReads.push(sessionId);
          return { ok: true as const, data: { status: 'unavailable' as const, reason: 'no_completed_request' as const } };
        },
      },
      sessions: {
        subscribeEvents: (_sessionId: string, handler: (event: SessionEvent) => void) => {
          harness.subscriptions += 1;
          handlers.add(handler);
          return () => {
            harness.unsubscribes += 1;
            handlers.delete(handler);
          };
        },
      },
  };
  return harness;
}

function event(type: SessionEvent['type']): SessionEvent {
  return { type, id: `${type}-1`, turnId: 'turn-1', ts: 1 } as SessionEvent;
}

function Probe(props: {
  sessionId?: string;
  active: boolean;
  onSnapshot?: (trace: SessionTrace | undefined) => void;
}) {
  const snapshot = useSessionTrace(props.sessionId, props.active, COPY);
  props.onSnapshot?.(snapshot.trace);
  return null;
}

async function flushRefresh(): Promise<void> {
  // The coalescer's real timer, plus a margin for the read it starts. Derived
  // from the constant so the two cannot drift apart.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, TRACE_REFRESH_DEBOUNCE_MS + 50));
  });
}

describe('useSessionTrace', () => {
  afterEach(() => {
    cleanupFakeDom();
    delete (globalThis as { window?: unknown }).window;
  });

  it('subscribes only while the panel is active, and unsubscribes when it hides', async () => {
    const { root } = installReactRenderer();
    const harness = installMakaBridge();

    await act(async () => {
      root.render(createElement(Probe, { sessionId: 'session-1', active: false }));
    });
    assert.equal(harness.subscriptions, 0, 'a hidden panel subscribes to nothing');
    assert.deepEqual(harness.reads, [], 'and reads nothing');

    await act(async () => {
      root.render(createElement(Probe, { sessionId: 'session-1', active: true }));
    });
    assert.equal(harness.subscriptions, 1);
    assert.deepEqual(harness.reads, ['session-1']);

    await act(async () => {
      root.render(createElement(Probe, { sessionId: 'session-1', active: false }));
    });
    assert.equal(harness.unsubscribes, 1, 'hiding releases the subscription');
  });

  it('re-reads once for a burst of ledger-changing events', async () => {
    const { root } = installReactRenderer();
    const harness = installMakaBridge();
    await act(async () => {
      root.render(createElement(Probe, { sessionId: 'session-1', active: true }));
    });
    assert.equal(harness.reads.length, 1, 'the activation read');

    await act(async () => {
      harness.emit(event('tool_result'));
      harness.emit(event('token_usage'));
      harness.emit(event('complete'));
    });
    await flushRefresh();

    assert.equal(harness.reads.length, 2, 'a closing burst is one re-read, not three');
  });

  it('does not re-read for streaming deltas', async () => {
    const { root } = installReactRenderer();
    const harness = installMakaBridge();
    await act(async () => {
      root.render(createElement(Probe, { sessionId: 'session-1', active: true }));
    });

    await act(async () => {
      for (let index = 0; index < 20; index += 1) harness.emit(event('text_delta'));
    });
    await flushRefresh();

    assert.equal(harness.reads.length, 1, 'a streaming turn must not re-project per delta');
  });

  it('never reads after the panel hides, even for an event already in flight', async () => {
    const { root } = installReactRenderer();
    const harness = installMakaBridge();
    await act(async () => {
      root.render(createElement(Probe, { sessionId: 'session-1', active: true }));
    });

    await act(async () => {
      harness.emit(event('complete'));
    });
    await act(async () => {
      root.render(createElement(Probe, { sessionId: 'session-1', active: false }));
    });
    await flushRefresh();

    assert.equal(harness.reads.length, 1, 'the scheduled read dies with the panel');
  });

  it('keeps the previous timeline across hide and re-activation', () => {
    // Switching tabs away and back is not new information about the session, so
    // blanking the timeline would read as the panel forgetting. Nothing pinned
    // this before, so reverting it passed the suite unchanged.
    const { root } = installReactRenderer();
    const harness = installMakaBridge();
    const seen: Array<SessionTrace | undefined> = [];
    const render = async (active: boolean) => {
      await act(async () => {
        root.render(
          createElement(Probe, {
            sessionId: 'session-1',
            active,
            onSnapshot: (snapshotTrace) => seen.push(snapshotTrace),
          }),
        );
      });
    };

    return (async () => {
      await render(true);
      assert.equal(seen.at(-1)?.sessionId, 'session-1', 'the first read populates it');

      await render(false);
      await render(true);

      // Every frame of the re-activation read still carries the previous trace:
      // no render in between saw `undefined`.
      // Once a trace has arrived, no later render may go back to nothing —
      // renders before it are the initial mount and its loading frame.
      const firstTrace = seen.findIndex((snapshotTrace) => snapshotTrace !== undefined);
      assert.notEqual(firstTrace, -1, 'a trace arrived at all');
      assert.equal(
        seen.slice(firstTrace).every((snapshotTrace) => snapshotTrace !== undefined),
        true,
        'the timeline never blanks once it has content',
      );
      assert.equal(harness.reads.length, 2, 're-activation still re-reads');
    })();
  });
});
