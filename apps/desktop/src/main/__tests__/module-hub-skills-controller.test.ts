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

import { deferred } from '@maka/core/test-only/async-primitives';
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, createElement } from "react";
import type { SkillEntry, ToastApi } from "@maka/ui";
import type { OpenSkillLocationResult, SkillLocationsSnapshot } from "../../shared/skill-locations.js";
import { cleanupFakeDom, installReactRenderer } from "./fake-dom.js";
import {
  createFakeModuleHubServices,
  ModuleHubServicesProvider,
  useSkillsController,
  type ModuleHubServices,
  type SkillsController,
  type UseSkillsControllerInput,
} from "../../renderer/features/module-hub/testing.js";
function skill(id: string): SkillEntry {
  return {
    id,
    name: id,
    description: `${id} description`,
    path: `/skills/${id}/SKILL.md`,
    enabled: true,
    runtimeStatus: "enabled",
  };
}

function skillLocations(project: string): SkillLocationsSnapshot {
  return {
    contextIds: { project },
    locations: [{
      ref: "project:agents",
      scope: "project",
      source: "agents",
      path: `/${project}/.agents/skills`,
      status: "missing",
      skillCount: 0,
    }],
  };
}

type ToastRecord = {
  kind: "success" | "error";
  title: string;
  description?: string;
  profileId?: string;
};

function toastRecorder(
  records: ToastRecord[],
): Pick<ToastApi, "success" | "error"> {
  return {
    success: (title, description) => {
      records.push({ kind: "success", title, description });
      return "success-toast";
    },
    error: (title, description, _diagnosticDetails, diagnosticTarget) => {
      records.push({
        kind: "error",
        title,
        description,
        ...(diagnosticTarget && "profileId" in diagnosticTarget
          ? { profileId: diagnosticTarget.profileId }
          : {}),
      });
      return "error-toast";
    },
  };
}

let latestController: SkillsController | undefined;

function ControllerProbe(props: UseSkillsControllerInput) {
  latestController = useSkillsController(props);
  return null;
}

function renderController(
  root: ReturnType<typeof installReactRenderer>["root"],
  services: ModuleHubServices,
  input: UseSkillsControllerInput,
) {
  root.render(
    createElement(
      ModuleHubServicesProvider,
      { services },
      createElement(ControllerProbe, input),
    ),
  );
}

function controller(): SkillsController {
  assert.ok(latestController);
  return latestController;
}

function input(
  records: ToastRecord[],
  overrides: Partial<UseSkillsControllerInput> = {},
): UseSkillsControllerInput {
  return {
    uiLocale: "en",
    active: true,
    clientPathsAccessible: false,
    toastApi: toastRecorder(records),
    useSkillInChat: () => undefined,
    ...overrides,
  };
}

afterEach(() => {
  latestController = undefined;
  cleanupFakeDom();
});

