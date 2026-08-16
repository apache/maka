import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  createClientRuntimeHostProfileCatalog,
  LOCAL_RUNTIME_HOST_PROFILE,
  type ResolvedRuntimeHostProfile,
} from "@maka/runtime-host/client";
import {
  createDesktopRuntimeHostProfileService,
  resolveDesktopRuntimeHostStartup,
} from "../runtime-host-profile-service.js";
import type { RuntimeHostDesktopTargetState } from "../runtime-host-desktop-manager.js";

const ROOT_ID = "a".repeat(64);
const PROFILE = {
  id: "office",
  name: "Office",
  kind: "remote" as const,
  transport: { kind: "tls" as const, url: "wss://runtime.example.com" },
  rootId: ROOT_ID,
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

test("migrates the former selected Host into enabled and default preferences", async () => {
  const root = await clientRoot();
  await createClientRuntimeHostProfileCatalog(root).create(PROFILE, "token");
  await writeFile(
    join(root, "runtime-host-profile-selection.json"),
    `${JSON.stringify({ schemaVersion: 1, profileId: PROFILE.id })}\n`,
  );

  const startup = await resolveDesktopRuntimeHostStartup(root);

  assert.equal(startup.preferences.defaultProfileId, PROFILE.id);
  assert.deepEqual(startup.preferences.enabledRemoteProfileIds, [PROFILE.id]);
  assert.equal(startup.remotes[0]?.profile.id, PROFILE.id);
  assert.equal(
    JSON.parse(await readFile(join(root, "runtime-host-profile-selection.json"), "utf8"))
      .schemaVersion,
    2,
  );
});

test("starts Local and preserves remote preferences when the profile catalog is unreadable", async () => {
  const root = await clientRoot();
  const catalog = createClientRuntimeHostProfileCatalog(root);
  await catalog.create(PROFILE, "token");
  const preferencesPath = join(root, "runtime-host-profile-selection.json");
  await writeFile(
    preferencesPath,
    `${JSON.stringify({
      schemaVersion: 2,
      defaultProfileId: PROFILE.id,
      enabledRemoteProfileIds: [PROFILE.id],
    })}\n`,
  );
  const read = catalog.read.bind(catalog);
  let firstRead = true;
  catalog.read = async () => {
    if (firstRead) {
      firstRead = false;
      throw new Error("profile catalog is unreadable");
    }
    return read();
  };

  const startup = await resolveDesktopRuntimeHostStartup(root, { catalog });

  assert.deepEqual(startup.preferences, {
    schemaVersion: 2,
    defaultProfileId: PROFILE.id,
    enabledRemoteProfileIds: [PROFILE.id],
  });
  assert.deepEqual(startup.remotes, []);
  assert.match(startup.unavailable.get(PROFILE.id)?.message ?? "", /unreadable/);

  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup,
    catalog,
    states: () => [connectingLocal()],
    enable: async () => undefined,
    disable: async () => undefined,
    setDefault: () => undefined,
  });
  await service.setEnabled(PROFILE.id, true);
  assert.equal(
    JSON.parse(await readFile(preferencesPath, "utf8")).defaultProfileId,
    PROFILE.id,
  );
});

test("does not overwrite Runtime Host preferences that were unreadable at startup", async () => {
  const root = await clientRoot();
  const preferencesPath = join(root, "runtime-host-profile-selection.json");
  const savedPreferences = `${JSON.stringify({
    schemaVersion: 2,
    defaultProfileId: PROFILE.id,
    enabledRemoteProfileIds: [PROFILE.id],
  })}\n`;
  await writeFile(preferencesPath, savedPreferences);
  const startup = await resolveDesktopRuntimeHostStartup(root, {
    readPreferences: async () => {
      throw Object.assign(new Error("preferences are temporarily unavailable"), {
        code: "EACCES",
      });
    },
  });
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup,
    states: () => [connectingLocal()],
    enable: async () => assert.fail("an unreadable preference authority must not mutate"),
    disable: async () => assert.fail("an unreadable preference authority must not mutate"),
    setDefault: () => assert.fail("an unreadable preference authority must not mutate"),
  });

  await assert.rejects(
    () => service.setDefault(LOCAL_RUNTIME_HOST_PROFILE.id),
    /restart Maka before changing/,
  );
  assert.equal(await readFile(preferencesPath, "utf8"), savedPreferences);
});

