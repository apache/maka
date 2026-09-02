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
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  createClientRuntimeHostCredentialStore,
  createClientRuntimeHostProfileCatalog,
  createRuntimeHostProfileCredentialStore,
  encodeRuntimeHostOwnerConnectionCode,
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
  createDesktopRuntimeHostManagedServiceStore,
  findDesktopRuntimeHostManagedServiceBinding,
  isDesktopRuntimeHostManagedSshServiceBinding,
} from "../runtime-host-managed-services.js";
import {
  createDesktopRuntimeHostPairingIntent,
  writeDesktopRuntimeHostPairingIntents,
} from "../runtime-host-pairing-journal.js";
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
const MANAGED_PROFILE = {
  ...PROFILE,
  id: "managed-office",
  transport: {
    kind: "ssh" as const,
    destination: "operator@example.com",
    remotePort: 7443,
    websocketPath: "/runtime-host",
  },
};
const MANAGED_SERVICE = {
  deployment: {
    id: "c".repeat(64),
    rootPath: "/srv/maka",
    deploymentId: "11111111-1111-4111-8111-111111111111",
  },
  control: {
    kind: "ssh_operator" as const,
    operatorPath: "/home/operator/.local/share/maka/operator",
  },
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

test('removes obsolete experimental Guest profiles and pairing intents at startup', async () => {
  const root = await clientRoot();
  const credentials = createClientRuntimeHostCredentialStore(root);
  const catalog = createClientRuntimeHostProfileCatalog(root, credentials);
  const guest = { ...PROFILE, id: 'shared-obsolete', access: 'session_guest' as const };
  await createRuntimeHostProfileCredentialStore(credentials).set(guest, {
    credential: 'guest-token',
    profileIncarnationId: 'guest-incarnation',
  });
  await writeFile(
    join(root, 'runtime-host-profiles.json'),
    `${JSON.stringify({ schemaVersion: 3, profiles: [guest] })}\n`,
  );
  await writeFile(
    join(root, 'runtime-host-profile-selection.json'),
    `${JSON.stringify({
      schemaVersion: 2,
      defaultProfileId: guest.id,
      enabledRemoteProfileIds: [guest.id],
    })}\n`,
  );
  await writeDesktopRuntimeHostPairingIntents(credentials, [
    createDesktopRuntimeHostPairingIntent({
      target: { profile: guest, credential: 'guest-token' },
      wasEnabled: true,
    }),
  ]);

  const startup = await resolveDesktopRuntimeHostStartup(root, {
    catalog,
    credentialStore: credentials,
  });

  assert.deepEqual((await catalog.read()).profiles, []);
  assert.deepEqual(startup.pairingIntents, []);
  assert.deepEqual(startup.preferences, {
    schemaVersion: 2,
    defaultProfileId: 'local',
    enabledRemoteProfileIds: [],
  });
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

test("reuses the existing WSL profile when the same managed Host is added again", async () => {
  const root = await clientRoot();
  const catalog = createClientRuntimeHostProfileCatalog(root);
  const managedServices = createDesktopRuntimeHostManagedServiceStore(root);
  const existing = {
    id: "ubuntu",
    name: "Ubuntu",
    kind: "environment" as const,
    provider: { kind: "wsl" as const, distribution: "Ubuntu-24.04" },
    rootId: ROOT_ID,
    operatorPath: "/home/operator/.local/share/Maka/runtime-host-services/operator",
  };
  await catalog.create(existing);
  const enabled: string[] = [];
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup: await resolveDesktopRuntimeHostStartup(root, { catalog }),
    catalog,
    managedServices,
    states: () => [connectingLocal()],
    enable: async (target) => {
      enabled.push(target.profile.id);
    },
    disable: async () => undefined,
    setDefault: () => undefined,
    finalizePairing: async () => undefined,
  });
  const managedService = {
    deployment: {
      id: ROOT_ID,
      rootPath: "/home/operator/.config/Maka/workspaces/default",
      deploymentId: "11111111-1111-4111-8111-111111111111",
    },
  };

  const result = await service.addManagedEnvironmentAndEnable({
    profile: { ...existing, id: "replacement", name: "Replacement" },
    managedService,
  });

  assert.equal(result.profileId, existing.id);
  assert.deepEqual((await catalog.read()).profiles, [existing]);
  assert.deepEqual(enabled, [existing.id]);
  assert.deepEqual(
    findDesktopRuntimeHostManagedServiceBinding(
      await managedServices.read(),
      existing,
    ),
    { profile: existing, ...managedService, state: "active" },
  );
});

test("reconnects an enabled remote Host with interactive SSH", async () => {
  const root = await clientRoot();
  const catalog = createClientRuntimeHostProfileCatalog(root);
  await catalog.create(MANAGED_PROFILE, "opaque-token");
  const calls: string[] = [];
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup: {
      preferences: {
        schemaVersion: 2,
        defaultProfileId: LOCAL_RUNTIME_HOST_PROFILE.id,
        enabledRemoteProfileIds: [MANAGED_PROFILE.id],
      },
      pairingIntents: [],
      remotes: [{ profile: MANAGED_PROFILE, credential: "opaque-token" }],
      unavailable: new Map(),
    },
    catalog,
    states: () => [connectingLocal()],
    enable: async (target, interaction) => {
      calls.push(`enable:${target.profile.id}:${interaction}`);
    },
    disable: async (profileId) => {
      calls.push(`disable:${profileId}`);
    },
    setDefault: () => undefined,
    finalizePairing: async () => undefined,
  });

  await service.reconnect(MANAGED_PROFILE.id, MANAGED_PROFILE.rootId);

  assert.deepEqual(calls, [
    `disable:${MANAGED_PROFILE.id}`,
    `enable:${MANAGED_PROFILE.id}:terminal`,
  ]);
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
    /profile "Local".*disable/u,
  );
  assert.equal(
    (await service.getSnapshot()).entries.some((entry) => entry.profile.id === PROFILE.id),
    false,
  );
});

