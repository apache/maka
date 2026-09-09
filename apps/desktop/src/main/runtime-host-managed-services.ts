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

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  decodePersistedRuntimeHostProfile,
  migrateRuntimeHostProfileOperatorCommand,
  sameEnvironmentRuntimeHostDeployment,
  sameResolvedRuntimeHostProfileTarget,
  type EnvironmentRuntimeHostProfile,
  type PersistedRuntimeHostProfile,
  type RemoteRuntimeHostProfile,
  type RuntimeHostRemoteTransport,
} from "@maka/runtime-host/client";
import { requireHostRootId } from "@maka/runtime-host/protocol";
import {
  createRuntimeHostLegacyPosixOperatorCommand,
  decodeRuntimeHostOperatorCommand,
  type RuntimeHostOperatorCommand,
} from "@maka/runtime-host/operator";
import { withFileUpdateLock } from "@maka/storage/file-update-lock";
import { syncDirectory } from "@maka/storage/stable-storage";

const SCHEMA_VERSION = 2;
const DOCUMENT_MAX_BYTES = 256 * 1024;
const BINDING_COUNT_MAX = 32;
const PATH_MAX_BYTES = 4 * 1024;

export interface DesktopRuntimeHostDeploymentBinding {
  readonly id: string;
  readonly rootPath: string;
  readonly deploymentId?: string;
}

type ManagedSshRuntimeHostProfile = RemoteRuntimeHostProfile & {
  readonly transport: Extract<RuntimeHostRemoteTransport, { readonly kind: "ssh" }>;
};

interface DesktopRuntimeHostSshControlRoute {
  readonly kind: "ssh_operator";
  readonly operator: RuntimeHostOperatorCommand;
}

interface DesktopRuntimeHostManagedServiceTargetBase {
  readonly deployment: DesktopRuntimeHostDeploymentBinding;
}

export interface DesktopRuntimeHostManagedSshServiceTarget
  extends DesktopRuntimeHostManagedServiceTargetBase {
  readonly control: DesktopRuntimeHostSshControlRoute;
}

export type DesktopRuntimeHostManagedWslServiceTarget =
  DesktopRuntimeHostManagedServiceTargetBase;

type DesktopRuntimeHostManagedServiceTarget =
  | DesktopRuntimeHostManagedSshServiceTarget
  | DesktopRuntimeHostManagedWslServiceTarget;

interface DesktopRuntimeHostManagedServiceBindingBase {
  readonly deployment: DesktopRuntimeHostDeploymentBinding;
}

export type DesktopRuntimeHostManagedSshServiceBinding =
  DesktopRuntimeHostManagedServiceBindingBase & {
    readonly profile: ManagedSshRuntimeHostProfile;
    readonly control: DesktopRuntimeHostSshControlRoute;
    readonly state: "active" | "uninstalling" | "cleanup_pending";
  };

export type DesktopRuntimeHostManagedServiceBinding =
  | DesktopRuntimeHostManagedSshServiceBinding
  | (DesktopRuntimeHostManagedServiceBindingBase & {
      readonly profile: EnvironmentRuntimeHostProfile;
      readonly state: "active";
    });

export function isDesktopRuntimeHostManagedSshProfile(
  profile: PersistedRuntimeHostProfile,
): profile is ManagedSshRuntimeHostProfile {
  return profile.kind === "remote" && profile.transport.kind === "ssh";
}

export function isDesktopRuntimeHostManagedSshServiceBinding(
  binding: DesktopRuntimeHostManagedServiceBinding,
): binding is DesktopRuntimeHostManagedSshServiceBinding {
  return binding.profile.kind === "remote";
}

type DesktopRuntimeHostManagedServiceBindingInput =
  | {
      readonly profile: ManagedSshRuntimeHostProfile;
      readonly deployment: DesktopRuntimeHostDeploymentBinding;
      readonly control: DesktopRuntimeHostSshControlRoute;
    }
  | {
      readonly profile: EnvironmentRuntimeHostProfile;
      readonly deployment: DesktopRuntimeHostDeploymentBinding;
    };

export interface DesktopRuntimeHostManagedServiceDocument {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly bindings: readonly DesktopRuntimeHostManagedServiceBinding[];
}

