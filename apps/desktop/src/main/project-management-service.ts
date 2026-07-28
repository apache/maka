import type { ProjectCatalog, ProjectRecord, SessionStore } from '@maka/storage';
import type { CurrentProjectSelection } from './project-root-controller.js';

type DirectoryActionResult =
  | { ok: true; project: ProjectRecord }
  | { ok: false; reason: 'cancelled' };
type SelectedDirectoryActionResult =
  | { ok: true; project: ProjectRecord; path: string }
  | { ok: false; reason: 'cancelled' };

export interface ProjectManagementService {
  current(): Promise<CurrentProjectSelection>;
  list(): Promise<ProjectRecord[]>;
  add(): Promise<SelectedDirectoryActionResult>;
  select(
    projectId: unknown,
  ): Promise<{ project: ProjectRecord | null; path: string }>;
  relink(projectId: unknown): Promise<DirectoryActionResult>;
  rename(projectId: unknown, name: unknown): Promise<ProjectRecord>;
  archive(projectId: unknown): Promise<ProjectRecord>;
  restore(projectId: unknown): Promise<ProjectRecord>;
}

export function createProjectManagementService(deps: {
  catalog: ProjectCatalog;
  sessions: Pick<SessionStore, 'listHeaders' | 'updateHeader'>;
  chooseDirectory(): Promise<string | undefined>;
  selection: {
    currentSelection(): Promise<CurrentProjectSelection>;
    setSelection(projectId: string | null, projectPath: string): void;
  };
}): ProjectManagementService {
  async function current(): Promise<CurrentProjectSelection> {
    const selection = await deps.selection.currentSelection();
    if (selection.projectId === null) {
      return selection;
    }
    const projects = await deps.catalog.list();
    const selectedProjectId = selection.projectId;
    const requested =
      typeof selectedProjectId === 'string'
        ? projects.find(
            (project) =>
              project.id === selectedProjectId ||
              project.aliases?.includes(selectedProjectId),
          )
        : projects.find((project) =>
            project.locations.some((location) => location.path === selection.path),
          );
    const isSelectable = (project: ProjectRecord | undefined) =>
      project !== undefined &&
      project.archivedAt === undefined &&
      project.available &&
      project.preferredPath;
    const selected =
      isSelectable(requested) ? requested : projects.find((project) => isSelectable(project));
    const path = selected?.preferredPath;
    if (!selected || !path) {
      if (requested || typeof selectedProjectId === 'string') {
        deps.selection.setSelection(null, selection.path);
        return { projectId: null, path: selection.path };
      }
      return { projectId: undefined, path: selection.path };
    }
    deps.selection.setSelection(selected.id, path);
    return { projectId: selected.id, path };
  }

  return {
    current,
    list: () => deps.catalog.list(),

    async add() {
      const path = await deps.chooseDirectory();
      if (!path) return { ok: false, reason: 'cancelled' };
      const project = await deps.catalog.register(path);
      const selected = await deps.catalog.select(project.id);
      deps.selection.setSelection(selected.project.id, selected.path);
      return { ok: true, project: selected.project, path: selected.path };
    },

    async select(projectId) {
      if (projectId === null) {
        const selection = await deps.selection.currentSelection();
        deps.selection.setSelection(null, selection.path);
        return { project: null, path: selection.path };
      }
      const selected = await deps.catalog.select(requireProjectId(projectId));
      deps.selection.setSelection(selected.project.id, selected.path);
      return selected;
    },

    async relink(projectId) {
      const id = requireProjectId(projectId);
      const path = await deps.chooseDirectory();
      if (!path) return { ok: false, reason: 'cancelled' };
      let selectedProjectWasRelinked = false;
      const prepareSessions = async (context: {
        projectId: string;
        projectAliases: string[];
        destinationPath: string;
        previousLocations: Array<{ path: string }>;
        conflictingProjectId?: string;
        conflictingProjectAliases?: string[];
      }) => {
        const selectedPath = (await deps.selection.currentSelection()).path;
        selectedProjectWasRelinked = context.previousLocations.some(
          (location) => location.path === selectedPath,
        );
        const survivingIds = new Set([context.projectId, ...context.projectAliases]);
        const conflictingIds = new Set([
          ...(context.conflictingProjectId ? [context.conflictingProjectId] : []),
          ...(context.conflictingProjectAliases ?? []),
        ]);
        for (const header of await deps.sessions.listHeaders()) {
          if (header.projectId && survivingIds.has(header.projectId)) {
            await deps.sessions.updateHeader(header.id, {
              cwd: context.destinationPath,
              ...(header.projectId !== context.projectId
                ? { projectId: context.projectId }
                : {}),
            });
          } else if (header.projectId && conflictingIds.has(header.projectId)) {
            await deps.sessions.updateHeader(header.id, { projectId: context.projectId });
          }
        }
      };
      const project = await deps.catalog.relink(id, path, prepareSessions);
      if (selectedProjectWasRelinked && project.preferredPath) {
        deps.selection.setSelection(project.id, project.preferredPath);
      }
      return { ok: true, project };
    },

    rename(projectId, name) {
      const trimmed = typeof name === 'string' ? name.trim() : '';
      if (!trimmed) throw new TypeError('Invalid project name.');
      return deps.catalog.rename(requireProjectId(projectId), trimmed);
    },

    async archive(projectId) {
      const project = await deps.catalog.archive(requireProjectId(projectId));
      await current();
      return project;
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
