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
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { ChatModelChoice } from '@maka/core/chat-model-choice';
import { LocaleProvider } from '@maka/ui';
import { NEW_TASK_PENDING_KEY } from '../../renderer/pending-items.js';
import { getDesktopConversationCopy } from '../../renderer/locales/conversation-copy.js';
import {
  useComposerAttachments,
  type ComposerAttachmentService,
} from '../../renderer/use-composer-attachments.js';
import { useAppShellComposerQuotes } from '../../renderer/use-app-shell-composer-quotes.js';
import {
  composerModelSupportsVision,
  type NewChatModel,
} from '../../renderer/shell-chat-model-selection.js';

/**
 * #3408 for what the composer STAGES. The draft text is covered by
 * `chat-composer-region-draft-handoff.test.ts`.
 *
 * Staged files and quotes bucket by the composer's staging key, which AppShell
 * derives as `activeId ?? NEW_TASK_PENDING_KEY`. Two owners, both stable: a
 * Session, or the one new-task bucket. What is pinned here is that nothing
 * moves a bucket out from under an operation that is still running against it.
 */

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  HTMLElement: globalThis.HTMLElement,
  Event: globalThis.Event,
  Node: globalThis.Node,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT,
};

let mountedRoot: Root | undefined;

afterEach(async () => {
  if (mountedRoot) await act(() => mountedRoot?.unmount());
  mountedRoot = undefined;
  Object.assign(globalThis, originalGlobals);
});

async function mountProbe<T>(useHook: (options: { draftKey: string }) => T): Promise<{
  latest(): T;
  render(draftKey: string, locale?: 'en' | 'zh-CN'): Promise<void>;
}> {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoot = root;

  let latest: T | undefined;
  function Probe(props: { draftKey: string }) {
    latest = useHook(props);
    return null;
  }

  const render = async (draftKey: string, locale: 'en' | 'zh-CN' = 'en') => {
    await act(async () => {
      root.render(
        createElement(LocaleProvider, {
          locale,
          children: createElement(Probe, { draftKey }),
        }),
      );
    });
  };

  return {
    latest: () => {
      assert.ok(latest);
      return latest;
    },
    render,
  };
}

type PickedFile = {
  approvalId: string;
  name: string;
  mimeType: string;
  size: number;
};

const idleAttachmentService: ComposerAttachmentService = {
  pickFiles: async () => ({ ok: false, reason: 'cancelled' }),
  previewApproval: async () => ({ ok: false, reason: 'not used' }),
};

function stubFilePicker(): {
  service: ComposerAttachmentService;
  resolve(files: PickedFile[]): void;
} {
  let release: (files: PickedFile[]) => void = () => {};
  const chosen = new Promise<{ ok: true; files: PickedFile[] }>((resolveChosen) => {
    release = (files) => resolveChosen({ ok: true, files });
  });
  return {
    service: {
      pickFiles: () => chosen,
      previewApproval: async () => ({ ok: false, reason: 'not used' }),
    },
    resolve: release,
  };
}

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fileWithBytes(name: string, type: string, bytes: ArrayLike<number>): File {
  return new File([Uint8Array.from(bytes)], name, { type });
}

function textFile(name: string): File {
  // Bytes that match no signature, so content sniffing leaves the declared
  // text type in place rather than downgrading it.
  return fileWithBytes(name, 'text/plain', new TextEncoder().encode('plain notes'));
}

/** A blob whose leading-byte read rejects, exercising the `sniffFileMimeType`
 * catch: the declared image/PDF type must be downgraded, not reinstated. */
function unreadableFile(name: string, type: string): File {
  return {
    name,
    type,
    size: 32,
    slice: () => ({ arrayBuffer: () => Promise.reject(new Error('slice read failed')) }),
  } as unknown as File;
}

/** A blob whose leading-byte read is held open, so a test can switch the active
 * draft while `fileToPending` is mid-sniff — the window this PR's async made
 * real. Bytes are PNG so it stages as an image once the read resolves. */
function deferredImageFile(name: string): { file: File; resolveRead(): void } {
  let release: () => void = () => {};
  const arrayBuffer = () =>
    new Promise<ArrayBuffer>((resolve) => {
      release = () => resolve(new Uint8Array(PNG_MAGIC).buffer);
    });
  const file = {
    name,
    type: 'image/png',
    size: PNG_MAGIC.length,
    slice: () => ({ arrayBuffer }),
  } as unknown as File;
  return { file, resolveRead: () => release() };
}

function modelChoice(model: string, supportsVision: boolean): ChatModelChoice {
  return {
    connectionId: 'connection-test',
    connectionSlug: 'test',
    providerType: 'openai-compatible',
    providerLabel: 'Test',
    model,
    label: model,
    isDefault: model === 'text-model',
    thinkingLevels: [],
    supportsVision,
  };
}

