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
import type { DailyReviewSummary } from '@maka/core/daily-review';
import {
  createFakeModuleHubServices,
  createDailyReviewBridge,
  type DailyReviewController,
  type ModuleHubServices,
  useDailyReviewController,
} from '../../renderer/features/module-hub/testing.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
function summary(sessionCount = 2): DailyReviewSummary {
  return {
    day: { fromMs: Date.UTC(2026, 7, 24), toMs: Date.UTC(2026, 7, 25) },
    totals: {
      sessionCount,
      requestCount: 7,
      totalTokens: 1234,
      costUsd: 0.25,
      errorCount: 0,
    },
    sessions: [],
    topTools: [],
    topModels: [],
  };
}

function dailyReviewService(
  day: ModuleHubServices['dailyReview']['day'],
): ModuleHubServices['dailyReview'] {
  return {
    day,
    runOnce: async () => ({ archiveId: 'archive-1' }),
    listArchives: async () => [],
    getArchive: async () => null,
    saveMarkdownToFile: async () => ({ ok: true, path: '/tmp/review.md' }),
  };
}

test('stable page bridge retries rather than exposing a stale default-Host read', async () => {
  const hostA = { profileId: 'profile-a', hostId: 'host-a' };
  const hostB = { profileId: 'profile-b', hostId: 'host-b' };
  let currentHost = hostA;
  const reads: string[] = [];
  const firstRead = deferred<{ ok: true; data: DailyReviewSummary }>();
  const services = createFakeModuleHubServices({
    runtimeHosts: {
      getDefault: async () => currentHost,
      subscribeChanges: () => () => undefined,
    },
    dailyReview: dailyReviewService(async (_offset, _span, host) => {
      reads.push(host.hostId);
      if (host.hostId === hostA.hostId) return firstRead.promise;
      return { ok: true, data: summary(9) };
    }),
  });
  const bridge = createDailyReviewBridge(services, 'en');
  const pending = bridge.fetchDay(0, 1);

  currentHost = hostB;
  firstRead.resolve({ ok: true, data: summary(1) });

  assert.equal((await pending).totals.sessionCount, 9);
  assert.deepEqual(reads, ['host-a', 'host-b']);
});

test('page bridge keeps the last successful today snapshot through a failed refresh', async () => {
  let fail = false;
  let reads = 0;
  const services = createFakeModuleHubServices({
    dailyReview: dailyReviewService(async () => {
      reads += 1;
      if (fail) throw new Error('offline');
      return { ok: true, data: summary(reads) };
    }),
  });
  const bridge = createDailyReviewBridge(services, 'en');
  assert.equal(bridge.readCachedDay?.(0, 1), undefined);
  const first = await bridge.fetchDay(0, 1);
  assert.equal(bridge.readCachedDay?.(0, 1), first);
  assert.equal(bridge.readCachedDay?.(-1, 1), undefined);
  assert.equal(bridge.readCachedDay?.(0, 7), undefined);
  await bridge.fetchDay(-1, 1);
  assert.equal(bridge.readCachedDay?.(0, 1), first);
  fail = true;
  await assert.rejects(bridge.fetchDay(0, 1), /offline/);
  assert.equal(bridge.readCachedDay?.(0, 1), first);
  fail = false;
  const fresh = await bridge.fetchDay(0, 1);
  assert.equal(bridge.readCachedDay?.(0, 1), fresh);
  assert.equal(reads, 4);
});

test('cancelled and superseded reads cannot overwrite a newer cached summary', async () => {
  const reads = Array.from({ length: 3 }, () => deferred<{ ok: true; data: DailyReviewSummary }>());
  let index = 0;
  const bridge = createDailyReviewBridge(createFakeModuleHubServices({
    dailyReview: dailyReviewService(async () => reads[index++]!.promise),
  }), 'en');
  const oldRead = bridge.fetchDay(0, 1);
  const newRead = bridge.fetchDay(0, 1);
  reads[1]!.resolve({ ok: true, data: summary(8) });
  const fresh = await newRead;
  reads[0]!.resolve({ ok: true, data: summary(1) });
  await oldRead;
  assert.equal(bridge.readCachedDay?.(0, 1), fresh);

  const request = new AbortController();
  const cancelled = bridge.fetchDay(0, 1, request.signal);
  await Promise.resolve();
  request.abort();
  reads[2]!.resolve({ ok: true, data: summary(99) });
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(bridge.readCachedDay?.(0, 1), fresh);
});

