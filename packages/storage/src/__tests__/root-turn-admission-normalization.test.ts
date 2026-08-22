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
import { test } from 'node:test';
import { normalizeRootTurnAdmissionPayload } from '../agent-run-store.js';

test('root admission preserves an explicit empty inline-reference marker from its sources', () => {
  const content = { text: 'plain', inlineReferences: [] } as const;
  const normalized = normalizeRootTurnAdmissionPayload(content, [
    {
      messageId: 'message-1',
      content,
      placement: 'next_turn',
      disposition: 'followup',
    },
  ]);

  assert.deepEqual(normalized.normalizedInput, content);
  assert.deepEqual(normalized.sourceMessages[0]?.content, content);
});

test('root admission preserves and validates each source submission digest', () => {
  const digest = `sha256:${'a'.repeat(64)}` as const;
  const source = {
    messageId: 'message-1',
    content: { text: 'prepared', displayText: 'submitted' },
    submittedContentDigest: digest,
    placement: 'next_turn' as const,
    disposition: 'followup' as const,
  };
  const normalized = normalizeRootTurnAdmissionPayload(source.content, [source]);

  assert.equal(normalized.sourceMessages[0]?.submittedContentDigest, digest);
  assert.throws(() =>
    normalizeRootTurnAdmissionPayload(source.content, [
      { ...source, submittedContentDigest: 'sha256:not-a-digest' },
    ]),
  );
});
