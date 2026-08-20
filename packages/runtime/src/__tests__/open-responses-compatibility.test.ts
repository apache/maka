import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenResponsesCompatibilityFinalizer } from '../open-responses-compatibility.js';

test('applies the declared Open Responses body policies', () => {
  const finalize = createOpenResponsesCompatibilityFinalizer('alibaba-token-plan');
  assert.ok(finalize);
  assert.deepEqual(finalize({ model: 'qwen3.8-max', store: true, tool_choice: 'auto' }), {
    model: 'qwen3.8-max',
    store: false,
    tool_choice: 'auto',
  });
  assert.deepEqual(finalize({ model: 'qwen3.8-max' }), {
    model: 'qwen3.8-max',
    store: false,
  });
  for (const toolChoice of ['required', { type: 'function', name: 'lookup' }]) {
    assert.throws(
      () => finalize({ tool_choice: toolChoice }),
      /does not support forced tool_choice/,
    );
  }
});
