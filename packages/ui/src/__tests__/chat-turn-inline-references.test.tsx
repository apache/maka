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
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { InlineReference } from '@maka/core/events';
import { TurnView } from '../chat-turn.js';
import { LocaleProvider } from '../locale-context.js';
import type { ChatItem, TurnViewModel } from '../materialize.js';

const originalGlobals = {
  document: globalThis.document,
  matchMedia: globalThis.matchMedia,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  window: globalThis.window,
};
const originalActEnvironment = (globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
}).IS_REACT_ACT_ENVIRONMENT;

const mountedRoots: ReturnType<typeof createRoot>[] = [];

afterEach(async () => {
  for (const root of mountedRoots.splice(0)) await act(() => root.unmount());
  Object.assign(globalThis, {
    ...originalGlobals,
    IS_REACT_ACT_ENVIRONMENT: originalActEnvironment,
  });
});

function domRoot() {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, {
    document,
    window,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  return { container, root };
}

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
  const { container, root } = domRoot();
  await act(() =>
    root.render(
      <LocaleProvider locale="en">
        <TurnView turn={userTurn(user)} />
      </LocaleProvider>,
    ),
  );
  const bubble = container.querySelector('.maka-chat-message-bubble-user');
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
