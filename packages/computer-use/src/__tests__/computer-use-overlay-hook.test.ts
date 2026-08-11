import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CuAction } from '@maka/core/computer-use';
import { buildComputerUseTools } from '@maka/runtime/computer-use-tools';
import { parseObservationText } from '@maka/runtime/test-only/observation-text-reader';
import { createComputerUseOverlayHook } from '../computer-use-overlay-hook.js';

function fakeController() {
  const moves: unknown[] = [];
  const completions: unknown[] = [];
  const cancellations: unknown[] = [];
  const ensured: string[] = [];
  return {
    controller: {
      ensure: (sessionId: string) => {
        ensured.push(sessionId);
      },
      move: (input: unknown) => {
        moves.push(input);
      },
      complete: (input: unknown) => {
        completions.push(input);
      },
      cancel: (input: unknown) => {
        cancellations.push(input);
      },
    },
    moves,
    completions,
    cancellations,
    ensured,
  };
}

test('presentation starts from the Runtime-bound screen point', () => {
  const { controller, moves } = fakeController();
  const hook = createComputerUseOverlayHook(controller as never);
  hook.onActionBegin(
    { type: 'left_click', coordinate: { x: 400, y: 300 } },
    {
      sessionId: 's1',
      toolCallId: 'a1',
      presentationScreenPoint: { x: 201, y: 151 },
    },
  );
  assert.deepEqual(moves, [
    {
      actionId: 'a1',
      sessionId: 's1',
      screenX: 201,
      screenY: 151,
      kind: 'click',
      instant: true,
      keepElevated: true,
    },
  ]);
});

test('a window to order against replaces the level as what keeps the cursor visible', () => {
  // Elevation was the only tool available while ordering relative to a foreign
  // window looked impossible. It is not: with a target id the cursor sits
  // directly above that window, and staying elevated on top of that would put
  // it back over the user's own windows — the thing being fixed.
  const { controller, moves } = fakeController();
  const hook = createComputerUseOverlayHook(controller as never);
  hook.onActionBegin(
    { type: 'left_click', coordinate: { x: 400, y: 300 } },
    {
      sessionId: 's1',
      toolCallId: 'a1',
      presentationScreenPoint: { x: 201, y: 151 },
      targetWindowId: 4321,
    },
  );
  assert.equal((moves[0] as { keepElevated: boolean }).keepElevated, false);
  assert.equal((moves[0] as { targetWindowId?: number }).targetWindowId, 4321);
});

test('with no window to order against the cursor stays elevated', () => {
  // There is nothing to sink to, and an unseen cursor is the worse failure.
  const { controller, moves } = fakeController();
  const hook = createComputerUseOverlayHook(controller as never);
  hook.onActionBegin(
    { type: 'left_click', coordinate: { x: 400, y: 300 } },
    {
      sessionId: 's1',
      toolCallId: 'a1',
      presentationScreenPoint: { x: 201, y: 151 },
    },
  );
  assert.equal((moves[0] as { keepElevated: boolean }).keepElevated, true);
  assert.equal((moves[0] as { targetWindowId?: number }).targetWindowId, undefined);
});

test('the landing carries the window the cursor has to come back down to', () => {
  // `complete` raises the cursor for the trip to the executor's coordinate, so
  // it is the last thing that can tell the sink which window to sink onto. An
  // action whose begin never ran reaches `complete` with the only window id it
  // ever carried, and dropping it left the sink ordering against the previous
  // action's window.
  const { controller, completions } = fakeController();
  const hook = createComputerUseOverlayHook(controller as never);
  hook.onActionEnd?.(
    { type: 'left_click', coordinate: { x: 400, y: 300 } },
    { outcome: { ok: true, tier: 'semantic-background', verified: true } },
    {
      sessionId: 's1',
      toolCallId: 'a1',
      presentationScreenPoint: { x: 201, y: 151 },
      targetWindowId: 20,
    },
  );
  assert.equal((completions[0] as { targetWindowId?: number }).targetWindowId, 20);
});

test('the executor-resolved point wins when there is one', () => {
  const { controller, completions } = fakeController();
  const hook = createComputerUseOverlayHook(controller as never);
  hook.onActionEnd?.(
    { type: 'left_click', coordinate: { x: 400, y: 300 } },
    {
      outcome: { ok: true, tier: 'semantic-background', verified: true },
      resolvedScreenPoint: { x: 202, y: 152 },
    },
    { sessionId: 's1', toolCallId: 'a1' },
  );
  assert.deepEqual(completions, [
    {
      actionId: 'a1',
      sessionId: 's1',
      screenX: 202,
      screenY: 152,
      kind: 'click',
      pulse: true,
    },
  ]);
});