test('starts an enabled Owner profile beside a retained Guest mount for the same Root', async () => {
  const root = await clientRoot();
  const catalog = createClientRuntimeHostProfileCatalog(root);
  await catalog.create(PROFILE, 'owner-token');
  await writeFile(
    join(root, 'runtime-host-profile-selection.json'),
    `${JSON.stringify({
      schemaVersion: 2,
      defaultProfileId: PROFILE.id,
      enabledRemoteProfileIds: [PROFILE.id],
    })}\n`,
  );
  const startup = await resolveDesktopRuntimeHostStartup(root, { catalog });
  const enabled: string[] = [];
  const guest = {
    profile: {
      ...PROFILE,
      id: 'shared-session',
      access: 'session_guest' as const,
    },
    credential: 'guest-token',
  };
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup,
    catalog,
    states: () => [connectingLocal(), connecting(guest)],
    enable: async (target) => {
      enabled.push(target.profile.id);
    },
    disable: async () => undefined,
    setDefault: () => undefined,
    finalizePairing: async () => undefined,
  });

  await service.startEnabledProfiles();

  assert.deepEqual(enabled, [PROFILE.id]);
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
      pairingIntents: [],
      remotes: [
        { profile: PROFILE, credential: "office-token" },
        { profile: READY_PROFILE, credential: "backup-token" },
      ],
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
  const conflictingProfile = {
    ...PROFILE,
    id: "legacy-office",
    transport: { kind: "tls" as const, url: "wss://old-runtime.example.com" },
  };
  await catalog.create(conflictingProfile, "legacy-token");
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
    },
    credential: "new-token",
  });

  assert.deepEqual(result, { profileId: PROFILE.id });
  assert.equal(connected[0]?.profile.id, PROFILE.id);
  const connectedProfile = connected[0]?.profile;
  assert.equal(connectedProfile?.kind, "remote");
  assert.deepEqual(connectedProfile?.kind === "remote" ? connectedProfile.transport : undefined, {
    kind: "tls",
    url: "wss://runtime.example.com/",
  });
  assert.equal(connected[0]?.credential, "new-token");
  assert.equal((await catalog.resolve(PROFILE.id)).credential, "new-token");
  assert.deepEqual(finalized, [PROFILE.id]);
  assert.deepEqual((await catalog.read()).profiles.map((profile) => profile.id), [
    conflictingProfile.id,
    PROFILE.id,
  ]);
});

test("keeps a separate profile when the same Host is paired through another connection", async () => {
  const root = await clientRoot();
  const catalog = createClientRuntimeHostProfileCatalog(root);
  await catalog.create(PROFILE, "old-token");
  const startup = await resolveDesktopRuntimeHostStartup(root, { catalog });
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

  await service.addAndEnableVerified({
    profile: {
      ...PROFILE,
      id: "replacement",
      transport: { kind: "tls", url: "wss://new-runtime.example.com" },
    },
    credential: "new-token",
  });
  assert.equal((await catalog.resolve(PROFILE.id)).credential, "old-token");
  assert.equal((await catalog.resolve("replacement")).credential, "new-token");
});

test('classifies connection-code failures without exposing transport errors to the renderer', async () => {
  const root = await clientRoot();
  const startup = await resolveDesktopRuntimeHostStartup(root);
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup,
    states: () => [connectingLocal()],
    enable: async () => {
      throw new RuntimeHostPermanentReconnectError(
        'Runtime Host profile candidate rejected its access credential',
      );
    },
    disable: async () => undefined,
    setDefault: () => undefined,
    finalizePairing: async () => undefined,
  });

  assert.deepEqual(await service.importConnectionCode('not-a-code'), {
    kind: 'error',
    reason: 'invalid_code',
  });
  assert.deepEqual(
    await service.importConnectionCode(
      encodeRuntimeHostOwnerConnectionCode({
        name: 'Other computer',
        rootId: ROOT_ID,
        transport: {
          kind: 'libp2p-direct',
          reachability: peerReachability('12D3KooWpeer'),
        },
        credential: 'pending-credential',
      }),
    ),
    { kind: 'error', reason: 'code_unavailable' },
  );
});

