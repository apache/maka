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

import { deferred } from '@maka/core/test-only/async-primitives';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { AstryxLocaleProvider, LocaleProvider } from '@maka/ui';
import {
  ArchivedTaskScopeSurface,
  type SessionNavigationRowActions,
  type SessionNavigationSession,
} from '../../renderer/features/session-navigation/testing.js';
import type { ArchivedPurgeRequest } from '../../renderer/features/session-navigation/testing.js';
import { runtimeHostProjectKey } from '../../renderer/application/contracts/runtime-host-project-key.js';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  HTMLElement: globalThis.HTMLElement,
  Event: globalThis.Event,
  Node: globalThis.Node,
  CSS: globalThis.CSS,
  matchMedia: globalThis.matchMedia,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT,
};

let mountedRoot: Root | undefined;

afterEach(async () => {
  if (mountedRoot) await act(() => mountedRoot?.unmount());
  mountedRoot = undefined;
  Object.assign(globalThis, originalGlobals);
});

test('hands the bulk delete exactly the shown ids, and retires it when the scope changes', async () => {
  const harness = installScope();
  await harness.render();
  // Most recently archived first, unknown times last.
  assert.deepEqual(harness.shownIds(), ['alpha-new', 'alpha-old', 'loose']);
  assert.ok(harness.findButton('Clear all'), 'nothing narrowed keeps the whole-list label');

  await harness.search('alpha');
  assert.deepEqual(harness.shownIds(), ['alpha-new', 'alpha-old']);
  await harness.click('Delete 2 shown');

  const [request] = harness.requests;
  assert.ok(request);
  assert.deepEqual(request.sessionIds, ['alpha-new', 'alpha-old']);
  assert.equal(request.narrowed, true);
  // No age filter, so the Host is asked to hold no age.
  assert.equal('requireArchivedForMs' in request, false);
  assert.equal(request.isCurrent(), true);
  assert.equal(harness.findButton('Delete 2 shown')?.disabled, true, 'busy while it runs');

  // A scope change retires the pending confirm: a late preview asks nothing.
  await harness.search('alp');
  assert.equal(request.isCurrent(), false);
  await act(async () => harness.settle());
  assert.equal(harness.findButton('Delete 2 shown')?.disabled, false);
});

test('a pending bulk delete asks nothing once the page is gone', async () => {
  const harness = installScope();
  await harness.render();
  await harness.click('Clear all');
  const [request] = harness.requests;
  assert.ok(request);
  assert.equal(request.narrowed, false);
  assert.equal(request.isCurrent(), true);
  await act(async () => mountedRoot?.unmount());
  mountedRoot = undefined;
  assert.equal(request.isCurrent(), false);
});

function session(id: string, overrides: Partial<SessionNavigationSession>): SessionNavigationSession {
  return {
    id,
    name: id,
    isFlagged: false,
    isArchived: true,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'fake',
    llmConnectionSlug: 'test',
    connectionLocked: true,
    model: 'test',
    permissionMode: 'ask',
    runtimeHostId: 'host-1',
    profileId: 'profile-1',
    profileName: 'This Mac',
    profileKind: 'local',
    ...overrides,
  };
}

function installScope() {
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const matchMedia = () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  });
  Object.assign(window, { matchMedia });
  Object.assign(globalThis, {
    document,
    window,
    matchMedia,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    Node: window.Node,
    CSS: { escape: (value: string) => value },
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoot = root;
  const sessions = [
    session('alpha-old', { projectId: 'alpha', archivedAt: Date.now() - 40 * 86_400_000 }),
    session('alpha-new', { projectId: 'alpha', archivedAt: Date.now() - 86_400_000 }),
    session('loose', {}),
  ];
  const projectScopes = [
    {
      key: runtimeHostProjectKey('host-1', 'alpha'),
      hostId: 'host-1',
      profileName: 'This Mac',
      project: { id: 'alpha', name: 'Alpha project' },
    },
  ];
  const requests: ArchivedPurgeRequest[] = [];
  const pending = deferred<void>();
  const commands = {
    current: {
      purgeArchived: async (request: ArchivedPurgeRequest) => {
        requests.push(request);
        await pending.promise;
      },
    } as unknown as SessionNavigationRowActions,
  };
  const findButton = (label: string) =>
    [...document.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes(label),
    ) as HTMLButtonElement | undefined;
  return {
    requests,
    findButton,
    settle: () => pending.resolve(),
    async render() {
      await act(async () => {
        root.render(
          createElement(LocaleProvider, {
            locale: 'en',
            children: createElement(AstryxLocaleProvider, {
              children: createElement(ArchivedTaskScopeSurface<SessionNavigationSession>, {
                sessions,
                projectScopes,
                commands,
                children: ({ visible, controls }) => [
                  createElement('div', { key: 'controls' }, controls),
                  createElement(
                    'ul',
                    { key: 'shown', 'data-testid': 'shown' },
                    visible.map((row) => createElement('li', { key: row.id, 'data-id': row.id })),
                  ),
                ],
              }),
            }),
          }),
        );
        await Promise.resolve();
      });
    },
    shownIds() {
      return [...document.querySelectorAll('[data-testid="shown"] li')].map((item) =>
        item.getAttribute('data-id'),
      );
    },
    async search(value: string) {
      const input = document.querySelector(
        'input[placeholder="Search archived tasks"]',
      ) as HTMLInputElement | null;
      assert.ok(input, 'missing search box');
      await act(async () => {
        input.value = value;
        const propsKey = Object.keys(input).find((key) => key.startsWith('__reactProps$'));
        assert.ok(propsKey, 'missing React props on input');
        const props = (input as unknown as Record<string, unknown>)[propsKey] as {
          onChange?: (event: { target: HTMLInputElement; defaultPrevented: boolean }) => void;
        };
        assert.ok(props.onChange, 'missing React change handler');
        props.onChange({ target: input, defaultPrevented: false });
        await Promise.resolve();
      });
    },
    async click(label: string) {
      const button = findButton(label);
      assert.ok(button, `missing button: ${label}`);
      await act(async () => {
        button.click();
        await Promise.resolve();
      });
    },
  };
}
