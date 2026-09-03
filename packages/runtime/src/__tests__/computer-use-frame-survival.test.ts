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

// A refusal that never reached the window, as the model reads it.
//
// The state machine keeps the frame (see cua-frame-state.test.ts). This is the
// other half: the model has to be told, in the id space it is holding, or it
// spends the `observe` anyway out of habit.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildComputerUseTools } from '../computer-use-tools.js';
import type { CuDispatchBackend, CuObservation } from '../computer-use-types.js';

/** The backend mints its own ids, and they are not the ones the model quotes. */
const BACKEND_OBSERVATION_ID = 'snap_d5e1da7761211ddb269f238620a75416_1';

function observation(): CuObservation {
  return {
    observationId: BACKEND_OBSERVATION_ID,
    appId: 'com.apple.TextEdit',
    pid: 42,
    windowId: 7,
    elements: [
      { elementId: '0', role: 'AXWindow', label: 'note.txt' },
      { elementId: '1', role: 'AXMenuItem', label: '导出为PDF…', enabled: false },
    ],
  } as CuObservation;
}

function backend(): CuDispatchBackend {
  return {
    async ensureReady() {},
    async resolveTarget() {
      return { kind: 'missing' };
    },
    async preflight() {
      return { accessibility: true, screenRecording: true };
    },
    async observeApp() {
      return observation();
    },
    async captureObservation() {
      return observation();
    },
    async runSemantic() {
      // What maka-cu answers for a disabled element: refused, and `path: "none"`
      // is its statement that nothing was dispatched (§6.5).
      return {
        outcome: {
          ok: false as const,
          error: 'unsupported_action' as const,
          message: 'the element is disabled',
          messageIsAppTextFree: true,
          evidence: { path: 'none', effect: 'unverifiable' as const },
        },
      };
    },
    async run() {
      return { outcome: { ok: true as const, tier: 'ax' as const } };
    },
  };
}

async function turn(): Promise<{ observed: string; refused: string }> {
  const [tool] = buildComputerUseTools({ backend: backend() });
  const context = {
    abortSignal: new AbortController().signal,
    sessionId: 's',
    turnId: 't',
    toolCallId: 'c',
  } as never;
  const observed = (await tool!.impl(
    { action: 'observe', app: 'com.apple.TextEdit', include_screenshot: false },
    context,
  )) as { modelText?: string; text: string };
  const modelText = observed.modelText ?? observed.text;
  const observationId = /observation_id=(\S+)/.exec(modelText)?.[1] ?? '';
  const refused = (await tool!.impl(
    { action: 'click_element', observation_id: observationId, element_id: '1' },
    context,
  )) as { modelText?: string; text: string };
  return { observed: observationId, refused: refused.modelText ?? refused.text };
}

test('the surviving frame is named in the ids the model was given', async () => {
  const { observed, refused } = await turn();
  // The failure quoted `semanticAction.observationId` at first, which is the
  // backend's snapshot id. A model holding `0e7f922c-…` and told
  // `snap_d5e1da77…` is still current reads that as a third frame from nowhere.
  assert.match(refused, /is still current/);
  assert.ok(refused.includes(observed), `refusal names ${observed}`);
  assert.ok(
    !refused.includes(BACKEND_OBSERVATION_ID),
    'the backend id space must not leak into what the model reads',
  );
});

test('a refusal that did reach the window does not claim the frame survived', async () => {
  const dispatched = backend();
  dispatched.runSemantic = async () => ({
    outcome: {
      ok: false as const,
      error: 'target_changed' as const,
      message: 'the element no longer matches the snapshot it was bound to',
      messageIsAppTextFree: true,
      evidence: { path: 'ax_action', effect: 'unverifiable' as const },
    },
  });
  const [tool] = buildComputerUseTools({ backend: dispatched });
  const context = {
    abortSignal: new AbortController().signal,
    sessionId: 's2',
    turnId: 't',
    toolCallId: 'c',
  } as never;
  const observed = (await tool!.impl(
    { action: 'observe', app: 'com.apple.TextEdit', include_screenshot: false },
    context,
  )) as { modelText?: string; text: string };
  const observationId = /observation_id=(\S+)/.exec(observed.modelText ?? observed.text)?.[1] ?? '';
  const refused = (await tool!.impl(
    { action: 'click_element', observation_id: observationId, element_id: '1' },
    context,
  )) as { modelText?: string; text: string };
  assert.doesNotMatch(refused.modelText ?? refused.text, /is still current/);
});

