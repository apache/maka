import assert from 'node:assert/strict';
import test from 'node:test';
import {
  candidateStartupFailureExitCode,
  candidateStartupFailureForExitCode,
  classifyCandidateStartupFailure,
} from '../candidate-startup-failure.js';

test('preserves the primary startup classification through cleanup aggregation', () => {
  const primary = Object.assign(new Error('stored row contains private data'), {
    code: 'stored_session_message_incompatible',
  });
  const aggregated = new AggregateError(
    [primary, new Error('cleanup failed')],
    'startup and cleanup failed',
    { cause: primary },
  );

  const failure = classifyCandidateStartupFailure(aggregated);
  assert.deepEqual(failure, { reason: 'stored_data_incompatible' });
  assert.deepEqual(
    candidateStartupFailureForExitCode(candidateStartupFailureExitCode(failure)),
    failure,
  );
});

test('classifies unknown startup failures without serializing their message', () => {
  const failure = classifyCandidateStartupFailure(new Error('private provider or workspace data'));
  assert.deepEqual(failure, { reason: 'internal_startup_failure' });
  assert.equal(JSON.stringify(failure).includes('private'), false);
});
