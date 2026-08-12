import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  createFileRuntimeHostProfileCatalog,
  createRuntimeHostProfileCredentialStore,
  type ResolvedRuntimeHostProfile,
} from "@maka/runtime-host/client";
import { createFileCredentialStore } from "@maka/storage";
import {
  createDesktopRuntimeHostProfileService,
  type DesktopRuntimeHostActivationResult,
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
    kind: "ready",
    selectedProfileId: "local",
    target: { profile: { id: "local", name: "Local", kind: "local" } },
  });

  const service = createProfileService(root, {
    activate: async (target) => {
      activations.push(target.profile.id);
      return { ok: true, activeTarget: target };
    },
  });
  const saved = await service.save({
    profile: {
      id: "office",
      name: "Office",
      kind: "remote",
      transport: { kind: "tls", url: "wss://runtime.example.com" },
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
    kind: "ready",
    selectedProfileId: "office",
    target: {
      profile: {
        id: "office",
        name: "Office",
        kind: "remote",
        transport: { kind: "tls", url: "wss://runtime.example.com/" },
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
          transport: { kind: "tls", url: "wss://other.example.com" },
          rootId: ROOT_ID,
        },
      }),
    /Switch away from an active Runtime Host profile/,
  );
});

test("requires a credential before selection and protects the active profile", async () => {
  const root = await clientRoot();
  const service = createProfileService(root, {
    activate: async (activeTarget) => ({ ok: true, activeTarget }),
  });
  await assert.rejects(
    () =>
      service.save({
        profile: {
          id: "office",
          name: "Office",
          kind: "remote",
          transport: { kind: "tls", url: "wss://runtime.example.com" },
          rootId: ROOT_ID,
        },
      }),
    /credential is required/,
  );
  await assert.rejects(() => service.remove("local"), /active.*cannot be removed/i);
});

