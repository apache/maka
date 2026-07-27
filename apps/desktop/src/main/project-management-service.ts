import type { ProjectCatalog, ProjectRecord, SessionStore } from '@maka/storage';

type DirectoryActionResult =
  | { ok: true; project: ProjectRecord }
  | { ok: false; reason: 'cancelled' };
type SelectedDirectoryActionResult =
  | { ok: true; project: ProjectRecord; path: string }
  | { ok: false; reason: 'cancelled' };

export interface ProjectManagementService {
  list(): Promise<ProjectRecord[]>;
  add(): Promise<SelectedDirectoryActionResult>;
  select(projectId: unknown): Promise<{ project: ProjectRecord; path: string }>;
  relink(projectId: unknown): Promise<DirectoryActionResult>;
  rename(projectId: unknown, name: unknown): Promise<ProjectRecord>;
  archive(projectId: unknown): Promise<ProjectRecord>;
  restore(projectId: unknown): Promise<ProjectRecord>;
}

export function createProjectManagementService(deps: {
  catalog: ProjectCatalog;
  sessions: Pick<SessionStore, 'listHeaders' | 'updateHeader'>;
  chooseDirectory(): Promise<string | undefined>;
  setSelectedPath(path: string): void;
}): ProjectManagementService {
  return {
    list: () => deps.catalog.list(),

    async add() {
      const path = await deps.chooseDirectory();
      if (!path) return { ok: false, reason: 'cancelled' };
      const project = await deps.catalog.register(path);
      const selected = await deps.catalog.select(project.id);
      deps.setSelectedPath(selected.path);
      return { ok: true, project: selected.project, path: selected.path };
    },

    async select(projectId) {
      const selected = await deps.catalog.select(requireProjectId(projectId));
      deps.setSelectedPath(selected.path);
      return selected;
    },

    async relink(projectId) {
      const id = requireProjectId(projectId);
      const path = await deps.chooseDirectory();
      if (!path) return { ok: false, reason: 'cancelled' };
      const mergeSessions = async (conflictingProjectId: string) => {
        for (const header of await deps.sessions.listHeaders()) {
          if (header.projectId === conflictingProjectId) {
            await deps.sessions.updateHeader(header.id, { projectId: id });
          }
        }
      };
      const project = await deps.catalog.relink(id, path, mergeSessions);
      return { ok: true, project };
    },

    rename(projectId, name) {
      const trimmed = typeof name === 'string' ? name.trim() : '';
      if (!trimmed) throw new TypeError('Invalid project name.');
      return deps.catalog.rename(requireProjectId(projectId), trimmed);
    },

    archive(projectId) {
      return deps.catalog.archive(requireProjectId(projectId));
    },

    restore(projectId) {
      return deps.catalog.restore(requireProjectId(projectId));
    },
  };
}

function requireProjectId(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new TypeError('Invalid project id.');
  return value;
}
