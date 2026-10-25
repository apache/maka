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
import { test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { AstryxLocaleProvider, LocaleProvider } from '@maka/ui';
import { TurnView } from '@maka/ui/testing';
import { deferred } from '@maka/core/test-only/async-primitives';
import {
  BranchWorktreeRoot,
  ComposerSubmissionServicesProvider,
} from '../../renderer/features/conversation/testing.js';
import { windowSubmissionServices } from './app-shell-chat-actions-fixture.js';

test('fork menu capability follows the displayed session and ignores stale workspace queries', async () => {
  const keys = ['document', 'window', 'HTMLElement', 'HTMLIFrameElement', 'Event', 'Node', 'CSS',
    'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'];
  const original = Object.fromEntries(keys.map((key) => [key, Reflect.get(globalThis, key)]));
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const matchMedia = (media: string) => ({
    matches: false, media, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  });
  Object.assign(window, { matchMedia, scrollTo() {} });
  Object.assign(window.HTMLElement.prototype, {
    showModal(this: HTMLElement) { this.setAttribute('open', ''); },
    close(this: HTMLElement) { this.removeAttribute('open'); },
  });
  Object.assign(globalThis, {
    document, window, matchMedia, HTMLElement: window.HTMLElement,
    HTMLIFrameElement: window.HTMLIFrameElement ?? class {}, Event: window.Event, Node: window.Node,
    CSS: { escape: (value: string) => value },
    requestAnimationFrame: () => 0, cancelAnimationFrame() {}, IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.querySelector('#root')!);
  const queries = new Map<string, ReturnType<typeof deferred<{ path: string; canCreate: boolean }>>>();
  const services = {
    ...windowSubmissionServices(),
    readBranchWorkspace: (sessionId: string) => {
      const query = deferred<{ path: string; canCreate: boolean }>();
      queries.set(sessionId, query);
      return query.promise;
    },
  };
  async function render(sessionId: string, sessionRevision = 0) {
    await act(async () => {
      root.render(createElement(ComposerSubmissionServicesProvider, {
        services,
        children: createElement(LocaleProvider, { locale: 'zh-CN', children:
          createElement(AstryxLocaleProvider, { children:
            createElement(BranchWorktreeRoot, { sessionId, sessionRevision, children: createElement(TurnView, {
              turn: {
                turnId: 'turn', status: 'completed', startedAt: 1, tools: [], notes: [],
                user: { id: 'user', role: 'user', text: 'Hello', ts: 1 },
                timeline: [{ kind: 'text', messageId: 'reply', text: 'Hi' }],
              },
              footerActions: [{ id: 'branch', label: '分叉', enabled: true }],
            }) }),
          }),
        }),
      }));
    });
  }
  const hasMenu = () => !!document.querySelector('button[data-action="branch"][aria-haspopup="menu"]');
  try {
    await render('pending-session');
    await act(async () => { queries.get('pending-session')!.reject(new Error('Session does not exist')); });
    assert.equal(hasMenu(), false);
    await render('pending-session', 1);
    await act(async () => { queries.get('pending-session')!.resolve({ path: '/repo', canCreate: true }); });
    assert.equal(hasMenu(), true, 'Host admission must refresh capability for the same session id');
    await render('pending-session', 2);
    const stale = queries.get('pending-session')!;
    await render('pending-session', 3);
    await act(async () => { queries.get('pending-session')!.resolve({ path: '/directory', canCreate: false }); });
    await act(async () => { stale.resolve({ path: '/repo', canCreate: true }); });
    assert.equal(hasMenu(), false, 'An older revision must not overwrite the latest capability');
    await render('git-session');
    await act(async () => { queries.get('git-session')!.resolve({ path: '/repo', canCreate: true }); });
    assert.equal(hasMenu(), true);
    assert.equal(document.querySelector('dialog'), null);
    await render('slow-session');
    assert.equal(hasMenu(), false, 'The old session must not supply the new session’s capability');
    await render('directory-session');
    await act(async () => { queries.get('directory-session')!.resolve({ path: '/directory', canCreate: false }); });
    assert.equal(hasMenu(), false);
    await act(async () => { queries.get('slow-session')!.resolve({ path: '/repo', canCreate: true }); });
    assert.equal(hasMenu(), false, 'A stale query must not re-enable worktree creation');
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, original);
  }
});