test("keeps a failed remote selection unavailable without changing the active Host", async () => {
  const root = await clientRoot();
  const service = createProfileService(root, {
    activate: async () => ({
      ok: false,
      activeTarget: { profile: { id: "local", name: "Local", kind: "local" } },
      error: new Error("remote unavailable"),
    }),
  });
  await service.save({
    profile: {
      id: "office",
      name: "Office",
      kind: "remote",
      transport: { kind: "tls", url: "wss://runtime.example.com" },
      rootId: ROOT_ID,
    },
    credential: "opaque-token",
  });

  const snapshot = await service.select("office");
  assert.equal(snapshot.selectedProfileId, "office");
  assert.equal(snapshot.activeProfileId, "local");
  assert.deepEqual(snapshot.unavailable, {
    profileId: "office",
    message: "remote unavailable",
  });
  const startup = await resolveSelectedDesktopRuntimeHostProfile(root);
  assert.equal(startup.kind, "ready");
  if (startup.kind !== "ready") assert.fail("Expected a ready startup selection");
  assert.equal(startup.selectedProfileId, "office");
  assert.equal(startup.target.profile.id, "office");
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
  const service = createProfileService(root, {
    activate: async (activeTarget) => {
      markActivationStarted();
      await activationStarted;
      return { ok: true, activeTarget };
    },
  });
  await service.save({
    profile: {
      id: "office",
      name: "Office",
      kind: "remote",
      transport: { kind: "tls", url: "wss://runtime.example.com" },
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

test("preserves a dangling Desktop selection as unavailable", async () => {
  const root = await clientRoot();
  const service = createProfileService(root, {
    activate: async (activeTarget) => ({ ok: true, activeTarget }),
  });
  await service.save({
    profile: {
      id: "office",
      name: "Office",
      kind: "remote",
      transport: { kind: "tls", url: "wss://runtime.example.com" },
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
  assert.equal(recovered.kind, "unavailable");
  if (recovered.kind !== "unavailable") assert.fail("Expected an unavailable selection");
  assert.equal(recovered.selectedProfileId, "office");
  assert.match(recovered.error.message, /Unknown Runtime Host profile/);
  assert.match(
    await readFile(join(root, "runtime-host-profile-selection.json"), "utf8"),
    /"profileId": "office"/,
  );
});

test("does not synthesize Local when the selection authority cannot be read", async () => {
  const root = await clientRoot();
  const selection = await resolveSelectedDesktopRuntimeHostProfile(root, {
    readSelection: async () => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    },
  });

  assert.equal(selection.kind, "unavailable");
  if (selection.kind !== "unavailable") assert.fail("Expected an unavailable selection");
  assert.equal(selection.selectedProfileId, undefined);
  assert.match(selection.error.message, /permission denied/);
  assert.equal("target" in selection, false);
});

test("reconnects when another process rotates the active profile credential", async () => {
  const root = await clientRoot();
  const activations: string[] = [];
  const service = createProfileService(root, {
    activate: async (target) => {
      activations.push(
        target.profile.kind === "remote"
          ? `${target.profile.transport.url}|${target.credential}`
          : "local",
      );
      return { ok: true, activeTarget: target };
    },
  });
  const profileA = {
    id: "office",
    name: "Office A",
    kind: "remote" as const,
    transport: { kind: "tls" as const, url: "wss://a.example.com" },
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
    {
      ...profileA,
      name: "Office B",
    },
    "token-b",
  );

  const beforeSwitch = await service.getSnapshot();
  assert.equal(
    beforeSwitch.profiles.find((profile) => profile.id === "office")?.name,
    "Office B",
  );
  assert.equal(beforeSwitch.activeProfileId, undefined);
  assert.equal(beforeSwitch.activeProfile?.name, "Office A");
  await service.select("office");
  assert.deepEqual(activations, [
    "wss://a.example.com/|token-a",
    "wss://a.example.com/|token-b",
  ]);
});

test("keeps a healthy Host active when selection persistence fails", async () => {
  const root = await clientRoot();
  const activations: string[] = [];
  const service = createProfileService(root, {
    activate: async (target) => {
      activations.push(target.profile.id);
      return { ok: true, activeTarget: target };
    },
    writeSelection: async () => {
      throw new Error("selection disk unavailable");
    },
  });
  await service.save({
    profile: {
      id: "office",
      name: "Office",
      kind: "remote",
      transport: { kind: "tls", url: "wss://runtime.example.com" },
      rootId: ROOT_ID,
    },
    credential: "opaque-token",
  });

  await assert.rejects(
    () => service.select("office"),
    /switched for this run, but the selection could not be saved/,
  );
  assert.deepEqual(activations, ["office"]);
  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.selectedProfileId, "office");
  assert.equal(snapshot.activeProfileId, "office");
});

async function clientRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "maka-desktop-host-profile-"));
  temporaryDirectories.push(root);
  return root;
}

const LOCAL_TARGET = {
  profile: { id: "local", name: "Local", kind: "local" },
} as const satisfies ResolvedRuntimeHostProfile;

function createProfileService(
  clientDataRoot: string,
  options: {
    readonly activeTarget?: ResolvedRuntimeHostProfile;
    readonly selectedProfileId?: string;
    readonly activate?: (
      target: ResolvedRuntimeHostProfile,
    ) => Promise<DesktopRuntimeHostActivationResult>;
    readonly writeSelection?: (profileId: string) => Promise<void>;
  } = {},
) {
  let activeTarget = options.activeTarget ?? LOCAL_TARGET;
  return createDesktopRuntimeHostProfileService({
    clientDataRoot,
    selectedProfileId: options.selectedProfileId ?? activeTarget.profile.id,
    getActiveTarget: () => activeTarget,
    activate: async (target) => {
      const result = options.activate
        ? await options.activate(target)
        : { ok: true as const };
      if (result.ok) activeTarget = target;
      return result;
    },
    ...(options.writeSelection
      ? { writeSelection: options.writeSelection }
      : {}),
  });
}
