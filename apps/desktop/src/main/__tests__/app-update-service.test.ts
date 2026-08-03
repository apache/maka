import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';
import type { AppUpdater } from 'electron-updater';
import {
  createAppUpdateService,
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
  feed: unknown;
  checkResult: Promise<unknown> | undefined;

  setFeedURL(input: unknown): void {
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
    this.quitAndInstallCalls += 1;
    if (this.quitAndInstallThrows) throw new Error('install failed');
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
  getActiveTaskCount?: () => number;
} = {}) {
  const updater = input.updater ?? new FakeUpdater();
  const clock = input.clock ?? new FakeClock();
  const service = createAppUpdateService({
    currentVersion: '1.0.0',
    isPackaged: input.isPackaged ?? true,
    platform: 'darwin',
    arch: 'arm64',
    openExternal: async () => undefined,
    updater: updater as unknown as AppUpdater,
    clock,
    onStatusChange: input.onStatusChange,
    getActiveTaskCount: input.getActiveTaskCount ?? (() => 0),
  });
  return { clock, service, updater };
}

describe('AppUpdateService', () => {
  test('owns one main-process schedule and configures background downloads', async () => {
    const { clock, service, updater } = createHarness();

    assert.equal(updater.autoDownload, true);
    assert.equal(updater.autoInstallOnAppQuit, false);
    assert.equal(updater.allowPrerelease, false);
    assert.deepEqual(updater.feed, {
      provider: 'github',
      owner: 'Maka-Agent',
      repo: 'maka-agent',
    });

    service.start();
    service.start();
    assert.deepEqual(clock.pending().map((timer) => timer.delayMs), [FIRST_UPDATE_CHECK_DELAY_MS]);

    await clock.runNext();
    assert.equal(updater.checkCalls, 1);
    assert.deepEqual(clock.pending().map((timer) => timer.delayMs), [UPDATE_CHECK_INTERVAL_MS]);

    service.dispose();
    assert.equal(clock.pending().length, 0);
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
      releaseName: undefined,
      downloadedFile: '/tmp/maka-update.zip',
    });
  });

  test('requires explicit authority before interrupting active tasks', async () => {
    let activeTaskCount = 2;
    const { service, updater } = createHarness({
      getActiveTaskCount: () => activeTaskCount,
    });
    updater.emit('update-downloaded', {
      ...updateInfo('1.1.0'),
      downloadedFile: '/tmp/maka-update.zip',
    });

    assert.deepEqual(
      await service.installUpdate({ allowInterruptActiveTasks: false }),
      { ok: false, reason: 'active_tasks', activeTaskCount: 2 },
    );
    assert.equal(updater.quitAndInstallCalls, 0);

    assert.deepEqual(
      await service.installUpdate({ allowInterruptActiveTasks: true }),
      { ok: true },
    );
    assert.equal(updater.quitAndInstallCalls, 1);

    activeTaskCount = 0;
    assert.deepEqual(
      await service.installUpdate({ allowInterruptActiveTasks: false }),
      { ok: true },
    );
    assert.equal(updater.quitAndInstallCalls, 2);
  });

  test('fails closed when the active-task snapshot is invalid or unreadable', async () => {
    let snapshot: number | Error = Number.NaN;
    const { service, updater } = createHarness({
      getActiveTaskCount: () => {
        if (snapshot instanceof Error) throw snapshot;
        return snapshot;
      },
    });
    updater.emit('update-downloaded', {
      ...updateInfo('1.1.0'),
      downloadedFile: '/tmp/maka-update.zip',
    });

    for (const invalid of [Number.NaN, -1, 1.5]) {
      snapshot = invalid;
      assert.deepEqual(
        await service.installUpdate({ allowInterruptActiveTasks: false }),
        { ok: false, reason: 'install_failed' },
      );
    }
    snapshot = new Error('snapshot unavailable');
    assert.deepEqual(
      await service.installUpdate({ allowInterruptActiveTasks: false }),
      { ok: false, reason: 'install_failed' },
    );
    assert.equal(updater.quitAndInstallCalls, 0);
  });
});
