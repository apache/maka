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
import { deferred } from '@maka/core/test-only/async-primitives';
import type { ComputerHistorySettings, ComputerHistoryStatus, ComputerHistoryTimeline } from '@maka/core/computer-history';
import {
  createFakeModuleHubServices, ModuleHubServicesProvider, normalizeHistoryExclusion,
  useComputerHistorySettings, useRecentHistoryApplications, type ModuleHubServices,
} from '../../renderer/features/module-hub/testing.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

const STATUS: ComputerHistoryStatus = {
  platformSupported: true, helperAvailable: true, state: 'needs_permission',
  accessibilityGranted: false, inputMonitoringGranted: false,
  eventCount: 0, suppressedEventCount: 0, segmentCount: 0,
  settings: { enabled: false, captureText: false, summariesEnabled: false, blockedApplications: [], blockedDomains: [] },
};

function services(overrides: Partial<ModuleHubServices['computerHistory']> = {}): ModuleHubServices {
  return createFakeModuleHubServices({
    computerHistory: {
      ...createFakeModuleHubServices().computerHistory,
      status: async () => STATUS,
      getAnalysisModel: async () => null,
      ...overrides,
    },
  });
}

function harness(service: ModuleHubServices) {
  const { root } = installReactRenderer();
  let current!: ReturnType<typeof useComputerHistorySettings>;
  function Probe() {
    current = useComputerHistorySettings();
    return null;
  }
  return {
    root,
    state: () => current,
    render: (next = service) => act(async () => root.render(
      createElement(ModuleHubServicesProvider, { services: next }, createElement(Probe)),
    )),
  };
}

afterEach(cleanupFakeDom);

test('settings load, focus and polling are read-only and never require timeline success', async (t) => {
  const timeline = t.mock.fn(async () => { throw new Error('archive damaged'); });
  const updateSettings = t.mock.fn(async () => STATUS.settings);
  const status = t.mock.fn(async () => STATUS);
  const h = harness(services({ timeline, updateSettings, status }));
  let tick!: () => void;
  let focus!: EventListener;
  const schedule = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (callback: () => void, delay: number) => {
    tick = callback;
    return schedule(callback, delay);
  });
  t.mock.method(window, 'addEventListener', (_type: string, handler: EventListener) => { focus = handler; });
  await h.render();
  await act(async () => tick());
  await act(async () => focus(new Event('focus')));
  assert.equal(status.mock.callCount(), 3);
  assert.equal(timeline.mock.callCount(), 0);
  assert.equal(updateSettings.mock.callCount(), 0);
  assert.deepEqual(h.state().status?.settings, STATUS.settings);
});

test('model and status errors remain visible while clear independently recovers a corrupted archive', async () => {
  let failed = true;
  const clearCalls: string[] = [];
  const h = harness(services({
    status: async () => { if (failed) throw new Error('storage unreadable'); return STATUS; },
    getAnalysisModel: async () => { throw new Error('local model unavailable'); },
    clear: async (scope) => { clearCalls.push(scope); failed = false; return STATUS; },
  }));
  await h.render();
  assert.equal(h.state().status, null);
  assert.equal(h.state().statusError, 'storage unreadable');
  assert.equal(h.state().modelError, 'local model unavailable');
  assert.equal(h.state().modelLabel, null);
  let cleared = false;
  await act(async () => { cleared = await h.state().clear('all'); });
  assert.equal(cleared, true);
  assert.deepEqual(clearCalls, ['all']);
  assert.equal(h.state().statusError, null);
  assert.equal(h.state().modelError, 'local model unavailable');
});

test('save failure does not publish optimistic consent; retry confirms exact patch and guards duplicate submissions', async () => {
  const patches: Partial<ComputerHistorySettings>[] = [];
  const response = deferred<ComputerHistorySettings>();
  let failed = true;
  let persisted = STATUS;
  const h = harness(services({
    status: async () => persisted,
    updateSettings: async (patch) => {
      patches.push(patch);
      if (failed) throw new Error('write denied');
      const settings = await response.promise;
      persisted = { ...STATUS, settings };
      return settings;
    },
  }));
  await h.render();
  let saved = true;
  await act(async () => { saved = await h.state().update({ captureText: true }, 'captureText'); });
  assert.equal(saved, false);
  assert.equal(h.state().actionError, 'write denied');
  assert.equal(h.state().status?.settings.captureText, false);
  failed = false;
  let pending!: Promise<boolean>;
  await act(async () => { pending = h.state().update({ blockedDomains: ['example.com'] }, 'exclusions'); });
  assert.equal(h.state().pending, 'exclusions');
  assert.equal(await h.state().update({ enabled: true }, 'enabled'), false);
  assert.equal(h.state().status?.settings.blockedDomains.length, 0);
  await act(async () => { response.resolve({ ...STATUS.settings, blockedDomains: ['example.com'] }); saved = await pending; });
  assert.equal(saved, true);
  assert.deepEqual(patches, [{ captureText: true }, { blockedDomains: ['example.com'] }]);
  assert.deepEqual(h.state().status?.settings.blockedDomains, ['example.com']);
  assert.equal(h.state().status?.settings.captureText, false);
  assert.equal(h.state().actionError, null);
  assert.equal(h.state().pending, null);
});

