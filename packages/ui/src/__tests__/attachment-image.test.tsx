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
      <LocaleProvider locale="en">
        <SessionAttachmentProvider sessionId="session-1" readBytes={readBytes}>
        <MarkdownBody text={text} />
      </SessionAttachmentProvider>
      </LocaleProvider>,
    );
  });
  return { container, root };
}

const TURN_WITH_IMAGE: TurnViewModel = {
  turnId: 'turn-1',
  status: 'completed',
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

test('renders a user thumbnail admitted by the shared preview policy', async () => {
  const { container, root } = domRoot();
  await act(async () => {
    root.render(
      <LocaleProvider locale="en">
        <SessionAttachmentProvider
          sessionId="session-1"
          readBytes={async () => ({ ok: true, base64: 'aW1n', mimeType: 'image/png' })}
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

test('rejects an oversized user thumbnail before reading it', async () => {
  const { container, root } = domRoot();
  let reads = 0;
  await act(async () => {
    root.render(
      <LocaleProvider locale="en">
        <SessionAttachmentProvider
          sessionId="session-1"
          readBytes={async () => {
            reads += 1;
            return { ok: false, reason: 'not_found' };
          }}
        >
          <TurnView
            turn={{
              ...TURN_WITH_IMAGE,
              user: {
                ...TURN_WITH_IMAGE.user!,
                attachments: [{ ...TURN_WITH_IMAGE.user!.attachments![0]!, bytes: 3 * 1024 * 1024 }],
              },
            }}
          />
        </SessionAttachmentProvider>
      </LocaleProvider>,
    );
  });

  assert.equal(container.querySelector('.maka-user-attachment-thumbnail img'), null);
  assert.equal(reads, 0);
});

test('renders a session attachment referenced by assistant Markdown', async () => {
  let readRef: { sessionId: string; artifactId: string } | undefined;
  const { container } = await renderAttachmentMarkdown(
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

test('explains unreadable assistant attachments and offers retry', async () => {
  const cases: Array<[string, ReadAttachmentBytes]> = [
    ['missing', async () => ({ ok: false, reason: 'not_found' })],
    ['document', async () => ({ ok: true, base64: 'cGRm', mimeType: 'application/pdf' })],
  ];
  for (const [name, readBytes] of cases) {
    const { container } = await renderAttachmentMarkdown(
      `![${name}](maka://runtime/attachments/attachment-${name})`,
      readBytes,
    );
    assert.equal(container.querySelector('img'), null);
    assert.ok(container.textContent.includes(name));
    assert.ok(container.textContent.includes("Could not load the image"));
    assert.equal(container.querySelector("button")?.textContent, "Retry");
  }
});

test('shares one attachment read across repeated Markdown image refs', async () => {
  let reads = 0;
  const { container } = await renderAttachmentMarkdown(
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

test('retries an attachment image after a transient read failure', async () => {
  const markdown = '![preview](maka://runtime/attachments/attachment-123)';
  let reads = 0;
  const readBytes: ReadAttachmentBytes = async () => {
    reads += 1;
    return reads === 1
      ? { ok: false, reason: 'read_failed' }
      : { ok: true, base64: 'cmVjb3ZlcmVk', mimeType: 'image/png' };
  };
  const { container } = await renderAttachmentMarkdown(markdown, readBytes);
  assert.equal(container.querySelector('img'), null);
  await act(async () => {
    container.querySelector('button')!.click();
  });

  const image = container.querySelector('img[alt="preview"]');
  assert.ok(image);
  assert.equal(image.getAttribute('src'), 'data:image/png;base64,cmVjb3ZlcmVk');
  assert.equal(reads, 2);
});

test('renders an attachment when a streaming Markdown image becomes complete', async () => {
  const { container, root } = domRoot();
  const markdown = '![preview](maka://runtime/attachments/attachment-123)';
  const readBytes: ReadAttachmentBytes = async () => ({
    ok: true,
    base64: 'c3RyZWFt',
    mimeType: 'image/png',
  });
  await act(async () => {
    root.render(
      <LocaleProvider locale="en">
        <SessionAttachmentProvider sessionId="session-1" readBytes={readBytes}>
        <MarkdownBody
          text="![preview](maka://runtime/attachments/attachment-"
          streaming
          settledText=""
        />
      </SessionAttachmentProvider>
      </LocaleProvider>,
    );
  });
  assert.equal(container.querySelector('img'), null);

  await act(async () => {
    root.render(
      <LocaleProvider locale="en">
        <SessionAttachmentProvider sessionId="session-1" readBytes={readBytes}>
        <MarkdownBody text={markdown} streaming settledText={markdown} />
      </SessionAttachmentProvider>
      </LocaleProvider>,
    );
  });

  const image = container.querySelector('img[alt="preview"]');
  assert.ok(image);
  assert.equal(image.getAttribute('src'), 'data:image/png;base64,c3RyZWFt');
});

test('saved large images show an original-file action instead of an unsaved or failed preview', async () => {
  const { container, root } = domRoot();
  const opened: string[] = [];
  await act(async () => {
    root.render(<LocaleProvider locale="en"><SessionAttachmentProvider sessionId="session-1"
      readBytes={async () => ({ ok: false, reason: 'too_large' })}
      openSavedImage={async (sessionId, artifactId) => { opened.push(`${sessionId}/${artifactId}`); return { ok: true }; }}>
      <MarkdownBody text="![large](maka://runtime/attachments/large-image)" />
    </SessionAttachmentProvider></LocaleProvider>);
  });
  assert.match(container.textContent ?? '', /Image saved.*preview size limit/);
  assert.doesNotMatch(container.textContent ?? '', /not saved|loading failed/i);
  assert.equal(container.querySelector('img'), null);
  const button = Array.from(container.querySelectorAll('button')).find(node => node.textContent?.includes('Open saved image'));
  assert.ok(button);
  await act(async () => button.click());
  assert.deepEqual(opened, ['session-1/large-image']);
});

test('message reception status clears only when the image is durably ready', async () => {
  const { ImageDeliveryProvider, ImageMessageProvider } = await import('../image-delivery.js');
  const { container, root } = domRoot();
  let finish!: (result: { status: 'ready'; artifactId: string }) => void;
  await act(async () => {
    root.render(<LocaleProvider locale="en"><SessionAttachmentProvider sessionId="session-1"
      readBytes={async () => ({ ok: true, mimeType: 'image/png', base64: 'c2F2ZWQ=' })}>
      <ImageDeliveryProvider sessionId="session-1" resolve={() => new Promise(resolve => { finish = resolve; })}>
        <ImageMessageProvider identity={{ turnId: 'turn-1', messageId: 'message-1' }}>
          <MarkdownBody text={"Text has finished.\n\n![image](/tmp/image.png)"} />
        </ImageMessageProvider>
      </ImageDeliveryProvider>
    </SessionAttachmentProvider></LocaleProvider>);
  });
  assert.match(container.textContent ?? '', /Text has finished/);
  assert.ok(container.querySelector('[data-maka-image-reception="receiving"]'), container.innerHTML);
  await act(async () => finish({ status: 'ready', artifactId: 'received-image' }));
  assert.equal(container.querySelector('[data-maka-image-reception]'), null);
  assert.ok(container.querySelector('img'));
});

test('duplicate references retain reception status when one instance unmounts', async () => {
  const { ImageMessageProvider, useImageReceptionStatus } = await import('../image-delivery.js');
  const { container, root } = domRoot();
  function ImageState({ state }: { state: 'receiving' | 'saved' }) {
    useImageReceptionStatus('/same.png', state);
    return null;
  }
  const render = (duplicate: boolean, messageId = 'one') => root.render(
    <LocaleProvider locale="en"><ImageMessageProvider identity={{ turnId: 'turn', messageId }}>
      <ImageState key="pending" state="receiving" />
      {duplicate && <ImageState key="saved" state="saved" />}
    </ImageMessageProvider></LocaleProvider>,
  );
  await act(() => render(true));
  assert.ok(container.querySelector('[data-maka-image-reception="receiving"]'));
  await act(() => render(false));
  assert.ok(container.querySelector('[data-maka-image-reception="receiving"]'));
  await act(() => render(false, 'two'));
  assert.ok(container.querySelector('[data-maka-image-reception="receiving"]'));
});
