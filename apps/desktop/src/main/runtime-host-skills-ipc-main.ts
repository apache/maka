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

import type { ChatDefaultPermissionMode } from '@maka/core/settings';
import { resolveSkillDiscoveryPaths, scanSkillsWithDiagnostics } from '@maka/runtime/skills';
import { type InvocableSkillEntry } from '@maka/runtime/skill-invocation';
import type {
  SkillCatalogGovernanceItem,
  SkillCatalogManagedUpdateMutation,
  SkillCatalogMutation,
  SkillCatalogMutationOutcome,
  SkillCatalogMutationRejectedReason,
  SkillCatalogPreviewUpdateResult,
  WorkspaceProjection,
  WorkspaceTarget,
} from "@maka/runtime-host/protocol";
import type {
  BundledSkillCatalogEntry,
  ManagedSkillSourceEntry,
  ManagedSkillUpdatePreview,
  SkillEntry,
  SkillGovernanceDetails,
} from "@maka/ui";
import type { createMainWindowController } from "./main-window.js";
import {
  importManagedSkillSource,
  toManagedSkillSourceEntry,
} from "./managed-skill-sources.js";
import type {
  DesktopRuntimeHostClient,
  DesktopSkillCatalogSnapshot,
} from "./runtime-host-client.js";
import { resolveSkillOpenPath } from "./skill-open-path.js";
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
} from "./ipc-reconnect-policy.js";

const MAX_REVISION_ATTEMPTS = 3;

type MainWindowController = ReturnType<typeof createMainWindowController>;

interface RuntimeHostSkillsIpcDeps {
  readonly ipcMain: ReconnectableReadIpcMain;
  readonly client: DesktopRuntimeHostClient;
  readonly workspaceRoot: string;
  readonly mainWindowController: MainWindowController;
  readonly getSelectedWorkspaceTarget: () => Promise<WorkspaceTarget | undefined>;
  readonly resolveNewSessionWorkspaceTarget: (
    projectId: string | null | undefined,
  ) => Promise<WorkspaceTarget | undefined>;
  readonly getDefaultPermissionMode: () => Promise<ChatDefaultPermissionMode>;
  readonly openPath: (path: string) => Promise<string>;
  readonly allowLocalPaths?: boolean;
}

interface GovernanceProjection {
  readonly workspace: WorkspaceProjection;
  readonly snapshot: DesktopSkillCatalogSnapshot;
  readonly items: readonly SkillCatalogGovernanceItem[];
  readonly paths: ReadonlyMap<string, string>;
}

type StableSkillMutationResult = Exclude<
  SkillCatalogMutationOutcome,
  { readonly kind: 'revision_conflict' }
>;

interface StableSkillMutation {
  readonly result: StableSkillMutationResult;
  readonly workspace: WorkspaceProjection;
}