test("Skills projections have independent same-Host generation and default-Host fences", async () => {
  const { root } = installReactRenderer();
  const records: ToastRecord[] = [];
  const hostA = { profileId: "profile-a", hostId: "host-a" };
  const hostB = { profileId: "profile-b", hostId: "host-b" };
  let defaultHost = hostA;
  const staleSkills = deferred<SkillEntry[]>();
  let skillReads = 0;
  const defaults = createFakeModuleHubServices();
  const services = createFakeModuleHubServices({
    runtimeHosts: {
      ...defaults.runtimeHosts,
      getDefault: async () => defaultHost,
    },
    skills: {
      ...defaults.skills,
      list: async (host) => {
        assert.equal(host, defaultHost);
        skillReads += 1;
        return skillReads === 1
          ? staleSkills.promise
          : [skill(`new-${host.hostId}`)];
      },
      listManagedSources: async () => [
        {
          id: "source-a",
          name: "Source A",
          description: "Source",
          category: "效率工具",
          sourceType: "local",
        },
      ],
      listLocations: async () => skillLocations("project"),
      listBundledCatalog: async () => [
        {
          id: "bundled-a",
          name: "Bundled A",
          description: "Bundled",
          category: "效率工具",
          declaredTools: [],
          installed: false,
        },
      ],
    },
  });

  await act(async () => renderController(root, services, input(records, { clientPathsAccessible: true })));
  let first: Promise<void>;
  await act(async () => { first = controller().host.onRefreshSkills(); });
  await act(async () => controller().host.onRefreshSkills());
  assert.deepEqual(
    controller().host.skills.map(({ id }) => id),
    ["new-host-a"],
  );
  assert.equal(controller().revision, 1);

  await act(async () => {
    staleSkills.resolve([skill("stale-host-a")]);
    await first;
  });
  assert.deepEqual(
    controller().host.skills.map(({ id }) => id),
    ["new-host-a"],
  );
  assert.equal(controller().revision, 1);

  await act(async () => controller().refreshProjectSkills());
  assert.equal(controller().revision, 2);
  assert.equal(controller().host.managedSkillSources[0]?.id, "source-a");
  assert.equal(controller().host.bundledSkillCatalog[0]?.id, "bundled-a");
  assert.equal(controller().host.skillLocations[0]?.ref, "project:agents");

  const lateHostRead = deferred<SkillEntry[]>();
  services.skills.list = async () => lateHostRead.promise;
  let pending: Promise<void>;
  await act(async () => { pending = controller().host.onRefreshSkills(); });
  defaultHost = hostB;
  await act(async () => {
    lateHostRead.resolve([skill("late-host-a")]);
    await pending;
  });
  assert.deepEqual(
    controller().host.skills.map(({ id }) => id),
    ["new-host-a"],
  );
  assert.equal(controller().revision, 2);
  assert.equal(records.length, 0);
});

test("Skills mutations preserve refresh combinations and suppress inactive or cancelled feedback", async () => {
  const { root } = installReactRenderer();
  const records: ToastRecord[] = [];
  const calls: string[] = [];
  const defaults = createFakeModuleHubServices();
  const services = createFakeModuleHubServices({
    runtimeHosts: defaults.runtimeHosts,
    skills: {
      ...defaults.skills,
      list: async () => {
        calls.push("list");
        return [];
      },
      listLocations: async () => {
        calls.push("locations");
        return { contextIds: {}, locations: [] };
      },
      listManagedSources: async () => {
        calls.push("sources");
        return [];
      },
      listBundledCatalog: async () => {
        calls.push("catalog");
        return [];
      },
      importManagedSource: async () => ({ ok: false, reason: "cancelled" }),
      installManaged: async () => ({ ok: true, skill: skill("managed") }),
      installBundled: async () => ({ ok: true, skill: skill("bundled") }),
      updateManaged: async () => ({ ok: true, skill: skill("updated") }),
      setEnabled: async (_id, enabled) => ({
        ok: true,
        skill: { ...skill("enabled"), enabled },
      }),
      setPinned: async (_id, pinned) => ({
        ok: true,
        skill: { ...skill("pinned"), pinned },
      }),
      delete: async () => ({ ok: true }),
    },
  });
  const activeInput = input(records, {
    clientPathsAccessible: true,
  });
  await act(async () => renderController(root, services, activeInput));
  const importManagedSkillSource =
    controller().host.onImportManagedSkillSource;
  assert.ok(importManagedSkillSource);

  await act(async () => importManagedSkillSource());
  assert.equal(records.length, 0);

  services.skills.importManagedSource = async () => ({
    ok: true,
    source: {
      id: "imported",
      name: "Imported",
      description: "Imported source",
      category: "效率工具",
      sourceType: "local",
    },
  });
  await act(async () => importManagedSkillSource());
  assert.deepEqual(calls.splice(0), ["sources"]);

  await act(async () => controller().host.onInstallManagedSkill("source-a"));
  assert.deepEqual(calls.splice(0), ["list", "locations", "sources"]);
  assert.equal(records.at(-1)?.kind, "success");

  await act(async () => controller().host.onInstallBundledSkill("bundled-a"));
  assert.deepEqual(calls.splice(0), ["list", "locations", "catalog"]);

  await act(async () => {
    assert.equal(await controller().host.onUpdateManagedSkill("managed"), true);
  });
  assert.deepEqual(calls.splice(0), ["list"]);

  await act(async () => controller().host.onSetSkillEnabled("managed", false));
  assert.deepEqual(calls.splice(0), ["list"]);

  await act(async () => controller().host.onSetSkillPinned("managed", true));
  assert.deepEqual(calls.splice(0), ["list"]);

  await act(async () =>
    controller().host.onDeleteSkill("user:agents:bundled-a"),
  );
  assert.deepEqual(calls.splice(0), ["list", "locations", "catalog"]);
  assert.match(records.at(-1)?.description ?? "", /bundled-a/);

  const lateInstall = deferred<ReturnType<typeof skill>>();
  services.skills.installManaged = async () => ({
    ok: true,
    skill: await lateInstall.promise,
  });
  const pending = controller().host.onInstallManagedSkill("late");
  await act(async () =>
    renderController(root, services, { ...activeInput, active: false }),
  );
  const recordCount = records.length;
  await act(async () => {
    lateInstall.resolve(skill("late"));
    await pending;
  });
  assert.equal(records.length, recordCount);
});

