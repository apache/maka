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
