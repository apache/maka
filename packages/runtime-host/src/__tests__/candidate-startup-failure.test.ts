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

test('does not classify cleanup errors as the primary startup failure', () => {
  const primary = new Error('primary recovery failure');
  const cleanup = Object.assign(new Error('secondary cleanup failure'), { errcode: 10 });
  const aggregated = new AggregateError([primary, cleanup], 'startup and cleanup failed', {
    cause: primary,
  });

  assert.deepEqual(classifyCandidateStartupFailure(aggregated), {
    reason: 'internal_startup_failure',
  });
});

test('does not infer workspace ownership from a generic filesystem error', () => {
  const filesystemError = Object.assign(new Error('resource is unavailable'), { code: 'EACCES' });
  const resourceError = new Error('Bundled resource is unavailable', { cause: filesystemError });

  assert.deepEqual(classifyCandidateStartupFailure(resourceError), {
    reason: 'internal_startup_failure',
  });
});

test('classifies unknown startup failures without serializing their message', () => {
  const failure = classifyCandidateStartupFailure(new Error('private provider or workspace data'));
  assert.deepEqual(failure, { reason: 'internal_startup_failure' });
  assert.equal(JSON.stringify(failure).includes('private'), false);
});
