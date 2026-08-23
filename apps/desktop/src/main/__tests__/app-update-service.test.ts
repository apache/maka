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
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';
import type { AppUpdater } from 'electron-updater';
import {
  createAppUpdateService,
  resolveUpdateFeedOverride,
  type AppUpdateInstallRequest,
  type AppUpdateStatus,
} from '../app-update-service.js';

const FIRST_UPDATE_CHECK_DELAY_MS = 10_000;
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

type Timer = {
  callback: () => void;
  delayMs: number;
  cleared: boolean;
};

class FakeClock {
  readonly timers: Timer[] = [];

  setTimeout = (callback: () => void, delayMs: number): Timer => {
    const timer = { callback, delayMs, cleared: false };
    this.timers.push(timer);
    return timer;
  };

  clearTimeout = (handle: unknown): void => {
    (handle as Timer).cleared = true;
  };

  pending(): Timer[] {
    return this.timers.filter((timer) => !timer.cleared);
  }

  async runNext(): Promise<void> {
    const timer = this.pending()[0];
    assert.ok(timer, 'expected a pending timer');
    timer.cleared = true;
    timer.callback();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  logger: unknown = console;
  checkCalls = 0;
  downloadCalls = 0;
  quitAndInstallCalls = 0;
  quitAndInstallThrows = false;
  quitAndInstallDispatchError = false;
  onQuitAndInstall: (() => void) | undefined;
  feed: unknown;
  setFeedURLCalls = 0;
  checkResult: Promise<unknown> | undefined;

  setFeedURL(input: unknown): void {
    this.setFeedURLCalls += 1;
    this.feed = input;
  }

  async checkForUpdates(): Promise<unknown> {
    this.checkCalls += 1;
    this.emit('checking-for-update');
    if (this.checkResult) return this.checkResult;
    this.emit('update-not-available', updateInfo('1.0.0'));
    return { isUpdateAvailable: false };
  }

  async downloadUpdate(): Promise<string[]> {
    this.downloadCalls += 1;
    return [];
  }

  quitAndInstall(): void {
    this.onQuitAndInstall?.();
    this.quitAndInstallCalls += 1;
    if (this.quitAndInstallThrows) throw new Error('install failed');
    if (this.quitAndInstallDispatchError) this.emit('error', new Error('install rejected'));
  }
}

function updateInfo(version: string) {
  return {
    version,
    files: [],
    path: '',
    sha512: '',
    releaseDate: '2026-08-03T00:00:00.000Z',
  };
}

function createHarness(input: {
  isPackaged?: boolean;
  updater?: FakeUpdater;
  clock?: FakeClock;
  onStatusChange?: (status: AppUpdateStatus) => void;
  activeTasks?: boolean;
  prepareInstall?: (
    input: AppUpdateInstallRequest,
  ) => Promise<
    | { readonly kind: 'active_tasks' }
    | { readonly kind: 'prepared'; rollback(): void }
  >;
  mockLatestVersion?: string;
  mockState?: 'available' | 'downloading' | 'downloaded';
  testFeedUrl?: string;
} = {}) {
  const updater = input.updater ?? new FakeUpdater();
  const clock = input.clock ?? new FakeClock();
  const service = createAppUpdateService({
    currentVersion: '1.0.0',
    isPackaged: input.isPackaged ?? true,
    updater: updater as unknown as AppUpdater,
    clock,
    onStatusChange: input.onStatusChange,
    prepareInstall: input.prepareInstall ?? (async (request) =>
      input.activeTasks && !request.allowInterruptActiveTasks
        ? { kind: 'active_tasks' }
        : { kind: 'prepared', rollback() {} }),
    mockLatestVersion: input.mockLatestVersion,
    mockState: input.mockState,
    testFeedUrl: input.testFeedUrl,
  });
  return { clock, service, updater };
}

describe('AppUpdateService', () => {
  test('owns one main-process schedule and configures background downloads', async () => {
    const { clock, service, updater } = createHarness();

    assert.equal(updater.autoDownload, true);
    assert.equal(updater.autoInstallOnAppQuit, false);
    assert.equal(updater.setFeedURLCalls, 0);

    service.start();
    service.start();
    assert.deepEqual(clock.pending().map((timer) => timer.delayMs), [FIRST_UPDATE_CHECK_DELAY_MS]);

    await clock.runNext();
    assert.equal(updater.checkCalls, 1);
    assert.deepEqual(clock.pending().map((timer) => timer.delayMs), [UPDATE_CHECK_INTERVAL_MS]);

    service.dispose();
    assert.equal(clock.pending().length, 0);
  });

  test('preserves electron-updater channel policy derived from the app version', () => {
    for (const allowPrerelease of [false, true]) {
      const updater = new FakeUpdater();
      updater.allowPrerelease = allowPrerelease;
      createHarness({ updater });
      assert.equal(updater.allowPrerelease, allowPrerelease);
    }
  });

  test('routes the feed to a loopback generic provider when the test override is set', () => {
    const { updater } = createHarness({ testFeedUrl: 'http://127.0.0.1:8443/feed' });
    assert.deepEqual(updater.feed, {
      provider: 'generic',
      url: 'http://127.0.0.1:8443/feed',
    });
    assert.equal(updater.setFeedURLCalls, 1);
  });

  test('rejects a non-loopback test feed instead of falling back to production', () => {
    // A mistyped override must never silently install from the real GitHub
    // feed: construction fails closed.
    assert.throws(
      () => createHarness({ testFeedUrl: 'https://evil.example/feed' }),
      TypeError,
    );
  });

  test('resolveUpdateFeedOverride accepts exactly loopback http URLs', () => {
    assert.equal(resolveUpdateFeedOverride(undefined), undefined);
    assert.equal(resolveUpdateFeedOverride(''), undefined);
    assert.deepEqual(resolveUpdateFeedOverride('http://127.0.0.1:1'), {
      provider: 'generic',
      url: 'http://127.0.0.1:1/',
    });
    assert.deepEqual(resolveUpdateFeedOverride('http://127.0.0.1:65535/updates'), {
      provider: 'generic',
      url: 'http://127.0.0.1:65535/updates',
    });
    const rejected = [
      'not-a-url',
      'file:///C:/feed',
      'https://127.0.0.1:1', // https is not loopback-harness shaped
      'http://localhost:1', // alias resolution is not identity
      'http://127.0.0.2:1', // other loopback addresses stay rejected
      'http://[::1]:1', // IPv6 loopback stays rejected: one accepted shape only
      'http://127.0.0.1', // no port: cannot be an ephemeral harness server
      'http://u:p@127.0.0.1:1', // userinfo confusion
      'http://127.0.0.1.evil.example:1', // hostname prefix confusion
      'http://127.0.0.1:1/x?y=1', // query smuggling
      'http://127.0.0.1:1/x#frag',
    ];
    for (const raw of rejected) {
      assert.throws(
        () => resolveUpdateFeedOverride(raw),
        TypeError,
        `expected rejection: ${raw}`,
      );
    }
  });

  test('does not overlap checks and cannot re-arm after disposal', async () => {
    const updater = new FakeUpdater();
    let settleCheck!: (value: unknown) => void;
    updater.checkResult = new Promise((resolve) => {
      settleCheck = resolve;
    });
    const { clock, service } = createHarness({ updater });

    service.start();
    await clock.runNext();
    assert.equal(updater.checkCalls, 1);
    assert.equal(clock.pending().length, 0);

    service.dispose();
    settleCheck({ isUpdateAvailable: false });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(clock.pending().length, 0);
  });

  test('does not schedule the production updater in an unpackaged app', () => {
    const { clock, service } = createHarness({ isPackaged: false });
    service.start();
    assert.equal(clock.pending().length, 0);
  });

  test('lets the available update fixture advance through the retry action', async () => {
    const { clock, service } = createHarness({
      isPackaged: false,
      mockLatestVersion: '1.1.0',
      mockState: 'available',
    });
    service.start();
    await clock.runNext();
    assert.equal(service.getStatus().state, 'available');
    assert.equal((await service.retryUpdateDownload()).state, 'downloaded');
  });

  test('projects updater events without manually starting a second download', async () => {
    const statuses: AppUpdateStatus[] = [];
    const updater = new FakeUpdater();
    updater.checkForUpdates = async () => {
      updater.checkCalls += 1;
      updater.emit('checking-for-update');
      updater.emit('update-available', updateInfo('1.1.0'));
      return { isUpdateAvailable: true };
    };
    const { clock, service } = createHarness({
      updater,
      onStatusChange: (status) => statuses.push(status),
    });

    service.start();
    await clock.runNext();
    assert.equal(updater.downloadCalls, 0);
    assert.equal(service.getStatus().state, 'available');

    updater.emit('download-progress', {
      percent: 50,
      bytesPerSecond: 100,
      transferred: 5,
      total: 10,
    });
    updater.emit('update-downloaded', {
      ...updateInfo('1.1.0'),
      downloadedFile: '/tmp/maka-update.zip',
    });

    assert.deepEqual(statuses.map((status) => status.state), [
      'checking',
      'available',
      'downloading',
      'downloaded',
    ]);
    assert.deepEqual(service.getStatus(), {
      state: 'downloaded',
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
    });
  });

  test('cancels a stalled auto-download before retrying it', async () => {
    const updater = new FakeUpdater();
    const statuses: AppUpdateStatus[] = [];
    let rejectFirstDownload!: (error: Error) => void;
    let cancellationCalls = 0;
    updater.checkForUpdates = async () => {
      updater.checkCalls += 1;
      updater.emit('checking-for-update');
      updater.emit('update-available', updateInfo('1.1.0'));
      if (updater.checkCalls === 1) {
        const downloadPromise = new Promise<string[]>((_resolve, reject) => {
          rejectFirstDownload = reject;
        });
        return {
          isUpdateAvailable: true,
          updateInfo: updateInfo('1.1.0'),
          versionInfo: updateInfo('1.1.0'),
          downloadPromise,
          cancellationToken: {
            cancel: () => {
              cancellationCalls += 1;
              rejectFirstDownload(new Error('download cancelled for retry'));
            },
          },
        };
      }
      updater.emit('update-downloaded', {
        ...updateInfo('1.1.0'),
        downloadedFile: '/tmp/maka-update.zip',
      });
      return { isUpdateAvailable: true };
    };
    const { clock, service } = createHarness({
      updater,
      onStatusChange: (status) => statuses.push(status),
    });

    service.start();
    await clock.runNext();
    assert.equal(service.getStatus().state, 'available');

    assert.equal((await service.retryUpdateDownload()).state, 'downloaded');
    assert.equal(cancellationCalls, 1);
    assert.equal(updater.checkCalls, 2);
    assert.equal(statuses.some((status) => status.state === 'error'), false);
  });

  test('marks updater errors during a download as retryable download failures', async () => {
    const { service, updater } = createHarness();
    updater.emit('update-available', updateInfo('1.1.0'));
    updater.emit('error', new Error('proxy disconnected'));

    assert.deepEqual(service.getStatus(), {
      state: 'error',
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
      operation: 'download',
      message: 'proxy disconnected',
    });

    updater.checkForUpdates = async () => {
      updater.checkCalls += 1;
      updater.emit('checking-for-update');
      updater.emit('update-downloaded', {
        ...updateInfo('1.1.0'),
        downloadedFile: '/tmp/maka-update.zip',
      });
      return { isUpdateAvailable: true };
    };
    assert.equal((await service.retryUpdateDownload()).state, 'downloaded');
    assert.equal(updater.checkCalls, 1);
  });

  test('requires explicit authority before interrupting active tasks', async () => {
    const { service, updater } = createHarness({
      activeTasks: true,
    });
    updater.emit('update-downloaded', {
      ...updateInfo('1.1.0'),
      downloadedFile: '/tmp/maka-update.zip',
    });

    assert.deepEqual(
      await service.installUpdate({ allowInterruptActiveTasks: false }),
      { ok: false, reason: 'active_tasks' },
    );
    assert.equal(updater.quitAndInstallCalls, 0);

    assert.deepEqual(
      await service.installUpdate({ allowInterruptActiveTasks: true }),
      { ok: true },
    );
    assert.equal(updater.quitAndInstallCalls, 1);

    const idle = createHarness();
    idle.updater.emit('update-downloaded', {
      ...updateInfo('1.1.0'),
      downloadedFile: '/tmp/maka-update.zip',
    });
    assert.deepEqual(
      await idle.service.installUpdate({ allowInterruptActiveTasks: false }),
      { ok: true },
    );
    assert.equal(idle.updater.quitAndInstallCalls, 1);
  });

  test('completes the Runtime Host handoff before dispatching the installer', async () => {
    const order: string[] = [];
    const updater = new FakeUpdater();
    updater.onQuitAndInstall = () => order.push('install');
    const { service } = createHarness({
      updater,
      prepareInstall: async () => {
        order.push('host-prepared');
        return { kind: 'prepared', rollback() {} };
      },
    });
    updater.emit('update-downloaded', {
      ...updateInfo('1.1.0'),
      downloadedFile: '/tmp/maka-update.zip',
    });

    assert.deepEqual(await service.installUpdate({ allowInterruptActiveTasks: false }), {
      ok: true,
    });
    assert.deepEqual(order, ['host-prepared', 'install']);
  });

  test('reports synchronous and asynchronous installer failures through status', async () => {
    let synchronousRollbacks = 0;
    const synchronous = createHarness({
      prepareInstall: async () => ({
        kind: 'prepared',
        rollback: () => {
          synchronousRollbacks += 1;
        },
      }),
    });
    synchronous.updater.quitAndInstallDispatchError = true;
    synchronous.updater.emit('update-downloaded', {
      ...updateInfo('1.1.0'),
      downloadedFile: '/tmp/maka-update.zip',
    });
    assert.deepEqual(
      await synchronous.service.installUpdate({ allowInterruptActiveTasks: false }),
      { ok: false, reason: 'install_failed' },
    );
    const synchronousStatus = synchronous.service.getStatus();
    assert.equal(synchronousStatus.state, 'error');
    assert.equal(
      synchronousStatus.state === 'error'
        ? synchronousStatus.operation
        : undefined,
      'install',
    );
    assert.equal(synchronousRollbacks, 1);

    let asynchronousRollbacks = 0;
    const asynchronous = createHarness({
      prepareInstall: async () => ({
        kind: 'prepared',
        rollback: () => {
          asynchronousRollbacks += 1;
        },
      }),
    });
    asynchronous.updater.emit('update-downloaded', {
      ...updateInfo('1.1.0'),
      downloadedFile: '/tmp/maka-update.zip',
    });
    assert.deepEqual(
      await asynchronous.service.installUpdate({ allowInterruptActiveTasks: false }),
      { ok: true },
    );
    assert.equal(asynchronous.service.getStatus().state, 'installing');
    asynchronous.updater.emit('error', new Error('signature rejected'));
    assert.deepEqual(asynchronous.service.getStatus(), {
      state: 'error',
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
      operation: 'install',
      message: 'signature rejected',
    });
    assert.equal(asynchronousRollbacks, 1);
  });
});