test('a successful action with no point anywhere still cancels', () => {
  const { controller, completions, cancellations } = fakeController();
  const hook = createComputerUseOverlayHook(controller as never);
  hook.onActionEnd?.(
    { type: 'left_click', coordinate: { x: 400, y: 300 } },
    { outcome: { ok: true, tier: 'ax', verified: false } },
    { sessionId: 's1', toolCallId: 'a1' },
  );
  assert.deepEqual(completions, []);
  assert.deepEqual(cancellations, [{ actionId: 'a1', sessionId: 's1' }]);
});

test('failed pointer action without a resolved point cancels presentation', () => {
  const { controller, completions, cancellations } = fakeController();
  const hook = createComputerUseOverlayHook(controller as never);
  hook.onActionEnd?.(
    { type: 'left_click', coordinate: { x: 40, y: 30 } },
    { outcome: { ok: false, error: 'capture_failed', message: 'no effect' } },
    { sessionId: 's1', toolCallId: 'a1' },
  );
  assert.deepEqual(completions, []);
  assert.deepEqual(cancellations, [{ actionId: 'a1', sessionId: 's1' }]);
});

test('failed pointer action with a diagnostic point still cancels', () => {
  const { controller, completions, cancellations } = fakeController();
  const hook = createComputerUseOverlayHook(controller as never);
  hook.onActionEnd?.(
    { type: 'left_click', coordinate: { x: 40, y: 30 } },
    {
      outcome: { ok: false, error: 'target_changed', message: 'moved' },
      resolvedScreenPoint: { x: 140, y: 130 },
    },
    { sessionId: 's1', toolCallId: 'a1' },
  );
  assert.deepEqual(completions, []);
  assert.deepEqual(cancellations, [{ actionId: 'a1', sessionId: 's1' }]);
});

test('mouse_move completion is reconciled from executor evidence', () => {
  const { controller, completions } = fakeController();
  const hook = createComputerUseOverlayHook(controller as never);
  hook.onActionEnd?.(
    { type: 'mouse_move', coordinate: { x: 40, y: 30 } },
    {
      outcome: { ok: true, tier: 'coordinate-background' },
      resolvedScreenPoint: { x: 140, y: 130 },
    },
    { sessionId: 's1', toolCallId: 'move1' },
  );
  assert.deepEqual(completions, [
    {
      actionId: 'move1',
      sessionId: 's1',
      screenX: 140,
      screenY: 130,
      kind: 'move',
      pulse: false,
    },
  ]);
});

test('non-pointer actions keep the session cursor without moving it', () => {
  const { controller, moves, ensured } = fakeController();
  const hook = createComputerUseOverlayHook(controller as never);
  for (const action of [
    { type: 'type', text: 'hi' },
    { type: 'key', text: 'Return' },
    { type: 'screenshot' },
    { type: 'wait', durationMs: 100 },
  ] as CuAction[]) {
    hook.onActionBegin(action, { sessionId: 's1', toolCallId: 'a1' });
  }
  assert.deepEqual(moves, []);
  assert.deepEqual(ensured, ['s1', 's1', 's1', 's1']);
});

// ── The seam, not the fixture ───────────────────────────────────────────────
//
// Every test above hands `presentationScreenPoint` to the hook by name. Nothing
// above can say whether anything produces one, and for the semantic path
// nothing did: `bindCuaSemanticActionToObservation` set only `elementId`, so
// the runtime's `presentationScreenPoint()` returned `undefined` and every
// element action — the whole accessibility path, the only one Maka dispatches
// on by default — reached the sink as `ensure` then `cancel`. The cursor never
// moved, nothing landed, nothing pulsed, and `targetWindowId` was never used
// because the hook returned before it.
//
// So these drive the real tool with the real hook and record what the sink is
// actually told.

function recordingSink() {
  const events: Array<{ call: string; input: Record<string, unknown> }> = [];
  const strip = (input: Record<string, unknown>): Record<string, unknown> => {
    const { actionId: _a, sessionId: _s, ...rest } = input;
    return rest;
  };
  return {
    events,
    sink: {
      ensure: () => events.push({ call: 'ensure', input: {} }),
      move: (input: Record<string, unknown>) => {
        events.push({ call: 'move', input: strip(input) });
        return { readyForInteraction: Promise.resolve(), finished: Promise.resolve() };
      },
      complete: (input: Record<string, unknown>) => {
        events.push({ call: 'complete', input: strip(input) });
      },
      cancel: () => events.push({ call: 'cancel', input: {} }),
    },
  };
}

/**
 * A window at (100, 50) 400x300 on screen, captured 800x600, holding one button
 * whose observed frame is at (200, 100) 40x20 — screen coordinates, the same
 * space as the window bounds, which is how `validateSemanticElementVisibility`
 * already compares them.
 */
