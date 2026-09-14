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
import { after, before, test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { parseHTML } from 'linkedom';
import { act, createElement, type ComponentType, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from '@maka/ui';
import type {
  CapabilitySnapshotCollection,
  OsPermissionId,
  OsPermissionSnapshot,
  PermissionSnapshot,
} from '@maka/core/capabilities';
import type { MakaBridge, PermissionActionResult } from '../../preload/bridge-contract.js';
import { cleanupFakeDom, installFakeDom } from './fake-dom.js';

type Host = { profileId: string; hostId: string };
interface RenderModules {
  PermissionCenterPage: ComponentType<{ historyContext?: boolean }>;
  RuntimeHostSettingsTarget: ComponentType<{ host?: Host; generation?: string; children: ReactNode }>;
}

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const REMOTE = { profileId: 'remote-selected', hostId: 'remote-host' };
let components: RenderModules;
let bundleDirectory: string;

before(async () => {
  bundleDirectory = await mkdtemp(resolve(REPO_ROOT, 'apps/desktop/dist/main/__tests__/permission-page-'));
  const outfile = resolve(bundleDirectory, 'components.mjs');
  // Bundle the page and its Host provider together so they share the real context.
  // Renderer imports must not resolve to an older incremental build.
  await build({
    stdin: {
      contents: [
        "export { PermissionCenterPage } from './settings/permission-center-page';",
        "export { RuntimeHostSettingsTarget } from './settings/runtime-host-settings-target';",
      ].join('\n'),
      resolveDir: resolve(REPO_ROOT, 'apps/desktop/src/renderer'),
    },
    outfile,
    bundle: true,
    packages: 'external',
    alias: { '@maka/core/capabilities': resolve(REPO_ROOT, 'packages/core/src/capabilities.ts') },
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    target: 'node20',
    logLevel: 'silent',
  });
  components = await import(pathToFileURL(outfile).href) as RenderModules;
});

after(async () => {
  if (bundleDirectory) await rm(bundleDirectory, { recursive: true, force: true });
});

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function snapshot(overrides: Partial<Record<OsPermissionId, Partial<OsPermissionSnapshot>>> = {}): PermissionSnapshot {
  const permission = (
    id: OsPermissionId,
    status: OsPermissionSnapshot['status'],
    canRequest = false,
  ): OsPermissionSnapshot => ({
    id, status, source: 'platform', checkedAt: 1_000, canOpenSettings: true, canRequest,
    ...overrides[id],
  });
  return {
    checkedAt: 1_000,
    platform: 'darwin',
    permissions: {
      accessibility: {
        consumers: { activity_recorder: { status: 'granted' } },
        ...permission('accessibility', 'granted'),
      },
      input_monitoring: {
        consumers: { activity_recorder: { status: 'denied' } },
        ...permission('input_monitoring', 'denied'),
      },
      screen_recording: permission('screen_recording', 'denied', true),
      notifications: permission('notifications', 'not_determined', true),
      automation: permission('automation', 'unknown'),
    },
  };
}

function harness(t: TestContext, options: {
  host?: Host;
  historyContext?: boolean;
  getSnapshot?: MakaBridge['permissions']['getSnapshot'];
  getCapabilities?: MakaBridge['capabilities']['getSnapshot'];
  requestAccess?: MakaBridge['permissions']['requestAccess'];
  openSystemSettings?: MakaBridge['permissions']['openSystemSettings'];
  startDragOnboarding?: MakaBridge['permissions']['startDragOnboarding'];
} = {}) {
  installFakeDom();
  // The shared fake DOM owns React/global cleanup. Real Astryx controls also need
  // selectors, focus and portals, supplied by the existing linkedom dependency.
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const matchMedia = globalThis.window.matchMedia;
  const getComputedStyle = () => ({
    direction: 'ltr', writingMode: 'horizontal-tb', getPropertyValue: () => '',
  });
  Object.assign(window, { matchMedia, getComputedStyle });
  const scrollDescriptor = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'scrollIntoView');
  Object.assign(window.HTMLElement.prototype, { scrollIntoView() {} });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  const globals = {
    document, window, matchMedia, getComputedStyle,
    HTMLElement: window.HTMLElement, HTMLIFrameElement: window.HTMLIFrameElement,
    Node: window.Node, Event: window.Event, MutationObserver: window.MutationObserver,
    CSS: { supports: () => false, escape: (value: string) => value },
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const reads: unknown[][] = [];
  const capabilityReads: unknown[][] = [];
  const writes: Array<{ method: string; args: unknown[] }> = [];
  const forbiddenCalls: string[] = [];
  let current = snapshot();
  const deniedHistoryApi = new Proxy({}, {
    get: (_target, method) => (..._args: unknown[]) => {
      forbiddenCalls.push(String(method));
      return Promise.reject(new Error(`Permission Center must not call Computer History.${String(method)}`));
    },
  });
  Object.assign(window, {
    maka: {
      permissions: {
        getSnapshot: async (...args: Parameters<MakaBridge['permissions']['getSnapshot']>) => {
          reads.push(args);
          return options.getSnapshot ? options.getSnapshot(...args) : structuredClone(current);
        },
        requestAccess: async (...args: Parameters<MakaBridge['permissions']['requestAccess']>) => {
          writes.push({ method: 'requestAccess', args });
          return options.requestAccess ? options.requestAccess(...args) : { ok: true };
        },
        openSystemSettings: async (...args: Parameters<MakaBridge['permissions']['openSystemSettings']>) => {
          writes.push({ method: 'openSystemSettings', args });
          return options.openSystemSettings ? options.openSystemSettings(...args) : { ok: true };
        },
        startDragOnboarding: async (...args: Parameters<MakaBridge['permissions']['startDragOnboarding']>) => {
          writes.push({ method: 'startDragOnboarding', args });
          return options.startDragOnboarding ? options.startDragOnboarding(...args) : { ok: true };
        },
      },
      capabilities: {
        getSnapshot: async (...args: Parameters<MakaBridge['capabilities']['getSnapshot']>) => {
          capabilityReads.push(args);
          return options.getCapabilities ? options.getCapabilities(...args) : { checkedAt: 1_000, capabilities: [] };
        },
      },
      computerHistory: deniedHistoryApi,
      settings: deniedHistoryApi,
    },
  });
  const root = createRoot(document.getElementById('root')!);
  t.after(async () => {
    try {
      await act(async () => root.unmount());
      assert.deepEqual(forbiddenCalls, [], 'permission reads/actions never change recording or content consent');
      assert.ok(reads.every((args) => args.length === 0), 'local OS reads must not carry a Host');
      assert.ok(writes.every(({ args }) => args.length === 1 && typeof args[0] === 'string'),
        'local OS actions carry only the permission ID');
    } finally {
      if (scrollDescriptor) Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', scrollDescriptor);
      else Reflect.deleteProperty(window.HTMLElement.prototype, 'scrollIntoView');
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      cleanupFakeDom();
    }
  });
  const button = (label: string, within: ParentNode = document): HTMLButtonElement => {
    const element = [...within.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => {
        if (candidate.getAttribute('aria-label') === label) return true;
        const visible = candidate.cloneNode(true) as HTMLElement;
        for (const hidden of visible.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
        return visible.textContent === label;
      });
    assert.ok(element, `Missing button: ${label}`);
    return element;
  };
  const click = async (label: string, within?: ParentNode) => {
    const element = button(label, within);
    assert.equal(element.disabled || element.getAttribute('aria-disabled') === 'true', false, `${label} must be usable`);
    await act(async () => element.click());
  };
  return {
    document, reads, capabilityReads, writes, button, click,
    setSnapshot(value: PermissionSnapshot) { current = value; },
    row(id: OsPermissionId) {
      const element = document.querySelector<HTMLElement>(`[data-permission-id="${id}"]`);
      assert.ok(element, `Missing permission row: ${id}`);
      return element;
    },
    render: (generation = 'epoch-1') => act(async () => root.render(createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(AstryxLocaleProvider, {
        children: createElement(ToastProvider, {
          children: createElement(components.RuntimeHostSettingsTarget, {
            host: options.host,
            generation,
            children: createElement(components.PermissionCenterPage, { historyContext: options.historyContext }),
          }),
        }),
      }),
    }))),
    focus: () => act(async () => window.dispatchEvent(new window.Event('focus'))),
    visibility: (state: DocumentVisibilityState) => act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
      document.dispatchEvent(new window.Event('visibilitychange'));
    }),
  };
}

