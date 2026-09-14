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
  createFakeComputerHistoryAnalysisModel, createFakeModuleHubServices, ModuleHubServicesProvider, normalizeHistoryExclusion,
  useComputerHistorySettings, useRecentHistoryApplications, type ModuleHubServices,
} from '../../renderer/features/module-hub/testing.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

const STATUS: ComputerHistoryStatus = {
  platformSupported: true, helperAvailable: true, state: 'needs_permission',
  accessibilityGranted: false, inputMonitoringGranted: false,
  eventCount: 0, suppressedEventCount: 0, segmentCount: 0,
  settings: { enabled: false, captureText: false, summariesEnabled: false, summaryTextEnabled: false, blockedApplications: [], blockedDomains: [] },
};

const MODEL = createFakeComputerHistoryAnalysisModel({
  modelKey: 'fixture::selected',
  defaultModelKey: 'fixture::default',
  models: [
    { key: 'fixture::selected', label: 'Selected model', connectionName: 'Fixture' },
    { key: 'fixture::default', label: 'Default model', connectionName: 'Fixture' },
  ],
});
type AnalysisModel = ReturnType<typeof createFakeComputerHistoryAnalysisModel>;

function services(overrides: Partial<ModuleHubServices['computerHistory']> = {}): ModuleHubServices {
  return createFakeModuleHubServices({
    computerHistory: {
      ...createFakeModuleHubServices().computerHistory,
      status: async () => STATUS,
      getAnalysisModel: async () => createFakeComputerHistoryAnalysisModel(),
      ...overrides,
    },
  });
}

