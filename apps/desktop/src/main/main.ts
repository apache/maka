import { app, dialog } from 'electron';
import { renameSync, writeFileSync } from 'node:fs';
import { isIsolatedE2e } from './startup-context.js';

function writeDevelopmentLaunchRecord(
  path: string | undefined,
  record: Record<string, unknown>,
): void {
  if (app.isPackaged || !path) return;
  try {
    const temporary = `${path}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    console.error('[maka-dev] failed to report launch state:', error);
  }
}

function developmentLaunchIdentity(): { pid: number; supervisorPid: number } | undefined {
  const supervisorPid = Number(process.env.MAKA_DEV_SUPERVISOR_PID);
  if (!Number.isSafeInteger(supervisorPid) || supervisorPid <= 0) return undefined;
  return { pid: process.pid, supervisorPid };
}

// The macOS app menu title and app.getName() consumers read this name. Set it
// before ready, unchanged from its historical pre-ready position.
app.setName('Maka');

// E2E isolation: redirect userData BEFORE the single-instance lock so the
// lock judges the throwaway dir, not the real user data — otherwise a
// developer with Maka open makes the E2E process exit as a "second instance".
// Gated by isIsolatedE2e (not just the dir env) so a packaged build ignores
// it. Also before ready: userData must be pinned before any store opens.
if (isIsolatedE2e && process.env.MAKA_E2E_USER_DATA_DIR) {
  app.setPath('userData', process.env.MAKA_E2E_USER_DATA_DIR);
}

// Electron does not enforce single-instance by default. Must run before any
// workspace/store setup below -- a losing second process exits immediately,
// before touching shared state. See the 'second-instance' listener in
// boot.ts for what the surviving process does about it.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  const developmentIdentity = developmentLaunchIdentity();
  if (developmentIdentity) {
    writeDevelopmentLaunchRecord(process.env.MAKA_DEV_APP_PID_FILE, developmentIdentity);
  }
  // The full boot must not run in the top-level module-evaluation chain:
  // Electron ESM emits `ready` only after the entry module finishes
  // evaluating, so a top-level `await app.whenReady()` (which the
  // storage-root repair dialog needs) would deadlock. Boot therefore runs
  // after ready via a dynamic import, keeping the startup chain out of
  // module evaluation and preserving "root-identity check before any
  // store/db write".
  app
    .whenReady()
    .then(() => {
      console.log('[startup] app ready');
      return import('./boot.js');
    })
    .then(() => {
      if (developmentIdentity) {
        writeDevelopmentLaunchRecord(process.env.MAKA_DEV_LAUNCH_STATUS_FILE, {
          ...developmentIdentity,
          status: 'ready',
        });
      }
    })
    .catch((error: unknown) => {
      console.error('[startup] fatal:', error);
      if (developmentIdentity) {
        writeDevelopmentLaunchRecord(process.env.MAKA_DEV_LAUNCH_STATUS_FILE, {
          ...developmentIdentity,
          status: 'failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      // E2E runs must not hang on a modal error box (same reasoning as the
      // fixture-fatal path in boot.ts: print a parseable line and exit fast).
      if (!isIsolatedE2e) {
        const message = error instanceof Error ? error.message : String(error);
        dialog.showErrorBox('Maka failed to start', message);
      }
      app.exit(1);
    });
}