test('local permissions render without a Host; browsing and checking never request access or change History', async (t) => {
  const h = harness(t);
  await h.render();
  assert.equal(h.row('input_monitoring').dataset.state, 'denied');
  assert.deepEqual(h.reads, [[]]);
  assert.deepEqual(h.capabilityReads, []);
  assert.deepEqual(h.writes, []);
  assert.ok(h.document.querySelector('[role="tablist"]'));
  assert.equal(h.document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('aria-controls'),
    h.document.querySelector('[role="tabpanel"]')?.id);

  await h.click('Computer History');
  assert.equal(h.document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('aria-controls'),
    h.document.querySelector('[role="tabpanel"]')?.id, 'scope selection controls the displayed panel');
  await h.click('All permissions');
  await h.click('Check again');
  await h.focus();
  assert.equal(h.reads.length, 3);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.capabilityReads, []);

  await h.click('Open System Settings', h.row('input_monitoring'));
  await h.click('Request permission', h.row('notifications'));
  await h.click('Guide me', h.row('screen_recording'));
  assert.deepEqual(h.writes, [
    { method: 'openSystemSettings', args: ['input_monitoring'] },
    { method: 'requestAccess', args: ['notifications'] },
    { method: 'startDragOnboarding', args: ['screen_recording'] },
  ]);
});

