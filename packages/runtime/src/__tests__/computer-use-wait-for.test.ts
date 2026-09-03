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

// Waiting for the thing, instead of waiting a number.
//
// The only wait there was slept for a duration the model had to guess. After an
// action that opens something — a sheet, a save panel, a progress bar — the
// right length is not knowable in advance, so the guess is either too short and
// the next observe finds nothing, or too long and every wait costs that much.
//
// Playwright's `browser_wait_for` takes `text` / `textGone` for exactly this,
// and it is the only condition a model can state: it has just read the window,
// so it knows what should appear in it. Neither Codex nor cua-driver exposes any
// wait condition at all.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildComputerUseTools } from '../computer-use-tools.js';
import type { CuDispatchBackend, CuObservation } from '../computer-use-types.js';

function observation(labels: string[]): CuObservation {
  return {
    observationId: `backend-${labels.join('-')}`,
    appId: 'com.apple.TextEdit',
    pid: 1,
    windowId: 2,
    elements: [
      { elementId: '0', role: 'AXWindow', label: 'note.txt' },
      ...labels.map((label, index) => ({
        elementId: String(index + 1),
        role: 'AXStaticText',
        label,
      })),
    ],
  } as CuObservation;
}

/** A window whose contents change after `after` observations. */
function backend(before: string[], after: string[], changeAt: number): CuDispatchBackend {
  let looks = 0;
  return {
    async ensureReady() {},
    async resolveTarget() {
      return { kind: 'missing' };
    },
    async preflight() {
      return { accessibility: true, screenRecording: true };
    },
    async observeApp() {
      looks += 1;
      return observation(looks > changeAt ? after : before);
    },
    async captureObservation() {
      return observation(before);
    },
    async run() {
      return { outcome: { ok: true as const, tier: 'ax' as const } };
    },
  };
}

async function waitFor(
  b: CuDispatchBackend,
  args: Record<string, unknown>,
  observeFirst = true,
): Promise<{ text: string; modelText?: string; error?: string }> {
  const [tool] = buildComputerUseTools({ backend: b });
  const context = {
    abortSignal: new AbortController().signal,
    sessionId: `s-${Math.random()}`,
    turnId: 't',
    toolCallId: 'c',
  } as never;
  if (observeFirst) {
    await tool!.impl(
      { action: 'observe', app: 'com.apple.TextEdit', include_screenshot: false },
      context,
    );
  }
  return (await tool!.impl({ action: 'wait', ...args }, context)) as {
    text: string;
    modelText?: string;
    error?: string;
  };
}

test('a wait for text returns as soon as it is there, not when the clock runs out', async () => {
  const result = await waitFor(backend(['Saving…'], ['Saved'], 1), {
    wait_for_text: 'Saved',
    duration: 5,
  });
  assert.doesNotMatch(result.text, /failed/);
  assert.match(result.text, /appeared after/);
  // And the observation that proved it comes back, so the model can act on the
  // thing it was waiting for without spending another call to look at it.
  assert.match(result.modelText ?? '', /AXStaticText "Saved"/);
});

test('a wait for text to go returns when it goes', async () => {
  const result = await waitFor(backend(['Loading…'], ['Done'], 1), {
    wait_for_text_gone: 'Loading',
    duration: 5,
  });
  assert.match(result.text, /gone after/);
});

test('a timeout hands back the window as it stands', async () => {
  const result = await waitFor(backend(['Saving…'], ['Saving…'], 99), {
    wait_for_text: 'Saved',
    duration: 0.6,
  });
  assert.equal(result.error, 'timeout');
  assert.match(result.text, /was still absent after/);
  // The whole question a model asks after a timeout is "what is there instead",
  // and making it spend another call on that is the round trip this removes.
  assert.match(result.modelText ?? '', /AXStaticText "Saving…"/);
  // It also says how many times it looked, which is the difference between a
  // condition that is not coming and a poll that never ran.
  assert.match(result.text, /looks/);
});

test('a wait with no observation behind it says so instead of guessing a window', async () => {
  const result = await waitFor(backend(['x'], ['y'], 0), { wait_for_text: 'y' }, false);
  assert.match(result.text, /no_active_frame/);
  assert.match(result.text, /Observe first/);
});

test('text that is already there returns at once, which is what "wait until" means', async () => {
  // Measured on a real machine: `wait_for_text: "8"` against Calculator came
  // back in 0.1s, because a button is named `8`. That is the condition being
  // satisfied, not a bug — but a model that expected to wait reads an instant
  // return as a broken tool, so the parameter description says to name
  // something not on screen yet.
  const result = await waitFor(backend(['Saved'], ['Saved'], 99), {
    wait_for_text: 'Saved',
    duration: 5,
  });
  assert.doesNotMatch(result.text, /failed/);
  assert.match(result.text, /appeared after 0\.[01]s/);
});

test('a plain duration wait is untouched', async () => {
  // The old behaviour is still the answer when there is nothing to wait for.
  const result = await waitFor(backend(['x'], ['x'], 99), { duration: 0.05 });
  assert.doesNotMatch(result.text, /failed/);
  assert.doesNotMatch(result.text, /appeared|gone after/);
});
