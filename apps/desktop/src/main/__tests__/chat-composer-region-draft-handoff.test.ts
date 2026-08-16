import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { AstryxLocaleProvider, type ComposerHandle, LocaleProvider } from '@maka/ui';
import { ChatComposerRegion } from '../../renderer/chat-composer-region.js';
import { UNRESOLVED_NEW_TASK_DRAFT_KEY } from '../../renderer/new-task-reload-intent.js';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  HTMLElement: globalThis.HTMLElement,
  HTMLIFrameElement: globalThis.HTMLIFrameElement,
  Event: globalThis.Event,
  Node: globalThis.Node,
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

test('hands off only the unresolved new-task draft while a Session is open', async () => {
  const { document, window } = parseHTML('<div id="root"></div>');
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

  const render = async (activeId: string | undefined, newTaskDraftKey: string) => {
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

  await render(undefined, UNRESOLVED_NEW_TASK_DRAFT_KEY);
  await act(() => composer.current?.setText('new task draft'));

  await render('session-1', UNRESOLVED_NEW_TASK_DRAFT_KEY);
  await act(() => composer.current?.setText('session draft'));

  await render('session-1', 'new-task:local:project-1');
  await render(undefined, 'new-task:local:project-1');

  assert.equal(composer.current?.getText(), 'new task draft');
});