test('a stalled remote capability read cannot block local rows or an OS action; History scope never reads Host capabilities', async (t) => {
  const remote = deferred<CapabilitySnapshotCollection>();
  const h = harness(t, { host: REMOTE, historyContext: true, getCapabilities: () => remote.promise });
  await h.render();
  assert.deepEqual(h.capabilityReads, []);
  await h.click('All permissions');
  assert.deepEqual(h.capabilityReads, [[REMOTE]]);
  assert.equal(h.row('input_monitoring').dataset.state, 'denied');
  await h.click('Open System Settings', h.row('input_monitoring'));
  assert.deepEqual(h.writes, [{ method: 'openSystemSettings', args: ['input_monitoring'] }]);

  await h.click('Computer History');
  await h.click('Check again');
  assert.equal(h.capabilityReads.length, 1);
  await act(async () => remote.reject(new Error('Retired remote response')));
  assert.equal(h.document.querySelector('[role="alert"]'), null);
  assert.equal(h.document.body.textContent.includes('Retired remote response'), false);
});

test('remote capability failure is isolated while local read and local action still succeed', async (t) => {
  const h = harness(t, {
    host: REMOTE,
    getCapabilities: async () => { throw new Error('Network unavailable for selected remote'); },
  });
  await h.render();
  assert.ok(h.document.body.textContent.includes('Capabilities for the selected Host are unavailable.'));
  assert.ok(h.document.body.textContent.includes('Network error'));
  assert.equal(h.document.querySelector('[role="alert"]'), null, 'Host failure is not a local permission read failure');
  assert.equal(h.row('input_monitoring').dataset.state, 'denied');
  await h.click('Open System Settings', h.row('input_monitoring'));
  assert.equal(h.writes.length, 1);
  await h.click('Check again');
  assert.equal(h.reads.length, 2);
  assert.deepEqual(h.capabilityReads, [[REMOTE], [REMOTE]]);
});

