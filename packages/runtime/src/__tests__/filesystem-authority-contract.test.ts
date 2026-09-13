/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

// Direct unit tests for the filesystem-authority contract module. The
// integration path (executor → ToolOutcomeUnknownError) is covered in
// filesystem-mutation-outcome.test.ts; these tests pin the pure classifier
// and its types at the contract seam.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { FilesystemWorkerClientError } from '../filesystem-worker/client.js';
import { classifyFailedMutationOutcome, UNKNOWN_OUTCOME_REASONS } from '../filesystem-authority.js';

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
