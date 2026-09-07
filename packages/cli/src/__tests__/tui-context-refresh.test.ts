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

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { deferred } from '@maka/core/test-only/async-primitives';
import type { SessionEvent } from '@maka/core/events';
import {
  CTX_REFRESH_DEBOUNCE_MS,
  createCtxRefresher,
  isCtxRefreshRelevantEvent,
  scheduleCtxRefreshTimeout,
} from '../tui-context-refresh.js';

function toolStartEvent(): SessionEvent {
  return {
    type: 'tool_start',
    id: 'event-tool-start',
    turnId: 'turn-1',
    ts: 1,
    toolUseId: 'tool-1',
    toolName: 'Bash',
    args: { command: 'npm test' },
  };
}

function textDeltaEvent(): SessionEvent {
  return {
    type: 'text_delta',
    id: 'event-text',
    turnId: 'turn-1',
    ts: 1,
    messageId: 'message-1',
    text: 'hello',
  };
}

interface ScheduledRun {
  callback: () => void;
  delayMs: number;
}

function createFakeScheduler() {
  let pending: ScheduledRun | undefined;
  const schedule = (callback: () => void, delayMs: number) => {
    pending = { callback, delayMs };
    return () => {
      if (pending?.callback === callback) pending = undefined;
    };
  };
  return {
    schedule,
    hasPending: () => pending !== undefined,
    pendingDelayMs: () => pending?.delayMs,
    flush: () => {
      const run = pending;
      pending = undefined;
      run?.callback();
    },
  };
}

describe('isCtxRefreshRelevantEvent', () => {
  test('matches the desktop inspector trace-relevant set', () => {
    for (const type of [
      'tool_start',
      'tool_result',
      'token_usage',
      'provider_retry',
      'error',
      'complete',
      'abort',
    ]) {
      assert.equal(isCtxRefreshRelevantEvent({ type } as SessionEvent), true, type);
    }
  });

  test('streaming deltas never schedule a query', () => {
    for (const type of ['text_delta', 'thinking_delta', 'tool_output', 'queue_update']) {
      assert.equal(isCtxRefreshRelevantEvent({ type } as SessionEvent), false, type);
    }
  });
});

describe('createCtxRefresher', () => {
  test('a relevant event runs one query after the debounce delay', async () => {
    const scheduler = createFakeScheduler();
    const queryCalls: number[] = [];
    const applied: string[] = [];
    const refresher = createCtxRefresher({
      query: () => {
        queryCalls.push(1);
        return Promise.resolve('snapshot');
      },
      apply: (result) => applied.push(result),
      delayMs: CTX_REFRESH_DEBOUNCE_MS,
      schedule: scheduler.schedule,
    });

    refresher.observe(toolStartEvent());
    assert.equal(scheduler.pendingDelayMs(), CTX_REFRESH_DEBOUNCE_MS);
    assert.equal(queryCalls.length, 0);

    scheduler.flush();
    await Promise.resolve();
    assert.deepEqual(queryCalls, [1]);
    assert.deepEqual(applied, ['snapshot']);
  });

  test('a burst of events coalesces into one query, at the last event', async () => {
    const scheduler = createFakeScheduler();
    let queries = 0;
    const refresher = createCtxRefresher({
      query: () => {
        queries += 1;
        return Promise.resolve('snapshot');
      },
      apply: () => {},
      delayMs: 400,
      schedule: scheduler.schedule,
    });

    refresher.observe(toolStartEvent());
    refresher.observe(toolStartEvent());
    refresher.observe(toolStartEvent());
    assert.equal(scheduler.hasPending(), true);

    scheduler.flush();
    await Promise.resolve();
    assert.equal(queries, 1);
  });

  test('only the latest issued query may apply', async () => {
    const scheduler = createFakeScheduler();
    const queries: Array<ReturnType<typeof deferred<string>>> = [];
    const applied: string[] = [];
    const refresher = createCtxRefresher({
      query: () => {
        const query = deferred<string>();
        queries.push(query);
        return query.promise;
      },
      apply: (result) => applied.push(result),
      delayMs: 400,
      schedule: scheduler.schedule,
    });

    refresher.observe(toolStartEvent());
    scheduler.flush();
    refresher.observe(toolStartEvent());
    scheduler.flush();
    assert.equal(queries.length, 2);

    // The newer answer lands first; the older read then resolves late and
    // must not overwrite it with its staler snapshot.
    queries[1]!.resolve('newer');
    await Promise.resolve();
    assert.deepEqual(applied, ['newer']);
    queries[0]!.resolve('older');
    await Promise.resolve();
    assert.deepEqual(applied, ['newer']);
  });

  test('a failed query leaves the last value standing and later events still refresh', async () => {
    const scheduler = createFakeScheduler();
    const queries: Array<ReturnType<typeof deferred<string>>> = [];
    const applied: string[] = [];
    const refresher = createCtxRefresher({
      query: () => {
        const query = deferred<string>();
        queries.push(query);
        return query.promise;
      },
      apply: (result) => applied.push(result),
      delayMs: 400,
      schedule: scheduler.schedule,
    });

    refresher.observe(toolStartEvent());
    scheduler.flush();
    queries[0]!.reject(new Error('host not ready'));
    // The rejection is consumed, not raised.
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(applied, []);

    refresher.observe(toolStartEvent());
    scheduler.flush();
    queries[1]!.resolve('recovered');
    await Promise.resolve();
    assert.deepEqual(applied, ['recovered']);
  });

  test('cancel drops a scheduled query and retires an in-flight one', async () => {
    const scheduler = createFakeScheduler();
    const inFlight = deferred<string>();
    const applied: string[] = [];
    const refresher = createCtxRefresher({
      query: () => inFlight.promise,
      apply: (result) => applied.push(result),
      delayMs: 400,
      schedule: scheduler.schedule,
    });

    // Scheduled but not yet run: cancel prevents the query entirely.
    refresher.observe(toolStartEvent());
    refresher.cancel();
    assert.equal(scheduler.hasPending(), false);

    // In-flight: a resolution after cancel belongs to a retired read.
    refresher.observe(toolStartEvent());
    scheduler.flush();
    refresher.cancel();
    inFlight.resolve('stale');
    await Promise.resolve();
    assert.deepEqual(applied, []);
  });

  test('irrelevant events never schedule a query', () => {
    const scheduler = createFakeScheduler();
    const refresher = createCtxRefresher({
      query: () => Promise.resolve('snapshot'),
      apply: () => {},
      delayMs: 400,
      schedule: scheduler.schedule,
    });

    refresher.observe(textDeltaEvent());
    assert.equal(scheduler.hasPending(), false);
  });

  test('the default timeout scheduler fires and cancels for real', async () => {
    const fired = deferred<void>();
    const cancel = scheduleCtxRefreshTimeout(() => fired.resolve(), 0);
    cancel();
    // A cancelled zero-delay timer must not fire on the next tick.
    await new Promise((resolve) => setTimeout(resolve, 5));
    let firedFlag = false;
    void fired.promise.then(() => {
      firedFlag = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(firedFlag, false);

    const fired2 = deferred<void>();
    scheduleCtxRefreshTimeout(() => fired2.resolve(), 0);
    await fired2.promise;
  });
});