test('persists authenticated Owner routes imported through a connection code', async () => {
  const root = await clientRoot();
  const catalog = createClientRuntimeHostProfileCatalog(root);
  const startup = await resolveDesktopRuntimeHostStartup(root, { catalog });
  const staleTransport = {
    kind: 'libp2p-direct' as const,
    reachability: peerReachability(
      '12D3KooWpeer',
      1,
      ['/ip4/192.0.2.8/udp/44001/quic-v1'],
      ['/memory/stale-relay'],
    ),
  };
  const freshEndpoint = peerReachability(
    '12D3KooWpeer',
    2,
    ['/ip4/198.51.100.9/udp/44002/quic-v1'],
    ['/memory/fresh-relay'],
  );
  let observedIncarnation: string | undefined;
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup,
    catalog,
    states: () => [connectingLocal()],
    enable: async (target, _sshInteraction, onPeerEndpoint) => {
      observedIncarnation = target.profileIncarnationId;
      assert.deepEqual(
        target.profile.kind === 'remote' ? target.profile.transport : undefined,
        staleTransport,
      );
      assert.ok(onPeerEndpoint);
      onPeerEndpoint(freshEndpoint);
    },
    disable: async () => undefined,
    setDefault: () => undefined,
    finalizePairing: async () => undefined,
  });

  const result = await service.importConnectionCode(
    encodeRuntimeHostOwnerConnectionCode({
      name: 'Other computer',
      rootId: ROOT_ID,
      transport: staleTransport,
      credential: 'pending-owner-token',
    }),
  );

  assert.equal(result.kind, 'connected');
  if (result.kind !== 'connected') return;
  const persisted = await catalog.resolve(result.profileId);
  assert.equal(persisted.credential, 'pending-owner-token');
  assert.equal(persisted.profileIncarnationId, observedIncarnation);
  assert.deepEqual(
    persisted.profile.kind === 'remote' ? persisted.profile.transport : undefined,
    { kind: 'libp2p-direct', reachability: freshEndpoint },
  );
  const restarted = await resolveDesktopRuntimeHostStartup(root, { catalog });
  assert.deepEqual(restarted.remotes, [persisted]);
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

  await service.startEnabledProfiles();

  assert.deepEqual(finalized, [PROFILE.id]);
  assert.equal((await catalog.resolve(PROFILE.id)).credential, "new-token");
  assert.deepEqual(
    (await resolveDesktopRuntimeHostStartup(root, { catalog })).pairingIntents,
    [],
  );
});

test("keeps a managed Direct route on the SSH profile credential authority", async () => {
  const root = await clientRoot();
  const catalog = createClientRuntimeHostProfileCatalog(root);
  const managedServices = createDesktopRuntimeHostManagedServiceStore(root);
  await catalog.create(MANAGED_PROFILE, "owner-token");
  await managedServices.save(MANAGED_PROFILE, MANAGED_SERVICE);
  const startup = await resolveDesktopRuntimeHostStartup(root, { catalog });
  const activated: ResolvedRuntimeHostProfile[] = [];
  const livePeer = peerReachability(
    '12D3KooWpeer',
    2,
    ['/ip4/192.0.2.9/udp/44002/quic-v1'],
    ['/dns4/relay.example/udp/443/quic-v1/p2p/12D3KooWrelay'],
  );
  let exposeReadyState = false;
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup,
    catalog,
    managedServices,
    states: () =>
      exposeReadyState
        ? [
            connectingLocal(),
            readyWithPeerEndpoint(
              { profile: MANAGED_PROFILE, credential: "owner-token" },
              livePeer,
            ),
          ]
        : [connectingLocal()],
    enable: async (target) => {
      activated.push(target);
    },
    disable: async () => undefined,
    setDefault: () => undefined,
    finalizePairing: async () => undefined,
  });

  await assert.rejects(
    service.resolveCollaborationConnectionTarget(MANAGED_PROFILE),
    /Enable Direct peer access/u,
  );

  exposeReadyState = true;
  await service.upsertManagedDirectPeerProfile(MANAGED_PROFILE.id, '12D3KooWpeer');

  const directId = (await catalog.read()).profiles.find(
    (profile) => profile.kind === 'remote' && profile.transport.kind === 'libp2p-direct',
  )?.id;
  assert.ok(directId);
  const direct = await catalog.resolve(directId);
  assert.equal(direct.credential, "owner-token");
  assert.equal(direct.profile.kind, "remote");
  if (direct.profile.kind !== "remote") assert.fail("expected a remote Direct profile");
  assert.deepEqual(direct.profile.transport, {
    kind: "libp2p-direct",
    reachability: livePeer,
  });
  assert.deepEqual(
    await service.resolveCollaborationConnectionTarget(MANAGED_PROFILE),
    {
      name: MANAGED_PROFILE.name,
      transport: { kind: 'libp2p-direct', reachability: livePeer },
    },
  );
  exposeReadyState = false;
  assert.equal((await catalog.resolve(MANAGED_PROFILE.id)).credential, "owner-token");

  const beforeRejectedRemoval = {
    document: await catalog.read(),
    source: await catalog.resolve(MANAGED_PROFILE.id),
    direct: await catalog.resolve(directId),
    managed: await managedServices.read(),
    snapshot: await service.getSnapshot(),
  };
  const managedBinding = await service.resolveManagedService(MANAGED_PROFILE.id);
  assert.ok(managedBinding);
  assert.ok(isDesktopRuntimeHostManagedSshServiceBinding(managedBinding));
  await assert.rejects(
    service.remove(MANAGED_PROFILE.id),
    /remove the Direct peer profile/u,
  );
  await assert.rejects(
    service.markManagedServiceUninstalling(managedBinding),
    /remove the Direct peer profile/u,
  );
  assert.deepEqual(
    {
      document: await catalog.read(),
      source: await catalog.resolve(MANAGED_PROFILE.id),
      direct: await catalog.resolve(directId),
      managed: await managedServices.read(),
      snapshot: await service.getSnapshot(),
    },
    beforeRejectedRemoval,
  );

  await service.setEnabled(MANAGED_PROFILE.id, true);
  const access = await service.resolveManagedAccess(MANAGED_PROFILE.id);
  assert.ok(access);
  await service.rotateManagedCredential(access, 'replacement-token');
  await service.setEnabled(MANAGED_PROFILE.id, false);
  await service.setEnabled(directId, true);

  assert.equal((await catalog.resolve(directId)).credential, 'replacement-token');
  assert.equal(activated.at(-1)?.profile.id, directId);
  assert.equal(activated.at(-1)?.credential, 'replacement-token');

  await service.setEnabled(directId, false);
  await service.removeManagedDirectPeerProfile(MANAGED_PROFILE.id);

  assert.deepEqual((await catalog.read()).profiles, [MANAGED_PROFILE]);
  await service.remove(MANAGED_PROFILE.id);
  assert.deepEqual((await catalog.read()).profiles, []);
  assert.deepEqual((await managedServices.read()).bindings, []);
});

