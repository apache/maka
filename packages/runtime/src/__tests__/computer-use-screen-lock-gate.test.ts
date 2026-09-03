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

/**
 * The `screen_locked` producer.
 *
 * `screen_locked` existed as an outcome code, a session status, a block reason
 * and a `screenUnlocked` release long before anything could ever produce it, so
 * locking the machine mid-run did not stop Computer Use from driving it. These
 * tests are written against the tool surface rather than against a lock monitor:
 * a monitor that answers correctly and is never asked is exactly the defect.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildComputerUseTools,
  type CuDispatchBackend,
  type CuObservation,
} from '../computer-use-tools.js';
import type { MakaToolContext } from '../tool-runtime.js';

function ctx(sessionId = 's1'): MakaToolContext {
  return {
    sessionId,
    turnId: 't1',
    cwd: '/tmp',
    toolCallId: 'call1',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
}

function observation(): CuObservation {
  return {
    observationId: 'backend-obs-1',
    appId: 'Fixture',
    pid: 42,
    windowId: 7,
    contentFingerprint: 'ax-structure-1',
    elements: [
      {
        elementId: '5',
        role: 'AXButton',
        label: 'Continue',
        identity: { token: 'button-token', role: 'AXButton', label: 'Continue' },
      },
    ],
  } as CuObservation;
}

/** Records everything the backend was ever asked to do. */
function recordingBackend(): CuDispatchBackend & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async ensureReady() {},
    async resolveTarget() {
      return { kind: 'missing' };
    },
    async preflight() {
      calls.push('preflight');
      return { accessibility: true, screenRecording: true };
    },
    async observeApp() {
      calls.push('observeApp');
      return observation();
    },
    async run(action) {
      calls.push(`run:${action.type}`);
      return { outcome: { ok: true, tier: 'ax', verified: true } };
    },
  };
}

describe('screen-lock gate', () => {
  test('refuses every call while the machine is locked, and asks before touching the backend', async () => {
    const backend = recordingBackend();
    const [tool] = buildComputerUseTools({
      backend,
      screenLocked: () => true,
    });

    for (const action of ['observe', 'list_apps', 'screenshot'] as const) {
      const result = (await tool.impl(
        { action, ...(action === 'list_apps' ? {} : { app: 'Fixture' }) } as never,
        ctx(),
      )) as { text: string; error?: string };
      assert.match(result.text, /screen_locked/, `${action} must refuse while locked`);
      assert.equal(result.error, 'screen_locked');
    }

    // Not "the backend refused" — the backend was never reached. A guard that
    // lets the driver look at a locked machine first has already lost.
    assert.deepEqual(backend.calls, []);
  });

  test('is consulted per call, so locking mid-run stops the run', async () => {
    const backend = recordingBackend();
    let locked = false;
    const [tool] = buildComputerUseTools({
      backend,
      screenLocked: () => locked,
    });

    const observed = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx())) as {
      text: string;
    };
    assert.doesNotMatch(observed.text, /screen_locked/);
    assert.ok(backend.calls.includes('observeApp'));

    locked = true;
    const refused = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx())) as {
      text: string;
    };
    assert.match(refused.text, /screen_locked/);
  });

  test('latches the session state, so the refusal survives the machine unlocking itself', async () => {
    const backend = recordingBackend();
    let locked = true;
    const tools = buildComputerUseTools({
      backend,
      screenLocked: () => locked,
    });
    const [tool] = tools;

    await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx());
    assert.equal(tools.sessionEvents.snapshot('s1').status, 'screen_locked');

    // The lock is gone but the state is not: whatever the agent last saw is
    // from before the machine was locked, and only an explicit release moves it.
    locked = false;
    const stillRefused = (await tool.impl(
      { action: 'observe', app: 'Fixture' } as never,
      ctx(),
    )) as { text: string };
    assert.match(stillRefused.text, /screen_locked/);

    tools.sessionEvents.screenUnlocked('s1');
    assert.equal(tools.sessionEvents.snapshot('s1').status, 'reobserve_required');
    const allowed = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx())) as {
      text: string;
    };
    assert.doesNotMatch(allowed.text, /screen_locked/);
  });

  test('tells the host which session it refused, so the host can release it later', async () => {
    const backend = recordingBackend();
    const asked: string[] = [];
    const [tool] = buildComputerUseTools({
      backend,
      screenLocked: ({ sessionId }) => {
        asked.push(sessionId);
        return true;
      },
    });

    await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx('session-A'));
    // Without the session, a run whose FIRST call landed on a locked screen
    // would latch `screen_locked` while being unknown to the guard that owns
    // `screenUnlocked` — and would stay latched for the rest of its life.
    assert.deepEqual(asked, ['session-A']);
  });

  test('a refusal never reaches the overlay hook, so the probe is the only witness', async () => {
    // The desktop's screen-lock wrapper is documented as covering the refused
    // attempt too, "since onActionBegin runs before the backend sees the
    // action". It does not. `onActionBegin` has one call site, inside
    // `runWithPresentation`, and the refusal returns hundreds of lines above
    // it — so the probe callback is the only thing that sees a refused
    // session, and the wrapper's job is the other producer entirely: a
    // dispatch the probe let through that the executor then refuses.
    //
    // Pinned here rather than left to the comment, because the two are
    // indistinguishable from the desktop side: both end with the session in
    // the guard's set, and only the order says which one put it there.
    const backend = recordingBackend();
    const began: string[] = [];
    const ended: string[] = [];
    const asked: string[] = [];
    const [tool] = buildComputerUseTools({
      backend,
      overlay: {
        onActionBegin: (_action, context) => {
          began.push(context.sessionId);
        },
        onActionEnd: (_action, _result, context) => {
          ended.push(context.sessionId);
        },
      },
      screenLocked: ({ sessionId }) => {
        asked.push(sessionId);
        return true;
      },
    });

    for (const args of [
      { action: 'observe', app: 'Fixture' },
      { action: 'left_click', coordinate: [10, 10], observation_id: 'obs-1' },
      { action: 'click_element', element_id: '5', observation_id: 'obs-1' },
    ]) {
      const result = (await tool.impl(args as never, ctx('session-A'))) as { text: string };
      assert.match(result.text, /screen_locked/, `${args.action} must be refused`);
    }

    assert.deepEqual(asked, ['session-A', 'session-A', 'session-A'], 'the probe saw every call');
    assert.deepEqual(began, [], 'and the overlay hook saw none of them');
    assert.deepEqual(ended, []);
    assert.deepEqual(backend.calls, [], 'nor did the backend');
  });

  test('without a probe there is no guard, rather than a silent refusal', async () => {
    const backend = recordingBackend();
    const [tool] = buildComputerUseTools({ backend });
    const result = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx())) as {
      text: string;
    };
    assert.doesNotMatch(result.text, /screen_locked/);
  });
});
