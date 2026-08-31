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
  render(draftKey: string, locale?: 'en' | 'zh'): Promise<void>;
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

  const render = async (draftKey: string, locale: 'en' | 'zh' = 'en') => {
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

function textFile(name: string): File {
  return { name, type: 'text/plain', size: 12 } as unknown as File;
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
  const image = { name: 'chart.png', type: 'image/png', size: 12 } as unknown as File;

  await probe.render('session-en', 'en');
  await act(() => probe.latest().attachFilePaths([image]));
  await act(() => probe.latest().attachFilePaths([image]));
  assert.equal(probe.latest().pendingAttachments.length, 2);
  const en = getDesktopConversationCopy('en').actions;
  assert.deepEqual(calls, [{
    title: en.imageAttachmentNotDirectTitle,
    description: en.imageAttachmentNotDirectDescription,
  }]);

  await probe.render('session-zh', 'zh');
  await act(() => probe.latest().attachFilePaths([image]));
  const zh = getDesktopConversationCopy('zh').actions;
  assert.deepEqual(calls[1], {
    title: zh.imageAttachmentNotDirectTitle,
    description: zh.imageAttachmentNotDirectDescription,
  });

  probe.latest().imageNoticeLifecycle.transfer('session-zh', 'session-transferred');
  await probe.render('session-transferred', 'zh');
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