test('retired service saves and pending reads cannot overwrite or unlock the current settings session', async () => {
  const oldSave = deferred<ComputerHistorySettings>();
  const oldStatus = deferred<ComputerHistoryStatus>();
  let holdRead = false;
  const first = services({
    status: async () => holdRead ? oldStatus.promise : STATUS,
    updateSettings: async () => oldSave.promise,
  });
  const h = harness(first);
  await h.render();
  holdRead = true;
  let read!: Promise<boolean>;
  let save!: Promise<boolean>;
  await act(async () => { read = h.state().refresh(); save = h.state().update({ enabled: true }, 'enabled'); });
  const latest: ComputerHistoryStatus = { ...STATUS, state: 'stopped', eventCount: 12 };
  await h.render(services({ status: async () => latest }));
  await act(async () => {
    oldSave.resolve({ ...STATUS.settings, enabled: true });
    oldStatus.resolve({ ...STATUS, eventCount: 99 });
    assert.equal(await save, false);
    assert.equal(await read, false);
  });
  assert.equal(h.state().status?.eventCount, 12);
  assert.equal(h.state().status?.settings.enabled, false);
  assert.equal(h.state().pending, null);
  assert.equal(h.state().actionError, null);
});

test('source validation rejects invalid native IDs and URL syntax before any save', () => {
  for (const value of ['unknown', 'com..App', 'com.-App', 'com._App', 'com.' + 'a'.repeat(253)]) {
    assert.equal(normalizeHistoryExclusion(value, 'applications'), null);
  }
  assert.equal(normalizeHistoryExclusion(' com.apple.Safari ', 'applications'), 'com.apple.Safari');
  for (const value of ['', 'https://example.com', '*.example.com', 'example.com/a', 'example.com:443', 'a@b.com', 'example.com?x=1']) {
    assert.equal(normalizeHistoryExclusion(value, 'websites'), null);
  }
  assert.equal(normalizeHistoryExclusion('WWW.Example.COM', 'websites'), 'example.com');
});

test('recent application discovery is optional, filters native IDs and fences stale archive responses', async () => {
  const { root } = installReactRenderer();
  const pending = deferred<ComputerHistoryTimeline>();
  let settings!: ReturnType<typeof useComputerHistorySettings>;
  let recent!: ReturnType<typeof useRecentHistoryApplications>;
  function Probe() {
    settings = useComputerHistorySettings();
    recent = useRecentHistoryApplications();
    return null;
  }
  const render = (value: ModuleHubServices) => act(async () => root.render(
    createElement(ModuleHubServicesProvider, { services: value }, createElement(Probe)),
  ));
  await render(services({ timeline: async () => pending.promise }));
  assert.equal(settings.status?.settings.enabled, false, 'configuration does not await archive discovery');
  await render(services({ timeline: async () => { throw new Error('archive damaged'); } }));
  await act(async () => pending.resolve({ status: STATUS, entries: [] }));
  assert.equal(recent.error, 'archive damaged');
  assert.equal(settings.statusError, null);
  const sourceIDs = ['unknown', 'com.example.App', 'com.example.App', 'com..App', 'com.example.Browser'];
  await render(services({
    timeline: async () => ({
      status: STATUS,
      entries: [{
        id: 'seen', title: 'Observed', description: '', applications: sourceIDs,
        start: '2026-09-13T10:00:00Z', end: '2026-09-13T10:00:00Z',
        eventCount: 1, suppressedEventCount: 0, contextMarkdown: '',
      }],
    }),
  }));
  assert.deepEqual(recent.applications, ['com.example.App', 'com.example.Browser']);
  assert.equal(recent.error, null);
  assert.equal(settings.statusError, null);
});
