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

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { act, createElement } from 'react';
import {
  SESSION_TRACE_SCHEMA_VERSION,
  type SessionTrace,
} from '@maka/core/session-trace';
import type { SessionEvent } from '@maka/core/events';
import type { Result } from '@maka/core/result';
import type {
  DesktopSessionTracePage,
  DesktopSessionUsageSummary,
} from '../../preload/bridge-contract.js';
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
    coverage: {
      modelCalls: 'none',
      turnsMissingModelCalls: [],
      turnsWithFewerModelCallsThanSteps: [],
      unreadableRecords: 0,
      oversizedRuns: 0,
    },
  };
}

function usageSummary(
  totalRequests = 0,
  totalCostUsd = 0,
): DesktopSessionUsageSummary {
  return {
    range: { from: 0, to: 1 },
    totalRequests,
    totalCostUsd,
    totalTokens: {
      input: totalRequests,
      output: 0,
      cacheMiss: totalRequests,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: totalRequests,
    },
    cacheHitRequests: 0,
    cacheCreateRequests: 0,
    errorRequests: 0,
    provenance: {
      coverage: {
        attempts: totalRequests,
        pricedAttempts: totalRequests,
        unpricedAttempts: 0,
        usageReportedAttempts: totalRequests,
        usagePartialAttempts: 0,
        usageMissingAttempts: 0,
      },
      legacyRecords: 0,
      unreadableRecords: 0,
      pendingRepairs: 0,
    },
  };
}

interface TraceHarness {
  reads: string[];
  traceRequests: Array<{ sessionId: string; cursor?: string }>;
  contextReads: string[];
  summaryReads: string[];
  emit: (event: SessionEvent) => void;
  emitUsageChange: () => void;
  subscriptions: number;
  unsubscribes: number;
}

