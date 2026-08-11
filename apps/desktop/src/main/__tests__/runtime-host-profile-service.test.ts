import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  createFileRuntimeHostProfileCatalog,
  createRuntimeHostProfileCredentialStore,
} from "@maka/runtime-host/client";
import { createFileCredentialStore } from "@maka/storage";
import {
  createDesktopRuntimeHostProfileService,
  resolveSelectedDesktopRuntimeHostProfile,
} from "../runtime-host-profile-service.js";

const ROOT_ID = "a".repeat(64);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

test("defaults Desktop to Local and keeps remote credentials outside profiles", async () => {
  const root = await clientRoot();
  const activations: string[] = [];
  assert.deepEqual(await resolveSelectedDesktopRuntimeHostProfile(root), {
    target: { profile: { id: "local", name: "Local", kind: "local" } },
  });

  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    activeTarget: { profile: { id: "local", name: "Local", kind: "local" } },
    activate: async ({ profile }) => {
      activations.push(profile.id);
    },
  });
  const saved = await service.save({
    profile: {
      id: "office",
      name: "Office",
      kind: "remote",
      url: "wss://runtime.example.com",
      rootId: ROOT_ID,
    },
    credential: "opaque-token",
  });
  assert.deepEqual(saved.profiles.map(({ id }) => id), ["local", "office"]);
  assert.equal(
    (await readFile(join(root, "runtime-host-profiles.json"), "utf8")).includes(
      "opaque-token",
    ),
    false,
  );

  await service.select("office");
  assert.deepEqual(activations, ["office"]);
  assert.equal((await service.getSnapshot()).activeProfileId, "office");
  assert.deepEqual(await resolveSelectedDesktopRuntimeHostProfile(root), {
    target: {
      profile: {
        id: "office",
        name: "Office",
        kind: "remote",
        url: "wss://runtime.example.com/",
        rootId: ROOT_ID,
      },
      credential: "opaque-token",
    },
  });
  await assert.rejects(
    () =>
      service.save({
        profile: {
          id: "office",
          name: "Changed while active",
          kind: "remote",
          url: "wss://other.example.com",
          rootId: ROOT_ID,
        },
      }),
    /Switch away from an active Runtime Host profile/,
  );
});

test("requires a credential before selection and protects the active profile", async () => {
  const root = await clientRoot();
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    activeTarget: { profile: { id: "local", name: "Local", kind: "local" } },
    activate: async () => undefined,
  });
  await assert.rejects(
    () =>
      service.save({
        profile: {
          id: "office",
          name: "Office",
          kind: "remote",
          url: "wss://runtime.example.com",
          rootId: ROOT_ID,
        },
      }),
    /credential is required/,
  );
  await assert.rejects(() => service.remove("local"), /active.*cannot be removed/i);
});

test("keeps the active selection when a live Host switch fails", async () => {
  const root = await clientRoot();
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    activeTarget: { profile: { id: "local", name: "Local", kind: "local" } },
    activate: async () => {
      throw new Error("remote unavailable");
    },
  });
  await service.save({
    profile: {
      id: "office",
      name: "Office",
      kind: "remote",
      url: "wss://runtime.example.com",
      rootId: ROOT_ID,
    },
    credential: "opaque-token",
  });

  await assert.rejects(() => service.select("office"), /remote unavailable/);
  assert.equal((await service.getSnapshot()).activeProfileId, "local");
  assert.equal(
    (await resolveSelectedDesktopRuntimeHostProfile(root)).target.profile.id,
    "local",
  );
});

test("serializes removal behind an in-flight Host switch", async () => {
  const root = await clientRoot();
  let releaseActivation!: () => void;
  const activationStarted = new Promise<void>((resolve) => {
    releaseActivation = resolve;
  });
  let markActivationStarted!: () => void;
  const enteredActivation = new Promise<void>((resolve) => {
    markActivationStarted = resolve;
  });
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    activeTarget: { profile: { id: "local", name: "Local", kind: "local" } },
    activate: async () => {
      markActivationStarted();
      await activationStarted;
    },
  });
  await service.save({
    profile: {
      id: "office",
      name: "Office",
      kind: "remote",
      url: "wss://runtime.example.com",
      rootId: ROOT_ID,
    },
    credential: "opaque-token",
  });

  const selecting = service.select("office");
  await enteredActivation;
  const removing = service.remove("office");
  releaseActivation();
  await selecting;
  await assert.rejects(removing, /active.*cannot be removed/i);

  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.activeProfileId, "office");
  assert.deepEqual(snapshot.profiles.map((profile) => profile.id), ["local", "office"]);
});

