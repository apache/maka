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
import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from '@maka/ui';
import { ArchiveRetentionNotices, StorageUsageServicesProvider } from '../../renderer/features/storage-usage/index.js';
import type { StorageRetentionQueryResult } from '@maka/runtime-host/protocol';
import type { StorageUsageServices } from '../../renderer/features/storage-usage/index.js';
import type { RetentionNoticeHost, RetentionNoticeState } from '../../renderer/features/storage-usage/index.js';
import { createDesktopStorageUsageServices } from '../../renderer/platform/desktop/create-storage-usage-services.js';
import {
  acknowledgeRetentionResults,
  decodeRetentionNoticeState,
  observeRetentionNotices,
  RETENTION_NOTICE_COOLDOWN_MS,
  RETENTION_NOTICE_POLL_MS,
} from '../../renderer/features/storage-usage/testing.js';

const HOST = { profileId: 'p1', hostId: 'h1', name: 'Laptop' };
const RESULT: StorageRetentionQueryResult = { enabled: true, revision: 1, days: 30, enabledAt: 0, preview: { count: 0 } };
const stops: Array<() => void> = [];
afterEach(() => { while (stops.length) stops.pop()?.(); });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function rig(persisted = new Map<string, RetentionNoticeState>()) {
  let change = () => {};
  let timer: (() => void) | undefined;
  let time = 1_000_000;
  let visible = true;
  let hosts: readonly RetentionNoticeHost[] = [HOST];
  let result = RESULT;
  let load: (host: RetentionNoticeHost) => Promise<StorageRetentionQueryResult> = async () => result;
  let reads = 0;
  let unsubscribed = false;
  const shown: Array<{ host: RetentionNoticeHost; kind: string; count?: number; dismissed: boolean }> = [];
  const writes: RetentionNoticeState[] = [];
  const services: StorageUsageServices & { notices: NonNullable<StorageUsageServices['notices']> } = {
    loadUsage: async () => assert.fail('usage must not be scanned'),
    loadSessionUsage: async () => assert.fail('per-task sizes must not be scanned'),
    setRetention: async () => assert.fail('observing must never change retention'),
    loadRetention: async (host) => { reads += 1; return load(host as RetentionNoticeHost); },
    notices: {
      loadHosts: async () => hosts,
      subscribeChanges: (handler) => { change = handler; return () => { unsubscribed = true; }; },
      isVisible: () => visible,
      readSeen: (id) => persisted.get(id),
      writeSeen: (id, state) => { persisted.set(id, state); writes.push(state); },
    },
  };
  const stop = observeRetentionNotices({
    services,
    now: () => time,
    notify: (host, notice) => {
      const item = { host, kind: notice.kind, ...(notice.kind === 'deletion' ? { count: notice.deletion.count } : {}), dismissed: false };
      shown.push(item);
      return () => { item.dismissed = true; };
    },
    schedule: (callback, delay) => {
      assert.equal(delay, RETENTION_NOTICE_POLL_MS);
      timer = callback;
      return () => { if (timer === callback) timer = undefined; };
    },
  });
  stops.push(stop);
  return {
    services, shown, writes, persisted, stop,
    setResult: (next: StorageRetentionQueryResult) => { result = next; },
    setLoad: (next: typeof load) => { load = next; },
    setHosts: (next: typeof hosts) => { hosts = next; change(); },
    setVisible: (next: boolean) => { visible = next; change(); },
    advance: (ms: number) => { time += ms; },
    poll: async () => { const callback = timer; assert.ok(callback); timer = undefined; callback(); await settle(); },
    get reads() { return reads; },
    get stopped() { return unsubscribed && timer === undefined; },
  };
}

test('announces the latest cleanup once per Host, including after an observer restart', async () => {
  const r = rig();
  r.setResult({ ...RESULT, lastDeletion: { at: 100, count: 8, bytes: 4096 } });
  await settle();
  assert.deepEqual(r.shown.map((n) => [n.host.hostId, n.kind, n.count]), [['h1', 'deletion', 8]]);
  await r.poll();
  assert.equal(r.shown.length, 1);
  assert.equal(r.writes.length, 1);
  r.stop();
  const restarted = rig(r.persisted);
  restarted.setResult({ ...RESULT, lastDeletion: { at: 100, count: 8 } });
  await settle();
  assert.equal(restarted.shown.length, 0);
});

test('coalesces successive cleanup batches without acknowledging unseen results', async () => {
  const r = rig();
  r.setResult({ ...RESULT, lastDeletion: { at: 100, count: 8 } });
  await settle();
  r.setResult({ ...RESULT, lastDeletion: { at: 200, count: 3 } });
  r.advance(RETENTION_NOTICE_POLL_MS);
  await r.poll();
  assert.equal(r.shown.length, 1);
  assert.equal(r.persisted.get('h1')?.deletionAt, 100);
  r.advance(RETENTION_NOTICE_COOLDOWN_MS);
  await r.poll();
  assert.deepEqual(r.shown.map((n) => n.count), [8, 3]);
  assert.equal(r.persisted.get('h1')?.deletionAt, 200);
});

