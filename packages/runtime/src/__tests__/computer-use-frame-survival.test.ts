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
