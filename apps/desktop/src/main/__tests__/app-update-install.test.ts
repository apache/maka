import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type {
  AppUpdateInstallRequest,
  AppUpdateInstallResult,
} from '../../preload/bridge-contract.js';
import { requestDownloadedAppUpdate } from '../../renderer/app-update-install.js';

describe('requestDownloadedAppUpdate', () => {
  test('installs immediately when main reports no active work', async () => {
    const requests: AppUpdateInstallRequest[] = [];
    const outcome = await requestDownloadedAppUpdate({
      installUpdate: async (request) => {
        requests.push(request);
        return { ok: true };
      },
      confirmActiveTasks: async () => {
        throw new Error('confirmation should not open');
      },
    });

    assert.deepEqual(requests, [{ maxInterruptibleActiveTasks: 0 }]);
    assert.deepEqual(outcome, { kind: 'install-started' });
  });

  test('leaves the downloaded update pending when the user cancels', async () => {
    const requests: AppUpdateInstallRequest[] = [];
    let confirmedCount: number | undefined;
    const outcome = await requestDownloadedAppUpdate({
      installUpdate: async (request) => {
        requests.push(request);
        return { ok: false, reason: 'active_tasks', activeTaskCount: 2 };
      },
      confirmActiveTasks: async (count) => {
        confirmedCount = count;
        return false;
      },
    });

    assert.equal(confirmedCount, 2);
    assert.deepEqual(requests, [{ maxInterruptibleActiveTasks: 0 }]);
    assert.deepEqual(outcome, { kind: 'cancelled' });
  });

  test('sends explicit interruption authority only after confirmation', async () => {
    const requests: AppUpdateInstallRequest[] = [];
    const results: AppUpdateInstallResult[] = [
      { ok: false, reason: 'active_tasks', activeTaskCount: 1 },
      { ok: true },
    ];
    const outcome = await requestDownloadedAppUpdate({
      installUpdate: async (request) => {
        requests.push(request);
        return results.shift()!;
      },
      confirmActiveTasks: async () => true,
    });

    assert.deepEqual(requests, [
      { maxInterruptibleActiveTasks: 0 },
      { maxInterruptibleActiveTasks: 1 },
    ]);
    assert.deepEqual(outcome, { kind: 'install-started' });
  });

  test('returns a terminal failure from the authorized install attempt', async () => {
    const results: AppUpdateInstallResult[] = [
      { ok: false, reason: 'active_tasks', activeTaskCount: 3 },
      { ok: false, reason: 'install_failed' },
    ];
    const outcome = await requestDownloadedAppUpdate({
      installUpdate: async () => results.shift()!,
      confirmActiveTasks: async () => true,
    });

    assert.deepEqual(outcome, { kind: 'failed', reason: 'install_failed' });
  });

  test('asks again instead of expanding authority when more tasks start', async () => {
    const requests: AppUpdateInstallRequest[] = [];
    const confirmedCounts: number[] = [];
    const results: AppUpdateInstallResult[] = [
      { ok: false, reason: 'active_tasks', activeTaskCount: 1 },
      { ok: false, reason: 'active_tasks', activeTaskCount: 3 },
      { ok: true },
    ];
    const outcome = await requestDownloadedAppUpdate({
      installUpdate: async (request) => {
        requests.push(request);
        return results.shift()!;
      },
      confirmActiveTasks: async (count) => {
        confirmedCounts.push(count);
        return true;
      },
    });

    assert.deepEqual(confirmedCounts, [1, 3]);
    assert.deepEqual(requests, [
      { maxInterruptibleActiveTasks: 0 },
      { maxInterruptibleActiveTasks: 1 },
      { maxInterruptibleActiveTasks: 3 },
    ]);
    assert.deepEqual(outcome, { kind: 'install-started' });
  });
});