test('a Session keeps its own staged quotes, and the new-task bucket keeps its own', async () => {
  const probe = await mountProbe(useAppShellComposerQuotes);

  await probe.render(NEW_TASK_PENDING_KEY);
  await act(() => probe.latest().addQuote({ text: 'quoted for a new task' }));

  await probe.render('session-1');
  assert.equal(probe.latest().pendingQuotes.length, 0);
  await act(() => probe.latest().addQuote({ text: 'quoted for the Session' }));
  assert.deepEqual(
    probe.latest().pendingQuotes.map((quote) => quote.text),
    ['quoted for the Session'],
  );

  await probe.render(NEW_TASK_PENDING_KEY);
  assert.deepEqual(
    probe.latest().pendingQuotes.map((quote) => quote.text),
    ['quoted for a new task'],
  );
});

test('a completing send clears the attachments it submitted', async () => {
  const probe = await mountProbe((options) =>
    useComposerAttachments({
      ...options,
      toastApi: { error() {} },
      service: idleAttachmentService,
    }),
  );

  await probe.render(NEW_TASK_PENDING_KEY);
  await act(() => probe.latest().attachFilePaths([textFile('notes.txt')]));
  const submitted = probe.latest().pendingAttachments;
  assert.equal(submitted.length, 1);

  // AppShell reads `pendingAttachments`, awaits the send, and only then calls
  // this — through the callback it captured before awaiting. The staging key
  // has to be the same one on both sides of that await, or the send leaves what
  // it already delivered staged in the composer, ready to be sent again.
  const clearAfterSend = probe.latest().clearSubmittedAttachments;
  await probe.render(NEW_TASK_PENDING_KEY);
  await act(() => clearAfterSend(submitted));

  assert.equal(probe.latest().pendingAttachments.length, 0);
});

test('AppShell composition shows the localized non-vision image notice once per task', async () => {
  const calls: Array<{ title: string; description?: string }> = [];
  let nextModel: NewChatModel | undefined = {
    llmConnectionId: 'connection-test',
    llmConnectionSlug: 'test',
    model: 'text-model',
  };
  const choices = [modelChoice('text-model', false), modelChoice('vision-model', true)];
  const probe = await mountProbe((options) =>
    useComposerAttachments({
      ...options,
      toastApi: { error() {} },
      imageNotice: {
        notify(title, description) {
          calls.push({ title, ...(description === undefined ? {} : { description }) });
        },
        supportsVision: () => composerModelSupportsVision({
          active: undefined,
          next: nextModel,
          choices,
        }),
      },
      service: idleAttachmentService,
    }),
  );
  const image = fileWithBytes('chart.png', 'image/png', PNG_MAGIC);

  await probe.render('session-en', 'en');
  await act(() => probe.latest().attachFilePaths([image]));
  await act(() => probe.latest().attachFilePaths([image]));
  assert.equal(probe.latest().pendingAttachments.length, 2);
  const en = getDesktopConversationCopy('en').actions;
  assert.deepEqual(calls, [{
    title: en.imageAttachmentNotDirectTitle,
    description: en.imageAttachmentNotDirectDescription,
  }]);

  await probe.render('session-zh', 'zh-CN');
  await act(() => probe.latest().attachFilePaths([image]));
  const zh = getDesktopConversationCopy('zh-CN').actions;
  assert.deepEqual(calls[1], {
    title: zh.imageAttachmentNotDirectTitle,
    description: zh.imageAttachmentNotDirectDescription,
  });

  probe.latest().imageNoticeLifecycle.transfer('session-zh', 'session-transferred');
  await probe.render('session-transferred', 'zh-CN');
  await act(() => probe.latest().attachFilePaths([image]));
  assert.equal(calls.length, 2);

  nextModel = undefined;
  await probe.render('session-no-target');
  await act(() => probe.latest().attachFilePaths([image]));
  nextModel = {
    llmConnectionId: 'connection-test',
    llmConnectionSlug: 'test',
    model: 'vision-model',
  };
  await probe.render('session-vision');
  await act(() => probe.latest().attachFilePaths([image]));
  assert.equal(calls.length, 2);

  nextModel = {
    llmConnectionId: 'connection-test',
    llmConnectionSlug: 'test',
    model: 'text-model',
  };
  await probe.render('session-reset');
  await act(() => probe.latest().attachFilePaths([image]));
  probe.latest().imageNoticeLifecycle.reset('session-reset');
  await act(() => probe.latest().attachFilePaths([image]));
  assert.equal(calls.length, 4);
});

