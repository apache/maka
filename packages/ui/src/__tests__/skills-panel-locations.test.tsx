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
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { LocaleProvider } from '../locale-context.js';
import type { SkillLocation, SkillLocationRef } from '../module-panel-types.js';
import { SkillsModuleMain } from '../skills-panel.js';
import { ToastProvider } from '../toast.js';

const originalGlobals = {
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  document: globalThis.document,
  matchMedia: globalThis.matchMedia,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  window: globalThis.window,
};
const originalActEnvironment = (globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
}).IS_REACT_ACT_ENVIRONMENT;
const mountedRoots: ReturnType<typeof createRoot>[] = [];

afterEach(async () => {
  for (const root of mountedRoots.splice(0)) await act(() => root.unmount());
  Object.assign(globalThis, {
    ...originalGlobals,
    IS_REACT_ACT_ENVIRONMENT: originalActEnvironment,
  });
});

const locations: SkillLocation[] = [
  { ref: 'project:maka', scope: 'project', source: 'maka', path: '/repo/.maka/skills', status: 'missing', skillCount: 0 },
  { ref: 'project:agents', scope: 'project', source: 'agents', path: '/repo/.agents/skills', status: 'available', skillCount: 2 },
  { ref: 'workspace:legacy', scope: 'workspace', source: 'legacy', path: '/workspace/skills', status: 'read_failed', skillCount: 0 },
  { ref: 'user:maka', scope: 'user', source: 'maka', path: '/home/user/.maka/skills', status: 'blocked_path', skillCount: 0 },
  { ref: 'user:agents', scope: 'user', source: 'agents', path: '/home/user/.agents/skills', status: 'available', skillCount: 1 },
];

test('Skill locations close the menu before opening and create only a missing directory', async () => {
  const { document, window } = parseHTML('<div id="root"></div>');
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  async function flushFrames(): Promise<void> {
    await act(async () => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
      await Promise.resolve();
    });
  }
  window.getComputedStyle = () => ({
    direction: 'ltr',
    writingMode: 'horizontal-tb',
    getPropertyValue: () => '',
  }) as unknown as CSSStyleDeclaration;
  Object.assign(globalThis, {
    document,
    window,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  const opened: Array<{ ref: SkillLocationRef; createIfMissing: boolean }> = [];
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(() => {
    root.render(
      <LocaleProvider locale="en">
        <ToastProvider>
          <SkillsModuleMain
            skillLocations={locations}
            onOpenSkillLocation={(ref, createIfMissing) => {
              opened.push({ ref, createIfMissing });
            }}
          />
        </ToastProvider>
      </LocaleProvider>,
    );
  });

  await clickByLabel(document, window, 'More Skill actions');
  await clickMenuItem(document, window, 'Skill locations…');

  const markup = document.documentElement.innerHTML;
  for (const location of locations) assert.ok(markup.includes(location.path));
  assert.ok(markup.includes('Create and open'));
  assert.ok(markup.includes('2 Skills'));
  assert.match(menuItem(document, 'Workspace compatibility folder').outerHTML, /aria-disabled="true"/);
  assert.match(menuItem(document, 'User · Maka').outerHTML, /aria-disabled="true"/);

  await clickMenuItem(document, window, 'Project · Maka');
  assert.deepEqual(opened, []);
  assert.equal(document.querySelector('[aria-label="More Skill actions"]')?.getAttribute('aria-expanded'), 'false');
  await flushFrames();
  assert.deepEqual(opened, [{ ref: 'project:maka', createIfMissing: true }]);

  await clickByLabel(document, window, 'More Skill actions');
  await clickMenuItem(document, window, 'Skill locations…');
  await clickMenuItem(document, window, 'Project · Agents');
  assert.equal(opened.length, 1);
  assert.equal(document.querySelector('[aria-label="More Skill actions"]')?.getAttribute('aria-expanded'), 'false');
  await flushFrames();
  assert.deepEqual(opened, [
    { ref: 'project:maka', createIfMissing: true },
    { ref: 'project:agents', createIfMissing: false },
  ]);
});

async function clickByLabel(
  document: Document,
  window: ReturnType<typeof parseHTML>['window'],
  label: string,
): Promise<void> {
  const element = document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  assert.ok(element, `missing ${label}`);
  await act(async () => {
    element.dispatchEvent(new window.Event('click', { bubbles: true }));
    await Promise.resolve();
  });
}

async function clickMenuItem(
  document: Document,
  window: ReturnType<typeof parseHTML>['window'],
  label: string,
): Promise<void> {
  const element = menuItem(document, label);
  await act(async () => {
    element.dispatchEvent(new window.Event('click', { bubbles: true }));
    await Promise.resolve();
  });
}

function menuItem(document: Document, label: string): HTMLElement {
  const element = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    .find((candidate) => candidate.textContent?.includes(label));
  assert.ok(element, `missing menu item ${label}`);
  return element;
}