test("Skills capabilities and stale mutation diagnostics are fenced", async () => {
  const { root } = installReactRenderer();
  const records: ToastRecord[] = [];
  const hostA = { profileId: "profile-a", hostId: "host-a" };
  const hostB = { profileId: "profile-b", hostId: "host-b" };
  let defaultHost = hostA;
  const openFailure = deferred<never>();
  const used: string[] = [];
  const opened: Array<{ ref: string; createIfMissing: boolean }> = [];
  const defaults = createFakeModuleHubServices();
  const services = createFakeModuleHubServices({
    runtimeHosts: {
      ...defaults.runtimeHosts,
      getDefault: async () => defaultHost,
    },
    skills: {
      ...defaults.skills,
      open: async () => openFailure.promise,
      listLocations: async () => skillLocations("project"),
      openLocation: async (ref, options) => {
        opened.push({ ref, createIfMissing: options.createIfMissing === true });
        return { ok: true };
      },
    },
  });

  await act(async () =>
    renderController(
      root,
      services,
      input(records, {
        useSkillInChat: (id, name) => used.push(`${id}:${name}`),
      }),
    ),
  );
  assert.equal(controller().host.onOpenSkill, undefined);
  assert.equal(controller().host.onOpenSkillLocation, undefined);
  assert.equal(controller().host.onImportManagedSkillSource, undefined);
  controller().host.onUseSkill("skill-a", "Skill A");
  assert.deepEqual(used, ["skill-a:Skill A"]);

  await act(async () =>
    renderController(
      root,
      services,
      input(records, {
        useSkillInChat: () => undefined,
        clientPathsAccessible: true,
      }),
    ),
  );
  assert.equal(typeof controller().host.onOpenSkill, "function");
  assert.equal(
    typeof controller().host.onImportManagedSkillSource,
    "function",
  );
  assert.equal(controller().host.onOpenSkillLocation, undefined);
  await act(async () => controller().host.onRefreshSkills());
  assert.equal(typeof controller().host.onOpenSkillLocation, "function");
  await act(async () =>
    controller().host.onOpenSkillLocation?.("project:agents", true),
  );
  assert.deepEqual(opened, [{ ref: "project:agents", createIfMissing: true }]);

  const pendingOpen = controller().host.onOpenSkill?.("skill-a");
  defaultHost = hostB;
  await act(async () => {
    openFailure.reject(new Error("old host offline"));
    await pendingOpen;
  });
  assert.equal(records.length, 0);

  services.skills.open = async () => ({ ok: false, reason: "missing" });
  await act(async () => controller().host.onOpenSkill?.("missing"));
  assert.equal(records.length, 1);
  assert.equal(records[0]?.kind, "error");
  assert.equal(records[0]?.profileId, "profile-b");
});

