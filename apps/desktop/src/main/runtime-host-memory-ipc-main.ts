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

import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import type {
  LocalMemoryBackupInfo,
  LocalMemoryEntryPreview,
  LocalMemoryState,
} from '@maka/core/local-memory';
import { isPathInside } from '@maka/runtime/path-containment';
import {
  MEMORY_DOCUMENT_CHUNK_MAX_BYTES,
  type MemoryBackupKind,
  type MemoryDocumentName,
  type MemoryEntryProjection,
  type MemoryEntriesView,
  type MemoryMutateInput,
  type MemoryMutateResult,
  type MemoryRevision,
  type MemoryStateProjection,
} from "@maka/runtime-host/protocol";
import type { DesktopRuntimeHostClient } from "./runtime-host-client.js";
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
} from "./ipc-reconnect-policy.js";

type LocalMemoryMutationResult =
  | {
      readonly ok: true;
      readonly state: LocalMemoryState;
      readonly entry?: LocalMemoryEntryPreview;
      readonly proposal?: LocalMemoryEntryPreview;
    }
  | {
      readonly ok: false;
      readonly state: LocalMemoryState;
      readonly reason: string;
      readonly message: string;
    };

const MAX_REVISION_ATTEMPTS = 3;
const MEMORY_DIRECTORY = "memory";
const MEMORY_FILE = "MEMORY.md";
const BACKUP_FILES: Readonly<Record<MemoryBackupKind, string>> = {
  save: "MEMORY.md.bak",
  reset: "MEMORY.md.reset.bak",
  restore: "MEMORY.md.restore.bak",
};

interface RuntimeHostMemoryIpcDeps {
  readonly ipcMain: ReconnectableReadIpcMain;
  readonly client: DesktopRuntimeHostClient;
  readonly workspaceRoot: string;
  readonly allowLocalPaths?: boolean;
  readonly openPath: (path: string) => Promise<string>;
}

export function registerRuntimeHostMemoryIpc(
  deps: RuntimeHostMemoryIpcDeps,
): void {
  handleReconnectableRead(deps.ipcMain, "memory:getState", () =>
    getMemoryState(deps),
  );
  deps.ipcMain.handle("memory:save", async (_event, content: unknown) => {
    if (typeof content !== "string") return getMemoryState(deps);
    await replaceRuntimeHostMemoryDocument(deps.client, content);
    return getMemoryState(deps);
  });
  deps.ipcMain.handle("memory:reset", async () => {
    await mutateMemory(deps, (expectedRevision) => ({
      kind: "reset",
      expectedRevision,
    }));
    return getMemoryState(deps);
  });
  deps.ipcMain.handle("memory:restoreLatestBackup", async () => {
    const state = await getMemoryState(deps);
    const backup = state.latestBackup;
    if (!backup)
      return {
        ok: false as const,
        state,
        message: "No Memory backup is available",
      };
    return restoreBackup(deps, backup.kind);
  });
  deps.ipcMain.handle("memory:restoreBackup", async (_event, kind: unknown) => {
    if (!isBackupKind(kind)) {
      return {
        ok: false as const,
        state: await getMemoryState(deps),
        message: "Invalid Memory backup kind",
      };
    }
    return restoreBackup(deps, kind);
  });
  deps.ipcMain.handle("memory:setEnabled", async (_event, enabled: unknown) => {
    await deps.client.updateRuntimePolicy((policy) => ({
      kind: "set_memory",
      value: { ...policy.memory, enabled: enabled === true },
    }));
    return getMemoryState(deps);
  });
  deps.ipcMain.handle(
    "memory:setAgentReadEnabled",
    async (_event, enabled: unknown) => {
      await deps.client.updateRuntimePolicy((policy) => ({
        kind: "set_memory",
        value: { ...policy.memory, agentReadEnabled: enabled === true },
      }));
      return getMemoryState(deps);
    },
  );
  deps.ipcMain.handle("memory:openFile", () =>
    openMemoryPath(deps, MEMORY_FILE),
  );
  deps.ipcMain.handle("memory:openLatestBackup", async () => {
    const state = await getMemoryState(deps);
    return state.latestBackup
      ? openMemoryPath(
          deps,
          BACKUP_FILES[state.latestBackup.kind],
        )
      : { ok: false as const, message: "No Memory backup is available" };
  });
  deps.ipcMain.handle("memory:openBackup", async (_event, kind: unknown) => {
    return isBackupKind(kind)
      ? openMemoryPath(deps, BACKUP_FILES[kind])
      : { ok: false as const, message: "Invalid Memory backup kind" };
  });
}

