import type { ProjectRecord } from '@maka/core/project';
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
  resolveClient: () => RuntimeHostProjectClient,
): DesktopProjectCatalog {
  return {
    list: async () => {
      const client = resolveClient();
      return (await client.listProjects()).map(toProjectRecord);
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
  client: Pick<DesktopRuntimeHostClient, "listProjects">,
  project: ProjectCatalogProject,
): Promise<ProjectRecord> {
  const details = (await client.listProjects()).find(
    (candidate) => candidate.id === project.id || candidate.aliases.includes(project.id),
  );
  if (!details) throw new Error(`Project ${project.id} disappeared after mutation`);
  return toProjectRecord(details);
}

function toProjectRecord(project: ProjectCatalogProjectDetails): ProjectRecord {
  return {
    id: project.id,
    ...(project.aliases.length === 0 ? {} : { aliases: [...project.aliases] }),
    name: project.name,
    locations: [...project.locations],
    ...(project.archivedAt === null ? {} : { archivedAt: project.archivedAt }),
    available: project.available,
    ...(project.preferredPath === null ? {} : { preferredPath: project.preferredPath }),
  };
}
