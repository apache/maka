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

import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createClientRuntimeHostCredentialStore,
  createClientRuntimeHostProfileCatalog,
  decodeRuntimeHostOwnerConnectionCode,
  LOCAL_RUNTIME_HOST_PROFILE,
  RUNTIME_HOST_ACCESS_CREDENTIAL_MAX_BYTES,
  RuntimeHostOperationError,
  RuntimeHostPermanentReconnectError,
  RuntimeHostRemoteCompatibilityError,
  sameRemoteRuntimeHostProfileTarget,
  sameResolvedRuntimeHostProfileTarget,
  type RemoteRuntimeHostProfile,
  type ResolvedRuntimeHostProfile,
  type RuntimeHostProfileCatalog,
} from "@maka/runtime-host/client";
import { runtimeHostAccessCredentialFingerprint } from "@maka/runtime-host/operator";
import type { CredentialStore } from "@maka/storage/credential-store";
import { withFileUpdateLock } from "@maka/storage/file-update-lock";
import type {
  DesktopRuntimeHostProfileAddInput,
  DesktopRuntimeHostProfileAddResult,
  DesktopRuntimeHostProfileEntry,
  DesktopRuntimeHostProfileSnapshot,
  DesktopRuntimeHostConnectionCodeImportResult,
} from "../preload/bridge-contract.js";
import {
  RuntimeHostPairingFinalizationInterruptedError,
  type RuntimeHostDesktopTargetState,
} from "./runtime-host-desktop-manager.js";
import {
  createDesktopRuntimeHostPairingIntent,
  DesktopRuntimeHostPairingJournalInvalidError,
  pairingIntentMatchesTarget,
  readDesktopRuntimeHostPairingIntents,
  writeDesktopRuntimeHostPairingIntents,
  type DesktopRuntimeHostPairingIntent,
} from "./runtime-host-pairing-journal.js";
import {
  createDesktopRuntimeHostManagedServiceStore,
  findDesktopRuntimeHostManagedServiceBinding,
  sameDesktopRuntimeHostManagedServiceBinding,
  type DesktopRuntimeHostManagedService,
  type DesktopRuntimeHostManagedServiceBinding,
  type DesktopRuntimeHostManagedServiceStore,
} from "./runtime-host-managed-services.js";

const PREFERENCES_SCHEMA_VERSION = 2;
const PREFERENCES_FILE = "runtime-host-profile-selection.json";
const PROFILE_FILE = "runtime-host-profiles.json";

export interface DesktopRuntimeHostPreferences {
  readonly schemaVersion: 2;
  readonly defaultProfileId: string;
  readonly enabledRemoteProfileIds: readonly string[];
}

export interface DesktopRuntimeHostStartup {
  readonly preferences: DesktopRuntimeHostPreferences;
  readonly preferencesReadFailure?: Error;
  readonly pairingIntents: readonly DesktopRuntimeHostPairingIntent[];
  readonly pairingReadFailure?: Error;
  readonly remotes: readonly ResolvedRuntimeHostProfile[];
  readonly unavailable: ReadonlyMap<string, Error>;
}

export interface DesktopRuntimeHostProfileService {
  getSnapshot(): Promise<DesktopRuntimeHostProfileSnapshot>;
  addAndEnable(
    input: DesktopRuntimeHostProfileAddInput,
  ): Promise<DesktopRuntimeHostProfileAddResult>;
  addAndEnableVerified(
    input: DesktopRuntimeHostProfileAddInput & {
      readonly credential: string;
      readonly managedService?: DesktopRuntimeHostManagedService;
    },
  ): Promise<{ readonly profileId: string }>;
  importConnectionCode(code: string): Promise<DesktopRuntimeHostConnectionCodeImportResult>;
  resolveManagedService(
    profileId: string,
  ): Promise<DesktopRuntimeHostManagedServiceBinding | undefined>;
  resolveManagedAccess(
    profileId: string,
  ): Promise<DesktopRuntimeHostManagedAccess | undefined>;
  resolveManagedDirectPeerProfile(profileId: string): Promise<{
    readonly exists: boolean;
    readonly enabled: boolean;
  }>;
  upsertManagedDirectPeerProfile(
    profileId: string,
    peer: {
      readonly peerId: string;
      readonly routeHints: readonly string[];
      readonly coordinationRelays: readonly string[];
    },
  ): Promise<void>;
  removeManagedDirectPeerProfile(profileId: string): Promise<void>;
  clearManagedServiceBinding(expected: DesktopRuntimeHostManagedServiceBinding): Promise<void>;
  markManagedServiceUninstalling(
    expected: DesktopRuntimeHostManagedServiceBinding,
  ): Promise<DesktopRuntimeHostManagedServiceBinding>;
  markManagedServiceCleanupPending(
    expected: DesktopRuntimeHostManagedServiceBinding,
  ): Promise<DesktopRuntimeHostManagedServiceBinding>;
  rotateManagedCredential(
    expected: DesktopRuntimeHostManagedAccess,
    credential: string,
  ): Promise<void>;
  startEnabledProfiles(): Promise<void>;
  resolvePairingRecovery(): Promise<DesktopRuntimeHostProfileSnapshot>;
  setEnabled(profileId: string, enabled: boolean): Promise<DesktopRuntimeHostProfileSnapshot>;
  reconnect(profileId: string, expectedRootId: string): Promise<void>;
  setDefault(profileId: string): Promise<DesktopRuntimeHostProfileSnapshot>;
  remove(profileId: string): Promise<DesktopRuntimeHostProfileSnapshot>;
}

export interface DesktopRuntimeHostManagedAccess
  extends DesktopRuntimeHostManagedServiceBinding {
  readonly credentialFingerprint: string;
  readonly enabled: boolean;
}

