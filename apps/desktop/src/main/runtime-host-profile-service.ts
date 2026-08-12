import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createClientRuntimeHostProfileCatalog,
  LOCAL_RUNTIME_HOST_PROFILE,
  RUNTIME_HOST_ACCESS_CREDENTIAL_MAX_BYTES,
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

export type DesktopRuntimeHostStartupSelection =
  | {
      readonly kind: "ready";
      readonly selectedProfileId: string;
      readonly target: ResolvedRuntimeHostProfile;
    }
  | {
      readonly kind: "unavailable";
      readonly selectedProfileId?: string;
      readonly error: Error;
    };

export type DesktopRuntimeHostActivationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown };

export async function resolveSelectedDesktopRuntimeHostProfile(
  clientDataRoot: string,
  overrides: {
    catalog?: RuntimeHostProfileCatalog;
    readSelection?: () => Promise<string>;
  } = {},
): Promise<DesktopRuntimeHostStartupSelection> {
  const selectionPath = join(clientDataRoot, SELECTION_FILE);
  const catalog = overrides.catalog ?? createClientRuntimeHostProfileCatalog(clientDataRoot);
  let selectedProfileId: string;
  try {
    selectedProfileId = await (overrides.readSelection?.() ??
      readSelectedProfileId(selectionPath));
  } catch (error) {
    return {
      kind: "unavailable",
      error: asError(error),
    };
  }
  try {
    return {
      kind: "ready",
      selectedProfileId,
      target: await catalog.resolve(selectedProfileId),
    };
  } catch (error) {
    return {
      kind: "unavailable",
      selectedProfileId,
      error: asError(error),
    };
  }
}

export function selectDesktopRuntimeHostProfile(
  clientDataRoot: string,
  profileId: string,
): Promise<void> {
  return writeSelectedProfileId(join(clientDataRoot, SELECTION_FILE), profileId);
}

export function createDesktopRuntimeHostProfileService(input: {
  readonly clientDataRoot: string;
  readonly selectedProfileId: string;
  readonly unavailable?: {
    readonly profileId: string;
    readonly error: Error;
  };
  readonly getActiveTarget: () => ResolvedRuntimeHostProfile | undefined;
  readonly activate: (
    target: ResolvedRuntimeHostProfile,
  ) => Promise<DesktopRuntimeHostActivationResult>;
  readonly writeSelection?: (profileId: string) => Promise<void>;
  readonly catalog?: RuntimeHostProfileCatalog;
}): DesktopRuntimeHostProfileService {
  const catalog = input.catalog ?? createClientRuntimeHostProfileCatalog(input.clientDataRoot);
  const selectionPath = join(input.clientDataRoot, SELECTION_FILE);
  let selectedProfileId = input.selectedProfileId;
  let unavailable = input.unavailable;
  let mutationTail: Promise<void> = Promise.resolve();

  const snapshot = async (): Promise<DesktopRuntimeHostProfileSnapshot> => {
    const activeTarget = input.getActiveTarget();
    const document = await catalog.read();
    const remoteProfiles = [...document.profiles];
    const activeProfileId = activeTarget && await catalog
      .resolve(activeTarget.profile.id)
      .then((resolved) =>
        sameRuntimeHostTarget(resolved, activeTarget)
          ? activeTarget.profile.id
          : undefined,
      )
      .catch(() => undefined);
    return {
      profiles: [LOCAL_RUNTIME_HOST_PROFILE, ...remoteProfiles],
      selectedProfileId,
      ...(activeTarget ? { activeProfile: activeTarget.profile } : {}),
      ...(activeProfileId ? { activeProfileId } : {}),
      ...(unavailable?.profileId === selectedProfileId
        ? {
            unavailable: {
              profileId: unavailable.profileId,
              message: unavailable.error.message,
            },
          }
        : {}),
    };
  };

  const selectProfile = async (
    profileId: string,
  ): Promise<DesktopRuntimeHostProfileSnapshot> => {
    let target: ResolvedRuntimeHostProfile;
    try {
      target = await catalog.resolve(profileId);
    } catch (error) {
      await persistSelection(profileId);
      selectedProfileId = profileId;
      unavailable = { profileId, error: asError(error) };
      return snapshot();
    }
    const activeTarget = input.getActiveTarget();
    if (activeTarget && sameRuntimeHostTarget(target, activeTarget)) {
      await persistSelection(profileId);
      selectedProfileId = profileId;
      unavailable = undefined;
      return snapshot();
    }
    const activation = await input.activate(target);
    if (!activation.ok) {
      await persistSelection(profileId);
      selectedProfileId = profileId;
      unavailable = { profileId, error: asError(activation.error) };
      return snapshot();
    }
    selectedProfileId = profileId;
    unavailable = undefined;
    try {
      await persistSelection(profileId);
    } catch (error) {
      throw new Error(
        "Runtime Host switched for this run, but the selection could not be saved",
        { cause: error },
      );
    }
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
        const activeTarget = input.getActiveTarget();
        if (value.profile.id === activeTarget?.profile.id) {
          throw new Error("Switch away from an active Runtime Host profile before changing it");
        }
        await catalog.save(value.profile, value.credential);
        return snapshot();
      });
    },
    remove(profileId) {
      return mutate(async () => {
        const activeTarget = input.getActiveTarget();
        if (profileId === activeTarget?.profile.id) {
          throw new Error("The active Runtime Host profile cannot be removed");
        }
        if (profileId === selectedProfileId) {
          throw new Error("Select another Runtime Host profile before removing this one");
        }
        await catalog.remove(profileId);
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
    left.profile.transport.kind === right.profile.transport.kind &&
    left.profile.transport.url === right.profile.transport.url &&
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
    (typeof value.credential !== "string" ||
      Buffer.byteLength(value.credential, "utf8") >
        RUNTIME_HOST_ACCESS_CREDENTIAL_MAX_BYTES)
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