test('a same-Host lifecycle generation retires only capability reads, preserving local rows, filters and pending action', async (t) => {
  const retired = deferred<CapabilitySnapshotCollection>();
  const current = deferred<CapabilitySnapshotCollection>();
  const action = deferred<PermissionActionResult>();
  let calls = 0;
  const h = harness(t, {
    host: REMOTE,
    getCapabilities: () => ++calls === 1 ? retired.promise : current.promise,
    openSystemSettings: () => action.promise,
  });
  await h.render();
  await h.click('Show only denied permissions, 2');
  const row = h.row('input_monitoring');
  await h.click('Open System Settings', row);
  await h.render('epoch-2');
  assert.deepEqual(h.capabilityReads, [[REMOTE], [REMOTE]], 'same Host identity still needs a new generation read');
  assert.equal(h.row('input_monitoring'), row, 'Host lifecycle must not remount local state');
  assert.equal(h.document.querySelectorAll('[data-permission-id]').length, 2, 'local filter remains selected');
  assert.equal(h.button('Opening\u2026', row).disabled, true, 'the original local action remains in flight');
  assert.deepEqual(h.reads, [[]], 'Host lifecycle does not trigger a new local read');
  await act(async () => current.reject(new Error('Current Host network failure')));
  await act(async () => retired.resolve({ checkedAt: 1_000, capabilities: [] }));
  assert.ok(h.document.body.textContent.includes('Network error'), 'retired success cannot clear the current error');
  await act(async () => action.resolve({ ok: true }));
  assert.equal(h.button('Open System Settings', row).disabled, false);
  assert.deepEqual(h.writes, [{ method: 'openSystemSettings', args: ['input_monitoring'] }]);
});

test('collector AX denial is not hidden by Electron grant in aggregate filters or History readiness', async (t) => {
  const h = harness(t);
  h.setSnapshot(snapshot({
    accessibility: { status: 'granted', consumers: { activity_recorder: { status: 'denied', reason: 'permission_probe_failed' } } },
  }));
  await h.render();
  assert.equal(h.row('accessibility').dataset.state, 'denied');
  assert.match(h.row('accessibility').textContent!, /Maka Desktop: Granted/);
  assert.match(h.row('accessibility').textContent!, /Computer History collector: Denied/);
  assert.equal(h.button('Show only granted permissions, 0').disabled, true);
  await h.click('Show only denied permissions, 3');
  assert.ok(h.row('accessibility'));
  assert.equal(h.document.querySelectorAll('[data-permission-id]').length, 3);

  await h.click('Computer History');
  assert.ok(h.document.body.textContent.includes('Computer History: 2 permissions need attention'));
  assert.equal(h.document.body.textContent.includes('Computer History permissions are ready'), false);
  assert.equal(h.row('accessibility').dataset.state, 'denied');
  assert.equal(h.row('accessibility').querySelectorAll('button').length, 1,
    'collector mismatch has a System Settings route, not the Electron drag or request flow');
  assert.deepEqual(h.writes, []);
});

test('an All-scope denial filter survives refresh when only the collector is denied', async (t) => {
  const h = harness(t);
  h.setSnapshot(snapshot({
    accessibility: { consumers: { activity_recorder: { status: 'denied' } } },
    input_monitoring: { status: 'granted', consumers: { activity_recorder: { status: 'granted' } } },
    screen_recording: { status: 'granted' },
    notifications: { status: 'granted' },
    automation: { status: 'granted' },
  }));
  await h.render();
  await h.click('Show only denied permissions, 1');
  assert.equal(h.document.querySelectorAll('[data-permission-id]').length, 1);
  await h.focus();
  assert.equal(h.document.querySelectorAll('[data-permission-id]').length, 1,
    'filter retention uses the same combined statuses as rows and counts');
  assert.equal(h.row('accessibility').dataset.state, 'denied');
  const selected = h.document.querySelector('button[aria-pressed="true"]');
  assert.ok(selected);
  await act(async () => (selected as HTMLButtonElement).click());
  assert.equal(h.document.querySelectorAll('[data-permission-id]').length, 5);
  assert.deepEqual(h.writes, []);
});

test('already-granted access can still be managed or revoked from either scope without modifying History', async (t) => {
  const h = harness(t);
  h.setSnapshot(snapshot({
    input_monitoring: { status: 'granted', consumers: { activity_recorder: { status: 'granted' } } },
  }));
  await h.render();
  for (const scope of ['All permissions', 'Computer History']) {
    await h.click(scope);
    for (const id of ['accessibility', 'input_monitoring'] as const) {
      const row = h.row(id);
      assert.equal(row.dataset.state, 'granted');
      assert.equal(row.querySelectorAll('button').length, 1);
      await h.click('Open System Settings', row);
      assert.equal(h.row(id).dataset.state, 'granted');
    }
  }
  assert.deepEqual(h.writes.map(({ args }) => args), [
    ['accessibility'], ['input_monitoring'], ['accessibility'], ['input_monitoring'],
  ]);
});

