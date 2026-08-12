import assert from "node:assert/strict";
import { test } from "node:test";
import type { IpcHandler } from "../ipc-reconnect-policy.js";
import type { DesktopRuntimeHostClient } from "../runtime-host-client.js";
import { registerRuntimeHostSkillsIpc } from "../runtime-host-skills-ipc-main.js";

test("projects an empty Skill surface until a remote Project is selected", async () => {
  const handlers = new Map<string, IpcHandler>();
  registerRuntimeHostSkillsIpc({
    ipcMain: {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
      handleReconnectableRead: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    client: new Proxy(
      {},
      {
        get() {
          throw new Error("Skill reads must not reach the Host without a Project");
        },
      },
    ) as DesktopRuntimeHostClient,
    workspaceRoot: "/client-workspace",
    mainWindowController: {} as never,
    getSelectedWorkspaceTarget: async () => undefined,
    getDefaultPermissionMode: async () => "ask",
    openPath: async () => "",
    allowLocalPaths: false,
  });

  for (const channel of [
    "skills:list",
    "skills:listInvocable",
    "skills:catalog:list",
    "skills:sources:list",
  ]) {
    const handler = handlers.get(channel);
    assert.ok(handler, `missing ${channel} handler`);
    assert.deepEqual(await handler({} as never), []);
  }
});