test("Skills errors recheck the active surface after an async Host fence", async () => {
  const { root } = installReactRenderer();
  const records: ToastRecord[] = [];
  const host = { profileId: "profile-a", hostId: "host-a" };
  const hostRecheck = deferred<typeof host>();
  let hostReads = 0;
  const defaults = createFakeModuleHubServices();
  const services = createFakeModuleHubServices({
    runtimeHosts: {
      ...defaults.runtimeHosts,
      getDefault: async () => {
        hostReads += 1;
        return hostReads === 1 ? host : hostRecheck.promise;
      },
    },
    skills: {
      ...defaults.skills,
      open: async () => {
        throw new Error("open failed");
      },
    },
  });

  const capability = { clientPathsAccessible: true };
  await act(async () =>
    renderController(root, services, input(records, capability)),
  );
  const pendingOpen = controller().host.onOpenSkill?.("skill-a");
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(hostReads, 2);

  await act(async () =>
    renderController(
      root,
      services,
      input(records, { ...capability, active: false }),
    ),
  );
  hostRecheck.resolve(host);
  await act(async () => pendingOpen);
  assert.deepEqual(records, []);
});

test("stale Skills refresh errors do not outlive a newer successful generation", async () => {
  const { root } = installReactRenderer();
  const records: ToastRecord[] = [];
  const host = { profileId: "profile-a", hostId: "host-a" };
  const staleHostRecheck = deferred<typeof host>();
  const staleLocationRead = deferred<SkillLocationsSnapshot>();
  let hostReads = 0;
  let skillReads = 0;
  let locationReads = 0;
  const defaults = createFakeModuleHubServices();
  const services = createFakeModuleHubServices({
    runtimeHosts: {
      ...defaults.runtimeHosts,
      getDefault: async () => {
        hostReads += 1;
        return hostReads === 3 ? staleHostRecheck.promise : host;
      },
    },
    skills: {
      ...defaults.skills,
      list: async () => {
        skillReads += 1;
        if (skillReads === 1) throw new Error("stale refresh failed");
        return [skill("fresh")];
      },
      listLocations: async () => {
        locationReads += 1;
        return locationReads === 1
          ? staleLocationRead.promise
          : { contextIds: {}, locations: [] };
      },
    },
  });

  await act(async () => renderController(root, services, input(records, { clientPathsAccessible: true })));
  let staleRefresh: Promise<void>;
  await act(async () => {
    staleRefresh = controller().host.onRefreshSkills();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(hostReads, 3);

  await act(async () => controller().host.onRefreshSkills());
  assert.deepEqual(
    controller().host.skills.map(({ id }) => id),
    ["fresh"],
  );

  staleHostRecheck.resolve(host);
  staleLocationRead.resolve({ contextIds: {}, locations: [] });
  await act(async () => staleRefresh);
  assert.deepEqual(records, []);
});

test("Skills refresh failures stay silent while the default Host is unavailable", async () => {
  const { root } = installReactRenderer();
  const records: ToastRecord[] = [];
  const host = { profileId: "profile-a", hostId: "host-a" };
  let defaultHost: typeof host | undefined;
  const defaults = createFakeModuleHubServices();
  const services = createFakeModuleHubServices({
    runtimeHosts: {
      ...defaults.runtimeHosts,
      getDefault: async () => {
        if (!defaultHost) throw new Error("identity is unavailable");
        return defaultHost;
      },
    },
  });

  await act(async () => renderController(root, services, input(records)));
  await act(async () => controller().refreshProjectSkills());
  assert.deepEqual(records, []);
  assert.deepEqual(controller().host.skills, []);

  defaultHost = host;
  await act(async () => controller().refreshProjectSkills());
  assert.equal(controller().revision, 1);
  assert.deepEqual(records, []);

  services.skills.list = async () => {
    throw new Error("list failed");
  };
  await act(async () => controller().host.onRefreshSkills());
  assert.equal(records.filter(({ kind }) => kind === "error").length, 1);
});

test("changing Projects invalidates displayed Skill locations even when the refresh fails", async () => {
  const { root } = installReactRenderer();
  const records: ToastRecord[] = [];
  const opened: Array<{ ref: string; contextId: string; createIfMissing?: boolean }> = [];
  const defaults = createFakeModuleHubServices();
  const services = createFakeModuleHubServices({
    skills: {
      ...defaults.skills,
      listLocations: async () => skillLocations("project-a"),
      openLocation: async (ref, options) => {
        opened.push({ ref, ...options });
        return { ok: true };
      },
    },
  });
  await act(async () =>
    renderController(root, services, input(records, { clientPathsAccessible: true })),
  );
  await act(async () => controller().refreshProjectSkills());
  assert.equal(controller().host.skillLocations[0]?.path, "/project-a/.agents/skills");
  const openPreviousLocation = controller().host.onOpenSkillLocation;
  assert.ok(openPreviousLocation);

  const projectBLocations = deferred<SkillLocationsSnapshot>();
  services.skills.listLocations = async () => projectBLocations.promise;
  let refreshing: Promise<void>;
  await act(async () => { refreshing = controller().refreshProjectSkills(); });
  assert.deepEqual(controller().host.skillLocations, []);
  assert.equal(controller().host.onOpenSkillLocation, undefined);
  await act(async () => openPreviousLocation("project:agents", true));
  assert.deepEqual(opened, []);

  await act(async () => {
    projectBLocations.reject(new Error("project-b unavailable"));
    await refreshing;
  });
  assert.deepEqual(controller().host.skillLocations, []);
  assert.equal(controller().host.onOpenSkillLocation, undefined);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.description, "Skill locations could not be refreshed. Try again later.");

  services.skills.listLocations = async () => skillLocations("project-b");
  await act(async () => controller().host.onRefreshSkills());
  assert.equal(controller().host.skillLocations[0]?.path, "/project-b/.agents/skills");
  await act(async () => openPreviousLocation("project:agents", true));
  assert.deepEqual(opened, []);
  await act(async () => controller().host.onOpenSkillLocation?.("project:agents", true));
  assert.deepEqual(opened, [{
    ref: "project:agents",
    contextId: "project-b",
    createIfMissing: true,
  }]);
});

test("Skill location actions do not retarget a snapshot from a previous default Host", async () => {
  const { root } = installReactRenderer();
  const records: ToastRecord[] = [];
  const hostA = { profileId: "profile-a", hostId: "host-a" };
  const hostB = { profileId: "profile-b", hostId: "host-b" };
  let defaultHost = hostA;
  const opened: unknown[] = [];
  const defaults = createFakeModuleHubServices();
  const services = createFakeModuleHubServices({
    runtimeHosts: {
      ...defaults.runtimeHosts,
      getDefault: async () => defaultHost,
    },
    skills: {
      ...defaults.skills,
      listLocations: async () => skillLocations("project"),
      openLocation: async (ref, options, host) => {
        opened.push({ ref, ...options, host });
        return { ok: true };
      },
    },
  });
  await act(async () =>
    renderController(root, services, input(records, { clientPathsAccessible: true })),
  );
  await act(async () => controller().refreshProjectSkills());
  const openPreviousLocation = controller().host.onOpenSkillLocation;
  assert.ok(openPreviousLocation);
  defaultHost = hostB;
  await act(async () => openPreviousLocation("project:agents", true));
  assert.deepEqual(opened, []);
  await act(async () => controller().refreshProjectSkills());
  await act(async () => controller().host.onOpenSkillLocation?.("project:agents", false));
  assert.deepEqual(opened, [{
    ref: "project:agents",
    contextId: "project",
    createIfMissing: false,
    host: hostB,
  }]);
  assert.deepEqual(records, []);
});

test("a late Skill location response cannot restore the previous Project's directories", async () => {
  const { root } = installReactRenderer();
  const records: ToastRecord[] = [];
  const projectA = deferred<SkillLocationsSnapshot>();
  const defaults = createFakeModuleHubServices();
  const services = createFakeModuleHubServices({
    skills: {
      ...defaults.skills,
      listLocations: async () => projectA.promise,
    },
  });
  await act(async () =>
    renderController(root, services, input(records, { clientPathsAccessible: true })),
  );
  let previousRefresh: Promise<void>;
  await act(async () => { previousRefresh = controller().refreshProjectSkills(); });
  services.skills.listLocations = async () => skillLocations("project-b");
  await act(async () => controller().refreshProjectSkills());
  await act(async () => {
    projectA.resolve(skillLocations("project-a"));
    await previousRefresh;
  });
  assert.equal(controller().host.skillLocations[0]?.path, "/project-b/.agents/skills");
  assert.deepEqual(records, []);
});

test("independent Skill locations stay actionable when the Project has no usable context", async () => {
  const { root } = installReactRenderer();
  const records: ToastRecord[] = [];
  const opened: unknown[] = [];
  const defaults = createFakeModuleHubServices();
  const snapshot: SkillLocationsSnapshot = {
    contextIds: { workspace: 'workspace-context', user: 'user-context' },
    locations: [
      { ref: 'project:agents', scope: 'project', source: 'agents', path: '/missing/.agents/skills', status: 'read_failed', skillCount: 0 },
      { ref: 'workspace:legacy', scope: 'workspace', source: 'legacy', path: '/workspace/skills', status: 'available', skillCount: 0 },
      { ref: 'user:agents', scope: 'user', source: 'agents', path: '/home/.agents/skills', status: 'missing', skillCount: 0 },
    ],
  };
  const services = createFakeModuleHubServices({
    skills: {
      ...defaults.skills,
      list: async () => { throw new Error('Project is unavailable'); },
      listLocations: async () => snapshot,
      openLocation: async (ref, options) => { opened.push({ ref, ...options }); return { ok: true }; },
    },
  });
  await act(async () => renderController(root, services, input(records, { clientPathsAccessible: true })));
  await act(async () => controller().refreshProjectSkills());
  assert.deepEqual(controller().host.skillLocations, snapshot.locations);
  const open = controller().host.onOpenSkillLocation;
  assert.ok(open);
  await act(async () => open('project:agents', true));
  assert.deepEqual(opened, []);
  await act(async () => open('workspace:legacy', false));
  await act(async () => open('user:agents', true));
  assert.deepEqual(opened, [
    { ref: 'workspace:legacy', contextId: 'workspace-context', createIfMissing: false },
    { ref: 'user:agents', contextId: 'user-context', createIfMissing: true },
  ]);
});

for (const reason of ['stale_context', 'missing'] as const) {
  test(`refreshes Skill locations after ${reason} without retrying the open action`, async () => {
    const { root } = installReactRenderer();
    const records: ToastRecord[] = [];
    const opened: unknown[] = [];
    const defaults = createFakeModuleHubServices();
    let locationReads = 0;
    const services = createFakeModuleHubServices({
      skills: {
        ...defaults.skills,
        listLocations: async () => {
          locationReads += 1;
          return skillLocations(locationReads === 1 ? 'project-a' : 'project-b');
        },
        openLocation: async (ref, options) => {
          opened.push({ ref, ...options });
          return { ok: false, reason };
        },
      },
    });
    await act(async () => renderController(root, services, input(records, { clientPathsAccessible: true })));
    await act(async () => controller().refreshProjectSkills());
    const openPreviousLocation = controller().host.onOpenSkillLocation;
    assert.ok(openPreviousLocation);

    await act(async () => openPreviousLocation('project:agents', false));
    assert.equal(controller().host.skillLocations[0]?.path, '/project-b/.agents/skills');
    assert.equal(locationReads, 2);
    assert.deepEqual(opened, [{ ref: 'project:agents', contextId: 'project-a', createIfMissing: false }]);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.kind, 'error');

    await act(async () => openPreviousLocation('project:agents', true));
    assert.equal(opened.length, 1);
    await act(async () => controller().host.onOpenSkillLocation?.('project:agents', true));
    assert.deepEqual(opened[1], { ref: 'project:agents', contextId: 'project-b', createIfMissing: true });
  });
}

