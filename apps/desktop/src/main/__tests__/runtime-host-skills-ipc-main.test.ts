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

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { WorkspaceTarget } from "@maka/runtime-host/protocol";
import type { SkillLocationsSnapshot } from "../../shared/skill-locations.js";
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
    resolveLocale: async () => 'en' as const,
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
  assert.deepEqual(await handlers.get("skills:locations:list")?.({} as never), {
    contextId: null,
    locations: [],
  });
});

test("binds new-session Skill discovery to its explicit Project", async () => {
  const handlers = new Map<string, IpcHandler>();
  const resolvedProjectIds: Array<string | null | undefined> = [];
  let target: unknown;
  registerRuntimeHostSkillsIpc({
    resolveLocale: async () => 'en' as const,
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

test("blocks Skill location opening for a remote Runtime Host", async () => {
  const handlers = new Map<string, IpcHandler>();
  let opened = false;
  registerRuntimeHostSkillsIpc({
    ipcMain: {
      handle: (channel, listener) => handlers.set(channel, listener),
      handleReconnectableRead: (channel, listener) => handlers.set(channel, listener),
    },
    client: {} as DesktopRuntimeHostClient,
    workspaceRoot: "/client-workspace",
    mainWindowController: {} as never,
    getSelectedWorkspaceTarget: async () => ({ kind: "project", projectId: "remote" }),
    resolveNewSessionWorkspaceTarget: async () => undefined,
    getDefaultPermissionMode: async () => "ask",
    openPath: async () => {
      opened = true;
      return "";
    },
    allowLocalPaths: false,
    resolveLocale: async () => "en",
  });

  const handler = handlers.get("skills:locations:open");
  assert.ok(handler);
  assert.deepEqual(
    await handler({} as never, "user:agents", { createIfMissing: true }),
    { ok: false, reason: "blocked_path" },
  );
  assert.equal(opened, false);
});

test("rejects a Skill location from the previously selected Project before creating a directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "maka-skill-location-context-"));
  const projectA = join(root, "project-a");
  const projectB = join(root, "project-b");
  const workspaceRoot = join(root, "workspace");
  await Promise.all([projectA, projectB, workspaceRoot].map((path) => mkdir(path)));
  const handlers = new Map<string, IpcHandler>();
  const opened: string[] = [];
  let selectedProject = "project-a";
  registerRuntimeHostSkillsIpc({
    ipcMain: {
      handle: (channel, listener) => handlers.set(channel, listener),
      handleReconnectableRead: (channel, listener) => handlers.set(channel, listener),
    },
    client: {
      loadSkillCatalog: async ({ workspace }: { workspace: WorkspaceTarget }) => ({
        workspace: {
          target: workspace,
          hostCwd: workspace.kind === "project" && workspace.projectId === "project-a"
            ? projectA
            : projectB,
        },
        items: [],
      }),
    } as unknown as DesktopRuntimeHostClient,
    workspaceRoot,
    mainWindowController: {} as never,
    getSelectedWorkspaceTarget: async () => ({ kind: "project", projectId: selectedProject }),
    resolveNewSessionWorkspaceTarget: async () => undefined,
    getDefaultPermissionMode: async () => "ask",
    resolveLocale: async () => "en",
    openPath: async (path) => {
      opened.push(path);
      return "";
    },
  });
  try {
    const list = handlers.get("skills:locations:list");
    const open = handlers.get("skills:locations:open");
    assert.ok(list);
    assert.ok(open);
    const previous: SkillLocationsSnapshot = await list({} as never);
    selectedProject = "project-b";

    assert.deepEqual(
      await open({} as never, "project:maka", {
        contextId: previous.contextId,
        createIfMissing: true,
      }),
      { ok: false, reason: "stale_context" },
    );
    assert.deepEqual(opened, []);
    const current: SkillLocationsSnapshot = await list({} as never);
    assert.equal(current.locations.find(({ ref }) => ref === "project:maka")?.status, "missing");
    for (const options of [undefined, { createIfMissing: true }, { contextId: "invalid", createIfMissing: true }]) {
      assert.deepEqual(await open({} as never, "project:maka", options), {
        ok: false,
        reason: "stale_context",
      });
    }
    assert.deepEqual(
      await open({} as never, "project:maka", {
        contextId: current.contextId,
        createIfMissing: true,
      }),
      { ok: true },
    );
    assert.deepEqual(opened, [await realpath(join(projectB, ".maka", "skills"))]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