test("recovers interrupted managed credential rotation after restart", async () => {
  const root = await clientRoot();
  const catalog = createClientRuntimeHostProfileCatalog(root);
  await catalog.create(MANAGED_PROFILE, "old-token");
  await createDesktopRuntimeHostManagedServiceStore(root).save(MANAGED_PROFILE, MANAGED_SERVICE);
  await writeFile(
    join(root, "runtime-host-profile-selection.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      defaultProfileId: LOCAL_RUNTIME_HOST_PROFILE.id,
      enabledRemoteProfileIds: [MANAGED_PROFILE.id],
    })}\n`,
  );
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

  const managedAccess = await service.resolveManagedAccess(MANAGED_PROFILE.id);
  assert.ok(managedAccess);
  await assert.rejects(
    () => service.rotateManagedCredential(managedAccess, "new-token"),
    RuntimeHostPairingFinalizationInterruptedError,
  );
  assert.equal((await catalog.resolve(MANAGED_PROFILE.id)).credential, "new-token");
  const managed = await service.resolveManagedService(MANAGED_PROFILE.id);
  assert.ok(managed);
  assert.ok(isDesktopRuntimeHostManagedSshServiceBinding(managed));
  await assert.rejects(
    service.markManagedServiceUninstalling(managed),
    /unfinished pairing/u,
  );

  const recoveredStartup = await resolveDesktopRuntimeHostStartup(root, { catalog });
  assert.equal(recoveredStartup.pairingIntents.length, 1);
  const resolve = catalog.resolve.bind(catalog);
  let catalogReadable = false;
  catalog.resolve = async (profileId) => {
    if (!catalogReadable) throw new Error("profile catalog is temporarily unavailable");
    return resolve(profileId);
  };
  const recovered = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup: recoveredStartup,
    catalog,
    states: () => [connectingLocal()],
    enable: async () => undefined,
    disable: async () => undefined,
    setDefault: () => undefined,
    finalizePairing: async () => undefined,
  });
  await assert.rejects(
    recovered.resolveManagedAccess(MANAGED_PROFILE.id),
    /unfinished pairing/u,
  );
  await recovered.startEnabledProfiles();
  assert.equal(
    (await resolveDesktopRuntimeHostStartup(root)).pairingIntents.length,
    1,
  );

  catalogReadable = true;
  await recovered.startEnabledProfiles();

  assert.ok(await recovered.resolveManagedAccess(MANAGED_PROFILE.id));
  assert.equal(
    (await recovered.getSnapshot()).entries.find(
      (entry) => entry.profile.id === MANAGED_PROFILE.id,
    )?.managedService,
    true,
  );
  assert.deepEqual(
    (await resolveDesktopRuntimeHostStartup(root, { catalog })).pairingIntents,
    [],
  );
});

test("does not rotate a managed credential after its profile target changes", async () => {
  const root = await clientRoot();
  const catalog = createClientRuntimeHostProfileCatalog(root);
  const managedServices = createDesktopRuntimeHostManagedServiceStore(root);
  await catalog.create(MANAGED_PROFILE, "old-token");
  await managedServices.save(MANAGED_PROFILE, MANAGED_SERVICE);
  await writeFile(
    join(root, "runtime-host-profile-selection.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      defaultProfileId: LOCAL_RUNTIME_HOST_PROFILE.id,
      enabledRemoteProfileIds: [MANAGED_PROFILE.id],
    })}\n`,
  );
  const startup = await resolveDesktopRuntimeHostStartup(root, { catalog });
  let finalized = false;
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup,
    catalog,
    managedServices,
    states: () => [connectingLocal()],
    enable: async () => undefined,
    disable: async () => undefined,
    setDefault: () => undefined,
    finalizePairing: async () => {
      finalized = true;
    },
  });
  const managedAccess = await service.resolveManagedAccess(MANAGED_PROFILE.id);
  assert.ok(managedAccess);

  const replacementProfile = {
    ...MANAGED_PROFILE,
    rootId: "d".repeat(64),
    transport: {
      ...MANAGED_PROFILE.transport,
      destination: "other@example.com",
    },
  };
  const replacementService = {
    ...MANAGED_SERVICE,
    deployment: {
      id: "e".repeat(64),
      rootPath: "/srv/other-maka",
    },
  };
  await catalog.remove(MANAGED_PROFILE.id);
  await catalog.create(replacementProfile, "other-token");
  await managedServices.save(replacementProfile, replacementService);

  await assert.rejects(
    service.rotateManagedCredential(managedAccess, "prepared-for-original-host"),
    /profile changed/u,
  );
  assert.equal((await catalog.resolve(MANAGED_PROFILE.id)).credential, "other-token");
  assert.equal(finalized, false);
  assert.deepEqual(
    (await resolveDesktopRuntimeHostStartup(root, { catalog })).pairingIntents,
    [],
  );
});

