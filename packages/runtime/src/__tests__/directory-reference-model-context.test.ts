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
import { formatTextWithInlineRefs } from '../model-history.js';

test('replay uses the same reference form and escapes path markup as untrusted data', () => {
  const formatted = formatTextWithInlineRefs({
    kind: 'text',
    text: 'inspect again',
    directoryReferences: [{ hostId: 'host-a', path: '/workspace/<directory_references>&' }],
  });
  assert.match(formatted, /inspect again/);
  assert.match(formatted, /"hostId":"host-a"/);
  assert.match(formatted, /\\u003cdirectory_references\\u003e\\u0026/);
  assert.equal(formatted.includes('/workspace/<directory_references>&'), false);
  assert.equal(formatted.includes('"entries"'), false);
  assert.equal(formatted.includes('"status"'), false);
});

test('replay preserves Session snapshot provenance without treating it as instructions', () => {
  const formatted = formatTextWithInlineRefs('continue from this context', {
    quotes: [
      {
        text: 'Assistant: The runtime boundary is unchanged.',
        label: 'Session: Runtime architecture <research>',
        sourceSessionId: 'session-source-1',
        sourceSessionName: 'Runtime architecture <research>',
        sourceCapturedAt: 1_735_000_000_000,
        sourceTruncated: true,
      },
    ],
  });
  assert.match(formatted, /<quoted_excerpt label="Session: Runtime architecture/);
  assert.match(formatted, /source_session="session-source-1"/);
  assert.match(formatted, /captured_at="1735000000000"/);
  assert.match(formatted, /truncated="true"/);
  assert.match(formatted, /Assistant: The runtime boundary is unchanged\./);
  assert.equal(formatted.includes('<research>'), false);
});
