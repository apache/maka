import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  createFileRuntimeHostProfileCatalog,
  createRuntimeHostProfileCredentialStore,
  type ResolvedRuntimeHostProfile,
  type RuntimeHostProfileCatalog,
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
  const added = await service.addAndSelect({
    profile: {
      id: "office",
      name: "Office",
      kind: "remote",
      transport: { kind: "tls", url: "wss://runtime.example.com" },
      rootId: ROOT_ID,
    },
    credential: "opaque-token",
  });
  assert.equal(added.kind, "connected");
  assert.deepEqual(added.snapshot.profiles.map(({ id }) => id), ["local", "office"]);
  assert.equal(
    (await readFile(join(root, "runtime-host-profiles.json"), "utf8")).includes(
      "opaque-token",
    ),
    false,
  );

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
      service.addAndSelect({
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
      service.addAndSelect({
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
  assert.throws(
    () =>
      service.addAndSelect({
        profile: {
          id: "oversized",
          name: "Oversized",
          kind: "remote",
          transport: { kind: "tls", url: "wss://runtime.example.com" },
          rootId: ROOT_ID,
        },
        credential: "x".repeat(8 * 1024 + 1),
      }),
    /credential input is invalid/,
  );
  await assert.rejects(() => service.remove("local"), /active.*cannot be removed/i);
});

test("rolls back a failed new remote profile without changing the active Host", async () => {
  const root = await clientRoot();
  const service = createProfileService(root, {
    activate: async () => ({
      ok: false,
      activeTarget: { profile: { id: "local", name: "Local", kind: "local" } },
      error: new Error("remote unavailable"),
    }),
  });
  const result = await service.addAndSelect({
    profile: {
      id: "office",
      name: "Office",
      kind: "remote",
      transport: { kind: "tls", url: "wss://runtime.example.com" },
      rootId: ROOT_ID,
    },
    credential: "opaque-token",
  });
  assert.deepEqual(result, {
    kind: "unavailable",
    snapshot: {
      profiles: [{ id: "local", name: "Local", kind: "local" }],
      selectedProfileId: "local",
      runtimeHostReadiness: "ready",
      activeProfile: { id: "local", name: "Local", kind: "local" },
      activeProfileId: "local",
    },
    message: "remote unavailable",
  });
  const startup = await resolveSelectedDesktopRuntimeHostProfile(root);
  assert.deepEqual(startup, {
    kind: "ready",
    selectedProfileId: "local",
    target: { profile: { id: "local", name: "Local", kind: "local" } },
  });
});

test("does not roll back a profile changed by another process while connecting", async () => {
  const root = await clientRoot();
  const gate = deferredGate();
  const service = createProfileService(root, {
    activate: async () => {
      gate.enter();
      await gate.released;
      return { ok: false, error: new Error("remote unavailable") };
    },
  });
  const adding = service.addAndSelect({
    profile: {
      id: "office",
      name: "Office",
      kind: "remote",
      transport: { kind: "tls", url: "wss://runtime.example.com" },
      rootId: ROOT_ID,
    },
    credential: "desktop-token",
  });
  await gate.entered;
  const externalCatalog = profileCatalog(root);
  await externalCatalog.save(
    {
      id: "office",
      name: "Rotated externally",
      kind: "remote",
      transport: { kind: "tls", url: "wss://runtime.example.com" },
      rootId: ROOT_ID,
    },
    "external-token",
  );
  gate.release();

  const result = await adding;
  assert.equal(result.kind, "unavailable");
  assert.deepEqual(result.snapshot.profiles.map((profile) => profile.id), [
    "local",
    "office",
  ]);
  assert.equal((await externalCatalog.resolve("office")).credential, "external-token");
});

test("does not persist a selection removed by another process while connecting", async () => {
  const root = await clientRoot();
  const gate = deferredGate();
  const service = createProfileService(root, {
    activate: async (activeTarget) => {
      gate.enter();
      await gate.released;
      return { ok: true, activeTarget };
    },
  });
  const adding = service.addAndSelect({
    profile: {
      id: "office",
      name: "Office",
      kind: "remote",
      transport: { kind: "tls", url: "wss://runtime.example.com" },
      rootId: ROOT_ID,
    },
    credential: "desktop-token",
  });
  await gate.entered;
  await profileCatalog(root).remove("office");
  gate.release();

  const result = await adding;
  assert.equal(result.kind, "connected");
  if (result.kind !== "connected") assert.fail("Expected a connected result");
  assert.match(result.warning ?? "", /profile changed while connecting/u);
  assert.equal(result.snapshot.selectedProfileId, "local");
  assert.deepEqual(result.snapshot.profiles.map((profile) => profile.id), ["local"]);
  assert.equal(result.snapshot.activeProfile?.id, "office");
  assert.equal(result.snapshot.activeProfileId, undefined);
  assert.deepEqual(await resolveSelectedDesktopRuntimeHostProfile(root), {
    kind: "ready",
    selectedProfileId: "local",
    target: LOCAL_TARGET,
  });
});

test("serializes removal behind an in-flight Host switch", async () => {
  const root = await clientRoot();
  await profileCatalog(root).save(
    {
      id: "office",
      name: "Office",
      kind: "remote",
      transport: { kind: "tls", url: "wss://runtime.example.com" },
      rootId: ROOT_ID,
    },
    "opaque-token",
  );
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

test("serializes a snapshot with a Host selection that starts while it is reading", async () => {
  const root = await clientRoot();
  const stored = profileCatalog(root);
  await stored.save(
    {
      id: "office",
      name: "Office",
      kind: "remote",
      transport: { kind: "tls", url: "wss://runtime.example.com" },
      rootId: ROOT_ID,
    },
    "opaque-token",
  );
  const gate = deferredGate();
  let gateNextRead = true;
  const catalog: RuntimeHostProfileCatalog = {
    read: async () => {
      if (gateNextRead) {
        gateNextRead = false;
        gate.enter();
        await gate.released;
      }
      return stored.read();
    },
    resolve: (profileId) => stored.resolve(profileId),
    create: (profile, credential) => stored.create(profile, credential),
    save: (profile, credential) => stored.save(profile, credential),
    remove: (profileId) => stored.remove(profileId),
    removeIfCurrent: (target) => stored.removeIfCurrent(target),
  };
  const activations: string[] = [];
  const service = createProfileService(root, {
    catalog,
    activate: async (target) => {
      activations.push(target.profile.id);
      return { ok: true };
    },
  });

  const reading = service.getSnapshot();
  await gate.entered;
  const selecting = service.select("office");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(activations, []);

  gate.release();
  const beforeSelection = await reading;
  assert.equal(beforeSelection.selectedProfileId, "local");
  assert.equal(beforeSelection.activeProfileId, "local");
  const afterSelection = await selecting;
  assert.equal(afterSelection.selectedProfileId, "office");
  assert.equal(afterSelection.activeProfileId, "office");
});

test("preserves a dangling Desktop selection as unavailable", async () => {
  const root = await clientRoot();
  const service = createProfileService(root, {
    activate: async (activeTarget) => ({ ok: true, activeTarget }),
  });
  await service.addAndSelect({
    profile: {
      id: "office",
      name: "Office",
      kind: "remote",
      transport: { kind: "tls", url: "wss://runtime.example.com" },
      rootId: ROOT_ID,
    },
    credential: "opaque-token",
  });
  const catalog = profileCatalog(root);
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
          ? `${target.profile.transport.kind === "ssh" ? target.profile.transport.destination : target.profile.transport.url}|${target.credential}`
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
  await service.addAndSelect({ profile: profileA, credential: "token-a" });

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

test("keeps the prior selection when the active Host selection cannot be persisted", async () => {
  const root = await clientRoot();
  const activations: string[] = [];
  const service = createProfileService(root, {
    activate: async (target) => {
      activations.push(target.profile.id);
      return { ok: true, activeTarget: target };
    },
    selectionFailure: new Error("selection disk unavailable"),
  });
  const result = await service.addAndSelect({
    profile: {
      id: "office",
      name: "Office",
      kind: "remote",
      transport: { kind: "tls", url: "wss://runtime.example.com" },
      rootId: ROOT_ID,
    },
    credential: "opaque-token",
  });
  assert.equal(result.kind, "connected");
  if (result.kind !== "connected") assert.fail("Expected a connected result");
  assert.match(result.warning ?? "", /selection could not be saved/);
  assert.deepEqual(activations, ["office"]);
  assert.equal(result.snapshot.selectedProfileId, "local");
  assert.equal(result.snapshot.activeProfileId, "office");
});

async function clientRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "maka-desktop-host-profile-"));
  temporaryDirectories.push(root);
  return root;
}

function profileCatalog(root: string) {
  return createFileRuntimeHostProfileCatalog(
    join(root, "runtime-host-profiles.json"),
    createRuntimeHostProfileCredentialStore(
      createFileCredentialStore(join(root, "runtime-host-client")),
    ),
  );
}

function deferredGate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { entered, released, enter, release };
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
    readonly catalog?: RuntimeHostProfileCatalog;
    readonly selectionFailure?: Error;
  } = {},
) {
  let activeTarget = options.activeTarget ?? LOCAL_TARGET;
  return createDesktopRuntimeHostProfileService({
    clientDataRoot,
    selectedProfileId: options.selectedProfileId ?? activeTarget.profile.id,
    getActiveTarget: () => activeTarget,
    getRuntimeHostReadiness: () => "ready",
    activate: async (target) => {
      const result = options.activate
        ? await options.activate(target)
        : { ok: true as const };
      if (result.ok) activeTarget = target;
      return result;
    },
    ...(options.catalog ? { catalog: options.catalog } : {}),
    ...(options.selectionFailure
      ? {
          selectionAuthority: {
            selectIfCurrentTarget: async () => {
              throw options.selectionFailure;
            },
          },
        }
      : {}),
  });
}
