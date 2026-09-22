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

/**
 * A user row draws its Skill chips from the text it carries.
 *
 * `inlineReferences` is a frozen rendering hint the Host composes from the
 * invocation receipts, so the optimistic row, the desktop's local copy and any
 * invocation with no successful receipt carry the token as plain text and an
 * empty array. Reading that array as "this message has no tokens" left those
 * rows showing `/skill:writer` while the canonical copy of the same message
 * showed a chip.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { InlineReference } from '@maka/core/events';
import { TurnView } from '../chat-turn.js';
import { LocaleProvider } from '../locale-context.js';
import type { ChatItem, TurnViewModel } from '../materialize.js';
import { installTranscriptDom, type TranscriptDom } from './transcript-test-dom.js';

let dom: TranscriptDom | undefined;

afterEach(async () => {
  await dom?.cleanup();
  dom = undefined;
});

function userTurn(user: ChatItem): TurnViewModel {
  return {
    turnId: 'turn-1',
    status: 'completed',
    user,
    tools: [],
    notes: [],
    startedAt: 1,
    timeline: [],
  };
}

async function renderUserRow(user: ChatItem): Promise<HTMLElement> {
  dom = installTranscriptDom();
  await dom.render(
    <LocaleProvider locale="en">
      <TurnView turn={userTurn(user)} />
    </LocaleProvider>,
  );
  const bubble = dom.container.querySelector('.maka-chat-message-bubble-user');
  assert.ok(bubble, 'the user row rendered no bubble');
  return bubble as unknown as HTMLElement;
}

function chipLabels(bubble: HTMLElement): string[] {
  return [...bubble.querySelectorAll('.astryx-badge')].map(
    (badge) => (badge.textContent ?? '').trim(),
  );
}

const WRITER_FILE: InlineReference = {
  kind: 'workspace_file',
  value: '@notes/writer.md',
  label: 'writer.md',
  start: 5,
};

test('draws a Skill chip from the token when the row carries no references', async () => {
  const bubble = await renderUserRow({
    id: 'ask',
    role: 'user',
    text: 'run /skill:writer on this',
    ts: 1,
    inlineReferences: [],
  });

  assert.deepEqual(chipLabels(bubble), ['writer']);
  assert.ok(
    !(bubble.textContent ?? '').includes('/skill:writer'),
    'the raw token must not survive beside its chip',
  );
  assert.equal(bubble.textContent, 'run writer on this');
});

test('draws the same chip when the row carries no reference field at all', async () => {
  const bubble = await renderUserRow({
    id: 'ask',
    role: 'user',
    text: 'run /skill:writer on this',
    ts: 1,
  });

  assert.deepEqual(chipLabels(bubble), ['writer']);
});

test('prefers the frozen label when the Host composed one', async () => {
  const bubble = await renderUserRow({
    id: 'ask',
    role: 'user',
    text: 'run /skill:writer on this',
    ts: 1,
    inlineReferences: [
      { kind: 'skill', value: '/skill:writer', label: 'Writer', start: 4 },
    ],
  });

  assert.deepEqual(chipLabels(bubble), ['Writer']);
  assert.ok(!(bubble.textContent ?? '').includes('/skill:writer'));
});

test('keeps a file chip and a Skill chip side by side', async () => {
  const bubble = await renderUserRow({
    id: 'ask',
    role: 'user',
    text: 'read @notes/writer.md then /skill:writer',
    ts: 1,
    inlineReferences: [WRITER_FILE],
  });

  assert.deepEqual(chipLabels(bubble), ['writer.md', 'writer']);
  assert.ok(!(bubble.textContent ?? '').includes('/skill:writer'));
  assert.equal(bubble.textContent, 'read writer.md then writer');
});

test('leaves a reference the text no longer holds as text, and still chips the token', async () => {
  const bubble = await renderUserRow({
    id: 'ask',
    role: 'user',
    text: 'read something else then /skill:writer',
    ts: 1,
    inlineReferences: [WRITER_FILE],
  });

  assert.deepEqual(chipLabels(bubble), ['writer']);
  assert.equal(bubble.textContent, 'read something else then writer');
});

test('does not chip a token the grammar rejects at its position', async () => {
  // `a/skill:writer` is a URL-shaped mention the grammar's `(?<=\s)` excludes;
  // drawing chips by token *value* chips it anyway — and when the invocation's
  // receipt failed the wrong chip stayed in the final transcript forever.
  const bubble = await renderUserRow({
    id: 'ask',
    role: 'user',
    text: '参考 a/skill:writer 再调 /skill:writer',
    ts: 1,
    inlineReferences: [],
  });

  assert.deepEqual(chipLabels(bubble), ['writer']);
  assert.equal(bubble.textContent, '参考 a/skill:writer 再调 writer');
});

test('does not chip a token that starts right after a reference span', async () => {
  // The text's own boundary check sees `d/`, not the whitespace the grammar
  // requires — the gap slice's start is not a real `^`.
  const bubble = await renderUserRow({
    id: 'ask',
    role: 'user',
    text: 'read @notes/writer.md/skill:review',
    ts: 1,
    inlineReferences: [WRITER_FILE],
  });

  assert.deepEqual(chipLabels(bubble), ['writer.md']);
  assert.equal(bubble.textContent, 'read writer.md/skill:review');
});

test('chips prefix-related ids at their own positions', async () => {
  // Value-set tokenization let the shorter `review` match inside `reviewer`
  // first, leaving a `review` chip plus a stray `er`.
  const bubble = await renderUserRow({
    id: 'ask',
    role: 'user',
    text: 'run /skill:review and /skill:reviewer',
    ts: 1,
    inlineReferences: [],
  });

  assert.deepEqual(chipLabels(bubble), ['review', 'reviewer']);
  assert.equal(bubble.textContent, 'run review and reviewer');
});