test('warnings bypass cleanup cooldown, deduplicate, and disappear when the Host clears them', async () => {
  const r = rig();
  r.setResult({ ...RESULT, lastDeletion: { at: 100, count: 1 } });
  await settle();
  const hold = { since: 100, detectedAt: 200, until: 300 };
  r.setResult({ ...RESULT, hold });
  await r.poll();
  await r.poll();
  assert.deepEqual(r.shown.map((n) => n.kind), ['deletion', 'hold']);
  r.setResult({ ...RESULT, hold: { ...hold, detectedAt: 250, until: 350 } });
  await r.poll();
  assert.equal(r.shown[1]!.dismissed, true);
  assert.equal(r.shown[2]!.dismissed, false);
  r.setResult(RESULT);
  await r.poll();
  assert.equal(r.shown[2]!.dismissed, true);
});

test('reports backward-clock pauses and clears the warning when retention is disabled', async () => {
  const r = rig();
  const lastSweep = { at: 50, deleted: 0, skippedBusy: 0, needsReview: 0, failed: 0, paused: true as const };
  r.setResult({ ...RESULT, lastSweep });
  await settle();
  assert.deepEqual(r.shown.map((n) => n.kind), ['paused']);
  r.setResult({ ...RESULT, enabled: false, lastSweep });
  await r.poll();
  assert.equal(r.shown[0]!.dismissed, true);
  assert.equal(r.shown.length, 1);
});

test('Settings acknowledges displayed results even when the observer has cached an older result', async () => {
  const r = rig();
  r.setResult({ ...RESULT, lastDeletion: { at: 100, count: 1 } });
  await settle();
  const newer = { ...RESULT, lastDeletion: { at: 200, count: 4 }, hold: { since: 100, detectedAt: 300, until: 400 } };
  acknowledgeRetentionResults(r.services, HOST, newer);
  r.setResult(newer);
  r.advance(RETENTION_NOTICE_COOLDOWN_MS);
  await r.poll();
  assert.equal(r.shown.length, 1);
});

test('Settings acknowledgement withdraws an already-visible warning without treating its first announcement as acknowledgement', async () => {
  const r = rig();
  const held = { ...RESULT, hold: { since: 100, detectedAt: 200, until: 300 } };
  r.setResult(held);
  await settle();
  await r.poll();
  assert.equal(r.shown.length, 1);
  assert.equal(r.shown[0]!.dismissed, false);
  acknowledgeRetentionResults(r.services, HOST, held);
  await r.poll();
  assert.equal(r.shown[0]!.dismissed, true);
  assert.equal(r.shown.length, 1);
});

test('disabled Hosts back off across focus changes and are checked again after fifteen minutes', async () => {
  const r = rig();
  r.setResult({ ...RESULT, enabled: false });
  await settle();
  for (let minute = 1; minute < 15; minute += 1) {
    r.advance(RETENTION_NOTICE_POLL_MS);
    await r.poll();
    r.setVisible(false);
    await settle();
    r.setVisible(true);
    await settle();
  }
  assert.equal(r.reads, 1);
  r.setResult({ ...RESULT, hold: { since: 100, detectedAt: 200, until: 300 } });
  r.advance(RETENTION_NOTICE_POLL_MS);
  await r.poll();
  assert.equal(r.reads, 2);
  assert.equal(r.shown[0]!.kind, 'hold');
  await r.poll();
  assert.equal(r.reads, 3);
});

test('does not read or acknowledge results while hidden and catches up on visibility change', async () => {
  const r = rig();
  r.setVisible(false);
  r.setResult({ ...RESULT, lastDeletion: { at: 100, count: 2 } });
  await settle();
  assert.equal(r.reads, 0);
  assert.equal(r.writes.length, 0);
  await r.poll();
  assert.equal(r.reads, 0);
  r.setVisible(true);
  await settle();
  assert.equal(r.shown.length, 1);
});

test('a disconnected Host does not hide results from another Host, and duplicate profiles are read once', async () => {
  const r = rig();
  const second = { profileId: 'p2', hostId: 'h2', name: 'Server' };
  r.setHosts([HOST, second, { ...second, profileId: 'alias' }]);
  r.setLoad(async (host) => {
    if (host.hostId === 'h1') throw new Error('disconnected');
    return { ...RESULT, lastDeletion: { at: 100, count: 1 } };
  });
  await settle();
  assert.deepEqual(r.shown.map((n) => n.host), [second]);
  assert.equal(r.reads, 2);
});

test('removing a Host during an in-flight query discards its result and retires its warning', async () => {
  const r = rig();
  r.setResult({ ...RESULT, hold: { since: 100, detectedAt: 200, until: 300 } });
  await settle();
  let finish!: (result: StorageRetentionQueryResult) => void;
  r.setLoad(() => new Promise((resolve) => { finish = resolve; }));
  const pending = r.poll();
  await settle();
  r.setHosts([]);
  finish({ ...RESULT, lastDeletion: { at: 500, count: 8 } });
  await pending;
  await settle();
  assert.equal(r.shown.length, 1);
  assert.equal(r.shown[0]!.dismissed, true);
  assert.equal(r.persisted.get('h1')?.deletionAt, undefined);
});

