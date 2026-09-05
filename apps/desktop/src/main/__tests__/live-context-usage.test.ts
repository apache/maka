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
import type { SessionEvent } from '@maka/core/events';
import type { ContextDiagnosticsResult } from '@maka/runtime-host/protocol';
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
    assert.deepEqual(seen, [{ usageTokens: 79_436, contextWindow: 128_000 }]);
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
    assert.deepEqual(seen, [{ usageTokens: 60_000, contextWindow: 128_000 }]);
    tracker.dispose();
  });

  it('keeps the last value when a read fails', async () => {
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
    tracker.observe(event('tool_result'));
    timer.fire();
    query.pending[1]!.reject(new Error('host not ready'));
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(seen, [{ usageTokens: 79_436, contextWindow: 128_000 }]);
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
    assert.deepEqual(seen, [undefined]);
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
    assert.deepEqual(seen, [{ usageTokens: 5_000, contextWindow: 128_000 }]);
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
      { usageTokens: 79_436, contextWindow: 128_000 },
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
    assert.deepEqual(seen, []);
  });
});
