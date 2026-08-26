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
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { IpcMainInvokeEvent } from 'electron';
import { DEFAULT_APP_ICON } from '@maka/core/settings';
import type { AppSettings, UpdateAppSettingsInput } from '@maka/core/settings';
import { registerAppIconIpc } from '../app-icon-ipc.js';
import { customAppIconDirectory, resolveCustomAppIconPath } from '../custom-app-icon-store.js';

const ID = 'c'.repeat(32);
const ICON = `custom:${ID}`;

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

async function harness(selected: string, options: {
    onCompareAndSet?: () => void;
    onApply?: () => void;
    onShowOpenDialog?: () => Promise<void>;
    /** Seeds `appearance.appIconDark`; absent means the split is off. */
    dark?: string;
    /** Makes the conditional write throw, standing in for a disk failure. */
    failWrite?: boolean;
  } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'maka-icon-ipc-'));
  await mkdir(customAppIconDirectory(root), { recursive: true });
  await writeFile(resolveCustomAppIconPath(root, ID), 'x');

  const handlers = new Map<string, Handler>();
  let settings = {
    appearance: {
      theme: 'auto',
      appIcon: selected,
      ...(options.dark === undefined ? {} : { appIconDark: options.dark }),
    },
  } as unknown as AppSettings;
  const applied: AppSettings[] = [];

  registerAppIconIpc({
    // Typed, not cast: a stub that stops matching the real dependencies should
    // fail the build rather than keep passing against a shape that is gone.
    ipcMain: { handle: (channel: string, handler: Handler) => void handlers.set(channel, handler) },
    showOpenDialog: async () => {
      await options.onShowOpenDialog?.();
      return { canceled: true, filePaths: [] };
    },
    listPreviews: async () => [],
    importArtwork: async () => 'default',
    settingsStore: {
      update: async (patch: UpdateAppSettingsInput) => {
        settings = {
          ...settings,
          appearance: { ...settings.appearance, ...patch.appearance },
        } as AppSettings;
        return settings;
      },
      updateIf: async (
        predicate: (current: AppSettings) => boolean,
        patch: UpdateAppSettingsInput | ((current: AppSettings) => UpdateAppSettingsInput),
      ) => {
        // The real store evaluates the predicate and writes on one queue. The
        // hook stands in for whatever else reached that queue first.
        options.onCompareAndSet?.();
        if (!predicate(settings)) return { applied: false, settings };
        // Thrown after the predicate, where the real store would fail: the
        // decision to write has been made and the write is what breaks.
        if (options.failWrite) throw new Error('disk is full');
        // Spread, like the real `mergeSettings`: an explicit `undefined` in a
        // patch overwrites rather than being skipped, which is how a slot is
        // cleared.
        const resolved = typeof patch === 'function' ? patch(settings) : patch;
        settings = {
          ...settings,
          appearance: { ...settings.appearance, ...resolved.appearance },
        } as AppSettings;
        return { applied: true, settings };
      },
    },
    applySettings: async (next: AppSettings) => {
      options.onApply?.();
      applied.push(next);
    },
    userDataPath: () => root,
  });

  return {
    root,
    applied,
    remove: (icon: unknown) =>
      handlers.get('app:removeIcon')!(undefined as unknown as IpcMainInvokeEvent, icon),
    current: () => settings.appearance.appIcon,
    currentDark: () => settings.appearance.appIconDark,
    select: (icon: unknown) =>
      handlers.get('app:selectIcon')!(undefined as unknown as IpcMainInvokeEvent, icon),
    importIcon: () =>
      handlers.get('app:importIcon')!(undefined as unknown as IpcMainInvokeEvent),
    // Stands in for whatever else reached the settings queue first; the IPC
    // path above is the one under test.
    forceSelect: (icon: string) => {
      settings = {
        ...settings,
        appearance: { ...settings.appearance, appIcon: icon },
      } as AppSettings;
    },
  };
}

test('removing the current icon resets the selection before the file goes away', async () => {
  const h = await harness(ICON);
  const result = (await h.remove(ICON)) as { ok: boolean; selection?: string };

  assert.equal(result.ok, true);
  // The shipped default, which is no longer the id literally named `default`.
  assert.equal(result.selection, DEFAULT_APP_ICON);
  // Both halves moved, and the setting is the half that moved first.
  assert.equal(h.current(), DEFAULT_APP_ICON);
  assert.deepEqual(await readdir(customAppIconDirectory(h.root)), []);
  // The OS surface was told, so the dock is not still holding the deleted art.
  assert.equal(h.applied.length, 1);
});

test('removing an icon that is not selected leaves the selection alone', async () => {
  const h = await harness('sky');
  const result = (await h.remove(ICON)) as { ok: boolean; selection?: string };

  assert.equal(result.ok, true);
  assert.equal(result.selection, 'sky');
  assert.equal(h.current(), 'sky');
  assert.deepEqual(await readdir(customAppIconDirectory(h.root)), []);
  assert.equal(h.applied.length, 0);
});

/**
 * The shipped set is not the user's to delete, and a malformed reference names
 * no artwork at all — neither may reach the store, which would otherwise turn
 * the string into a path.
 */
test('shipped ids and malformed references are refused without touching disk', async () => {
  const h = await harness(ICON);
  for (const bad of ['default', 'sky', 'custom:../../etc/passwd', 'custom:', 42, null]) {
    const result = (await h.remove(bad)) as { ok: boolean; reason?: string };
    assert.equal(result.ok, false, `${String(bad)} should be refused`);
    assert.equal(result.reason, 'invalid_id');
  }
  assert.deepEqual(await readdir(customAppIconDirectory(h.root)), [`${ID}.png`]);
  assert.equal(h.current(), ICON);
});