test("reactivates the previous credential after a pre-rebind rotation crash", async () => {
  const root = await clientRoot();
  const credentialStore = createClientRuntimeHostCredentialStore(root);
  const catalog = createClientRuntimeHostProfileCatalog(root, credentialStore);
  await catalog.create(MANAGED_PROFILE, "old-token");
  await createDesktopRuntimeHostManagedServiceStore(root).save(
    MANAGED_PROFILE,
    MANAGED_SERVICE,
  );
  await writeFile(
    join(root, "runtime-host-profile-selection.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      defaultProfileId: LOCAL_RUNTIME_HOST_PROFILE.id,
      enabledRemoteProfileIds: [MANAGED_PROFILE.id],
    })}\n`,
  );
  await writeDesktopRuntimeHostPairingIntents(credentialStore, [
    createDesktopRuntimeHostPairingIntent({
      target: { profile: MANAGED_PROFILE, credential: "new-token" },
      previous: { profile: MANAGED_PROFILE, credential: "old-token" },
      wasEnabled: true,
    }),
  ]);
  const startup = await resolveDesktopRuntimeHostStartup(root, {
    catalog,
    credentialStore,
  });
  const enabled: ResolvedRuntimeHostProfile[] = [];
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup,
    catalog,
    credentialStore,
    states: () => [connectingLocal()],
    enable: async (target) => {
      enabled.push(target);
    },
    disable: async () => undefined,
    setDefault: () => undefined,
    finalizePairing: async () => assert.fail("an unapplied credential cannot be finalized"),
  });

  await service.startEnabledProfiles();

  assert.deepEqual(enabled.map((target) => target.credential), ["old-token"]);
  assert.deepEqual(
    (await resolveDesktopRuntimeHostStartup(root, { catalog })).pairingIntents,
    [],
  );
});

test('recovers a new profile after a crash before its enable preference is written', async () => {
  const root = await clientRoot();
  const credentialStore = createClientRuntimeHostCredentialStore(root);
  const catalog = createClientRuntimeHostProfileCatalog(root, credentialStore);
  await catalog.create(MANAGED_PROFILE, 'new-token');
  await writeDesktopRuntimeHostPairingIntents(credentialStore, [
    createDesktopRuntimeHostPairingIntent({
      target: { profile: MANAGED_PROFILE, credential: 'new-token' },
      wasEnabled: false,
    }),
  ]);
  const startup = await resolveDesktopRuntimeHostStartup(root, { catalog, credentialStore });
  assert.deepEqual(startup.preferences.enabledRemoteProfileIds, []);
  const enabled: ResolvedRuntimeHostProfile[] = [];
  const finalized: string[] = [];
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup,
    catalog,
    credentialStore,
    states: () => [connectingLocal()],
    enable: async (target) => {
      enabled.push(target);
    },
    disable: async () => undefined,
    setDefault: () => undefined,
    finalizePairing: async (profileId) => {
      finalized.push(profileId);
    },
  });

  await service.startEnabledProfiles();

  assert.deepEqual(enabled.map((target) => target.credential), ['new-token']);
  assert.deepEqual(finalized, [MANAGED_PROFILE.id]);
  assert.equal(
    (await service.getSnapshot()).entries.find(({ profile }) => profile.id === MANAGED_PROFILE.id)
      ?.enabled,
    true,
  );
  assert.deepEqual(
    (await resolveDesktopRuntimeHostStartup(root, { catalog, credentialStore })).pairingIntents,
    [],
  );
});

test("does not let journal cleanup failure lock a completed pairing", async () => {
  const root = await clientRoot();
  const credentials = createClientRuntimeHostCredentialStore(root);
  const credentialStore = {
    getSecret: credentials.getSecret.bind(credentials),
    setSecret: credentials.setSecret.bind(credentials),
    deleteSecret: async () => {
      throw new Error("credential cleanup failed");
    },
  };
  const catalog = createClientRuntimeHostProfileCatalog(root, credentialStore);
  await catalog.create(MANAGED_PROFILE, "old-token");
  await createDesktopRuntimeHostManagedServiceStore(root).save(
    MANAGED_PROFILE,
    MANAGED_SERVICE,
  );
  await writeFile(
    join(root, "runtime-host-profile-selection.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      defaultProfileId: LOCAL_RUNTIME_HOST_PROFILE.id,
      enabledRemoteProfileIds: [MANAGED_PROFILE.id],
    })}\n`,
  );
  const startup = await resolveDesktopRuntimeHostStartup(root, { catalog, credentialStore });
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup,
    catalog,
    credentialStore,
    states: () => [connectingLocal()],
    enable: async () => undefined,
    disable: async () => undefined,
    setDefault: () => undefined,
    finalizePairing: async () => undefined,
  });
  const access = await service.resolveManagedAccess(MANAGED_PROFILE.id);
  assert.ok(access);

  await service.rotateManagedCredential(access, "new-token");

  assert.equal((await service.getSnapshot()).pairingRecoveryPending, undefined);
  await service.setEnabled(MANAGED_PROFILE.id, false);
  assert.equal(
    (await service.getSnapshot()).entries.find(({ profile }) => profile.id === MANAGED_PROFILE.id)
      ?.enabled,
    false,
  );

  const restarted = await resolveDesktopRuntimeHostStartup(root, { catalog, credentialStore });
  assert.equal(restarted.pairingIntents.length, 0);
  const reenabled: ResolvedRuntimeHostProfile[] = [];
  const restartedService = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup: restarted,
    catalog,
    credentialStore,
    states: () => [connectingLocal()],
    enable: async (target) => {
      reenabled.push(target);
    },
    disable: async () => undefined,
    setDefault: () => undefined,
    finalizePairing: async () => undefined,
  });
  await restartedService.startEnabledProfiles();
  assert.deepEqual(reenabled, []);
  assert.equal(
    (await restartedService.getSnapshot()).entries.find(
      ({ profile }) => profile.id === MANAGED_PROFILE.id,
    )?.enabled,
    false,
  );
});