test('a refusal that hands back a fresh observation does not also call the old one current', async () => {
  // The two halves fired together and said opposite things. A refusal that
  // dispatched nothing got the sentence "observation X is still current, use it
  // rather than observing again"; a refusal whose code is in
  // `REOBSERVABLE_FAILURES` got a fresh full observation, which
  // `registerObservation` makes the current frame. `target_missing` with
  // `path: "none"` is both, so the model was told to reuse a frame the same
  // reply had just superseded — and the call it was told to make came back
  // `stale_frame`, telling it to observe. Reproduced against the real tool
  // before this: two consecutive refusals with contradictory instructions and
  // no way to tell which to obey.
  //
  // The other test in this file uses `unsupported_action`, which is not in that
  // set, so it only ever exercised the half that was right.
  const missing = backend();
  missing.runSemantic = async () => ({
    outcome: {
      ok: false as const,
      error: 'target_missing' as const,
      message: 'the element is gone',
      messageIsAppTextFree: true,
      evidence: { path: 'none', effect: 'unverifiable' as const },
    },
  });
  const [tool] = buildComputerUseTools({ backend: missing });
  const context = {
    abortSignal: new AbortController().signal,
    sessionId: 's4',
    turnId: 't',
    toolCallId: 'c',
  } as never;
  const observed = (await tool.impl(
    { action: 'observe', app: 'com.apple.TextEdit', include_screenshot: false },
    context,
  )) as { modelText?: string; text: string };
  const observationId = /observation_id=(\S+)/.exec(observed.modelText ?? observed.text)?.[1] ?? '';
  const refused = (await tool.impl(
    { action: 'click_element', observation_id: observationId, element_id: '1' },
    context,
  )) as { modelText?: string; text: string };
  const text = refused.modelText ?? refused.text;

  // A fresh observation was handed back, so the frame the action quoted is not
  // the current one any more.
  assert.match(text, /Fresh observation:/);
  assert.doesNotMatch(text, /is still current/);
  // And specifically not about the id the model is holding.
  assert.ok(
    !new RegExp(`${observationId}[^\\n]*is still current`).test(text),
    'the superseded frame must not be described as current',
  );

  // The instruction the model is left with is the one the next call answers.
  const next = (await tool.impl(
    { action: 'click_element', observation_id: observationId, element_id: '0' },
    context,
  )) as { modelText?: string; text: string; error?: string };
  assert.equal(next.error, 'stale_frame');
});

test('a frame that moves during dispatch does not erase the executor s own refusal', async () => {
  // The frame bookkeeping fails after the executor has already answered: the
  // epoch moved while the dispatch was in flight, so `confirmAction` is
  // rejected. Returning only the frame's word replaced a real
  // `dispatch_refused` with `stale_frame`, and the model did the only thing
  // `stale_frame` says to do — observe, re-pick the same element, and collect
  // the identical refusal it was never shown.
  const moving = backend();
  const tools = buildComputerUseTools({ backend: moving });
  const [tool] = tools;
  moving.runSemantic = async () => {
    tools.sessionEvents.reobserveRequired('s3');
    return {
      outcome: {
        ok: false as const,
        error: 'dispatch_refused' as const,
        message: 'AXPress returned -25205',
        messageIsAppTextFree: true,
        evidence: { path: 'ax_action', effect: 'unverifiable' as const },
      },
    };
  };
  const context = {
    abortSignal: new AbortController().signal,
    sessionId: 's3',
    turnId: 't',
    toolCallId: 'c',
  } as never;
  const observed = (await tool!.impl(
    { action: 'observe', app: 'com.apple.TextEdit', include_screenshot: false },
    context,
  )) as { modelText?: string; text: string };
  const observationId = /observation_id=(\S+)/.exec(observed.modelText ?? observed.text)?.[1] ?? '';
  const refused = (await tool!.impl(
    { action: 'click_element', observation_id: observationId, element_id: '1' },
    context,
  )) as { modelText?: string; text: string; error?: string };
  const text = refused.modelText ?? refused.text;

  assert.equal(refused.error, 'dispatch_refused');
  assert.match(text, /AXPress returned -25205/);
  // And the frame fact is still said, because the retry does have to be
  // re-observed — it is added to the executor's account, not swapped for it.
  assert.match(text, /moved on/);
});
