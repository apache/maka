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
  decodeRemoteRuntimeHostProfile,
  sameRemoteRuntimeHostProfileTarget,
  type RemoteRuntimeHostProfile,
} from "@maka/runtime-host/client";
import { requireHostRootId } from "@maka/runtime-host/protocol";
import { withFileUpdateLock } from "@maka/storage/file-update-lock";
import { syncDirectory } from "@maka/storage/stable-storage";

const SCHEMA_VERSION = 1;
const DOCUMENT_MAX_BYTES = 256 * 1024;
const BINDING_COUNT_MAX = 32;
const PATH_MAX_BYTES = 4 * 1024;

export interface DesktopRuntimeHostDeploymentBinding {
  readonly id: string;
  readonly rootPath: string;
  readonly deploymentId?: string;
}

export interface DesktopRuntimeHostControlRoute {
  readonly kind: "ssh_operator";
  readonly operatorPath: string;
}

export interface DesktopRuntimeHostManagedServiceTarget {
  readonly deployment: DesktopRuntimeHostDeploymentBinding;
  readonly control: DesktopRuntimeHostControlRoute;
}

export interface DesktopRuntimeHostManagedServiceBinding {
  readonly profile: RemoteRuntimeHostProfile;
  readonly deployment: DesktopRuntimeHostDeploymentBinding;
  readonly control: DesktopRuntimeHostControlRoute;
  readonly state: "active" | "uninstalling" | "cleanup_pending";
}

export interface DesktopRuntimeHostManagedServiceDocument {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly bindings: readonly DesktopRuntimeHostManagedServiceBinding[];
}