test('disposing during discovery prevents late notices and leaves no subscription or timer', async () => {
  const r = rig();
  r.setResult({ ...RESULT, lastDeletion: { at: 100, count: 8 } });
  r.stop();
  await settle();
  assert.equal(r.shown.length, 0);
  assert.equal(r.writes.length, 0);
  assert.equal(r.stopped, true);
});

test('corrupt persisted state cannot suppress cleanup indefinitely', () => {
  for (const value of [null, [], 123, { deletionAt: -1, notifiedAt: Infinity, warning: 5 }]) {
    assert.deepEqual(decodeRetentionNoticeState(value), {});
  }
  assert.deepEqual(decodeRetentionNoticeState({ deletionAt: 0, notifiedAt: 3, warning: 'hold:1' }), { deletionAt: 0, notifiedAt: 3, warning: 'hold:1' });
});

test('Desktop events ignore blur, refresh on acknowledgement, and unsubscribe cleanly', () => {
  const keys = ['document', 'window', 'localStorage'] as const;
  const descriptors = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible', hasFocus: () => true });
  const window = new EventTarget();
  const stored = new Map<string, string>();
  const localStorage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } };
  let changes = 0;
  let unsubscribed = false;
  let stop = () => {};
  try {
    for (const [key, value] of Object.entries({ document, window, localStorage })) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    const notices = createDesktopStorageUsageServices({
      storage: {
        usage: async () => assert.fail('no storage query expected'),
        sessionUsage: async () => assert.fail('no storage query expected'),
        retention: async () => assert.fail('no storage query expected'),
        setRetention: async () => assert.fail('no policy change expected'),
      },
      runtimeHostProfiles: {
        getSnapshot: async () => assert.fail('no discovery expected'),
        subscribeChanges: () => () => { unsubscribed = true; },
      },
    }).notices!;
    stop = notices.subscribeChanges(() => { changes += 1; });
    window.dispatchEvent(new Event('blur'));
    assert.equal(changes, 0);
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(changes, 2);
    const announced = { warning: 'hold:1' };
    notices.writeSeen('h1', announced);
    assert.equal(changes, 2);
    const acknowledged = { ...announced, acknowledgedWarning: announced.warning };
    notices.writeSeen('h1', acknowledged);
    assert.equal(changes, 3);
    assert.deepEqual(notices.readSeen('h1'), acknowledged);
    notices.writeSeen('h1', acknowledged);
    assert.equal(changes, 3);
    stop();
    assert.equal(unsubscribed, true);
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    notices.writeSeen('h1', { warning: 'hold:2', acknowledgedWarning: 'hold:2' });
    assert.equal(changes, 3);
  } finally {
    stop();
    keys.forEach((key, index) => {
      const descriptor = descriptors[index];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});


test('same-name Hosts keep separate notices and open their own archived tasks in all locales', async () => {
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    HTMLElement: globalThis.HTMLElement,
    getComputedStyle: globalThis.getComputedStyle,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  };
  try {
    for (const locale of ['en', 'zh-CN', 'zh-TW'] as const) {
      const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
      Object.assign(window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) });
      Object.assign(globalThis, {
        document, window, HTMLElement: window.HTMLElement,
        getComputedStyle: () => ({ color: 'currentColor' }), IS_REACT_ACT_ENVIRONMENT: true,
      });
      const r = rig();
      r.stop();
      r.setHosts([HOST, { ...HOST, profileId: 'p2', hostId: 'h2' }]);
      r.setResult({ ...RESULT, lastDeletion: { at: 100, count: 3, bytes: 2048 } });
      const opened: string[] = [];
      const container = document.getElementById('root') as unknown as HTMLElement;
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(createElement(LocaleProvider, { locale, children: createElement(AstryxLocaleProvider, {
            children: createElement(ToastProvider, { children: createElement(StorageUsageServicesProvider, {
              services: r.services,
              children: createElement(ArchiveRetentionNotices, { navigation: {
                setSettingsProfileId: (id) => { opened.push(id); },
                openSettingsSection: (section) => { opened.push(section); },
              } }),
            }) }),
          }) }));
          await settle();
        });
        assert.ok(document.body.textContent?.includes('Laptop'));
        assert.ok(document.body.textContent?.includes('3'));
        const actions = Array.from(document.querySelectorAll('button')).filter((button) => /View archived tasks|查看已归档任务|檢視已歸檔任務/.test(button.textContent ?? ''));
        assert.equal(actions.length, 2, document.body.textContent ?? 'missing notice');
        for (const action of actions) await act(async () => { action.click(); });
        assert.deepEqual(opened, ['p1', 'archived-tasks', 'p2', 'archived-tasks']);
      } finally {
        await act(async () => root.unmount());
      }
    }
  } finally {
    Object.assign(globalThis, previous);
  }
});
