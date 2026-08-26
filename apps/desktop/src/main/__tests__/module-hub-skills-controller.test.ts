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
import { afterEach, test } from "node:test";
import { act, createElement } from "react";
import type { SkillEntry, ToastApi } from "@maka/ui";
import { cleanupFakeDom, installReactRenderer } from "./fake-dom.js";
import {
  createFakeModuleHubServices,
  ModuleHubServicesProvider,
  useSkillsController,
  type ModuleHubServices,
  type SkillsController,
  type UseSkillsControllerInput,
} from "../../renderer/features/module-hub/testing.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, reject, resolve };
}

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

  await act(async () => renderController(root, services, input(records)));
  const first = controller().host.onRefreshSkills();
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

  const lateHostRead = deferred<SkillEntry[]>();
  services.skills.list = async () => lateHostRead.promise;
  const pending = controller().host.onRefreshSkills();
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
    openSkillsFolder: () => undefined,
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
  assert.deepEqual(calls.splice(0), ["list", "sources"]);
  assert.equal(records.at(-1)?.kind, "success");

  await act(async () => controller().host.onInstallBundledSkill("bundled-a"));
  assert.deepEqual(calls.splice(0), ["list", "catalog"]);

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
  assert.deepEqual(calls.splice(0), ["list", "catalog"]);
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
  const opened: string[] = [];
  const defaults = createFakeModuleHubServices();
  const services = createFakeModuleHubServices({
    runtimeHosts: {
      ...defaults.runtimeHosts,
      getDefault: async () => defaultHost,
    },
    skills: {
      ...defaults.skills,
      open: async () => openFailure.promise,
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
  assert.equal(controller().host.onOpenSkillsFolder, undefined);
  assert.equal(controller().host.onImportManagedSkillSource, undefined);
  controller().host.onUseSkill("skill-a", "Skill A");
  assert.deepEqual(used, ["skill-a:Skill A"]);

  await act(async () =>
    renderController(
      root,
      services,
      input(records, {
        useSkillInChat: () => undefined,
        openSkillsFolder: () => {
          opened.push("folder");
        },
      }),
    ),
  );
  assert.equal(typeof controller().host.onOpenSkill, "function");
  assert.equal(
    typeof controller().host.onImportManagedSkillSource,
    "function",
  );
  controller().host.onOpenSkillsFolder?.();
  assert.deepEqual(opened, ["folder"]);

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

  const capability = { openSkillsFolder: () => undefined };
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
  let hostReads = 0;
  let skillReads = 0;
  const defaults = createFakeModuleHubServices();
  const services = createFakeModuleHubServices({
    runtimeHosts: {
      ...defaults.runtimeHosts,
      getDefault: async () => {
        hostReads += 1;
        return hostReads === 2 ? staleHostRecheck.promise : host;
      },
    },
    skills: {
      ...defaults.skills,
      list: async () => {
        skillReads += 1;
        if (skillReads === 1) throw new Error("stale refresh failed");
        return [skill("fresh")];
      },
    },
  });

  await act(async () => renderController(root, services, input(records)));
  const staleRefresh = controller().host.onRefreshSkills();
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(hostReads, 2);

  await act(async () => controller().host.onRefreshSkills());
  assert.deepEqual(
    controller().host.skills.map(({ id }) => id),
    ["fresh"],
  );

  staleHostRecheck.resolve(host);
  await act(async () => staleRefresh);
  assert.deepEqual(records, []);
});