export interface DesktopRuntimeHostManagedServiceStore {
  read(): Promise<DesktopRuntimeHostManagedServiceDocument>;
  save(
    profile: RemoteRuntimeHostProfile,
    target: DesktopRuntimeHostManagedServiceTarget,
  ): Promise<void>;
  removeIfCurrent(
    binding: DesktopRuntimeHostManagedServiceBinding,
  ): Promise<boolean>;
  removeForProfileIfCurrent(
    profile: RemoteRuntimeHostProfile,
  ): Promise<boolean>;
  markUninstallingIfCurrent(
    binding: DesktopRuntimeHostManagedServiceBinding,
  ): Promise<boolean>;
  markCleanupPendingIfCurrent(
    binding: DesktopRuntimeHostManagedServiceBinding,
  ): Promise<boolean>;
  removeCleanupPendingIfCurrent(
    binding: DesktopRuntimeHostManagedServiceBinding,
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
  profile: RemoteRuntimeHostProfile,
): DesktopRuntimeHostManagedServiceBinding | undefined {
  const binding = document.bindings.find(
    (candidate) => candidate.profile.id === profile.id,
  );
  return binding && sameRemoteRuntimeHostProfileTarget(binding.profile, profile)
    ? binding
    : undefined;
}

export function sameDesktopRuntimeHostManagedServiceBinding(
  left: DesktopRuntimeHostManagedServiceBinding,
  right: DesktopRuntimeHostManagedServiceBinding,
): boolean {
  return (
    left.state === right.state &&
    left.profile.id === right.profile.id &&
    sameRemoteRuntimeHostProfileTarget(left.profile, right.profile) &&
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
        if ((legacyError as NodeJS.ErrnoException).code === "ENOENT")
          return emptyDocument();
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
    const document = decodeDocument(JSON.parse(contents));
    await removeLegacyDocument(this.#legacyPath);
    return document;
  }

  save(
    value: RemoteRuntimeHostProfile,
    managedTarget: DesktopRuntimeHostManagedServiceTarget,
  ): Promise<void> {
    const profile = decodeRemoteRuntimeHostProfile(value);
    if (profile.transport.kind !== "ssh") {
      return Promise.reject(
        new Error("A managed Runtime Host service requires SSH"),
      );
    }
    const deployment = decodeDeployment(managedTarget.deployment);
    const control = decodeControlRoute(managedTarget.control);
    return this.#exclusive(async () => {
      const current = await this.#readUnlocked();
      const bindings = current.bindings.filter(
        (binding) => binding.profile.id !== profile.id,
      );
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
            profile,
            deployment,
            control,
            state: "active",
          },
        ],
      });
    });
  }

  markUninstallingIfCurrent(
    binding: DesktopRuntimeHostManagedServiceBinding,
  ): Promise<boolean> {
    return this.#setStateIfCurrent(
      binding,
      ["active", "uninstalling"],
      "uninstalling",
    );
  }

  markCleanupPendingIfCurrent(
    binding: DesktopRuntimeHostManagedServiceBinding,
  ): Promise<boolean> {
    return this.#setStateIfCurrent(
      binding,
      ["uninstalling", "cleanup_pending"],
      "cleanup_pending",
    );
  }

  removeCleanupPendingIfCurrent(
    binding: DesktopRuntimeHostManagedServiceBinding,
  ): Promise<boolean> {
    return this.#remove(binding, "cleanup_pending");
  }

  removeIfCurrent(binding: DesktopRuntimeHostManagedServiceBinding): Promise<boolean> {
    return this.#remove(binding);
  }

  removeForProfileIfCurrent(value: RemoteRuntimeHostProfile): Promise<boolean> {
    return this.#remove(undefined, undefined, decodeRemoteRuntimeHostProfile(value));
  }

  #remove(
    expected?: DesktopRuntimeHostManagedServiceBinding,
    state?: DesktopRuntimeHostManagedServiceBinding["state"],
    profileOverride?: RemoteRuntimeHostProfile,
  ): Promise<boolean> {
    const profile = expected?.profile ?? profileOverride!;
    return this.#exclusive(async () => {
      const current = await this.#readUnlocked();
      const binding = current.bindings.find(
        (candidate) => candidate.profile.id === profile.id,
      );
      if (
        !binding ||
        !sameRemoteRuntimeHostProfileTarget(binding.profile, profile) ||
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
    expected: DesktopRuntimeHostManagedServiceBinding,
    allowedStates: readonly DesktopRuntimeHostManagedServiceBinding["state"][],
    state: DesktopRuntimeHostManagedServiceBinding["state"],
  ): Promise<boolean> {
    const profile = expected.profile;
    return this.#exclusive(async () => {
      const current = await this.#readUnlocked();
      const binding = current.bindings.find(
        (candidate) => candidate.profile.id === profile.id,
      );
      if (
        !binding ||
        !sameRemoteRuntimeHostProfileTarget(binding.profile, profile) ||
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
  if (
    record.schemaVersion !== SCHEMA_VERSION ||
    !Array.isArray(record.bindings)
  ) {
    throw new Error("Runtime Host managed service document is invalid");
  }
  if (record.bindings.length > BINDING_COUNT_MAX) {
    throw new Error(
      "Runtime Host managed service document has too many bindings",
    );
  }
  const bindings = record.bindings.map((candidate) => {
    const binding = requireExactRecord(
      candidate,
      "Runtime Host managed service binding",
      ["control", "deployment", "profile", "state"],
    );
    const profile = decodeRemoteRuntimeHostProfile(binding.profile);
    if (profile.transport.kind !== "ssh") {
      throw new Error("A managed Runtime Host service requires SSH");
    }
    if (
      binding.state !== "active" &&
      binding.state !== "uninstalling" &&
      binding.state !== "cleanup_pending"
    ) {
      throw new Error("Runtime Host managed service state is invalid");
    }
    return Object.freeze({
      profile,
      deployment: decodeDeployment(binding.deployment),
      control: decodeControlRoute(binding.control),
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
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    bindings: Object.freeze(bindings),
  });
}

function decodeLegacyDocument(
  value: unknown,
): DesktopRuntimeHostManagedServiceDocument {
  const record = requireExactRecord(
    value,
    "Legacy Runtime Host managed service document",
    ["schemaVersion", "bindings"],
  );
  if (record.schemaVersion !== 1 || !Array.isArray(record.bindings)) {
    throw new Error("Legacy Runtime Host managed service document is invalid");
  }
  return decodeDocument({
    schemaVersion: SCHEMA_VERSION,
    bindings: record.bindings.map((candidate) => {
      const binding = requireExactRecord(
        candidate,
        "Legacy Runtime Host service binding",
        ["profile", "service", "state"],
      );
      const service = decodeLegacyService(binding.service);
      return {
        profile: binding.profile,
        deployment: { id: service.id, rootPath: service.rootPath },
        control: { kind: "ssh_operator", operatorPath: service.operatorPath },
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

function decodeControlRoute(value: unknown): DesktopRuntimeHostControlRoute {
  const record = requireExactRecord(
    value,
    "Managed Runtime Host control route",
    ["kind", "operatorPath"],
  );
  if (record.kind !== "ssh_operator") {
    throw new Error("Managed Runtime Host control route is invalid");
  }
  const operatorPath = requirePath(
    record.operatorPath,
    "Managed Runtime Host operator path",
  );
  if (!operatorPath.startsWith("/")) {
    throw new Error("Managed Runtime Host operator path must be absolute");
  }
  return Object.freeze({ kind: "ssh_operator", operatorPath });
}

function decodeLegacyService(value: unknown): {
  readonly id: string;
  readonly rootPath: string;
  readonly operatorPath: string;
} {
  const record = requireExactRecord(
    value,
    "Managed Runtime Host service",
    ["id", "operatorPath", "rootPath"],
  );
  const rootPath = requirePath(
    record.rootPath,
    "Managed Runtime Host State Root",
  );
  const operatorPath = requirePath(
    record.operatorPath,
    "Managed Runtime Host operator path",
  );
  if (!operatorPath.startsWith("/")) {
    throw new Error("Managed Runtime Host operator path must be absolute");
  }
  return Object.freeze({
    id: requireHostRootId(record.id),
    rootPath,
    operatorPath,
  });
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
  return (
    left.deployment.id === right.deployment.id &&
    left.deployment.rootPath === right.deployment.rootPath &&
    left.deployment.deploymentId === right.deployment.deploymentId &&
    left.control.kind === right.control.kind &&
    left.control.operatorPath === right.control.operatorPath
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
