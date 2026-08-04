// What the wire adapter says when it cannot build an action.
//
// These throws become the tool result the model reads, so the code in front of
// the colon is the first thing it acts on. Two of them named a coordinate for
// failures that had nothing to do with one, which sends a model that mistyped
// an action name or forgot `text` off to check its coordinates.
import test from 'node:test';
import assert from 'node:assert/strict';

import { adaptToCuAction, computerActionNames } from '../computer-use-codec.js';

test('a missing text is reported as a missing argument, not a bad coordinate', () => {
  for (const action of ['type', 'key', 'hold_key'] as const) {
    assert.throws(
      () => adaptToCuAction({ action, observation_id: 'obs-1' } as never),
      (error: Error) => {
        assert.doesNotMatch(error.message, /invalid_coordinate/);
        assert.match(error.message, /requires text/);
        assert.match(error.message, /`text`/);
        return true;
      },
      `${action} should name the argument it is missing`,
    );
  }
});

test('an unknown action is answered with the actions this tool takes', () => {
  assert.throws(
    () => adaptToCuAction({ action: 'type_text', text: 'hello' } as never),
    (error: Error) => {
      assert.doesNotMatch(error.message, /invalid_coordinate/);
      // The word it sent back is not the answer; the closed set is.
      for (const name of ['type', 'key', 'left_click', 'observe', 'click_element']) {
        assert.ok(error.message.includes(name), `the refusal should list \`${name}\``);
      }
      return true;
    },
  );
});

test('an unknown action never echoes what was sent with it', () => {
  const secret = 'hunter2-correct-horse';
  assert.throws(
    () => adaptToCuAction({ action: 'type_text', text: secret } as never),
    (error: Error) => {
      assert.ok(!error.message.includes(secret), 'a refusal must not echo a typed value');
      return true;
    },
  );
});

test('the action list is read off the schema rather than kept by hand', () => {
  const names = computerActionNames();
  assert.ok(names.includes('element_sequence'));
  assert.ok(names.includes('window_action'));
  assert.equal(new Set(names).size, names.length, 'no action should be listed twice');
});

test('a coordinate action that is missing its coordinate still says so', () => {
  assert.throws(
    () => adaptToCuAction({ action: 'left_click', observation_id: 'obs-1' } as never),
    /invalid_coordinate/,
  );
});
