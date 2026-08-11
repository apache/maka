import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createClientRuntimeHostProfileCatalog,
  LOCAL_RUNTIME_HOST_PROFILE,
  type RemoteRuntimeHostProfile,
  type ResolvedRuntimeHostProfile,
  type RuntimeHostProfileCatalog,
} from "@maka/runtime-host/client";
import type {
  DesktopRuntimeHostProfileSaveInput,
  DesktopRuntimeHostProfileSnapshot,
} from "../preload/bridge-contract.js";

const SELECTION_SCHEMA_VERSION = 1;
const SELECTION_FILE = "runtime-host-profile-selection.json";

export interface DesktopRuntimeHostProfileService {
  getSnapshot(): Promise<DesktopRuntimeHostProfileSnapshot>;
  save(input: DesktopRuntimeHostProfileSaveInput): Promise<DesktopRuntimeHostProfileSnapshot>;
  remove(profileId: string): Promise<DesktopRuntimeHostProfileSnapshot>;
  select(profileId: string): Promise<DesktopRuntimeHostProfileSnapshot>;
}

export interface DesktopRuntimeHostStartupSelection {
  readonly target: ResolvedRuntimeHostProfile;
  readonly recoveryError?: Error;
}

export async function resolveSelectedDesktopRuntimeHostProfile(
  clientDataRoot: string,
  overrides: {
    catalog?: RuntimeHostProfileCatalog;
    readSelection?: () => Promise<string>;
    writeSelection?: (profileId: string) => Promise<void>;
  } = {},
): Promise<DesktopRuntimeHostStartupSelection> {
  const selectionPath = join(clientDataRoot, SELECTION_FILE);
  const catalog = overrides.catalog ?? createClientRuntimeHostProfileCatalog(clientDataRoot);
  try {
    const selectedProfileId = await (overrides.readSelection?.() ??
      readSelectedProfileId(selectionPath));
    return { target: await catalog.resolve(selectedProfileId) };
  } catch (error) {
    let recoveryError = asError(error);
    try {
      await (overrides.writeSelection?.(LOCAL_RUNTIME_HOST_PROFILE.id) ??
        writeSelectedProfileId(selectionPath, LOCAL_RUNTIME_HOST_PROFILE.id));
    } catch (resetError) {
      recoveryError = new AggregateError(
        [recoveryError, resetError],
        "Runtime Host selection is invalid and could not be reset",
      );
    }
    return {
      target: { profile: LOCAL_RUNTIME_HOST_PROFILE },
      recoveryError,
    };
  }
}