test('a new local day cannot reuse yesterday as today or cache an overnight read', async (t) => {
  let now = new Date(2026, 8, 18, 23, 59).getTime();
  t.mock.method(Date, 'now', () => now);
  const pending = deferred<{ ok: true; data: DailyReviewSummary }>();
  let reads = 0;
  const bridge = createDailyReviewBridge(createFakeModuleHubServices({
    dailyReview: dailyReviewService(async () => {
      reads += 1;
      return reads === 1 ? { ok: true, data: summary() } : pending.promise;
    }),
  }), 'en');
  await bridge.fetchDay(0, 1);
  assert.ok(bridge.readCachedDay?.(0, 1));
  const overnight = bridge.fetchDay(0, 1);
  now = new Date(2026, 8, 19, 0, 1).getTime();
  assert.equal(bridge.readCachedDay?.(0, 1), undefined);
  pending.resolve({ ok: true, data: summary(99) });
  await overnight;
  assert.equal(bridge.readCachedDay?.(0, 1), undefined);
});

test('the controller invalidates cached and pending reads on Host changes and disposes its subscription', async () => {
  const { root } = installReactRenderer();
  const hostA = { profileId: 'a', hostId: 'a' };
  const hostB = { profileId: 'b', hostId: 'b' };
  let currentHost = hostA;
  let listener: Parameters<ModuleHubServices['runtimeHosts']['subscribeChanges']>[0] | undefined;
  const pending = deferred<{ ok: true; data: DailyReviewSummary }>();
  let reads = 0;
  const services = createFakeModuleHubServices({
    runtimeHosts: {
      getDefault: async () => currentHost,
      subscribeChanges: (handler) => {
        listener = handler;
        return () => { listener = undefined; };
      },
    },
    dailyReview: dailyReviewService(async () => {
      reads += 1;
      return reads === 2 ? pending.promise : { ok: true, data: summary(reads) };
    }),
  });
  let controller: DailyReviewController | undefined;
  function Probe() {
    controller = useDailyReviewController({
      services, uiLocale: 'en',
      toastApi: { success: () => undefined, error: () => undefined },
      appendComposerText: () => undefined,
      captureActiveComposerClaim: () => undefined,
      isDailyReviewSurfaceActive: () => false,
    });
    return null;
  }
  await act(async () => root.render(createElement(Probe)));
  const bridge = controller!.bridge;
  await bridge.fetchDay(0, 1);
  await act(async () => root.render(createElement(Probe)));
  assert.equal(controller!.bridge, bridge);
  assert.ok(bridge.readCachedDay?.(0, 1));
  const loading = bridge.fetchDay(0, 1);
  await Promise.resolve();
  currentHost = hostB;
  assert.ok(listener);
  listener({ ...hostB, readiness: 'ready', isDefault: true });
  assert.equal(bridge.readCachedDay?.(0, 1), undefined);
  pending.resolve({ ok: true, data: summary(99) });
  await loading;
  assert.equal(bridge.readCachedDay?.(0, 1), undefined);
  const fresh = await bridge.fetchDay(0, 1);
  assert.equal(bridge.readCachedDay?.(0, 1), fresh);
  await act(async () => root.unmount());
  assert.equal(listener, undefined);
  assert.equal(bridge.readCachedDay?.(0, 1), undefined);
});

test('today paste captures its composer claim before reading and drops a late result', async () => {
  const { root } = installReactRenderer();
  const pendingDay = deferred<{ ok: true; data: DailyReviewSummary }>();
  const appended: string[] = [];
  const successes: string[] = [];
  let claimCurrent = true;
  let claims = 0;
  const services = createFakeModuleHubServices({
    dailyReview: dailyReviewService(async () => pendingDay.promise),
  });
  let controller: DailyReviewController | undefined;

  function Probe() {
    controller = useDailyReviewController({
      services,
      uiLocale: 'en',
      toastApi: {
        success: (title) => successes.push(title),
        error: () => undefined,
      },
      appendComposerText: (text) => appended.push(text),
      captureActiveComposerClaim: () => {
        claims += 1;
        return {
          isCurrent: () => claimCurrent,
          append: (text) => appended.push(text),
        };
      },
      isDailyReviewSurfaceActive: () => true,
    });
    return null;
  }

  await act(async () => root.render(createElement(Probe)));
  const bridgeBefore = controller?.bridge;
  await act(async () => root.render(createElement(Probe)));
  assert.equal(controller?.bridge, bridgeBefore);

  let paste!: Promise<void>;
  await act(async () => {
    paste = controller!.pasteToday();
    await Promise.resolve();
  });
  assert.equal(claims, 1);
  claimCurrent = false;
  pendingDay.resolve({ ok: true, data: summary() });
  await act(async () => paste);

  assert.deepEqual(appended, []);
  assert.deepEqual(successes, []);
});

