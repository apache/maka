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

// Moving a window, which was always possible and had no way to be said.
//
// A model asked to move a window reached for a title-bar drag — the only route a
// person has — which needs a coordinate, which needs the window not to be
// covered, which a window driven from the background always is. It spent 57
// calls on that in one run.
//
// `AXPosition` is settable on every window measured (17 of 17), `AXSize` on 14,
// and writing either does not bring the application forward. The capability was
// there; the vocabulary was not.
import test from 'node:test';
import assert from 'node:assert/strict';

import { computerParams } from '../computer-use-codec.js';

function parse(input: unknown) {
  return computerParams.safeParse(input);
}

test('a move names where to put the window', () => {
  const ok = parse({
    action: 'window_action',
    observation_id: 'obs_1',
    element_id: '0',
    window_action: 'move',
    position: [220, 164],
  });
  assert.equal(ok.success, true);
});

test('a move without a position is rejected rather than guessed at', () => {
  const bad = parse({
    action: 'window_action',
    observation_id: 'obs_1',
    element_id: '0',
    window_action: 'move',
  });
  assert.equal(bad.success, false);
});

test('a resize names a size, and a size is positive', () => {
  assert.equal(
    parse({
      action: 'window_action',
      observation_id: 'obs_1',
      element_id: '0',
      window_action: 'resize',
      size: [800, 600],
    }).success,
    true,
  );
  assert.equal(
    parse({
      action: 'window_action',
      observation_id: 'obs_1',
      element_id: '0',
      window_action: 'resize',
      size: [0, 600],
    }).success,
    false,
  );
  assert.equal(
    parse({
      action: 'window_action',
      observation_id: 'obs_1',
      element_id: '0',
      window_action: 'resize',
    }).success,
    false,
  );
});

test('minimise needs no geometry', () => {
  assert.equal(
    parse({
      action: 'window_action',
      observation_id: 'obs_1',
      element_id: '0',
      window_action: 'minimize',
    }).success,
    true,
  );
});

test('a negative position is accepted, because a second display is a real place', () => {
  // Measured on this machine: display 2 sits at (-193, -1080) in the space the
  // observation reports. Refusing a negative coordinate would make half the
  // desktop unaddressable, and macOS clamps what it will not honour anyway.
  const ok = parse({
    action: 'window_action',
    observation_id: 'obs_1',
    element_id: '0',
    window_action: 'move',
    position: [-193, -1049],
  });
  assert.equal(ok.success, true);
});

test('a minimise names its own cost, because it cannot be taken back', async () => {
  // Measured: the moment `minimize_window` succeeds, `list_apps` reports
  // `windowCount: 0` for that application and `observe` answers
  // `target_missing`. A minimized window is not in `CGWindowListCopyWindowInfo`
  // under `.optionOnScreenOnly`, so there is no id left for an unminimize to
  // address — and the fresh observation attached to this very result will not
  // contain the window either. A model that is not told reads that as the
  // window having been closed, or retries.
  const { buildComputerUseTools } = await import('../computer-use-tools.js');
  const observation = {
    observationId: 'backend-1',
    appId: 'com.apple.calculator',
    pid: 1,
    windowId: 2,
    elements: [{ elementId: '0', role: 'AXWindow', label: '计算器' }],
  };
  // The fixture has to lose the window, or it cannot reproduce what happens.
  // A backend that keeps answering with an observation makes this assertion
  // pass no matter what the code does.
  let gone = false;
  const [tool] = buildComputerUseTools({
    backend: {
      async preflight() {
        return { accessibility: true, screenRecording: true };
      },
      async observeApp() {
        if (gone) throw new Error('target_missing: the target window no longer exists');
        return observation as never;
      },
      async captureObservation() {
        if (gone) throw new Error('target_missing: the target window no longer exists');
        return observation as never;
      },
      async runSemantic(action: { type: string; action?: string }) {
        if (action.type === 'window_action' && action.action === 'minimize') gone = true;
        return {
          outcome: {
            ok: true as const,
            tier: 'ax' as const,
            verified: true,
            evidence: { path: 'ax_attribute', effect: 'confirmed' as const },
          },
        };
      },
      async run() {
        return { outcome: { ok: true as const, tier: 'ax' as const } };
      },
    } as never,
  });
  const context = {
    abortSignal: new AbortController().signal,
    sessionId: 'm',
    turnId: 't',
    toolCallId: 'c',
  } as never;
  const observed = (await tool!.impl(
    { action: 'observe', app: 'com.apple.calculator', include_screenshot: false },
    context,
  )) as { modelText?: string; text: string };
  const observationId = /observation_id=(\S+)/.exec(observed.modelText ?? observed.text)?.[1] ?? '';
  const minimised = (await tool!.impl(
    {
      action: 'window_action',
      observation_id: observationId,
      element_id: '0',
      window_action: 'minimize',
    },
    context,
  )) as { modelText?: string; text: string };
  assert.match(
    minimised.modelText ?? minimised.text,
    /only the person at the machine can bring it back/,
  );

  const moved = (await tool!.impl(
    {
      action: 'window_action',
      observation_id: observationId,
      element_id: '0',
      window_action: 'move',
      position: [10, 10],
    },
    context,
  )) as { modelText?: string; text: string };
  // Moving is reversible and says nothing of the sort.
  assert.doesNotMatch(moved.modelText ?? moved.text, /bring it back/);
});

test('an action outside the three is not a window action', () => {
  assert.equal(
    parse({
      action: 'window_action',
      observation_id: 'obs_1',
      element_id: '0',
      window_action: 'close',
    }).success,
    false,
  );
});
