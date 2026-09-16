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
import { test, type TestContext } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { deferred } from '@maka/core/test-only/async-primitives';
import type { ComputerHistoryApplication, ComputerHistoryStatus } from '@maka/core/computer-history';
import {
  ComputerHistoryAppIcon,
  createFakeComputerHistoryAnalysisModel,
  createFakeModuleHubServices,
  ModuleHubServicesProvider,
  type ModuleHubServices,
  useComputerHistoryApplications,
  useComputerHistoryController,
} from '../../renderer/features/module-hub/testing.js';

const A = 'com.example.Editor';
const B = 'com.example.Browser';
const metadata = (bundleIdentifier: string): ComputerHistoryApplication => ({
  bundleIdentifier, name: `App ${bundleIdentifier}`, iconDataUrl: null,
});
const ids = Array.from({ length: 67 }, (_, i) => `com.example.app${String(i).padStart(2, '0')}`);

function renderer(t: TestContext) {
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const globals = {
    document, window,
    HTMLElement: window.HTMLElement,
    HTMLIFrameElement: window.HTMLIFrameElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Reflect.get(globalThis, key)]));
  Object.assign(globalThis, globals);
  const container = document.getElementById('root')!;
  const root = createRoot(container);
  t.after(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      Object.assign(globalThis, previous);
    }
  });
  return { root, container, window };
}

function services(overrides: Partial<ModuleHubServices['computerHistory']>): ModuleHubServices {
  return createFakeModuleHubServices({
    computerHistory: { ...createFakeModuleHubServices().computerHistory, ...overrides },
  });
}

function hookHarness(t: TestContext, applications: ModuleHubServices['computerHistory']['applications']) {
  const { root } = renderer(t);
  const service = services({ applications });
  let current: ReturnType<typeof useComputerHistoryApplications>;
  function Probe({ bundleIds }: { bundleIds: readonly string[] }) {
    current = useComputerHistoryApplications(bundleIds);
    return null;
  }
  return {
    root,
    render: (bundleIds: readonly string[]) => act(async () => {
      root.render(createElement(ModuleHubServicesProvider, { services: service }, createElement(Probe, { bundleIds })));
    }),
    state: () => current,
  };
}

test('metadata requests are deduplicated, bounded to 32 and sequential; unchanged or empty sets send no IPC', async (t) => {
  const batches = [0, 1, 2].map(() => deferred<readonly ComputerHistoryApplication[]>());
  const requests: string[][] = [];
  const h = hookHarness(t, async (batch) => {
    requests.push([...batch]);
    return batches[requests.length - 1]!.promise;
  });
  await h.render([]);
  const refresh = h.state().refresh;
  await act(async () => refresh());
  assert.equal(h.state().refresh, refresh);
  assert.equal(requests.length, 0);
  await h.render([...ids].reverse().concat(ids[0]!));
  assert.deepEqual(requests, [ids.slice(0, 32)]);
  await h.render([...ids, ids[1]!, 'unknown']);
  assert.equal(requests.length, 1);
  for (let index = 0; index < batches.length; index++) {
    assert.equal(requests.length, index + 1, 'no following batch starts before this one settles');
    assert.deepEqual(requests[index], ids.slice(index * 32, (index + 1) * 32));
    await act(async () => batches[index]!.resolve(requests[index]!.map(metadata)));
  }
  assert.deepEqual([...h.state().applications.keys()], ids);
  await h.render(ids);
  assert.equal(requests.length, 3);
  assert.equal(h.state().refresh, refresh, 'header refresh callback stays stable across source and result changes');
  await h.render([]);
  assert.equal(requests.length, 3);
  assert.equal(h.state().applications.size, 0);
});

test('unknown and invalid timeline sources cannot poison valid native lookups', async (t) => {
  const requests: string[][] = [];
  const h = hookHarness(t, async (batch) => {
    requests.push([...batch]);
    return batch.map(metadata);
  });
  const invalid = [
    '', 'unknown', 'Safari', 'com..app', '.com.app', 'com.app.', 'com._app',
    'com.-app', ' com.example.App', 'com.example.App\n', '/Applications/Safari.app',
    'com.' + 'a'.repeat(253), 'win32._app..bad', 'win32._app.', 'win32._app/escape',
    'win32.editor.exe', 'Win32.editor', 'winapp.invalid', 'winapp.Package_8wekyb3d8bbwe!App/escape',
  ];
  await h.render(invalid);
  assert.equal(requests.length, 0);
  const valid = [
    A, B, 'com.example-2.App', 'com.' + 'a'.repeat(252), 'win32._fixture_app', 'win32.editor.2026',
    'winapp.Microsoft.WindowsNotepad_8wekyb3d8bbwe!App',
  ].sort();
  await h.render([...invalid, ...valid, A]);
  assert.deepEqual(requests, [valid]);
  assert.deepEqual([...h.state().applications.keys()], valid);
  await h.render([...valid].reverse().concat('another unknown source'));
  assert.equal(requests.length, 1, 'changes to fallback-only sources need no IPC');
});

