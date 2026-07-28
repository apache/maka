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

test('completion uses only the executor-resolved point', () => {
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
