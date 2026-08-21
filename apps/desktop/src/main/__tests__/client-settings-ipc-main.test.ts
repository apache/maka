import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultSettings,
  mergeSettings,
  type UpdateAppSettingsInput,
} from "@maka/core/settings";
import { registerClientSettingsIpc } from "../client-settings-ipc-main.js";

test("client settings updates filter Host policy and return newly submitted secrets", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let settings = createDefaultSettings();
  let storedPatch: UpdateAppSettingsInput | undefined;
  let applied = 0;
  registerClientSettingsIpc({
    ipcMain: {
      handle(channel, listener) {
        handlers.set(channel, listener as (...args: unknown[]) => unknown);
      },
    },
    settingsStore: {
      get: async () => settings,
      update: async (patch: UpdateAppSettingsInput) => {
        storedPatch = patch;
        settings = mergeSettings(settings, patch);
        return settings;
      },
    } as never,
    apply: async () => {
      applied += 1;
    },
  });

  const result = await handlers.get("settings:client:update")?.({}, {
    appearance: { theme: "dark" },
    botChat: { channels: { telegram: { token: "fresh-bot-token" } } },
    chatDefaults: { permissionMode: "bypass" },
  });

  assert.deepEqual(storedPatch, {
    appearance: { theme: "dark" },
    botChat: { channels: { telegram: { token: "fresh-bot-token" } } },
  });
  assert.equal((result as { settings: typeof settings }).settings.appearance.theme, "dark");
  assert.equal(
    (result as { settings: typeof settings }).settings.botChat.channels.telegram.token,
    "fresh-bot-token",
  );
  assert.equal(settings.chatDefaults.permissionMode, "ask");
  assert.equal(applied, 1);
});
