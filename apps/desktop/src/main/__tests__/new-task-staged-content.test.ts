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
import { LocaleProvider } from '@maka/ui';
import { NEW_TASK_PENDING_KEY } from '../../renderer/app-shell-pending-attachments.js';
import { useAppShellComposerAttachments } from '../../renderer/use-app-shell-composer-attachments.js';
import { useAppShellComposerQuotes } from '../../renderer/use-app-shell-composer-quotes.js';

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
  render(draftKey: string): Promise<void>;
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

  const render = async (draftKey: string) => {
    await act(async () => {
      root.render(
        createElement(LocaleProvider, {
          locale: 'en',
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

function stubFilePicker(): {
  resolve(files: { approvalId: string; name: string; mimeType: string; size: number }[]): void;
} {
  let release: (files: never[]) => void = () => {};
  const chosen = new Promise<{ ok: true; files: unknown[] }>((resolveChosen) => {
    release = (files) => resolveChosen({ ok: true, files });
  });
  Object.assign(globalThis.window as unknown as Record<string, unknown>, {
    maka: { attachments: { pickFiles: () => chosen } },
  });
  return { resolve: (files) => release(files as never[]) };
}

function textFile(name: string): File {
  return { name, type: 'text/plain', size: 12 } as unknown as File;
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
    useAppShellComposerAttachments({ ...options, toastApi: { error() {} } }),
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

test('files chosen in the native dialog land in the composer now on screen', async () => {
  const probe = await mountProbe((options) =>
    useAppShellComposerAttachments({ ...options, toastApi: { error() {} } }),
  );
  await probe.render(NEW_TASK_PENDING_KEY);
  const picker = stubFilePicker();

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
