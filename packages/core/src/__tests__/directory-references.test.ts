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
  aggregateMessageContents,
  decodeMessageContent,
  isDirectoryReference,
  messageContentDigest,
  messageContentsEqual,
  normalizeMessageContent,
} from '../events.js';
import { decodeCanonicalMessage } from '../session.js';
import { decodeRuntimeEvent } from '../runtime-event.js';

const reference = { hostId: 'host-a', path: '/workspace/source' };

test('directory references require a Host and an absolute path with a closed shape', () => {
  for (const path of ['/workspace/source', 'C:\\projects\\source', '\\\\server\\share\\source']) {
    assert.equal(isDirectoryReference({ ...reference, path }), true, path);
  }
  for (const invalid of [
    { path: reference.path },
    { ...reference, hostId: '' },
    { ...reference, hostId: '../host' },
    { ...reference, path: 'relative/path' },
    { ...reference, path: '/path\0name' },
    { ...reference, path: '/' + 'x'.repeat(4096) },
    { ...reference, access: 'write' },
  ]) {
    assert.equal(isDirectoryReference(invalid), false);
    assert.throws(() => decodeMessageContent({ text: 'inspect', directoryReferences: [invalid] }));
  }
});

test('directory references are cloned and remain part of durable message identity', () => {
  const source = { text: 'inspect', directoryReferences: [{ ...reference }] };
  const normalized = normalizeMessageContent(source);
  const same = decodeMessageContent(JSON.parse(JSON.stringify(source)));
  assert.equal(messageContentsEqual(normalized, same), true);
  assert.equal(messageContentDigest(normalized), messageContentDigest(same));
  for (const other of [
    { ...reference, hostId: 'host-b' },
    { ...reference, path: '/workspace/other' },
  ]) {
    const changed = { ...source, directoryReferences: [other] };
    assert.equal(messageContentsEqual(normalized, changed), false);
    assert.notEqual(messageContentDigest(normalized), messageContentDigest(changed));
  }
  source.directoryReferences[0]!.path = '/changed';
  assert.deepEqual(normalized.directoryReferences, [reference]);
  assert.deepEqual(normalizeMessageContent({ text: 'plain', directoryReferences: [] }), {
    text: 'plain',
  });
  assert.equal(
    messageContentsEqual({ text: 'plain' }, { text: 'plain', directoryReferences: [] }),
    true,
  );
});

test('directory references survive queue aggregation, StoredMessage and RuntimeEvent decoding', () => {
  const content = aggregateMessageContents([
    { text: 'model context', displayText: 'inspect', directoryReferences: [reference] },
    { text: 'also inspect', directoryReferences: [{ ...reference, path: '/workspace/second' }] },
  ]);
  assert.equal(content.displayText, 'inspect\n\nalso inspect');
  assert.deepEqual(content.directoryReferences, [
    reference,
    { ...reference, path: '/workspace/second' },
  ]);
  const stored = decodeCanonicalMessage({
    type: 'user',
    id: 'message-1',
    turnId: 'turn-1',
    ts: 1,
    ...content,
  });
  assert.equal(stored.type, 'user');
  if (stored.type !== 'user') throw new Error('Expected user message');
  assert.deepEqual(stored.directoryReferences, content.directoryReferences);
  const event = decodeRuntimeEvent({
    id: 'event-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', ...content },
  });
  assert.equal(event.content?.kind, 'text');
  if (event.content?.kind !== 'text') throw new Error('Expected text event');
  assert.deepEqual(event.content.directoryReferences, content.directoryReferences);
});
