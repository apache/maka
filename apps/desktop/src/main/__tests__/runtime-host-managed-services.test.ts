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
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createClientRuntimeHostProfileCatalog } from "@maka/runtime-host/client";
import {
  createDesktopRuntimeHostManagedServiceStore,
  findDesktopRuntimeHostManagedServiceBinding,
  isDesktopRuntimeHostManagedSshServiceBinding,
} from "../runtime-host-managed-services.js";
import {
  createDesktopRuntimeHostProfileService,
  resolveDesktopRuntimeHostStartup,
} from "../runtime-host-profile-service.js";

const roots: string[] = [];
const profile = {
  id: "office",
  name: "Office",
  kind: "remote" as const,
  transport: {
    kind: "ssh" as const,
    destination: "operator@example.com",
    remotePort: 7443,
    websocketPath: "/runtime-host",
  },
  rootId: "a".repeat(64),
};
const service = {
  id: "b".repeat(64),
  rootPath: "/srv/maka",
  operatorPath: "/home/operator/.local/share/maka/operator",
};
const deploymentId = "11111111-1111-4111-8111-111111111111";
const deployedService = {
  deployment: { id: service.id, rootPath: service.rootPath, deploymentId },
  control: { kind: "ssh_operator" as const, operatorPath: service.operatorPath },
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

test("keeps Desktop service bindings outside the shared profile catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "maka-managed-host-services-"));
  roots.push(root);
  const catalog = createClientRuntimeHostProfileCatalog(root);
  const legacyPath = join(root, "runtime-host-managed-services.json");
  const legacyDocument = `${JSON.stringify({
    schemaVersion: 1,
    bindings: [{ profile, service, state: "uninstalling" }],
  })}\n`;
  await writeFile(
    legacyPath,
    legacyDocument,
  );
  const managedServices = createDesktopRuntimeHostManagedServiceStore(root);
  const concurrentStore = createDesktopRuntimeHostManagedServiceStore(root);
  await catalog.create(profile, "secret");

  assert.equal((await managedServices.read()).bindings[0]?.deployment.id, service.id);
  await assert.rejects(readFile(legacyPath, "utf8"), {
    code: "ENOENT",
  });
  await writeFile(legacyPath, legacyDocument);
  await managedServices.read();
  await assert.rejects(readFile(legacyPath, "utf8"), { code: "ENOENT" });

  const profileService = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup: await resolveDesktopRuntimeHostStartup(root, { catalog }),
    catalog,
    managedServices,
    states: () => [],
    enable: async () => undefined,
    disable: async () => undefined,
    setDefault: () => undefined,
    finalizePairing: async () => undefined,
  });
  const legacyUninstall = await profileService.resolveManagedService(profile.id);
  assert.ok(legacyUninstall);
  assert.equal(legacyUninstall.deployment.deploymentId, undefined);
  assert.equal(legacyUninstall.state, "uninstalling");
  assert.equal(
    (await profileService.markManagedServiceUninstalling(legacyUninstall)).state,
    "uninstalling",
  );

  await Promise.all([
    managedServices.save(profile, deployedService),
    concurrentStore.save(
      { ...profile, id: "lab", rootId: "d".repeat(64) },
      {
        ...deployedService,
        deployment: {
          ...deployedService.deployment,
          id: "e".repeat(64),
          deploymentId: "22222222-2222-4222-8222-222222222222",
        },
      },
    ),
  ]);

  assert.doesNotMatch(
    await readFile(join(root, "runtime-host-profiles.json"), "utf8"),
    /managedService/u,
  );
  assert.deepEqual(
    findDesktopRuntimeHostManagedServiceBinding(
      await managedServices.read(),
      profile,
    ),
    {
      profile: { ...profile, transport: { ...profile.transport } },
      deployment: { id: service.id, rootPath: service.rootPath, deploymentId },
      control: { kind: "ssh_operator", operatorPath: service.operatorPath },
      state: "active",
    },
  );
  assert.equal((await managedServices.read()).bindings.length, 2);
  assert.equal(
    findDesktopRuntimeHostManagedServiceBinding(await managedServices.read(), {
      ...profile,
      transport: {
        ...profile.transport,
        destination: "operator@new.example.com",
      },
    }),
    undefined,
  );
  const binding = findDesktopRuntimeHostManagedServiceBinding(
    await managedServices.read(),
    profile,
  );
  assert.ok(binding);
  assert.ok(isDesktopRuntimeHostManagedSshServiceBinding(binding));
  assert.equal(await managedServices.markUninstallingIfCurrent(binding), true);
  assert.equal(
    findDesktopRuntimeHostManagedServiceBinding(
      await managedServices.read(),
      profile,
    )?.state,
    "uninstalling",
  );
  assert.equal(
    await managedServices.removeCleanupPendingIfCurrent(binding),
    false,
  );
  assert.equal(
    await managedServices.markCleanupPendingIfCurrent(binding),
    true,
  );
  assert.equal(
    findDesktopRuntimeHostManagedServiceBinding(
      await managedServices.read(),
      profile,
    )?.state,
    "cleanup_pending",
  );
  assert.equal(
    await managedServices.markUninstallingIfCurrent(binding),
    false,
  );
  assert.equal(
    await managedServices.removeCleanupPendingIfCurrent(binding),
    true,
  );
});

test("persists a WSL deployment through its environment control route", async () => {
  const root = await mkdtemp(join(tmpdir(), "maka-managed-wsl-deployment-"));
  roots.push(root);
  const store = createDesktopRuntimeHostManagedServiceStore(root);
  const environment = {
    id: "ubuntu",
    name: "Ubuntu",
    kind: "environment" as const,
    provider: { kind: "wsl" as const, distribution: "Ubuntu-24.04" },
    rootId: "a".repeat(64),
    operatorPath: "/home/operator/.local/share/maka/operator",
  };
  await store.save(environment, {
    deployment: {
      id: environment.rootId,
      rootPath: "/home/operator/.config/Maka/workspaces/default",
      deploymentId,
    },
  });

  assert.deepEqual(
    findDesktopRuntimeHostManagedServiceBinding(await store.read(), environment),
    {
      profile: environment,
      deployment: {
        id: environment.rootId,
        rootPath: "/home/operator/.config/Maka/workspaces/default",
        deploymentId,
      },
      state: "active",
    },
  );
  await assert.rejects(
    store.save(
      { ...environment, id: "ubuntu-duplicate" },
      {
        deployment: {
          id: environment.rootId,
          rootPath: "/home/operator/.config/Maka/workspaces/default",
          deploymentId,
        },
      },
    ),
    /already bound/u,
  );
  await assert.rejects(store.save(profile, deployedService), /already bound/u);
});
