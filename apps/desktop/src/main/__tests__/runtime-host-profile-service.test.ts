import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  createClientRuntimeHostProfileCatalog,
  LOCAL_RUNTIME_HOST_PROFILE,
  RuntimeHostPermanentReconnectError,
  RuntimeHostRemoteCompatibilityError,
  type ResolvedRuntimeHostProfile,
} from "@maka/runtime-host/client";
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
} from "@maka/runtime-host/protocol";
import {
  RuntimeHostPairingFinalizationInterruptedError,
  type RuntimeHostDesktopTargetState,
} from "../runtime-host-desktop-manager.js";
import {
  createDesktopRuntimeHostProfileService,
  resolveDesktopRuntimeHostStartup,
} from "../runtime-host-profile-service.js";

const ROOT_ID = "a".repeat(64);
const PROFILE = {
  id: "office",
  name: "Office",
  kind: "remote" as const,
  transport: { kind: "tls" as const, url: "wss://runtime.example.com" },
  rootId: ROOT_ID,
};
const READY_PROFILE = {
  id: "backup",
  name: "Backup",
  kind: "remote" as const,
  transport: { kind: "tls" as const, url: "wss://backup.example.com" },
  rootId: "b".repeat(64),
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
    finalizePairing: async () => undefined,
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
    finalizePairing: async () => assert.fail("an unreadable preference authority must not mutate"),
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
    finalizePairing: async () => undefined,
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
    finalizePairing: async () => undefined,
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
    finalizePairing: async () => undefined,
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

test("projects a shared compatibility error through an unavailable enabled remote profile", async () => {
  const root = await clientRoot();
  const catalog = createClientRuntimeHostProfileCatalog(root);
  await catalog.create(PROFILE, "office-token");
  await catalog.create(READY_PROFILE, "backup-token");
  const compatibilityError = new RuntimeHostRemoteCompatibilityError("office", {
    kind: "incompatible",
    hostEpoch: "host-epoch",
    protocolMin: RUNTIME_HOST_PROTOCOL_VERSION + 1,
    protocolMax: RUNTIME_HOST_PROTOCOL_VERSION + 2,
    compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH - 1,
    compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    compositionRevision: "host-revision",
    state: "ready",
    replacement: "blocked_by_residency",
  });
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup: {
      preferences: {
        schemaVersion: 2,
        defaultProfileId: LOCAL_RUNTIME_HOST_PROFILE.id,
        enabledRemoteProfileIds: [PROFILE.id, READY_PROFILE.id],
      },
      remotes: [
        { profile: PROFILE, credential: "office-token" },
        { profile: READY_PROFILE, credential: "backup-token" },
      ],
      pairingIntents: [],
      unavailable: new Map(),
    },
    states: () => [
      connectingLocal(),
      unavailable({ profile: PROFILE, credential: "office-token" }, compatibilityError),
      ready({ profile: READY_PROFILE, credential: "backup-token" }),
    ],
    enable: async () => undefined,
    disable: async () => undefined,
    finalizePairing: async () => undefined,
    setDefault: () => undefined,
    catalog,
  });

  const snapshot = await service.getSnapshot();
  const office = snapshot.entries.find((entry) => entry.profile.id === PROFILE.id);
  const backup = snapshot.entries.find((entry) => entry.profile.id === READY_PROFILE.id);
  const local = snapshot.entries.find((entry) => entry.profile.id === LOCAL_RUNTIME_HOST_PROFILE.id);

  assert.equal(office?.enabled, true);
  assert.equal(office?.readiness, "unavailable");
  assert.equal(office?.message, compatibilityError.message);
  assert.equal(local?.enabled, true);
  assert.equal(local?.readiness, "connecting");
  assert.equal(backup?.enabled, true);
  assert.equal(backup?.readiness, "ready");
  assert.equal(backup?.message, undefined);
});

test("removes a managed profile when its verified connection cannot be established", async () => {
  const root = await clientRoot();
  const disabled: string[] = [];
  const startup = await resolveDesktopRuntimeHostStartup(root);
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup,
    states: () => [connectingLocal()],
    enable: async () => {
      throw new Error("connection refused");
    },
    disable: async (profileId) => {
      disabled.push(profileId);
    },
    setDefault: () => undefined,
    finalizePairing: async () => undefined,
  });

  await assert.rejects(
    () => service.addAndEnableVerified({ profile: PROFILE, credential: "token" }),
    /connection refused/,
  );

  assert.deepEqual(disabled, [PROFILE.id]);
  assert.equal(
    (await service.getSnapshot()).entries.some((entry) => entry.profile.id === PROFILE.id),
    false,
  );
});