export interface DesktopRuntimeHostManagedServiceStore {
  read(): Promise<DesktopRuntimeHostManagedServiceDocument>;
  save(
    profile: ManagedSshRuntimeHostProfile,
    target: DesktopRuntimeHostManagedSshServiceTarget,
  ): Promise<void>;
  save(
    profile: EnvironmentRuntimeHostProfile,
    target: DesktopRuntimeHostManagedWslServiceTarget,
  ): Promise<void>;
  removeIfCurrent(
    binding: DesktopRuntimeHostManagedServiceBinding,
  ): Promise<boolean>;
  removeForProfileIfCurrent(
    profile: PersistedRuntimeHostProfile,
  ): Promise<boolean>;
  markUninstallingIfCurrent(
    binding: DesktopRuntimeHostManagedSshServiceBinding,
  ): Promise<boolean>;
  markCleanupPendingIfCurrent(
    binding: DesktopRuntimeHostManagedSshServiceBinding,
  ): Promise<boolean>;
  removeCleanupPendingIfCurrent(
    binding: DesktopRuntimeHostManagedSshServiceBinding,
  ): Promise<boolean>;
}

export function createDesktopRuntimeHostManagedServiceStore(
  clientDataRoot: string,
): DesktopRuntimeHostManagedServiceStore {
  return new FileDesktopRuntimeHostManagedServiceStore(
    join(clientDataRoot, "runtime-host-deployments.json"),
    join(clientDataRoot, "runtime-host-managed-services.json"),
  );
}

export function findDesktopRuntimeHostManagedServiceBinding(
  document: DesktopRuntimeHostManagedServiceDocument,
  profile: PersistedRuntimeHostProfile,
): DesktopRuntimeHostManagedServiceBinding | undefined {
  const binding = document.bindings.find(
    (candidate) => candidate.profile.id === profile.id,
  );
  if (!binding || !sameManagedProfileTarget(binding.profile, profile)) return undefined;
  // The profile catalog owns a WSL control route. The deployment binding owns only
  // its stable environment identity, so a crash between their writes cannot hide it.
  if (binding.profile.kind === "environment" && profile.kind === "environment") {
    return { profile, deployment: binding.deployment, state: "active" };
  }
  return binding;
}

export function sameDesktopRuntimeHostManagedServiceBinding(
  left: DesktopRuntimeHostManagedServiceBinding,
  right: DesktopRuntimeHostManagedServiceBinding,
): boolean {
  return (
    left.state === right.state &&
    left.profile.id === right.profile.id &&
    sameManagedProfileTarget(left.profile, right.profile) &&
    sameBindingTarget(left, right)
  );
}

class FileDesktopRuntimeHostManagedServiceStore implements DesktopRuntimeHostManagedServiceStore {
  readonly #path: string;
  readonly #legacyPath: string;

  constructor(path: string, legacyPath: string) {
    this.#path = path;
    this.#legacyPath = legacyPath;
  }

  async read(): Promise<DesktopRuntimeHostManagedServiceDocument> {
    return this.#exclusive(() => this.#readUnlocked());
  }

  async #readUnlocked(): Promise<DesktopRuntimeHostManagedServiceDocument> {
    let contents: string;
    try {
      contents = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        contents = await readFile(this.#legacyPath, "utf8");
      } catch (legacyError) {
        if ((legacyError as NodeJS.ErrnoException).code === "ENOENT") return emptyDocument();
        throw legacyError;
      }
      const migrated = decodeLegacyDocument(JSON.parse(contents));
      await writeDocument(this.#path, migrated);
      await removeLegacyDocument(this.#legacyPath);
      return migrated;
    }
    if (Buffer.byteLength(contents, "utf8") > DOCUMENT_MAX_BYTES) {
      throw new Error("Runtime Host managed service document is too large");
    }
    const value: unknown = JSON.parse(contents);
    const migrated = decodeDocument(value);
    if ((value as { readonly schemaVersion?: unknown }).schemaVersion === 1) {
      await writeDocument(this.#path, migrated);
    }
    await removeLegacyDocument(this.#legacyPath);
    return migrated;
  }

  save(
    profile: ManagedSshRuntimeHostProfile,
    target: DesktopRuntimeHostManagedSshServiceTarget,
  ): Promise<void>;
  save(
    profile: EnvironmentRuntimeHostProfile,
    target: DesktopRuntimeHostManagedWslServiceTarget,
  ): Promise<void>;
  save(
    profile: ManagedSshRuntimeHostProfile | EnvironmentRuntimeHostProfile,
    target: DesktopRuntimeHostManagedServiceTarget,
  ): Promise<void> {
    const binding = decodeBinding(
      { profile, ...target },
      "Runtime Host managed service binding",
    );
    const bindingProfile = binding.profile;
    return this.#exclusive(async () => {
      const current = await this.#readUnlocked();
      const bindings = current.bindings.filter(
        (binding) => binding.profile.id !== bindingProfile.id,
      );
      if (
        bindings.some(
          (binding) =>
            binding.profile.rootId === bindingProfile.rootId &&
            (bindingProfile.kind === "environment" ||
              binding.profile.kind === "environment"),
        )
      ) {
        throw new Error(
          "A managed Runtime Host deployment is already bound to another profile",
        );
      }
      if (bindings.length >= BINDING_COUNT_MAX) {
        throw new Error(
          "Too many managed Runtime Host services are configured",
        );
      }
      await writeDocument(this.#path, {
        schemaVersion: SCHEMA_VERSION,
        bindings: [
          ...bindings,
          {
            ...binding,
            state: "active",
          },
        ],
      });
    });
  }

