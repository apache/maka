import type { ProjectRecord } from "@maka/core";
import type { ProjectCatalogProject } from "@maka/runtime-host/protocol";
import type { ProjectManagementCatalog } from "./project-management-service.js";
import type { DesktopRuntimeHostClient } from "./runtime-host-client.js";

export interface DesktopProjectCatalog extends ProjectManagementCatalog {}

type RuntimeHostProjectClient = Pick<
  DesktopRuntimeHostClient,
  | "archiveProject"
  | "listProjects"
  | "projectLocations"
  | "registerProject"
  | "relinkProject"
  | "renameProject"
  | "restoreProject"
>;

export function createRuntimeHostProjectCatalog(
  resolveClient: () => RuntimeHostProjectClient,
): DesktopProjectCatalog {
  return {
    list: async () => {
      const client = resolveClient();
      return Promise.all((await client.listProjects()).map((project) => projectRecord(client, project)));
    },
    register: async (path) => {
      const client = resolveClient();
      return projectRecord(client, await client.registerProject(path));
    },
    relink: async (projectId, path) => {
      const client = resolveClient();
      return projectRecord(client, await client.relinkProject(projectId, path));
    },
    rename: async (projectId, name) => {
      const client = resolveClient();
      return projectRecord(client, await client.renameProject(projectId, name));
    },
    archive: async (projectId) => {
      const client = resolveClient();
      return projectRecord(client, await client.archiveProject(projectId));
    },
    restore: async (projectId) => {
      const client = resolveClient();
      return projectRecord(client, await client.restoreProject(projectId));
    },
  };
}

async function projectRecord(
  client: Pick<DesktopRuntimeHostClient, "projectLocations">,
  project: ProjectCatalogProject,
): Promise<ProjectRecord> {
  if (!project.available || project.archivedAt !== null) return toProjectRecord(project);
  return toProjectRecord(project, await client.projectLocations(project.id));
}

function toProjectRecord(
  project: ProjectCatalogProject,
  location?: Awaited<ReturnType<DesktopRuntimeHostClient["projectLocations"]>>,
): ProjectRecord {
  return {
    id: project.id,
    ...(project.aliases.length === 0 ? {} : { aliases: [...project.aliases] }),
    name: project.name,
    locations: location ? [...location.locations] : [],
    ...(project.archivedAt === null ? {} : { archivedAt: project.archivedAt }),
    available: project.available,
    ...(location ? { preferredPath: location.preferredPath } : {}),
  };
}
