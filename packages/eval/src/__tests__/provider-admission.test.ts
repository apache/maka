import assert from 'node:assert/strict';
import test from 'node:test';
import { isInferenceAdmissionEvent } from '../provider-admission.js';

test('recognizes confirmed provider inference events', () => {
  assert.equal(isInferenceAdmissionEvent({ type: 'response.created' }, false), true);
  assert.equal(
    isInferenceAdmissionEvent({ type: 'message_start', message: { id: 'msg' } }, true),
    true,
  );
  assert.equal(isInferenceAdmissionEvent({ choices: [{ delta: { content: 'x' } }] }, false), true);
  assert.equal(isInferenceAdmissionEvent({ usage: { input_tokens: 1 } }, false), true);
});

test('does not treat provider and transport errors as model admission', () => {
  assert.equal(isInferenceAdmissionEvent({ error: { type: 'rate_limit' } }, false), false);
  assert.equal(isInferenceAdmissionEvent({ type: 'response.failed' }, false), false);
  assert.equal(isInferenceAdmissionEvent({ type: 'ping' }, true), false);
});
