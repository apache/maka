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
import type { StoredMessage } from '../session.js';
import { createSessionSnapshot, sessionSnapshotToQuote } from '../session-reference.js';

function user(id: string, text: string, ts = 1): StoredMessage {
  return { type: 'user', id, turnId: `turn-${id}`, ts, text };
}

function assistant(id: string, text: string, ts = 2): StoredMessage {
  return { type: 'assistant', id, turnId: `turn-${id}`, ts, text, modelId: 'model' };
}

test('creates a recent, redacted snapshot and excludes non-conversation messages', () => {
  const snapshot = createSessionSnapshot(
    [
      user('old-user', 'old context'),
      assistant('old-assistant', 'old answer'),
      {
        type: 'tool_call',
        id: 'tool-call',
        turnId: 'turn-tool',
        ts: 3,
        toolName: 'Bash',
        args: { command: 'cat secret.txt' },
      },
      {
        type: 'system_note',
        id: 'system-note',
        ts: 4,
        kind: 'error',
        data: { secret: 'do-not-share' },
      },
      user('new-user', 'new question', 5),
      assistant('new-assistant', 'new answer', 6),
    ],
    {
      sessionId: 'session-source',
      sessionName: 'Runtime research',
      capturedAt: 123,
      maxChars: 10_000,
    },
  );

  assert.deepEqual(
    snapshot.items.map((item) => item.role),
    ['user', 'assistant', 'user', 'assistant'],
  );
  assert.match(snapshot.text, /new question/);
  assert.match(snapshot.text, /new answer/);
  assert.doesNotMatch(snapshot.text, /secret/);
  assert.equal(snapshot.truncated, false);
  assert.equal(snapshot.reference.sessionId, 'session-source');
  assert.equal(snapshot.reference.sessionName, 'Runtime research');
  assert.equal(snapshot.reference.capturedAt, 123);
});

test('bounds a snapshot from the newest content and preserves truncation provenance', () => {
  const snapshot = createSessionSnapshot(
    [
      user('first', 'first message'),
      assistant('second', 'second message'),
      user('last', 'latest message'),
    ],
    {
      sessionId: 'session-source',
      sessionName: 'Long session',
      capturedAt: 456,
      maxChars: 24,
    },
  );

  assert.equal(snapshot.truncated, true);
  assert.ok(snapshot.text.length <= 24);
  assert.match(snapshot.text, /latest/);
  assert.equal(sessionSnapshotToQuote(snapshot).sourceSessionId, 'session-source');
  assert.equal(sessionSnapshotToQuote(snapshot).sourceSessionName, 'Long session');
  assert.equal(sessionSnapshotToQuote(snapshot).sourceCapturedAt, 456);
  assert.equal(sessionSnapshotToQuote(snapshot).sourceTruncated, true);
});

test('accounts for the role prefix when truncating a single item', () => {
  const snapshot = createSessionSnapshot([user('last', 'latest message')], {
    sessionId: 'session-source',
    sessionName: 'Short budget',
    maxChars: 10,
  });

  assert.equal(snapshot.items[0]?.text, 'late');
  assert.equal(snapshot.text, 'User: late');
  assert.ok(snapshot.text.length <= 10);
  assert.doesNotMatch(snapshot.text, /User: User/);
});

test('does not emit a partial role prefix when no content fits', () => {
  const snapshot = createSessionSnapshot([user('last', 'latest message')], {
    sessionId: 'session-source',
    sessionName: 'Tiny budget',
    maxChars: 5,
  });

  assert.deepEqual(snapshot.items, []);
  assert.equal(snapshot.text, '');
  assert.equal(snapshot.truncated, true);
});

test('does not split an emoji when truncating the first item', () => {
  const snapshot = createSessionSnapshot([user('last', 'a😀b')], {
    sessionId: 'session-source',
    sessionName: 'Unicode boundary',
    maxChars: 8,
  });

  assert.equal(snapshot.text, 'User: a');
  assert.equal(snapshot.items[0]?.text, 'a');
  assert.equal([...snapshot.text].join(''), snapshot.text);
});

test('does not emit a partial role prefix when an emoji cannot fit', () => {
  const snapshot = createSessionSnapshot([user('last', '😀')], {
    sessionId: 'session-source',
    sessionName: 'Joined boundary',
    maxChars: 7,
  });

  assert.equal(snapshot.text, '');
  assert.deepEqual(snapshot.items, []);
  assert.equal([...snapshot.text].join(''), snapshot.text);
});
