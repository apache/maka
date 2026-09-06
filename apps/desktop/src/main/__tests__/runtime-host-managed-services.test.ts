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
};
const operator = {
  kind: "node" as const,
  platform: "posix" as const,
  nodePath: "/usr/bin/node",
  modulePath: "/home/operator/.local/share/maka/operator.mjs",
};
const deploymentId = "11111111-1111-4111-8111-111111111111";
const deployedService = {
  deployment: { id: service.id, rootPath: service.rootPath, deploymentId },
  control: { kind: "ssh_operator" as const, operator },
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

test("migrates released WSL deployment bindings to the legacy operator route", async () => {
  const root = await mkdtemp(join(tmpdir(), "maka-managed-wsl-migration-"));
  roots.push(root);
  const path = join(root, "runtime-host-deployments.json");
  await writeFile(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      bindings: [{
        profile: {
          id: "ubuntu",
          name: "Ubuntu",
          kind: "environment",
          provider: { kind: "wsl", distribution: "Ubuntu-24.04" },
          rootId: "a".repeat(64),
          operatorPath: "/home/operator/.local/share/maka/operator",
        },
        deployment: {
          id: "a".repeat(64),
          rootPath: "/home/operator/.config/Maka/workspaces/default",
          deploymentId,
        },
        state: "active",
      }],
    })}\n`,
  );

  const document = await createDesktopRuntimeHostManagedServiceStore(root).read();
  const binding = document.bindings[0];
  assert.equal(binding?.profile.kind, "environment");
  assert.deepEqual(binding?.profile.kind === "environment" ? binding.profile.operator : null, {
    kind: "legacy_posix_executable",
    executablePath: "/home/operator/.local/share/maka/operator",
  });
  const stored = await readFile(path, "utf8");
  assert.match(stored, /"schemaVersion": 2/u);
  assert.doesNotMatch(stored, /operatorPath/u);

  const currentProfile = {
    id: "ubuntu",
    name: "Ubuntu",
    kind: "environment" as const,
    provider: { kind: "wsl" as const, distribution: "Ubuntu-24.04" },
    rootId: "a".repeat(64),
    operator,
  };
  const resolved = findDesktopRuntimeHostManagedServiceBinding(document, currentProfile);
  assert.equal(resolved?.profile.kind, "environment");
  assert.equal(resolved?.profile.kind === "environment" ? resolved.profile.operator : null, operator);
});

test("keeps Desktop service bindings outside the shared profile catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "maka-managed-host-services-"));
  roots.push(root);
  const catalog = createClientRuntimeHostProfileCatalog(root);
  const managedServices = createDesktopRuntimeHostManagedServiceStore(root);
  const concurrentStore = createDesktopRuntimeHostManagedServiceStore(root);
  await catalog.create(profile, "secret");

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
      control: { kind: "ssh_operator", operator },
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
    operator,
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
