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
import { describe, it } from 'node:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { SessionEvent } from '@maka/core/events';
import type { ContextDiagnosticsResult } from '@maka/runtime-host/protocol';
import type { SessionInspectorService } from '../../renderer/application/contracts/session-inspector/service.js';
import { useLiveContextUsageState } from '../../renderer/application/contracts/session-inspector/use-live-context-usage.js';
import {
  createLiveContextUsageTracker,
  liveContextUsageFromDiagnostics,
} from '../../renderer/features/workbar/testing.js';

const ROUTE = { model: 'deepseek-v4-flash', providerType: 'deepseek' } as const;

function available(overrides: Record<string, unknown> = {}): ContextDiagnosticsResult {
  return {
    status: 'available',
    providerId: 'deepseek',
    modelId: 'deepseek-v4-flash',
    completedAt: 1,
    inputTokens: 79_436,
    contextWindow: 128_000,
    ...overrides,
  } as ContextDiagnosticsResult;
}

function event(type: SessionEvent['type']): SessionEvent {
  return { type, id: `${type}-1`, turnId: 'turn-1', ts: 1 } as SessionEvent;
}

/** A controllable stand-in for `setTimeout`, so the policy is testable. */
function fakeTimer() {
  const pending = new Map<number, () => void>();
  let nextHandle = 1;
  return {
    schedule: (callback: () => void) => {
      const handle = nextHandle++;
      pending.set(handle, callback);
      return handle;
    },
    cancel: (handle: unknown) => {
      pending.delete(handle as number);
    },
    fire: () => {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
    },
    get scheduled() {
      return pending.size;
    },
  };
}

/** A manually resolved query, so tests control exactly when each read lands. */
function scriptedQuery() {
  const pending: { sessionId: string; resolve: (value: ContextDiagnosticsResult) => void; reject: (error: unknown) => void }[] = [];
  return {
    query: (sessionId: string) =>
      new Promise<ContextDiagnosticsResult>((resolve, reject) => {
        pending.push({ sessionId, resolve, reject });
      }),
    pending,
  };
}

describe('liveContextUsageFromDiagnostics', () => {
  it('maps a matching snapshot onto the gauge, window included', () => {
    assert.deepEqual(liveContextUsageFromDiagnostics(available(), ROUTE), {
      usageTokens: 79_436,
      contextWindow: 128_000,
    });
  });

  it('refuses a snapshot from another model or provider', () => {
    // A token count is one model's number in one tokenizer: model A's tokens
    // against model B's window is a precise-looking lie.
    assert.equal(liveContextUsageFromDiagnostics(available({ modelId: 'other' }), ROUTE), undefined);
    assert.equal(liveContextUsageFromDiagnostics(available({ providerId: 'openai' }), ROUTE), undefined);
  });

  it('refuses when the composer has no settled route', () => {
    assert.equal(liveContextUsageFromDiagnostics(available(), { providerType: 'deepseek' }), undefined);
    assert.equal(liveContextUsageFromDiagnostics(available(), { model: 'deepseek-v4-flash' }), undefined);
  });

  it('refuses unavailable or unmetered snapshots', () => {
    assert.equal(
      liveContextUsageFromDiagnostics({ status: 'unavailable', reason: 'no_completed_request' }, ROUTE),
      undefined,
    );
    assert.equal(liveContextUsageFromDiagnostics(available({ inputTokens: undefined }), ROUTE), undefined);
    assert.equal(liveContextUsageFromDiagnostics(available({ inputTokens: 0 }), ROUTE), undefined);
    assert.equal(liveContextUsageFromDiagnostics(undefined, ROUTE), undefined);
  });

  it('stands alone without a window', () => {
    assert.deepEqual(
      liveContextUsageFromDiagnostics(available({ contextWindow: undefined }), ROUTE),
      { usageTokens: 79_436 },
    );
  });
});

