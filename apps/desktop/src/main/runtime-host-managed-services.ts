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

export interface DesktopRuntimeHostManagedService {
  readonly id: string;
  readonly rootPath: string;
  readonly operatorPath: string;
}

export interface DesktopRuntimeHostManagedServiceBinding {
  readonly profile: RemoteRuntimeHostProfile;
  readonly service: DesktopRuntimeHostManagedService;
  readonly state: "active" | "uninstalling";
}

export interface DesktopRuntimeHostManagedServiceDocument {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly bindings: readonly DesktopRuntimeHostManagedServiceBinding[];
}

export interface DesktopRuntimeHostManagedServiceStore {
  read(): Promise<DesktopRuntimeHostManagedServiceDocument>;
  save(
    profile: RemoteRuntimeHostProfile,
    service: DesktopRuntimeHostManagedService,
  ): Promise<void>;
  removeIfCurrent(
    profile: RemoteRuntimeHostProfile,
    service: DesktopRuntimeHostManagedService,
  ): Promise<boolean>;
  removeForProfileIfCurrent(profile: RemoteRuntimeHostProfile): Promise<boolean>;
  markUninstallingIfCurrent(
    profile: RemoteRuntimeHostProfile,
    service: DesktopRuntimeHostManagedService,
  ): Promise<boolean>;
}

export function createDesktopRuntimeHostManagedServiceStore(
  clientDataRoot: string,
): DesktopRuntimeHostManagedServiceStore {
  return new FileDesktopRuntimeHostManagedServiceStore(
    join(clientDataRoot, "runtime-host-managed-services.json"),
  );
}

export function findDesktopRuntimeHostManagedServiceBinding(
  document: DesktopRuntimeHostManagedServiceDocument,
  profile: RemoteRuntimeHostProfile,
): DesktopRuntimeHostManagedServiceBinding | undefined {
  const binding = document.bindings.find((candidate) => candidate.profile.id === profile.id);
  return binding && sameRemoteRuntimeHostProfileTarget(binding.profile, profile)
    ? binding
    : undefined;
}

