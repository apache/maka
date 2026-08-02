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
 * Startup signal the main process prints synchronously right before showing
 * the repair modal (see `confirmDesktopStorageRootRepair` in boot.ts). It is
 * an explicit contract between the app and this test: it can only be printed
 * after `ready` — the whole boot module runs inside the `whenReady` callback —
 * and only when the root-identity gate fired, so seeing it proves both
 * invariants at once.
 *
 * CDP evaluation is deliberately not the success signal: macOS modal loops
 * block CDP evaluation while Linux modal dialogs keep answering it, so no
 * evaluate-based heuristic is portable. A deadlocked main process (the
 * regression this test guards) never reaches the gate, so the signal never
 * appears; a future removal of the gate skips the signal too.
 */
const REPAIR_GATE_SIGNAL = '[storage-root] root-identity conflict; parking at repair dialog';

async function appParkedAtRepairGate(app: ElectronApplication): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, 30_000);
    app.on('console', (message) => {
      if (settled) return;
      if (message.text().includes(REPAIR_GATE_SIGNAL)) {
        settled = true;
        clearTimeout(timeout);
        resolve(true);
      }
    });
  });
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

    // The gate signal is printed only after ready and only when the conflict
    // fired; a deadlocked main process (the regression) never prints it.
    expect(await appParkedAtRepairGate(app)).toBe(true);

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