test("recovers a dangling Desktop selection to Local", async () => {
  const root = await clientRoot();
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    activeTarget: { profile: { id: "local", name: "Local", kind: "local" } },
    activate: async () => undefined,
  });
  await service.save({
    profile: {
      id: "office",
      name: "Office",
      kind: "remote",
      url: "wss://runtime.example.com",
      rootId: ROOT_ID,
    },
    credential: "opaque-token",
  });
  await service.select("office");

  const catalog = createFileRuntimeHostProfileCatalog(
    join(root, "runtime-host-profiles.json"),
    createRuntimeHostProfileCredentialStore(
      createFileCredentialStore(join(root, "runtime-host-client")),
    ),
  );
  await catalog.remove("office");

  const recovered = await resolveSelectedDesktopRuntimeHostProfile(root);
  assert.equal(recovered.target.profile.id, "local");
  assert.match(recovered.recoveryError?.message ?? "", /Unknown Runtime Host profile/);
  assert.match(
    await readFile(join(root, "runtime-host-profile-selection.json"), "utf8"),
    /"profileId": "local"/,
  );
});

test("reconnects when another process retargets the active profile id", async () => {
  const root = await clientRoot();
  const activations: string[] = [];
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    activeTarget: { profile: { id: "local", name: "Local", kind: "local" } },
    activate: async (target) => {
      activations.push(
        target.profile.kind === "remote" ? `${target.profile.url}|${target.credential}` : "local",
      );
    },
  });
  const profileA = {
    id: "office",
    name: "Office A",
    kind: "remote" as const,
    url: "wss://a.example.com",
    rootId: "a".repeat(64),
  };
  await service.save({ profile: profileA, credential: "token-a" });
  await service.select("office");

  const externalCatalog = createFileRuntimeHostProfileCatalog(
    join(root, "runtime-host-profiles.json"),
    createRuntimeHostProfileCredentialStore(
      createFileCredentialStore(join(root, "runtime-host-client")),
    ),
  );
  await externalCatalog.save(
    { ...profileA, name: "Office B", url: "wss://b.example.com", rootId: "b".repeat(64) },
    "token-b",
  );

  const beforeSwitch = await service.getSnapshot();
  assert.equal(
    beforeSwitch.profiles.find((profile) => profile.id === "office")?.name,
    "Office A",
  );
  await service.select("office");
  assert.deepEqual(activations, [
    "wss://a.example.com/|token-a",
    "wss://b.example.com/|token-b",
  ]);
});

test("publishes a profile change only after selection persistence commits", async () => {
  const root = await clientRoot();
  const activations: string[] = [];
  const committed: string[] = [];
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    activeTarget: { profile: { id: "local", name: "Local", kind: "local" } },
    activate: async ({ profile }) => {
      activations.push(profile.id);
    },
    onTargetChanged: ({ profile }) => committed.push(profile.id),
    writeSelection: async () => {
      throw new Error("selection disk unavailable");
    },
  });
  await service.save({
    profile: {
      id: "office",
      name: "Office",
      kind: "remote",
      url: "wss://runtime.example.com",
      rootId: ROOT_ID,
    },
    credential: "opaque-token",
  });

  await assert.rejects(() => service.select("office"), /selection disk unavailable/);
  assert.deepEqual(activations, ["office", "local"]);
  assert.deepEqual(committed, []);
  assert.equal((await service.getSnapshot()).activeProfileId, "local");
});

async function clientRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "maka-desktop-host-profile-"));
  temporaryDirectories.push(root);
  return root;
}
