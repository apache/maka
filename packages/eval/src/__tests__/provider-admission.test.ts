import assert from 'node:assert/strict';
import test from 'node:test';
import { isInferenceAdmissionEvent, isSuccessfulInferenceResponse } from '../provider-admission.js';

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

test('treats a successful model response as inference admission without guessing from errors', () => {
  assert.equal(isSuccessfulInferenceResponse(200, 'deepseek-v4-flash'), true);
  assert.equal(isSuccessfulInferenceResponse(204, 'deepseek-v4-flash'), true);
  assert.equal(isSuccessfulInferenceResponse(200, undefined), false);
  assert.equal(isSuccessfulInferenceResponse(429, 'deepseek-v4-flash'), false);
  assert.equal(isSuccessfulInferenceResponse(500, 'deepseek-v4-flash'), false);
});
