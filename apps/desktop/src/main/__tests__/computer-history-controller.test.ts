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
import type {
  ComputerHistoryDetail,
  ComputerHistoryStatus,
  ComputerHistoryTimeline,
  ComputerHistoryTimelineEntry,
} from '@maka/core/computer-history';
import {
  createFakeComputerHistoryAnalysisModel,
  createFakeModuleHubServices,
  ModuleHubServicesProvider,
  useComputerHistoryController,
  type ModuleHubServices,
} from '../../renderer/features/module-hub/testing.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

const STATUS: ComputerHistoryStatus = {
  platformSupported: true, helperAvailable: true, state: 'paused',
  accessibilityGranted: true, inputMonitoringGranted: true,
  eventCount: 2, suppressedEventCount: 0, segmentCount: 1,
  settings: { enabled: true, captureText: false, summariesEnabled: false, summaryTextEnabled: false, blockedApplications: [], blockedDomains: [] },
};

function entry(id: string): ComputerHistoryTimelineEntry {
  return {
    id, title: `Activity ${id}`, description: 'Observed metadata',
    start: '2026-09-13T10:00:00Z', end: '2026-09-13T10:10:00Z',
    applications: ['com.example.App'], eventCount: 1, suppressedEventCount: 0,
    contextMarkdown: `<computer-history-context trust="untrusted-observed-ui">${id}</computer-history-context>`,
  };
}

function detail(id: string): ComputerHistoryDetail {
  return { entry: entry(id), events: [], eventTotal: 0, rawAvailable: false, truncated: false };
}

function services(overrides: Partial<ModuleHubServices['computerHistory']> = {}): ModuleHubServices {
  const defaults = createFakeModuleHubServices();
  return createFakeModuleHubServices({
    computerHistory: {
      ...defaults.computerHistory,
      status: async () => STATUS,
      applications: async (bundleIds) => bundleIds.map((bundleIdentifier) => ({ bundleIdentifier, name: 'Example App', iconDataUrl: null })),
      timeline: async () => ({ status: STATUS, entries: [entry('a'), entry('b')] }),
      detail: async (id) => detail(id),
      getAnalysisModel: async () => createFakeComputerHistoryAnalysisModel({
        modelKey: 'fixture-analysis-model',
        models: [{ key: 'fixture-analysis-model', label: 'Fixture analysis model', connectionName: 'Fixture' }],
      }),
      ...overrides,
    },
  });
}

type Controller = ReturnType<typeof useComputerHistoryController>;

function harness(service: ModuleHubServices) {
  const { root } = installReactRenderer();
  let current: Controller | undefined;
  let renders = 0;
  function Probe({ selectedId }: { selectedId: string | null }) {
    current = useComputerHistoryController(selectedId);
    renders += 1;
    return null;
  }
  return {
    root,
    render(selectedId: string | null, nextService = service) {
      root.render(createElement(ModuleHubServicesProvider, { services: nextService }, createElement(Probe, { selectedId })));
    },
    controller() {
      assert.ok(current);
      return current;
    },
    renderCount: () => renders,
  };
}

test('late detail error cannot replace the newly selected activity', async () => {
  const oldRead = deferred<ComputerHistoryDetail>();
  const newerRead = deferred<ComputerHistoryDetail>();
  const h = harness(services({
    detail: async (id) => id === 'a' ? oldRead.promise : newerRead.promise,
  }));
  await act(async () => h.render('a'));
  assert.equal(h.controller().detailLoading, true);
  await act(async () => h.render('b'));
  newerRead.resolve(detail('b'));
  await act(async () => newerRead.promise);
  assert.equal(h.controller().detail?.entry.id, 'b');
  assert.equal(h.controller().detailLoading, false);
  oldRead.reject(new Error('old activity read failed'));
  await act(async () => { await oldRead.promise.catch(() => {}); });
  assert.equal(h.controller().detail?.entry.id, 'b');
  assert.equal(h.controller().detailError, null);
});

