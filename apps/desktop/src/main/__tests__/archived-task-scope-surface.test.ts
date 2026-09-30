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
import type { SessionSummary } from '@maka/core/session';
import type { SessionRemovePreviewResult } from '@maka/runtime-host/protocol';
import { AstryxLocaleProvider, LocaleProvider } from '@maka/ui';
import {
  ArchivedTaskCleanupServicesProvider,
  ArchivedTaskScopeSurface,
} from '../../renderer/features/archived-task-cleanup/index.js';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  HTMLElement: globalThis.HTMLElement,
  HTMLIFrameElement: globalThis.HTMLIFrameElement,
  Event: globalThis.Event,
  Node: globalThis.Node,
  CSS: globalThis.CSS,
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

const PREVIEW: SessionRemovePreviewResult = {
  archivableSubtaskCount: 1,
  removedSubtaskCount: 2,
  worktreeCount: 1,
  bytes: 2048,
};

test('deletes exactly the shown tasks the confirm previewed', async () => {
  const answer = deferred<SessionRemovePreviewResult>();
  const harness = installSurface((ids) => {
    harness.previewed.push([...ids]);
    return answer.promise;
  });
  await harness.render();
  assert.deepEqual(harness.shownIds(), ['alpha-old', 'alpha-new', 'loose']);
  assert.ok(harness.findButton('Clear all'), 'nothing narrowed keeps the whole-list label');

  await harness.search('alpha');
  assert.deepEqual(harness.shownIds(), ['alpha-old', 'alpha-new']);
  await harness.click('Delete 2 shown');

  assert.deepEqual(harness.previewed, [['alpha-old', 'alpha-new']]);
  assert.match(harness.dialogText(), /Delete the 2 tasks shown\?/);
  assert.match(harness.dialogText(), /Working out what else will be removed/);
  // The action shows as busy until the preview arrives, and deletes nothing.
  assert.equal(harness.dialogAction()?.disabled, true);
  await act(async () => harness.dialogAction()?.click());
  assert.deepEqual(harness.purged, [], 'no delete before the preview arrives');

  // The list widening under the open dialog does not widen the delete.
  await harness.search('');
  assert.deepEqual(harness.shownIds(), ['alpha-old', 'alpha-new', 'loose']);
  await act(async () => answer.resolve(PREVIEW));
  assert.equal(harness.dialogAction()?.disabled, false);
  assert.match(harness.dialogText(), /Also deleted: 2 child tasks and 1 subagent worktree\./);
  assert.match(harness.dialogText(), /About 2\.0 KB of task data \(an estimate\)\./);
  assert.match(harness.dialogText(), /1 ordinary subtask is kept and moved to Archived\./);

  await harness.click('Delete permanently');
  assert.deepEqual(harness.purged, [['alpha-old', 'alpha-new']]);
  assert.equal(harness.dialogText(), '', 'the confirm closes once the delete starts');
});

test('a failed preview still names the count and lets the reader cancel or delete', async () => {
  const harness = installSurface(async () => {
    throw new Error('Runtime Host unavailable');
  });
  await harness.render();
  await harness.click('Clear all');
  assert.match(harness.dialogText(), /Clear all 3 archived tasks\?/);
  assert.match(harness.dialogText(), /Could not work out what else will be removed\./);
  assert.doesNotMatch(harness.dialogText(), /child task|of task data/);

  await harness.click('Cancel');
  assert.equal(harness.dialogText(), '');
  assert.deepEqual(harness.purged, []);

  await harness.click('Clear all');
  await harness.click('Delete permanently');
  assert.deepEqual(harness.purged, [['alpha-old', 'alpha-new', 'loose']]);
});

function row(id: string, overrides: Partial<SessionSummary>): SessionSummary {
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
    ...overrides,
  };
}

function installSurface(
  previewRemovals: (sessionIds: readonly string[]) => Promise<SessionRemovePreviewResult>,
) {
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
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
  Object.assign(window, { matchMedia, scrollTo() {} });
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
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoot = root;
  const rows = [
    row('alpha-old', { projectId: 'alpha', archivedAt: Date.now() - 40 * 86_400_000 }),
    row('alpha-new', { projectId: 'alpha', archivedAt: Date.now() - 86_400_000 }),
    row('loose', {}),
  ];
  const projectOf = (session: SessionSummary) =>
    session.projectId ? { key: session.projectId, label: 'Alpha project' } : null;
  const previewed: string[][] = [];
  const purged: string[][] = [];
  const findButton = (label: string) =>
    [...document.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === label,
    ) as HTMLButtonElement | undefined;
  return {
    previewed,
    purged,
    findButton,
    async render() {
      await act(async () => {
        root.render(
          createElement(LocaleProvider, {
            locale: 'en',
            children: createElement(AstryxLocaleProvider, {
              children: createElement(ArchivedTaskCleanupServicesProvider, {
                services: { previewRemovals },
                children: createElement(ArchivedTaskScopeSurface<SessionSummary>, {
                  rows,
                  projectOf,
                  onPurge: async (ids) => {
                    purged.push([...ids]);
                  },
                  children: ({ visible }) =>
                    createElement(
                      'ul',
                      { 'data-testid': 'shown' },
                      visible.map((session) =>
                        createElement('li', { key: session.id, 'data-id': session.id }),
                      ),
                    ),
                }),
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
    dialogAction() {
      return [...document.querySelectorAll('[role="alertdialog"] button')].find((button) =>
        button.textContent?.includes('Delete permanently'),
      ) as HTMLButtonElement | undefined;
    },
    dialogText() {
      return [...document.querySelectorAll('[role="alertdialog"]')]
        .map((dialog) => dialog.textContent ?? '')
        .join('');
    },
    async search(value: string) {
      const input = document.querySelector('input[placeholder="Search archived tasks"]') as
        | HTMLInputElement
        | null;
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