export function registerRuntimeHostSkillsIpc(
  deps: RuntimeHostSkillsIpcDeps,
): void {
  handleReconnectableRead(deps.ipcMain, "skills:list", async () => {
    const workspace = await deps.getSelectedWorkspaceTarget();
    if (!workspace) return [];
    const projection = await loadGovernance(
      deps,
      workspace,
    );
    return projection.items.map((item) =>
      toSkillEntry(item, projection.paths.get(item.ref) ?? ""),
    );
  });

  handleReconnectableRead(
    deps.ipcMain,
    "skills:listInvocable",
    async (_event, sessionId?: unknown, newSessionContext?: unknown) => {
      let target;
      if (typeof sessionId === "string") {
        target = { kind: "session" as const, sessionId };
      } else {
        const projectId = normalizeNewSessionProjectId(newSessionContext);
        const workspace = await deps.resolveNewSessionWorkspaceTarget(projectId);
        if (!workspace) return [];
        target = {
          kind: "new_session" as const,
          context: { workspace },
          collaborationMode:
            normalizeNewSessionCollaborationMode(newSessionContext) ?? "agent",
          permissionMode:
            normalizeNewSessionPermissionMode(newSessionContext) ??
            await deps.getDefaultPermissionMode(),
        };
      }
      return (await deps.client.listInvocableSkills(target)).map(
        (item): InvocableSkillEntry => ({ ...item }),
      );
    },
  );

  handleReconnectableRead(deps.ipcMain, "skills:catalog:list", async () => {
    const workspace = await deps.getSelectedWorkspaceTarget();
    if (!workspace) return [];
    const snapshot = await deps.client.loadSkillCatalog(
      { workspace },
      "bundled",
    );
    return snapshot.items.flatMap((item): BundledSkillCatalogEntry[] =>
      item.kind === "bundled"
        ? [
            {
              id: item.id,
              name: item.name,
              description: item.description,
              category: item.category as BundledSkillCatalogEntry["category"],
              declaredTools: [...item.declaredTools],
              installed: item.installed,
            },
          ]
        : [],
    );
  });

  deps.ipcMain.handle("skills:catalog:install", async (_event, id: string) => {
    return installSkill(deps, "bundled", id);
  });

  handleReconnectableRead(deps.ipcMain, "skills:sources:list", async () => {
    const workspace = await deps.getSelectedWorkspaceTarget();
    if (!workspace) return [];
    const snapshot = await deps.client.loadSkillCatalog(
      { workspace },
      "managed_sources",
    );
    return snapshot.items.flatMap((item): ManagedSkillSourceEntry[] =>
      item.kind === "managed_source"
        ? [
            {
              id: item.id,
              name: item.name,
              description: item.description,
              category: item.category as ManagedSkillSourceEntry["category"],
              sourceType: item.sourceType,
            },
          ]
        : [],
    );
  });

  deps.ipcMain.handle("skills:sources:importLocalFile", async () => {
    if (deps.allowLocalPaths === false) {
      throw new Error("Local Skill import is unavailable for a remote Runtime Host");
    }
    const result = await deps.mainWindowController.showOpenDialog({
      title: "Import Skill source",
      properties: ["openFile"],
      filters: [
        { name: "Skill Markdown", extensions: ["md"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false as const, reason: "cancelled" as const };
    }
    const imported = await importManagedSkillSource({
      sourceFile: result.filePaths[0],
    });
    if (!imported.ok) return imported;
    return {
      ok: true as const,
      source: toManagedSkillSourceEntry(imported.source),
    };
  });

  deps.ipcMain.handle(
    "skills:installManaged",
    async (_event, sourceId: string) => {
      return installSkill(deps, "managed", sourceId);
    },
  );

  handleReconnectableRead(
    deps.ipcMain,
    "skills:previewUpdate",
    async (_event, idOrRef: string) => {
      const workspaceTarget = await requireSelectedWorkspaceTarget(deps);
      for (let attempt = 0; attempt < MAX_REVISION_ATTEMPTS; attempt += 1) {
        const projection = await loadGovernance(deps, workspaceTarget);
        const resolved = resolveGovernanceItem(projection.items, idOrRef);
        if (!resolved.ok) return resolved;
        const result = await deps.client.previewSkillUpdate({
          context: { workspace: projection.workspace.target },
          expectedRevision: projection.snapshot.revision,
          ref: resolved.item.ref,
        });
        if (result.kind === "revision_conflict") continue;
        const workspace = result.resolvedWorkspace;
        return projectPreviewResult(
          result,
          resolved.item,
          await resolveProjectedPath(deps, workspace.hostCwd, resolved.item.ref),
        );
      }
      throw new Error(
        "Skill catalog kept changing while Desktop prepared the update preview",
      );
    },
  );

  deps.ipcMain.handle(
    "skills:updateManaged",
    async (
      _event,
      idOrRef: string,
      options?: {
        force?: boolean;
        expectedCurrentSha256?: string;
        expectedSourceSha256?: string;
      },
    ) => {
      let mutation: SkillCatalogManagedUpdateMutation;
      if (options?.force === true) {
        if (!options.expectedCurrentSha256 || !options.expectedSourceSha256) {
          return { ok: false as const, reason: "metadata_error" as const };
        }
        mutation = {
          kind: "update_managed",
          ref: idOrRef,
          force: true,
          expectedCurrentSha256:
            options.expectedCurrentSha256 as `sha256:${string}`,
          expectedSourceSha256:
            options.expectedSourceSha256 as `sha256:${string}`,
        };
      } else {
        mutation = {
          kind: "update_managed",
          ref: idOrRef,
          force: false,
          expectedCurrentSha256: null,
          expectedSourceSha256: null,
        };
      }
      return mutateResolvedSkill(deps, idOrRef, (ref) => ({
        ...mutation,
        ref,
      }));
    },
  );

  deps.ipcMain.handle(
    "skills:setEnabled",
    async (_event, idOrRef: string, enabled: boolean) => {
      return mutateResolvedSkill(deps, idOrRef, (ref) => ({
        kind: "set_enabled",
        ref,
        enabled: enabled === true,
      }));
    },
  );

  deps.ipcMain.handle(
    "skills:setPinned",
    async (_event, idOrRef: string, pinned: boolean) => {
      return mutateResolvedSkill(deps, idOrRef, (ref) => ({
        kind: "set_pinned",
        ref,
        pinned: pinned === true,
      }));
    },
  );

  deps.ipcMain.handle("skills:delete", async (_event, idOrRef: string) => {
    const { result } = await mutateResolvedSkillRaw(
      deps,
      idOrRef,
      (ref) => ({
        kind: "delete",
        ref,
      }),
    );
    if (result.kind === "rejected") {
      return { ok: false as const, reason: mapMutationReason(result.reason) };
    }
    return { ok: true as const };
  });

  deps.ipcMain.handle(
    "skills:open",
    async (_event, idOrRef: string, target: "file" | "directory" = "file") => {
      if (deps.allowLocalPaths === false) {
        throw new Error("Local Skill paths are unavailable for a remote Runtime Host");
      }
      const projection = await loadGovernance(
        deps,
        await requireSelectedWorkspaceTarget(deps),
      );
      const item = resolveGovernanceItem(projection.items, idOrRef);
      if (!item.ok) return item;
      const resolved = await resolveSkillOpenPath(
        deps.workspaceRoot,
        item.item.ref,
        target,
        projection.workspace.hostCwd,
      );
      if (!resolved.ok) return resolved;
      const error = await deps.openPath(resolved.path);
      return error
        ? { ok: false as const, reason: "open_failed" as const }
        : { ok: true as const, target: resolved.target };
    },
  );
}

async function loadGovernance(
  deps: RuntimeHostSkillsIpcDeps,
  workspace: WorkspaceTarget,
): Promise<GovernanceProjection> {
  const snapshot = await deps.client.loadSkillCatalog(
    { workspace },
    "governance",
  );
  return {
    workspace: snapshot.workspace,
    snapshot,
    items: snapshot.items.filter(isGovernanceItem),
    paths:
      deps.allowLocalPaths === false
        ? new Map()
        : await loadSkillPaths(deps.workspaceRoot, snapshot.workspace.hostCwd),
  };
}

async function loadSkillPaths(
  workspaceRoot: string,
  projectRoot: string,
): Promise<ReadonlyMap<string, string>> {
  const scan = await scanSkillsWithDiagnostics(
    resolveSkillDiscoveryPaths(projectRoot, workspaceRoot),
  );
  return new Map([
    ...scan.inventory.map((skill) => [skill.ref, skill.path] as const),
    ...scan.rejected.map((skill) => [skill.ref, skill.path] as const),
  ]);
}

function isGovernanceItem(
  item: DesktopSkillCatalogSnapshot["items"][number],
): item is SkillCatalogGovernanceItem {
  return item.kind === "skill" || item.kind === "discovery_diagnostic";
}

function normalizeNewSessionCollaborationMode(
  input: unknown,
): "agent" | "plan" | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const value = (input as Record<string, unknown>).collaborationMode;
  return value === "agent" || value === "plan" ? value : undefined;
}

function normalizeNewSessionPermissionMode(
  input: unknown,
): ChatDefaultPermissionMode | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const value = (input as Record<string, unknown>).permissionMode;
  return value === "ask" || value === "bypass" ? value : undefined;
}

function normalizeNewSessionProjectId(input: unknown): string | null | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const value = (input as Record<string, unknown>).projectId;
  if (value === null) return null;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resolveGovernanceItem(
  items: readonly SkillCatalogGovernanceItem[],
  idOrRef: string,
):
  | { readonly ok: true; readonly item: SkillCatalogGovernanceItem }
  | { readonly ok: false; readonly reason: "not_found" | "invalid_id" } {
  if (typeof idOrRef !== "string" || idOrRef.trim().length === 0) {
    return { ok: false, reason: "invalid_id" };
  }
  const exact = items.find((item) => item.ref === idOrRef);
  if (exact) return { ok: true, item: exact };
  const matches = items.filter((item) => item.id === idOrRef);
  return matches.length === 1
    ? { ok: true, item: matches[0] }
    : { ok: false, reason: matches.length === 0 ? "not_found" : "invalid_id" };
}

async function installSkill(
  deps: RuntimeHostSkillsIpcDeps,
  sourceType: "bundled" | "managed",
  sourceId: string,
) {
  const { result, workspace } = await mutateSkill(
    deps,
    sourceType === "bundled" ? "bundled" : "managed_sources",
    {
      kind: "install",
      sourceType,
      sourceId,
    },
  );
  if (result.kind === "rejected")
    return { ok: false as const, reason: mapMutationReason(result.reason) };
  if (!result.entry)
    throw new Error("Runtime Host did not project the installed Skill");
  return {
    ok: true as const,
    skill: toSkillEntry(
      result.entry,
      await resolveProjectedPath(deps, workspace.hostCwd, result.entry.ref),
    ),
  };
}

async function mutateResolvedSkill(
  deps: RuntimeHostSkillsIpcDeps,
  idOrRef: string,
  mutation: (ref: string) => SkillCatalogMutation,
) {
  const { result, workspace } = await mutateResolvedSkillRaw(
    deps,
    idOrRef,
    mutation,
  );
  if (result.kind === "rejected")
    return { ok: false as const, reason: mapMutationReason(result.reason) };
  if (!result.entry)
    throw new Error("Runtime Host did not project the mutated Skill");
  return {
    ok: true as const,
    skill: toSkillEntry(
      result.entry,
      await resolveProjectedPath(deps, workspace.hostCwd, result.entry.ref),
    ),
  };
}

async function mutateResolvedSkillRaw(
  deps: RuntimeHostSkillsIpcDeps,
  idOrRef: string,
  mutation: (ref: string) => SkillCatalogMutation,
): Promise<StableSkillMutation> {
  const workspace = await requireSelectedWorkspaceTarget(deps);
  for (let attempt = 0; attempt < MAX_REVISION_ATTEMPTS; attempt += 1) {
    const projection = await loadGovernance(deps, workspace);
    const resolved = resolveGovernanceItem(projection.items, idOrRef);
    if (!resolved.ok) {
      return {
        result: {
          kind: "rejected",
          reason: "not_found",
        },
        workspace: projection.workspace,
      };
    }
    const result = await deps.client.mutateSkillCatalog({
      context: { workspace: projection.workspace.target },
      expectedRevision: projection.snapshot.revision,
      mutation: mutation(resolved.item.ref),
    });
    if (result.kind !== "revision_conflict") {
      return { result, workspace: result.resolvedWorkspace };
    }
  }
  throw new Error(
    "Skill catalog kept changing while Desktop applied a mutation",
  );
}

async function mutateSkill(
  deps: RuntimeHostSkillsIpcDeps,
  view: "governance" | "bundled" | "managed_sources",
  mutation: SkillCatalogMutation,
): Promise<StableSkillMutation> {
  const workspace = await requireSelectedWorkspaceTarget(deps);
  for (let attempt = 0; attempt < MAX_REVISION_ATTEMPTS; attempt += 1) {
    const snapshot = await deps.client.loadSkillCatalog(
      { workspace },
      view,
    );
    const result = await deps.client.mutateSkillCatalog({
      context: { workspace: snapshot.workspace.target },
      expectedRevision: snapshot.revision,
      mutation,
    });
    if (result.kind !== "revision_conflict") {
      return { result, workspace: result.resolvedWorkspace };
    }
  }
  throw new Error(
    "Skill catalog kept changing while Desktop applied a mutation",
  );
}

async function resolveProjectedPath(
  deps: Pick<RuntimeHostSkillsIpcDeps, "workspaceRoot" | "allowLocalPaths">,
  projectRoot: string,
  ref: string,
): Promise<string> {
  if (deps.allowLocalPaths === false) return "";
  const resolved = await resolveSkillOpenPath(deps.workspaceRoot, ref, "file", projectRoot);
  return resolved.ok ? resolved.path : "";
}

async function requireSelectedWorkspaceTarget(
  deps: Pick<RuntimeHostSkillsIpcDeps, "getSelectedWorkspaceTarget">,
): Promise<WorkspaceTarget> {
  const workspace = await deps.getSelectedWorkspaceTarget();
  if (!workspace) {
    throw new Error("Select a project from the remote Runtime Host first");
  }
  return workspace;
}

function toSkillEntry(
  item: SkillCatalogGovernanceItem,
  path: string,
): SkillEntry {
  return {
    kind: item.kind,
    ref: item.ref,
    id: item.id,
    name: item.name,
    description: item.description,
    path,
    declaredTools: [...item.declaredTools],
    sourceType: item.sourceType,
    userModified: item.userModified,
    validationStatus: item.validationStatus,
    ...(item.managedUpdateStatus === null
      ? {}
      : { managedUpdateStatus: item.managedUpdateStatus }),
    enabled: item.enabled,
    pinned: item.pinned,
    runtimeStatus: item.runtimeStatus,
    scope: item.scope,
    source: item.source,
    ...(item.contextStatus === "unknown"
      ? {}
      : { contextStatus: item.contextStatus }),
    ...(item.contextRank === null ? {} : { contextRank: item.contextRank }),
    ...(item.shadowedBy === null ? {} : { shadowedBy: item.shadowedBy }),
    needsReview: item.needsReview,
    manageable: item.manageable,
  };
}

function toSkillDetails(
  item: SkillCatalogGovernanceItem,
  path: string,
  preview?: Extract<SkillCatalogPreviewUpdateResult, { kind: "preview" }>,
): SkillGovernanceDetails {
  const supportedValidationCodes = item.validationCodes.filter(
    (code): code is SkillGovernanceDetails["validationCodes"][number] =>
      code === "missing_lock" ||
      code === "modified" ||
      code === "invalid_json" ||
      code === "id_mismatch" ||
      code === "unsupported_schema" ||
      code === "invalid_hash" ||
      code === "write_failed" ||
      code === "lock_symlink",
  );
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    path,
    declaredTools: [...item.declaredTools],
    sourceType: item.sourceType,
    userModified: item.userModified,
    validationStatus: item.validationStatus,
    enabled: item.enabled,
    runtimeStatus: item.runtimeStatus,
    validationCodes: supportedValidationCodes,
    validationMessages: [],
    ...(item.managedUpdateStatus === null
      ? {}
      : { managedUpdateStatus: item.managedUpdateStatus }),
    hasManagedBaseline: preview?.hasManagedBaseline ?? false,
    ...(preview
      ? {
          sourceAvailable: true,
          sourceChanged: preview.summary.changedLineCount > 0,
        }
      : {}),
  };
}