export async function resolveDesktopRuntimeHostStartup(
  clientDataRoot: string,
  overrides: {
    catalog?: RuntimeHostProfileCatalog;
    credentialStore?: CredentialStore;
    readPreferences?: () => Promise<DesktopRuntimeHostPreferences>;
  } = {},
): Promise<DesktopRuntimeHostStartup> {
  const preferencesPath = join(clientDataRoot, PREFERENCES_FILE);
  let preferences: DesktopRuntimeHostPreferences;
  let preferencesReadFailure: Error | undefined;
  try {
    preferences = await (overrides.readPreferences?.() ??
      readRuntimeHostPreferences(preferencesPath));
  } catch (error) {
    preferencesReadFailure = asError(error);
    console.error(
      "[runtime-host] preferences could not be read; using Local defaults:",
      preferencesReadFailure,
    );
    preferences = defaultPreferences();
  }
  let pairingIntents: readonly DesktopRuntimeHostPairingIntent[] = [];
  let pairingReadFailure: Error | undefined;
  const credentialStore =
    overrides.credentialStore ?? createClientRuntimeHostCredentialStore(clientDataRoot);
  try {
    pairingIntents = await readDesktopRuntimeHostPairingIntents(credentialStore);
  } catch (error) {
    pairingReadFailure = asError(error);
    console.error("[runtime-host] pairing recovery journal could not be read:", pairingReadFailure);
  }
  const catalog =
    overrides.catalog ?? createClientRuntimeHostProfileCatalog(clientDataRoot, credentialStore);
  let document: Awaited<ReturnType<RuntimeHostProfileCatalog["read"]>>;
  try {
    document = await catalog.read();
  } catch (error) {
    const failure = asError(error);
    console.error(
      "[runtime-host] remote profiles could not be read; starting with Local only:",
      failure,
    );
    const unavailable = new Map<string, Error>();
    for (const profileId of preferences.enabledRemoteProfileIds) {
      unavailable.set(profileId, failure);
    }
    if (preferences.defaultProfileId !== LOCAL_RUNTIME_HOST_PROFILE.id) {
      unavailable.set(preferences.defaultProfileId, failure);
    }
    return {
      preferences,
      ...(preferencesReadFailure ? { preferencesReadFailure } : {}),
      pairingIntents,
      ...(pairingReadFailure ? { pairingReadFailure } : {}),
      remotes: [],
      unavailable,
    };
  }
  const profileIds = new Set(document.profiles.map((profile) => profile.id));
  const defaultProfileId =
    preferences.defaultProfileId === LOCAL_RUNTIME_HOST_PROFILE.id ||
    profileIds.has(preferences.defaultProfileId)
      ? preferences.defaultProfileId
      : LOCAL_RUNTIME_HOST_PROFILE.id;
  const enabledRemoteProfileIds = new Set(
    preferences.enabledRemoteProfileIds.filter((profileId) => profileIds.has(profileId)),
  );
  if (defaultProfileId !== LOCAL_RUNTIME_HOST_PROFILE.id) {
    enabledRemoteProfileIds.add(defaultProfileId);
  }
  const normalized: DesktopRuntimeHostPreferences = {
    ...preferences,
    defaultProfileId,
    enabledRemoteProfileIds: [...enabledRemoteProfileIds].sort(),
  };
  if (JSON.stringify(normalized) !== JSON.stringify(preferences)) {
    await writeRuntimeHostPreferences(preferencesPath, normalized);
    preferences = normalized;
  }
  const enabledIds = new Set(preferences.enabledRemoteProfileIds);
  if (preferences.defaultProfileId !== LOCAL_RUNTIME_HOST_PROFILE.id) {
    enabledIds.add(preferences.defaultProfileId);
  }
  const remotes: ResolvedRuntimeHostProfile[] = [];
  const unavailable = new Map<string, Error>();
  for (const profileId of enabledIds) {
    try {
      remotes.push(await catalog.resolve(profileId));
    } catch (error) {
      unavailable.set(profileId, asError(error));
    }
  }
  return {
    preferences,
    ...(preferencesReadFailure ? { preferencesReadFailure } : {}),
    pairingIntents,
    ...(pairingReadFailure ? { pairingReadFailure } : {}),
    remotes,
    unavailable,
  };
}