test('retracted queue attachments can be restored and submitted without re-ingest', async () => {
  const probe = await mountProbe((options) =>
    useComposerAttachments({
      ...options,
      toastApi: { error() {} },
      service: idleAttachmentService,
    }),
  );

  await probe.render('session-1');
  await act(() =>
    probe.latest().restoreAttachments('session-1', [
      {
        kind: 'other',
        name: 'notes.txt',
        mimeType: 'text/plain',
        bytes: 5,
        ref: {
          kind: 'session_file',
          sessionId: 'session-1',
          relativePath: 'attachments/notes.txt',
        },
      },
    ]),
  );

  assert.equal(probe.latest().pendingAttachments[0]?.source.type, 'retained');
});

test('files chosen in the native dialog land in the composer now on screen', async () => {
  const picker = stubFilePicker();
  const probe = await mountProbe((options) =>
    useComposerAttachments({
      ...options,
      toastApi: { error() {} },
      service: picker.service,
    }),
  );
  await probe.render(NEW_TASK_PENDING_KEY);

  const picking = probe.latest().pickAttachments();
  // The dialog is modal to its own window, not to the app: the surface behind
  // it can change before the user finishes choosing.
  await probe.render('session-1');
  await act(async () => {
    picker.resolve([
      { approvalId: 'approval-1', name: 'chosen.txt', mimeType: 'text/plain', size: 9 },
    ]);
    await picking;
  });

  assert.deepEqual(
    probe.latest().pendingAttachments.map((item) => item.displayName),
    ['chosen.txt'],
  );
});

test('files dropped while a session switch is mid-sniff land in the composer now on screen', async () => {
  const probe = await mountProbe((options) =>
    useComposerAttachments({
      ...options,
      toastApi: { error() {} },
      service: idleAttachmentService,
    }),
  );
  await probe.render(NEW_TASK_PENDING_KEY);

  // fileToPending reads the leading bytes before staging; that read is async,
  // so the surface can change before it resolves. The file must land where the
  // user is looking now, not in the bucket bound before the read started.
  const dropped = deferredImageFile('photo.png');
  const attaching = probe.latest().attachFilePaths([dropped.file]);
  await probe.render('session-1');
  await act(async () => {
    dropped.resolveRead();
    await attaching;
  });

  assert.deepEqual(
    probe.latest().pendingAttachments.map((item) => item.displayName),
    ['photo.png'],
  );
});

test('dropped files stage by content: a real image named .pdf notices, a disguised .png does not', async () => {
  const calls: Array<{ title: string }> = [];
  const probe = await mountProbe((options) =>
    useComposerAttachments({
      ...options,
      toastApi: { error() {} },
      imageNotice: {
        notify(title) {
          calls.push({ title });
        },
        // No selected target that supports vision, so a staged image notices.
        supportsVision: () => false,
      },
      service: idleAttachmentService,
    }),
  );
  await probe.render('session-1');

  // A real image behind a `.pdf` name stages as an image — thumbnail path and
  // the non-vision notice both key off the sniffed kind, not the extension.
  await act(() =>
    probe.latest().attachFilePaths([fileWithBytes('report.pdf', 'application/pdf', PNG_MAGIC)]),
  );
  assert.equal(probe.latest().pendingAttachments.at(-1)?.kind, 'image');
  assert.equal(calls.length, 1);

  // A non-image behind a `.png` name and an `image/png` claim does neither: the
  // unverified claim is downgraded rather than trusted.
  await act(() =>
    probe.latest().attachFilePaths([
      fileWithBytes('photo.png', 'image/png', new TextEncoder().encode('not an image')),
    ]),
  );
  assert.equal(probe.latest().pendingAttachments.at(-1)?.kind, 'other');
  assert.equal(calls.length, 1);
});

test('a failed leading-byte read downgrades the declared image claim rather than trusting it', async () => {
  const calls: Array<{ title: string }> = [];
  const probe = await mountProbe((options) =>
    useComposerAttachments({
      ...options,
      toastApi: { error() {} },
      imageNotice: {
        notify(title) {
          calls.push({ title });
        },
        supportsVision: () => false,
      },
      service: idleAttachmentService,
    }),
  );
  await probe.render('session-1');

  // `slice().arrayBuffer()` rejects: the catch must route an empty prefix
  // through the downgrade, so an `image/png` claim it could not verify stages
  // as an ordinary file and never fires the vision notice.
  await act(() =>
    probe.latest().attachFilePaths([unreadableFile('screenshot.png', 'image/png')]),
  );
  assert.equal(probe.latest().pendingAttachments.at(-1)?.kind, 'other');
  assert.equal(probe.latest().pendingAttachments.at(-1)?.mimeType, 'application/octet-stream');
  assert.equal(calls.length, 0);
});
