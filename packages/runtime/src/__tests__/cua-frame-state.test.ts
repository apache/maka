import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CuAction } from '@maka/core/computer-use';
import {
  bindCuaAction,
  bindCuaActionToObservation,
  bindCuaSemanticActionToObservation,
  CuaFrameState,
  fingerprintCuaSemanticAction,
} from '../cua-frame-state.js';

function createState(): CuaFrameState {
  let nextFrameId = 1;
  return new CuaFrameState(() => `frame-${nextFrameId++}`);
}

function observation() {
  return {
    capturedAt: 1,
    displays: [],
    target: { pid: 42, windowId: 7 },
  };
}

describe('CuaFrameState', () => {
  test('creates a new frame identity for every observation', () => {
    const state = createState();

    assert.deepEqual(
      { frameId: state.observe(observation()).frameId, epoch: state.activeObservation()?.epoch },
      { frameId: 'frame-1', epoch: 0 },
    );
    assert.deepEqual(
      { frameId: state.observe(observation()).frameId, epoch: state.activeObservation()?.epoch },
      { frameId: 'frame-2', epoch: 0 },
    );
  });

  test('binds an action fingerprint to its observed frame', () => {
    const state = createState();
    const firstFrame = state.observe(observation());
    const first = bindCuaAction(firstFrame, 'click:10,20', firstFrame.target);
    const secondFrame = state.observe(observation());
    const second = bindCuaAction(secondFrame, 'click:10,20', secondFrame.target);

    assert.notEqual(first.fingerprint, second.fingerprint);
    assert.equal(first.frameId, 'frame-1');
    assert.equal(second.frameId, 'frame-2');
  });

  test('rejects an action from a superseded frame', () => {
    const state = createState();
    const oldFrame = state.observe(observation());
    const oldAction = bindCuaAction(oldFrame, 'click:10,20', oldFrame.target);
    state.observe(observation());

    assert.deepEqual(state.claimAction(oldAction), {
      ok: false,
      reason: 'stale_frame',
    });
  });

  test('rejects the same action twice on one frame', () => {
    const state = createState();
    const frame = state.observe(observation());
    const action = bindCuaAction(frame, 'click:10,20', frame.target);

    assert.deepEqual(state.claimAction(action), { ok: true });
    assert.deepEqual(state.claimAction(action), {
      ok: false,
      reason: 'duplicate_action',
    });
  });

  test('rejects old actions after invalidation', () => {
    const state = createState();
    const frame = state.observe(observation());
    const action = bindCuaAction(frame, 'click:10,20', frame.target);

    assert.equal(state.invalidate(), 1);
    assert.deepEqual(state.claimAction(action), {
      ok: false,
      reason: 'no_active_frame',
    });
    assert.deepEqual((({ frameId, epoch }) => ({ frameId, epoch }))(state.observe(observation())), {
      frameId: 'frame-2',
      epoch: 1,
    });
    assert.deepEqual(state.claimAction(action), {
      ok: false,
      reason: 'stale_epoch',
    });
  });

  test('advances the epoch only after confirming a claimed action', () => {
    const state = createState();
    const frame = state.observe(observation());
    const action = bindCuaAction(frame, 'type:hello', frame.target);

    assert.deepEqual(state.confirmAction(action), {
      ok: false,
      reason: 'action_not_claimed',
    });
    assert.deepEqual(state.claimAction(action), { ok: true });
    assert.deepEqual(state.confirmAction(action), { ok: true, epoch: 1 });
    assert.deepEqual((({ frameId, epoch }) => ({ frameId, epoch }))(state.observe(observation())), {
      frameId: 'frame-2',
      epoch: 1,
    });
  });

  test('binds coordinates to the immediately preceding window screenshot space', () => {
    const state = createState();
    const observation = state.observe({
      capturedAt: 1,
      screenshotWidthPx: 800,
      screenshotHeightPx: 600,
      displays: [],
      target: {
        pid: 42,
        windowId: 7,
        bounds: { x: 100, y: 200, width: 800, height: 600 },
        sourceBoundsPx: { x: 0, y: 0, width: 800, height: 600 },
      },
    });
    const action: CuAction = {
      type: 'left_click',
      coordinate: { x: 25, y: 30 },
    };

    const bound = bindCuaActionToObservation(observation, action);

    assert.equal(bound?.target?.windowId, 7);
    assert.deepEqual(bound?.windowCoordinate, { x: 25, y: 30 });
    assert.equal(bound?.coordinateSpace, 'window-screenshot-local');
  });

  test('rejects a coordinate outside the bound window screenshot', () => {
    const state = createState();
    const observation = state.observe({
      capturedAt: 1,
      screenshotWidthPx: 800,
      screenshotHeightPx: 600,
      displays: [],
      target: { pid: 42, windowId: 7 },
    });

    assert.equal(
      bindCuaActionToObservation(observation, {
        type: 'left_click',
        coordinate: { x: 801, y: 30 },
      }),
      undefined,
    );
  });

  // A refusal the executor never dispatched must not cost the frame.
  //
  // Measured on a real save-as-PDF run: `click_element` was refused
  // `unsupported_action` with `path: "none"`, the frame was invalidated anyway,
  // and `unsupported_action` is not one of the codes that hands back a fresh
  // observation — so the next call was `reobserve_required` and the one after it
  // was an `observe` that changed nothing. Three rounds of that, 9 of 23 calls,
  // before the model found the route it needed.
  test('an action that never ran is retired without spending the frame', () => {
    const state = createState();
    const frame = state.observe(observation());
    const first = bindCuaSemanticActionToObservation(frame, {
      type: 'click_element',
      elementId: '2',
    }) as NonNullable<ReturnType<typeof bindCuaSemanticActionToObservation>>;

    assert.equal(state.claimAction(first).ok, true);
    const retired = state.retireAction(first);

    assert.equal(retired.ok, true);
    // The epoch does not move, so the frame the model is holding still names
    // the window it is looking at.
    assert.equal(retired.ok && retired.epoch, frame.epoch);
    assert.equal(state.activeObservation()?.frameId, frame.frameId);
  });

  test('a retired frame still accepts a different action', () => {
    const state = createState();
    const frame = state.observe(observation());
    const bind = (elementId: string) =>
      bindCuaSemanticActionToObservation(frame, {
        type: 'click_element',
        elementId,
      }) as NonNullable<ReturnType<typeof bindCuaSemanticActionToObservation>>;

    const refused = bind('2');
    state.claimAction(refused);
    state.retireAction(refused);

    // The point of keeping the frame: the model can address something else with
    // the observation it already has, which is the round trip being saved.
    assert.deepEqual(state.claimAction(bind('7')), { ok: true });
  });

  test('the same action is not offered twice after being retired', () => {
    const state = createState();
    const frame = state.observe(observation());
    const action = bindCuaSemanticActionToObservation(frame, {
      type: 'click_element',
      elementId: '2',
    }) as NonNullable<ReturnType<typeof bindCuaSemanticActionToObservation>>;

    state.claimAction(action);
    state.retireAction(action);

    // Retired, not released — and said apart from a dispatched repeat, because
    // the two carry opposite instructions. `duplicate_action` means the action
    // may already have taken effect and the model should look; this one means
    // nothing was dispatched either time, which is the same thing the refusal
    // it just received told it.
    assert.deepEqual(state.claimAction(action), { ok: false, reason: 'retired_action' });
  });

  test('a lookup can tell a retired action from one that ran', () => {
    // `wasRetired` mirrors `isConsumed` exactly — same arguments, same
    // recomputed binding — because the pre-check that uses them has only a
    // frame and a fingerprint, not a bound action.
    const state = createState();
    const frame = state.observe(observation());
    const retire = bindCuaAction(
      frame,
      fingerprintCuaSemanticAction('click_element'),
      frame.target,
    );
    state.claimAction(retire);
    state.retireAction(retire);
    assert.equal(state.isConsumed(frame, retire.actionFingerprint), true);
    assert.equal(state.wasRetired(frame, retire.actionFingerprint), true);
  });

  test('a repeat of an action that did run is still duplicate_action', () => {
    // The other half of the same fact, through the claim path: this one reached
    // the window, so "observe and see whether it took effect" is the right
    // thing to say about it and the wrong thing to say about a retired one.
    const state = createState();
    const frame = state.observe(observation());
    const action = bindCuaAction(frame, fingerprintCuaSemanticAction('set_value'), frame.target);
    state.claimAction(action);
    state.confirmAction(action);

    assert.deepEqual(state.claimAction(action), { ok: false, reason: 'duplicate_action' });
  });

  test('retiring an action nobody claimed is refused rather than silently accepted', () => {
    const state = createState();
    const frame = state.observe(observation());
    const action = bindCuaSemanticActionToObservation(frame, {
      type: 'click_element',
      elementId: '2',
    }) as NonNullable<ReturnType<typeof bindCuaSemanticActionToObservation>>;

    assert.deepEqual(state.retireAction(action), { ok: false, reason: 'action_not_claimed' });
  });

  test('semantic actions bind element identity to the observed window', () => {
    const state = createState();
    const observation = state.observe({
      capturedAt: 1,
      displays: [],
      target: { pid: 42, windowId: 7 },
    });

    const bound = bindCuaSemanticActionToObservation(observation, {
      type: 'click_element',
      elementId: 'old-index-5',
    });

    assert.equal(bound?.target?.windowId, 7);
    assert.equal(bound?.elementId, 'old-index-5');
  });
});