describe('createLiveContextUsageTracker', () => {
  it('reads immediately when aimed at a session', async () => {
    const timer = fakeTimer();
    const query = scriptedQuery();
    const seen: unknown[] = [];
    const tracker = createLiveContextUsageTracker({
      query: query.query,
      delayMs: 400,
      schedule: timer.schedule,
      cancel: timer.cancel,
      onChange: (usage) => seen.push(usage),
    });
    tracker.setTarget({ sessionId: 's1', route: ROUTE });
    assert.equal(query.pending.length, 1);
    query.pending[0]!.resolve(available());
    await Promise.resolve();
    // The leading `undefined` is the aim itself: whatever stood on screen
    // before cannot answer for this target, so it clears before the read.
    assert.deepEqual(seen, [undefined, { usageTokens: 79_436, contextWindow: 128_000 }]);
    tracker.dispose();
  });

  it('reports nothing when there is no target', () => {
    const timer = fakeTimer();
    const query = scriptedQuery();
    const seen: unknown[] = [];
    const tracker = createLiveContextUsageTracker({
      query: query.query,
      delayMs: 400,
      schedule: timer.schedule,
      cancel: timer.cancel,
      onChange: (usage) => seen.push(usage),
    });
    tracker.setTarget(undefined);
    assert.equal(query.pending.length, 0);
    assert.deepEqual(seen, [undefined]);
    tracker.dispose();
  });

  it('re-reads on ledger-changing events after the debounce, coalescing bursts', async () => {
    const timer = fakeTimer();
    const query = scriptedQuery();
    const seen: unknown[] = [];
    const tracker = createLiveContextUsageTracker({
      query: query.query,
      delayMs: 400,
      schedule: timer.schedule,
      cancel: timer.cancel,
      onChange: (usage) => seen.push(usage),
    });
    tracker.setTarget({ sessionId: 's1', route: ROUTE });
    query.pending[0]!.resolve(available({ inputTokens: 40_000 }));
    await Promise.resolve();

    // A step settling emits a burst; the last event's state is the one worth
    // reading, so the burst must collapse into one re-read, and only after
    // the debounce.
    tracker.observe(event('tool_start'));
    tracker.observe(event('tool_result'));
    tracker.observe(event('text_delta'));
    assert.equal(timer.scheduled, 1);
    assert.equal(query.pending.length, 1);
    timer.fire();
    assert.equal(query.pending.length, 2);
    query.pending[1]!.resolve(available({ inputTokens: 52_000 }));
    await Promise.resolve();
    assert.deepEqual(seen, [
      undefined,
      { usageTokens: 40_000, contextWindow: 128_000 },
      { usageTokens: 52_000, contextWindow: 128_000 },
    ]);
    tracker.dispose();
  });

  it('ignores streaming deltas', () => {
    const timer = fakeTimer();
    const query = scriptedQuery();
    const tracker = createLiveContextUsageTracker({
      query: query.query,
      delayMs: 400,
      schedule: timer.schedule,
      cancel: timer.cancel,
      onChange: () => undefined,
    });
    tracker.setTarget({ sessionId: 's1', route: ROUTE });
    tracker.observe(event('text_delta'));
    tracker.observe(event('tool_output_delta'));
    assert.equal(timer.scheduled, 0);
    assert.equal(query.pending.length, 1);
    tracker.dispose();
  });

  it('discards a read that answers an older question', async () => {
    const timer = fakeTimer();
    const query = scriptedQuery();
    const seen: unknown[] = [];
    const tracker = createLiveContextUsageTracker({
      query: query.query,
      delayMs: 400,
      schedule: timer.schedule,
      cancel: timer.cancel,
      onChange: (usage) => seen.push(usage),
    });
    tracker.setTarget({ sessionId: 's1', route: ROUTE });
    tracker.observe(event('token_usage'));
    timer.fire();
    assert.equal(query.pending.length, 2);
    // The newer read lands first; the older one must not overwrite it when it
    // resolves late.
    query.pending[1]!.resolve(available({ inputTokens: 60_000 }));
    await Promise.resolve();
    query.pending[0]!.resolve(available({ inputTokens: 10_000 }));
    await Promise.resolve();
    assert.deepEqual(seen, [undefined, { usageTokens: 60_000, contextWindow: 128_000 }]);
    tracker.dispose();
  });

  it('keeps the last value when a read fails', async () => {
    const timer = fakeTimer();
    const query = scriptedQuery();
    const seen: unknown[] = [];
    let failures = 0;
    const tracker = createLiveContextUsageTracker({
      query: query.query,
      delayMs: 400,
      schedule: timer.schedule,
      cancel: timer.cancel,
      onChange: (usage) => seen.push(usage),
      onReadFailure: () => { failures += 1; },
    });
    tracker.setTarget({ sessionId: 's1', route: ROUTE });
    query.pending[0]!.resolve(available());
    await Promise.resolve();
    tracker.observe(event('tool_result'));
    timer.fire();
    query.pending[1]!.reject(new Error('host not ready'));
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(seen, [undefined, { usageTokens: 79_436, contextWindow: 128_000 }]);
    assert.equal(failures, 1);
    tracker.dispose();
  });

  it('clears the previous target’s reading before the first read on a new one', async () => {
    const timer = fakeTimer();
    const query = scriptedQuery();
    const seen: unknown[] = [];
    const tracker = createLiveContextUsageTracker({
      query: query.query,
      delayMs: 400,
      schedule: timer.schedule,
      cancel: timer.cancel,
      onChange: (usage) => seen.push(usage),
    });
    tracker.setTarget({ sessionId: 's1', route: ROUTE });
    query.pending[0]!.resolve(available());
    await Promise.resolve();

    // Switching sessions makes the standing number unanswerable: it must
    // leave the screen BEFORE the new target's first read lands…
    tracker.setTarget({ sessionId: 's2', route: ROUTE });
    assert.deepEqual(seen, [undefined, { usageTokens: 79_436, contextWindow: 128_000 }, undefined]);

    // …and a rejected first read on the new target keeps it cleared, rather
    // than pinning the previous session's number in place indefinitely.
    query.pending[1]!.reject(new Error('host not ready'));
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(seen, [undefined, { usageTokens: 79_436, contextWindow: 128_000 }, undefined]);
    tracker.dispose();
  });

  it('keeps the standing value when re-aimed at the same target', async () => {
    const timer = fakeTimer();
    const query = scriptedQuery();
    const seen: unknown[] = [];
    const tracker = createLiveContextUsageTracker({
      query: query.query,
      delayMs: 400,
      schedule: timer.schedule,
      cancel: timer.cancel,
      onChange: (usage) => seen.push(usage),
    });
    tracker.setTarget({ sessionId: 's1', route: ROUTE });
    query.pending[0]!.resolve(available());
    await Promise.resolve();

    // An identical re-aim is not a target change: the value still answers the
    // question, so clearing it would only flicker. The re-read happens, and a
    // failure keeps the value standing as always.
    tracker.setTarget({ sessionId: 's1', route: { ...ROUTE } });
    assert.equal(query.pending.length, 2);
    query.pending[1]!.reject(new Error('host not ready'));
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(seen, [undefined, { usageTokens: 79_436, contextWindow: 128_000 }]);
    tracker.dispose();
  });

  it('clears immediately and drops in-flight reads when the target goes away', async () => {
    const timer = fakeTimer();
    const query = scriptedQuery();
    const seen: unknown[] = [];
    const tracker = createLiveContextUsageTracker({
      query: query.query,
      delayMs: 400,
      schedule: timer.schedule,
      cancel: timer.cancel,
      onChange: (usage) => seen.push(usage),
    });
    tracker.setTarget({ sessionId: 's1', route: ROUTE });
    tracker.setTarget(undefined);
    assert.equal(timer.scheduled, 0);
    query.pending[0]!.resolve(available());
    await Promise.resolve();
    // Once for aiming, once for the target going away.
    assert.deepEqual(seen, [undefined, undefined]);
    tracker.dispose();
  });

  it('drops a read in flight for a session the user has left', async () => {
    const timer = fakeTimer();
    const query = scriptedQuery();
    const seen: unknown[] = [];
    const tracker = createLiveContextUsageTracker({
      query: query.query,
      delayMs: 400,
      schedule: timer.schedule,
      cancel: timer.cancel,
      onChange: (usage) => seen.push(usage),
    });
    tracker.setTarget({ sessionId: 's1', route: ROUTE });
    tracker.setTarget({ sessionId: 's2', route: ROUTE });
    assert.equal(query.pending.length, 2);
    query.pending[1]!.resolve(available({ inputTokens: 5_000 }));
    await Promise.resolve();
    query.pending[0]!.resolve(available({ inputTokens: 99_000 }));
    await Promise.resolve();
    // Aiming, then leaving s1 clears its (never-landed) reading, then s2's
    // lands; the stale s1 read resolving late must not overwrite it.
    assert.deepEqual(seen, [undefined, undefined, { usageTokens: 5_000, contextWindow: 128_000 }]);
    tracker.dispose();
  });

  it('re-evaluates the same session when the route changes', async () => {
    const timer = fakeTimer();
    const query = scriptedQuery();
    const seen: unknown[] = [];
    const tracker = createLiveContextUsageTracker({
      query: query.query,
      delayMs: 400,
      schedule: timer.schedule,
      cancel: timer.cancel,
      onChange: (usage) => seen.push(usage),
    });
    tracker.setTarget({ sessionId: 's1', route: ROUTE });
    query.pending[0]!.resolve(available());
    await Promise.resolve();
    // The user switched models: the snapshot still names the old route, so
    // the gauge must fall back rather than wear another model's number.
    tracker.setTarget({ sessionId: 's1', route: { model: 'qwen3', providerType: 'alibaba' } });
    assert.equal(query.pending.length, 2);
    query.pending[1]!.resolve(available());
    await Promise.resolve();
    assert.deepEqual(seen, [
      undefined,
      { usageTokens: 79_436, contextWindow: 128_000 },
      undefined,
      undefined,
    ]);
    tracker.dispose();
  });

  it('cancels a scheduled refresh and drops in-flight reads on dispose', async () => {
    const timer = fakeTimer();
    const query = scriptedQuery();
    const seen: unknown[] = [];
    const tracker = createLiveContextUsageTracker({
      query: query.query,
      delayMs: 400,
      schedule: timer.schedule,
      cancel: timer.cancel,
      onChange: (usage) => seen.push(usage),
    });
    tracker.setTarget({ sessionId: 's1', route: ROUTE });
    tracker.observe(event('tool_result'));
    tracker.dispose();
    assert.equal(timer.scheduled, 0);
    query.pending[0]!.resolve(available());
    await Promise.resolve();
    // Only the aiming clear lands; the disposed tracker's read is dropped.
    assert.deepEqual(seen, [undefined]);
  });
});