class FileDesktopRuntimeHostManagedServiceStore
  implements DesktopRuntimeHostManagedServiceStore
{
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async read(): Promise<DesktopRuntimeHostManagedServiceDocument> {
    let contents: string;
    try {
      contents = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyDocument();
      throw error;
    }
    if (Buffer.byteLength(contents, "utf8") > DOCUMENT_MAX_BYTES) {
      throw new Error("Runtime Host managed service document is too large");
    }
    return decodeDocument(JSON.parse(contents));
  }

  save(
    value: RemoteRuntimeHostProfile,
    managedService: DesktopRuntimeHostManagedService,
  ): Promise<void> {
    const profile = decodeRemoteRuntimeHostProfile(value);
    if (profile.transport.kind !== "ssh") {
      return Promise.reject(new Error("A managed Runtime Host service requires SSH"));
    }
    const service = decodeService(managedService);
    return this.#exclusive(async () => {
      const current = await this.read();
      const bindings = current.bindings.filter(
        (binding) => binding.profile.id !== profile.id,
      );
      if (bindings.length >= BINDING_COUNT_MAX) {
        throw new Error("Too many managed Runtime Host services are configured");
      }
      await writeDocument(this.#path, {
        schemaVersion: SCHEMA_VERSION,
        bindings: [...bindings, { profile, service, state: "active" }],
      });
    });
  }

  markUninstallingIfCurrent(
    value: RemoteRuntimeHostProfile,
    managedService: DesktopRuntimeHostManagedService,
  ): Promise<boolean> {
    const profile = decodeRemoteRuntimeHostProfile(value);
    const service = decodeService(managedService);
    return this.#exclusive(async () => {
      const current = await this.read();
      const binding = current.bindings.find(
        (candidate) => candidate.profile.id === profile.id,
      );
      if (
        !binding ||
        !sameRemoteRuntimeHostProfileTarget(binding.profile, profile) ||
        !sameService(binding.service, service)
      ) {
        return false;
      }
      if (binding.state === "uninstalling") return true;
      await writeDocument(this.#path, {
        schemaVersion: SCHEMA_VERSION,
        bindings: current.bindings.map((candidate) =>
          candidate === binding ? { ...candidate, state: "uninstalling" as const } : candidate,
        ),
      });
      return true;
    });
  }

  removeIfCurrent(
    value: RemoteRuntimeHostProfile,
    managedService: DesktopRuntimeHostManagedService,
  ): Promise<boolean> {
    const profile = decodeRemoteRuntimeHostProfile(value);
    const service = decodeService(managedService);
    return this.#remove(profile, service);
  }

  removeForProfileIfCurrent(value: RemoteRuntimeHostProfile): Promise<boolean> {
    return this.#remove(decodeRemoteRuntimeHostProfile(value));
  }

  #remove(
    profile: RemoteRuntimeHostProfile,
    service?: DesktopRuntimeHostManagedService,
  ): Promise<boolean> {
    return this.#exclusive(async () => {
      const current = await this.read();
      const binding = current.bindings.find(
        (candidate) => candidate.profile.id === profile.id,
      );
      if (
        !binding ||
        !sameRemoteRuntimeHostProfileTarget(binding.profile, profile) ||
        (service && !sameService(binding.service, service))
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

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    return withFileUpdateLock(this.#path, operation);
  }
}

function decodeDocument(value: unknown): DesktopRuntimeHostManagedServiceDocument {
  const record = requireExactRecord(value, "Runtime Host managed service document", [
    "schemaVersion",
    "bindings",
  ]);
  if (record.schemaVersion !== SCHEMA_VERSION || !Array.isArray(record.bindings)) {
    throw new Error("Runtime Host managed service document is invalid");
  }
  if (record.bindings.length > BINDING_COUNT_MAX) {
    throw new Error("Runtime Host managed service document has too many bindings");
  }
  const bindings = record.bindings.map((candidate) => {
    const binding = requireExactRecord(candidate, "Runtime Host managed service binding", [
      "profile",
      "service",
      "state",
    ]);
    const profile = decodeRemoteRuntimeHostProfile(binding.profile);
    if (profile.transport.kind !== "ssh") {
      throw new Error("A managed Runtime Host service requires SSH");
    }
    if (binding.state !== "active" && binding.state !== "uninstalling") {
      throw new Error("Runtime Host managed service state is invalid");
    }
    return Object.freeze({
      profile,
      service: decodeService(binding.service),
      state: binding.state,
    });
  });
  if (new Set(bindings.map((binding) => binding.profile.id)).size !== bindings.length) {
    throw new Error("Runtime Host managed service bindings must have unique profile IDs");
  }
  return Object.freeze({ schemaVersion: SCHEMA_VERSION, bindings: Object.freeze(bindings) });
}

function decodeService(value: unknown): DesktopRuntimeHostManagedService {
  const record = requireExactRecord(value, "Managed Runtime Host service", [
    "id",
    "rootPath",
    "operatorPath",
  ]);
  const rootPath = requirePath(record.rootPath, "Managed Runtime Host State Root");
  const operatorPath = requirePath(record.operatorPath, "Managed Runtime Host operator path");
  if (!operatorPath.startsWith("/")) {
    throw new Error("Managed Runtime Host operator path must be absolute");
  }
  return Object.freeze({
    id: requireHostRootId(record.id),
    rootPath,
    operatorPath,
  });
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
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unexpected fields`);
  }
  return record;
}

function sameService(
  left: DesktopRuntimeHostManagedService,
  right: DesktopRuntimeHostManagedService,
): boolean {
  return (
    left.id === right.id &&
    left.rootPath === right.rootPath &&
    left.operatorPath === right.operatorPath
  );
}

function emptyDocument(): DesktopRuntimeHostManagedServiceDocument {
  return Object.freeze({ schemaVersion: SCHEMA_VERSION, bindings: Object.freeze([]) });
}

async function writeDocument(
  path: string,
  document: DesktopRuntimeHostManagedServiceDocument,
): Promise<void> {
  const validated = decodeDocument(document);
  const temporaryPath = join(dirname(path), `.runtime-host-managed-services-${randomUUID()}.tmp`);
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
