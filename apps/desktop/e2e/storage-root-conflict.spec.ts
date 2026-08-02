import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STORAGE_ROOT_MARKER_FILE, resolveStorageRoot } from '@maka/storage/root-authority';
import { buildFixtureEnv } from '../../../scripts/fixture-env.mjs';
import { closeElectronApplication } from '../../../scripts/electron-lifecycle.mjs';

const DESKTOP_ROOT = process.cwd();

/**
 * Poll the main process for readiness without hanging on the modal repair
 * dialog: once the dialog opens (which can only happen after ready, because
 * the boot module runs inside the `whenReady` callback), the dialog's modal
 * loop on macOS stops answering CDP evaluation, so an evaluate call that
 * never settles is itself proof that ready was reached. A deadlocked main
 * process, by contrast, answers every evaluate with `isReady() === false`
 * forever.
 */
async function mainProcessReachedReady(app: ElectronApplication): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    let settled = false;
    const outcome = await Promise.race([
      app
        .evaluate(({ app: electronApp }) => electronApp.isReady())
        .then((ready) => {
          settled = true;
          return ready ? 'ready' : 'not-ready';
        })
        .catch((error: unknown) => {
          settled = true;
          return `evaluate-error:${error instanceof Error ? error.message : String(error)}`;
        }),
      new Promise<string>((resolve) => setTimeout(() => resolve('modal-dialog'), 1_000)),
    ]);
    if (outcome === 'ready' || outcome === 'modal-dialog') return true;
    if (outcome === 'not-ready' || outcome.startsWith('evaluate-error:')) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
  }
  return false;
}

/**
 * A conflicting storage root must reach the ready state with the repair
 * dialog open, not deadlock in module evaluation, and must not write any
 * store/db files before the user answers the dialog.
 *
 * Regression for the Electron ESM startup deadlock: top-level
 * `await app.whenReady()` inside the repair-confirm path never resolves
 * because `ready` only fires after the main module finishes evaluating.
 *
 * The ready signal is the main-process line `[startup] app ready`, which the
 * thin entry prints from inside the `whenReady` callback right before
 * dynamic-importing the boot module. A modal repair dialog blocks further
 * CDP evaluation on macOS, so asserting `app.isReady()` from the test side
 * would hang once the dialog opens; the console line is emitted before the
 * dialog exists and stays observable.
 */
test('reaches ready with a storage-root repair dialog open and writes nothing before the answer', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'maka-root-conflict-'));
  const homeDir = join(userDataDir, 'home');
  await mkdir(homeDir, { recursive: true });
  let app;
  try {
    // Seed a real interactive marker, then corrupt its device id so startup
    // must stop at the repair dialog (mirrors the disk-identity drift that
    // triggers root_identity_collision).
    const workspaceRoot = join(userDataDir, 'workspaces', 'default');
    await resolveStorageRoot({ path: workspaceRoot, kind: 'interactive' });
    const markerPath = join(workspaceRoot, STORAGE_ROOT_MARKER_FILE);
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as {
      rootIdentity: { dev: string };
    };
    marker.rootIdentity.dev = (BigInt(marker.rootIdentity.dev) + 1n).toString();
    const conflictingMarker = `${JSON.stringify(marker)}\n`;
    await writeFile(markerPath, conflictingMarker);

    // Launch without a fixture so the repair gate is live (fixture mode
    // seeds its own workspace and bypasses the dialog).
    app = await electron.launch({
      args: ['.'],
      cwd: DESKTOP_ROOT,
      env: buildFixtureEnv(userDataDir, homeDir, {}),
    });

    // The app must become ready while the repair dialog is open — before
    // this fix the main process deadlocked in module evaluation and
    // isReady() never turned true.
    expect(await mainProcessReachedReady(app)).toBe(true);

    // Before the dialog is answered, no store/db files may be created in
    // the workspace: the root-identity gate must precede all storage.
    const workspaceEntries = await readdir(workspaceRoot);
    expect(workspaceEntries).toEqual([STORAGE_ROOT_MARKER_FILE]);
    expect(await readFile(markerPath, 'utf8')).toBe(conflictingMarker);
  } finally {
    if (app) await closeElectronApplication(app, 5_000);
    await rm(userDataDir, { recursive: true, force: true });
  }
});