test('synchronous duplicate mutations invoke the service once and remain busy until refresh completes', async () => {
  const write = deferred<ComputerHistoryStatus>();
  const readback = deferred<ComputerHistoryTimeline>();
  let timelineReads = 0;
  let writes = 0;
  const service = services({
    timeline: async () => ++timelineReads === 1
      ? { status: STATUS, entries: [entry('a')] }
      : readback.promise,
    clear: async () => { writes += 1; return write.promise; },
  });
  const h = harness(service);
  await act(async () => h.render('a'));
  let first!: Promise<boolean>;
  let duplicate!: Promise<boolean>;
  await act(async () => {
    first = h.controller().run(() => service.computerHistory.clear('all'));
    duplicate = h.controller().run(() => service.computerHistory.clear('all'));
  });
  assert.equal(await duplicate, false);
  assert.equal(writes, 1);
  assert.equal(h.controller().busy, true);
  assert.equal(h.controller().detail, null);
  write.resolve({ ...STATUS, eventCount: 0 });
  await act(async () => { await write.promise; });
  assert.equal(h.controller().busy, true);
  readback.resolve({ status: { ...STATUS, eventCount: 0 }, entries: [] });
  await act(async () => assert.equal(await first, true));
  assert.equal(h.controller().busy, false);
  assert.deepEqual(h.controller().entries, []);
});

test('unmount cancels polling and prevents pending read results from being published', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const read = deferred<ComputerHistoryTimeline>();
  const eventRead = deferred<ComputerHistoryDetail>();
  let reads = 0;
  const h = harness(services({
    timeline: async () => { reads += 1; return read.promise; },
    detail: async () => eventRead.promise,
  }));
  await act(async () => h.render('a'));
  await act(async () => h.root.unmount());
  const renders = h.renderCount();
  read.resolve({ status: STATUS, entries: [entry('a')] });
  eventRead.resolve(detail('a'));
  await act(async () => { await Promise.all([read.promise, eventRead.promise]); });
  await act(async () => t.mock.timers.tick(60_000));
  assert.equal(h.renderCount(), renders);
  assert.equal(reads, 1);
  assert.equal(h.controller().detail, null);
  assert.deepEqual(h.controller().entries, []);
});

test('a pending mutation resolving after unmount does not refresh or report completion', async () => {
  const write = deferred<ComputerHistoryStatus>();
  let reads = 0;
  const service = services({
    timeline: async () => { reads += 1; return { status: STATUS, entries: [entry('a')] }; },
    deleteEntry: async () => write.promise,
  });
  const h = harness(service);
  await act(async () => h.render('a'));
  let deletion!: Promise<boolean>;
  await act(async () => { deletion = h.controller().run(() => service.computerHistory.deleteEntry('a')); });
  await act(async () => h.root.unmount());
  write.resolve(STATUS);
  await act(async () => assert.equal(await deletion, false));
  assert.equal(reads, 1);
});

test('corrupt timeline keeps independently read status and permits clear-all recovery', async () => {
  let corrupt = true;
  let currentStatus = STATUS;
  const scopes: string[] = [];
  const service = services({
    status: async () => currentStatus,
    timeline: async () => {
      if (corrupt) throw new Error('corrupt summary archive');
      return { status: currentStatus, entries: [] };
    },
    clear: async (scope) => {
      scopes.push(scope);
      corrupt = false;
      currentStatus = { ...STATUS, eventCount: 0 };
      return currentStatus;
    },
  });
  const h = harness(service);
  await act(async () => h.render(null));
  assert.equal(h.controller().error, 'corrupt summary archive');
  assert.equal(h.controller().status?.state, 'paused');
  assert.equal(h.controller().loading, false);
  await act(async () => assert.equal(await h.controller().run(() => service.computerHistory.clear('all')), true));
  assert.deepEqual(scopes, ['all']);
  assert.equal(h.controller().error, null);
  assert.equal(h.controller().status?.eventCount, 0);
  assert.deepEqual(h.controller().entries, []);
});