function installMakaBridge(
  options: {
    tracePages?: DesktopSessionTracePage[];
    trace?: (
      sessionId: string,
      cursor?: string,
    ) => Promise<Result<DesktopSessionTracePage>>;
    summary?: (
      sessionId: string,
      readIndex: number,
    ) => Promise<Result<DesktopSessionUsageSummary>>;
  } = {},
): TraceHarness {
  const handlers = new Set<(event: SessionEvent) => void>();
  const usageChangeHandlers = new Set<() => void>();
  const harness: TraceHarness = {
    reads: [],
    traceRequests: [],
    contextReads: [],
    summaryReads: [],
    emit: (event) => {
      for (const handler of [...handlers]) handler(event);
    },
    emitUsageChange: () => {
      for (const handler of [...usageChangeHandlers]) handler();
    },
    subscriptions: 0,
    unsubscribes: 0,
  };
  // Attached to the fake window the renderer already installed: `installFakeDom`
  // replaces `globalThis.window`, so building one here first would be clobbered.
  (globalThis.window as unknown as { maka: unknown }).maka = {
      inspector: {
        trace: async (
          sessionId: string,
          cursor?: string,
        ): Promise<Result<DesktopSessionTracePage>> => {
          harness.reads.push(sessionId);
          harness.traceRequests.push({ sessionId, ...(cursor ? { cursor } : {}) });
          if (options.trace) return options.trace(sessionId, cursor);
          return {
            ok: true,
            data: options.tracePages?.shift() ?? { trace: trace(sessionId), nextCursor: null },
          };
        },
        summary: async (sessionId: string) => {
          harness.summaryReads.push(sessionId);
          if (options.summary) return options.summary(sessionId, harness.summaryReads.length);
          return { ok: true as const, data: usageSummary() };
        },
        // The hook reads the context snapshot on the same signal (#2323). It
        // is counted separately: the assertions below are about how often the
        // TRACE is re-read, and an enrichment read must not move them.
        context: async (sessionId: string) => {
          harness.contextReads.push(sessionId);
          return { ok: true as const, data: { status: 'unavailable' as const, reason: 'no_completed_request' as const } };
        },
        subscribeUsageChanges: (_sessionId: string, handler: () => void) => {
          usageChangeHandlers.add(handler);
          return () => usageChangeHandlers.delete(handler);
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
  onHookSnapshot?: (snapshot: ReturnType<typeof useSessionTrace>) => void;
}) {
  const snapshot = useSessionTrace(props.sessionId, props.active, COPY);
  props.onSnapshot?.(snapshot.trace);
  props.onHookSnapshot?.(snapshot);
  return null;
}

function tracePage(
  sessionId: string,
  runId: string,
  nextCursor: string | null,
): DesktopSessionTracePage {
  const startedAt = Number(runId.replace(/\D/g, ''));
  return {
    trace: {
      ...trace(sessionId),
      turns: [
        {
          turnId: `turn-${runId}`,
          runId,
          startedAt,
          endedAt: startedAt,
          durationMs: 0,
          steps: [],
        },
      ],
    },
    nextCursor,
  };
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

  it('refreshes Session usage only from the Usage authority signal', async () => {
    const { root } = installReactRenderer();
    const harness = installMakaBridge();
    await act(async () => {
      root.render(createElement(Probe, { sessionId: 'session-1', active: true }));
    });
    assert.equal(harness.summaryReads.length, 1);

    await act(async () => harness.emit(event('tool_result')));
    await flushRefresh();
    assert.equal(harness.reads.length, 2);
    assert.equal(harness.summaryReads.length, 1);

    await act(async () => harness.emit(event('token_usage')));
    await flushRefresh();
    assert.equal(harness.summaryReads.length, 1, 'Session events do not own Usage freshness');

    await act(async () => harness.emitUsageChange());
    await flushRefresh();
    assert.equal(harness.summaryReads.length, 2);
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

  it('rebuilds the requested page depth from the newest runs after a refresh', async () => {
    const { root } = installReactRenderer();
    const harness = installMakaBridge({
      tracePages: [
        tracePage('session-1', 'run-3', 'cursor-3'),
        tracePage('session-1', 'run-2', 'cursor-2'),
        tracePage('session-1', 'run-5', 'cursor-5'),
        tracePage('session-1', 'run-4', 'cursor-4'),
      ],
    });
    let snapshot: ReturnType<typeof useSessionTrace> | undefined;
    await act(async () => {
      root.render(
        createElement(Probe, {
          sessionId: 'session-1',
          active: true,
          onHookSnapshot: (value) => {
            snapshot = value;
          },
        }),
      );
    });

    await act(async () => snapshot?.loadEarlier());
    assert.deepEqual(
      snapshot?.trace?.turns.map((turn) => turn.runId),
      ['run-2', 'run-3'],
    );

    await act(async () => harness.emit(event('complete')));
    await flushRefresh();

    assert.deepEqual(
      snapshot?.trace?.turns.map((turn) => turn.runId),
      ['run-4', 'run-5'],
    );
    assert.deepEqual(
      harness.traceRequests.map((request) => request.cursor),
      [undefined, 'cursor-3', undefined, 'cursor-5'],
    );
  });

  it('rebuilds the loaded window when a run is inserted behind an unchanged head cursor', async () => {
    const { root } = installReactRenderer();
    const harness = installMakaBridge({
      tracePages: [
        tracePage('session-1', 'run-z', 'cursor-z'),
        tracePage('session-1', 'run-m', null),
        // The head page and its cursor are unchanged, but run-n now sorts
        // between the two pages that were already loaded.
        tracePage('session-1', 'run-z', 'cursor-z'),
        tracePage('session-1', 'run-n', 'cursor-n'),
      ],
    });
    let snapshot: ReturnType<typeof useSessionTrace> | undefined;
    await act(async () => {
      root.render(
        createElement(Probe, {
          sessionId: 'session-1',
          active: true,
          onHookSnapshot: (value) => {
            snapshot = value;
          },
        }),
      );
    });

    await act(async () => snapshot?.loadEarlier());
    assert.deepEqual(
      snapshot?.trace?.turns.map((turn) => turn.runId),
      ['run-m', 'run-z'],
    );

    await act(async () => harness.emit(event('complete')));
    await flushRefresh();

    assert.deepEqual(
      snapshot?.trace?.turns.map((turn) => turn.runId),
      ['run-n', 'run-z'],
      'an unchanged head cursor cannot justify reusing a stale older page',
    );
    assert.equal(snapshot?.nextCursor, 'cursor-n');
  });

  it('keeps the requested page depth when a head refresh supersedes load-earlier', async () => {
    const { root } = installReactRenderer();
    let resolveEarlierPage: ((result: Result<DesktopSessionTracePage>) => void) | undefined;
    const earlierPage = new Promise<Result<DesktopSessionTracePage>>((resolve) => {
      resolveEarlierPage = resolve;
    });
    let startReads = 0;
    const harness = installMakaBridge({
      trace: async (sessionId, cursor) => {
        if (cursor === undefined) {
          startReads += 1;
          if (startReads === 1) {
            return { ok: true, data: tracePage(sessionId, 'run-3', 'cursor-3') };
          }
          return { ok: true, data: tracePage(sessionId, 'run-4', 'cursor-4') };
        }
        if (cursor === 'cursor-3') return earlierPage;
        if (cursor === 'cursor-4') {
          return { ok: true, data: tracePage(sessionId, 'run-3', 'cursor-3') };
        }
        throw new Error(`unexpected cursor ${cursor}`);
      },
    });
    let snapshot: ReturnType<typeof useSessionTrace> | undefined;
    await act(async () => {
      root.render(
        createElement(Probe, {
          sessionId: 'session-1',
          active: true,
          onHookSnapshot: (value) => {
            snapshot = value;
          },
        }),
      );
    });

    await act(async () => snapshot?.loadEarlier());
    assert.equal(snapshot?.loadingEarlier, true);
    await act(async () => harness.emit(event('complete')));
    await flushRefresh();
    await act(async () => {
      resolveEarlierPage?.({ ok: true, data: tracePage('session-1', 'run-2', 'cursor-2') });
    });

    assert.deepEqual(
      snapshot?.trace?.turns.map((turn) => turn.runId),
      ['run-3', 'run-4'],
    );
    assert.equal(snapshot?.loadingEarlier, false);
    assert.deepEqual(
      harness.traceRequests.map((request) => request.cursor),
      [undefined, 'cursor-3', undefined, 'cursor-4'],
    );
  });

  it('settles loading when load-earlier supersedes an in-flight retry', async () => {
    const { root } = installReactRenderer();
    let resolveRetry: ((result: Result<DesktopSessionTracePage>) => void) | undefined;
    const retryPage = new Promise<Result<DesktopSessionTracePage>>((resolve) => {
      resolveRetry = resolve;
    });
    let headReads = 0;
    installMakaBridge({
      trace: async (sessionId, cursor) => {
        if (cursor === undefined) {
          headReads += 1;
          return headReads === 1
            ? { ok: true, data: tracePage(sessionId, 'run-3', 'cursor-3') }
            : retryPage;
        }
        if (cursor === 'cursor-3') {
          return { ok: true, data: tracePage(sessionId, 'run-2', 'cursor-2') };
        }
        throw new Error(`unexpected cursor ${cursor}`);
      },
    });
    let snapshot: ReturnType<typeof useSessionTrace> | undefined;
    await act(async () => {
      root.render(
        createElement(Probe, {
          sessionId: 'session-1',
          active: true,
          onHookSnapshot: (value) => {
            snapshot = value;
          },
        }),
      );
    });

    await act(async () => {
      snapshot?.retry();
      snapshot?.loadEarlier();
      await Promise.resolve();
    });

    assert.equal(snapshot?.loading, false);
    assert.equal(snapshot?.loadingEarlier, false);
    assert.deepEqual(
      snapshot?.trace?.turns.map((turn) => turn.runId),
      ['run-2', 'run-3'],
    );

    await act(async () => {
      resolveRetry?.({ ok: true, data: tracePage('session-1', 'run-4', 'cursor-4') });
    });
    assert.deepEqual(
      snapshot?.trace?.turns.map((turn) => turn.runId),
      ['run-2', 'run-3'],
    );
  });

  it('stops presenting an old Session summary when its refresh fails', async () => {
    const { root } = installReactRenderer();
    const harness = installMakaBridge({
      summary: async (_sessionId, readIndex) =>
        readIndex === 1
          ? { ok: true, data: usageSummary(1, 1) }
          : { ok: false, error: { code: 'FAILED', message: 'failed' } },
    });
    let snapshot: ReturnType<typeof useSessionTrace> | undefined;
    await act(async () => {
      root.render(
        createElement(Probe, {
          sessionId: 'session-1',
          active: true,
          onHookSnapshot: (value) => {
            snapshot = value;
          },
        }),
      );
    });
    assert.equal(snapshot?.summary?.totalCostUsd, 1);

    await act(async () => harness.emitUsageChange());
    await flushRefresh();

    assert.equal(snapshot?.summary, undefined);
    assert.equal(snapshot?.summaryError, true);
  });
});