function harness(service: ModuleHubServices) {
  const { root } = installReactRenderer();
  let current!: ReturnType<typeof useComputerHistorySettings>;
  let renders = 0;
  function Probe() {
    current = useComputerHistorySettings();
    renders += 1;
    return null;
  }
  return {
    root,
    state: () => current,
    renderCount: () => renders,
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

for (const writeSucceeds of [true, false]) test(`settings ${writeSucceeds ? 'save' : 'failure'} completes from status while model readback is stalled`, async () => {
  const catalog = deferred<AnalysisModel>();
  let holdCatalog = false;
  let persisted = { ...STATUS, settings: { ...STATUS.settings, summariesEnabled: true } };
  const patches: Partial<ComputerHistorySettings>[] = [];
  const h = harness(services({
    status: async () => persisted,
    getAnalysisModel: async () => holdCatalog ? catalog.promise : MODEL,
    updateSettings: async (patch) => {
      patches.push(patch);
      if (!writeSucceeds) throw new Error('settings write denied');
      persisted = { ...persisted, settings: { ...persisted.settings, ...patch } };
      return persisted.settings;
    },
  }));
  await h.render();
  holdCatalog = true;
  let result: boolean | undefined;
  let save!: Promise<boolean>;
  await act(async () => {
    save = h.state().update({ summariesEnabled: false }, 'summariesEnabled');
    void save.then((value) => { result = value; });
  });
  try {
    assert.deepEqual(patches, [{ summariesEnabled: false }]);
    assert.equal(h.state().status?.settings.summariesEnabled, !writeSucceeds);
    assert.equal(h.state().actionError, writeSucceeds ? null : 'settings write denied');
    assert.equal(h.state().pending, null, 'catalog latency must not lock recording settings after status readback');
    assert.equal(result, writeSucceeds, 'the action settles without waiting for the model catalog');
  } finally {
    await act(async () => { catalog.resolve({ ...MODEL, modelKey: 'fixture::default' }); await save; });
  }
  assert.equal(h.state().model?.modelKey, 'fixture::default', 'model readback still publishes independently');
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

test('model selection publishes only confirmed state and synchronously guards duplicate and other mutations', async () => {
  const response = deferred<AnalysisModel>();
  let persisted = MODEL;
  const writes: { key: string; host: AnalysisModel['host'] }[] = [];
  let settingWrites = 0;
  const h = harness(services({
    getAnalysisModel: async () => persisted,
    setAnalysisModel: async (key, host) => {
      writes.push({ key, host });
      persisted = await response.promise;
      return persisted;
    },
    updateSettings: async () => { settingWrites++; return STATUS.settings; },
  }));
  await h.render();
  assert.deepEqual(h.state().model, MODEL);
  assert.equal(h.state().modelLabel, MODEL.modelKey);
  assert.equal(h.state().modelAvailable, true);
  let save!: Promise<boolean>;
  let duplicate!: Promise<boolean>;
  await act(async () => {
    save = h.state().selectModel('fixture::default');
    duplicate = h.state().selectModel('fixture::default');
  });
  assert.equal(await duplicate, false);
  assert.equal(h.state().pending, 'model');
  assert.equal(h.state().model?.modelKey, MODEL.modelKey, 'selection is not optimistic');
  assert.equal(h.state().modelLabel, MODEL.modelKey);
  assert.equal(await h.state().update({ captureText: true }, 'captureText'), false);
  assert.equal(settingWrites, 0);
  assert.deepEqual(writes, [{ key: 'fixture::default', host: MODEL.host }]);
  const confirmed = { ...MODEL, modelKey: 'fixture::default' };
  await act(async () => { response.resolve(confirmed); assert.equal(await save, true); });
  assert.deepEqual(h.state().model, confirmed);
  assert.equal(h.state().modelLabel, 'fixture::default');
  assert.equal(h.state().pending, null);
  assert.equal(h.state().modelSaveError, null);
  await act(async () => assert.equal(await h.state().selectModel('fixture::default'), true));
  assert.equal(writes.length, 1, 'selecting the persisted value is a no-op');
});

test('default model selection persists an empty key while displaying the resolved available key', async () => {
  let persisted = MODEL;
  const writes: string[] = [];
  const h = harness(services({
    getAnalysisModel: async () => persisted,
    setAnalysisModel: async (key) => {
      writes.push(key);
      persisted = { ...persisted, modelKey: key };
      return persisted;
    },
  }));
  await h.render();
  await act(async () => assert.equal(await h.state().selectModel(''), true));
  assert.deepEqual(writes, ['']);
  assert.equal(h.state().model?.modelKey, '');
  assert.equal(h.state().modelLabel, MODEL.defaultModelKey);
  assert.equal(h.state().modelAvailable, true);
  const newDefault = { ...persisted, defaultModelKey: 'fixture::selected' };
  persisted = newDefault;
  await act(async () => h.state().refresh());
  assert.deepEqual(h.state().model, newDefault);
  assert.equal(h.state().modelLabel, 'fixture::selected');
  await act(async () => assert.equal(await h.state().selectModel(''), true));
  assert.deepEqual(writes, [''], 'a changed default does not turn the default selection into an explicit save');
});

for (const [modelKey, defaultModelKey, effectiveKey, available] of [
  ['', null, null, false],
  ['', 'fixture::missing', 'fixture::missing', false],
  ['fixture::missing', 'fixture::default', 'fixture::missing', false],
  ['fixture::selected', null, 'fixture::selected', true],
] as const) {
  test(`model availability for selected ${modelKey || '(default)'} and default ${defaultModelKey ?? '(unset)'}`, async () => {
    const snapshot = { ...MODEL, modelKey, defaultModelKey };
    const h = harness(services({ getAnalysisModel: async () => snapshot }));
    await h.render();
    assert.deepEqual(h.state().model, snapshot);
    assert.equal(h.state().modelLabel, effectiveKey);
    assert.equal(h.state().modelAvailable, available);
    assert.equal(h.state().modelError, null, 'an unavailable configured key is not a failed read');
  });
}

test('model saves are blocked before loading, for unknown choices and while another settings action is pending', async () => {
  const initial = deferred<AnalysisModel>();
  const clear = deferred<ComputerHistoryStatus>();
  let writes = 0;
  let loaded = false;
  const h = harness(services({
    getAnalysisModel: async () => loaded ? MODEL : initial.promise,
    setAnalysisModel: async () => { writes++; return MODEL; },
    clear: async () => clear.promise,
  }));
  await h.render();
  assert.equal(h.state().model, null);
  assert.deepEqual(h.state().status, STATUS, 'recording status does not wait for the model catalog');
  assert.equal(h.state().loading, false);
  assert.equal(await h.state().selectModel('fixture::default'), false);
  await act(async () => { loaded = true; initial.resolve(MODEL); await initial.promise; });
  assert.equal(await h.state().selectModel('fixture::unknown'), false);
  let clearing!: Promise<boolean>;
  await act(async () => { clearing = h.state().clear('all'); });
  assert.equal(await h.state().selectModel('fixture::default'), false);
  assert.equal(h.state().pending, 'clear');
  await act(async () => { clear.resolve(STATUS); assert.equal(await clearing, true); });
  assert.equal(writes, 0);
});

test('model save failure retains the confirmed selection, rejects for the caller and clears on retry', async () => {
  const failure = new Error('model write denied');
  let fail = true;
  let persisted = MODEL;
  const h = harness(services({
    getAnalysisModel: async () => persisted,
    setAnalysisModel: async (modelKey) => {
      if (fail) throw failure;
      persisted = { ...MODEL, modelKey };
      return persisted;
    },
  }));
  await h.render();
  await act(async () => assert.rejects(h.state().selectModel('fixture::default'), (error) => error === failure));
  assert.deepEqual(h.state().model, MODEL);
  assert.equal(h.state().modelLabel, MODEL.modelKey);
  assert.equal(h.state().modelSaveError, failure.message);
  assert.equal(h.state().pending, null);
  fail = false;
  await act(async () => assert.equal(await h.state().selectModel('fixture::default'), true));
  assert.equal(h.state().model?.modelKey, 'fixture::default');
  assert.equal(h.state().modelSaveError, null);
});

test('a committed model save with failed readback fences authority until reread without blocking consent revocation', async () => {
  const catalog = deferred<AnalysisModel>();
  const failure = new Error('model committed but readback failed');
  let persistedModel = MODEL;
  let persistedStatus = { ...STATUS, settings: { ...STATUS.settings, summariesEnabled: true, summaryTextEnabled: true } };
  let reads = 0;
  let writes = 0;
  const patches: Partial<ComputerHistorySettings>[] = [];
  const h = harness(services({
    status: async () => persistedStatus,
    getAnalysisModel: async () => ++reads === 1 ? MODEL : catalog.promise,
    setAnalysisModel: async (modelKey) => {
      writes++;
      persistedModel = { ...MODEL, modelKey };
      throw failure;
    },
    updateSettings: async (patch) => {
      patches.push(patch);
      persistedStatus = { ...persistedStatus, settings: { ...persistedStatus.settings, ...patch } };
      return persistedStatus.settings;
    },
  }));
  await h.render();
  assert.equal(h.state().modelAvailable, true);
  await act(async () => assert.rejects(h.state().selectModel('fixture::default'), (error) => error === failure));
  assert.equal(persistedModel.modelKey, 'fixture::default', 'the backend committed despite the rejected save');
  assert.equal(reads, 2, 'uncertain persistence triggers a fresh authority read');
  assert.deepEqual(h.state().model, MODEL, 'retain the last snapshot without treating it as current authority');
  assert.equal(h.state().modelAvailable, false);
  assert.equal(h.state().modelError, failure.message);
  assert.equal(h.state().modelSaveError, failure.message);
  assert.equal(h.state().pending, null);
  assert.equal(await h.state().selectModel(MODEL.modelKey), false);
  assert.equal(writes, 1, 'an uncertain snapshot cannot authorize another model selection');
  await act(async () => assert.equal(await h.state().update({
    summariesEnabled: false, summaryTextEnabled: false,
  }, 'summariesEnabled'), true));
  assert.deepEqual(patches, [{ summariesEnabled: false, summaryTextEnabled: false }]);
  assert.equal(h.state().status?.settings.summariesEnabled, false);
  assert.equal(h.state().status?.settings.summaryTextEnabled, false);
  assert.equal(h.state().pending, null, 'consent revocation completes while the catalog remains unresolved');
  assert.equal(h.state().modelAvailable, false);
  await act(async () => { catalog.resolve(persistedModel); await catalog.promise; });
  assert.deepEqual(h.state().model, persistedModel);
  assert.equal(h.state().modelLabel, 'fixture::default');
  assert.equal(h.state().modelAvailable, true);
  assert.equal(h.state().modelError, null);
  assert.equal(h.state().modelSaveError, failure.message, 'read recovery does not erase the failed save feedback');
});

test('a failed model read disables availability and selection until a successful refresh', async () => {
  let fail = false;
  let writes = 0;
  const h = harness(services({
    getAnalysisModel: async () => { if (fail) throw new Error('model catalog unavailable'); return MODEL; },
    setAnalysisModel: async () => { writes++; return MODEL; },
  }));
  await h.render();
  fail = true;
  await act(async () => h.state().refresh());
  assert.equal(h.state().modelError, 'model catalog unavailable');
  assert.equal(h.state().modelAvailable, false);
  assert.equal(await h.state().selectModel('fixture::default'), false);
  assert.equal(writes, 0);
  fail = false;
  await act(async () => h.state().refresh());
  assert.deepEqual(h.state().model, MODEL);
  assert.equal(h.state().modelError, null);
  assert.equal(h.state().modelAvailable, true);
});

test('stale model polling cannot overwrite a confirmed save and polling pauses during model writes', async (t) => {
  const stale = deferred<AnalysisModel>();
  const staleStatus = deferred<ComputerHistoryStatus>();
  const response = deferred<AnalysisModel>();
  let reads = 0;
  let statusReads = 0;
  let persisted = MODEL;
  const h = harness(services({
    status: async () => ++statusReads === 2 ? staleStatus.promise : STATUS,
    getAnalysisModel: async () => ++reads === 2 ? stale.promise : persisted,
    setAnalysisModel: async () => { persisted = await response.promise; return persisted; },
  }));
  let tick!: () => void;
  let focus!: EventListener;
  const schedule = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (callback: () => void, delay: number) => {
    tick = callback;
    return schedule(callback, delay);
  });
  t.mock.method(window, 'addEventListener', (_type: string, listener: EventListener) => { focus = listener; });
  await h.render();
  let poll!: Promise<boolean>;
  let save!: Promise<boolean>;
  await act(async () => { poll = h.state().refresh(); });
  await act(async () => { save = h.state().selectModel('fixture::default'); });
  await act(async () => { tick(); focus(new Event('focus')); });
  assert.equal(reads, 2, 'scheduled reads do not race an admitted model write');
  await act(async () => {
    response.resolve({ ...MODEL, modelKey: 'fixture::default' });
    assert.equal(await save, true);
  });
  await act(async () => {
    stale.resolve(MODEL);
    staleStatus.resolve(STATUS);
    assert.equal(await poll, false);
  });
  assert.equal(h.state().model?.modelKey, 'fixture::default');
  assert.equal(h.state().pending, null);
  await act(async () => tick());
  assert.equal(h.state().model?.modelKey, 'fixture::default');
  assert.ok(reads > 2, 'polling resumes once persistence finishes');
});

for (const oldSaveSucceeds of [true, false]) test(`retired model reads and ${oldSaveSucceeds ? 'successful' : 'failed'} saves cannot overwrite or unlock a replacement service session`, async () => {
  const oldRead = deferred<AnalysisModel>();
  const oldWrite = deferred<AnalysisModel>();
  let holdRead = false;
  const h = harness(services({
    getAnalysisModel: async () => holdRead ? oldRead.promise : MODEL,
    setAnalysisModel: async () => oldWrite.promise,
  }));
  await h.render();
  holdRead = true;
  let read!: Promise<boolean>;
  let oldSave!: Promise<boolean>;
  await act(async () => { read = h.state().refresh(); oldSave = h.state().selectModel('fixture::default'); });
  const currentWrite = deferred<AnalysisModel>();
  const currentModel = { ...MODEL, host: { profileId: 'replacement', hostId: 'local-new' } };
  let persisted = currentModel;
  const writes: AnalysisModel['host'][] = [];
  await h.render(services({
    getAnalysisModel: async () => persisted,
    setAnalysisModel: async (_key, host) => {
      writes.push(host);
      persisted = await currentWrite.promise;
      return persisted;
    },
  }));
  let newSave!: Promise<boolean>;
  await act(async () => { newSave = h.state().selectModel('fixture::default'); });
  await act(async () => {
    oldRead.resolve({ ...MODEL, modelKey: 'fixture::default' });
    if (oldSaveSucceeds) {
      oldWrite.resolve({ ...MODEL, modelKey: 'fixture::default' });
      assert.equal(await oldSave, false);
    } else {
      const failure = new Error('retired host write denied');
      oldWrite.reject(failure);
      await assert.rejects(oldSave, (error) => error === failure);
    }
    assert.equal(await read, false);
  });
  assert.deepEqual(h.state().model, currentModel);
  assert.equal(h.state().pending, 'model', 'old completion must not unlock the new write');
  assert.equal(h.state().modelSaveError, null);
  assert.deepEqual(writes, [currentModel.host]);
  await act(async () => {
    currentWrite.resolve({ ...currentModel, modelKey: 'fixture::default' });
    assert.equal(await newSave, true);
  });
  assert.equal(h.state().model?.modelKey, 'fixture::default');
  assert.equal(h.state().pending, null);
});

for (const succeeds of [true, false]) {
  test(`model save ${succeeds ? 'success' : 'failure'} after unmount does not publish state; failures still reach the caller`, async () => {
    const response = deferred<AnalysisModel>();
    let reads = 0;
    const h = harness(services({
      getAnalysisModel: async () => { reads++; return MODEL; },
      setAnalysisModel: async () => response.promise,
    }));
    await h.render();
    let save!: Promise<boolean>;
    await act(async () => { save = h.state().selectModel('fixture::default'); });
    await act(async () => h.root.unmount());
    const renders = h.renderCount();
    await act(async () => {
      if (succeeds) {
        response.resolve({ ...MODEL, modelKey: 'fixture::default' });
        assert.equal(await save, false);
      } else {
        const failure = new Error('late model write failed');
        response.reject(failure);
        await assert.rejects(save, (error) => error === failure);
      }
    });
    assert.equal(h.renderCount(), renders);
    assert.equal(reads, 1);
    assert.deepEqual(h.state().model, MODEL);
  });
}

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
