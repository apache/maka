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
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createClientRuntimeHostProfileCatalog } from "@maka/runtime-host/client";
import {
  createDesktopRuntimeHostManagedServiceStore,
  findDesktopRuntimeHostManagedServiceBinding,
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
  operatorPath: "/home/operator/.local/share/maka/operator",
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

test("keeps Desktop service bindings outside the shared profile catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "maka-managed-host-services-"));
  roots.push(root);
  const catalog = createClientRuntimeHostProfileCatalog(root);
  const managedServices = createDesktopRuntimeHostManagedServiceStore(root);
  const concurrentStore = createDesktopRuntimeHostManagedServiceStore(root);
  await catalog.create(profile, "secret");

  await Promise.all([
    managedServices.save(profile, service),
    concurrentStore.save(
      { ...profile, id: "lab", rootId: "d".repeat(64) },
      { ...service, id: "e".repeat(64) },
    ),
  ]);

  assert.doesNotMatch(
    await readFile(join(root, "runtime-host-profiles.json"), "utf8"),
    /managedService/u,
  );
  assert.deepEqual(
    findDesktopRuntimeHostManagedServiceBinding(await managedServices.read(), profile),
    { profile: { ...profile, transport: { ...profile.transport } }, service, state: "active" },
  );
  assert.equal((await managedServices.read()).bindings.length, 2);
  assert.equal(
    findDesktopRuntimeHostManagedServiceBinding(await managedServices.read(), {
      ...profile,
      transport: { ...profile.transport, destination: "operator@new.example.com" },
    }),
    undefined,
  );
  assert.equal(await managedServices.markUninstallingIfCurrent(profile, service), true);
  assert.equal(
    findDesktopRuntimeHostManagedServiceBinding(await managedServices.read(), profile)?.state,
    "uninstalling",
  );
  assert.equal(await managedServices.removeIfCurrent(profile, service), true);
});
