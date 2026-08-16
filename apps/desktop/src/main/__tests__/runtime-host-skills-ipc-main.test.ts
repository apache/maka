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
    resolveNewSessionWorkspaceTarget: async () => undefined,
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

test("binds new-session Skill discovery to its explicit Project", async () => {
  const handlers = new Map<string, IpcHandler>();
  const resolvedProjectIds: Array<string | null | undefined> = [];
  let target: unknown;
  registerRuntimeHostSkillsIpc({
    ipcMain: {
      handle: (channel, listener) => handlers.set(channel, listener),
      handleReconnectableRead: (channel, listener) => handlers.set(channel, listener),
    },
    client: {
      listInvocableSkills: async (next: unknown) => {
        target = next;
        return [];
      },
    } as unknown as DesktopRuntimeHostClient,
    workspaceRoot: "/client-workspace",
    mainWindowController: {} as never,
    getSelectedWorkspaceTarget: async () => undefined,
    resolveNewSessionWorkspaceTarget: async (projectId) => {
      resolvedProjectIds.push(projectId);
      return typeof projectId === "string"
        ? { kind: "project", projectId }
        : undefined;
    },
    getDefaultPermissionMode: async () => "ask",
    openPath: async () => "",
  });

  const handler = handlers.get("skills:listInvocable");
  assert.ok(handler);
  assert.deepEqual(
    await handler({} as never, undefined, {
      projectId: "project-docs",
      collaborationMode: "plan",
      permissionMode: "bypass",
    }),
    [],
  );
  assert.deepEqual(resolvedProjectIds, ["project-docs"]);
  assert.deepEqual(target, {
    kind: "new_session",
    context: { workspace: { kind: "project", projectId: "project-docs" } },
    collaborationMode: "plan",
    permissionMode: "bypass",
  });
});
