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
import { describe, it } from 'node:test';
import { buildToolOperationId, canonicalToolArgsHash } from '../runtime-commit-sink.js';

describe('RuntimeCommitSink identities', () => {
  it('builds operation identity from the invocation and provider call, never argument text', () => {
    const first = buildToolOperationId({
      invocationId: 'invocation-1',
      providerToolCallId: 'provider-call-1',
    });
    const repeated = buildToolOperationId({
      invocationId: 'invocation-1',
      providerToolCallId: 'provider-call-1',
    });
    const nextCall = buildToolOperationId({
      invocationId: 'invocation-1',
      providerToolCallId: 'provider-call-2',
    });

    assert.equal(first, repeated);
    assert.notEqual(first, nextCall);
    assert.match(first, /^toolop_[a-f0-9]{32}$/);
  });

  it('keeps tuple identity unambiguous when provider strings contain NUL', () => {
    assert.notEqual(
      buildToolOperationId({
        invocationId: 'a\0b',
        providerToolCallId: 'c',
      }),
      buildToolOperationId({
        invocationId: 'a',
        providerToolCallId: 'b\0c',
      }),
    );
  });

  it('hashes stable-json tool identity while preserving semantic argument differences', () => {
    assert.equal(
      canonicalToolArgsHash('Read', { path: '/workspace/a', offset: 1 }),
      canonicalToolArgsHash('Read', { offset: 1, path: '/workspace/a' }),
    );
    assert.notEqual(
      canonicalToolArgsHash('Read', { path: '/workspace/a' }),
      canonicalToolArgsHash('Read', { path: '/workspace/b' }),
    );
    assert.notEqual(
      canonicalToolArgsHash('Read', { path: '/workspace/a' }),
      canonicalToolArgsHash('Write', { path: '/workspace/a' }),
    );
  });
});