function fixtureObservation(): Record<string, unknown> {
  return {
    observationId: 'backend-obs-1',
    appId: 'Fixture',
    pid: 42,
    windowId: 4321,
    contentFingerprint: 'ax-structure-1',
    windowBounds: { x: 100, y: 50, width: 400, height: 300 },
    sourceBoundsPx: { x: 0, y: 0, width: 800, height: 600 },
    elements: [
      {
        elementId: '5',
        role: 'AXButton',
        label: 'Continue',
        frame: { x: 200, y: 100, width: 40, height: 20 },
        identity: { token: 'button-token', role: 'AXButton', label: 'Continue' },
      },
    ],
    screenshot: { base64: 'AA==', mimeType: 'image/png', widthPx: 800, heightPx: 600 },
  };
}

function toolContext(): Record<string, unknown> {
  return {
    sessionId: 's1',
    turnId: 't1',
    cwd: '/tmp',
    toolCallId: 'call1',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
}

async function driveRealTool(
  observationOverrides: Record<string, unknown>,
  call: Record<string, unknown>,
): Promise<Array<{ call: string; input: Record<string, unknown> }>> {
  const { events, sink } = recordingSink();
  const observed = { ...fixtureObservation(), ...observationOverrides };
  const backend = {
    async preflight() {
      return { accessibility: true, screenRecording: true };
    },
    async observeApp() {
      return observed;
    },
    async run() {
      return { outcome: { ok: true, tier: 'ax', verified: true } };
    },
    async runSemantic() {
      return { outcome: { ok: true, tier: 'ax', verified: true }, observation: observed };
    },
  };
  const [tool] = buildComputerUseTools({
    backend: backend as never,
    overlay: createComputerUseOverlayHook(sink as never),
  });
  const first = (await tool.impl(
    { action: 'observe', app: 'Fixture' } as never,
    toolContext() as never,
  )) as { modelText?: string };
  // `observe` answers in the rendered observation format, not JSON, so the id
  // is read with the same parser the runtime's own tests use rather than a
  // second copy of the grammar here.
  const observationId = parseObservationText(first.modelText ?? '')?.observation_id;
  events.length = 0;
  await tool.impl({ ...call, observation_id: observationId } as never, toolContext() as never);
  return events;
}

test('a semantic action reaches the sink with the point it is aimed at', async () => {
  const events = await driveRealTool({}, { action: 'click_element', element_id: '5' });
  assert.deepEqual(
    events.map((event) => event.call),
    ['move', 'complete'],
    'an element action must move the cursor and land it, not ensure-then-cancel',
  );
  // The centre of the element's own observed frame, in screen coordinates.
  assert.deepEqual(events[0]?.input, {
    screenX: 220,
    screenY: 110,
    kind: 'click',
    instant: true,
    keepElevated: false,
    targetWindowId: 4321,
  });
  assert.deepEqual(events[1]?.input, {
    screenX: 220,
    screenY: 110,
    kind: 'click',
    pulse: true,
    targetWindowId: 4321,
  });
});

test('a coordinate action is unchanged', async () => {
  const events = await driveRealTool({}, { action: 'left_click', coordinate: [400, 300] });
  assert.deepEqual(
    events.map((event) => event.call),
    ['move', 'complete'],
  );
  // 400/800 and 300/600 of a 400x300 window at (100, 50).
  const move = events[0]?.input as { screenX: number; screenY: number };
  assert.equal(move.screenX, 300);
  assert.equal(move.screenY, 200);
});

test('an element whose observed frame is outside its window is not aimed at', async () => {
  // A frame that no longer lies inside the window is stale or the element has
  // moved, which is what the executor refuses the action for. Flying the cursor
  // to a point the action will be rejected from is worse than not moving it.
  const events = await driveRealTool(
    {
      elements: [
        {
          elementId: '5',
          role: 'AXButton',
          label: 'Continue',
          frame: { x: 900, y: 900, width: 40, height: 20 },
          identity: { token: 'button-token', role: 'AXButton', label: 'Continue' },
        },
      ],
    },
    { action: 'click_element', element_id: '5' },
  );
  assert.deepEqual(
    events.map((event) => event.call),
    ['ensure', 'cancel'],
  );
});

test('an element the observation reported no frame for is not aimed at either', async () => {
  const events = await driveRealTool(
    {
      elements: [
        {
          elementId: '5',
          role: 'AXButton',
          label: 'Continue',
          identity: { token: 'button-token', role: 'AXButton', label: 'Continue' },
        },
      ],
    },
    { action: 'click_element', element_id: '5' },
  );
  assert.deepEqual(
    events.map((event) => event.call),
    ['ensure', 'cancel'],
  );
});
