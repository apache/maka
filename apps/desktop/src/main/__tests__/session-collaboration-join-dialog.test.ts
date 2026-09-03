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
import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from '@maka/ui';
import {
  SessionCollaborationJoinDialog,
  SessionCollaborationServicesProvider,
  type SessionCollaborationServices,
} from '../../renderer/features/session-collaboration/testing.js';

type SessionCollaborationJoinCopy = ComponentProps<
  typeof SessionCollaborationJoinDialog
>['copy'];

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  HTMLElement: globalThis.HTMLElement,
  HTMLIFrameElement: globalThis.HTMLIFrameElement,
  Event: globalThis.Event,
  Node: globalThis.Node,
  CSS: globalThis.CSS,
  getComputedStyle: globalThis.getComputedStyle,
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

test('keeps loading progress visible while an irreversible import settles', async () => {
  let reportProgress: Parameters<SessionCollaborationServices['importInvitation']>[1];
  const services: SessionCollaborationServices = {
    importInvitation: async (_input, onProgress) => {
      reportProgress = onProgress;
      return new Promise(() => undefined);
    },
    cancelImport: async () => 'settling',
    readInvitationClipboard: async () => '',
    listMounts: async () => [],
    removeMount: async () => undefined,
    requestTurn: async () => {
      throw new Error('unused');
    },
    getTurnRequests: async () => ({ canRequestTurns: false, requests: [] }),
    acknowledgeTurnRequest: async () => ({ acknowledged: false }),
    withdrawTurnRequest: async () => ({ withdrawn: false }),
    getPendingTurnRequests: async () => [],
    decideTurnRequest: async () => {
      throw new Error('unused');
    },
    createOperationId: () => 'operation-1',
  };
  const { document } = installDom();
  const container = document.querySelector('#root');
  assert.ok(container);
  mountedRoot = createRoot(container);
  await act(async () => {
    mountedRoot?.render(
      createElement(LocaleProvider, {
        locale: 'en',
        children: createElement(AstryxLocaleProvider, {
          children: createElement(ToastProvider, {
            children: createElement(SessionCollaborationServicesProvider, {
              services,
              children: createElement(SessionCollaborationJoinDialog, {
                copy: testCopy(),
                onImported: assert.fail,
                onClose: assert.fail,
              }),
            }),
          }),
        }),
      }),
    );
    await Promise.resolve();
  });
  await setTextArea(document, 'invitation');
  await clickButton(document, 'join');
  assert.ok(reportProgress);
  await act(async () => reportProgress?.('loading_session'));
  assert.match(document.body.textContent, /loadingSession/u);

  await clickButton(document, 'close');

  assert.match(document.body.textContent, /loadingSession/u);
  assert.doesNotMatch(document.body.textContent, /finalizingAccess/u);
});

test('closes as a retained background recovery instead of reporting a failed join', async () => {
  let imported = 0;
  let closed = 0;
  const services: SessionCollaborationServices = {
    importInvitation: async () => ({ kind: 'recovering', mountId: 'shared-1' }),
    cancelImport: async () => 'settling',
    readInvitationClipboard: async () => '',
    listMounts: async () => [],
    removeMount: async () => undefined,
    requestTurn: async () => {
      throw new Error('unused');
    },
    getTurnRequests: async () => ({ canRequestTurns: false, requests: [] }),
    acknowledgeTurnRequest: async () => ({ acknowledged: false }),
    withdrawTurnRequest: async () => ({ withdrawn: false }),
    getPendingTurnRequests: async () => [],
    decideTurnRequest: async () => {
      throw new Error('unused');
    },
    createOperationId: () => 'operation-1',
  };
  const { document } = installDom();
  const container = document.querySelector('#root');
  assert.ok(container);
  mountedRoot = createRoot(container);
  await act(async () => {
    mountedRoot?.render(
      createElement(LocaleProvider, {
        locale: 'en',
        children: createElement(AstryxLocaleProvider, {
          children: createElement(ToastProvider, {
            children: createElement(SessionCollaborationServicesProvider, {
              services,
              children: createElement(SessionCollaborationJoinDialog, {
                copy: testCopy(),
                onImported: () => {
                  imported += 1;
                },
                onClose: () => {
                  closed += 1;
                },
              }),
            }),
          }),
        }),
      }),
    );
    await Promise.resolve();
  });
  await setTextArea(document, 'invitation');
  await clickButton(document, 'join');

  assert.equal(imported, 1);
  assert.equal(closed, 1);
  assert.doesNotMatch(document.body.textContent, /connectionFailed/u);
});

function installDom(): { document: Document } {
  const parsed = parseHTML('<html><body><div id="root"></div></body></html>');
  const { document, window } = parsed;
  const matchMedia = (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });
  const getComputedStyle = () => ({
    getPropertyValue: () => '',
  }) as unknown as CSSStyleDeclaration;
  Object.assign(window, { matchMedia, getComputedStyle, scrollTo() {} });
  Object.assign(window.HTMLElement.prototype, {
    showModal(this: HTMLElement) {
      this.setAttribute('open', '');
    },
    close(this: HTMLElement) {
      this.removeAttribute('open');
    },
  });
  Object.assign(globalThis, {
    document,
    window,
    matchMedia,
    HTMLElement: window.HTMLElement,
    HTMLIFrameElement: window.HTMLIFrameElement ?? class HTMLIFrameElement {},
    Event: window.Event,
    Node: window.Node,
    CSS: { escape: (value: string) => value },
    getComputedStyle,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  return { document };
}

async function setTextArea(document: Document, value: string): Promise<void> {
  const textArea = document.querySelector('textarea') as HTMLTextAreaElement | null;
  assert.ok(textArea);
  await act(async () => {
    textArea.value = value;
    const propsKey = Object.keys(textArea).find((key) => key.startsWith('__reactProps$'));
    assert.ok(propsKey);
    const props = (textArea as unknown as Record<string, unknown>)[propsKey] as {
      onChange?: (event: { target: HTMLTextAreaElement }) => void;
    };
    assert.ok(props.onChange);
    props.onChange({ target: textArea });
    await Promise.resolve();
  });
}

async function clickButton(document: Document, label: string): Promise<void> {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent === label,
  );
  assert.ok(button, `missing button: ${label}`);
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

function testCopy(): SessionCollaborationJoinCopy {
  return new Proxy({}, {
    get: (_target, property) => String(property),
  }) as SessionCollaborationJoinCopy;
}
