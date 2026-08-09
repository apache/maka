import type { ProjectRecord } from "@maka/core";
import { RuntimeHostOperationError } from "@maka/runtime-host/client";
import { ProjectPathMismatchError } from "@maka/storage";
import type { ProjectManagementCatalog } from "./project-management-service.js";
import type { DesktopRuntimeHostClient } from "./runtime-host-client.js";

export interface DesktopProjectCatalog extends ProjectManagementCatalog {
  touch(projectId: string, path?: string): Promise<ProjectRecord>;
}

type RuntimeHostProjectClient = Pick<
  DesktopRuntimeHostClient,
  | "archiveProject"
  | "listProjects"
  | "registerProject"
  | "relinkProject"
  | "renameProject"
  | "restoreProject"
  | "selectProject"
  | "touchProject"
>;

export function createRuntimeHostProjectCatalog(
  resolveClient: () => RuntimeHostProjectClient,
): DesktopProjectCatalog {
  return {
    list: () => resolveClient().listProjects(),
    register: (path) => resolveClient().registerProject(path),
    select: (projectId) => resolveClient().selectProject(projectId),
    async touch(projectId, path) {
      try {
        return await resolveClient().touchProject(projectId, path);
      } catch (error) {
        if (error instanceof RuntimeHostOperationError && error.code === "operation_conflict") {
          throw new ProjectPathMismatchError(projectId, path ?? "");
        }
        throw error;
      }
    },
    relink: (projectId, path) => resolveClient().relinkProject(projectId, path),
    rename: (projectId, name) => resolveClient().renameProject(projectId, name),
    archive: (projectId) => resolveClient().archiveProject(projectId),
    restore: (projectId) => resolveClient().restoreProject(projectId),
  };
}
