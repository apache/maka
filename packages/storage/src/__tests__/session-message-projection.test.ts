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
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import type { StoredMessage, WorkHubDelegationAssignedMessage } from '@maka/core/session';
import {
  catalogPreviewForUserMessage,
  projectSessionCatalogMessages,
} from '../session-message-projection.js';

test('catalog previews preserve code points at the 95/96/97 boundary without NFC normalization', () => {
  for (const point of ['a', '中', '😀', '\ud800', '\udc00', '\u0000', '\u0301']) {
    for (const length of [95, 96, 97]) {
      const text = point.repeat(length);
      const expected = length <= 96 ? text : point.repeat(95) + '…';
      for (const message of [
        { type: 'user' as const, id: 'u', turnId: 't', ts: 10, text },
        { type: 'assistant' as const, id: 'a', turnId: 't', ts: 10, text, modelId: 'model' },
        coordination(text),
      ]) {
        assert.deepEqual(projectSessionCatalogMessages([message]), {
          lastMessageAt: 10,
          lastMessagePreview: expected,
        });
      }
    }
  }
  for (const [text, expected] of [
    ['  cafe\u0301\t中文\n😀  ', 'cafe\u0301 中文 😀'],
    ['e\u0301'.repeat(48), 'e\u0301'.repeat(48)],
    ['e\u0301'.repeat(48) + 'x', 'e\u0301'.repeat(47) + 'e…'],
    ['x'.repeat(94) + '😀z', 'x'.repeat(94) + '😀z'],
    ['x'.repeat(94) + '😀zy', 'x'.repeat(94) + '😀…'],
  ]) {
    assert.equal(
      catalogPreviewForUserMessage({ type: 'user', id: 'u', turnId: 't', ts: 10, text: text! }),
      expected,
    );
  }
});

test('catalog previews preserve display text and reverse-message fallback ordering', () => {
  const user = { type: 'user' as const, id: 'u', turnId: 't', ts: 10, text: 'hidden original' };
  assert.equal(
    catalogPreviewForUserMessage({ ...user, displayText: '  shown\ntext  ' }),
    'shown text',
  );
  assert.equal(
    catalogPreviewForUserMessage({ ...user, displayText: '😀'.repeat(97) }),
    '😀'.repeat(95) + '…',
  );
  assert.equal(catalogPreviewForUserMessage({ ...user, displayText: ' \t ' }), undefined);
  const messages: StoredMessage[] = [
    { ...user, displayText: 'earlier preview' },
    { type: 'assistant', id: 'a', turnId: 't', ts: 20, text: ' \n ', modelId: 'model' },
    { ...coordination(' \t '), ts: 30 },
  ];
  assert.deepEqual(projectSessionCatalogMessages(messages), {
    lastMessageAt: 30,
    lastMessagePreview: 'earlier preview',
  });
  assert.deepEqual(projectSessionCatalogMessages([...messages, coordination('latest preview')]), {
    lastMessageAt: 10,
    lastMessagePreview: 'latest preview',
  });
  assert.deepEqual(projectSessionCatalogMessages([]), {});
});

test('SQLite append and terminal projection consume at most 97 preview code points', () => {
  // Observe consumed code points in an isolated process: this detects the
  // full-input array regression without depending on heap or timing noise.
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      String.raw`
        import assert from 'node:assert/strict';
        import { mkdtemp, rm } from 'node:fs/promises';
        import { tmpdir } from 'node:os';
        import { join } from 'node:path';
        const { createSessionStore } = await import(process.argv[1]);
        const root = await mkdtemp(join(tmpdir(), 'maka-catalog-preview-prefix-'));
        let store = createSessionStore(root);
        const reads = [];
        try {
          const session = await store.create({ cwd: root, llmConnectionSlug: 'test',
            model: 'test-model', permissionMode: 'ask', name: 'Preview', labels: [] });
          const transcript = [];
          for (const [index, operation] of ['appendMessage', 'commitMessageCatalogProjection'].entries()) {
            const message = { type: 'assistant', id: 'a' + index, turnId: 't' + index,
              ts: 100 + index, modelId: 'test-model', text: ('Section ' + index + ': ' +
                'The implementation details explain the system behavior. '.repeat(5_000))
                .slice(0, 256 * 1_024) };
            const normalized = message.text.replace(/\s+/g, ' ').trim();
            const expected = Array.from(normalized).slice(0, 95).join('') + '…';
            const originalIterator = String.prototype[Symbol.iterator];
            String.prototype[Symbol.iterator] = function* () {
              const iterator = originalIterator.call(this);
              const observed = this === normalized;
              const slot = reads.length;
              if (observed) reads.push(0);
              for (let point = iterator.next(); !point.done; point = iterator.next()) {
                if (observed) reads[slot]++;
                yield point.value;
              }
            };
            try { await store[operation](session.id, message); }
            finally { String.prototype[Symbol.iterator] = originalIterator; }
            if (operation === 'appendMessage') transcript.push(message);
            const record = await store.readCatalogRecord(session.id);
            assert.equal(record.summary.lastMessagePreview, expected);
            assert.equal(record.summary.lastMessageAt, message.ts);
            assert.deepEqual(await store.readMessages(session.id), transcript);
          }
          const latest = await store.readCatalogRecord(session.id);
          await store.commitMessageCatalogProjection(session.id, {
            ...transcript[0], id: 'stale', ts: 1, text: 'Stale preview' });
          await store.commitMessageCatalogProjection(session.id, {
            ...transcript[0], id: 'empty', ts: 200, text: ' \n\t ' });
          const beforeClose = await store.readCatalogRecord(session.id);
          assert.equal(beforeClose.summary.lastMessagePreview, latest.summary.lastMessagePreview);
          assert.equal(beforeClose.summary.lastMessageAt, 200);
          await store.close();
          store = createSessionStore(root);
          assert.deepEqual(await store.readCatalogRecord(session.id), beforeClose);
          assert.deepEqual(await store.readMessages(session.id), transcript);
        } finally {
          await store.close();
          await rm(root, { recursive: true, force: true });
        }
        console.log('SQLite preview, canonical transcript and reopen semantics passed');
        assert.equal(reads.length, 2, 'both public storage paths must exercise the observer');
        assert.ok(reads.every(count => count <= 97),
          'catalog preview consumed more than 97 code points: ' + reads.join(', '));
      `,
      new URL('../session-store.js', import.meta.url).href,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr + child.stdout);
});

function coordination(userText: string): WorkHubDelegationAssignedMessage {
  return {
    type: 'workhub_coordination',
    kind: 'delegation_assigned',
    id: 'coordination',
    turnId: 't',
    ts: 10,
    schemaVersion: 1,
    actionId: 'action',
    actionFingerprint: `sha256:${'a'.repeat(64)}`,
    coordinationTurnId: 't',
    targetSessionId: 'target',
    disposition: 'delegate_existing',
    userText,
    delegationId: 'delegation',
    targetTurnId: 'target-turn',
    targetMessageId: 'target-message',
    targetSessionName: 'Target',
  };
}
