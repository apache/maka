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
import { AstryxLocaleProvider, LocaleProvider, ToastProvider, useToast } from '@maka/ui';
import type { ProjectRecord } from '@maka/core/project';
import type { DesktopRuntimeHostRef } from '../../preload/bridge-contract.js';
import type { TaskEntryServices } from '../../renderer/features/task-entry/testing.js';

interface RenderModules {
  RemoteProjectDirectoryDialog: ComponentType<{
    host?: DesktopRuntimeHostRef;
    onClose(): void;
    onRegistered(project: ProjectRecord, host: DesktopRuntimeHostRef): void;
  }>;
  SettingsFixture: ComponentType<{ host?: DesktopRuntimeHostRef; verified?: boolean }>;
  SessionRecoveryFixture: ComponentType<{ sessionId?: string }>;
  TaskEntryServicesProvider: ComponentType<{ services: TaskEntryServices; children: ReactNode }>;
  createFakeTaskEntryServices(): TaskEntryServices;
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
        import { createElement, Fragment } from 'react';
        import { WorkspacePicker } from '@maka/ui';
        import { TaskEntryRoot, TaskEntryWorkspacePickerConsumer } from './features/task-entry';
        import { ProjectsSettingsPage } from './settings/projects-settings-page';
        import { RuntimeHostSettingsTarget } from './settings/runtime-host-settings-target';
        export { RemoteProjectDirectoryDialog } from './remote-project-directory-dialog';
        export { TaskEntryServicesProvider } from './features/task-entry';
        export { createFakeTaskEntryServices } from './features/task-entry/testing';
        export function SessionRecoveryFixture({ sessionId }) {
          return createElement(TaskEntryRoot, { children: ({ commands }) => createElement(Fragment, null,
            createElement('button', { onClick: () => commands.openSessionWorkspaceRecovery(sessionId) }, 'Repair workspace'),
            createElement(TaskEntryWorkspacePickerConsumer, {
              manageProjects() {},
              activeSession: sessionId ? { id: sessionId, profileId: 'local', runtimeHostId: 'host-local', projectId: null, profileKind: 'local' } : undefined,
              children: (workspacePicker) => createElement(WorkspacePicker, { workspacePicker }),
            }),
          ) });
        }
        export function SettingsFixture({ host = { profileId: 'remote', hostId: 'host-remote' }, verified = true }) {
          return createElement(RuntimeHostSettingsTarget, {
            host,
            children: createElement(ProjectsSettingsPage, {
              settings: { projects: {} }, runtimeHostStatus: 'ready', runtimeHostTargetVerified: verified,
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
  const button = [...document.querySelectorAll('button, [role="menuitem"]')].filter(
    (candidate) => candidate.textContent === label || candidate.getAttribute('aria-label') === label,
  ).at(-1);
  assert.ok(button, `missing button ${label}: ${document.body.textContent}`);
  await act(async () => button.dispatchEvent(new window.Event('click', { bubbles: true })));
  await flushFrames();
}

async function submitNamedProject(repetitions = 1) {
  await click('New project');
  await submitProjectName(repetitions);
}

async function submitProjectName(repetitions = 1) {
  const input = document.querySelector('input');
  assert.ok(input);
  await act(async () => {
    input.value = 'Project';
    const propsKey = Object.keys(input).find((key) => key.startsWith('__reactProps$'));
    assert.ok(propsKey);
    const props = (input as unknown as Record<string, unknown>)[propsKey] as {
      onChange: (event: { target: HTMLInputElement; defaultPrevented: boolean }) => void;
    };
    props.onChange({ target: input, defaultPrevented: false });
  });
  const form = document.querySelector('#maka-new-project-form');
  assert.ok(form);
  await act(async () => {
    for (let index = 0; index < repetitions; index++) {
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    }
  });
  await flushFrames();
}

// Request routing belongs here; native modal input blocking is checked in Chromium,
// not by rerendering the fixture or dispatching clicks behind an open dialog.
for (const action of ['submit', 'cancel'] as const) {
  test(`Session naming dialog ${action} routes only the accepted recovery`, async () => {
    const harness = installRenderer();
    const calls: string[] = [];
    harness.services.catalog.getCatalog = async () => ({
      defaultProfileId: 'local',
      hosts: [{
        profile: { id: 'local', name: 'Local', kind: 'local' },
        hostId: 'host-local', readiness: 'ready', state: 'available',
        projects: [], selectedProjectId: null,
        capabilities: { chooseClientDirectory: true, chooseHostDirectory: false, selectNoProject: true },
        chatDefaults: { permissionMode: 'ask', thinkingLevel: 'high' },
      }],
    });
    harness.services.catalog.addProject = async () => {
      calls.push('add'); return { ok: false, reason: 'archived', projectId: 'p' };
    };
    harness.services.catalog.restoreProject = async () => {
      calls.push('restore'); return { ok: true, project: restored };
    };
    harness.services.sessions.relocateWorkspace = async (sessionId, projectId) => {
      calls.push(`relocate:${sessionId}:${projectId}`); return { ok: true };
    };
    await harness.render(createElement(components.SessionRecoveryFixture, { sessionId: 'session-1' }));
    await click('Repair workspace');
    await click('New project');
    assert.ok(document.querySelector('#maka-new-project-form'));
    if (action === 'cancel') {
      await click('Close');
      assert.equal(document.querySelector('#maka-new-project-form'), null);
      assert.deepEqual(calls, []);
    } else {
      await submitProjectName();
      assert.deepEqual(calls, ['add']);
      await click('Restore and use for this session');
      assert.deepEqual(calls, ['add', 'restore', 'relocate:session-1:p']);
    }
  });
}

for (const outcome of ['restore', 'cancel', 'failure', 'normal'] as const) {
  test(`remote directory registration: ${outcome}`, async () => {
    const harness = installRenderer();
    const accepted: ProjectRecord[] = [];
    const restores: unknown[][] = [];
    bridge({
      registerDirectory: async () => outcome === 'normal' ? restored : archived,
    });
    harness.services.catalog.restoreProject = async (...args) => {
      restores.push(args);
      if (outcome === 'failure') throw new Error('restore failed');
      return { ok: true, project: restored };
    };
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
    if (outcome === 'cancel') {
      const dialog = [...document.querySelectorAll('dialog')].find(el => el.textContent.includes('Project archived'));
      assert.ok(dialog);
      const cancel = [...dialog.querySelectorAll('button')].find(el => el.textContent === 'Cancel');
      assert.ok(cancel);
      await act(async () => cancel.dispatchEvent(new window.Event('click', { bubbles: true })));
      await flushFrames();
    } else await click('Restore');
    if (outcome === 'restore') {
      assert.deepEqual(restores, [[host, 'p']]);
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
    });
    harness.services.catalog.restoreProject = async () => { throw new Error('restore failed'); };
    await harness.render(createElement(components.SettingsFixture));
    await submitNamedProject();
    if (failure === 'restore') await click('Restore');
    assert.match(document.body.textContent, /Action failed/);
    const add = [...document.querySelectorAll('button')].find(el => el.textContent === 'New project');
    assert.ok(add);
    assert.notEqual(add.getAttribute('aria-busy'), 'true');
    assert.equal(add.hasAttribute('disabled'), false);
  });
}
for (const outcome of ['restore', 'normal', 'refresh-failure'] as const) {
  test(`Settings successful Add: ${outcome}`, async () => {
    const harness = installRenderer();
    let restores = 0;
    let snapshots = 0;
    bridge({
      add: async () => outcome === 'normal'
        ? { ok: true, project: restored }
        : { ok: false, reason: 'archived', projectId: 'p' },
      getSnapshot: async () => {
        snapshots++;
        if (snapshots > 1 && outcome === 'refresh-failure') throw new Error('refresh failed');
        return { projects: [], capabilities: { chooseClientDirectory: true } };
      },
    });
    harness.services.catalog.restoreProject = async () => { restores++; return { ok: true, project: restored }; };
    await harness.render(createElement(components.SettingsFixture));
    await submitNamedProject();
    assert.equal(restores, 0);
    if (outcome !== 'normal') await click('Restore');
    assert.equal(restores, outcome === 'normal' ? 0 : 1);
    assert.equal(snapshots, 2);
    if (outcome === 'refresh-failure') assert.match(document.body.textContent, /Action failed/);
    else assert.doesNotMatch(document.body.textContent, /Action failed/);
  });
}

for (const stage of ['picker', 'confirmation', 'restore'] as const) {
  test(`Settings ${stage} cancellation skips refresh and errors${stage === 'confirmation' ? ' and allows retry' : ''}`, async () => {
    const harness = installRenderer();
    let adds = 0;
    let restores = 0;
    let snapshots = 0;
    bridge({
      add: async () => {
        adds++;
        return stage === 'picker'
          ? { ok: false, reason: 'cancelled' }
          : { ok: false, reason: 'archived', projectId: 'p' };
      },
      getSnapshot: async () => {
        snapshots++;
        if (snapshots > 1) throw new Error('unexpected refresh after cancellation');
        return { projects: [], capabilities: { chooseClientDirectory: true } };
      },
    });
    harness.services.catalog.restoreProject = async () => {
      restores++;
      return { ok: false, reason: 'cancelled' };
    };
    await harness.render(createElement(components.SettingsFixture));
    assert.equal(snapshots, 1);
    const attempts = stage === 'confirmation' ? 2 : 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await submitNamedProject();
      if (stage !== 'picker') {
        assert.match(document.body.textContent, /Project archived/);
        assert.equal(snapshots, 1, 'waiting for confirmation must not refresh');
        await click(stage === 'confirmation' ? 'Cancel' : 'Restore');
      }
      assert.deepEqual({
        adds,
        restores,
        snapshots,
        actionFailed: document.body.textContent.includes('Action failed'),
      }, {
        adds: attempt,
        restores: stage === 'restore' ? attempt : 0,
        snapshots: 1,
        actionFailed: false,
      });
      const add = [...document.querySelectorAll('button')].find(el => el.textContent === 'New project');
      assert.ok(add);
      assert.notEqual(add.getAttribute('aria-busy'), 'true');
      assert.equal(add.hasAttribute('disabled'), false);
    }
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('async confirmation preserves the queue and ordinary confirmations after rejection', async () => {
  const harness = installRenderer();
  const completion = deferred<void>();
  const outcomes: unknown[] = [];
  const cause = new Error('unconfirmed write');
  function Fixture() {
    const toast = useToast();
    return createElement('button', { onClick: () => {
      void toast.confirm({ title: 'Async first', onConfirm: async () => {
        await completion.promise;
        throw cause;
      } }).then(value => outcomes.push(value), error => outcomes.push(error));
      void toast.confirm({ title: 'Ordinary second' }).then(value => outcomes.push(value));
    } }, 'Queue confirmations');
  }
  await harness.render(createElement(Fixture));
  await click('Queue confirmations');
  await click('Confirm');
  assert.match(document.body.textContent, /Async first/);
  assert.doesNotMatch(document.body.textContent, /Ordinary second/);
  await act(async () => completion.resolve());
  await flushFrames();
  assert.deepEqual(outcomes, [cause]);
  assert.match(document.body.textContent, /Ordinary second/);
  await click('Confirm');
  assert.deepEqual(outcomes, [cause, true]);
  assert.equal(document.querySelector('.maka-confirm-modal'), null);
});

test('restore confirmation stays busy and cannot dismiss until completion', async () => {
  const harness = installRenderer();
  const completion = deferred<void>();
  let restores = 0;
  let accepted = 0;
  bridge();
  harness.services.catalog.restoreProject = async () => {
    restores++;
    await completion.promise;
    return { ok: true, project: restored };
  };
  await harness.render(createElement(components.RemoteProjectDirectoryDialog, {
    host, onClose() {}, onRegistered() { accepted++; },
  }));
  await click('Add this folder');
  const dialog = document.querySelector<HTMLDialogElement>('.maka-confirm-modal');
  assert.ok(dialog);
  const action = [...dialog.querySelectorAll('button')].find(el => el.textContent === 'Restore');
  const cancel = [...dialog.querySelectorAll('button')].find(el => el.textContent === 'Cancel');
  assert.ok(action);
  assert.ok(cancel);
  // Same-tick double click must start only one write, before React rerenders.
  await act(async () => {
    action.dispatchEvent(new window.Event('click', { bubbles: true }));
    action.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await flushFrames();
  assert.equal(restores, 1);
  assert.equal(dialog.hasAttribute('open'), true);
  assert.equal(dialog.getAttribute('aria-busy'), 'true');
  assert.ok(dialog.querySelector('[role="status"]'), 'restore button shows its loading indicator');
  await act(async () => {
    cancel.dispatchEvent(new window.Event('click', { bubbles: true }));
    dialog.dispatchEvent(new window.Event('cancel', { bubbles: false, cancelable: true }));
  });
  await flushFrames();
  assert.equal(dialog.hasAttribute('open'), true);
  assert.equal(accepted, 0);
  await act(async () => completion.resolve());
  await flushFrames();
  assert.equal(document.querySelector('.maka-confirm-modal'), null);
  assert.equal(accepted, 1);
});

for (const stage of ['registration', 'confirmation', 'restoration'] as const) {
  for (const invalidation of ['host', 'unmount'] as const) {
    test(`remote ${stage} ignores ${invalidation} invalidation`, async () => {
      const harness = installRenderer();
      const registration = deferred<ProjectRecord>();
      const restoration = deferred<{ ok: true; project: ProjectRecord }>();
      let restores = 0;
      let accepted = 0;
      bridge({ registerDirectory: () => registration.promise });
      harness.services.catalog.restoreProject = async () => { restores++; return restoration.promise; };
      const render = (target = host) => harness.render(createElement(components.RemoteProjectDirectoryDialog, {
        host: target, onClose() {}, onRegistered() { accepted++; },
      }));
      await render();
      await click('Add this folder');
      if (stage !== 'registration') {
        await act(async () => registration.resolve(archived));
        await flushFrames();
      }
      if (stage === 'restoration') {
        await click('Restore');
        assert.equal(restores, 1, 'restore starts before invalidation');
      }
      if (invalidation === 'host') await render({ profileId: 'other', hostId: 'other-host' });
      else await harness.render(null);
      if (stage === 'registration') await act(async () => registration.resolve(archived));
      if (stage === 'confirmation') await click('Restore');
      if (stage === 'restoration') await act(async () => restoration.resolve({ ok: true, project: restored }));
      assert.equal(restores, stage === 'restoration' ? 1 : 0);
      assert.equal(accepted, 0);
      if (stage === 'registration') assert.doesNotMatch(document.body.textContent, /Project archived/);
    });
  }
}

for (const invalidation of ['host', 'verification', 'unmount'] as const) {
  test(`Settings confirmation ignores ${invalidation} invalidation without refreshing old Host`, async () => {
    const harness = installRenderer();
    let restores = 0;
    let snapshots = 0;
    bridge({
      add: async (target: DesktopRuntimeHostRef, options: { name: string }) => {
        assert.deepEqual(target, host);
        assert.deepEqual(options, { name: 'Project' });
        return { ok: false, reason: 'archived', projectId: 'p' };
      },
      getSnapshot: async () => { snapshots++; return { projects: [], capabilities: { chooseClientDirectory: true } }; },
    });
    harness.services.catalog.restoreProject = async () => { restores++; return { ok: true, project: restored }; };
    await harness.render(createElement(components.SettingsFixture));
    await submitNamedProject();
    await harness.render(invalidation === 'unmount' ? null : createElement(components.SettingsFixture, {
      ...(invalidation === 'host' ? { host: { profileId: 'other', hostId: 'other-host' } } : { verified: false }),
    }));
    const reads = snapshots;
    await click('Restore');
    assert.equal(restores, 0);
    assert.equal(snapshots, reads);
  });
}

test('remote registration rejects same-tick duplicate submissions without invalidating the first request', async () => {
  const harness = installRenderer();
  const registration = deferred<ProjectRecord>();
  let registrations = 0;
  const accepted: ProjectRecord[] = [];
  bridge({ registerDirectory: async () => { registrations++; return registration.promise; } });
  await harness.render(createElement(components.RemoteProjectDirectoryDialog, {
    host, onClose() {}, onRegistered(project) { accepted.push(project); },
  }));
  const button = [...document.querySelectorAll('button')].find(el => el.textContent === 'Add this folder');
  assert.ok(button);
  await act(async () => {
    button.dispatchEvent(new window.Event('click', { bubbles: true }));
    button.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  assert.equal(registrations, 1);
  await act(async () => registration.resolve(restored));
  assert.deepEqual(accepted, [restored]);
});

test('Settings Add stays single-flight while the folder picker is pending', async () => {
  const harness = installRenderer();
  const addition = deferred<{ ok: true; project: ProjectRecord }>();
  let adds = 0;
  bridge({ add: async () => { adds++; return addition.promise; } });
  await harness.render(createElement(components.SettingsFixture));
  await submitNamedProject(2);
  assert.equal(adds, 1);
  const add = document.querySelector('button[aria-busy="true"]');
  assert.ok(add);
  await act(async () => addition.resolve({ ok: true, project: restored }));
  assert.notEqual(add.getAttribute('aria-busy'), 'true');
});

for (const outcome of ['cancelled', 'archived'] as const) {
  test(`remote handles restore result ${outcome} without accepting an archived project`, async () => {
    const harness = installRenderer();
    let accepted = 0;
    bridge();
    harness.services.catalog.restoreProject = async () => outcome === 'cancelled'
      ? { ok: false, reason: 'cancelled' }
      : { ok: false, reason: 'archived', projectId: 'p' };
    await harness.render(createElement(components.RemoteProjectDirectoryDialog, {
      host, onClose() {}, onRegistered() { accepted++; },
    }));
    await click('Add this folder');
    await click('Restore');
    assert.equal(accepted, 0);
    assert.equal(Boolean(document.querySelector('.remoteProjectDirectoryError')), outcome === 'archived');
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
    select() {},
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
  const services = components.createFakeTaskEntryServices();
  const container = document.getElementById('root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoot = root;
  return {
    document,
    services,
    async render(children: ReactNode) {
      await act(async () => root.render(createElement(LocaleProvider, {
        locale: 'en',
        children: createElement(AstryxLocaleProvider, {
          children: createElement(ToastProvider, {
            children: createElement(components.TaskEntryServicesProvider, { services, children }),
          }),
        }),
      })));
    },
  };
}