async function getMemoryState(
  deps: RuntimeHostMemoryIpcDeps,
): Promise<LocalMemoryState> {
  const policy = await deps.client.queryRuntimePolicy();
  const path = deps.allowLocalPaths !== false
    ? join(deps.workspaceRoot, MEMORY_DIRECTORY, MEMORY_FILE)
    : "";
  for (let attempt = 0; attempt < MAX_REVISION_ATTEMPTS; attempt += 1) {
    const result = await deps.client.queryMemory({ kind: "state" });
    if (result.kind === "blocked") {
      return emptyMemoryState({
        path,
        enabled: policy.policy.memory.enabled,
        agentReadEnabled: policy.policy.memory.agentReadEnabled,
        status:
          result.reason === "disabled" ? "disabled" : "incognito_blocked",
        reason: result.reason,
      });
    }
    if (result.kind !== "state") {
      return emptyMemoryState({
        path,
        enabled: policy.policy.memory.enabled,
        agentReadEnabled: policy.policy.memory.agentReadEnabled,
        status: "error",
        reason: "Runtime Host returned an invalid Memory state projection",
      });
    }
    const backups = result.backups
      .map((backup) => projectBackup(deps, backup))
      .sort((left, right) => right.updatedAt - left.updatedAt);
    if (result.status === "missing") {
      return {
        ...emptyMemoryState({
          path,
          enabled: policy.policy.memory.enabled,
          agentReadEnabled: policy.policy.memory.agentReadEnabled,
          status: "ok",
        }),
        entryCount: result.entryCount,
        activeEntryCount: result.activeEntryCount,
        archivedEntryCount: result.archivedEntryCount,
        backups,
        ...(backups[0] ? { latestBackup: backups[0] } : {}),
      };
    }
    if (result.status === "safe_mode") {
      return {
        ...emptyMemoryState({
          path,
          enabled: policy.policy.memory.enabled,
          agentReadEnabled: policy.policy.memory.agentReadEnabled,
          status: "safe_mode",
          reason: "Memory is in safe mode",
        }),
        entryCount: result.entryCount,
        activeEntryCount: result.activeEntryCount,
        archivedEntryCount: result.archivedEntryCount,
        backups,
        ...(backups[0] ? { latestBackup: backups[0] } : {}),
      };
    }
    const [document, active, archived] = await Promise.all([
      readRuntimeHostMemoryDocumentSnapshot(deps.client, "memory"),
      readMemoryEntriesSnapshot(deps.client, "active"),
      readMemoryEntriesSnapshot(deps.client, "archived"),
    ]);
    if (
      document.revision !== result.memoryRevision ||
      active.revision !== result.revision ||
      archived.revision !== result.revision
    ) {
      continue;
    }
    const entries = [...active.entries, ...archived.entries].sort(
      compareMemoryEntries,
    );
    return {
      path,
      enabled: policy.policy.memory.enabled,
      agentReadEnabled: policy.policy.memory.agentReadEnabled,
      status: "ok",
      content: document.content,
      entryCount: result.entryCount,
      activeEntryCount: result.activeEntryCount,
      archivedEntryCount: result.archivedEntryCount,
      entries,
      activeEntries: active.entries,
      archivedEntries: archived.entries,
      ...(entries[0] ? { latestEntry: entries[0] } : {}),
      ...(backups[0] ? { latestBackup: backups[0] } : {}),
      backups,
    };
  }
  throw new Error("Memory kept changing while Desktop assembled its state");
}

function emptyMemoryState(
  input: Pick<
    LocalMemoryState,
    "path" | "enabled" | "agentReadEnabled" | "status" | "reason"
  >,
): LocalMemoryState {
  return {
    ...input,
    content: "",
    entryCount: 0,
    activeEntryCount: 0,
    archivedEntryCount: 0,
    entries: [],
    activeEntries: [],
    archivedEntries: [],
    backups: [],
  };
}

async function readMemoryEntriesSnapshot(
  client: DesktopRuntimeHostClient,
  view: MemoryEntriesView,
): Promise<{
  readonly entries: LocalMemoryEntryPreview[];
  readonly revision: MemoryRevision | null;
}> {
  for (let attempt = 0; attempt < MAX_REVISION_ATTEMPTS; attempt += 1) {
    const first = await client.queryMemory({ kind: "entries_start", view });
    if (first.kind === "blocked" || first.kind === "missing") {
      return { entries: [], revision: null };
    }
    if (first.kind !== "entries_page" || first.view !== view) {
      if (first.kind === "revision_changed") continue;
      throw new Error("Runtime Host returned an invalid Memory entries page");
    }
    const entries = [...first.items];
    let page = first;
    let changed = false;
    while (page.nextCursor !== null) {
      const next = await client.queryMemory({
        kind: "entries_continue",
        view,
        revision: first.revision,
        cursor: page.nextCursor,
      });
      if (next.kind === "revision_changed") {
        changed = true;
        break;
      }
      if (
        next.kind !== "entries_page" ||
        next.revision !== first.revision ||
        next.view !== view
      ) {
        throw new Error(
          "Runtime Host returned an inconsistent Memory entries page",
        );
      }
      entries.push(...next.items);
      page = next;
    }
    if (!changed) {
      return {
        entries: entries.map(projectMemoryEntry).sort(compareMemoryEntries),
        revision: first.revision,
      };
    }
  }
  throw new Error("Memory entries kept changing while Desktop read them");
}