test('a stale refresh cannot restore an activity after deletion refresh completes', async () => {
  const stale = deferred<ComputerHistoryTimeline>();
  let reads = 0;
  const service = services({
    timeline: async () => {
      reads += 1;
      if (reads === 2) return stale.promise;
      return { status: STATUS, entries: reads === 1 ? [entry('a')] : [] };
    },
    deleteEntry: async () => STATUS,
  });
  const h = harness(service);
  await act(async () => h.render(null));
  let pendingRefresh!: Promise<void>;
  await act(async () => { pendingRefresh = h.controller().refresh(); });
  await act(async () => { await h.controller().run(() => service.computerHistory.deleteEntry('a')); });
  assert.deepEqual(h.controller().entries, []);
  stale.resolve({ status: STATUS, entries: [entry('a')] });
  await act(async () => pendingRefresh);
  assert.deepEqual(h.controller().entries, []);
});

for (const deletionSucceeds of [true, false]) {
  test(`deletion ${deletionSucceeds ? 'success invalidates cached entries even when readback fails' : 'failure retains cached entries without readback'}`, async () => {
    const write = deferred<ComputerHistoryStatus>();
    const readback = deferred<ComputerHistoryTimeline>();
    let reads = 0;
    const deletedIds: string[] = [];
    const service = services({
      timeline: async () => ++reads === 1
        ? { status: STATUS, entries: [entry('a'), entry('b')] }
        : readback.promise,
      deleteEntry: async (id) => { deletedIds.push(id); return write.promise; },
    });
    const h = harness(service);
    await act(async () => h.render(null));
    let deletion!: Promise<boolean>;
    await act(async () => { deletion = h.controller().run(() => service.computerHistory.deleteEntry('a')); });
    assert.deepEqual(deletedIds, ['a']);
    assert.equal(h.controller().busy, true);
    assert.deepEqual(h.controller().entries.map(({ id }) => id), ['a', 'b'], 'pending deletion has not invalidated the cache');
    if (deletionSucceeds) {
      await act(async () => {
        write.resolve(STATUS);
        await write.promise;
      });
      assert.equal(reads, 2);
      assert.equal(h.controller().busy, true);
      assert.deepEqual(h.controller().entries, [], 'successful destructive changes invalidate entries before readback settles');
      await act(async () => {
        readback.reject(new Error('post-deletion archive unavailable'));
        assert.equal(await deletion, true, 'the deletion succeeded even though refreshing failed');
      });
      assert.deepEqual(h.controller().entries, []);
      assert.equal(h.controller().error, 'post-deletion archive unavailable');
    } else {
      await act(async () => {
        write.reject(new Error('deletion denied'));
        assert.equal(await deletion, false);
      });
      assert.equal(reads, 1, 'a failed mutation does not issue a post-deletion read');
      assert.deepEqual(h.controller().entries.map(({ id }) => id), ['a', 'b']);
      assert.equal(h.controller().error, 'deletion denied');
    }
    assert.equal(h.controller().busy, false);
    assert.equal(h.controller().loading, false);
  });
}

afterEach(() => cleanupFakeDom());