test('remote Skills refreshes skip location IPC and clear local directory actions', async () => {
  const { root } = installReactRenderer();
  const records: ToastRecord[] = [];
  const defaults = createFakeModuleHubServices();
  let locationReads = 0;
  const services = createFakeModuleHubServices({
    skills: {
      ...defaults.skills,
      list: async () => [skill('host-skill')],
      listLocations: async () => {
        locationReads += 1;
        return skillLocations('local-project');
      },
    },
  });
  await act(async () => renderController(root, services, input(records)));
  await act(async () => controller().refreshProjectSkills());
  assert.equal(locationReads, 0);
  assert.equal(controller().host.skills[0]?.id, 'host-skill');
  assert.deepEqual(controller().host.skillLocations, []);
  assert.equal(controller().host.onOpenSkillLocation, undefined);

  await act(async () => renderController(root, services, input(records, { clientPathsAccessible: true })));
  assert.equal(locationReads, 1);
  assert.equal(controller().host.skillLocations[0]?.path, '/local-project/.agents/skills');
  await act(async () => renderController(root, services, input(records)));
  await act(async () => controller().host.onRefreshSkills());
  assert.equal(locationReads, 1);
  assert.deepEqual(controller().host.skillLocations, []);
  assert.equal(controller().host.onOpenSkillLocation, undefined);
  assert.deepEqual(records, []);
});