  markUninstallingIfCurrent(
    binding: DesktopRuntimeHostManagedSshServiceBinding,
  ): Promise<boolean> {
    return this.#setStateIfCurrent(
      binding,
      ["active", "uninstalling"],
      "uninstalling",
    );
  }

  markCleanupPendingIfCurrent(
    binding: DesktopRuntimeHostManagedSshServiceBinding,
  ): Promise<boolean> {
    return this.#setStateIfCurrent(
      binding,
      ["uninstalling", "cleanup_pending"],
      "cleanup_pending",
    );
  }

  removeCleanupPendingIfCurrent(
    binding: DesktopRuntimeHostManagedSshServiceBinding,
  ): Promise<boolean> {
    return this.#remove(binding, "cleanup_pending");
  }

  removeIfCurrent(binding: DesktopRuntimeHostManagedServiceBinding): Promise<boolean> {
    return this.#remove(binding);
  }

  removeForProfileIfCurrent(value: PersistedRuntimeHostProfile): Promise<boolean> {
    return this.#remove(undefined, undefined, decodePersistedRuntimeHostProfile(value));
  }

  #remove(
    expected?: DesktopRuntimeHostManagedServiceBinding,
    state?: DesktopRuntimeHostManagedServiceBinding["state"],
    profileOverride?: PersistedRuntimeHostProfile,
  ): Promise<boolean> {
    const profile = expected?.profile ?? profileOverride!;
    return this.#exclusive(async () => {
      const current = await this.#readUnlocked();
      const binding = current.bindings.find(
        (candidate) => candidate.profile.id === profile.id,
      );
      if (
        !binding ||
        !sameManagedProfileTarget(binding.profile, profile) ||
        (expected && !sameBindingTarget(binding, expected)) ||
        (state && binding.state !== state)
      ) {
        return false;
      }
      await writeDocument(this.#path, {
        schemaVersion: SCHEMA_VERSION,
        bindings: current.bindings.filter(
          (candidate) => candidate.profile.id !== profile.id,
        ),
      });
      return true;
    });
  }

  #setStateIfCurrent(
    expected: DesktopRuntimeHostManagedSshServiceBinding,
    allowedStates: readonly DesktopRuntimeHostManagedSshServiceBinding["state"][],
    state: DesktopRuntimeHostManagedSshServiceBinding["state"],
  ): Promise<boolean> {
    const profile = expected.profile;
    return this.#exclusive(async () => {
      const current = await this.#readUnlocked();
      const binding = current.bindings.find(
        (candidate) => candidate.profile.id === profile.id,
      );
      if (
        !binding ||
        !isDesktopRuntimeHostManagedSshServiceBinding(binding) ||
        !sameManagedProfileTarget(binding.profile, profile) ||
        !sameBindingTarget(binding, expected) ||
        !allowedStates.includes(binding.state)
      ) {
        return false;
      }
      if (binding.state === state) return true;
      await writeDocument(this.#path, {
        schemaVersion: SCHEMA_VERSION,
        bindings: current.bindings.map((candidate) =>
          candidate === binding ? { ...candidate, state } : candidate,
        ),
      });
      return true;
    });
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    return withFileUpdateLock(this.#path, operation);
  }
}