export function createDesktopRuntimeHostProfileService(input: {
  readonly clientDataRoot: string;
  readonly startup: DesktopRuntimeHostStartup;
  readonly states: () => readonly RuntimeHostDesktopTargetState[];
  readonly enable: (
    target: ResolvedRuntimeHostProfile,
    sshInteraction: "terminal" | "batch",
  ) => Promise<void>;
  readonly disable: (profileId: string) => Promise<void>;
  readonly finalizePairing: (profileId: string) => Promise<void>;
  readonly setDefault: (profileId: string) => void;
  readonly catalog?: RuntimeHostProfileCatalog;
  readonly credentialStore?: CredentialStore;
  readonly managedServices?: DesktopRuntimeHostManagedServiceStore;
}): DesktopRuntimeHostProfileService {
  const credentialStore =
    input.credentialStore ?? createClientRuntimeHostCredentialStore(input.clientDataRoot);
  const catalog =
    input.catalog ?? createClientRuntimeHostProfileCatalog(input.clientDataRoot, credentialStore);
  const managedServices =
    input.managedServices ?? createDesktopRuntimeHostManagedServiceStore(input.clientDataRoot);
  const preferencesPath = join(input.clientDataRoot, PREFERENCES_FILE);
  const profilePath = join(input.clientDataRoot, PROFILE_FILE);
  let preferences = input.startup.preferences;
  const unavailable = new Map(input.startup.unavailable);
  let pairingIntents = new Map(
    input.startup.pairingIntents.map((intent) => [intent.target.profile.id, intent]),
  );
  let pairingReadFailure = input.startup.pairingReadFailure;
  let mutationTail = Promise.resolve();

  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = mutationTail.then(operation);
    mutationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };

  const assertPreferencesWritable = (): void => {
    // The Local fallback is effective startup state, not a replacement for
    // preferences whose durable value is unknown.
    if (input.startup.preferencesReadFailure) {
      throw new Error(
        "Saved Runtime Host settings could not be read; restart Maka before changing them",
        { cause: input.startup.preferencesReadFailure },
      );
    }
  };

  const mutateProfiles = <T>(operation: () => Promise<T>): Promise<T> =>
    mutate(async () => {
      assertPreferencesWritable();
      if (pairingReadFailure) {
        throw new Error(
          "Resolve the unreadable Runtime Host pairing recovery state before changing profiles",
          { cause: pairingReadFailure },
        );
      }
      return operation();
    });

  const persistPairingIntents = async (
    next: ReadonlyMap<string, DesktopRuntimeHostPairingIntent>,
  ): Promise<void> => {
    await writeDesktopRuntimeHostPairingIntents(credentialStore, [...next.values()]);
    pairingIntents = new Map(next);
  };

  const beginPairingIntent = async (intent: DesktopRuntimeHostPairingIntent): Promise<void> => {
    const profileId = intent.target.profile.id;
    if (pairingIntents.has(profileId)) {
      throw new Error("This Runtime Host has an unfinished pairing recovery");
    }
    await persistPairingIntents(new Map(pairingIntents).set(profileId, intent));
  };

  const assertPairingComplete = (profileId: string): void => {
    if (pairingIntents.has(profileId)) {
      throw new Error('Resolve this Runtime Host\'s unfinished pairing before changing it');
    }
  };

  const snapshot = async (): Promise<DesktopRuntimeHostProfileSnapshot> => {
    const document = await catalog.read();
    const managedDocument = await managedServices.read();
    const profiles = [LOCAL_RUNTIME_HOST_PROFILE, ...document.profiles];
    const states = new Map(input.states().map((state) => [state.target.profile.id, state]));
    const enabled = new Set(preferences.enabledRemoteProfileIds);
    return {
      defaultProfileId: preferences.defaultProfileId,
      ...(pairingReadFailure ? { pairingRecoveryBlocked: true as const } : {}),
      ...(pairingIntents.size > 0 ? { pairingRecoveryPending: true as const } : {}),
      entries: profiles.map((profile): DesktopRuntimeHostProfileEntry => {
        const isEnabled = profile.kind === "local" || enabled.has(profile.id);
        const state = states.get(profile.id);
        const error = state?.readiness === "unavailable"
          ? state.error
          : unavailable.get(profile.id);
        return {
          profile,
          ...(profile.kind === "remote" &&
          findDesktopRuntimeHostManagedServiceBinding(managedDocument, profile)
            ? { managedService: true as const }
            : {}),
          enabled: isEnabled,
          isDefault: preferences.defaultProfileId === profile.id,
          readiness: isEnabled ? (state?.readiness ?? "unavailable") : "disabled",
          ...(state?.readiness === "ready"
            ? { hostId: state.candidate.client.hostId }
            : state && "hostId" in state && state.hostId
              ? { hostId: state.hostId }
              : {}),
          ...(error ? { message: error.message } : {}),
        };
      }),
    };
  };

  const persist = async (next: DesktopRuntimeHostPreferences): Promise<void> => {
    await withFileUpdateLock(profilePath, () =>
      writeRuntimeHostPreferences(preferencesPath, next),
    );
    preferences = next;
  };

  const clearPairingIntentBestEffort = async (profileId: string): Promise<void> => {
    const next = new Map(pairingIntents);
    next.delete(profileId);
    await persistPairingIntents(next).catch((error) =>
      console.error("[runtime-host] completed pairing recovery could not be cleared:", error),
    );
  };

  const ensureEnabled = async (target: ResolvedRuntimeHostProfile): Promise<void> => {
    assertRootIsNotEnabled(target, preferences, await catalog.read(), input.states());
    if (preferences.enabledRemoteProfileIds.includes(target.profile.id)) return;
    const next = withEnabled(preferences, target.profile.id, true);
    await persistIfCurrentTarget(catalog, profilePath, preferencesPath, target, next);
    preferences = next;
  };

  const resolveActivationTarget = async (
    target: ResolvedRuntimeHostProfile,
  ): Promise<ResolvedRuntimeHostProfile> => {
    if (
      target.profile.kind !== 'remote' ||
      target.profile.transport.kind !== 'libp2p-direct'
    ) {
      return target;
    }
    const directProfile = target.profile;
    const document = await catalog.read();
    const sourceProfile = document.profiles.find(
      (profile) =>
        profile.kind === 'remote' &&
        profile.transport.kind === 'ssh' &&
        profile.rootId === directProfile.rootId &&
        managedDirectPeerProfileId(profile.id) === directProfile.id,
    );
    if (!sourceProfile) return target;
    const managed = findDesktopRuntimeHostManagedServiceBinding(
      await managedServices.read(),
      sourceProfile,
    );
    if (!managed) return target;
    if (managed.state !== 'active') {
      throw new Error('The managed SSH recovery profile is not available');
    }
    const source = await catalog.resolve(sourceProfile.id);
    if (source.profile.kind !== 'remote' || !source.credential) {
      throw new Error('The managed SSH recovery profile credential is not available');
    }
    if (source.credential === target.credential) return target;
    const rebound = await catalog.rebindIfCurrent(target, target.profile, source.credential);
    if (!rebound.rebound) {
      throw new Error('The Direct peer profile changed before its credential could be refreshed');
    }
    return catalog.resolve(target.profile.id);
  };

  const activateTarget = async (
    target: ResolvedRuntimeHostProfile,
    sshInteraction: "terminal" | "batch",
  ): Promise<void> => {
    try {
      const activationTarget = await resolveActivationTarget(target);
      await input.enable(activationTarget, sshInteraction);
      const current = await catalog.resolve(activationTarget.profile.id).catch(() => undefined);
      if (!current || !sameResolvedRuntimeHostProfileTarget(current, activationTarget)) {
        await input.disable(activationTarget.profile.id);
        throw new Error("Runtime Host profile changed while it was connecting");
      }
      const remainsEnabled =
        activationTarget.profile.id === preferences.defaultProfileId ||
        preferences.enabledRemoteProfileIds.includes(activationTarget.profile.id);
      if (!remainsEnabled) {
        await input.disable(activationTarget.profile.id);
        return;
      }
      unavailable.delete(activationTarget.profile.id);
    } catch (error) {
      const failure = asError(error);
      unavailable.set(target.profile.id, failure);
      throw failure;
    }
  };

  const startupSshInteraction = (
    target: ResolvedRuntimeHostProfile,
  ): "terminal" | "batch" =>
    target.profile.kind === "remote" &&
    target.profile.transport.kind === "ssh" &&
    target.profile.id === preferences.defaultProfileId
      ? "terminal"
      : "batch";

  const resolveExistingPairingTarget = async (
    profileId: string,
  ): Promise<ResolvedRuntimeHostProfile | undefined> => {
    const profile = (await catalog.read()).profiles.find(
      (candidate) => candidate.id === profileId,
    );
    return profile ? catalog.resolve(profileId) : undefined;
  };

  const finishPairingIntent = async (
    intent: DesktopRuntimeHostPairingIntent,
  ): Promise<void> => {
    const target = await catalog.resolve(intent.target.profile.id);
    if (!pairingIntentMatchesTarget(intent.target, target)) {
      throw new Error("Runtime Host profile changed before pairing could resume");
    }
    await ensureEnabled(target);
    await activateTarget(target, "terminal");
    await input.finalizePairing(target.profile.id);
    await clearPairingIntentBestEffort(target.profile.id);
  };

  const rollbackPairingIntent = async (
    intent: DesktopRuntimeHostPairingIntent,
    failure: unknown,
  ): Promise<void> => {
    let current: ResolvedRuntimeHostProfile | undefined;
    try {
      current = await resolveExistingPairingTarget(intent.target.profile.id);
    } catch (resolveFailure) {
      throw new AggregateError(
        [failure, resolveFailure],
        "Runtime Host pairing failed and its current profile could not be read",
      );
    }
    if (!current || !pairingIntentMatchesTarget(intent.target, current)) {
      if (!intent.previous) {
        await managedServices.removeForProfileIfCurrent(intent.target.profile);
      }
      await clearPairingIntentBestEffort(intent.target.profile.id);
      return;
    }
    const rollbackFailures: unknown[] = [];
    await input.disable(current.profile.id).catch((error) => rollbackFailures.push(error));
    if (intent.previous) {
      const restored = await catalog
        .rebindIfCurrent(current, intent.previous.profile, intent.previous.credential)
        .catch((error) => {
          rollbackFailures.push(error);
          return undefined;
        });
      if (restored && !restored.rebound) {
        rollbackFailures.push(new Error("Runtime Host profile changed during pairing rollback"));
      }
      if (restored?.rebound) {
        const previousTarget = await catalog.resolve(intent.previous.profile.id).catch((error) => {
          rollbackFailures.push(error);
          return undefined;
        });
        if (previousTarget) {
          const next = withEnabled(preferences, previousTarget.profile.id, intent.wasEnabled);
          await persistIfCurrentTarget(
            catalog,
            profilePath,
            preferencesPath,
            previousTarget,
            next,
          ).then(
            () => {
              preferences = next;
            },
            (error) => rollbackFailures.push(error),
          );
          if (intent.wasEnabled) {
            await activateTarget(previousTarget, "terminal").catch((error) =>
              rollbackFailures.push(error),
            );
          }
        }
      }
    } else {
      const next = withEnabled(preferences, current.profile.id, false);
      await persistIfCurrentTarget(catalog, profilePath, preferencesPath, current, next).then(
        () => {
          preferences = next;
        },
        (error) => rollbackFailures.push(error),
      );
      let profileRemoved = false;
      await catalog.removeIfCurrent(current).then(
        (result) => {
          if (!result.removed) {
            rollbackFailures.push(
              new Error("Runtime Host profile changed during pairing rollback"),
            );
          } else {
            profileRemoved = true;
          }
        },
        (error) => rollbackFailures.push(error),
      );
      if (profileRemoved) {
        await managedServices.removeForProfileIfCurrent(intent.target.profile).catch((error) =>
          rollbackFailures.push(error),
        );
      }
    }
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [failure, ...rollbackFailures],
        "Runtime Host pairing failed and its previous profile could not be restored",
      );
    }
    unavailable.delete(current.profile.id);
    await clearPairingIntentBestEffort(intent.target.profile.id);
  };

  const recoverPairingIntent = async (
    intent: DesktopRuntimeHostPairingIntent,
  ): Promise<Error | undefined> => {
    let current: ResolvedRuntimeHostProfile | undefined;
    try {
      current = await resolveExistingPairingTarget(intent.target.profile.id);
    } catch (error) {
      const failure = asError(error);
      unavailable.set(intent.target.profile.id, failure);
      return failure;
    }
    if (!current || !pairingIntentMatchesTarget(intent.target, current)) {
      if (!intent.previous) {
        await managedServices.removeForProfileIfCurrent(intent.target.profile);
      }
      await clearPairingIntentBestEffort(intent.target.profile.id);
      if (
        current &&
        (preferences.defaultProfileId === current.profile.id ||
          preferences.enabledRemoteProfileIds.includes(current.profile.id))
      ) {
        try {
          await activateTarget(current, startupSshInteraction(current));
        } catch (error) {
          return asError(error);
        }
      }
      return undefined;
    }
    try {
      await finishPairingIntent(intent);
      return undefined;
    } catch (error) {
      const failure = asError(error);
      const stateFailure = input.states().find(
        (state) =>
          state.target.profile.id === intent.target.profile.id &&
          state.readiness === "unavailable",
      );
      if (
        failure instanceof RuntimeHostPermanentReconnectError ||
        stateFailure?.readiness === "unavailable" &&
          stateFailure.error instanceof RuntimeHostPermanentReconnectError ||
        failure instanceof RuntimeHostOperationError &&
          failure.operation === "access.credential.finalize" &&
          failure.code === "invalid_request"
      ) {
        await rollbackPairingIntent(intent, failure);
        return undefined;
      }
      unavailable.set(intent.target.profile.id, failure);
      return failure;
    }
  };

  const enable = async (profileId: string): Promise<Error | undefined> => {
    const pairingIntent = pairingIntents.get(profileId);
    if (pairingIntent) {
      return recoverPairingIntent(pairingIntent);
    }
    const target = await catalog.resolve(profileId);
    await ensureEnabled(target);
    try {
      await activateTarget(target, "terminal");
      return undefined;
    } catch (error) {
      return asError(error);
    }
  };

  const recoverPendingPairings = (): Promise<void> =>
    mutateProfiles(async () => {
      for (const intent of [...pairingIntents.values()]) {
        await recoverPairingIntent(intent);
      }
    });

  const addAndEnableVerified = (
    value: DesktopRuntimeHostProfileAddInput & {
      readonly credential: string;
      readonly managedService?: DesktopRuntimeHostManagedService;
    },
  ): Promise<{ readonly profileId: string }> => {
    requireSaveInput(value);
    return mutateProfiles(async () => {
      const currentDocument = await catalog.read();
      const existing = currentDocument.profiles.find((profile) =>
        profile.rootId === value.profile.rootId &&
        sameRemoteRuntimeHostProfileTarget(profile, value.profile),
      );
      const previousTarget = existing ? await catalog.resolve(existing.id) : undefined;
      const profile = existing ? { ...value.profile, id: existing.id } : value.profile;
      const target = { profile, credential: value.credential } as const;
      const intent = createDesktopRuntimeHostPairingIntent({
        target,
        ...(previousTarget ? { previous: previousTarget } : {}),
        wasEnabled:
          previousTarget !== undefined &&
          preferences.enabledRemoteProfileIds.includes(previousTarget.profile.id),
      });
      await beginPairingIntent(intent);
      try {
        if (value.managedService) {
          await managedServices.save(profile, value.managedService);
        }
        if (previousTarget) {
          const rebound = await catalog.rebindIfCurrent(
            previousTarget,
            profile,
            value.credential,
          );
          if (!rebound.rebound) {
            throw new Error("Runtime Host profile changed before it could be updated");
          }
        } else {
          await catalog.create(profile, value.credential);
        }
        await finishPairingIntent(intent);
        return { profileId: profile.id };
      } catch (failure) {
        if (failure instanceof RuntimeHostPairingFinalizationInterruptedError) throw failure;
        await rollbackPairingIntent(intent, failure);
        throw failure;
      }
    });
  };

  return {
    getSnapshot: () => mutate(snapshot),
    addAndEnable(value) {
      requireSaveInput(value);
      return mutateProfiles(async () => {
        if (value.credential === undefined) {
          throw new Error("A Runtime Host access credential is required");
        }
        const document = await catalog.create(value.profile, value.credential);
        const profile = document.profiles.find((candidate) => candidate.id === value.profile.id);
        if (!profile) throw new Error("Runtime Host profile creation did not persist");
        const target = { profile, credential: value.credential } as const;
        let error: Error | undefined;
        try {
          error = await enable(profile.id);
        } catch (failure) {
          await rollbackCreatedProfile(catalog, target, failure);
          throw failure;
        }
        return error
          ? { kind: "unavailable", snapshot: await snapshot(), message: error.message }
          : { kind: "connected", snapshot: await snapshot() };
      });
    },
    addAndEnableVerified,
    async importConnectionCode(code) {
      let decoded;
      try {
        decoded = decodeRuntimeHostOwnerConnectionCode(code);
      } catch {
        return { kind: 'error', reason: 'invalid_code' };
      }
      try {
        const result = await addAndEnableVerified({
          profile: {
            id: `remote-${randomUUID()}`,
            name: decoded.name,
            kind: 'remote',
            rootId: decoded.rootId,
            transport: decoded.transport,
          },
          credential: decoded.credential,
        });
        return { kind: 'connected', profileId: result.profileId };
      } catch (error) {
        return { kind: 'error', reason: connectionCodeImportFailure(error) };
      }
    },
    rotateManagedCredential(expected, credential) {
      return mutateProfiles(async () => {
        const profileId = expected.profile.id;
        if (!preferences.enabledRemoteProfileIds.includes(profileId)) {
          throw new Error('Enable this Runtime Host before rotating its access credential');
        }
        const previous = await catalog.resolve(profileId);
        if (previous.profile.kind !== 'remote') {
          throw new Error('Only a remote Runtime Host credential can be rotated');
        }
        const managed = findDesktopRuntimeHostManagedServiceBinding(
          await managedServices.read(),
          previous.profile,
        );
        if (
          !managed ||
          !sameDesktopRuntimeHostManagedServiceBinding(managed, expected) ||
          !previous.credential ||
          runtimeHostAccessCredentialFingerprint(previous.credential) !==
            expected.credentialFingerprint
        ) {
          throw new Error(
            'Runtime Host profile changed before its access credential could be rotated',
          );
        }
        const target = { profile: previous.profile, credential } as const;
        const intent = createDesktopRuntimeHostPairingIntent({
          target,
          previous,
          wasEnabled: true,
        });
        await beginPairingIntent(intent);
        try {
          const rebound = await catalog.rebindIfCurrent(
            previous,
            previous.profile,
            credential,
          );
          if (!rebound.rebound) {
            throw new Error('Runtime Host profile changed before its credential could be rotated');
          }
          await finishPairingIntent(intent);
        } catch (failure) {
          if (failure instanceof RuntimeHostPairingFinalizationInterruptedError) throw failure;
          await rollbackPairingIntent(intent, failure);
          throw failure;
        }
      });
    },
    resolveManagedService(profileId) {
      return mutate(async () => {
        const profile = (await catalog.read()).profiles.find(
          (candidate) => candidate.id === profileId,
        );
        if (!profile) return undefined;
        const binding = findDesktopRuntimeHostManagedServiceBinding(
          await managedServices.read(),
          profile,
        );
        return binding;
      });
    },
    resolveManagedAccess(profileId) {
      return mutate(async () => {
        if (pairingReadFailure || pairingIntents.has(profileId)) {
          throw new Error(
            "Resolve this Runtime Host's unfinished pairing before managing its access",
            pairingReadFailure ? { cause: pairingReadFailure } : undefined,
          );
        }
        const resolved = await catalog.resolve(profileId).catch(() => undefined);
        if (!resolved?.credential || resolved.profile.kind !== "remote") return undefined;
        const binding = findDesktopRuntimeHostManagedServiceBinding(
          await managedServices.read(),
          resolved.profile,
        );
        return binding
          ? {
              ...binding,
              credentialFingerprint: runtimeHostAccessCredentialFingerprint(resolved.credential),
              enabled: preferences.enabledRemoteProfileIds.includes(profileId),
            }
          : undefined;
      });
    },
    resolveManagedDirectPeerProfile(profileId) {
      return mutate(async () => {
        const peerProfileId = managedDirectPeerProfileId(profileId);
        return {
          exists: (await catalog.read()).profiles.some((profile) => profile.id === peerProfileId),
          enabled: preferences.enabledRemoteProfileIds.includes(peerProfileId),
        };
      });
    },
    upsertManagedDirectPeerProfile(profileId, peer) {
      return mutateProfiles(async () => {
        assertPairingComplete(profileId);
        const source = await catalog.resolve(profileId);
        if (
          source.profile.kind !== 'remote' ||
          source.profile.transport.kind !== 'ssh' ||
          !source.credential
        ) {
          throw new Error('Direct peer can only be added through a managed SSH Runtime Host');
        }
        const managed = findDesktopRuntimeHostManagedServiceBinding(
          await managedServices.read(),
          source.profile,
        );
        if (!managed || managed.state !== 'active') {
          throw new Error('This Runtime Host profile is not bound to an active managed service');
        }
        if (peer.routeHints.length === 0 && peer.coordinationRelays.length === 0) {
          throw new Error('Runtime Host returned an invalid direct-peer descriptor');
        }
        const peerProfileId = managedDirectPeerProfileId(profileId);
        if (preferences.enabledRemoteProfileIds.includes(peerProfileId)) {
          throw new Error('Disable the Direct peer profile before changing its listener');
        }
        const profile: RemoteRuntimeHostProfile = {
          id: peerProfileId,
          name: directPeerProfileName(source.profile.name),
          kind: 'remote',
          rootId: source.profile.rootId,
          transport: {
            kind: 'libp2p-direct',
            peerId: peer.peerId,
            routeHints: peer.routeHints,
            coordinationRelays: peer.coordinationRelays,
          },
        };
        const existing = (await catalog.read()).profiles.find(
          (candidate) => candidate.id === peerProfileId,
        );
        if (!existing) {
          await catalog.create(profile, source.credential);
          return;
        }
        const previous = await catalog.resolve(peerProfileId);
        if (previous.profile.kind !== 'remote' || previous.profile.rootId !== source.profile.rootId) {
          throw new Error('The Direct peer profile identity is already in use');
        }
        const rebound = await catalog.rebindIfCurrent(previous, profile, source.credential);
        if (!rebound.rebound) {
          throw new Error('The Direct peer profile changed before it could be updated');
        }
      });
    },
    removeManagedDirectPeerProfile(profileId) {
      return mutateProfiles(async () => {
        assertPairingComplete(profileId);
        const peerProfileId = managedDirectPeerProfileId(profileId);
        if (preferences.enabledRemoteProfileIds.includes(peerProfileId)) {
          throw new Error('Disable the Direct peer profile before changing its listener');
        }
        const current = await catalog.resolve(peerProfileId).catch(() => undefined);
        if (!current) return;
        const source = await catalog.resolve(profileId);
        if (
          source.profile.kind !== 'remote' ||
          source.profile.transport.kind !== 'ssh' ||
          current.profile.kind !== 'remote' ||
          current.profile.transport.kind !== 'libp2p-direct' ||
          current.profile.rootId !== source.profile.rootId
        ) {
          throw new Error('The Direct peer profile identity is already in use');
        }
        const removed = await catalog.removeIfCurrent(current);
        if (!removed.removed) {
          throw new Error('The Direct peer profile changed before it could be removed');
        }
      });
    },
    markManagedServiceUninstalling(expected) {
      return mutateProfiles(async () => {
        assertPairingComplete(expected.profile.id);
        const document = await catalog.read();
        const current = document.profiles.find(
          (profile) => profile.id === expected.profile.id,
        );
        if (
          !current ||
          !sameRemoteRuntimeHostProfileTarget(current, expected.profile)
        ) {
          throw new Error('Runtime Host managed service binding changed during uninstall');
        }
        if (
          document.profiles.some(
            (profile) => profile.id === managedDirectPeerProfileId(expected.profile.id),
          )
        ) {
          throw new Error('Disable and remove the Direct peer profile before uninstalling this service');
        }
        if (
          !(await managedServices.markUninstallingIfCurrent(
            expected.profile,
            expected.service,
          ))
        ) {
          throw new Error('Runtime Host managed service binding changed during uninstall');
        }
        return { ...expected, state: 'uninstalling' };
      });
    },
    markManagedServiceCleanupPending(expected) {
      return mutateProfiles(async () => {
        assertPairingComplete(expected.profile.id);
        const current = (await catalog.read()).profiles.find(
          (profile) => profile.id === expected.profile.id,
        );
        if (
          !current ||
          !sameRemoteRuntimeHostProfileTarget(current, expected.profile) ||
          !(await managedServices.markCleanupPendingIfCurrent(
            expected.profile,
            expected.service,
          ))
        ) {
          throw new Error('Runtime Host managed service binding changed during uninstall');
        }
        return { ...expected, state: 'cleanup_pending' };
      });
    },
    clearManagedServiceBinding(expected) {
      return mutateProfiles(async () => {
        assertPairingComplete(expected.profile.id);
        const current = (await catalog.read()).profiles.find(
          (profile) => profile.id === expected.profile.id,
        );
        if (
          !current ||
          !sameRemoteRuntimeHostProfileTarget(current, expected.profile) ||
          !(await managedServices.removeCleanupPendingIfCurrent(
            expected.profile,
            expected.service,
          ))
        ) {
          throw new Error('Runtime Host managed service binding changed during uninstall');
        }
      });
    },
    startEnabledProfiles() {
      const tasks: Promise<unknown>[] = [];
      let interactiveStartup = Promise.resolve();
      if (!pairingReadFailure && pairingIntents.size > 0) {
        interactiveStartup = recoverPendingPairings().catch((error) =>
          console.error("[runtime-host] pairing recovery failed:", error),
        );
        tasks.push(interactiveStartup);
      }
      for (const target of input.startup.remotes) {
        if (target.profile.kind !== "remote" || !target.credential) continue;
        if (pairingIntents.has(target.profile.id)) continue;
        const sshInteraction = startupSshInteraction(target);
        const activation = () => activateTarget(target, sshInteraction);
        tasks.push(
          (sshInteraction === "terminal" ? interactiveStartup.then(activation) : activation()).catch((error) =>
            console.error(`[runtime-host] ${target.profile.name} is unavailable:`, error),
          ),
        );
      }
      return Promise.all(tasks).then(() => undefined);
    },
    resolvePairingRecovery() {
      return mutate(async () => {
        assertPreferencesWritable();
        if (pairingReadFailure) {
          try {
            pairingIntents = new Map(
              (await readDesktopRuntimeHostPairingIntents(credentialStore)).map((intent) => [
                intent.target.profile.id,
                intent,
              ]),
            );
            pairingReadFailure = undefined;
          } catch (error) {
            if (!(error instanceof DesktopRuntimeHostPairingJournalInvalidError)) throw error;
            await writeDesktopRuntimeHostPairingIntents(credentialStore, []);
            pairingIntents = new Map();
            pairingReadFailure = undefined;
          }
        }
        for (const intent of [...pairingIntents.values()]) {
          await recoverPairingIntent(intent);
        }
        return snapshot();
      });
    },
    setEnabled(profileId, isEnabled) {
      return mutateProfiles(async () => {
        if (profileId === LOCAL_RUNTIME_HOST_PROFILE.id) {
          if (!isEnabled) throw new Error("Local Runtime Host cannot be disabled");
          return snapshot();
        }
        if (isEnabled) {
          await enable(profileId);
          return snapshot();
        }
        assertPairingComplete(profileId);
        if (preferences.defaultProfileId === profileId) {
          throw new Error("Choose another default Runtime Host before disabling this one");
        }
        const next = withEnabled(preferences, profileId, false);
        await persist(next);
        unavailable.delete(profileId);
        await input.disable(profileId);
        return snapshot();
      });
    },
    reconnect(profileId, expectedRootId) {
      return mutateProfiles(async () => {
        assertPairingComplete(profileId);
        if (!preferences.enabledRemoteProfileIds.includes(profileId)) {
          throw new Error('Enable this Runtime Host before reconnecting it');
        }
        const target = await catalog.resolve(profileId);
        if (target.profile.kind !== 'remote' || target.profile.rootId !== expectedRootId) {
          throw new Error('Runtime Host profile changed before it could reconnect');
        }
        await input.disable(profileId);
        await activateTarget(target, 'terminal');
      });
    },
    setDefault(profileId) {
      return mutateProfiles(async () => {
        if (
          profileId !== LOCAL_RUNTIME_HOST_PROFILE.id &&
          !preferences.enabledRemoteProfileIds.includes(profileId)
        ) {
          throw new Error("Enable a Runtime Host before making it the default");
        }
        const next = { ...preferences, defaultProfileId: profileId };
        await persist(next);
        input.setDefault(profileId);
        return snapshot();
      });
    },
    remove(profileId) {
      return mutateProfiles(async () => {
        if (profileId === LOCAL_RUNTIME_HOST_PROFILE.id) {
          throw new Error("Local Runtime Host cannot be removed");
        }
        assertPairingComplete(profileId);
        if (preferences.enabledRemoteProfileIds.includes(profileId)) {
          throw new Error("Disable a Runtime Host before removing it");
        }
        if (preferences.defaultProfileId === profileId) {
          throw new Error("Choose another default Runtime Host before removing this one");
        }
        const document = await catalog.read();
        const profile = document.profiles.find(
          (candidate) => candidate.id === profileId,
        );
        if (!profile) throw new Error("Runtime Host profile was not found");
        if (
          profile.kind === 'remote' &&
          profile.transport.kind === 'ssh' &&
          document.profiles.some(
            (candidate) => candidate.id === managedDirectPeerProfileId(profileId),
          )
        ) {
          throw new Error('Disable and remove the Direct peer profile before removing its SSH profile');
        }
        const managedBinding = findDesktopRuntimeHostManagedServiceBinding(
          await managedServices.read(),
          profile,
        );
        if (managedBinding && managedBinding.state !== 'active') {
          throw new Error('Finish uninstalling this Runtime Host service before removing it');
        }
        await catalog.remove(profileId);
        if (managedBinding) {
          await managedServices
            .removeIfCurrent(profile, managedBinding.service)
            .catch((error) =>
              console.error("[runtime-host] removed Profile left stale service metadata:", error),
            );
        }
        unavailable.delete(profileId);
        return snapshot();
      });
    },
  };
}

