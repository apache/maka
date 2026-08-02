import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CuAction } from '@maka/core';
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
      targetStacking: { frontmost: true, destinationCovered: true },
    },
  );
  assert.equal((moves[0] as { keepElevated: boolean }).keepElevated, false);
  assert.equal((moves[0] as { targetWindowId?: number }).targetWindowId, 4321);
});

test('a covered destination keeps the cursor elevated instead of hiding it', () => {
  const { controller, moves, ensured } = fakeController();
  const hook = createComputerUseOverlayHook(controller as never);
  hook.onActionBegin(
    { type: 'left_click', coordinate: { x: 400, y: 300 } },
    {
      sessionId: 's1',
      toolCallId: 'a1',
      presentationScreenPoint: { x: 201, y: 151 },
      targetStacking: { frontmost: false, destinationCovered: true },
    },
  );
  assert.equal(moves.length, 1, 'the cursor is still drawn over the covering window');
  assert.equal((moves[0] as { keepElevated: boolean }).keepElevated, true);
  assert.deepEqual(ensured, []);
});

test('the cursor may sink only when the target is exposed under it and behind something else', () => {
  const { controller, moves } = fakeController();
  const hook = createComputerUseOverlayHook(controller as never);
  hook.onActionBegin(
    { type: 'left_click', coordinate: { x: 400, y: 300 } },
    {
      sessionId: 's1',
      toolCallId: 'a1',
      presentationScreenPoint: { x: 201, y: 151 },
      targetStacking: { frontmost: false, destinationCovered: false },
    },
  );
  assert.equal((moves[0] as { keepElevated: boolean }).keepElevated, false);
});

test('a frontmost target stays elevated so the cursor clears its open menus', () => {
  const { controller, moves } = fakeController();
  const hook = createComputerUseOverlayHook(controller as never);
  hook.onActionBegin(
    { type: 'left_click', coordinate: { x: 400, y: 300 } },
    {
      sessionId: 's1',
      toolCallId: 'a1',
      presentationScreenPoint: { x: 201, y: 151 },
      targetStacking: { frontmost: true, destinationCovered: false },
    },
  );
  assert.equal((moves[0] as { keepElevated: boolean }).keepElevated, true);
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

test('a semantic action lands on the point it was sent to, instead of being wiped', () => {
  // `runSemantic` reports no landing point — an element action resolves to an
  // element, never to a pointer position. Requiring one made every action on
  // the accessibility path, the only path Maka dispatches on by default, end in
  // `cancel()`: the cursor flew to the control and was erased on arrival.
  const { controller, completions, cancellations } = fakeController();
  const hook = createComputerUseOverlayHook(controller as never);
  hook.onActionEnd?.(
    { type: 'left_click', coordinate: { x: 400, y: 300 } },
    { outcome: { ok: true, tier: 'ax', verified: false } },
    {
      sessionId: 's1',
      toolCallId: 'a1',
      presentationScreenPoint: { x: 1362, y: 397 },
    },
  );
  assert.deepEqual(cancellations, []);
  assert.deepEqual(completions, [
    {
      actionId: 'a1',
      sessionId: 's1',
      screenX: 1362,
      screenY: 397,
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