test('late success and rejection cannot repopulate a changed set or start stale batches', async (t) => {
  const oldRead = deferred<readonly ComputerHistoryApplication[]>();
  const replacedRead = deferred<readonly ComputerHistoryApplication[]>();
  const requests: string[][] = [];
  const h = hookHarness(t, async (batch) => {
    requests.push([...batch]);
    if (batch.includes(ids[0]!)) return oldRead.promise;
    if (batch.includes(B)) return replacedRead.promise;
    return batch.map(metadata);
  });
  await h.render(ids);
  await h.render([A]);
  await act(async () => oldRead.resolve(ids.slice(0, 32).map(metadata)));
  assert.deepEqual(requests, [ids.slice(0, 32), [A]]);
  assert.deepEqual([...h.state().applications.keys()], [A]);
  await h.render([B]);
  await h.render([]);
  await act(async () => replacedRead.reject(new Error('obsolete lookup failed')));
  assert.equal(h.state().applications.size, 0);
  assert.equal(h.state().error, null);
});

test('unmount abandons a pending batch without issuing the next one', async (t) => {
  const pending = deferred<readonly ComputerHistoryApplication[]>();
  const requests: string[][] = [];
  const h = hookHarness(t, async (batch) => {
    requests.push([...batch]);
    return pending.promise;
  });
  await h.render(ids);
  await act(async () => h.root.unmount());
  await act(async () => pending.resolve(ids.slice(0, 32).map(metadata)));
  assert.deepEqual(requests, [ids.slice(0, 32)]);
  assert.equal(h.state().applications.size, 0);
});

test('native batch failure preserves history and resolved icons; manual refresh recovers the same sources', async (t) => {
  const { root } = renderer(t);
  const status: ComputerHistoryStatus = {
    platformSupported: true, helperAvailable: true, state: 'paused',
    accessibilityGranted: true, inputMonitoringGranted: true,
    eventCount: 1, suppressedEventCount: 0, segmentCount: 1,
    settings: { enabled: true, captureText: false, summariesEnabled: false, summaryTextEnabled: false, blockedApplications: [], blockedDomains: [] },
  };
  const entry = {
    id: 'activity', title: 'Edited a document', description: 'Local history',
    start: '2026-09-13T10:00:00Z', end: '2026-09-13T10:10:00Z',
    applications: ids, eventCount: 1, suppressedEventCount: 0, contextMarkdown: 'Observed metadata',
  };
  let failed = true;
  const service = services({
    status: async () => status,
    timeline: async () => ({ status, entries: [entry] }),
    getAnalysisModel: async () => createFakeComputerHistoryAnalysisModel(),
    applications: async (batch) => {
      if (failed && batch.includes(ids[32]!)) throw new Error('Native application helper unavailable');
      return batch.map(metadata);
    },
  });
  let history!: ReturnType<typeof useComputerHistoryController>;
  let apps!: ReturnType<typeof useComputerHistoryApplications>;
  function Probe() {
    history = useComputerHistoryController(null);
    apps = useComputerHistoryApplications(history.entries.flatMap((item) => item.applications));
    return createElement('span', null, history.entries[0]?.title);
  }
  await act(async () => root.render(
    createElement(ModuleHubServicesProvider, { services: service }, createElement(Probe)),
  ));
  assert.equal(apps.error, 'Native application helper unavailable');
  assert.deepEqual([...apps.applications.keys()], ids.slice(0, 32));
  assert.deepEqual(history.entries, [entry]);
  assert.equal(history.error, null);
  assert.equal(history.loading, false);
  failed = false;
  await act(async () => apps.refresh());
  assert.equal(apps.error, null);
  assert.deepEqual([...apps.applications.keys()], ids);
  assert.deepEqual(history.entries, [entry]);
});

test('broken native icons retain initials and a different image source recovers without remounting', async (t) => {
  const { root, container, window } = renderer(t);
  const render = (iconDataUrl: string | null, name = '\u00e9diteur') => act(async () => root.render(
    createElement(ComputerHistoryAppIcon, {
      application: A, metadata: { bundleIdentifier: A, name, iconDataUrl }, size: 24,
    }),
  ));
  const first = 'data:image/png;base64,AA==';
  const second = 'data:image/png;base64,AQ==';
  await render(first);
  const image = container.querySelector('img');
  assert.ok(image);
  assert.equal(image.getAttribute('src'), first);
  assert.equal(image.getAttribute('width'), '24');
  await act(async () => { image.dispatchEvent(new window.Event('error')); });
  assert.equal(container.querySelector('img'), null);
  assert.equal(container.textContent, '\u00c9');
  await render(first);
  assert.equal(container.querySelector('img'), null, 'same failed URL is not retried on each render');
  await render(second);
  assert.equal(container.querySelector('img')?.getAttribute('src'), second);
  await render(null, '\u7f16\u8f91\u5668');
  assert.equal(container.textContent, '\u7f16');
  await render(null, A);
  assert.equal(container.textContent, 'E', 'backend fallback ID uses the readable application name');
});

test('remote URLs, paths and non-PNG data never become icon image sources', async (t) => {
  const { root, container } = renderer(t);
  for (const iconDataUrl of [
    'https://example.com/icon.png', 'http://example.com/icon.png', '//example.com/icon.png',
    'file:///Applications/Editor.app/icon.png', '/private/icon.png', 'blob:https://example.com/icon',
    'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
  ]) {
    await act(async () => root.render(createElement(ComputerHistoryAppIcon, {
      application: A, metadata: { bundleIdentifier: A, name: 'Native Editor', iconDataUrl },
    })));
    assert.equal(container.querySelector('img'), null, iconDataUrl);
    assert.equal(container.textContent, 'N');
  }
  await act(async () => root.render(createElement(ComputerHistoryAppIcon, { application: A })));
  assert.equal(container.textContent, 'E');
  await act(async () => root.render(createElement(ComputerHistoryAppIcon, { application: '' })));
  assert.equal(container.textContent, '?');
});
