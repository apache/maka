import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { computerParams } from '../computer-use-codec.js';
import { computerWireParams } from '../computer-use-tools.js';

/**
 * The tool takes arguments through two schemas, and they are written by hand.
 *
 * `computerWireParams` is the flat object the SDK validates a model's call
 * against — one shape covering every action, most fields optional.
 * `computerParams` is the strict discriminated union the tool narrows to before
 * it does anything. A field has to exist in both: the first to be accepted off
 * the wire, the second to survive narrowing.
 *
 * `window_action` existed in the union and not on the wire, and was therefore
 * unreachable from the day it shipped. Nothing failed — the SDK rejected those
 * calls above the layer the debug journal records, the unit tests exercised the
 * union directly, and the real-machine probe went around the tool entirely. It
 * took a model saying it had tried the action, and a trace showing no such call
 * had ever been made, to find it.
 *
 * A sample-driven test cannot catch the next one, because the next one will be
 * an action nobody thought to sample. This walks the union.
 */
function wireFields(): Set<string> {
  const shape = (computerWireParams as unknown as { shape?: Record<string, unknown> }).shape;
  assert.ok(shape, 'the wire schema must expose its shape for this check to mean anything');
  return new Set(Object.keys(shape));
}

function unionArms(): Array<{ action: string; fields: string[] }> {
  return computerParams.options.map((option) => {
    const shape = option.shape as Record<string, { value?: unknown; _def?: { value?: unknown } }>;
    const literal = shape.action;
    return {
      action: String(literal?.value ?? literal?._def?.value),
      fields: Object.keys(shape),
    };
  });
}

describe('the two argument schemas describe the same tool', () => {
  test('every field an action accepts can reach it through the wire', () => {
    const wire = wireFields();
    const unreachable = unionArms()
      .map(({ action, fields }) => ({ action, missing: fields.filter((f) => !wire.has(f)) }))
      .filter(({ missing }) => missing.length > 0);

    assert.deepEqual(
      unreachable,
      [],
      'these fields exist in the union and not on the wire, so a model cannot send them',
    );
  });

  test('the union covers every action name, and names nothing the wire cannot carry', () => {
    // The reverse direction: a wire field belonging to no arm is dead weight in
    // the description every model reads, and an arm the wire cannot name is the
    // window_action failure again.
    const arms = unionArms();
    assert.ok(arms.length > 0, 'the union must have arms');
    for (const { action } of arms) {
      assert.notEqual(action, 'undefined', 'every arm must discriminate on a literal action');
    }
  });

  test('the check would fail if a field were missing', () => {
    // A test that cannot fail is not a check. This is the shape of the bug it
    // exists to catch, proven against the same comparison.
    const wire = new Set(['action', 'observation_id']);
    const pretend = [{ action: 'window_action', fields: ['action', 'observation_id', 'position'] }];
    const unreachable = pretend
      .map(({ action, fields }) => ({ action, missing: fields.filter((f) => !wire.has(f)) }))
      .filter(({ missing }) => missing.length > 0);

    assert.deepEqual(unreachable, [{ action: 'window_action', missing: ['position'] }]);
  });
});