for (const transition of ['Host', 'surface', 'generation', 'capability'] as const) {
  test(`a late Skill location failure cannot refresh after its ${transition} changes`, async () => {
    const { root } = installReactRenderer();
    const records: ToastRecord[] = [];
    const defaults = createFakeModuleHubServices();
    const failure = deferred<OpenSkillLocationResult>();
    let defaultHost = { profileId: 'profile-a', hostId: 'host-a' };
    let locationReads = 0;
    const services = createFakeModuleHubServices({
      runtimeHosts: { ...defaults.runtimeHosts, getDefault: async () => defaultHost },
      skills: {
        ...defaults.skills,
        listLocations: async () => {
          locationReads += 1;
          return skillLocations(`project-${locationReads}`);
        },
        openLocation: async () => failure.promise,
      },
    });
    const activeInput = input(records, { clientPathsAccessible: true });
    await act(async () => renderController(root, services, activeInput));
    await act(async () => controller().refreshProjectSkills());
    let pending: Promise<void> | undefined;
    await act(async () => { pending = controller().host.onOpenSkillLocation?.('project:agents', false); });
    if (transition === 'Host') defaultHost = { profileId: 'profile-b', hostId: 'host-b' };
    if (transition === 'surface') {
      await act(async () => renderController(root, services, { ...activeInput, active: false }));
    }
    if (transition === 'capability') {
      await act(async () => renderController(root, services, { ...activeInput, clientPathsAccessible: false }));
    }
    if (transition === 'generation') await act(async () => controller().host.onRefreshSkills());
    const readsBeforeFailure = locationReads;
    await act(async () => {
      failure.resolve({ ok: false, reason: 'stale_context' });
      await pending;
    });
    assert.equal(locationReads, readsBeforeFailure);
    assert.deepEqual(records, []);
  });
}

