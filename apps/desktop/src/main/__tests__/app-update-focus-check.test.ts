import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AppUpdater } from 'electron-updater';
import { createAppUpdateService } from '../app-update-service.js';

/**
 * Focus-triggered update checks (#162).
 *
 * The four-hour timer alone meant a version published while the window sat
 * open went unnoticed until the next tick — the reported "the update never
 * showed up". Focus is when the user is present, so it is when looking is
 * worth it; the throttle is what keeps a frequent signal from becoming a
 * request storm.
 */
function createHarness(options: { start: number }) {
  const checks: number[] = [];
  let now = options.start;

  const updater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    on: () => updater,
    setFeedURL: () => {},
    checkForUpdates: async () => {
      checks.push(now);
      return null;
    },
  } as unknown as AppUpdater;

  const service = createAppUpdateService({
    currentVersion: '0.1.8',
    isPackaged: true,
    updater,
    prepareInstall: async () => ({ kind: 'prepared', rollback() {} }),
    clock: {
      // No scheduled checks in these tests: the timer is a separate trigger and
      // firing it here would blur which path recorded the timestamp.
      setTimeout: () => undefined,
      clearTimeout: () => {},
      now: () => now,
    },
  });

  return {
    service,
    checks,
    advance(ms: number) {
      now += ms;
    },
  };
}

const FIFTEEN_MINUTES = 15 * 60 * 1000;

describe('update check on window focus', () => {
  test('does not check again inside the throttle window', async () => {
    const harness = createHarness({ start: 1_000 });
    harness.service.start();

    await harness.service.checkForUpdatesOnFocus();
    harness.advance(FIFTEEN_MINUTES - 1);
    await harness.service.checkForUpdatesOnFocus();

    // Alt-tabbing repeatedly must not mean repeated update requests.
    assert.equal(harness.checks.length, 1);
  });

  test('checks again once the throttle window has passed', async () => {
    const harness = createHarness({ start: 1_000 });
    harness.service.start();

    await harness.service.checkForUpdatesOnFocus();
    harness.advance(FIFTEEN_MINUTES);
    await harness.service.checkForUpdatesOnFocus();

    assert.equal(harness.checks.length, 2);
  });

  test('stays quiet until the service has started', async () => {
    // Before start() the app has not decided it is in an updatable build at
    // all; a focus event arriving first must not jump that gate.
    const harness = createHarness({ start: 1_000 });

    await harness.service.checkForUpdatesOnFocus();

    assert.equal(harness.checks.length, 0);
  });

  test('stays quiet after dispose', async () => {
    const harness = createHarness({ start: 1_000 });
    harness.service.start();
    harness.service.dispose();

    await harness.service.checkForUpdatesOnFocus();

    assert.equal(harness.checks.length, 0);
  });

  test('manual checkForUpdatesNow ignores the focus throttle', async () => {
    const harness = createHarness({ start: 1_000 });
    harness.service.start();

    await harness.service.checkForUpdatesOnFocus();
    harness.advance(1_000);
    await harness.service.checkForUpdatesNow();

    // Focus is throttled for 15 minutes; the About button must still check.
    assert.equal(harness.checks.length, 2);
  });

  test('manual checkForUpdatesNow works before start for packaged builds', async () => {
    // The user can open Settings → About before the first scheduled check
    // arms; a manual click must not depend on start().
    const harness = createHarness({ start: 1_000 });

    await harness.service.checkForUpdatesNow();

    assert.equal(harness.checks.length, 1);
  });
});
