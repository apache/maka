import { findProjectByIdentity, type ProjectRecord } from '@maka/core/project';
import type {
  ProjectCatalogProject,
  ProjectCatalogProjectDetails,
} from "@maka/runtime-host/protocol";
import type { ProjectManagementCatalog } from "./project-management-service.js";
import type { DesktopRuntimeHostClient } from "./runtime-host-client.js";

export interface DesktopProjectCatalog extends ProjectManagementCatalog {}

type RuntimeHostProjectClient = Pick<
  DesktopRuntimeHostClient,
  | "archiveProject"
  | "listProjects"
  | "registerProject"
  | "relinkProject"
  | "renameProject"
  | "restoreProject"
>;

export function createRuntimeHostProjectCatalog(
  resolveTarget: () => {
    readonly client: RuntimeHostProjectClient;
    readonly includeHostPaths: boolean;
  },
): DesktopProjectCatalog {
  return {
    list: async () => {
      const target = resolveTarget();
      return (await target.client.listProjects(target.includeHostPaths)).map(toProjectRecord);
    },
    register: async (path) => {
      const target = resolveTarget();
      return projectRecord(target, await target.client.registerProject(path));
    },
    relink: async (projectId, path) => {
      const target = resolveTarget();
      return projectRecord(target, await target.client.relinkProject(projectId, path));
    },
    rename: async (projectId, name) => {
      const target = resolveTarget();
      return projectRecord(target, await target.client.renameProject(projectId, name));
    },
    archive: async (projectId) => {
      const target = resolveTarget();
      return projectRecord(target, await target.client.archiveProject(projectId));
    },
    restore: async (projectId) => {
      const target = resolveTarget();
      return projectRecord(target, await target.client.restoreProject(projectId));
    },
  };
}

async function projectRecord(
  target: {
    readonly client: Pick<DesktopRuntimeHostClient, "listProjects">;
    readonly includeHostPaths: boolean;
  },
  project: ProjectCatalogProject,
): Promise<ProjectRecord> {
  const details = findProjectByIdentity(
    await target.client.listProjects(target.includeHostPaths),
    project.id,
  );
  if (!details) throw new Error(`Project ${project.id} disappeared after mutation`);
  return toProjectRecord(details);
}

function toProjectRecord(
  project: ProjectCatalogProject | ProjectCatalogProjectDetails,
): ProjectRecord {
  return {
    id: project.id,
    ...(project.aliases.length === 0 ? {} : { aliases: [...project.aliases] }),
    name: project.name,
    locations: "locations" in project ? [...project.locations] : [],
    ...(project.archivedAt === null ? {} : { archivedAt: project.archivedAt }),
    available: project.available,
    ...("preferredPath" in project && project.preferredPath !== null
      ? { preferredPath: project.preferredPath }
      : {}),
  };
}