function decodeDocument(
  value: unknown,
): DesktopRuntimeHostManagedServiceDocument {
  const record = requireExactRecord(
    value,
    "Runtime Host managed service document",
    ["schemaVersion", "bindings"],
  );
  if (!Array.isArray(record.bindings)) {
    throw new Error("Runtime Host managed service document is invalid");
  }
  if (record.schemaVersion === 1) return migrateVersionOneDocument(record.bindings);
  if (record.schemaVersion !== SCHEMA_VERSION) {
    throw new Error("Runtime Host managed service document is invalid");
  }
  if (record.bindings.length > BINDING_COUNT_MAX) {
    throw new Error(
      "Runtime Host managed service document has too many bindings",
    );
  }
  const bindings = record.bindings.map((candidate) => {
    const candidateProfile = decodePersistedRuntimeHostProfile(
      (candidate as { readonly profile?: unknown } | null)?.profile,
    );
    const binding = requireExactRecord(
      candidate,
      "Runtime Host managed service binding",
      candidateProfile.kind === "environment"
        ? ["deployment", "profile", "state"]
        : ["control", "deployment", "profile", "state"],
    );
    if (
      binding.state !== "active" &&
      binding.state !== "uninstalling" &&
      binding.state !== "cleanup_pending"
    ) {
      throw new Error("Runtime Host managed service state is invalid");
    }
    const decoded = decodeBinding(
      binding,
      "Runtime Host managed service binding",
    );
    if (!("control" in decoded)) {
      if (binding.state !== "active") {
        throw new Error("Managed WSL Runtime Host binding state is invalid");
      }
      return Object.freeze({
        profile: decoded.profile,
        deployment: decoded.deployment,
        state: "active" as const,
      });
    }
    return Object.freeze({
      profile: decoded.profile,
      deployment: decoded.deployment,
      control: decoded.control,
      state: binding.state,
    });
  });
  if (
    new Set(bindings.map((binding) => binding.profile.id)).size !==
    bindings.length
  ) {
    throw new Error(
      "Runtime Host managed service bindings must have unique profile IDs",
    );
  }
  const bindingCountByRootId = new Map<string, number>();
  for (const binding of bindings) {
    bindingCountByRootId.set(
      binding.profile.rootId,
      (bindingCountByRootId.get(binding.profile.rootId) ?? 0) + 1,
    );
  }
  if (
    bindings.some(
      (binding) =>
        binding.profile.kind === "environment" &&
        bindingCountByRootId.get(binding.profile.rootId)! > 1,
    )
  ) {
    throw new Error(
      "Managed WSL Runtime Host State Roots cannot have another deployment binding",
    );
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    bindings: Object.freeze(bindings),
  });
}

function migrateVersionOneDocument(bindings: unknown[]): DesktopRuntimeHostManagedServiceDocument {
  return decodeDocument({
    schemaVersion: SCHEMA_VERSION,
    bindings: bindings.map((candidate) => {
      const profile = migrateRuntimeHostProfileOperatorCommand(
        (candidate as { readonly profile?: unknown } | null)?.profile,
      );
      const decodedProfile = decodePersistedRuntimeHostProfile(profile);
      const binding = requireExactRecord(
        candidate,
        "Runtime Host managed service binding",
        decodedProfile.kind === "environment"
          ? ["deployment", "profile", "state"]
          : ["control", "deployment", "profile", "state"],
      );
      if (decodedProfile.kind === "environment") return { ...binding, profile };
      const control = requireExactRecord(binding.control, "Managed Runtime Host control route", [
        "kind",
        "operatorPath",
      ]);
      if (control.kind !== "ssh_operator") {
        throw new Error("Managed Runtime Host control route is invalid");
      }
      return {
        ...binding,
        profile,
        control: {
          kind: "ssh_operator",
          operator: createRuntimeHostLegacyPosixOperatorCommand(
            requirePosixOperatorPath(control.operatorPath),
          ),
        },
      };
    }),
  });
}

function decodeLegacyDocument(value: unknown): DesktopRuntimeHostManagedServiceDocument {
  const record = requireExactRecord(value, "Legacy Runtime Host managed service document", [
    "schemaVersion",
    "bindings",
  ]);
  if (record.schemaVersion !== 1 || !Array.isArray(record.bindings)) {
    throw new Error("Legacy Runtime Host managed service document is invalid");
  }
  return decodeDocument({
    schemaVersion: SCHEMA_VERSION,
    bindings: record.bindings.map((candidate) => {
      const binding = requireExactRecord(candidate, "Legacy Runtime Host service binding", [
        "profile",
        "service",
        "state",
      ]);
      const service = requireExactRecord(binding.service, "Managed Runtime Host service", [
        "id",
        "operatorPath",
        "rootPath",
      ]);
      const operatorPath = requirePosixOperatorPath(service.operatorPath);
      return {
        profile: migrateRuntimeHostProfileOperatorCommand(binding.profile),
        deployment: {
          id: requireHostRootId(service.id),
          rootPath: requirePath(service.rootPath, "Managed Runtime Host State Root"),
        },
        control: {
          kind: "ssh_operator",
          operator: createRuntimeHostLegacyPosixOperatorCommand(operatorPath),
        },
        state: binding.state,
      };
    }),
  });
}

