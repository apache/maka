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
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { TurnView } from '../chat-turn.js';
import {
  SessionAttachmentProvider,
  type ReadAttachmentBytes,
} from '../attachment-image.js';
import { LocaleProvider } from '../locale-context.js';
import { MarkdownBody } from '../markdown-body.js';
import type { TurnViewModel } from '../materialize.js';

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

async function renderAttachmentMarkdown(text: string, readBytes: ReadAttachmentBytes) {
  const { container, root } = domRoot();
  await act(async () => {
    root.render(
      <SessionAttachmentProvider sessionId="session-1" readBytes={readBytes}>
        <MarkdownBody text={text} />
      </SessionAttachmentProvider>,
    );
  });
  return container;
}

const TURN_WITH_IMAGE: TurnViewModel = {
  turnId: 'turn-1',
  status: 'completed',
  partialOutputRetained: false,
  user: {
    id: 'ask',
    role: 'user',
    text: 'show this',
    ts: 1,
    attachments: [{
      kind: 'image',
      name: 'preview.png',
      mimeType: 'image/png',
      bytes: 3,
      ref: { kind: 'session_file', sessionId: 'session-1', relativePath: 'attachment-123' },
    }],
  },
  tools: [],
  notes: [],
  startedAt: 1,
  timeline: [],
};

test('loads a user attachment thumbnail through the injected session reader', async () => {
  const { container, root } = domRoot();
  await act(async () => {
    root.render(
      <LocaleProvider locale="en">
        <SessionAttachmentProvider
          sessionId="session-1"
          readBytes={async () => ({
            ok: true,
            base64: 'aW1n',
            mimeType: 'image/png',
          })}
        >
          <TurnView turn={TURN_WITH_IMAGE} />
        </SessionAttachmentProvider>
      </LocaleProvider>,
    );
  });

  const image = container.querySelector('.maka-user-attachment-thumbnail img');
  assert.ok(image);
  assert.equal(image.getAttribute('src'), 'data:image/png;base64,aW1n');
});

test('renders a session attachment referenced by assistant Markdown', async () => {
  let readRef: { sessionId: string; artifactId: string } | undefined;
  const container = await renderAttachmentMarkdown(
    '![preview](maka://runtime/attachments/attachment-123)',
    async (sessionId, artifactId) => {
      readRef = { sessionId, artifactId };
      return { ok: true, base64: 'aW1n', mimeType: 'image/png' };
    },
  );

  const image = container.querySelector('img[alt="preview"]');
  assert.ok(image);
  assert.equal(image.getAttribute('src'), 'data:image/png;base64,aW1n');
  assert.deepEqual(readRef, { sessionId: 'session-1', artifactId: 'attachment-123' });
});

test('keeps an unknown assistant attachment as a named placeholder', async () => {
  const container = await renderAttachmentMarkdown(
    '![missing](maka://runtime/attachments/attachment-missing)',
    async () => ({ ok: false, reason: 'not_found' }),
  );

  assert.equal(container.querySelector('img'), null);
  assert.match(container.textContent, /\[missing\]/);
});

test('keeps a non-image assistant attachment as a named placeholder', async () => {
  const container = await renderAttachmentMarkdown(
    '![document](maka://runtime/attachments/attachment-pdf)',
    async () => ({ ok: true, base64: 'cGRm', mimeType: 'application/pdf' }),
  );

  assert.equal(container.querySelector('img'), null);
  assert.match(container.textContent, /\[document\]/);
});

test('keeps an oversized assistant image out of renderer state', async () => {
  const container = await renderAttachmentMarkdown(
    '![large](maka://runtime/attachments/attachment-large)',
    async () => ({
      ok: true,
      base64: 'a'.repeat(3 * 1024 * 1024),
      mimeType: 'image/png',
    }),
  );

  assert.equal(container.querySelector('img'), null);
  assert.match(container.textContent, /\[large\]/);
});

test('shares one attachment read across repeated Markdown image refs', async () => {
  let reads = 0;
  const container = await renderAttachmentMarkdown(
    [
      '![first](maka://runtime/attachments/attachment-123)',
      '![second](maka://runtime/attachments/attachment-123)',
    ].join('\n\n'),
    async () => {
      reads += 1;
      return { ok: true, base64: 'aW1n', mimeType: 'image/png' };
    },
  );

  assert.equal(container.querySelectorAll('img').length, 2);
  assert.equal(reads, 1);
});

test('renders a restored attachment through the streaming Markdown path', async () => {
  const { container, root } = domRoot();
  const markdown = '![preview](maka://runtime/attachments/attachment-123)';
  await act(async () => {
    root.render(
      <SessionAttachmentProvider
        sessionId="session-1"
        readBytes={async () => ({
          ok: true,
          base64: 'c3RyZWFt',
          mimeType: 'image/png',
        })}
      >
        <MarkdownBody text={markdown} streaming settledText={markdown} />
      </SessionAttachmentProvider>,
    );
  });

  const image = container.querySelector('img[alt="preview"]');
  assert.ok(image);
  assert.equal(image.getAttribute('src'), 'data:image/png;base64,c3RyZWFt');
});
