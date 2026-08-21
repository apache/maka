import type {
  AppSettings,
  UpdateAppSettingsInput,
  UpdateAppSettingsResult,
} from "@maka/core/settings";
import type { SettingsStore } from "@maka/storage";
import type { IpcMain } from "electron";
import {
  clientOwnedSettingsPatch,
  hasSettingsPatch,
} from "../shared/settings-ownership.js";
import {
  buildSettingsUpdateResult,
  maskAppSettings,
} from "./settings-ipc-helpers.js";

export function registerClientSettingsIpc(deps: {
  readonly ipcMain: Pick<IpcMain, "handle">;
  readonly settingsStore: SettingsStore;
  readonly apply: (settings: AppSettings) => Promise<void>;
}): void {
  deps.ipcMain.handle("settings:client:get", async () =>
    maskAppSettings(await deps.settingsStore.get()),
  );
  deps.ipcMain.handle(
    "settings:client:update",
    async (
      _event,
      patch: UpdateAppSettingsInput,
    ): Promise<UpdateAppSettingsResult> => {
      const clientPatch = clientOwnedSettingsPatch(patch);
      const settings = hasSettingsPatch(clientPatch)
        ? await deps.settingsStore.update(clientPatch)
        : await deps.settingsStore.get();
      await deps.apply(settings);
      return buildSettingsUpdateResult(settings, clientPatch);
    },
  );
}
