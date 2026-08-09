import type { ipcMain as electronIpcMain } from "electron";
import type { ChatDefaultPermissionMode } from "@maka/core";
import {
  resolveSkillDiscoveryPaths,
  scanSkillsWithDiagnostics,
  type InvocableSkillEntry,
} from "@maka/runtime";
import type {
  SkillCatalogGovernanceItem,
  SkillCatalogManagedUpdateMutation,
  SkillCatalogMutateResult,
  SkillCatalogMutation,
  SkillCatalogMutationRejectedReason,
  SkillCatalogPreviewUpdateResult,
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

const MAX_REVISION_ATTEMPTS = 3;

type MainWindowController = ReturnType<typeof createMainWindowController>;

interface RuntimeHostSkillsIpcDeps {
  readonly ipcMain: Pick<typeof electronIpcMain, "handle">;
  readonly client: DesktopRuntimeHostClient;
  readonly workspaceRoot: string;
  readonly mainWindowController: MainWindowController;
  readonly getCurrentProjectRoot: () => Promise<string>;
  readonly getDefaultPermissionMode: () => Promise<ChatDefaultPermissionMode>;
  readonly openPath: (path: string) => Promise<string>;
}

interface GovernanceProjection {
  readonly projectRoot: string;
  readonly snapshot: DesktopSkillCatalogSnapshot;
  readonly items: readonly SkillCatalogGovernanceItem[];
  readonly paths: ReadonlyMap<string, string>;
}

type StableSkillMutationResult = Exclude<
  SkillCatalogMutateResult,
  { readonly kind: 'revision_conflict' }
>;

interface StableSkillMutation {
  readonly result: StableSkillMutationResult;
  readonly projectRoot: string;
}

export function registerRuntimeHostSkillsIpc(
  deps: RuntimeHostSkillsIpcDeps,
): void {
  deps.ipcMain.handle("skills:list", async () => {
    const projection = await loadGovernance(
      deps,
      await deps.getCurrentProjectRoot(),
    );
    return projection.items.map((item) =>
      toSkillEntry(item, projection.paths.get(item.ref) ?? ""),
    );
  });

  deps.ipcMain.handle(
    "skills:listInvocable",
    async (_event, sessionId?: unknown, newSessionContext?: unknown) => {
      const target =
        typeof sessionId === "string"
          ? { kind: "session" as const, sessionId }
          : {
              kind: "new_session" as const,
              context: { projectRoot: await deps.getCurrentProjectRoot() },
              collaborationMode:
                normalizeNewSessionCollaborationMode(newSessionContext) ??
                "agent",
              permissionMode: await deps.getDefaultPermissionMode(),
            };
      return (await deps.client.listInvocableSkills(target)).map(
        (item): InvocableSkillEntry => ({ ...item }),
      );
    },
  );

  deps.ipcMain.handle("skills:catalog:list", async () => {
    const projectRoot = await deps.getCurrentProjectRoot();
    const snapshot = await deps.client.loadSkillCatalog(
      { projectRoot },
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

  deps.ipcMain.handle("skills:sources:list", async () => {
    const projectRoot = await deps.getCurrentProjectRoot();
    const snapshot = await deps.client.loadSkillCatalog(
      { projectRoot },
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

  deps.ipcMain.handle("skills:details", async (_event, idOrRef: string) => {
    const projection = await loadGovernance(
      deps,
      await deps.getCurrentProjectRoot(),
    );
    const resolved = resolveGovernanceItem(projection.items, idOrRef);
    if (!resolved.ok) return resolved;
    return {
      ok: true as const,
      details: toSkillDetails(
        resolved.item,
        projection.paths.get(resolved.item.ref) ?? "",
      ),
    };
  });

  deps.ipcMain.handle(
    "skills:previewUpdate",
    async (_event, idOrRef: string) => {
      const projectRoot = await deps.getCurrentProjectRoot();
      for (let attempt = 0; attempt < MAX_REVISION_ATTEMPTS; attempt += 1) {
        const projection = await loadGovernance(deps, projectRoot);
        const resolved = resolveGovernanceItem(projection.items, idOrRef);
        if (!resolved.ok) return resolved;
        const result = await deps.client.previewSkillUpdate({
          context: { projectRoot: projection.projectRoot },
          expectedRevision: projection.snapshot.revision,
          ref: resolved.item.ref,
        });
        if (result.kind === "revision_conflict") continue;
        return projectPreviewResult(
          result,
          resolved.item,
          projection.paths.get(resolved.item.ref) ?? "",
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

  deps.ipcMain.handle("skills:createStarter", async () => {
    const { result, projectRoot } = await mutateSkill(deps, "governance", {
      kind: "create_starter",
    });
    if (result.kind === "rejected")
      return { ok: false as const, reason: mapMutationReason(result.reason) };
    if (!result.entry)
      throw new Error("Runtime Host did not project the starter Skill");
    const path = await resolveProjectedPath(
      deps.workspaceRoot,
      projectRoot,
      result.entry.ref,
    );
    return {
      ok: true as const,
      created: result.kind === "committed",
      skill: toSkillEntry(result.entry, path),
      filePath: path,
    };
  });

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
      const projectRoot = await deps.getCurrentProjectRoot();
      const resolved = await resolveSkillOpenPath(
        deps.workspaceRoot,
        idOrRef,
        target,
        projectRoot,
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
  projectRoot: string,
): Promise<GovernanceProjection> {
  const snapshot = await deps.client.loadSkillCatalog(
    { projectRoot },
    "governance",
  );
  return {
    projectRoot,
    snapshot,
    items: snapshot.items.filter(isGovernanceItem),
    paths: await loadSkillPaths(deps.workspaceRoot, projectRoot),
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
  const { result, projectRoot } = await mutateSkill(
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
      await resolveProjectedPath(
        deps.workspaceRoot,
        projectRoot,
        result.entry.ref,
      ),
    ),
  };
}

async function mutateResolvedSkill(
  deps: RuntimeHostSkillsIpcDeps,
  idOrRef: string,
  mutation: (ref: string) => SkillCatalogMutation,
) {
  const { result, projectRoot } = await mutateResolvedSkillRaw(
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
      await resolveProjectedPath(
        deps.workspaceRoot,
        projectRoot,
        result.entry.ref,
      ),
    ),
  };
}

async function mutateResolvedSkillRaw(
  deps: RuntimeHostSkillsIpcDeps,
  idOrRef: string,
  mutation: (ref: string) => SkillCatalogMutation,
): Promise<StableSkillMutation> {
  const projectRoot = await deps.getCurrentProjectRoot();
  for (let attempt = 0; attempt < MAX_REVISION_ATTEMPTS; attempt += 1) {
    const projection = await loadGovernance(deps, projectRoot);
    const resolved = resolveGovernanceItem(projection.items, idOrRef);
    if (!resolved.ok) {
      return {
        result: { kind: "rejected", reason: "not_found" },
        projectRoot: projection.projectRoot,
      };
    }
    const result = await deps.client.mutateSkillCatalog({
      context: { projectRoot: projection.projectRoot },
      expectedRevision: projection.snapshot.revision,
      mutation: mutation(resolved.item.ref),
    });
    if (result.kind !== "revision_conflict") {
      return { result, projectRoot: projection.projectRoot };
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
  const projectRoot = await deps.getCurrentProjectRoot();
  for (let attempt = 0; attempt < MAX_REVISION_ATTEMPTS; attempt += 1) {
    const snapshot = await deps.client.loadSkillCatalog({ projectRoot }, view);
    const result = await deps.client.mutateSkillCatalog({
      context: { projectRoot },
      expectedRevision: snapshot.revision,
      mutation,
    });
    if (result.kind !== "revision_conflict") return { result, projectRoot };
  }
  throw new Error(
    "Skill catalog kept changing while Desktop applied a mutation",
  );
}

async function resolveProjectedPath(
  workspaceRoot: string,
  projectRoot: string,
  ref: string,
): Promise<string> {
  const resolved = await resolveSkillOpenPath(workspaceRoot, ref, "file", projectRoot);
  return resolved.ok ? resolved.path : "";
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