test('background polling retains selected evidence without a skeleton and exposes a fresh read error', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const nextTimeline = deferred<ComputerHistoryTimeline>();
  const nextDetail = deferred<ComputerHistoryDetail>();
  const failedDetail = deferred<ComputerHistoryDetail>();
  let reads = 0;
  let eventReads = 0;
  const h = harness(services({
    timeline: async () => ++reads === 2 ? nextTimeline.promise : { status: STATUS, entries: [entry('a')] },
    detail: async () => {
      eventReads += 1;
      if (reads < 2) return detail('a');
      return reads === 2 ? nextDetail.promise : failedDetail.promise;
    },
  }));
  await act(async () => h.render('a'));
  const original = h.controller().detail;
  assert.equal(original?.entry.id, 'a');
  await act(async () => t.mock.timers.tick(15_000));
  assert.equal(h.controller().loading, false);
  assert.equal(h.controller().detailLoading, false);
  assert.equal(h.controller().detail, original);
  const priorEventReads = eventReads;
  nextTimeline.resolve({ status: STATUS, entries: [entry('a')] });
  await act(async () => nextTimeline.promise);
  assert.ok(eventReads > priorEventReads);
  assert.equal(h.controller().detailLoading, false);
  assert.equal(h.controller().detail, original);
  const updated = { ...detail('a'), eventTotal: 3 };
  nextDetail.resolve(updated);
  await act(async () => nextDetail.promise);
  assert.equal(h.controller().detail, updated);
  await act(async () => t.mock.timers.tick(15_000));
  failedDetail.reject(new Error('fresh evidence is unavailable'));
  await act(async () => { await failedDetail.promise.catch(() => {}); });
  assert.equal(h.controller().detail, updated);
  assert.equal(h.controller().detailLoading, false);
  assert.equal(h.controller().detailError, 'fresh evidence is unavailable');
});

test('failed mutation releases loading after invalidating a pending refresh', async () => {
  const pending = deferred<ComputerHistoryTimeline>();
  let reads = 0;
  const h = harness(services({
    timeline: async () => ++reads === 1 ? { status: STATUS, entries: [entry('a')] } : pending.promise,
  }));
  await act(async () => h.render('a'));
  let refresh!: Promise<void>;
  await act(async () => { refresh = h.controller().refresh(); });
  assert.equal(h.controller().loading, true);
  await act(async () => {
    assert.equal(await h.controller().run(async () => { throw new Error('delete denied'); }), false);
  });
  assert.equal(h.controller().busy, false);
  assert.equal(h.controller().loading, false);
  assert.equal(h.controller().error, 'delete denied');
  pending.resolve({ status: STATUS, entries: [entry('stale')] });
  await act(async () => refresh);
  assert.deepEqual(h.controller().entries.map((value) => value.id), ['a']);
  assert.equal(h.controller().error, 'delete denied');
});

for (const completion of ['success', 'failure'] as const) {
  test(`old service mutation ${completion} cannot refresh or unlock a new service operation`, async () => {
    const oldWrite = deferred<void>();
    const newWrite = deferred<void>();
    let oldReads = 0;
    let newReads = 0;
    const oldService = services({
      timeline: async () => { oldReads += 1; return { status: STATUS, entries: [entry('old')] }; },
    });
    const newService = services({
      timeline: async () => { newReads += 1; return { status: STATUS, entries: [entry('new')] }; },
    });
    const h = harness(oldService);
    await act(async () => h.render('old'));
    const oldRun = h.controller().run;
    let oldOperation!: Promise<boolean>;
    await act(async () => { oldOperation = oldRun(() => oldWrite.promise); });
    await act(async () => h.render('new', newService));
    assert.equal(h.controller().busy, false);
    assert.equal(h.controller().detail?.entry.id, 'new');
    let newOperation!: Promise<boolean>;
    await act(async () => { newOperation = h.controller().run(() => newWrite.promise); });
    if (completion === 'success') oldWrite.resolve();
    else oldWrite.reject(new Error('old service failure'));
    await act(async () => assert.equal(await oldOperation, false));
    assert.equal(h.controller().busy, true);
    assert.equal(h.controller().error, null);
    assert.deepEqual(h.controller().entries.map((value) => value.id), ['new']);
    assert.equal(oldReads, 1);
    assert.equal(newReads, 1);
    await act(async () => {
      assert.equal(await h.controller().run(async () => assert.fail('duplicate new operation')), false);
    });
    newWrite.resolve();
    await act(async () => assert.equal(await newOperation, true));
    assert.equal(newReads, 2);
    assert.equal(h.controller().busy, false);
    await act(async () => {
      assert.equal(await oldRun(async () => assert.fail('obsolete callback invoked a service')), false);
    });
  });
}

