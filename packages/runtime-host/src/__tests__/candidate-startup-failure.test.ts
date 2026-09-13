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

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  candidateStartupFailureExitCode,
  candidateStartupFailureForExitCode,
  classifyCandidateStartupFailure,
  isPermanentCandidateStartupFailure,
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

test('preserves an operational migration blocker through the Candidate boundary', () => {
  const blocker = Object.assign(new Error('private migration detail'), {
    code: 'operational_state_migration_blocked',
  });
  const failure = classifyCandidateStartupFailure(
    new AggregateError([blocker, new Error('cleanup failed')], 'startup failed', {
      cause: blocker,
    }),
  );

  assert.deepEqual(failure, { reason: 'operational_state_migration_blocked' });
  assert.deepEqual(
    candidateStartupFailureForExitCode(candidateStartupFailureExitCode(failure)),
    failure,
  );
  assert.equal(JSON.stringify(failure).includes('private'), false);
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

test('preserves a retryable Local IPC security failure across the Candidate boundary', () => {
  const endpointError = Object.assign(new Error('private Windows ACL detail'), {
    code: 'insecure_endpoint_directory',
  });
  const failure = classifyCandidateStartupFailure(
    new AggregateError([endpointError, new Error('cleanup failed')], 'startup failed', {
      cause: endpointError,
    }),
  );

  assert.deepEqual(failure, { reason: 'local_ipc_security_failed' });
  assert.deepEqual(
    candidateStartupFailureForExitCode(candidateStartupFailureExitCode(failure)),
    failure,
  );
  assert.equal(isPermanentCandidateStartupFailure(failure), false);
  assert.equal(JSON.stringify(failure).includes('private'), false);
});

test('classifies unknown startup failures without serializing their message', () => {
  const failure = classifyCandidateStartupFailure(new Error('private provider or workspace data'));
  assert.deepEqual(failure, { reason: 'internal_startup_failure' });
  assert.equal(JSON.stringify(failure).includes('private'), false);
});
