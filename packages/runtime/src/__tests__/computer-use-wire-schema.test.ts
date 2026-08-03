// What the model is allowed to send has to match what the tool knows how to do.
//
// There are two schemas. `computerWireParams` is what the SDK validates a tool
// call against; `computerParams` is the strict union the tool narrows it to.
// Only the first one is enforced against a model, and only the second one has
// ever been tested.
//
// `window_action` shipped through that gap. Its fields went into the union, its
// tests passed against the union, and a real-machine probe called the backend
// directly and moved a window 80 points without taking the foreground. The wire
// schema is `.strict()` and had no `window_action`, `position` or `size`, so
// every call a model made was rejected by the SDK before reaching the tool —
// and invisibly, because the debug journal wraps `impl`, which was never
// reached. On a real run the model found the right action, was rejected,
// concluded "let me use that with the proper field names", and ran out of turn.
//
// This test exists so the next action cannot ship the same way.
import test from 'node:test';
import assert from 'node:assert/strict';

import { computerWireParams } from '../computer-use-tools.js';
import { computerActionNames, computerParams } from '../computer-use-codec.js';

/**
 * One legal call per action, written the way a model would send it.
 *
 * Every one of these is first checked against `computerParams`, so a sample
 * that drifts from the strict union fails here rather than silently weakening
 * the wire assertion it exists to make.
 */
const CALLS: Array<Record<string, unknown>> = [
  { action: 'list_apps' },
  { action: 'list_apps', app: 'TextEdit' },
  { action: 'launch_app', app: 'TextEdit' },
  { action: 'observe', app: 'com.apple.TextEdit' },
  { action: 'observe', app: 'com.apple.TextEdit', menu: '文件' },
  { action: 'observe', app: 'com.apple.finder', query: '下载' },
  { action: 'observe', window_id: 7, include_screenshot: false },
  { action: 'click_element', observation_id: 'o', element_id: '3' },
  { action: 'set_value', observation_id: 'o', element_id: '3', value: 'hello' },
  { action: 'select_text', observation_id: 'o', element_id: '3', text: 'hello' },
  { action: 'secondary_action', observation_id: 'o', element_id: '3', text: 'raise' },
  {
    action: 'scroll_element',
    observation_id: 'o',
    element_id: '3',
    scroll_direction: 'down',
    scroll_amount: 10,
  },
  {
    action: 'element_sequence',
    observation_id: 'o',
    steps: [{ label: 'OK' }, { label: 'Name', do: 'set_value', value: 'x' }],
  },
  { action: 'press_key', observation_id: 'o', text: 'Return' },
  { action: 'press_key', observation_id: 'o', element_id: '3', text: 'Tab' },
  {
    action: 'window_action',
    observation_id: 'o',
    element_id: '0',
    window_action: 'move',
    position: [220, 164],
  },
  {
    action: 'window_action',
    observation_id: 'o',
    element_id: '0',
    window_action: 'resize',
    size: [800, 600],
  },
  { action: 'window_action', observation_id: 'o', element_id: '0', window_action: 'minimize' },
  { action: 'screenshot', app: 'com.apple.TextEdit' },
  { action: 'cursor_position' },
  { action: 'mouse_move', observation_id: 'o', coordinate: [10, 20] },
  { action: 'left_click', observation_id: 'o', coordinate: [10, 20] },
  { action: 'right_click', observation_id: 'o', coordinate: [10, 20] },
  { action: 'middle_click', observation_id: 'o', coordinate: [10, 20] },
  { action: 'double_click', observation_id: 'o', coordinate: [10, 20] },
  { action: 'triple_click', observation_id: 'o', coordinate: [10, 20] },
  { action: 'left_mouse_down', observation_id: 'o', coordinate: [10, 20] },
  { action: 'left_mouse_up', observation_id: 'o', coordinate: [10, 20] },
  {
    action: 'left_click_drag',
    observation_id: 'o',
    start_coordinate: [10, 20],
    coordinate: [90, 120],
  },
  { action: 'type', observation_id: 'o', text: 'hello' },
  { action: 'key', observation_id: 'o', text: 'Return' },
  { action: 'hold_key', observation_id: 'o', text: 'shift', duration: 1 },
  {
    action: 'scroll',
    observation_id: 'o',
    coordinate: [10, 20],
    scroll_direction: 'down',
    scroll_amount: 10,
  },
  { action: 'zoom', observation_id: 'o', region: [0, 0, 100, 100] },
  { action: 'wait', duration: 1 },
  { action: 'wait', wait_for_text: 'Saved', duration: 5 },
  { action: 'wait', wait_for_text_gone: 'Loading' },
];

for (const call of CALLS) {
  const name =
    call.action === 'window_action'
      ? `window_action=${String(call.window_action)}`
      : String(call.action);
  test(`a legal ${name} call survives both schemas`, () => {
    // The sample is a legal call at all…
    const strict = computerParams.safeParse(call);
    assert.equal(
      strict.success,
      true,
      `the sample itself is not a legal call: ${JSON.stringify(strict.error?.issues)}`,
    );
    // …and the model is allowed to send it. This is the assertion that was
    // missing: a field present in the union and absent from the wire schema is
    // an action the model cannot reach, and nothing else in the suite notices.
    const wire = computerWireParams.safeParse(call);
    assert.equal(
      wire.success,
      true,
      `the wire schema rejects it, so the SDK will refuse the call before the tool sees it: ${JSON.stringify(wire.error?.issues)}`,
    );
  });
}

test('every action in the strict union is offered by the wire enum', () => {
  // The other half of the same gap: an action the union understands and the
  // enum does not is one the model is never told exists.
  //
  // Read from `computerParams`, not from CALLS. Built from CALLS this asserted
  // that the actions this file happens to list are in the enum — which is true
  // by construction the moment each one has a passing sample above, and stays
  // true when an action is added to the strict union and to neither. Injecting
  // an action into the union alone (the historical `window_action` bug class)
  // left this suite at 24 pass, 0 fail.
  const offered = new Set(
    (computerWireParams.shape.action as unknown as { options: string[] }).options,
  );
  const known = computerActionNames();
  assert.ok(known.length > 0, 'the strict union declares no actions at all');
  for (const action of known) {
    assert.ok(offered.has(action), `${action} is not in the action enum the model is shown`);
  }
});

test('every action in the strict union has a sample call above', () => {
  // The per-call assertions are what prove a field reaches the model, and they
  // only cover the actions CALLS names. An action with no sample is one whose
  // arguments nothing here holds against the wire schema, which is exactly how
  // `window_action` shipped unusable.
  const sampled = new Set(CALLS.map((call) => String(call.action)));
  for (const action of computerActionNames()) {
    assert.ok(sampled.has(action), `${action} has no sample call in CALLS`);
  }
});
