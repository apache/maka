// Direct unit tests for the filesystem-authority contract module. The
// integration path (executor → ToolOutcomeUnknownError) is covered in
// filesystem-mutation-outcome.test.ts; these tests pin the pure classifier
// and its types at the contract seam.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { FilesystemWorkerClientError } from '../filesystem-worker/client.js';
import {
  classifyFailedMutationOutcome,
  UNKNOWN_OUTCOME_REASONS,
  type FilesystemMutationOutcome,
  type FilesystemTargetDescriptor,
  type FilesystemTargetIdentity,
} from '../filesystem-authority.js';

function workerError(
  reason: ConstructorParameters<typeof FilesystemWorkerClientError>[0]['reason'],
  dispatched?: boolean,
): FilesystemWorkerClientError {
  return new FilesystemWorkerClientError({
    reason,
    stage: 'launch',
    requestId: 'test',
    ...(dispatched !== undefined ? { dispatched } : {}),
  });
}

describe('filesystem-authority contract: classifyFailedMutationOutcome', () => {
  test('a non-worker error is not classifiable', () => {
    assert.equal(classifyFailedMutationOutcome(new Error('boom')), undefined);
    assert.equal(classifyFailedMutationOutcome(undefined), undefined);
  });

  test('an aborted error is unknown only after dispatch', () => {
    assert.equal(classifyFailedMutationOutcome(workerError('aborted', false)), undefined);
    assert.equal(classifyFailedMutationOutcome(workerError('aborted', true)), 'unknown');
    // An aborted error with no flag (the question does not apply) is not unknown.
    assert.equal(classifyFailedMutationOutcome(workerError('aborted')), undefined);
  });

  test('every UNKNOWN_OUTCOME_REASONS member maps to unknown', () => {
    for (const reason of UNKNOWN_OUTCOME_REASONS) {
      // These reasons are semantically dispatched, so the flag is irrelevant.
      assert.equal(
        classifyFailedMutationOutcome(workerError(reason, true)),
        'unknown',
        `${reason} (dispatched=true) should be unknown`,
      );
      assert.equal(
        classifyFailedMutationOutcome(workerError(reason, undefined)),
        'unknown',
        `${reason} (dispatched unset) should still be unknown`,
      );
    }
  });

  test('a never-dispatched spawn failure is not unknown', () => {
    assert.equal(classifyFailedMutationOutcome(workerError('spawn_failed', false)), undefined);
  });

  test('pre-flight validation failures are not unknown', () => {
    assert.equal(
      classifyFailedMutationOutcome(
        new FilesystemWorkerClientError({
          reason: 'invalid_request',
          stage: 'validation',
          requestId: 'test',
        }),
      ),
      undefined,
    );
  });
});

describe('filesystem-authority contract: descriptor identity is opaque strings', () => {
  // The contract pins identity as decimal strings (BigInt cannot cross the JSON
  // boundary). These compile-time checks document that and guard a future
  // switch back to bigint.
  test('identity is {dev, ino} string fields', () => {
    const identity: FilesystemTargetIdentity = { dev: '123', ino: '456' };
    assert.equal(typeof identity.dev, 'string');
    assert.equal(typeof identity.ino, 'string');
  });

  test('a missing descriptor carries no identity', () => {
    const missing: FilesystemTargetDescriptor = {
      enforcementPath: '/tmp/x',
      targetType: 'missing',
    };
    assert.equal('identity' in missing, false);
  });

  test('an existing descriptor requires an identity', () => {
    const existing: FilesystemTargetDescriptor = {
      enforcementPath: '/tmp/x',
      targetType: 'file',
      identity: { dev: '1', ino: '2' },
    };
    assert.deepEqual(existing.identity, { dev: '1', ino: '2' });
  });

  test('MutationOutcome is the three-valued result set', () => {
    const outcomes: FilesystemMutationOutcome[] = ['applied', 'rejected', 'unknown'];
    assert.deepEqual([...outcomes].sort(), ['applied', 'rejected', 'unknown']);
  });
});