function managedDirectPeerProfileId(sourceProfileId: string): string {
  const digest = createHash('sha256').update(sourceProfileId).digest('hex').slice(0, 32);
  return `direct-${digest}`;
}

function directPeerProfileName(sourceName: string): string {
  const suffix = ' · Direct';
  let name = sourceName;
  while (Buffer.byteLength(name + suffix, 'utf8') > 128) name = name.slice(0, -1);
  return `${name}${suffix}`;
}

async function rollbackCreatedProfile(
  catalog: RuntimeHostProfileCatalog,
  target: ResolvedRuntimeHostProfile,
  failure: unknown,
): Promise<void> {
  try {
    await catalog.removeIfCurrent(target);
  } catch (rollbackFailure) {
    throw new AggregateError(
      [failure, rollbackFailure],
      "Runtime Host could not be added and the incomplete profile could not be removed",
    );
  }
}

function assertRootIsNotEnabled(
  target: ResolvedRuntimeHostProfile,
  preferences: DesktopRuntimeHostPreferences,
  document: Awaited<ReturnType<RuntimeHostProfileCatalog["read"]>>,
  states: readonly RuntimeHostDesktopTargetState[],
): void {
  if (target.profile.kind !== "remote") return;
  const rootId = target.profile.rootId;
  const duplicateProfile = document.profiles.find(
    (profile) =>
      profile.kind === "remote" &&
      profile.id !== target.profile.id &&
      preferences.enabledRemoteProfileIds.includes(profile.id) &&
      profile.rootId === rootId,
  );
  const duplicateState = states.find((state) => {
    if (state.target.profile.id === target.profile.id) return false;
    const stateRootId = state.target.profile.kind === "remote"
      ? state.target.profile.rootId
      : state.readiness === "ready"
        ? state.candidate.client.hostId
        : "hostId" in state
          ? state.hostId
          : undefined;
    return stateRootId === rootId;
  });
  const duplicate = duplicateProfile ?? duplicateState?.target.profile;
  if (duplicate) {
    throw new Error(
      `Runtime Host profile "${duplicate.name}" is already connected to this computer; disable it before adding another connection`,
    );
  }
}