test('discarding a committed rotation unlocks the restored local profile', async () => {
  const root = await clientRoot();
  const catalog = createClientRuntimeHostProfileCatalog(root);
  await catalog.create(MANAGED_PROFILE, 'old-token');
  await createDesktopRuntimeHostManagedServiceStore(root).save(
    MANAGED_PROFILE,
    MANAGED_SERVICE,
  );
  await writeFile(
    join(root, 'runtime-host-profile-selection.json'),
    `${JSON.stringify({
      schemaVersion: 2,
      defaultProfileId: LOCAL_RUNTIME_HOST_PROFILE.id,
      enabledRemoteProfileIds: [MANAGED_PROFILE.id],
    })}\n`,
  );
  const startup = await resolveDesktopRuntimeHostStartup(root, { catalog });
  let restoringOldCredential = false;
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup,
    catalog,
    states: () => [connectingLocal()],
    enable: async (target) => {
      if (restoringOldCredential && target.credential === 'old-token') {
        throw new Error('old credential was revoked remotely');
      }
    },
    disable: async () => undefined,
    setDefault: () => undefined,
    finalizePairing: async () => {
      throw new RuntimeHostPairingFinalizationInterruptedError();
    },
  });
  const access = await service.resolveManagedAccess(MANAGED_PROFILE.id);
  assert.ok(access);
  await assert.rejects(
    service.rotateManagedCredential(access, 'new-token'),
    RuntimeHostPairingFinalizationInterruptedError,
  );

  restoringOldCredential = true;
  const abandonedLock = join(root, 'runtime-host-profiles.json.lock');
  await mkdir(abandonedLock);
  const discarded = await service.discardPairing(MANAGED_PROFILE.id);
  assert.equal(discarded.pairingRecoveryPending, undefined);
  assert.equal((await catalog.resolve(MANAGED_PROFILE.id)).credential, 'old-token');
  assert.equal(
    discarded.entries.find(({ profile }) => profile.id === MANAGED_PROFILE.id)?.readiness,
    'unavailable',
  );
});

