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
 * Prove the app parked at the modal repair dialog — the only success signal
 * this test accepts.
 *
 * The dialog can only appear after ready: the whole boot module runs inside
 * the `whenReady` callback, so a modal dialog being up simultaneously proves
 * (a) ready was reached and (b) the root-identity gate fired and is holding
 * before any store/db write. On macOS the dialog's modal loop stops answering
 * CDP evaluation, so an evaluate that never settles within the deadline is the
 * observable form of "dialog is open". A deadlocked main process (the
 * regression this test guards) answers every evaluate with `isReady() ===
 * false` forever, and a future removal of the gate would make evaluate answer
 * `true` — both must fail, only the parked dialog may pass.
 */
async function appParkedAtRepairDialog(app: ElectronApplication): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const outcome = await Promise.race([
      app
        .evaluate(({ app: electronApp }) => electronApp.isReady())
        .then((ready) => (ready ? 'ready' : 'not-ready'))
        .catch(() => 'evaluate-error'),
      new Promise<string>((resolve) => setTimeout(() => resolve('modal-dialog'), 1_000)),
    ]);
    if (outcome === 'modal-dialog') return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/**
 * A conflicting storage root must park at the repair dialog — never deadlock
 * in module evaluation — and must not write any store/db files before the
 * user answers.
 *
 * Regression for the Electron ESM startup deadlock: top-level
 * `await app.whenReady()` inside the repair-confirm path never resolves
 * because `ready` only fires after the main module finishes evaluating.
 */
test('parks at the storage-root repair dialog and writes nothing before the answer', async () => {
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

    // The app must park at the dialog — before this fix the main process
    // deadlocked in module evaluation and no dialog ever appeared.
    expect(await appParkedAtRepairDialog(app)).toBe(true);

    // While the dialog is unanswered, no store/db files may be created in
    // the workspace: the root-identity gate must precede all storage.
    const workspaceEntries = await readdir(workspaceRoot);
    expect(workspaceEntries).toEqual([STORAGE_ROOT_MARKER_FILE]);
    expect(await readFile(markerPath, 'utf8')).toBe(conflictingMarker);
  } finally {
    if (app) await closeElectronApplication(app, 5_000);
    await rm(userDataDir, { recursive: true, force: true });
  }
});