for (const stage of ['Host lookup', 'location response'] as const) {
  test(`revoking local paths during ${stage} suppresses pending Skill locations`, async () => {
    const { root } = installReactRenderer();
    const records: ToastRecord[] = [];
    const defaults = createFakeModuleHubServices();
    const host = { profileId: 'profile-a', hostId: 'host-a' };
    const hostRead = deferred<typeof host>();
    const locationRead = deferred<SkillLocationsSnapshot>();
    let locationReads = 0;
    const services = createFakeModuleHubServices({
      runtimeHosts: {
        ...defaults.runtimeHosts,
        getDefault: async () => stage === 'Host lookup' ? hostRead.promise : host,
      },
      skills: {
        ...defaults.skills,
        listLocations: async () => { locationReads += 1; return locationRead.promise; },
      },
    });
    await act(async () => renderController(root, services, input(records, { clientPathsAccessible: true })));
    let pending: Promise<void>;
    await act(async () => { pending = controller().refreshProjectSkills(); });
    await act(async () => renderController(root, services, input(records)));
    await act(async () => {
      hostRead.resolve(host);
      locationRead.resolve(skillLocations('local-project'));
      await pending;
    });
    assert.equal(locationReads, stage === 'Host lookup' ? 0 : 1);
    assert.deepEqual(controller().host.skillLocations, []);
    assert.equal(controller().host.onOpenSkillLocation, undefined);
    assert.deepEqual(records, []);
  });
}