export async function readRuntimeHostMemoryDocument(
  client: DesktopRuntimeHostClient,
  document: MemoryDocumentName,
): Promise<string> {
  return (await readRuntimeHostMemoryDocumentSnapshot(client, document))
    .content;
}

async function readRuntimeHostMemoryDocumentSnapshot(
  client: DesktopRuntimeHostClient,
  document: MemoryDocumentName,
): Promise<{ readonly content: string; readonly revision: MemoryRevision | null }> {
  for (let attempt = 0; attempt < MAX_REVISION_ATTEMPTS; attempt += 1) {
    const first = await client.queryMemory({
      kind: "document_start",
      document,
    });
    if (first.kind === "missing" || first.kind === "blocked") {
      return { content: "", revision: null };
    }
    if (first.kind === "safe_mode") {
      return { content: "", revision: first.revision };
    }
    if (
      first.kind !== "document_page" ||
      first.document !== document ||
      first.offset !== 0
    ) {
      if (first.kind === "revision_changed") continue;
      throw new Error("Runtime Host returned an invalid Memory document page");
    }
    const chunks = [Buffer.from(first.chunkBase64, "base64")];
    let page = first;
    let changed = false;
    while (page.nextCursor !== null) {
      const next = await client.queryMemory({
        kind: "document_continue",
        document,
        revision: first.revision,
        cursor: page.nextCursor,
      });
      if (next.kind === "revision_changed") {
        changed = true;
        break;
      }
      if (
        next.kind !== "document_page" ||
        next.document !== document ||
        next.revision !== first.revision
      ) {
        throw new Error(
          "Runtime Host returned an inconsistent Memory document page",
        );
      }
      chunks.push(Buffer.from(next.chunkBase64, "base64"));
      page = next;
    }
    if (!changed) {
      return {
        content: Buffer.concat(chunks).toString("utf8"),
        revision: first.revision,
      };
    }
  }
  throw new Error("Memory document kept changing while Desktop read it");
}

async function mutateMemory(
  deps: RuntimeHostMemoryIpcDeps,
  createInput: (expectedRevision: MemoryRevision) => MemoryMutateInput,
): Promise<LocalMemoryMutationResult> {
  for (let attempt = 0; attempt < MAX_REVISION_ATTEMPTS; attempt += 1) {
    const state = await deps.client.queryMemory({ kind: "state" });
    if (state.kind !== "state") {
      return mutationFailure(
        deps,
        state.kind === "blocked" ? state.reason : "invalid_state",
      );
    }
    const result = await deps.client.mutateMemory(createInput(state.revision));
    if (result.kind === "revision_conflict") continue;
    if (
      result.kind === "rejected" ||
      result.kind === "backup_revision_conflict"
    ) {
      return mutationFailure(
        deps,
        result.kind === "rejected" ? result.reason : "backup_revision_conflict",
      );
    }
    if (result.kind !== "committed" && result.kind !== "unchanged") {
      return mutationFailure(deps, "invalid_state");
    }
    return { ok: true, state: await getMemoryState(deps) };
  }
  return mutationFailure(deps, "revision_conflict");
}

