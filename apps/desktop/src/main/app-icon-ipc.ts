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

import type {
  IpcMain,
  OpenDialogOptions,
  OpenDialogReturnValue,
} from "electron";
import {
  customAppIconId,
  isAppIconChoice,
  isCustomAppIcon,
  toAppIconChoice,
  type AppIconChoice,
  type AppSettings,
} from "@maka/core/settings";
import type { SettingsStore } from "@maka/storage/settings-store";
import type { AppIconPreview } from "./app-icon-surface.js";
import {
  CustomAppIconError,
  listCustomAppIconIds,
  removeCustomAppIcon,
  type CustomAppIconImportReason,
} from "./custom-app-icon-store.js";

export type AppIconImportResult =
  | { readonly ok: true; readonly icon: AppIconChoice }
  | { readonly ok: false; readonly reason: CustomAppIconImportReason };

export type AppIconSelectResult =
  | { readonly ok: true; readonly selection: AppIconChoice }
  | {
      readonly ok: false;
      readonly reason: "invalid_id" | "missing_artwork" | "write_failed";
    };

export type AppIconRemoveResult =
  | { readonly ok: true; readonly selection: AppIconChoice }
  | {
      readonly ok: false;
      readonly reason: "invalid_id" | "reset_failed" | "remove_failed";
    };

/**
 * The icon surface's one main-process owner.
 *
 * Selection and artwork are two pieces of state that must not disagree, so the
 * operation that can break the pair lives here rather than being sequenced by
 * the renderer: a renderer that deletes and then persists leaves the setting
 * pointing at a file that is gone whenever the second call fails.
 */
/**
 * Everything that touches Electron is injected rather than imported: this
 * module holds the policy, and keeping `electron` out of its import graph is
 * what lets the removal contract be tested without booting a browser process.
 */
export function registerAppIconIpc(input: {
  readonly ipcMain: Pick<IpcMain, "handle">;
  readonly showOpenDialog: (
    options: OpenDialogOptions,
  ) => Promise<OpenDialogReturnValue>;
  readonly listPreviews: () => Promise<readonly AppIconPreview[]>;
  readonly importArtwork: (source: {
    readonly sourcePath: string;
    readonly userDataPath: string;
  }) => Promise<AppIconChoice>;
  readonly settingsStore: Pick<SettingsStore, "update" | "updateIf">;
  readonly applySettings: (settings: AppSettings) => Promise<void>;
  readonly userDataPath: () => string;
}): void {
  const { userDataPath } = input;

  // Every operation that can move the selection or the artwork runs here, one
  // at a time. A compare-and-set around the settings write alone was not
  // enough: applying the icon yields, and a selection arriving in that window
  // would be left pointing at a file this sequence is about to delete. Making
  // the three operations a single serialized owner removes the window itself,
  // rather than guarding each one that gets noticed.
  let queue: Promise<unknown> = Promise.resolve();
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = queue.then(operation, operation);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Selection lives behind this seam too, so it queues with removal instead of
   * racing it through the generic settings channel. It is also the only place
   * that can refuse a choice whose artwork is gone — the generic channel would
   * happily persist an id with nothing behind it.
   */
  input.ipcMain.handle("app:selectIcon", (_event, icon: unknown) =>
    serialize(async (): Promise<AppIconSelectResult> => {
      if (!isAppIconChoice(icon)) return { ok: false, reason: "invalid_id" };
      const custom = customAppIconId(icon);
      if (custom !== undefined) {
        const present = await listCustomAppIconIds(userDataPath());
        if (!present.includes(custom))
          return { ok: false, reason: "missing_artwork" };
      }
      try {
        const settings = await input.settingsStore.update({
          appearance: { appIcon: icon },
        });
        await input.applySettings(settings);
        return {
          ok: true,
          selection: toAppIconChoice(settings.appearance.appIcon),
        };
      } catch {
        return { ok: false, reason: "write_failed" };
      }
    }),
  );

  // The picker asks for the whole set at once; there is no per-id request, so
  // no id from the renderer ever reaches the filesystem.
  input.ipcMain.handle(
    "app:iconPreviews",
    (): Promise<readonly AppIconPreview[]> => input.listPreviews(),
  );

  // The dialog runs here and the file it returns is the only path this sees.
  input.ipcMain.handle("app:importIcon", async (): Promise<AppIconImportResult> => {
    // The dialog stays OUTSIDE the queue on purpose: it is open for as long as
    // the user looks at it, and holding the owner for that would block select
    // and remove in every other window while someone reads a file list. The
    // dialog changes nothing; only the copy-into-place below does, and that is
    // what this owner exists to order.
    const picked = await input.showOpenDialog({
      properties: ["openFile"],
      // Only what `nativeImage` guarantees on every platform. Offering TIFF
      // or WebP would let a Windows or Linux user pick a file that then fails
      // to decode, with the dialog having implied otherwise.
      filters: [{ name: "PNG and JPEG", extensions: ["png", "jpg", "jpeg"] }],
    });
    const sourcePath = picked.canceled ? undefined : picked.filePaths[0];
    if (!sourcePath) return { ok: false, reason: "cancelled" };

    return serialize(async (): Promise<AppIconImportResult> => {
      try {
        return {
          ok: true,
          icon: await input.importArtwork({
            sourcePath,
            userDataPath: userDataPath(),
          }),
        };
      } catch (error) {
        return {
          ok: false,
          reason:
            error instanceof CustomAppIconError ? error.reason : "unreadable",
        };
      }
    });
  });

  input.ipcMain.handle("app:removeIcon", (_event, icon: unknown) =>
    serialize(async (): Promise<AppIconRemoveResult> => {
      // Only imported artwork is the user's to delete, and only a well-formed
      // reference names any of it.
      if (!isCustomAppIcon(icon)) return { ok: false, reason: "invalid_id" };
      const id = customAppIconId(icon);
      if (!id) return { ok: false, reason: "invalid_id" };

      // Compare-and-set, not read-then-write. Between a read and an
      // unconditional write another surface can select a different icon, and
      // resetting anyway would stamp `default` over that newer choice. The
      // store runs the predicate and the write on one queue, so this is the
      // only place the pair can be made atomic — no renderer busy flag
      // reaches across the IPC boundary to do it.
      //
      // When the predicate no longer holds, the newer selection stands and the
      // file is still deleted: it is no longer the one in use, which is
      // exactly the state the caller asked for.
      let settings: AppSettings;
      try {
        const outcome = await input.settingsStore.updateIf(
          (current) => toAppIconChoice(current.appearance.appIcon) === icon,
          { appearance: { appIcon: "default" } },
        );
        settings = outcome.settings;
        if (outcome.applied) await input.applySettings(settings);
      } catch {
        return { ok: false, reason: "reset_failed" };
      }

      try {
        await removeCustomAppIcon({ id, userDataPath: userDataPath() });
      } catch {
        return { ok: false, reason: "remove_failed" };
      }
      return {
        ok: true,
        selection: toAppIconChoice(settings.appearance.appIcon),
      };
    }),
  );
}