test('missing collector evidence stays unknown, and unrelated screen denial does not block verified History permissions', async (t) => {
  const h = harness(t, { historyContext: true });
  h.setSnapshot(snapshot({
    accessibility: { status: 'granted', consumers: undefined },
    input_monitoring: { status: 'granted', consumers: { activity_recorder: { status: 'granted' } } },
  }));
  await h.render();
  assert.equal(h.row('accessibility').dataset.state, 'unknown');
  assert.ok(h.document.body.textContent.includes('Computer History: 1 permissions need attention'));

  h.setSnapshot(snapshot({
    input_monitoring: { status: 'granted', consumers: { activity_recorder: { status: 'granted' } } },
  }));
  await h.focus();
  assert.equal(h.row('screen_recording').dataset.state, 'denied');
  assert.ok(h.document.body.textContent.includes('Computer History permissions are ready'));
  assert.deepEqual(h.writes, []);
});

test('request success waits for authoritative readback and suppresses duplicate in-flight actions', async (t) => {
  const action = deferred<PermissionActionResult>();
  const readback = deferred<PermissionSnapshot>();
  let reads = 0;
  const h = harness(t, {
    requestAccess: () => action.promise,
    getSnapshot: () => ++reads === 1 ? Promise.resolve(snapshot()) : readback.promise,
  });
  await h.render();
  const request = h.button('Request permission', h.row('notifications'));
  // Two events in one React batch exercise the synchronous action guard, before
  // the disabled state commits to the DOM.
  await act(async () => { request.click(); request.click(); });
  assert.deepEqual(h.writes, [{ method: 'requestAccess', args: ['notifications'] }]);
  await act(async () => action.resolve({ ok: true }));
  assert.equal(h.reads.length, 2);
  assert.equal(h.row('notifications').dataset.state, 'not_determined');
  assert.equal(h.button('Request permission', h.row('notifications')).disabled, true);

  await act(async () => readback.resolve(snapshot()));
  assert.equal(h.row('notifications').dataset.state, 'not_determined', 'successful request is not evidence of a grant');
  assert.equal(h.button('Request permission', h.row('notifications')).disabled, false);
});

test('opening System Settings does not grant permission; returning focus or visibility reads the actual state', async (t) => {
  const h = harness(t, { historyContext: true });
  await h.render();
  await h.click('Open System Settings', h.row('input_monitoring'));
  assert.equal(h.row('input_monitoring').dataset.state, 'denied');
  assert.ok(h.document.body.textContent.includes('Computer History: 1 permissions need attention'));

  h.setSnapshot(snapshot({
    input_monitoring: { status: 'granted', consumers: { activity_recorder: { status: 'granted' } } },
  }));
  await h.visibility('hidden');
  assert.equal(h.reads.length, 1, 'leaving the app is not an authorization check');
  await h.visibility('visible');
  assert.equal(h.row('input_monitoring').dataset.state, 'granted');
  assert.ok(h.document.body.textContent.includes('Computer History permissions are ready'));

  h.setSnapshot(snapshot());
  await h.focus();
  assert.equal(h.row('input_monitoring').dataset.state, 'denied', 'revocation is reflected on return too');
  assert.equal(h.writes.length, 1, 'returning focus only reads');
});

for (const failure of ['result', 'exception'] as const) {
  test(`${failure}: a failed OS action reports an error, preserves denial and leaves an explicit retry`, async (t) => {
    let attempts = 0;
    const h = harness(t, {
      openSystemSettings: async () => {
        if (++attempts > 1) return { ok: true };
        if (failure === 'exception') throw new Error('Synthetic OS bridge timeout');
        return { ok: false, reason: 'open_settings_failed' };
      },
    });
    await h.render();
    await h.click('Open System Settings', h.row('input_monitoring'));
    assert.ok(h.document.body.textContent.includes('Permission action failed'));
    assert.ok(h.document.body.textContent.includes(
      failure === 'exception' ? 'Request timed out' : 'Could not open System Settings',
    ));
    assert.equal(h.row('input_monitoring').dataset.state, 'denied');
    assert.equal(h.document.body.textContent.includes('System Settings is open.'), false);
    await h.click('Open System Settings', h.row('input_monitoring'));
    assert.equal(attempts, 2);
    assert.equal(h.row('input_monitoring').dataset.state, 'denied');
    assert.ok(h.document.body.textContent.includes('System Settings is open.'));
  });
}