function projectPreviewResult(
  result: Exclude<
    SkillCatalogPreviewUpdateResult,
    { kind: "revision_conflict" }
  >,
  item: SkillCatalogGovernanceItem,
  path: string,
):
  | { readonly ok: true; readonly preview: ManagedSkillUpdatePreview }
  | { readonly ok: false; readonly reason: string } {
  if (result.kind === "rejected") {
    return { ok: false, reason: mapPreviewReason(result.reason) };
  }
  return {
    ok: true,
    preview: {
      skill: toSkillDetails(item, path, result),
      currentContent: result.currentSnippet,
      sourceContent: result.sourceSnippet,
      expectedCurrentSha256: result.expectedCurrentSha256,
      expectedSourceSha256: result.expectedSourceSha256,
      summary: result.summary,
    },
  };
}

function mapMutationReason(reason: SkillCatalogMutationRejectedReason): string {
  switch (reason) {
    case "source_changed":
      return "local_modified";
    case "source_invalid":
    case "needs_review":
      return "metadata_error";
    default:
      return reason;
  }
}

function mapPreviewReason(
  reason: Extract<
    SkillCatalogPreviewUpdateResult,
    { kind: "rejected" }
  >["reason"],
): string {
  return reason === "source_invalid" ? "metadata_error" : reason;
}
