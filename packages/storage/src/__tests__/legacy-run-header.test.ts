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
import { describe, test } from 'node:test';
import {
  decodePersistedLegacyRunHeader,
  invocationOpeningFromLegacyRunHeader,
  type LegacyRunHeader,
} from '../legacy-run-header.js';

describe('legacy Run header decoding', () => {
  test('rejects a header with multiple hosted root authorities', () => {
    assert.throws(
      () =>
        decodePersistedLegacyRunHeader({
          ...runHeader(),
          scheduledTaskId: 'scheduled-task-1',
          goalId: 'goal-1',
        }),
      /Invalid AgentRun header schema/,
    );
  });

  test('folds every retired persisted value', () => {
    const decoded = decodePersistedLegacyRunHeader({
      ...runHeader(),
      status: 'waiting_permission',
      permissionMode: 'execute',
      automationId: 'automation-1',
    });
    assert.equal(decoded.status, 'waiting_for_user');
    assert.equal(decoded.permissionMode, 'ask');
    assert.equal(decoded.legacyAutomationId, 'automation-1');
    assert.equal(Object.hasOwn(decoded, 'automationId'), false);
  });

  test('accepts both bound and legacy connection identity', () => {
    assert.equal(decodePersistedLegacyRunHeader(runHeader()).llmConnectionId, undefined);
    const bound = decodePersistedLegacyRunHeader({
      ...runHeader(),
      llmConnectionId: '11111111-1111-4111-8111-111111111111',
    });
    assert.equal(bound.llmConnectionId, '11111111-1111-4111-8111-111111111111');
    assert.throws(
      () => decodePersistedLegacyRunHeader({ ...runHeader(), llmConnectionId: '' }),
      /Invalid AgentRun header schema/,
    );
  });

  test('projects an unbound connection as an unauthenticated route', () => {
    const opening = invocationOpeningFromLegacyRunHeader(
      decodePersistedLegacyRunHeader(runHeader()),
    );
    assert.equal(opening.route.provenance, 'unknown');
    assert.equal(opening.source.kind, 'fresh');
  });
});

describe('legacy continuation source decoding', () => {
  test('rejects a V2 replay manifest that does not identify its boundary', () => {
    assert.throws(
      () =>
        decodePersistedLegacyRunHeader(
          headerWithContinuation({
            ...validV2ContinuationSource(),
            replayManifestDigest: `sha256:${'c'.repeat(64)}`,
          }),
        ),
      /Invalid AgentRun header schema/,
    );
  });

  test('projects a V2 source onto the opening fact', () => {
    const header = decodePersistedLegacyRunHeader(
      headerWithContinuation(validV2ContinuationSource()),
    );
    const source = invocationOpeningFromLegacyRunHeader(header).source;
    assert.equal(source.kind, 'continuation');
    if (source.kind !== 'continuation') throw new Error('unreachable');
    assert.equal(source.claimId, 'claim-1');
    assert.equal(source.sourceRunId, 'source-run');
  });
});

function runHeader(): Record<string, unknown> {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    status: 'created',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/workspace',
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 1,
  };
}

function headerWithContinuation(
  continuationSource: LegacyRunHeader['continuationSource'],
): Record<string, unknown> {
  return {
    ...runHeader(),
    runId: 'target-run',
    invocationId: 'target-invocation',
    turnId: 'target-turn',
    continuationSource,
  };
}

function validV2ContinuationSource(): Extract<
  NonNullable<LegacyRunHeader['continuationSource']>,
  { protocol: 'continuation_source_v2' }
> {
  return {
    protocol: 'continuation_source_v2',
    claimId: 'claim-1',
    boundaryDigest: `sha256:${'a'.repeat(64)}`,
    sourceInvocationId: 'source-invocation',
    sourceRunId: 'source-run',
    sourceTurnId: 'source-turn',
    sourceRuntimeEventHighWater: 1,
    sourcePrefixDigest: `sha256:${'b'.repeat(64)}`,
    replayManifestDigest: `sha256:${'a'.repeat(64)}`,
  };
}
