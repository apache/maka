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
