import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { COMPUTER_USE_SEMANTIC_ACTIONS, computerUseApprovalSummary } from '@maka/core';

import { computerParams } from '../computer-use-codec.js';

/** Every action the tool schema accepts, read off the schema itself. */
function schemaActions(): string[] {
  return computerParams.options.map((option) => {
    const literal = option.shape.action as { value?: unknown; _def?: { value?: unknown } };
    return String(literal.value ?? literal._def?.value);
  });
}

describe('computer use approval actions', () => {
  test('summarises every action the schema accepts', () => {
    // These two lists are written in different packages — core cannot import
    // the schema — and they drifted: `window_action` reached the schema and not
    // the summary, so every window move, resize and minimise was projected as
    // `unknown` both to the person approving it and to the model reading its
    // own call back. Nothing failed; the action worked and described itself as
    // nothing in particular, which is why it survived.
    const unnamed = schemaActions().filter(
      (action) => computerUseApprovalSummary({ action }).action === 'unknown',
    );

    assert.deepEqual(unnamed, [], 'these actions summarise as `unknown`');
  });

  test('names no action the schema does not accept', () => {
    const accepted = new Set(schemaActions());
    const stale = COMPUTER_USE_SEMANTIC_ACTIONS.filter((action) => !accepted.has(action));

    assert.deepEqual(stale, [], 'these action names outlived the schema');
  });
});
