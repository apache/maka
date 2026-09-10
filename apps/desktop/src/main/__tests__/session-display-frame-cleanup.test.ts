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
import { it, type TestContext } from 'node:test';
import { armLiveTurn, type LiveTurnProjection } from '@maka/ui';
import {
  createAppShellSessionDisplayBatch,
  createAppShellSessionEventHandlers,
} from '../../renderer/app-shell-session-events.js';

function installBrowserScheduler(t: TestContext) {
  let nextId = 1;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  const globals = {
    requestAnimationFrame: (callback: () => void) => {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
    window: {
      setTimeout: (callback: () => void, delay: number) => {
        assert.equal(delay, 100);
        const id = nextId++;
        timers.set(id, callback);
        return id;
      },
      clearTimeout: (id: number) => { timers.delete(id); },
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  function fire(callbacks: Map<number, () => void>): void {
    const next = callbacks.entries().next().value;
    assert.ok(next, 'expected a scheduled callback');
    callbacks.delete(next[0]);
    next[1]();
  }
  return { frames, timers, fire };
}

function createStreamingSession() {
  const liveTurnBySessionRef = {
    current: { 'session-1': armLiveTurn('turn-1') } as Record<string, LiveTurnProjection>,
  };
  const displayBatch = createAppShellSessionDisplayBatch();
  let publications = 0;
  const options: Parameters<typeof createAppShellSessionEventHandlers>[0] = {
    uiLocale: 'zh-CN',
    activeIdRef: { current: 'session-1' },
    liveTurnBySessionRef,
    displayBatch,
    refreshMessages: async () => true,
    refreshSessions: async () => [],
    setLiveTurnBySession: (updater) => {
      publications += 1;
      liveTurnBySessionRef.current = updater(liveTurnBySessionRef.current);
    },
    setInteractionBySession: () => {},
    showModelSetupToast: () => {},
    toastApi: { error: () => {} },
  };
  return {
    displayBatch,
    publications: () => publications,
    text: () => liveTurnBySessionRef.current['session-1']?.steps[0]?.text?.text,
    send: (index: number) => {
      // The shell recreates handlers on render while sharing its display batch.
      createAppShellSessionEventHandlers(options).handleEvent('session-1', {
        type: 'text_delta', id: `event-${index}`, turnId: 'turn-1',
        messageId: 'assistant-1', ts: index, text: 'x',
      });
    },
  };
}

it('releases suspended animation frames after each timeout display flush', (t) => {
  const scheduler = installBrowserScheduler(t);
  const session = createStreamingSession();
  for (let index = 0; index < 150; index += 1) {
    session.send(index);
    assert.equal(scheduler.timers.size, 1);
    assert.equal(session.displayBatch.framePending, true);
    // A hidden renderer can keep receiving events and timeouts without painting.
    scheduler.fire(scheduler.timers);
    assert.equal(session.publications(), index + 1);
    assert.equal(session.displayBatch.framePending, false);
    assert.equal(session.displayBatch.pendingEvents.size, 0);
  }
  assert.equal(session.text(), 'x'.repeat(150));
  assert.equal(scheduler.frames.size, 0, 'completed batches must not retain suspended rAF callbacks');
  assert.equal(scheduler.timers.size, 0);
});

for (const winner of ['frames', 'timers'] as const) {
  it(`cancels the losing callback when ${winner} win without flushing the next batch`, (t) => {
    const scheduler = installBrowserScheduler(t);
    const session = createStreamingSession();
    const loser = winner === 'frames' ? 'timers' : 'frames';
    session.send(0);
    const staleCallback = scheduler[loser].values().next().value;
    assert.ok(staleCallback);
    scheduler.fire(scheduler[winner]);
    assert.equal(session.publications(), 1);
    assert.equal(scheduler[loser].size, 0);

    session.send(1);
    // Even a callback already dispatched before cancellation stays harmless.
    staleCallback();
    assert.equal(session.publications(), 1);
    assert.equal(session.displayBatch.framePending, true);
    assert.equal(scheduler.frames.size, 1);
    assert.equal(scheduler.timers.size, 1);
    scheduler.fire(scheduler[winner]);
    assert.equal(session.publications(), 2);
    assert.equal(session.text(), 'xx');
    assert.equal(scheduler.frames.size, 0);
    assert.equal(scheduler.timers.size, 0);
  });
}
