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
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { parseHTML } from 'linkedom';
import { act, createElement, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from '@maka/ui';
import type { ProjectRecord } from '@maka/core/project';
import type { DesktopRuntimeHostRef } from '../../preload/bridge-contract.js';

interface RenderModules {
  RemoteProjectDirectoryDialog: ComponentType<{
    host?: DesktopRuntimeHostRef;
    onClose(): void;
    onRegistered(project: ProjectRecord, host: DesktopRuntimeHostRef): void;
  }>;
  SettingsFixture: ComponentType;
}
let components: RenderModules;
let bundleDirectory: string;
let mountedRoot: Root | undefined;
let frames: FrameRequestCallback[] = [];
const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  HTMLElement: globalThis.HTMLElement,
  HTMLIFrameElement: globalThis.HTMLIFrameElement,
  Node: globalThis.Node,
  Event: globalThis.Event,
  CSS: globalThis.CSS,
  matchMedia: globalThis.matchMedia,
  getComputedStyle: globalThis.getComputedStyle,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT,
};

before(async () => {
  const repoRoot = resolve(import.meta.dirname, '../../../../..');
  bundleDirectory = await mkdtemp(resolve(repoRoot, 'apps/desktop/dist/main/__tests__/project-restore-'));
  const outfile = resolve(bundleDirectory, 'components.mjs');
  await build({
    stdin: {
      contents: `
        import { createElement } from 'react';
        import { ProjectsSettingsPage } from './settings/projects-settings-page';
        import { RuntimeHostSettingsTarget } from './settings/runtime-host-settings-target';
        export { RemoteProjectDirectoryDialog } from './remote-project-directory-dialog';
        export function SettingsFixture() {
          return createElement(RuntimeHostSettingsTarget, {
            host: { profileId: 'remote', hostId: 'host-remote' },
            children: createElement(ProjectsSettingsPage, {
              settings: { projects: {} }, runtimeHostStatus: 'ready', runtimeHostTargetVerified: true,
              onUpdate: async () => {}, onRetryRuntimeHost: async () => {}, onRemoteHostAdded() {},
            }),
          });
        }
      `,
      resolveDir: resolve(repoRoot, 'apps/desktop/src/renderer'),
    },
    outfile, bundle: true, packages: 'external', loader: { '.svg': 'dataurl' },
    platform: 'node', format: 'esm', jsx: 'automatic', target: 'node20', logLevel: 'silent',
    plugins: [{ name: 'omit-unrelated-host-profile-settings', setup(builder) {
      builder.onResolve({ filter: /runtime-host-profiles-section/ }, () => ({ path: 'profiles', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export function RuntimeHostProfilesSection() { return null; }' }));
    } }],
  });
  components = await import(pathToFileURL(outfile).href) as RenderModules;
});
afterEach(async () => {
  try { if (mountedRoot) await act(() => mountedRoot?.unmount()); }
  finally { mountedRoot = undefined; frames = []; Object.assign(globalThis, originalGlobals); }
});
after(async () => { if (bundleDirectory) await rm(bundleDirectory, { recursive: true, force: true }); });

const host = { profileId: 'remote', hostId: 'host-remote' };
const restored: ProjectRecord = { id: 'p', name: 'Project', locations: [], available: true };
const archived: ProjectRecord = { ...restored, archivedAt: 1 };
function bridge(overrides: Record<string, unknown> = {}) {
  Object.assign(window, { maka: {
    projects: {
      getDirectoryRoots: async () => [{ id: 'root', name: 'Root' }],
      listDirectory: async () => [], registerDirectory: async () => archived,
      restore: async () => restored,
      getSnapshot: async () => ({ projects: [], capabilities: { chooseClientDirectory: true } }),
      subscribeChanges: () => () => {},
      ...overrides,
    },
    app: { info: async () => ({}) },
    runtimeHostProfiles: { subscribeChanges: () => () => {} },
  } });
}
async function flushFrames() {
  for (let index = 0; index < 5; index++) {
    const pending = frames.splice(0);
    await act(async () => { for (const callback of pending) callback(0); });
  }
}
async function click(label: string) {
  const button = [...document.querySelectorAll('button')].filter(
    (candidate) => candidate.textContent === label || candidate.getAttribute('aria-label') === label,
  ).at(-1);
  assert.ok(button, `missing button ${label}: ${document.body.textContent}`);
  await act(async () => button.dispatchEvent(new window.Event('click', { bubbles: true })));
  await flushFrames();
}

for (const outcome of ['restore', 'cancel', 'failure', 'normal', 'stale'] as const) {
  test(`remote directory registration: ${outcome}`, async () => {
    const harness = installRenderer();
    const accepted: ProjectRecord[] = [];
    const restores: unknown[][] = [];
    bridge({
      registerDirectory: async () => outcome === 'normal' ? restored : archived,
      restore: async (...args: unknown[]) => {
        restores.push(args);
        if (outcome === 'failure') throw new Error('restore failed');
        return restored;
      },
    });
    const render = (target: DesktopRuntimeHostRef | undefined = host) => harness.render(
      createElement(components.RemoteProjectDirectoryDialog, {
        host: target, onClose() {}, onRegistered(project) { accepted.push(project); },
      }),
    );
    await render();
    await click('Add this folder');
    if (outcome === 'normal') {
      assert.deepEqual(accepted, [restored]);
      assert.equal(restores.length, 0);
      return;
    }
    assert.equal(accepted.length, 0, 'must not accept an archived project before confirmation');
    assert.match(document.body.textContent, /Project archived/);
    if (outcome === 'stale') await render({ profileId: 'another', hostId: 'another-host' });
    if (outcome === 'cancel') {
      const dialog = [...document.querySelectorAll('dialog')].find(el => el.textContent.includes('Project archived'));
      assert.ok(dialog);
      const cancel = [...dialog.querySelectorAll('button')].find(el => el.textContent === 'Cancel');
      assert.ok(cancel);
      await act(async () => cancel.dispatchEvent(new window.Event('click', { bubbles: true })));
      await flushFrames();
    } else await click('Restore');
    if (outcome === 'restore') {
      assert.deepEqual(restores, [['p', host]]);
      assert.deepEqual(accepted, [restored]);
    } else {
      assert.equal(accepted.length, 0);
      assert.equal(restores.length, outcome === 'failure' ? 1 : 0);
      if (outcome === 'failure') assert.ok(document.querySelector('.remoteProjectDirectoryError[role="alert"]'));
      const add = [...document.querySelectorAll('button')].find(el => el.textContent === 'Add this folder');
      assert.ok(add);
      assert.equal(add.hasAttribute('disabled'), false, 'registration can be retried');
    }
  });
}

for (const failure of ['add', 'restore'] as const) {
  test(`Settings reports ${failure} failure and releases Add`, async () => {
    const harness = installRenderer();
    bridge({
      add: async () => {
        if (failure === 'add') throw new Error('add failed');
        return { ok: false, reason: 'archived', projectId: 'p' };
      },
      restore: async () => { throw new Error('restore failed'); },
    });
    await harness.render(createElement(components.SettingsFixture));
    await click('Add project');
    if (failure === 'restore') await click('Restore');
    assert.match(document.body.textContent, /Action failed/);
    const add = [...document.querySelectorAll('button')].find(el => el.textContent === 'Add project');
    assert.ok(add);
    assert.notEqual(add.getAttribute('aria-busy'), 'true');
    assert.equal(add.hasAttribute('disabled'), false);
  });
}
for (const outcome of ['restore', 'cancel', 'refresh-failure'] as const) {
  test(`Settings archived Add: ${outcome}`, async () => {
    const harness = installRenderer();
    let restores = 0;
    let snapshots = 0;
    bridge({
      add: async () => ({ ok: false, reason: 'archived', projectId: 'p' }),
      restore: async () => { restores++; return restored; },
      getSnapshot: async () => {
        snapshots++;
        if (snapshots > 1 && outcome === 'refresh-failure') throw new Error('refresh failed');
        return { projects: [], capabilities: { chooseClientDirectory: true } };
      },
    });
    await harness.render(createElement(components.SettingsFixture));
    await click('Add project');
    assert.equal(restores, 0);
    await click(outcome === 'cancel' ? 'Cancel' : 'Restore');
    assert.equal(restores, outcome === 'cancel' ? 0 : 1);
    assert.ok(snapshots > 1);
    if (outcome === 'refresh-failure') assert.match(document.body.textContent, /Action failed/);
  });
}

function installRenderer() {
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const matchMedia = (media: string) => ({
    matches: false, media, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent: () => false,
  });
  const getComputedStyle = () => ({
    direction: 'ltr', writingMode: 'horizontal-tb', getPropertyValue: () => '',
  }) as unknown as CSSStyleDeclaration;
  Object.assign(window, { matchMedia, getComputedStyle, scrollTo() {} });
  Object.assign(window.HTMLElement.prototype, {
    showModal(this: HTMLElement) { this.setAttribute('open', ''); },
    close(this: HTMLElement) { this.removeAttribute('open'); },
  });
  Object.assign(globalThis, {
    document, window, matchMedia, getComputedStyle,
    HTMLElement: window.HTMLElement,
    HTMLIFrameElement: window.HTMLIFrameElement ?? class HTMLIFrameElement {},
    Event: window.Event, Node: window.Node, CSS: { escape: (value: string) => value },
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; }, cancelAnimationFrame: () => {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.getElementById('root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoot = root;
  return {
    document,
    async render(children: ReactNode) {
      await act(async () => root.render(createElement(LocaleProvider, {
        locale: 'en',
        children: createElement(AstryxLocaleProvider, {
          children: createElement(ToastProvider, {
            children,
          }),
        }),
      })));
    },
  };
}