function decodeDeployment(value: unknown): DesktopRuntimeHostDeploymentBinding {
  const hasDeploymentId =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "deploymentId");
  const record = requireExactRecord(
    value,
    "Managed Runtime Host deployment",
    hasDeploymentId ? ["deploymentId", "id", "rootPath"] : ["id", "rootPath"],
  );
  return Object.freeze({
    id: requireHostRootId(record.id),
    rootPath: requirePath(record.rootPath, "Managed Runtime Host State Root"),
    ...(record.deploymentId === undefined
      ? {}
      : { deploymentId: requireDeploymentId(record.deploymentId) }),
  });
}

function decodeSshControlRoute(value: unknown): DesktopRuntimeHostSshControlRoute {
  const record = requireExactRecord(
    value,
    "Managed Runtime Host control route",
    ["kind", "operator"],
  );
  if (record.kind !== "ssh_operator") {
    throw new Error("Managed Runtime Host control route is invalid");
  }
  return Object.freeze({
    kind: "ssh_operator",
    operator: decodeRuntimeHostOperatorCommand(record.operator),
  });
}

function decodeBinding(
  value: {
    readonly profile?: unknown;
    readonly deployment?: unknown;
    readonly control?: unknown;
  },
  label: string,
): DesktopRuntimeHostManagedServiceBindingInput {
  const profile = decodePersistedRuntimeHostProfile(value.profile);
  const deployment = decodeDeployment(value.deployment);
  if (profile.kind === "environment") {
    return Object.freeze({ profile, deployment });
  }
  if (!isDesktopRuntimeHostManagedSshProfile(profile)) {
    throw new Error(`${label} has no supported control route`);
  }
  const control = decodeSshControlRoute(value.control);
  return Object.freeze({ profile, deployment, control });
}

function requireDeploymentId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new Error("Managed Runtime Host deployment identity is invalid");
  }
  return value;
}

function requirePath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > PATH_MAX_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requirePosixOperatorPath(value: unknown): string {
  const path = requirePath(value, "Managed Runtime Host operator path");
  if (!path.startsWith("/")) {
    throw new Error("Managed Runtime Host operator path must be absolute");
  }
  return path;
}

function requireExactRecord(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} has unexpected fields`);
  }
  return record;
}

function sameBindingTarget(
  left: DesktopRuntimeHostManagedServiceBinding,
  right: DesktopRuntimeHostManagedServiceBinding,
): boolean {
  if (
    left.deployment.id !== right.deployment.id ||
    left.deployment.rootPath !== right.deployment.rootPath ||
    left.deployment.deploymentId !== right.deployment.deploymentId
  ) {
    return false;
  }
  if (!isDesktopRuntimeHostManagedSshServiceBinding(left)) {
    return !isDesktopRuntimeHostManagedSshServiceBinding(right);
  }
  return (
    isDesktopRuntimeHostManagedSshServiceBinding(right) &&
    JSON.stringify(left.control.operator) === JSON.stringify(right.control.operator)
  );
}

function sameManagedProfileTarget(
  left: PersistedRuntimeHostProfile,
  right: PersistedRuntimeHostProfile,
): boolean {
  return (
    left.id === right.id &&
    (left.kind === "environment" && right.kind === "environment"
      ? sameEnvironmentRuntimeHostDeployment(left, right)
      : sameResolvedRuntimeHostProfileTarget({ profile: left }, { profile: right }))
  );
}

function emptyDocument(): DesktopRuntimeHostManagedServiceDocument {
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    bindings: Object.freeze([]),
  });
}

async function writeDocument(
  path: string,
  document: DesktopRuntimeHostManagedServiceDocument,
): Promise<void> {
  const validated = decodeDocument(document);
  const temporaryPath = join(
    dirname(path),
    `.runtime-host-deployments-${randomUUID()}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function removeLegacyDocument(path: string): Promise<void> {
  try {
    await rm(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await syncDirectory(dirname(path));
}