async function persistIfCurrentTarget(
  catalog: RuntimeHostProfileCatalog,
  profilePath: string,
  preferencesPath: string,
  target: ResolvedRuntimeHostProfile,
  preferences: DesktopRuntimeHostPreferences,
): Promise<void> {
  await withFileUpdateLock(profilePath, async () => {
    const current = await catalog.resolve(target.profile.id);
    if (!sameResolvedRuntimeHostProfileTarget(current, target)) {
      throw new Error("Runtime Host profile changed while it was being enabled");
    }
    await writeRuntimeHostPreferences(preferencesPath, preferences);
  });
}

function withEnabled(
  preferences: DesktopRuntimeHostPreferences,
  profileId: string,
  enabled: boolean,
): DesktopRuntimeHostPreferences {
  const ids = new Set(preferences.enabledRemoteProfileIds);
  if (enabled) ids.add(profileId);
  else ids.delete(profileId);
  return { ...preferences, enabledRemoteProfileIds: [...ids].sort() };
}

export function registerDesktopRuntimeHostProfileIpc(
  ipcMain: Pick<Electron.IpcMain, "handle" | "removeHandler">,
  service: DesktopRuntimeHostProfileService,
): () => void {
  const channels = [
    "runtime-host-profiles:getSnapshot",
    "runtime-host-profiles:add-and-enable",
    "runtime-host-profiles:import-connection-code",
    "runtime-host-profiles:set-enabled",
    "runtime-host-profiles:set-default",
    "runtime-host-profiles:remove",
    "runtime-host-profiles:resolve-pairing-recovery",
  ] as const;
  ipcMain.handle(channels[0], () => service.getSnapshot());
  ipcMain.handle(channels[1], (_event, value: DesktopRuntimeHostProfileAddInput) =>
    service.addAndEnable(value),
  );
  ipcMain.handle(channels[2], (_event, code: string) => service.importConnectionCode(code));
  ipcMain.handle(channels[3], (_event, profileId: string, enabled: boolean) =>
    service.setEnabled(profileId, enabled),
  );
  ipcMain.handle(channels[4], (_event, profileId: string) => service.setDefault(profileId));
  ipcMain.handle(channels[5], (_event, profileId: string) => service.remove(profileId));
  ipcMain.handle(channels[6], () => service.resolvePairingRecovery());
  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}

