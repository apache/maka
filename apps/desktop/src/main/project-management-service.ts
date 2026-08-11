import type { ProjectRecord } from '@maka/core/project';
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
  /**
   * The on-disk path of a catalogued project, for surfaces that need to open
   * it. Returns null when the project is unknown, archived, or its folder is
   * gone, so a caller cannot reveal something the catalog no longer vouches
   * for. Deliberately takes an id rather than a path: the renderer never gets
   * to name an arbitrary directory for the main process to open.
   */
  pathFor(projectId: unknown): Promise<string | null>;
  rename(projectId: unknown, name: unknown): Promise<ProjectRecord>;
  archive(projectId: unknown): Promise<ProjectRecord>;
  restore(projectId: unknown): Promise<ProjectRecord>;
}

export interface ProjectManagementCatalog {
  list(): Promise<ProjectRecord[]>;
  register(path: string): Promise<ProjectRecord>;
  relink(projectId: string, path: string): Promise<ProjectRecord>;
  rename(projectId: string, name: string): Promise<ProjectRecord>;
  archive(projectId: string): Promise<ProjectRecord>;
  restore(projectId: string): Promise<ProjectRecord>;
}

export function createProjectManagementService(deps: {
  catalog: ProjectManagementCatalog;
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
        ? selectableProject(projects, selectedProjectId)
        : undefined;
    if (!requested) {
      if (typeof selectedProjectId === 'string') {
        deps.selection.setSelection(null, selection.path);
        return { projectId: null, path: selection.path };
      }
      return { projectId: undefined, path: selection.path };
    }
    deps.selection.setSelection(requested.id, requested.preferredPath);
    return { projectId: requested.id, path: requested.preferredPath };
  }

  return {
    current,
    list: () => deps.catalog.list(),

    async add() {
      const path = await deps.chooseDirectory();
      if (!path) return { ok: false, reason: 'cancelled' };
      const project = await deps.catalog.register(path);
      const selected = requireSelectableProject(project);
      deps.selection.setSelection(selected.id, selected.preferredPath);
      return { ok: true, project: selected, path: selected.preferredPath };
    },

    async select(projectId) {
      if (projectId === null) {
        const selection = await deps.selection.currentSelection();
        deps.selection.setSelection(null, selection.path);
        return { project: null, path: selection.path };
      }
      const id = requireProjectId(projectId);
      const selection = await deps.selection.currentSelection();
      const project = selectableProject(await deps.catalog.list(), id);
      if (!project) {
        return { project: null, path: selection.path };
      }
      deps.selection.setSelection(project.id, project.preferredPath);
      return { project, path: project.preferredPath };
    },

    async relink(projectId) {
      const id = requireProjectId(projectId);
      const path = await deps.chooseDirectory();
      if (!path) return { ok: false, reason: 'cancelled' };
      const selection = await deps.selection.currentSelection();
      const selectedProjectWasRelinked = selection.projectId === id;
      const project = await deps.catalog.relink(id, path);
      if (selectedProjectWasRelinked) {
        const selected = requireSelectableProject(project);
        deps.selection.setSelection(selected.id, selected.preferredPath);
      }
      return { ok: true, project };
    },

    async pathFor(projectId) {
      const id = requireProjectId(projectId);
      const project = selectableProject(await deps.catalog.list(), id);
      return project?.preferredPath ?? null;
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

function selectableProject(
  projects: readonly ProjectRecord[],
  id: string,
): (ProjectRecord & { readonly preferredPath: string }) | undefined {
  const project = projects.find(
    (candidate) => candidate.id === id || candidate.aliases?.includes(id),
  );
  return isSelectableProject(project) ? project : undefined;
}

function requireSelectableProject(
  project: ProjectRecord,
): ProjectRecord & { readonly preferredPath: string } {
  const selected = selectableProject([project], project.id);
  if (!selected) throw new Error(`Project is unavailable: ${project.id}`);
  return selected;
}

function isSelectableProject(
  project: ProjectRecord | undefined,
): project is ProjectRecord & { readonly preferredPath: string } {
  return Boolean(project?.available && project.archivedAt === undefined && project.preferredPath);
}