test('late old-service reads cannot overwrite the new service after a switch', async () => {
  const oldTimeline = deferred<ComputerHistoryTimeline>();
  const oldDetail = deferred<ComputerHistoryDetail>();
  const h = harness(services({
    timeline: async () => oldTimeline.promise,
    detail: async () => oldDetail.promise,
  }));
  await act(async () => h.render('a'));
  await act(async () => h.render('b', services({
    status: async () => ({ ...STATUS, state: 'running' }),
    timeline: async () => ({ status: { ...STATUS, state: 'running' }, entries: [entry('b')] }),
  })));
  oldTimeline.resolve({ status: STATUS, entries: [entry('a')] });
  oldDetail.resolve(detail('a'));
  await act(async () => { await Promise.all([oldTimeline.promise, oldDetail.promise]); });
  assert.equal(h.controller().status?.state, 'running');
  assert.deepEqual(h.controller().entries.map((value) => value.id), ['b']);
  assert.equal(h.controller().detail?.entry.id, 'b');
});

test('no selection skips details and clearing selection abandons a pending result', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const pending = deferred<ComputerHistoryDetail>();
  let eventReads = 0;
  const h = harness(services({
    detail: async () => { eventReads += 1; return pending.promise; },
  }));
  await act(async () => h.render(null));
  await act(async () => t.mock.timers.tick(15_000));
  assert.equal(eventReads, 0);
  await act(async () => h.render('a'));
  assert.equal(eventReads, 1);
  await act(async () => h.render(null));
  pending.resolve(detail('a'));
  await act(async () => pending.promise);
  assert.equal(h.controller().detail, null);
  assert.equal(h.controller().detailLoading, false);
  assert.equal(h.controller().detailError, null);
});

test('viewing and refreshing history do not depend on the analysis model settings', async () => {
  let modelReads = 0;
  const h = harness(services({
    getAnalysisModel: async () => {
      modelReads += 1;
      throw new Error('model settings unavailable');
    },
  }));
  await act(async () => h.render('a'));
  await act(async () => h.controller().refresh());
  assert.equal(modelReads, 0);
  assert.equal(h.controller().error, null);
  assert.equal(h.controller().detail?.entry.id, 'a');
  assert.deepEqual(h.controller().entries.map((value) => value.id), ['a', 'b']);
});

test('recording controls preserve the open document until refreshed evidence arrives', async () => {
  const write = deferred<void>();
  const readback = deferred<ComputerHistoryTimeline>();
  const evidence = deferred<ComputerHistoryDetail>();
  let reads = 0;
  const h = harness(services({
    status: async () => reads === 1 ? STATUS : { ...STATUS, state: 'running' },
    timeline: async () => ++reads === 1
      ? { status: STATUS, entries: [entry('a')] }
      : readback.promise,
    detail: async () => reads === 1 ? detail('a') : evidence.promise,
  }));
  await act(async () => h.render('a'));
  const original = h.controller().detail;
  let operation!: Promise<boolean>;
  await act(async () => {
    operation = h.controller().run(() => write.promise, { preserveDetail: true });
  });
  assert.equal(h.controller().busy, true);
  assert.equal(h.controller().detail, original);
  assert.equal(h.controller().detailLoading, false);
  write.resolve();
  await act(async () => write.promise);
  assert.equal(h.controller().detail, original);
  readback.resolve({ status: { ...STATUS, state: 'running' }, entries: [entry('a')] });
  await act(async () => assert.equal(await operation, true));
  assert.equal(h.controller().busy, false);
  assert.equal(h.controller().status?.state, 'running');
  assert.equal(h.controller().detail, original);
  assert.equal(h.controller().detailLoading, false);
  evidence.resolve({ ...detail('a'), eventTotal: 4 });
  await act(async () => evidence.promise);
  assert.equal(h.controller().detail?.eventTotal, 4);
});