it('reports pending rather than another target usage during a session switch', async () => {
  const original = {
    document: globalThis.document,
    window: globalThis.window,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }).IS_REACT_ACT_ENVIRONMENT,
  };
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, {
    document,
    window,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  type ContextResult = Awaited<ReturnType<SessionInspectorService['context']>>;
  const pending: Array<{ sessionId: string; resolve: (value: ContextResult) => void }> = [];
  const inspector: SessionInspectorService = {
    trace: async () => { throw new Error('not used'); },
    summary: async () => { throw new Error('not used'); },
    context: (sessionId: string) =>
      new Promise<ContextResult>((resolve) => pending.push({ sessionId, resolve })),
    subscribeSessionEvents: () => () => undefined,
    subscribeUsageChanges: () => () => undefined,
  };
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  let renders: Array<{
    sessionId: string;
    status: 'pending' | 'available' | 'unavailable';
    usageTokens: number | undefined;
  }> = [];
  function Probe(props: { sessionId: string }): ReactElement {
    const usage = useLiveContextUsageState({
      inspector,
      sessionId: props.sessionId,
      model: ROUTE.model,
      providerType: ROUTE.providerType,
    });
    renders.push({
      sessionId: props.sessionId,
      status: usage.status,
      usageTokens: usage.status === 'available' ? usage.usage.usageTokens : undefined,
    });
    return createElement('span');
  }

  try {
    await act(() => root.render(createElement(Probe, { sessionId: 's1' })));
    await act(async () => {
      pending[0]?.resolve({ ok: true, data: available({ inputTokens: 1_000 }) });
      await Promise.resolve();
    });
    assert.equal(renders.at(-1)?.usageTokens, 1_000);

    renders = [];
    await act(() => root.render(createElement(Probe, { sessionId: 's2' })));
    assert.ok(renders.length > 0);
    assert.equal(renders.at(-1)?.status, 'pending');
    assert.equal(
      renders.some((render) => render.usageTokens === 1_000),
      false,
      'the old session usage must not appear in any render for the new target',
    );
    await act(async () => {
      pending[1]?.resolve({
        ok: true,
        data: { status: 'unavailable', reason: 'no_completed_request' },
      });
      await Promise.resolve();
    });
    assert.equal(renders.at(-1)?.status, 'unavailable');
  } finally {
    await act(() => root.unmount());
    Object.assign(globalThis, original);
  }
});
