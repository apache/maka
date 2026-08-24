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
import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { AstryxLocaleProvider, type ComposerHandle, LocaleProvider } from '@maka/ui';
import { ChatComposerRegion } from '../../renderer/chat-composer-region.js';
import {
  markNewTaskReloadIntent,
  UNRESOLVED_NEW_TASK_DRAFT_KEY,
  writeNewTaskReloadDraft,
} from '../../renderer/new-task-reload-intent.js';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  HTMLElement: globalThis.HTMLElement,
  HTMLIFrameElement: globalThis.HTMLIFrameElement,
  Event: globalThis.Event,
  Node: globalThis.Node,
  sessionStorage: globalThis.sessionStorage,
  matchMedia: globalThis.matchMedia,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT,
};

let mountedRoot: Root | undefined;

afterEach(async () => {
  if (mountedRoot) await act(() => mountedRoot?.unmount());
  mountedRoot = undefined;
  Object.assign(globalThis, originalGlobals);
});

/**
 * Mounts the region on a linkedom document and returns its composer handle
 * plus a `render(activeId, newTaskDraftKey)` that re-renders with new props —
 * the two inputs the draft handoff is keyed on.
 */
async function mountRegion(): Promise<{
  composer: { current: ComposerHandle | null };
  render(
    activeId: string | undefined,
    newTaskDraftKey: string,
    newTaskSendPending?: boolean,
  ): Promise<void>;
}> {
  const { document, window } = parseHTML('<div id="root"></div>');
  const storage = new Map<string, string>();
  Object.assign(document, {
    getSelection: () => ({
      removeAllRanges() {},
      addRange() {},
    }),
  });
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    HTMLIFrameElement: window.HTMLIFrameElement ?? class HTMLIFrameElement {},
    Event: window.Event,
    Node: window.Node,
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoot = root;
  const composer = createRef<ComposerHandle>();

  const render = async (
    activeId: string | undefined,
    newTaskDraftKey: string,
    newTaskSendPending = false,
  ) => {
    await act(async () => {
      root.render(
        createElement(
          LocaleProvider,
          {
            locale: 'en',
            children: createElement(AstryxLocaleProvider, {
              children: createElement(ChatComposerRegion, {
              composerRef: composer,
              active: true,
              onboardingComposerHidden: false,
              activeInteraction: undefined,
              activeId,
              newTaskDraftKey,
              newTaskSendPending,
              stopPendingBySession: {},
              respondToSandboxBoundary: () => {},
              activeSandboxBoundary: undefined,
              activeQuestion: undefined,
              respondToUserQuestion: () => {},
              stop: () => {},
              onSend: () => {},
              onStop: () => {},
            }),
            }),
          },
        ),
      );
    });
  };

  return { composer, render };
}

test('hands off only the unresolved new-task draft while a Session is open', async () => {
  const { composer, render } = await mountRegion();
  markNewTaskReloadIntent();
  writeNewTaskReloadDraft(UNRESOLVED_NEW_TASK_DRAFT_KEY, 'new task draft');

  await render('session-1', UNRESOLVED_NEW_TASK_DRAFT_KEY);
  await act(() => composer.current?.setText('session draft'));

  await render('session-1', 'new-task:local:project-1');
  await render(undefined, 'new-task:local:project-1');

  assert.equal(composer.current?.getText(), 'new task draft');
});

test('carries the visible new-task draft when the target Project changes', async () => {
  const { composer, render } = await mountRegion();

  await render(undefined, 'new-task:local:project-1');
  await act(() => composer.current?.setText('draft in flight'));

  await render(undefined, 'new-task:local:project-2');
  assert.equal(composer.current?.getText(), 'draft in flight');

  // …and it keeps following the target rather than leaving copies behind: an
  // edit made under project-2 is what project-1 shows on the way back, not the
  // text that was carried away from it.
  await act(() => composer.current?.setText('draft in flight, edited'));
  await render(undefined, 'new-task:local:project-1');
  assert.equal(composer.current?.getText(), 'draft in flight, edited');
});

test('does not resurrect a sent new-task draft from a target passed through', async () => {
  const { composer, render } = await mountRegion();

  await render(undefined, 'new-task:local:project-1');
  await act(() => composer.current?.setText('sent text'));
  // Out to project-2 and back, so both slots have now held this text.
  await render(undefined, 'new-task:local:project-2');
  await render(undefined, 'new-task:local:project-1');
  // …and the send clears the slot it was submitted from, as Composer does.
  await act(() => composer.current?.clearDraft('new-task:local:project-1'));
  assert.equal(composer.current?.getText(), '');

  await render(undefined, 'new-task:local:project-2');
  assert.equal(composer.current?.getText(), '');
});

test('a send in flight owns its text even if the target changes under it', async () => {
  const { composer, render } = await mountRegion();

  await render(undefined, 'new-task:local:project-1');
  await act(() => composer.current?.setText('submitted text'));

  // The picker stays live while a send settles, so the target can move between
  // `sendCurrent` capturing the key it submitted from and clearing it. Carrying
  // the text out to project-2 here would leave the sent message in the composer
  // ready to be sent a second time, and the completion would clear an empty
  // project-1 instead.
  await render(undefined, 'new-task:local:project-2', true);
  // The composer's own completion: it clears the exact key it submitted from.
  await act(() => composer.current?.clearDraft('new-task:local:project-1'));
  await render(undefined, 'new-task:local:project-2', false);

  assert.equal(composer.current?.getText(), '');
  assert.equal(composer.current?.getDraft('new-task:local:project-1'), '');
  assert.equal(composer.current?.getDraft('new-task:local:project-2'), '');
});

test('a send in flight still hands over text typed after it was submitted', async () => {
  const { composer, render } = await mountRegion();

  await render(undefined, 'new-task:local:project-1');
  await act(() => composer.current?.setText('submitted text'));

  // The next message, begun while the send is still resolving. It is not the
  // submission's to clear, so it follows the target once the send settles.
  await act(() => composer.current?.setText('the next message'));
  await render(undefined, 'new-task:local:project-2', true);
  await render(undefined, 'new-task:local:project-2', false);

  assert.equal(composer.current?.getText(), 'the next message');
});

test('restores a reload draft when its own target is selected later', async () => {
  const { composer, render } = await mountRegion();
  markNewTaskReloadIntent();
  writeNewTaskReloadDraft('new-task:local:project-1', 'draft that survived a reload');

  // Startup settles on a different target than the reload draft belongs to, so
  // that draft stays put rather than being pasted into project-2.
  await render(undefined, UNRESOLVED_NEW_TASK_DRAFT_KEY);
  await render(undefined, 'new-task:local:project-2');
  assert.equal(composer.current?.getText(), '');

  await render(undefined, 'new-task:local:project-1');
  assert.equal(composer.current?.getText(), 'draft that survived a reload');
});

test('leaves a Session draft alone when the new-task target changes behind it', async () => {
  const { composer, render } = await mountRegion();

  await render(undefined, 'new-task:local:project-1');
  await act(() => composer.current?.setText('new task draft'));

  await render('session-1', 'new-task:local:project-1');
  await act(() => composer.current?.setText('session draft'));

  await render('session-1', 'new-task:local:project-2');
  assert.equal(composer.current?.getText(), 'session draft');

  await render(undefined, 'new-task:local:project-2');
  assert.equal(composer.current?.getText(), 'new task draft');
});