export function createDesktopRuntimeHostProfileService(input: {
  readonly clientDataRoot: string;
  readonly activeTarget: ResolvedRuntimeHostProfile;
  readonly activate: (target: ResolvedRuntimeHostProfile) => Promise<void>;
  readonly onTargetChanged?: (target: ResolvedRuntimeHostProfile) => void;
  readonly writeSelection?: (profileId: string) => Promise<void>;
  readonly catalog?: RuntimeHostProfileCatalog;
}): DesktopRuntimeHostProfileService {
  const catalog = input.catalog ?? createClientRuntimeHostProfileCatalog(input.clientDataRoot);
  const selectionPath = join(input.clientDataRoot, SELECTION_FILE);
  let activeTarget = input.activeTarget;
  let mutationTail: Promise<void> = Promise.resolve();

  const snapshot = async (): Promise<DesktopRuntimeHostProfileSnapshot> => {
    const document = await catalog.read();
    const remoteProfiles = [...document.profiles];
    if (activeTarget.profile.kind === "remote") {
      const index = remoteProfiles.findIndex(
        (profile) => profile.id === activeTarget.profile.id,
      );
      if (index === -1) remoteProfiles.push(activeTarget.profile);
      else remoteProfiles[index] = activeTarget.profile;
    }
    return {
      profiles: [LOCAL_RUNTIME_HOST_PROFILE, ...remoteProfiles],
      activeProfileId: activeTarget.profile.id,
    };
  };

  const selectProfile = async (
    profileId: string,
  ): Promise<DesktopRuntimeHostProfileSnapshot> => {
    const target = await catalog.resolve(profileId);
    if (sameRuntimeHostTarget(target, activeTarget)) {
      await persistSelection(profileId);
      activeTarget = target;
      return snapshot();
    }
    const previous = activeTarget;
    await input.activate(target);
    try {
      await persistSelection(profileId);
    } catch (selectionError) {
      try {
        await input.activate(previous);
      } catch (rollbackError) {
        throw new AggregateError(
          [selectionError, rollbackError],
          "Runtime Host switched, but its selection could not be saved or restored",
        );
      }
      throw selectionError;
    }
    activeTarget = target;
    input.onTargetChanged?.(target);
    return snapshot();
  };

  const persistSelection = (profileId: string): Promise<void> =>
    input.writeSelection?.(profileId) ?? writeSelectedProfileId(selectionPath, profileId);

  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = mutationTail.then(operation);
    mutationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };

  return {
    async getSnapshot() {
      await mutationTail;
      return snapshot();
    },
    save(value) {
      requireSaveInput(value);
      return mutate(async () => {
        if (value.profile.id === activeTarget.profile.id) {
          throw new Error("Switch away from an active Runtime Host profile before changing it");
        }
        await catalog.save(value.profile, value.credential);
        return snapshot();
      });
    },
    remove(profileId) {
      return mutate(async () => {
        if (profileId === activeTarget.profile.id) {
          throw new Error("The active Runtime Host profile cannot be removed");
        }
        await catalog.remove(profileId);
        const selectedProfileId = await readSelectedProfileId(selectionPath);
        if (selectedProfileId === profileId) {
          await writeSelectedProfileId(selectionPath, LOCAL_RUNTIME_HOST_PROFILE.id);
        }
        return snapshot();
      });
    },
    select(profileId) {
      return mutate(() => selectProfile(profileId));
    },
  };
}

function sameRuntimeHostTarget(
  left: ResolvedRuntimeHostProfile,
  right: ResolvedRuntimeHostProfile,
): boolean {
  if (left.profile.kind !== right.profile.kind) return false;
  if (left.profile.kind === "local" || right.profile.kind === "local") return true;
  return (
    left.profile.id === right.profile.id &&
    left.profile.url === right.profile.url &&
    left.profile.rootId === right.profile.rootId &&
    left.credential === right.credential
  );
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function registerDesktopRuntimeHostProfileIpc(
  ipcMain: Pick<Electron.IpcMain, "handle" | "removeHandler">,
  service: DesktopRuntimeHostProfileService,
): () => void {
  const channels = [
    "runtime-host-profiles:getSnapshot",
    "runtime-host-profiles:save",
    "runtime-host-profiles:remove",
    "runtime-host-profiles:select",
  ] as const;
  ipcMain.handle(channels[0], () => service.getSnapshot());
  ipcMain.handle(channels[1], (_event, input: DesktopRuntimeHostProfileSaveInput) =>
    service.save(input),
  );
  ipcMain.handle(channels[2], (_event, profileId: string) => service.remove(profileId));
  ipcMain.handle(channels[3], (_event, profileId: string) => service.select(profileId));
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
    typeof value.credential !== "string"
  ) {
    throw new Error("Runtime Host credential input is invalid");
  }
}

async function readSelectedProfileId(path: string): Promise<string> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return LOCAL_RUNTIME_HOST_PROFILE.id;
    }
    throw new Error("Runtime Host profile selection is invalid", { cause: error });
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== SELECTION_SCHEMA_VERSION ||
    !("profileId" in value) ||
    typeof value.profileId !== "string"
  ) {
    throw new Error("Runtime Host profile selection is invalid");
  }
  return value.profileId;
}

async function writeSelectedProfileId(path: string, profileId: string): Promise<void> {
  const temporaryPath = join(
    dirname(path),
    `.runtime-host-profile-selection-${randomUUID()}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    try {
      await handle.writeFile(
        `${JSON.stringify({ schemaVersion: SELECTION_SCHEMA_VERSION, profileId }, null, 2)}\n`,
        "utf8",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