/**
 * The gap a busy flag cannot close: the selection can move between the read
 * and the write, and on the far side of an IPC boundary at that. Resetting
 * unconditionally would stamp `default` over a choice the user just made.
 */
test('a selection landing during removal wins, and the file still goes', async () => {
  const newer = 'sky';
  const h = await harness(ICON, { onCompareAndSet: () => h.forceSelect(newer) });

  const result = (await h.remove(ICON)) as { ok: boolean; selection?: string };

  assert.equal(result.ok, true);
  // The newer choice is the authority, and it is what the caller is told.
  assert.equal(result.selection, newer);
  assert.equal(h.current(), newer);
  // Nothing was applied, because nothing about the selection changed here.
  assert.equal(h.applied.length, 0);
  // The artwork is still deleted: it is no longer in use, which is what was asked.
  assert.deepEqual(await readdir(customAppIconDirectory(h.root)), []);
});

/**
 * The window a compare-and-set around the settings write could not close:
 * applying the icon yields, and a selection arriving in that gap would be left
 * pointing at a file the removal is about to delete. Serializing the three
 * operations removes the window rather than guarding it, so a selection issued
 * mid-removal cannot interleave — it runs after, and is refused because the
 * artwork it names is gone.
 */
test('a selection issued mid-removal cannot land between reset, apply and delete', async () => {
  const observed: string[] = [];
  const h = await harness(ICON, {
    onCompareAndSet: () => observed.push('compare-and-set'),
    onApply: () => observed.push('apply'),
  });

  const removal = h.remove(ICON);
  // Issued without awaiting the removal: this is the interleaving attempt.
  const selection = h.select(ICON);
  const [removed, selected] = (await Promise.all([removal, selection])) as [
    { ok: boolean },
    { ok: boolean; reason?: string },
  ];

  assert.equal(removed.ok, true);
  // It ran after the removal, not inside it, and the artwork was already gone.
  assert.equal(selected.ok, false);
  assert.equal(selected.reason, 'missing_artwork');
  assert.equal(h.current(), DEFAULT_APP_ICON);
  assert.deepEqual(await readdir(customAppIconDirectory(h.root)), []);
  // Nothing ran between the reset and the delete, and both slots move in a
  // single compare-and-set: a second conditional write here would be a window
  // where the light slot is already committed and the dark one is not.
  assert.deepEqual(observed, ['compare-and-set', 'apply']);
});

/**
 * The dialog is user time, not work time. Holding the owner while it is open
 * would block selection and removal in every other window on someone reading a
 * file list, so only the copy-into-place is serialized.
 */
test('an open file dialog does not hold the queue', async () => {
  let releaseDialog: () => void = () => {};
  const dialogOpen = new Promise<void>((resolve) => {
    releaseDialog = resolve;
  });
  const h = await harness('sky', { onShowOpenDialog: () => dialogOpen });

  const importing = h.importIcon();
  // The dialog is still open; a selection issued now must not wait for it.
  const selected = (await h.select('ink')) as { ok: boolean };
  assert.equal(selected.ok, true);
  assert.equal(h.current(), 'ink');

  releaseDialog();
  await importing;
});

test('removing an icon used only in dark mode clears the dark slot', async () => {
  // The dangling-reference case: the light slot names something else, so the
  // light-slot predicate does not match and an earlier version of this handler
  // deleted the file while leaving `appIconDark` pointing at it.
  const h = await harness('sky', { dark: ICON });

  const result = (await h.remove(ICON)) as { ok: boolean; darkSelection?: string };

  assert.equal(result.ok, true);
  assert.equal(h.current(), 'sky', 'the light choice is untouched');
  assert.equal(h.currentDark(), undefined, 'the dark slot no longer names deleted artwork');
  assert.equal(result.darkSelection, undefined);
  assert.equal(h.applied.length, 1, 'the dock was re-applied for the cleared slot');
});

test('removing an icon used in both slots clears both', async () => {
  const h = await harness(ICON, { dark: ICON });

  const result = (await h.remove(ICON)) as { ok: boolean; selection: string };

  assert.equal(result.ok, true);
  assert.equal(h.current(), 'sky');
  assert.equal(h.currentDark(), undefined);
  assert.equal(result.selection, 'sky');
});

test('removing an unrelated icon leaves a dark choice alone', async () => {
  const other = `custom:${'d'.repeat(32)}`;
  const h = await harness('sky', { dark: 'ink' });

  await h.remove(other);

  assert.equal(h.current(), 'sky');
  assert.equal(h.currentDark(), 'ink', 'an unrelated removal must not disturb the split');
});

test('a failed reset commits nothing and leaves the dock alone', async () => {
  // The partial-commit case: both slots name the icon, so a two-step reset
  // would have written the light slot before the second write could fail.
  // One queued write means a failure leaves the persisted state untouched,
  // which is what makes `reset_failed` an honest answer.
  const h = await harness(ICON, { dark: ICON, failWrite: true });

  const result = (await h.remove(ICON)) as { ok: boolean; reason?: string };

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'reset_failed');
  assert.equal(h.current(), ICON, 'the light slot was not half-reset');
  assert.equal(h.currentDark(), ICON, 'the dark slot was not half-reset');
  assert.equal(h.applied.length, 0, 'nothing was applied to the dock');
  assert.deepEqual(
    await readdir(customAppIconDirectory(h.root)),
    [`${ID}.png`],
    'the artwork survives a failed reset',
  );
});
