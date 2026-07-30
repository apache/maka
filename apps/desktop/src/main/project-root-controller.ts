import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolveProjectRoot } from '@maka/runtime';

export interface CurrentProjectSelection {
  projectId: string | null | undefined;
  path: string;
}

/**
 * Owns the "current project root" selection shared across the app/window,
 * git, workspace-search, workspace-instructions, and session-entry IPC
 * surfaces. Project management updates the project id and path together, and
 * every other surface reads that same selection snapshot.
 *
 * Extracted from the former `registerIpc()` closures so the state has one owner
 * once the handlers are split across modules.
 */
export interface ProjectRootController {
  /** Resolve the effective project root (selected → persisted → fallback). */
  current(): Promise<string>;
  /** Resolve the selected project association and its effective root together. */
  currentSelection(): Promise<CurrentProjectSelection>;
  /** Validate + resolve an explicit renderer-supplied path without selecting it. */
  resolveExplicit(
    projectPath: unknown,
  ): Promise<
    | { ok: true; projectPath: string }
    | { ok: false; reason: 'invalid-path' | 'not-found' }
  >;
  /** Adopt a project association and resolved root as one persisted selection. */
  setSelection(projectId: string | null, projectPath: string): void;
}

export interface ProjectRootControllerDeps {
  /** Absolute path of the JSON file that persists the last selected project. */
  lastProjectPathFile: string;
  /** Roots probed (in order) when nothing is selected or persisted. */
  fallbackRoots: () => string[];
}

export function createProjectRootController(
  deps: ProjectRootControllerDeps,
): ProjectRootController {
  let selectedProject: CurrentProjectSelection | null = null;

  async function loadPersistedProjectRoot(): Promise<CurrentProjectSelection | null> {
    try {
      const raw = await readFile(deps.lastProjectPathFile, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.projectPath === 'string' && parsed.projectPath) {
        await stat(parsed.projectPath);
        return {
          projectId:
            typeof parsed.projectId === 'string' || parsed.projectId === null
              ? parsed.projectId
              : undefined,
          path: await resolveProjectRoot([parsed.projectPath]),
        };
      }
    } catch {
      // File missing, invalid, or points at a deleted directory.
    }
    return null;
  }
  const persistedProjectRootPromise = loadPersistedProjectRoot();

  async function saveLastProjectPath(
    projectPath: string,
    projectId: string | null | undefined,
  ): Promise<void> {
    try {
      await writeFile(
        deps.lastProjectPathFile,
        JSON.stringify({
          projectPath,
          ...(projectId !== undefined ? { projectId } : {}),
        }),
        'utf8',
      );
    } catch {
      // Best-effort; failure should not block the selection.
    }
  }

  async function current(): Promise<string> {
    return (await currentSelection()).path;
  }

  async function currentSelection(): Promise<CurrentProjectSelection> {
    if (selectedProject) return selectedProject;
    const persistedProjectRoot = await persistedProjectRootPromise;
    if (persistedProjectRoot) return (selectedProject = persistedProjectRoot);
    return {
      projectId: undefined,
      path: await resolveProjectRoot(deps.fallbackRoots()),
    };
  }

  async function resolveExplicit(projectPath: unknown): Promise<
    | { ok: true; projectPath: string }
    | { ok: false; reason: 'invalid-path' | 'not-found' }
  > {
    if (typeof projectPath !== 'string' || !projectPath) {
      return { ok: false, reason: 'invalid-path' };
    }
    try {
      await stat(projectPath);
    } catch {
      return { ok: false, reason: 'not-found' };
    }
    return { ok: true, projectPath: await resolveProjectRoot([projectPath]) };
  }

  function setSelection(projectId: string | null, projectPath: string): void {
    selectedProject = { projectId, path: projectPath };
    void saveLastProjectPath(projectPath, projectId);
  }

  return { current, currentSelection, resolveExplicit, setSelection };
}
