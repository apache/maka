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
import { act, createElement, type MutableRefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { AttachmentRef } from '@maka/core/events';
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from '@maka/ui';
import { WorkHubServicesProvider, type WorkHubServices } from '../../renderer/features/workhub/index.js';
import { WorkHubComposer } from '../../renderer/features/workhub/testing.js';
import type { RestoredDraftContent } from '../../renderer/application/contracts/transient-message-projection.js';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  HTMLElement: globalThis.HTMLElement,
  Element: globalThis.Element,
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

async function mountComposer() {
  const { document, window } = parseHTML('<div id="root"></div>');
  const getSelection = () => null;
  Object.assign(document, { getSelection });
  Object.assign(window, {
    getSelection,
    getComputedStyle: () =>
      ({ direction: 'ltr', writingMode: 'horizontal-tb', getPropertyValue: () => '' }) as unknown as CSSStyleDeclaration,
    matchMedia: () =>
      ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList,
  });
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Event: window.Event,
    Node: window.Node,
    matchMedia: window.matchMedia,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.querySelector('#root')!);
  mountedRoot = root;
  const uploads: unknown[] = [];
  const sends: Array<{ text: string; attachments: AttachmentRef[] }> = [];
  const draftRestore: MutableRefObject<
    ((sessionId: string, draft: RestoredDraftContent) => void) | undefined
  > = { current: undefined };
  const services = {
    attachments: {},
    prepareAttachments: async (_sessionId: string, items: unknown[]) => {
      uploads.push(...items);
      return [];
    },
  } as unknown as WorkHubServices;
  await act(async () => {
    root.render(createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(AstryxLocaleProvider, {
        children: createElement(ToastProvider, {
          children: createElement(WorkHubServicesProvider, { services },
            createElement(WorkHubComposer, {
              sessionId: 'workhub-session',
              draftRestore,
              onStop: () => undefined,
              onSend: async (text, attachments) => {
                sends.push({ text, attachments });
                return true;
              },
            })),
        }),
      }),
    }));
  });
  return {
    uploads,
    sends,
    async restore(draft: RestoredDraftContent) {
      await act(async () => draftRestore.current!('workhub-session', draft));
    },
    async submit() {
      await act(async () => {
        document.querySelector('form')!.dispatchEvent(
          new window.Event('submit', { bubbles: true, cancelable: true }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
  };
}

test('a retracted edit resends its restored attachment as the same Host reference', async () => {
  const h = await mountComposer();
  const brief: AttachmentRef = {
    kind: 'doc',
    name: 'brief.txt',
    mimeType: 'text/plain',
    bytes: 4,
    ref: { kind: 'workspace_file', relativePath: 'brief.txt' },
  };
  await h.restore({ text: 'redo this with the brief', attachments: [brief] });
  await h.submit();
  assert.deepEqual(h.sends, [{ text: 'redo this with the brief', attachments: [brief] }]);
  assert.deepEqual(h.uploads, [], 'a Host attachment is reused, not uploaded again');
});