function connectionCodeImportFailure(
  error: unknown,
): Extract<DesktopRuntimeHostConnectionCodeImportResult, { kind: 'error' }>['reason'] {
  if (error instanceof RuntimeHostRemoteCompatibilityError) return 'host_mismatch';
  if (
    error instanceof RuntimeHostOperationError &&
    error.operation === 'access.credential.finalize' &&
    error.code === 'invalid_request'
  ) {
    return 'code_unavailable';
  }
  if (error instanceof RuntimeHostPermanentReconnectError) {
    if (/rejected its access credential/u.test(error.message)) return 'code_unavailable';
    if (/unexpected State Root|incompatible Host composition/u.test(error.message)) {
      return 'host_mismatch';
    }
  }
  if (error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    if (error.code === 'peer_identity_mismatch') return 'host_mismatch';
    if (
      error.code === 'direct_path_unavailable' ||
      error.code === 'coordination_unavailable' ||
      error.code === 'peer_connect_in_progress'
    ) {
      return 'host_unreachable';
    }
  }
  return 'unknown';
}

function requireSaveInput(value: unknown): asserts value is {
  readonly profile: RemoteRuntimeHostProfile;
  readonly credential?: string;
} {
  if (typeof value !== "object" || value === null || !("profile" in value)) {
    throw new Error("Runtime Host profile input is invalid");
  }
  if (
    typeof value.profile !== "object" ||
    value.profile === null ||
    !("id" in value.profile) ||
    typeof value.profile.id !== "string"
  ) {
    throw new Error("Runtime Host profile input is invalid");
  }
  if (
    "credential" in value &&
    value.credential !== undefined &&
    (typeof value.credential !== "string" ||
      Buffer.byteLength(value.credential, "utf8") > RUNTIME_HOST_ACCESS_CREDENTIAL_MAX_BYTES)
  ) {
    throw new Error("Runtime Host credential input is invalid");
  }
}

