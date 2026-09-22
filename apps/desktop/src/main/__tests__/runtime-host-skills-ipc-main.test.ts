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
import { chmod, lstat, mkdir, mkdtemp, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { WorkspaceTarget } from "@maka/runtime-host/protocol";
import { createProjectCatalog } from "@maka/storage/project-catalog";
import { HostProjectMembershipGate } from "../../../../../packages/runtime-host/dist/server/project-membership-gate.js";
import { HostWorkspaceResolver } from "../../../../../packages/runtime-host/dist/server/workspace-resolver.js";
import type { OpenSkillLocationResult, SkillLocationsSnapshot } from "../../shared/skill-locations.js";
import type { IpcHandler } from "../ipc-reconnect-policy.js";
import { createProjectManagementService } from "../project-management-service.js";
import type { CurrentProjectSelection } from "../project-root-controller.js";
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
    getSelectedProject: async () => { throw new Error('Remote Host has no Client Project path'); },
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
    contextIds: {},
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
    getSelectedProject: async () => { throw new Error('No Project selected'); },
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
    getSelectedProject: async () => { throw new Error('Remote Host has no Client Project path'); },
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
  const homeDirectory = join(root, "home");
  await Promise.all([projectA, projectB, workspaceRoot, homeDirectory].map((path) => mkdir(path)));
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
    homeDirectory,
    mainWindowController: {} as never,
    getSelectedWorkspaceTarget: async () => ({ kind: "project", projectId: selectedProject }),
    getSelectedProject: async () => ({
      projectId: selectedProject,
      path: selectedProject === 'project-a' ? projectA : projectB,
    }),
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
        contextId: previous.contextIds.project,
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
        contextId: current.contextIds.project,
        createIfMissing: true,
      }),
      { ok: true },
    );
    assert.deepEqual(opened, [await realpath(join(projectB, ".maka", "skills"))]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const createIfMissing of [false, true]) {
  test(`can ${createIfMissing ? 'create and open missing' : 'open existing'} independent Skill directories after the selected Project disappears`, async () => {
    const root = await mkdtemp(join(tmpdir(), "maka-skill-location-missing-project-"));
    const projectRoot = join(root, "project");
    const workspaceRoot = join(root, "workspace");
    const homeDirectory = join(root, "home");
    await Promise.all([projectRoot, workspaceRoot, homeDirectory].map((path) => mkdir(path)));
    const independentLocations = [
      { ref: 'workspace:legacy', scope: 'workspace', path: join(workspaceRoot, 'skills') },
      { ref: 'user:maka', scope: 'user', path: join(homeDirectory, '.maka', 'skills') },
      { ref: 'user:agents', scope: 'user', path: join(homeDirectory, '.agents', 'skills') },
    ] as const;
    if (!createIfMissing) {
      await Promise.all(independentLocations.map(({ path }) => mkdir(path, { recursive: true })));
    }
    const catalog = createProjectCatalog(join(root, "state"));
    try {
      const project = await catalog.register(projectRoot);
      let selection: CurrentProjectSelection = {
        projectId: project.id,
        path: await realpath(projectRoot),
      };
      const management = createProjectManagementService({
        catalog: {
          list: () => catalog.list(),
          register: (path) => catalog.register(path),
          relink: async (id, path) => (await catalog.relinkWithSessions(id, path)).project,
          rename: (id, name) => catalog.rename(id, name),
          archive: (id) => catalog.archive(id),
          restore: (id) => catalog.restore(id),
        },
        chooseDirectory: async () => undefined,
        selection: {
          currentSelection: async () => selection,
          setSelection: (projectId, path) => { selection = { projectId, path }; },
        },
        capabilities: {
          chooseClientDirectory: true,
          chooseHostDirectory: false,
          selectNoProject: true,
          setLocalDefault: true,
          viewClientPath: true,
        },
      });
      const resolver = new HostWorkspaceResolver(catalog, new HostProjectMembershipGate(), () => {});
      const handlers = new Map<string, IpcHandler>();
      const opened: string[] = [];
      registerRuntimeHostSkillsIpc({
        ipcMain: {
          handle: (channel, listener) => handlers.set(channel, listener),
          handleReconnectableRead: (channel, listener) => handlers.set(channel, listener),
        },
        client: {
          loadSkillCatalog: async ({ workspace }: { workspace: WorkspaceTarget }) => {
            const resolved = await resolver.resolve(workspace);
            return { workspace: { target: resolved.target, hostCwd: resolved.cwd }, items: [] };
          },
        } as unknown as DesktopRuntimeHostClient,
        workspaceRoot,
        homeDirectory,
        mainWindowController: {} as never,
        getSelectedWorkspaceTarget: async () => {
          const current = await management.current();
          return typeof current.projectId === "string"
            ? { kind: "project", projectId: current.projectId }
            : { kind: "host_path", path: current.path };
        },
        getSelectedProject: () => management.current(),
        resolveNewSessionWorkspaceTarget: async () => undefined,
        getDefaultPermissionMode: async () => "ask",
        resolveLocale: async () => "en",
        openPath: async (path) => {
          opened.push(path);
          return "";
        },
      });
      const list = handlers.get("skills:locations:list");
      const open = handlers.get("skills:locations:open");
      assert.ok(list);
      assert.ok(open);
      const previous: SkillLocationsSnapshot = await list({} as never);
      assert.ok(previous.contextIds.project);

      await rename(projectRoot, join(root, "moved-project"));
      const current: SkillLocationsSnapshot = await list({} as never);
      assert.equal((await management.current()).projectId, null);
      assert.deepEqual(current.locations.map(({ ref, status }) => ({ ref, status })), [
        { ref: 'project:maka', status: 'read_failed' },
        { ref: 'project:agents', status: 'read_failed' },
        { ref: 'workspace:legacy', status: createIfMissing ? 'missing' : 'available' },
        { ref: 'user:maka', status: createIfMissing ? 'missing' : 'available' },
        { ref: 'user:agents', status: createIfMissing ? 'missing' : 'available' },
      ]);
      for (const { ref, scope } of independentLocations) {
        assert.equal(current.contextIds[scope], previous.contextIds[scope]);
        assert.deepEqual(await open({} as never, ref, {
          contextId: previous.contextIds[scope],
          createIfMissing,
        }), { ok: true });
        assert.deepEqual(await open({} as never, ref, { contextId: current.contextIds[scope] }), { ok: true });
      }
      assert.deepEqual(opened, (
        await Promise.all(independentLocations.map(({ path }) => realpath(path)))
      ).flatMap((path) => [path, path]));
      const projectContexts: Array<string | undefined> = [previous.contextIds.project, current.contextIds.project];
      for (const ref of ['project:maka', 'project:agents']) {
        for (const contextId of projectContexts) {
          assert.deepEqual(await open({} as never, ref, { contextId, createIfMissing: true }), {
            ok: false,
            reason: 'stale_context',
          });
        }
      }
      await assert.rejects(lstat(projectRoot), { code: 'ENOENT' });
      await assert.rejects(lstat(join(workspaceRoot, '.maka')), { code: 'ENOENT' });
      await assert.rejects(lstat(join(workspaceRoot, '.agents')), { code: 'ENOENT' });
      const refreshed: SkillLocationsSnapshot = await list({} as never);
      assert.ok(refreshed.locations
        .filter(({ scope }) => scope !== 'project')
        .every(({ status }) => status === 'available'),
      );
    } finally {
      catalog.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("Skill location contexts reject another scope, a remounted root, and a replacement Host", async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-skill-location-scope-'));
  const firstRoot = join(root, 'first');
  const secondRoot = join(root, 'second');
  const workspaceRoot = join(root, 'workspace');
  const homeDirectory = join(root, 'home');
  await Promise.all([firstRoot, secondRoot].map((path) => mkdir(path)));
  await symlink(firstRoot, workspaceRoot, 'junction');
  await symlink(firstRoot, homeDirectory, 'junction');
  const opened: string[] = [];
  const register = () => {
    const handlers = new Map<string, IpcHandler>();
    registerRuntimeHostSkillsIpc({
      ipcMain: {
        handle: (channel, listener) => handlers.set(channel, listener),
        handleReconnectableRead: (channel, listener) => handlers.set(channel, listener),
      },
      client: new Proxy({}, { get() { throw new Error('Host Skill catalog is unavailable'); } }) as DesktopRuntimeHostClient,
      workspaceRoot,
      homeDirectory,
      mainWindowController: {} as never,
      getSelectedWorkspaceTarget: async () => { throw new Error('Project is unavailable'); },
      getSelectedProject: async () => { throw new Error('Project is unavailable'); },
      resolveNewSessionWorkspaceTarget: async () => undefined,
      getDefaultPermissionMode: async () => 'ask',
      resolveLocale: async () => 'en',
      openPath: async (path) => { opened.push(path); return ''; },
    });
    const list = handlers.get('skills:locations:list');
    const open = handlers.get('skills:locations:open');
    assert.ok(list);
    assert.ok(open);
    return {
      list: async (): Promise<SkillLocationsSnapshot> => list({} as never),
      open: (ref: string, contextId: string | undefined) =>
        open({} as never, ref, { contextId, createIfMissing: true }),
    };
  };
  try {
    const host = register();
    const initial = await host.list();
    assert.deepEqual(initial.locations.map(({ ref }) => ref), ['workspace:legacy', 'user:maka', 'user:agents']);
    const canonicalFirstRoot = await realpath(firstRoot);
    assert.deepEqual(initial.locations.map(({ path, status }) => ({ path, status })), [
      { path: join(canonicalFirstRoot, 'skills'), status: 'missing' },
      { path: join(canonicalFirstRoot, '.maka', 'skills'), status: 'missing' },
      { path: join(canonicalFirstRoot, '.agents', 'skills'), status: 'missing' },
    ]);
    assert.deepEqual(await host.open('user:agents', initial.contextIds.workspace), { ok: false, reason: 'stale_context' });
    assert.deepEqual(await host.open('workspace:legacy', initial.contextIds.user), { ok: false, reason: 'stale_context' });
    assert.deepEqual(await host.open('../outside', initial.contextIds.user), { ok: false, reason: 'unknown_location' });

    await rename(workspaceRoot, join(root, 'previous-workspace'));
    await rename(homeDirectory, join(root, 'previous-home'));
    await symlink(secondRoot, workspaceRoot, 'junction');
    await symlink(secondRoot, homeDirectory, 'junction');
    assert.deepEqual(await host.open('workspace:legacy', initial.contextIds.workspace), { ok: false, reason: 'stale_context' });
    assert.deepEqual(await host.open('user:agents', initial.contextIds.user), { ok: false, reason: 'stale_context' });

    const remounted = await host.list();
    const replacement = register();
    assert.deepEqual(await replacement.open('workspace:legacy', remounted.contextIds.workspace), { ok: false, reason: 'stale_context' });
    assert.deepEqual(await replacement.open('user:agents', remounted.contextIds.user), { ok: false, reason: 'stale_context' });
    assert.deepEqual(opened, []);
    await assert.rejects(lstat(join(secondRoot, 'skills')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(secondRoot, '.agents')), { code: 'ENOENT' });

    const current = await replacement.list();
    assert.deepEqual(await replacement.open('workspace:legacy', current.contextIds.workspace), { ok: true });
    assert.deepEqual(await replacement.open('user:agents', current.contextIds.user), { ok: true });
    assert.deepEqual(opened, [await realpath(join(secondRoot, 'skills')), await realpath(join(secondRoot, '.agents', 'skills'))]);
    const available = await replacement.list();
    assert.deepEqual(
      available.locations.filter(({ status }) => status === 'available').map(({ path }) => path),
      opened,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reports open_failed when the native shell cannot open a Skill directory', async () => {
  await withLocationIpc(async ({ workspaceRoot, list, open, opened }) => {
    await mkdir(join(workspaceRoot, 'skills'));
    const snapshot = await list();
    assert.deepEqual(await open('workspace:legacy', {
      contextId: snapshot.contextIds.workspace,
      createIfMissing: false,
    }), { ok: false, reason: 'open_failed' });
    assert.deepEqual(opened, [await realpath(join(workspaceRoot, 'skills'))]);
  }, 'The file manager could not open the directory');
});

test('reports create_failed without opening when a Skill directory parent is not writable', {
  skip: process.platform === 'win32'
    ? 'POSIX permissions are required to make the Skill directory parent read-only'
    : process.getuid?.() === 0,
}, async () => {
  await withLocationIpc(async ({ workspaceRoot, list, open, opened }) => {
    const snapshot = await list();
    await chmod(workspaceRoot, 0o500);
    try {
      assert.deepEqual(await open('workspace:legacy', {
        contextId: snapshot.contextIds.workspace,
        createIfMissing: true,
      }), { ok: false, reason: 'create_failed' });
      assert.deepEqual(opened, []);
      const current = await list();
      assert.equal(current.locations.find(({ ref }) => ref === 'workspace:legacy')?.status, 'missing');
    } finally {
      await chmod(workspaceRoot, 0o700);
    }
  });
});

test('blocks leaf-symlink Skill directories at IPC even when their target is contained', async () => {
  await withLocationIpc(async ({ root, workspaceRoot, homeDirectory, list, open, opened }) => {
    const contained = join(workspaceRoot, 'contained');
    const outside = join(root, 'outside');
    await Promise.all([contained, outside, join(homeDirectory, '.agents')].map((path) => mkdir(path)));
    await symlink(contained, join(workspaceRoot, 'skills'), 'junction');
    await symlink(outside, join(homeDirectory, '.agents', 'skills'), 'junction');
    const snapshot = await list();
    for (const [ref, scope] of [['workspace:legacy', 'workspace'], ['user:agents', 'user']] as const) {
      assert.equal(snapshot.locations.find((location) => location.ref === ref)?.status, 'blocked_path');
      for (const createIfMissing of [false, true]) {
        assert.deepEqual(await open(ref, {
          contextId: snapshot.contextIds[scope],
          createIfMissing,
        }), { ok: false, reason: 'blocked_path' });
      }
    }
    assert.deepEqual(opened, []);
  });
});

async function withLocationIpc(
  run: (fixture: {
    root: string;
    workspaceRoot: string;
    homeDirectory: string;
    opened: string[];
    list: () => Promise<SkillLocationsSnapshot>;
    open: (
      ref: string,
      options: { contextId?: string; createIfMissing?: boolean },
    ) => Promise<OpenSkillLocationResult>;
  }) => Promise<void>,
  openPathError = '',
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-skill-location-ipc-'));
  const workspaceRoot = join(root, 'workspace');
  const homeDirectory = join(root, 'home');
  const handlers = new Map<string, IpcHandler>();
  const opened: string[] = [];
  try {
    await Promise.all([workspaceRoot, homeDirectory].map((path) => mkdir(path)));
    registerRuntimeHostSkillsIpc({
      ipcMain: {
        handle: (channel, listener) => handlers.set(channel, listener),
        handleReconnectableRead: (channel, listener) => handlers.set(channel, listener),
      },
      client: new Proxy({}, { get() { throw new Error('Location operations must not read the Host catalog'); } }) as DesktopRuntimeHostClient,
      workspaceRoot,
      homeDirectory,
      mainWindowController: {} as never,
      getSelectedWorkspaceTarget: async () => undefined,
      getSelectedProject: async () => { throw new Error('No Project selected'); },
      resolveNewSessionWorkspaceTarget: async () => undefined,
      getDefaultPermissionMode: async () => 'ask',
      resolveLocale: async () => 'en',
      openPath: async (path) => { opened.push(path); return openPathError; },
    });
    const list = handlers.get('skills:locations:list');
    const open = handlers.get('skills:locations:open');
    assert.ok(list);
    assert.ok(open);
    await run({
      root,
      workspaceRoot,
      homeDirectory,
      opened,
      list: () => list({} as never),
      open: (ref, options) => open({} as never, ref, options),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
