import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createClientRuntimeHostCredentialStore,
  createClientRuntimeHostProfileCatalog,
  LOCAL_RUNTIME_HOST_PROFILE,
  RUNTIME_HOST_ACCESS_CREDENTIAL_MAX_BYTES,
  RuntimeHostOperationError,
  RuntimeHostPermanentReconnectError,
  sameRemoteRuntimeHostProfileTarget,
  sameResolvedRuntimeHostProfileTarget,
  type RemoteRuntimeHostProfile,
  type ResolvedRuntimeHostProfile,
  type RuntimeHostProfileCatalog,
} from "@maka/runtime-host/client";
import type { CredentialStore } from "@maka/storage";
import { withFileUpdateLock } from "@maka/storage/file-update-lock";
import type {
  DesktopRuntimeHostProfileAddInput,
  DesktopRuntimeHostProfileAddResult,
  DesktopRuntimeHostProfileEntry,
  DesktopRuntimeHostProfileSnapshot,
} from "../preload/bridge-contract.js";
import {
  RuntimeHostPairingFinalizationInterruptedError,
  type RuntimeHostDesktopTargetState,
} from "./runtime-host-desktop-manager.js";
import {
  createDesktopRuntimeHostPairingIntent,
  pairingIntentMatchesTarget,
  readDesktopRuntimeHostPairingIntent,
  writeDesktopRuntimeHostPairingIntent,
  type DesktopRuntimeHostPairingIntent,
} from "./runtime-host-pairing-journal.js";

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
  readonly pairingIntent?: DesktopRuntimeHostPairingIntent;
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
    input: DesktopRuntimeHostProfileAddInput & { readonly credential: string },
  ): Promise<{ readonly profileId: string }>;
  startEnabledProfiles(): Promise<void>;
  discardPairingRecovery(): Promise<DesktopRuntimeHostProfileSnapshot>;
  setEnabled(profileId: string, enabled: boolean): Promise<DesktopRuntimeHostProfileSnapshot>;
  setDefault(profileId: string): Promise<DesktopRuntimeHostProfileSnapshot>;
  remove(profileId: string): Promise<DesktopRuntimeHostProfileSnapshot>;
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
  let pairingIntent: DesktopRuntimeHostPairingIntent | undefined;
  let pairingReadFailure: Error | undefined;
  const credentialStore =
    overrides.credentialStore ?? createClientRuntimeHostCredentialStore(clientDataRoot);
  try {
    pairingIntent = await readDesktopRuntimeHostPairingIntent(credentialStore);
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
      ...(pairingIntent ? { pairingIntent } : {}),
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
    ...(pairingIntent ? { pairingIntent } : {}),
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
}): DesktopRuntimeHostProfileService {
  const credentialStore =
    input.credentialStore ?? createClientRuntimeHostCredentialStore(input.clientDataRoot);
  const catalog =
    input.catalog ?? createClientRuntimeHostProfileCatalog(input.clientDataRoot, credentialStore);
  const preferencesPath = join(input.clientDataRoot, PREFERENCES_FILE);
  const profilePath = join(input.clientDataRoot, PROFILE_FILE);
  let preferences = input.startup.preferences;
  const unavailable = new Map(input.startup.unavailable);
  let pairingIntent = input.startup.pairingIntent;
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

  const mutateProfiles = <T>(operation: () => Promise<T>): Promise<T> =>
    mutate(async () => {
      // The Local fallback is effective startup state, not a replacement for
      // preferences whose durable value is unknown.
      if (input.startup.preferencesReadFailure) {
        throw new Error(
          "Saved Runtime Host settings could not be read; restart Maka before changing them",
          { cause: input.startup.preferencesReadFailure },
        );
      }
      if (pairingReadFailure) {
        throw new Error(
          "Discard the unreadable Runtime Host pairing recovery state before changing profiles",
          { cause: pairingReadFailure },
        );
      }
      return operation();
    });

  const persistPairingIntent = async (
    next: DesktopRuntimeHostPairingIntent | undefined,
  ): Promise<void> => {
    await writeDesktopRuntimeHostPairingIntent(credentialStore, next);
    pairingIntent = next;
  };

  const beginPairingIntent = async (intent: DesktopRuntimeHostPairingIntent): Promise<void> => {
    if (pairingIntent) throw new Error("Another Runtime Host has an unfinished pairing recovery");
    await persistPairingIntent(intent);
  };

  const snapshot = async (): Promise<DesktopRuntimeHostProfileSnapshot> => {
    const document = await catalog.read();
    const profiles = [LOCAL_RUNTIME_HOST_PROFILE, ...document.profiles];
    const states = new Map(input.states().map((state) => [state.target.profile.id, state]));
    const enabled = new Set(preferences.enabledRemoteProfileIds);
    return {
      defaultProfileId: preferences.defaultProfileId,
      ...(pairingReadFailure ? { pairingRecoveryBlocked: true as const } : {}),
      entries: profiles.map((profile): DesktopRuntimeHostProfileEntry => {
        const isEnabled = profile.kind === "local" || enabled.has(profile.id);
        const state = states.get(profile.id);
        const error = state?.readiness === "unavailable"
          ? state.error
          : unavailable.get(profile.id);
        return {
          profile,
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

  const clearPairingIntentBestEffort = async (): Promise<void> => {
    await persistPairingIntent(undefined).catch((error) =>
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

  const activateTarget = async (
    target: ResolvedRuntimeHostProfile,
    sshInteraction: "terminal" | "batch",
  ): Promise<void> => {
    try {
      await input.enable(target, sshInteraction);
      const current = await catalog.resolve(target.profile.id).catch(() => undefined);
      if (!current || !sameResolvedRuntimeHostProfileTarget(current, target)) {
        await input.disable(target.profile.id);
        throw new Error("Runtime Host profile changed while it was connecting");
      }
      unavailable.delete(target.profile.id);
    } catch (error) {
      const failure = asError(error);
      unavailable.set(target.profile.id, failure);
      throw failure;
    }
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
    await clearPairingIntentBestEffort();
  };

  const rollbackPairingIntent = async (
    intent: DesktopRuntimeHostPairingIntent,
    failure: unknown,
  ): Promise<void> => {
    const current = await catalog.resolve(intent.target.profile.id).catch(() => undefined);
    if (!current || !pairingIntentMatchesTarget(intent.target, current)) {
      await clearPairingIntentBestEffort();
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
      await catalog.removeIfCurrent(current).then(
        (result) => {
          if (!result.removed) {
            rollbackFailures.push(
              new Error("Runtime Host profile changed during pairing rollback"),
            );
          }
        },
        (error) => rollbackFailures.push(error),
      );
    }
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [failure, ...rollbackFailures],
        "Runtime Host pairing failed and its previous profile could not be restored",
      );
    }
    unavailable.delete(current.profile.id);
    await clearPairingIntentBestEffort();
  };

  const recoverPairingIntent = async (
    intent: DesktopRuntimeHostPairingIntent,
  ): Promise<Error | undefined> => {
    const current = await catalog.resolve(intent.target.profile.id).catch(() => undefined);
    if (!current || !pairingIntentMatchesTarget(intent.target, current)) {
      await clearPairingIntentBestEffort();
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
    if (pairingIntent?.target.profile.id === profileId) {
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

  const recoverPendingPairing = (): Promise<void> =>
    mutateProfiles(async () => {
      if (pairingIntent) await recoverPairingIntent(pairingIntent);
    });

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
    addAndEnableVerified(value) {
      requireSaveInput(value);
      return mutateProfiles(async () => {
        const currentDocument = await catalog.read();
        const existing = currentDocument.profiles.find(
          (profile) => profile.rootId === value.profile.rootId,
        );
        if (existing && !sameRemoteRuntimeHostProfileTarget(existing, value.profile)) {
          throw new Error(
            "This Runtime Host is already configured through another connection",
          );
        }
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
    },
    startEnabledProfiles() {
      const tasks: Promise<unknown>[] = [];
      if (!pairingReadFailure && pairingIntent) {
        tasks.push(
          recoverPendingPairing().catch((error) =>
            console.error("[runtime-host] pairing recovery failed:", error),
          ),
        );
      }
      for (const target of input.startup.remotes) {
        if (target.profile.kind !== "remote" || !target.credential) continue;
        if (pairingIntent?.target.profile.id === target.profile.id) continue;
        const sshInteraction =
          target.profile.transport.kind === "ssh" &&
          target.profile.id === preferences.defaultProfileId
            ? "terminal"
            : "batch";
        tasks.push(
          activateTarget(target, sshInteraction).catch((error) =>
            console.error(`[runtime-host] ${target.profile.name} is unavailable:`, error),
          ),
        );
      }
      return Promise.all(tasks).then(() => undefined);
    },
    discardPairingRecovery() {
      return mutate(async () => {
        if (!pairingReadFailure) return snapshot();
        await writeDesktopRuntimeHostPairingIntent(credentialStore, undefined);
        pairingReadFailure = undefined;
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
        if (preferences.enabledRemoteProfileIds.includes(profileId)) {
          throw new Error("Disable a Runtime Host before removing it");
        }
        if (preferences.defaultProfileId === profileId) {
          throw new Error("Choose another default Runtime Host before removing this one");
        }
        await catalog.remove(profileId);
        unavailable.delete(profileId);
        return snapshot();
      });
    },
  };
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
  if (duplicateProfile || duplicateState) {
    throw new Error(`Runtime Host ${rootId} is already enabled`);
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
    "runtime-host-profiles:set-enabled",
    "runtime-host-profiles:set-default",
    "runtime-host-profiles:remove",
    "runtime-host-profiles:discard-pairing-recovery",
  ] as const;
  ipcMain.handle(channels[0], () => service.getSnapshot());
  ipcMain.handle(channels[1], (_event, value: DesktopRuntimeHostProfileAddInput) =>
    service.addAndEnable(value),
  );
  ipcMain.handle(channels[2], (_event, profileId: string, enabled: boolean) =>
    service.setEnabled(profileId, enabled),
  );
  ipcMain.handle(channels[3], (_event, profileId: string) => service.setDefault(profileId));
  ipcMain.handle(channels[4], (_event, profileId: string) => service.remove(profileId));
  ipcMain.handle(channels[5], () => service.discardPairingRecovery());
  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
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