test("keeps managed service recovery when a failed pairing profile cannot be removed", async () => {
  const root = await clientRoot();
  const catalog = createClientRuntimeHostProfileCatalog(root);
  const removeIfCurrent = catalog.removeIfCurrent.bind(catalog);
  catalog.removeIfCurrent = async () => {
    throw new Error("profile catalog is temporarily unavailable");
  };
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
      throw new Error("finalization failed");
    },
  });

  await assert.rejects(
    () =>
      service.addAndEnableVerified({
        profile: MANAGED_PROFILE,
        credential: "new-token",
        managedService: MANAGED_SERVICE,
      }),
    /previous profile could not be restored/u,
  );

  catalog.removeIfCurrent = removeIfCurrent;
  const recoveredStartup = await resolveDesktopRuntimeHostStartup(root, { catalog });
  const recovered = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup: recoveredStartup,
    catalog,
    states: () => [connectingLocal()],
    enable: async () => undefined,
    disable: async () => undefined,
    setDefault: () => undefined,
    finalizePairing: async () => undefined,
  });
  await recovered.startEnabledProfiles();

  assert.equal(
    (await recovered.getSnapshot()).entries.find(
      (entry) => entry.profile.id === MANAGED_PROFILE.id,
    )?.managedService,
    true,
  );
  assert.deepEqual(
    (await resolveDesktopRuntimeHostStartup(root, { catalog })).pairingIntents,
    [],
  );
});

test("keeps an offline pairing recoverable without blocking another Host", async () => {
  const root = await clientRoot();
  const catalog = await stageInterruptedPairing(root);
  const startup = await resolveDesktopRuntimeHostStartup(root, { catalog });
  const finalized: string[] = [];
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup,
    catalog,
    states: () => [connectingLocal()],
    enable: async (target) => {
      if (target.profile.id === PROFILE.id) throw new Error("Host is offline");
    },
    disable: async () => undefined,
    setDefault: () => undefined,
    finalizePairing: async (profileId) => {
      finalized.push(profileId);
    },
  });

  await service.startEnabledProfiles();
  assert.equal((await service.getSnapshot()).pairingRecoveryPending, true);

  await service.addAndEnableVerified({ profile: READY_PROFILE, credential: "backup-token" });

  assert.deepEqual(finalized, [READY_PROFILE.id]);
  assert.equal((await catalog.resolve(READY_PROFILE.id)).credential, "backup-token");
  assert.equal((await service.getSnapshot()).pairingRecoveryPending, true);
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

  await service.startEnabledProfiles();

  assert.equal((await catalog.resolve(PROFILE.id)).credential, "old-token");
  assert.deepEqual(
    (await resolveDesktopRuntimeHostStartup(root, { catalog })).pairingIntents,
    [],
  );
});

test("restores an existing profile when replacement finalization fails", async () => {
    const root = await clientRoot();
    const catalog = createClientRuntimeHostProfileCatalog(root);
    await catalog.create(PROFILE, "old-token");
    const original = await catalog.resolve(PROFILE.id);
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
      },
      disable: async () => undefined,
      setDefault: () => undefined,
      finalizePairing: async () => {
        throw new Error("replacement finalization failed");
      },
    });

    await assert.rejects(
      () =>
        service.addAndEnableVerified({
          profile: {
            ...PROFILE,
            id: "replacement",
          },
          credential: "new-token",
        }),
      /finalization failed/u,
    );

    assert.deepEqual(await catalog.resolve(PROFILE.id), original);
    assert.equal(enabled.at(-1)?.credential, "old-token");
});