test("keeps Local enabled while a new remote Host connects", async () => {
  const root = await clientRoot();
  const enabled: string[] = [];
  const states: RuntimeHostDesktopTargetState[] = [connectingLocal()];
  const startup = await resolveDesktopRuntimeHostStartup(root);
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup,
    states: () => states,
    enable: async (target) => {
      enabled.push(target.profile.id);
      states.push(connecting(target));
    },
    disable: async () => undefined,
    setDefault: () => undefined,
  });

  const result = await service.addAndEnable({ profile: PROFILE, credential: "opaque-token" });

  assert.equal(result.kind, "connected");
  assert.deepEqual(enabled, [PROFILE.id]);
  assert.equal(result.snapshot.defaultProfileId, LOCAL_RUNTIME_HOST_PROFILE.id);
  assert.deepEqual(
    result.snapshot.entries.map((entry) => [entry.profile.id, entry.enabled]),
    [["local", true], [PROFILE.id, true]],
  );
  assert.equal(
    (await readFile(join(root, "runtime-host-profiles.json"), "utf8")).includes(
      "opaque-token",
    ),
    false,
  );
});

test("does not enable the same State Root twice", async () => {
  const root = await clientRoot();
  const startup = await resolveDesktopRuntimeHostStartup(root);
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup,
    states: () => [{
      epoch: "epoch-local",
      target: { profile: LOCAL_RUNTIME_HOST_PROFILE },
      readiness: "reconnecting",
      hostId: ROOT_ID,
    }],
    enable: async () => assert.fail("duplicate root must not connect"),
    disable: async () => undefined,
    setDefault: () => undefined,
  });

  await assert.rejects(
    () => service.addAndEnable({ profile: PROFILE, credential: "token" }),
    /already enabled/,
  );
  assert.equal(
    (await service.getSnapshot()).entries.some((entry) => entry.profile.id === PROFILE.id),
    false,
  );
});

test("preserves an enabled remote profile when that Host is unavailable", async () => {
  const root = await clientRoot();
  const startup = await resolveDesktopRuntimeHostStartup(root);
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup,
    states: () => [connectingLocal()],
    enable: async () => {
      throw new Error("connection refused");
    },
    disable: async () => undefined,
    setDefault: () => undefined,
  });

  const result = await service.addAndEnable({ profile: PROFILE, credential: "token" });

  assert.equal(result.kind, "unavailable");
  assert.equal(result.snapshot.entries.find((entry) => entry.profile.id === PROFILE.id)?.enabled, true);
  assert.match(
    result.snapshot.entries.find((entry) => entry.profile.id === PROFILE.id)?.message ?? "",
    /connection refused/,
  );
  assert.equal(result.snapshot.entries.find((entry) => entry.profile.id === "local")?.enabled, true);
});

test("keeps enablement, default selection, and removal as separate states", async () => {
  const root = await clientRoot();
  await createClientRuntimeHostProfileCatalog(root).create(PROFILE, "token");
  const startup = await resolveDesktopRuntimeHostStartup(root);
  const defaults: string[] = [];
  const disabled: string[] = [];
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup,
    states: () => [connectingLocal(), connecting({ profile: PROFILE, credential: "token" })],
    enable: async () => undefined,
    disable: async (profileId) => {
      disabled.push(profileId);
    },
    setDefault: (profileId) => defaults.push(profileId),
  });

  await service.setEnabled(PROFILE.id, true);
  assert.equal((await service.setDefault(PROFILE.id)).defaultProfileId, PROFILE.id);
  await assert.rejects(() => service.setEnabled(PROFILE.id, false), /another default/);
  await service.setDefault("local");
  const snapshot = await service.setEnabled(PROFILE.id, false);

  assert.deepEqual(defaults, [PROFILE.id, "local"]);
  assert.deepEqual(disabled, [PROFILE.id]);
  assert.equal(snapshot.entries.find((entry) => entry.profile.id === PROFILE.id)?.enabled, false);
  await service.remove(PROFILE.id);
  assert.deepEqual((await service.getSnapshot()).entries.map((entry) => entry.profile.id), ["local"]);
});

async function clientRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "maka-desktop-host-profile-"));
  temporaryDirectories.push(root);
  return root;
}

function connectingLocal(): RuntimeHostDesktopTargetState {
  return connecting({ profile: LOCAL_RUNTIME_HOST_PROFILE });
}

function connecting(target: ResolvedRuntimeHostProfile): RuntimeHostDesktopTargetState {
  return {
    epoch: `epoch-${target.profile.id}`,
    target,
    readiness: "connecting",
  };
}