test('today paste rechecks its composer claim after an async failure Host fence', async () => {
  const { root } = installReactRenderer();
  const host = { profileId: 'profile-a', hostId: 'host-a' };
  const finalHostRecheck = deferred<typeof host>();
  const errors: string[] = [];
  let claimCurrent = true;
  let hostReads = 0;
  const services = createFakeModuleHubServices({
    runtimeHosts: {
      getDefault: async () => {
        hostReads += 1;
        return hostReads === 3 ? finalHostRecheck.promise : host;
      },
      subscribeChanges: () => () => undefined,
    },
    dailyReview: dailyReviewService(async () => {
      throw new Error('offline');
    }),
  });
  let controller: DailyReviewController | undefined;

  function Probe() {
    controller = useDailyReviewController({
      services,
      uiLocale: 'en',
      toastApi: {
        success: () => undefined,
        error: (title) => errors.push(title),
      },
      appendComposerText: () => undefined,
      captureActiveComposerClaim: () => ({
        isCurrent: () => claimCurrent,
        append: () => undefined,
      }),
      isDailyReviewSurfaceActive: () => false,
    });
    return null;
  }

  await act(async () => root.render(createElement(Probe)));
  const paste = controller!.pasteToday();
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(hostReads, 3);

  claimCurrent = false;
  finalHostRecheck.resolve(host);
  await act(async () => paste);

  assert.deepEqual(errors, []);
});

test('page actions suppress late feedback after leaving Daily Review', async () => {
  const { root } = installReactRenderer();
  const clipboard = deferred<void>();
  const save = deferred<
    | { ok: true; path: string }
    | { ok: false; reason: 'canceled' | 'write_failed' | 'invalid_input' }
  >();
  let active = true;
  const successes: string[] = [];
  const errors: string[] = [];
  const services = createFakeModuleHubServices({
    dailyReview: {
      ...dailyReviewService(async () => ({ ok: true, data: summary() })),
      saveMarkdownToFile: async () => save.promise,
    },
    clipboard: { writeText: async () => clipboard.promise },
  });
  let controller: DailyReviewController | undefined;

  function Probe() {
    controller = useDailyReviewController({
      services,
      uiLocale: 'en',
      toastApi: {
        success: (title) => successes.push(title),
        error: (title) => errors.push(title),
      },
      appendComposerText: () => undefined,
      captureActiveComposerClaim: () => undefined,
      isDailyReviewSurfaceActive: () => active,
    });
    return null;
  }

  await act(async () => root.render(createElement(Probe)));
  const actionInput = {
    day: summary().day,
    range: 1 as const,
    totals: summary().totals,
    markdown: '# Review',
    label: 'Today',
  };
  // No caller predicate: the controller's live surface predicate is the
  // ownership fence, even if a Host model snapshot was captured before leave.
  const copyPromise = controller!.copyMarkdown(actionInput);
  const savePromise = controller!.saveMarkdown(actionInput);
  active = false;
  clipboard.resolve();
  save.resolve({ ok: true, path: '/tmp/review.md' });
  await act(async () => Promise.all([copyPromise, savePromise]));

  assert.deepEqual(successes, []);
  assert.deepEqual(errors, []);

  // Command Palette ownership is separate from the page surface: its public
  // command still reports success while Daily Review is not selected.
  await act(async () => controller!.saveToday());
  assert.deepEqual(successes, ['Today review saved']);
});

test('current default-Host Daily Review failures retain their diagnostic target', async () => {
  const { root } = installReactRenderer();
  const errors: Array<{ title: string; profileId?: string }> = [];
  const services = createFakeModuleHubServices({
    runtimeHosts: {
      getDefault: async () => ({
        profileId: 'remote-profile',
        hostId: 'remote-host',
      }),
      subscribeChanges: () => () => undefined,
    },
    dailyReview: dailyReviewService(async () => {
      throw new Error('offline');
    }),
  });
  let controller: DailyReviewController | undefined;

  function Probe() {
    controller = useDailyReviewController({
      services,
      uiLocale: 'en',
      toastApi: {
        success: () => undefined,
        error: (title, _description, _details, target) =>
          errors.push({
            title,
            profileId:
              target && 'profileId' in target ? target.profileId : undefined,
          }),
      },
      appendComposerText: () => undefined,
      captureActiveComposerClaim: () => undefined,
      isDailyReviewSurfaceActive: () => false,
    });
    return null;
  }

  await act(async () => root.render(createElement(Probe)));
  await act(async () => controller!.copyToday());

  assert.deepEqual(errors, [
    { title: 'Copy failed', profileId: 'remote-profile' },
  ]);
});

afterEach(() => cleanupFakeDom());
