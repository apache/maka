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
import {
  isSessionMediaInput,
  isSessionContentPart,
  sessionContentMarkdown,
  SESSION_MEDIA_MAX_BASE64,
} from '../session-media.js';

test('media transport bounds binary input and only publishes durable image references', () => {
  assert.ok(isSessionMediaInput({ kind: 'inline', mimeType: 'image/png', base64: 'AAAA' }));
  for (const base64 of ['not base64', 'AA', 'AAAA=', 'A'.repeat(SESSION_MEDIA_MAX_BASE64 + 4)])
    assert.equal(isSessionMediaInput({ kind: 'inline', mimeType: 'image/png', base64 }), false);
  assert.equal(
    isSessionMediaInput({ kind: 'source', source: '/tmp/image.svg', extra: true }),
    false,
  );
  assert.equal(isSessionMediaInput({ kind: 'source', source: '/tmp/\0image.svg' }), false);
  const part = {
    kind: 'image' as const,
    mimeType: 'image/svg+xml',
    ref: { kind: 'session_file' as const, sessionId: 'session', relativePath: 'image-1' },
  };
  assert.ok(isSessionContentPart(part));
  assert.equal(sessionContentMarkdown(part), '\n\n![](maka://runtime/attachments/image-1)\n\n');
  assert.equal(
    isSessionContentPart({ ...part, ref: { ...part.ref, relativePath: '../other' } }),
    false,
  );
});

test('ordered media survives canonical tool-result validation without allowing nested payloads', async () => {
  const { decodeCanonicalToolResultContent } = await import('../tool-result-record-schema.js');
  const content = {
    kind: 'content',
    parts: [
      { kind: 'text', text: 'before' },
      {
        kind: 'image',
        mimeType: 'image/svg+xml',
        ref: { kind: 'session_file', sessionId: 'session', relativePath: 'image-1' },
      },
    ],
  };
  assert.deepEqual(decodeCanonicalToolResultContent(content), content);
  assert.throws(() => decodeCanonicalToolResultContent({ kind: 'content', parts: [content] }));
  assert.throws(() =>
    decodeCanonicalToolResultContent({
      kind: 'content',
      parts: Array.from({ length: 65 }, () => ({ kind: 'text', text: 'a' })),
    }),
  );
});