export async function replaceRuntimeHostMemoryDocument(
  client: DesktopRuntimeHostClient,
  content: string,
): Promise<void> {
  const bytes = Buffer.from(content, "utf8");
  const contentSha256 =
    `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
  for (let attempt = 0; attempt < MAX_REVISION_ATTEMPTS; attempt += 1) {
    const state = await client.queryMemory({ kind: "state" });
    if (state.kind !== "state") throw new Error("Memory is unavailable");
    const opened = await client.mutateMemory({
      kind: "replace_begin",
      expectedRevision: state.revision,
      totalBytes: bytes.byteLength,
      contentSha256,
    });
    if (opened.kind === "revision_conflict") continue;
    if (opened.kind === "unchanged") return;
    if (opened.kind !== "upload_opened")
      throw new Error(memoryMutationMessage(opened));
    try {
      let offset: number = opened.nextOffset;
      while (offset < bytes.byteLength) {
        const chunk = bytes.subarray(
          offset,
          Math.min(bytes.byteLength, offset + MEMORY_DOCUMENT_CHUNK_MAX_BYTES),
        );
        const accepted = await client.mutateMemory({
          kind: "replace_chunk",
          uploadId: opened.uploadId,
          offset,
          chunkBase64: chunk.toString("base64"),
        });
        if (
          accepted.kind !== "chunk_accepted" ||
          accepted.nextOffset <= offset
        ) {
          throw new Error("Runtime Host did not advance the Memory upload");
        }
        offset = accepted.nextOffset;
      }
      const committed = await client.mutateMemory({
        kind: "replace_commit",
        uploadId: opened.uploadId,
      });
      if (committed.kind !== "committed" && committed.kind !== "unchanged") {
        throw new Error(memoryMutationMessage(committed));
      }
      return;
    } catch (error) {
      await client
        .mutateMemory({ kind: "replace_abort", uploadId: opened.uploadId })
        .catch(() => undefined);
      throw error;
    }
  }
  throw new Error("Memory kept changing while Desktop saved it");
}

async function restoreBackup(
  deps: RuntimeHostMemoryIpcDeps,
  kind: MemoryBackupKind,
): Promise<
  | { ok: true; state: LocalMemoryState }
  | { ok: false; state: LocalMemoryState; message: string }
> {
  const state = await deps.client.queryMemory({ kind: "state" });
  if (state.kind !== "state") {
    return {
      ok: false,
      state: await getMemoryState(deps),
      message: "Memory is unavailable",
    };
  }
  const backup = state.backups.find((candidate) => candidate.kind === kind);
  if (!backup) {
    return {
      ok: false,
      state: await getMemoryState(deps),
      message: "Memory backup not found",
    };
  }
  const result = await mutateMemory(deps, (expectedRevision) => ({
    kind: "restore_backup",
    expectedRevision,
    backupKind: kind,
    expectedBackupRevision: backup.revision,
  }));
  return result.ok
    ? { ok: true, state: result.state }
    : { ok: false, state: result.state, message: result.message };
}

async function openMemoryPath(
  deps: Pick<
    RuntimeHostMemoryIpcDeps,
    "workspaceRoot" | "allowLocalPaths" | "openPath"
  >,
  fileName: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (deps.allowLocalPaths === false) {
    return {
      ok: false,
      message: "Memory files are owned by the remote Runtime Host",
    };
  }
  try {
    const directory = await realpath(
      join(deps.workspaceRoot, MEMORY_DIRECTORY),
    );
    const path = await realpath(join(directory, fileName));
    if (!isPathInside(directory, path) || !(await lstat(path)).isFile()) {
      return {
        ok: false,
        message: "Memory path is not an allowed regular file",
      };
    }
    const error = await deps.openPath(path);
    return error
      ? { ok: false, message: "The system could not open the Memory file" }
      : { ok: true };
  } catch {
    return { ok: false, message: "Memory file not found" };
  }
}

function projectMemoryEntry(
  entry: MemoryEntryProjection,
): LocalMemoryEntryPreview {
  return {
    ...entry,
    origin:
      entry.source === "user_authored"
        ? "manual"
        : entry.source === "chat_extracted"
          ? "extracted"
          : "unknown",
  };
}

function projectBackup(
  deps: Pick<RuntimeHostMemoryIpcDeps, "workspaceRoot" | "allowLocalPaths">,
  backup: MemoryStateProjection["backups"][number],
): LocalMemoryBackupInfo {
  return {
    path: deps.allowLocalPaths !== false
      ? join(
          deps.workspaceRoot,
          MEMORY_DIRECTORY,
          BACKUP_FILES[backup.kind],
        )
      : "",
    kind: backup.kind,
    updatedAt: backup.updatedAt,
    sizeBytes: backup.sizeBytes,
    entryCount: backup.entryCount,
    activeEntryCount: backup.activeEntryCount,
    archivedEntryCount: backup.archivedEntryCount,
    safeMode: backup.safeMode,
    ...(backup.reason ? { reason: backup.reason } : {}),
  };
}

function compareMemoryEntries(
  left: LocalMemoryEntryPreview,
  right: LocalMemoryEntryPreview,
): number {
  return (
    (right.updatedAt ?? right.createdAt ?? 0) -
    (left.updatedAt ?? left.createdAt ?? 0)
  );
}

function isBackupKind(value: unknown): value is MemoryBackupKind {
  return value === "save" || value === "reset" || value === "restore";
}

async function mutationFailure(
  deps: RuntimeHostMemoryIpcDeps,
  reason: string,
): Promise<LocalMemoryMutationResult> {
  return {
    ok: false,
    state: await getMemoryState(deps),
    reason,
    message: memoryReasonMessage(reason),
  };
}

function memoryReasonMessage(reason: string): string {
  return reason.replaceAll("_", " ");
}

function memoryMutationMessage(result: MemoryMutateResult): string {
  return result.kind === "rejected"
    ? memoryReasonMessage(result.reason)
    : `Unexpected Memory mutation result: ${result.kind}`;
}
