/* Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE. */
import { cleanup, effect, host } from "nsh";
import type { QuickTools } from "../../../../plugins/application/quick-tools/runtime/engine";

export type CommandSetting = {
  id: string;
  name: string;
  alias: string;
  shortcut: string;
};
export type QuickSettings = {
  shortcut: string;
  plugins: {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    icon?: string;
    commands: CommandSetting[];
  }[];
};
export type SettingsCommand =
  | { kind: "read" }
  | { kind: "launcher"; enabled: boolean }
  | { kind: "shortcut"; value: string }
  | { kind: "plugin"; id: string; enabled: boolean }
  | {
      kind: "item";
      plugin: string;
      id: string;
      field: "alias" | "shortcut";
      value: string;
    };
type Request = { id: string; command: SettingsCommand };
type Reply = { id?: string; settings?: QuickSettings; error?: string };
const settingsEvent = "quickTools.settings";
let sequence = 0;
export function requestSettings(
  command: SettingsCommand,
): Promise<QuickSettings> {
  const id = String(++sequence);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(undefined, "Quick Tools did not respond"),
      10000,
    );
    const off = host.on(settingsEvent, (data) => {
      const reply = data as Reply;
      if (reply.id === id) finish(reply.settings, reply.error);
    });
    function finish(settings?: QuickSettings, error?: string) {
      clearTimeout(timer);
      off();
      if (settings) resolve(settings);
      else reject(Error(error ?? "Quick Tools settings unavailable"));
    }
    void host
      .call(settingsEvent, { id, command })
      .catch((cause) => finish(undefined, String(cause)));
  });
}
export function onSettingsChanged(apply: (settings: QuickSettings) => void) {
  return host.on(settingsEvent, (data) => {
    const reply = data as Reply;
    if (!reply.id && reply.settings) apply(reply.settings);
  });
}
// The panel owns the live engine and OS shortcut registrations for both windows.
export function serveQuickSettings(
  engine: QuickTools,
  started: Promise<unknown>,
  revision: () => number,
  ready: () => boolean,
  locale: () => string,
) {
  const snapshot = (): QuickSettings => ({
    shortcut: engine.shortcut(),
    plugins: engine.installed().map(({ manifest, enabled }) => ({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      enabled,
      icon: manifest.icon,
      commands: manifest.commands.map((command) => {
        const row = {
          ...command,
          plugin: manifest.id,
          pluginName: manifest.name,
        };
        return {
          id: row.id,
          name: row.name,
          alias: engine.alias(row),
          shortcut: engine.shortcut(row),
        };
      }),
    })),
  });
  const reply = (value: Reply) =>
    host
      .call(settingsEvent, value)
      .catch((cause) => console.warn(String(cause)));
  effect(() => {
    revision();
    locale();
    if (ready()) void reply({ settings: snapshot() });
  });
  let queue = Promise.resolve();
  cleanup(
    host.on(settingsEvent, (data) => {
      const { id, command } = data as Request;
      queue = queue
        .then(async () => {
          await started;
          switch (command.kind) {
            case "launcher":
              await engine.setLauncherEnabled(command.enabled);
              break;
            case "shortcut":
              await engine.setShortcut(command.value);
              break;
            case "plugin":
              if (
                !engine
                  .installed()
                  .some(({ manifest }) => manifest.id === command.id)
              )
                throw Error("Unknown plugin");
              await engine.enable(command.id, command.enabled);
              break;
            case "item": {
              const manifest = engine
                .installed()
                .find((p) => p.manifest.id === command.plugin)?.manifest;
              const entry = manifest?.commands.find((c) => c.id === command.id);
              if (!manifest || !entry) throw Error("Unknown command");
              const row = {
                ...entry,
                plugin: manifest.id,
                pluginName: manifest.name,
              };
              if (command.field === "shortcut")
                await engine.setShortcut(command.value, row);
              else
                await engine.preference(row, {
                  alias: command.value.trim().slice(0, 80),
                });
              break;
            }
            case "read":
              break;
            default:
              throw Error("Unknown Quick Tools setting");
          }
          await reply({ id, settings: snapshot() });
        })
        .catch(async (cause) => {
          await reply({
            id,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        });
    }),
  );
}
