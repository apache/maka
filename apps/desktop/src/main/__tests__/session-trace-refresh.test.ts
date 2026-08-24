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
import {
  createTraceRefreshCoalescer,
  isTraceRelevantEvent,
} from '../../renderer/session-trace-refresh.js';

function event(type: SessionEvent['type'], extra: Record<string, unknown> = {}): SessionEvent {
  return { type, id: `${type}-1`, turnId: 'turn-1', ts: 1, ...extra } as SessionEvent;
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

describe('session trace refresh policy', () => {
  it('ignores streaming deltas and reacts to ledger-changing events', () => {
    // A streaming turn emits deltas continuously. Re-projecting a whole session
    // per delta would spend the session's own latency budget watching it.
    assert.equal(isTraceRelevantEvent(event('text_delta', { messageId: 'm', text: 'a' })), false);
    assert.equal(isTraceRelevantEvent(event('thinking_delta', { messageId: 'm', text: 'a' })), false);
    assert.equal(isTraceRelevantEvent(event('tool_output_delta')), false);

    for (const type of ['tool_start', 'tool_result', 'token_usage', 'complete', 'error'] as const) {
      assert.equal(isTraceRelevantEvent(event(type)), true, `${type} changes the trace`);
    }
  });

  it('refreshes once for a burst of relevant events', () => {
    // A finishing turn emits tool_result, token_usage and complete within
    // milliseconds. Each alone justifies a re-read; three do not.
    const timer = fakeTimer();
    let refreshes = 0;
    const coalescer = createTraceRefreshCoalescer({
      refresh: () => {
        refreshes += 1;
      },
      delayMs: 400,
      schedule: timer.schedule,
      cancel: timer.cancel,
    });

    coalescer.observe(event('tool_result'));
    coalescer.observe(event('token_usage'));
    coalescer.observe(event('complete'));
    assert.equal(refreshes, 0, 'nothing reads before the burst settles');
    assert.equal(timer.scheduled, 1, 'the burst holds exactly one pending read');

    timer.fire();
    assert.equal(refreshes, 1);
  });

  it('schedules nothing for events that cannot change the trace', () => {
    const timer = fakeTimer();
    let refreshes = 0;
    const coalescer = createTraceRefreshCoalescer({
      refresh: () => {
        refreshes += 1;
      },
      delayMs: 400,
      schedule: timer.schedule,
      cancel: timer.cancel,
    });

    coalescer.observe(event('text_delta', { messageId: 'm', text: 'hello' }));
    assert.equal(timer.scheduled, 0);
    timer.fire();
    assert.equal(refreshes, 0);
  });

  it('cancel drops a scheduled read so a closed panel never fires one', () => {
    const timer = fakeTimer();
    let refreshes = 0;
    const coalescer = createTraceRefreshCoalescer({
      refresh: () => {
        refreshes += 1;
      },
      delayMs: 400,
      schedule: timer.schedule,
      cancel: timer.cancel,
    });

    coalescer.observe(event('complete'));
    coalescer.cancel();
    timer.fire();
    assert.equal(refreshes, 0, 'a hidden panel must not keep re-projecting');
  });
});
