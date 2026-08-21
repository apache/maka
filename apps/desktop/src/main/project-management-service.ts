import { findProjectByIdentity, type ProjectRecord } from '@maka/core/project';
import type {
  DesktopProjectCapabilities,
  DesktopProjectDirectoryEntry,
  DesktopProjectDirectoryRoot,
  DesktopProjectSnapshot,
} from '../preload/bridge-contract.js';
import type { CurrentProjectSelection } from './project-root-controller.js';

type DirectoryActionResult =
  | { ok: true; project: ProjectRecord }
  | { ok: false; reason: 'cancelled' };
type SelectedDirectoryActionResult =
  | { ok: true; project: ProjectRecord; path: string }
  | { ok: false; reason: 'cancelled' };

export interface ProjectManagementService {
  current(): Promise<CurrentProjectSelection>;
  getSnapshot(): Promise<DesktopProjectSnapshot>;
  add(options?: { select?: boolean }): Promise<SelectedDirectoryActionResult>;
  select(
    projectId: unknown,
  ): Promise<{ project: ProjectRecord | null; path: string }>;
  relink(projectId: unknown): Promise<DirectoryActionResult>;
  directoryRoots(): Promise<readonly DesktopProjectDirectoryRoot[]>;
  listDirectory(input: unknown): Promise<readonly DesktopProjectDirectoryEntry[]>;
  registerDirectory(input: unknown): Promise<ProjectRecord>;
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

export interface ProjectDirectoryCatalog {
  listDirectoryRoots(): Promise<readonly DesktopProjectDirectoryRoot[]>;
  listDirectories(
    rootId: string,
    segments: readonly string[],
  ): Promise<readonly DesktopProjectDirectoryEntry[]>;
  registerDirectory(rootId: string, segments: readonly string[]): Promise<ProjectRecord>;
}

export function createProjectManagementService(deps: {
  catalog: ProjectManagementCatalog;
  directoryCatalog?: ProjectDirectoryCatalog;
  chooseDirectory(): Promise<string | undefined>;
  selection: {
    currentSelection(): Promise<CurrentProjectSelection>;
    setSelection(projectId: string | null, projectPath: string): void;
  };
  capabilities: DesktopProjectCapabilities;
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
    const path = requested.preferredPath ?? selection.path;
    deps.selection.setSelection(requested.id, path);
    return { projectId: requested.id, path };
  }

  return {
    current,
    async getSnapshot() {
      return {
        projects: await deps.catalog.list(),
        capabilities: deps.capabilities,
      };
    },

    async add(options) {
      requireLocalDirectoryActions(deps);
      const path = await deps.chooseDirectory();
      if (!path) return { ok: false, reason: 'cancelled' };
      const project = await deps.catalog.register(path);
      const selected = requireSelectableProject(project);
      if (options?.select !== false) {
        deps.selection.setSelection(selected.id, selected.preferredPath);
      }
      return { ok: true, project: selected, path: selected.preferredPath };
    },

    async select(projectId) {
      if (projectId === null) {
        if (!deps.capabilities.selectNoProject) {
          throw new Error('The active Runtime Host requires a Project');
        }
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
      const path = project.preferredPath ?? selection.path;
      deps.selection.setSelection(project.id, path);
      return { project, path };
    },

    async relink(projectId) {
      requireLocalDirectoryActions(deps);
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

    directoryRoots() {
      return requireHostDirectoryActions(deps).listDirectoryRoots();
    },

    listDirectory(input) {
      const directory = requireDirectoryInput(input);
      return requireHostDirectoryActions(deps).listDirectories(
        directory.rootId,
        directory.segments,
      );
    },

    registerDirectory(input) {
      const directory = requireDirectoryInput(input);
      return requireHostDirectoryActions(deps).registerDirectory(
        directory.rootId,
        directory.segments,
      );
    },

    async pathFor(projectId) {
      if (!deps.capabilities.viewClientPath) return null;
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

function requireHostDirectoryActions(
  deps: {
    readonly capabilities: DesktopProjectCapabilities;
    readonly directoryCatalog?: ProjectDirectoryCatalog;
  },
): ProjectDirectoryCatalog {
  if (!deps.capabilities.chooseHostDirectory || !deps.directoryCatalog) {
    throw new Error('This Runtime Host does not publish project directories');
  }
  return deps.directoryCatalog;
}

function requireDirectoryInput(value: unknown): {
  readonly rootId: string;
  readonly segments: readonly string[];
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid project directory');
  }
  const input = value as { rootId?: unknown; segments?: unknown };
  if (
    typeof input.rootId !== 'string' ||
    !Array.isArray(input.segments) ||
    !input.segments.every((segment) => typeof segment === 'string')
  ) {
    throw new TypeError('Invalid project directory');
  }
  return { rootId: input.rootId, segments: input.segments };
}

function requireLocalDirectoryActions(
  deps: { readonly capabilities: DesktopProjectCapabilities },
): void {
  if (!deps.capabilities.chooseClientDirectory) {
    throw new Error('Remote Runtime Host projects must be registered on the Host');
  }
}

function requireProjectId(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new TypeError('Invalid project id.');
  return value;
}

function selectableProject(
  projects: readonly ProjectRecord[],
  id: string,
): ProjectRecord | undefined {
  const project = findProjectByIdentity(projects, id);
  return project?.available && project.archivedAt === undefined ? project : undefined;
}

function requireSelectableProject(
  project: ProjectRecord,
): ProjectRecord & { readonly preferredPath: string } {
  const selected = selectableProject([project], project.id);
  if (!selected?.preferredPath) throw new Error(`Project is unavailable: ${project.id}`);
  return selected as ProjectRecord & { readonly preferredPath: string };
}