test("keeps existing Hosts available while corrupt pairing recovery awaits resolution", async () => {
  const root = await clientRoot();
  const credentialStore = createClientRuntimeHostCredentialStore(root);
  const catalog = createClientRuntimeHostProfileCatalog(root, credentialStore);
  await catalog.create(PROFILE, "token");
  await writeFile(
    join(root, "runtime-host-profile-selection.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      defaultProfileId: "local",
      enabledRemoteProfileIds: [PROFILE.id],
    })}\n`,
  );
  await credentialStore.setSecret(
    "runtime-host-pairing-recovery",
    "runtime_host_access",
    "not-json",
  );
  const startup = await resolveDesktopRuntimeHostStartup(root, { catalog, credentialStore });
  assert.deepEqual(startup.remotes.map((target) => target.profile.id), [PROFILE.id]);
  const enabled: string[] = [];
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup,
    catalog,
    credentialStore,
    states: () => [connectingLocal()],
    enable: async (target) => {
      enabled.push(target.profile.id);
    },
    disable: async () => undefined,
    setDefault: () => undefined,
    finalizePairing: async () => undefined,
  });

  await service.startEnabledProfiles();
  assert.deepEqual(enabled, [PROFILE.id]);
  assert.equal((await service.getSnapshot()).pairingRecoveryBlocked, true);
  await assert.rejects(
    () => service.setEnabled(PROFILE.id, false),
    /Resolve the unreadable/u,
  );
  assert.equal((await service.resolvePairingRecovery()).pairingRecoveryBlocked, undefined);
  assert.equal((await service.setEnabled(PROFILE.id, false)).entries[1]?.enabled, false);
});

test("retries pairing recovery before discarding it", async () => {
  const root = await clientRoot();
  const catalog = await stageInterruptedPairing(root);
  const credentials = createClientRuntimeHostCredentialStore(root);
  let firstRead = true;
  const credentialStore = {
    getSecret: async (...args: Parameters<typeof credentials.getSecret>) => {
      if (firstRead) {
        firstRead = false;
        throw new Error("credential store is temporarily unavailable");
      }
      return credentials.getSecret(...args);
    },
    setSecret: credentials.setSecret.bind(credentials),
    deleteSecret: credentials.deleteSecret.bind(credentials),
    ...(credentials.compareAndSetSecret
      ? { compareAndSetSecret: credentials.compareAndSetSecret.bind(credentials) }
      : {}),
  };
  const startup = await resolveDesktopRuntimeHostStartup(root, { catalog, credentialStore });
  const finalized: string[] = [];
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup,
    catalog,
    credentialStore,
    states: () => [connectingLocal()],
    enable: async () => undefined,
    disable: async () => undefined,
    setDefault: () => undefined,
    finalizePairing: async (profileId) => {
      finalized.push(profileId);
    },
  });

  assert.equal((await service.getSnapshot()).pairingRecoveryBlocked, true);
  assert.equal((await service.resolvePairingRecovery()).pairingRecoveryBlocked, undefined);
  assert.deepEqual(finalized, [PROFILE.id]);
  assert.equal((await catalog.resolve(PROFILE.id)).credential, "new-token");
});

test("does not recover pairing through unreadable saved preferences", async () => {
  const root = await clientRoot();
  const catalog = await stageInterruptedPairing(root);
  const preferencesPath = join(root, "runtime-host-profile-selection.json");
  const savedPreferences = await readFile(preferencesPath, "utf8");
  const startup = await resolveDesktopRuntimeHostStartup(root, {
    catalog,
    readPreferences: async () => {
      throw new Error("preferences are temporarily unavailable");
    },
  });
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup,
    catalog,
    states: () => [connectingLocal()],
    enable: async () => assert.fail("pairing recovery must not connect"),
    disable: async () => assert.fail("pairing recovery must not disconnect"),
    setDefault: () => assert.fail("pairing recovery must not change the default"),
    finalizePairing: async () => assert.fail("pairing recovery must not finalize"),
  });

  await assert.rejects(() => service.resolvePairingRecovery(), /restart Maka before changing/u);
  assert.equal(await readFile(preferencesPath, "utf8"), savedPreferences);
});

test("does not retain a startup connection after its profile is disabled", async () => {
  const root = await clientRoot();
  const catalog = createClientRuntimeHostProfileCatalog(root);
  await catalog.create(PROFILE, "token");
  await writeFile(
    join(root, "runtime-host-profile-selection.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      defaultProfileId: "local",
      enabledRemoteProfileIds: [PROFILE.id],
    })}\n`,
  );
  const startup = await resolveDesktopRuntimeHostStartup(root, { catalog });
  let finishEnable!: () => void;
  const enableReady = new Promise<void>((resolve) => {
    finishEnable = resolve;
  });
  let connected = false;
  const service = createDesktopRuntimeHostProfileService({
    clientDataRoot: root,
    startup,
    catalog,
    states: () => [connectingLocal()],
    enable: async () => {
      await enableReady;
      connected = true;
    },
    disable: async () => {
      connected = false;
    },
    setDefault: () => undefined,
    finalizePairing: async () => undefined,
  });

  const startupTask = service.startEnabledProfiles();
  await service.setEnabled(PROFILE.id, false);
  finishEnable();
  await startupTask;

  assert.equal(connected, false);
  assert.equal(
    (await service.getSnapshot()).entries.find((entry) => entry.profile.id === PROFILE.id)?.enabled,
    false,
  );
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

function readyWithPeerEndpoint(
  target: ResolvedRuntimeHostProfile,
  peerEndpoint: ReturnType<typeof peerReachability>,
): RuntimeHostDesktopTargetState {
  return {
    epoch: `epoch-${target.profile.id}`,
    target,
    readiness: "ready",
    candidate: {
      client: {
        hostId: target.profile.kind === "remote" ? target.profile.rootId : ROOT_ID,
        status: async () => ({ peerEndpoint }),
      },
    } as never,
  };
}

function peerReachability(
  peerId: string,
  revision = 1,
  directRoutes: readonly string[] = ['/ip4/192.0.2.8/udp/44001/quic-v1'],
  coordinationRoutes: readonly string[] = [],
) {
  return {
    lease: {
      version: 1 as const,
      peerId,
      revision,
      issuedAt: 1,
      expiresAt: 2,
      directRoutes,
      coordinationRoutes,
    },
    publicKey: Buffer.from('public').toString('base64url'),
    signature: Buffer.from(`signature-${revision}`).toString('base64url'),
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
