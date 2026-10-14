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
import type { ChatModelChoice } from '@maka/ui';
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from '@maka/ui';
import type { SessionSummary } from '@maka/core/session';
import { WorkHubServicesProvider, type WorkHubServices } from '../../renderer/features/workhub/index.js';
import { WorkHubComposer } from '../../renderer/features/workhub/testing.js';

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

test('the WorkHub composer renders provider marks like regular chat', async () => {
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
    requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const activeSession = {
    id: 'workhub-session', name: 'WorkHub', status: 'active', labels: [], isFlagged: false,
    isArchived: false, hasUnread: false, backend: 'ai-sdk', llmConnectionSlug: 'native',
    connectionLocked: false, model: 'native-model', permissionMode: 'ask',
  } as unknown as SessionSummary;
  const choices: ChatModelChoice[] = [{
    connectionId: 'native', connectionSlug: 'native', connectionName: 'My account',
    providerType: 'openai', providerLabel: 'OpenAI', model: 'native-model', label: 'Native model',
    description: 'Native model description', isDefault: true, thinkingLevels: [],
  }];
  const services = {} as unknown as WorkHubServices;
  mountedRoot = createRoot(document.getElementById('root')!);
  await act(async () => {
    mountedRoot!.render(createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(AstryxLocaleProvider, {
        children: createElement(ToastProvider, {
          children: createElement(WorkHubServicesProvider, { services },
            createElement(WorkHubComposer, {
              sessionId: 'workhub-session',
              onStop: () => undefined,
              onSend: async () => true,
              activeSession,
              modelChoices: choices,
              activeModel: 'native-model',
              activeModelConnectionId: 'native',
              activeModelConnectionSlug: 'native',
              activeProviderType: 'openai',
              onModelChange: () => undefined,
              renderProviderMark: (type: string) => createElement('span', { 'data-provider-mark': type }),
            })),
        }),
      }),
    }));
  });
  const mark = document.querySelector('[data-provider-mark]');
  assert.ok(mark, 'the provider mark must render beside the model switcher');
  assert.equal(mark.getAttribute('data-provider-mark'), 'openai');
});