test("refreshes the existing profile when managed setup pairs the same Host again", async () => {
  const root = await clientRoot();
  const catalog = createClientRuntimeHostProfileCatalog(root);
  await catalog.create(PROFILE, "old-token");
  await writeFile(
    join(root, "runtime-host-profile-selection.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      defaultProfileId: "local",
      enabledRemoteProfileIds: [PROFILE.id],
    })}\n`,
  );
  const startup = await resolveDesktopRuntimeHostStartup(root, { catalog });
  const connected: ResolvedRuntimeHostProfile[] = [];
  const finalized: string[] = [];
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup,
    catalog,
    states: () => [connectingLocal()],
    enable: async (target) => {
      connected.push(target);
    },
    disable: async () => undefined,
    setDefault: () => undefined,
    finalizePairing: async (profileId) => {
      finalized.push(profileId);
    },
  });

  const result = await service.addAndEnableVerified({
    profile: {
      ...PROFILE,
      id: "replacement",
      name: "Renamed office",
      transport: { kind: "tls", url: "wss://new-runtime.example.com" },
    },
    credential: "new-token",
  });

  assert.deepEqual(result, { profileId: PROFILE.id });
  assert.equal(connected[0]?.profile.id, PROFILE.id);
  const connectedProfile = connected[0]?.profile;
  assert.equal(connectedProfile?.kind, "remote");
  assert.deepEqual(connectedProfile?.kind === "remote" ? connectedProfile.transport : undefined, {
    kind: "tls",
    url: "wss://new-runtime.example.com/",
  });
  assert.equal(connected[0]?.credential, "new-token");
  assert.equal((await catalog.resolve(PROFILE.id)).credential, "new-token");
  assert.deepEqual(finalized, [PROFILE.id]);
  assert.deepEqual((await catalog.read()).profiles.map((profile) => profile.id), [PROFILE.id]);
});

test("finishes a persisted pairing after Desktop restarts before finalization", async () => {
  const root = await clientRoot();
  const catalog = await stageInterruptedPairing(root);
  const startup = await resolveDesktopRuntimeHostStartup(root, { catalog });
  assert.equal(startup.pairingIntents.length, 1);
  const finalized: string[] = [];
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup,
    catalog,
    states: () => [connectingLocal()],
    enable: async () => undefined,
    disable: async () => undefined,
    setDefault: () => undefined,
    finalizePairing: async (profileId) => {
      finalized.push(profileId);
    },
  });

  await service.recoverPendingPairings();

  assert.deepEqual(finalized, [PROFILE.id]);
  assert.equal((await catalog.resolve(PROFILE.id)).credential, "new-token");
  assert.equal((await resolveDesktopRuntimeHostStartup(root, { catalog })).pairingIntents.length, 0);
});

test("preserves pairing recovery when shutdown interrupts finalization", async () => {
  const root = await clientRoot();
  const catalog = createClientRuntimeHostProfileCatalog(root);
  const startup = await resolveDesktopRuntimeHostStartup(root, { catalog });
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup,
    catalog,
    states: () => [connectingLocal()],
    enable: async () => undefined,
    disable: async () => undefined,
    setDefault: () => undefined,
    finalizePairing: async () => {
      throw new RuntimeHostPairingFinalizationInterruptedError();
    },
  });

  await assert.rejects(
    () => service.addAndEnableVerified({ profile: PROFILE, credential: "new-token" }),
    RuntimeHostPairingFinalizationInterruptedError,
  );

  assert.equal((await catalog.resolve(PROFILE.id)).credential, "new-token");
  const recovered = await resolveDesktopRuntimeHostStartup(root, { catalog });
  assert.equal(recovered.pairingIntents.length, 1);
  assert.deepEqual(recovered.preferences.enabledRemoteProfileIds, [PROFILE.id]);
});

test("restores the previous credential when an interrupted pairing can no longer authenticate", async () => {
  const root = await clientRoot();
  const catalog = await stageInterruptedPairing(root);
  const startup = await resolveDesktopRuntimeHostStartup(root, { catalog });
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup,
    catalog,
    states: () => [connectingLocal()],
    enable: async (target) => {
      if (target.credential === "new-token") {
        throw new RuntimeHostPermanentReconnectError("pairing credential expired");
      }
    },
    disable: async () => undefined,
    setDefault: () => undefined,
    finalizePairing: async () => assert.fail("an expired credential cannot be finalized"),
  });

  await service.recoverPendingPairings();

  assert.equal((await catalog.resolve(PROFILE.id)).credential, "old-token");
  assert.equal((await resolveDesktopRuntimeHostStartup(root, { catalog })).pairingIntents.length, 0);
});

for (const failureAt of ["connection", "finalization"] as const) {
  test(`restores an existing profile when replacement ${failureAt} fails`, async () => {
    const root = await clientRoot();
    const catalog = createClientRuntimeHostProfileCatalog(root);
    await catalog.create(PROFILE, "old-token");
    await writeFile(
      join(root, "runtime-host-profile-selection.json"),
      `${JSON.stringify({
        schemaVersion: 2,
        defaultProfileId: "local",
        enabledRemoteProfileIds: [PROFILE.id],
      })}\n`,
    );
    const startup = await resolveDesktopRuntimeHostStartup(root, { catalog });
    const enabled: ResolvedRuntimeHostProfile[] = [];
    const service = createDesktopRuntimeHostProfileService({
      clientDataRoot: root,
      startup,
      catalog,
      states: () => [connectingLocal()],
      enable: async (target) => {
        enabled.push(target);
        if (failureAt === "connection" && target.credential === "new-token") {
          throw new Error("replacement connection failed");
        }
      },
      disable: async () => undefined,
      setDefault: () => undefined,
      finalizePairing: async () => {
        if (failureAt === "finalization") throw new Error("replacement finalization failed");
        assert.fail("an unconnected credential cannot be finalized");
      },
    });

    await assert.rejects(
      () =>
        service.addAndEnableVerified({
          profile: {
            ...PROFILE,
            id: "replacement",
            transport: { kind: "tls", url: "wss://new-runtime.example.com" },
          },
          credential: "new-token",
        }),
      new RegExp(`${failureAt} failed`, "u"),
    );

    assert.deepEqual(await catalog.resolve(PROFILE.id), {
      profile: {
        ...PROFILE,
        transport: { kind: "tls", url: "wss://runtime.example.com/" },
      },
      credential: "old-token",
    });
    assert.equal(enabled.at(-1)?.credential, "old-token");
  });
}

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
    finalizePairing: async () => undefined,
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

async function stageInterruptedPairing(root: string) {
  const catalog = createClientRuntimeHostProfileCatalog(root);
  await catalog.create(PROFILE, "old-token");
  await writeFile(
    join(root, "runtime-host-profile-selection.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      defaultProfileId: "local",
      enabledRemoteProfileIds: [PROFILE.id],
    })}\n`,
  );
  const startup = await resolveDesktopRuntimeHostStartup(root, { catalog });
  let finalizationStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    finalizationStarted = resolve;
  });
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup,
    catalog,
    states: () => [connectingLocal()],
    enable: async () => undefined,
    disable: async () => undefined,
    setDefault: () => undefined,
    finalizePairing: async () => {
      finalizationStarted();
      await new Promise<never>(() => undefined);
    },
  });
  void service.addAndEnableVerified({
    profile: { ...PROFILE, name: "Updated office" },
    credential: "new-token",
  });
  await started;
  return catalog;
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

function ready(target: ResolvedRuntimeHostProfile): RuntimeHostDesktopTargetState {
  return {
    epoch: `epoch-${target.profile.id}`,
    target,
    readiness: "ready",
    candidate: {
      client: { hostId: target.profile.kind === "remote" ? target.profile.rootId : ROOT_ID },
    } as never,
  };
}

function unavailable(
  target: ResolvedRuntimeHostProfile,
  error: Error,
): RuntimeHostDesktopTargetState {
  return {
    epoch: `epoch-${target.profile.id}`,
    target,
    readiness: "unavailable",
    error,
  };
}
