import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createClientRuntimeHostProfileCatalog,
  LOCAL_RUNTIME_HOST_PROFILE,
  RUNTIME_HOST_ACCESS_CREDENTIAL_MAX_BYTES,
  sameResolvedRuntimeHostProfileTarget,
  type RemoteRuntimeHostProfile,
  type ResolvedRuntimeHostProfile,
  type RuntimeHostProfileCatalog,
} from "@maka/runtime-host/client";
import { withFileUpdateLock } from "@maka/storage/file-update-lock";
import type {
  DesktopRuntimeHostProfileAddInput,
  DesktopRuntimeHostProfileAddResult,
  DesktopRuntimeHostProfileEntry,
  DesktopRuntimeHostProfileSnapshot,
} from "../preload/bridge-contract.js";
import type { RuntimeHostDesktopTargetState } from "./runtime-host-desktop-manager.js";

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
  readonly remotes: readonly ResolvedRuntimeHostProfile[];
  readonly unavailable: ReadonlyMap<string, Error>;
}

export interface DesktopRuntimeHostProfileService {
  getSnapshot(): Promise<DesktopRuntimeHostProfileSnapshot>;
  addAndEnable(
    input: DesktopRuntimeHostProfileAddInput,
  ): Promise<DesktopRuntimeHostProfileAddResult>;
  setEnabled(profileId: string, enabled: boolean): Promise<DesktopRuntimeHostProfileSnapshot>;
  setDefault(profileId: string): Promise<DesktopRuntimeHostProfileSnapshot>;
  remove(profileId: string): Promise<DesktopRuntimeHostProfileSnapshot>;
}

export async function resolveDesktopRuntimeHostStartup(
  clientDataRoot: string,
  overrides: {
    catalog?: RuntimeHostProfileCatalog;
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
  const catalog = overrides.catalog ?? createClientRuntimeHostProfileCatalog(clientDataRoot);
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
    remotes,
    unavailable,
  };
}

export function createDesktopRuntimeHostProfileService(input: {
  readonly clientDataRoot: string;
  readonly startup: DesktopRuntimeHostStartup;
  readonly states: () => readonly RuntimeHostDesktopTargetState[];
  readonly enable: (target: ResolvedRuntimeHostProfile) => Promise<void>;
  readonly disable: (profileId: string) => Promise<void>;
  readonly setDefault: (profileId: string) => void;
  readonly catalog?: RuntimeHostProfileCatalog;
}): DesktopRuntimeHostProfileService {
  const catalog = input.catalog ?? createClientRuntimeHostProfileCatalog(input.clientDataRoot);
  const preferencesPath = join(input.clientDataRoot, PREFERENCES_FILE);
  const profilePath = join(input.clientDataRoot, PROFILE_FILE);
  let preferences = input.startup.preferences;
  const unavailable = new Map(input.startup.unavailable);
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
      return operation();
    });

  const snapshot = async (): Promise<DesktopRuntimeHostProfileSnapshot> => {
    const document = await catalog.read();
    const profiles = [LOCAL_RUNTIME_HOST_PROFILE, ...document.profiles];
    const states = new Map(input.states().map((state) => [state.target.profile.id, state]));
    const enabled = new Set(preferences.enabledRemoteProfileIds);
    return {
      defaultProfileId: preferences.defaultProfileId,
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

  const enable = async (profileId: string): Promise<Error | undefined> => {
    const target = await catalog.resolve(profileId);
    assertRootIsNotEnabled(target, preferences, await catalog.read(), input.states());
    const next = withEnabled(preferences, profileId, true);
    await persistIfCurrentTarget(catalog, profilePath, preferencesPath, target, next);
    preferences = next;
    try {
      await input.enable(target);
      const current = await catalog.resolve(profileId).catch(() => undefined);
      if (!current || !sameResolvedRuntimeHostProfileTarget(current, target)) {
        await input.disable(profileId);
        throw new Error("Runtime Host profile changed while it was connecting");
      }
      unavailable.delete(profileId);
      return undefined;
    } catch (error) {
      const failure = asError(error);
      unavailable.set(profileId, failure);
      return failure;
    }
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