async function readRuntimeHostPreferences(path: string): Promise<DesktopRuntimeHostPreferences> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultPreferences();
    if (!(error instanceof SyntaxError)) throw error;
    console.error("[runtime-host] preferences are invalid; using Local defaults");
    return defaultPreferences();
  }
  if (isLegacySelection(value)) {
    const migrated = {
      schemaVersion: PREFERENCES_SCHEMA_VERSION,
      defaultProfileId: value.profileId,
      enabledRemoteProfileIds:
        value.profileId === LOCAL_RUNTIME_HOST_PROFILE.id ? [] : [value.profileId],
    } as const;
    await writeRuntimeHostPreferences(path, migrated);
    return migrated;
  }
  if (!isRuntimeHostPreferences(value)) {
    console.error("[runtime-host] preferences are invalid; using Local defaults");
    return defaultPreferences();
  }
  return value;
}

function isLegacySelection(value: unknown): value is { schemaVersion: 1; profileId: string } {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { schemaVersion?: unknown }).schemaVersion === 1 &&
    typeof (value as { profileId?: unknown }).profileId === "string",
  );
}

function isRuntimeHostPreferences(value: unknown): value is DesktopRuntimeHostPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Partial<DesktopRuntimeHostPreferences>;
  return (
    input.schemaVersion === PREFERENCES_SCHEMA_VERSION &&
    typeof input.defaultProfileId === "string" &&
    Array.isArray(input.enabledRemoteProfileIds) &&
    input.enabledRemoteProfileIds.every(
      (profileId) => typeof profileId === "string" && profileId !== LOCAL_RUNTIME_HOST_PROFILE.id,
    ) &&
    new Set(input.enabledRemoteProfileIds).size === input.enabledRemoteProfileIds.length
  );
}

function defaultPreferences(): DesktopRuntimeHostPreferences {
  return {
    schemaVersion: PREFERENCES_SCHEMA_VERSION,
    defaultProfileId: LOCAL_RUNTIME_HOST_PROFILE.id,
    enabledRemoteProfileIds: [],
  };
}

async function writeRuntimeHostPreferences(
  path: string,
  preferences: DesktopRuntimeHostPreferences,
): Promise<void> {
  const temporaryPath = join(dirname(path), `.runtime-host-preferences-${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(preferences, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