test('an initial local read failure has a read-only retry and does not issue automatic authorization', async (t) => {
  let attempts = 0;
  const h = harness(t, {
    getSnapshot: async () => {
      if (++attempts === 1) throw new Error('Synthetic local read timeout');
      return snapshot();
    },
  });
  await h.render();
  assert.match(h.document.querySelector('[role="alert"]')?.textContent ?? '', /Request timed out/);
  assert.equal(h.document.querySelectorAll('[data-permission-id]').length, 0);
  assert.deepEqual(h.writes, []);
  await h.click('Read again');
  assert.equal(h.document.querySelector('[role="alert"]'), null);
  assert.equal(h.row('input_monitoring').dataset.state, 'denied');
  assert.deepEqual(h.writes, []);
});

test('failed refresh keeps cached rows but retires History readiness and authorization actions until retry succeeds', async (t) => {
  const verified = snapshot({
    input_monitoring: { status: 'granted', consumers: { activity_recorder: { status: 'granted' } } },
  });
  const refreshing = deferred<PermissionSnapshot>();
  let reads = 0;
  const h = harness(t, {
    historyContext: true,
    getSnapshot: () => ++reads === 2 ? refreshing.promise : Promise.resolve(verified),
  });
  await h.render();
  const cached = h.row('input_monitoring');
  assert.ok(h.document.body.textContent.includes('Computer History permissions are ready'));
  await h.focus();
  assert.equal(h.row('input_monitoring'), cached, 'background recheck does not replace cached rows with loading');
  assert.equal(h.button('Open System Settings', cached).disabled, true);
  await act(async () => refreshing.reject(new Error('Permission refresh timeout')));
  assert.match(h.document.querySelector('[role="alert"]')?.textContent ?? '', /Request timed out/);
  assert.equal(h.row('input_monitoring'), cached, 'failed refresh does not unmount cached rows');
  assert.equal(cached.dataset.state, 'granted');
  assert.equal(h.document.body.textContent.includes('Computer History permissions are ready'), false,
    'the aggregate must signal stale verification instead of green readiness');
  assert.equal(h.button('Open System Settings', cached).disabled, true);
  await h.click('Check again');
  assert.ok(h.document.body.textContent.includes('Computer History permissions are ready'));
  assert.equal(h.document.querySelector('[role="alert"]'), null);
  assert.equal(h.button('Open System Settings', cached).disabled, false);
  assert.deepEqual(h.writes, []);
});

for (const staleOutcome of ['success', 'failure'] as const) {
  test(`a superseded local ${staleOutcome} cannot overwrite the newer failed refresh or remove its retry`, async (t) => {
    const stale = deferred<PermissionSnapshot>();
    const latest = deferred<PermissionSnapshot>();
    let reads = 0;
    const h = harness(t, {
      getSnapshot: () => {
        reads++;
        if (reads === 2) return stale.promise;
        if (reads === 3) return latest.promise;
        return Promise.resolve(snapshot());
      },
    });
    await h.render();
    await h.focus();
    await h.focus();
    await act(async () => latest.reject(new Error('Latest permission check timeout')));
    await act(async () => {
      if (staleOutcome === 'failure') stale.reject(new Error('Retired permission check network error'));
      else stale.resolve(snapshot({
        input_monitoring: { status: 'granted', consumers: { activity_recorder: { status: 'granted' } } },
      }));
    });
    const alert = h.document.querySelector('[role="alert"]');
    assert.match(alert?.textContent ?? '', /Request timed out/);
    assert.doesNotMatch(alert?.textContent ?? '', /Network error/);
    assert.equal(h.row('input_monitoring').dataset.state, 'denied');
    assert.equal(h.button('Open System Settings', h.row('input_monitoring')).disabled, true);
    await h.click('Check again');
    assert.equal(h.document.querySelector('[role="alert"]'), null);
    assert.equal(h.button('Open System Settings', h.row('input_monitoring')).disabled, false);
    assert.deepEqual(h.writes, []);
  });
}
