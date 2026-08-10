import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolveProjectRoot } from '@maka/runtime';

export interface CurrentProjectSelection {
  projectId: string | null | undefined;
  path: string;
}

export interface ProjectRootController {
  current(): Promise<string>;
  currentSelection(): Promise<CurrentProjectSelection>;
  resolveExplicit(
    projectPath: unknown,
  ): Promise<
    | { ok: true; projectPath: string }
    | { ok: false; reason: 'invalid-path' | 'not-found' }
  >;
  setSelection(projectId: string | null, projectPath: string): void;
}

export interface ProjectRootControllerDeps {
  readonly rootId: string;
  readonly preferenceFile: string;
  readonly legacySelectionFile: string;
  readonly fallbackRoots: () => string[];
}

interface ProjectPreferenceFile {
  readonly version: 1;
  readonly selections: Readonly<Record<string, string | null>>;
}

export function createProjectRootController(
  deps: ProjectRootControllerDeps,
): ProjectRootController {
  let selectedProject: CurrentProjectSelection | null = null;
  const initialSelection = loadInitialSelection(deps);

  async function currentSelection(): Promise<CurrentProjectSelection> {
    if (selectedProject) return selectedProject;
    return (selectedProject = await initialSelection);
  }

  async function current(): Promise<string> {
    return (await currentSelection()).path;
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
    void persistSelection(deps, projectId);
  }

  return { current, currentSelection, resolveExplicit, setSelection };
}

async function loadInitialSelection(
  deps: ProjectRootControllerDeps,
): Promise<CurrentProjectSelection> {
  const fallbackPath = await resolveProjectRoot(deps.fallbackRoots());
  const preference = await readPreference(deps.preferenceFile, deps.rootId);
  if (preference !== undefined) return { projectId: preference, path: fallbackPath };

  const legacy = await readLegacySelection(deps.legacySelectionFile);
  if (!legacy) return { projectId: undefined, path: fallbackPath };
  if (typeof legacy.projectId !== 'string') return legacy;
  if (!(await savePreference(deps, legacy.projectId))) {
    return legacy;
  }
  await rm(deps.legacySelectionFile, { force: true }).catch(() => undefined);
  return legacy;
}

async function persistSelection(
  deps: ProjectRootControllerDeps,
  projectId: string | null,
): Promise<void> {
  if (!(await savePreference(deps, projectId))) return;
  await rm(deps.legacySelectionFile, { force: true }).catch(() => undefined);
}

async function readPreference(file: string, rootId: string): Promise<string | null | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<ProjectPreferenceFile>;
    if (parsed.version !== 1 || !parsed.selections || typeof parsed.selections !== 'object') {
      return undefined;
    }
    const value = parsed.selections[rootId];
    return typeof value === 'string' || value === null ? value : undefined;
  } catch {
    return undefined;
  }
}

async function readLegacySelection(file: string): Promise<CurrentProjectSelection | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    if (typeof parsed.projectPath !== 'string' || !parsed.projectPath) return null;
    await stat(parsed.projectPath);
    return {
      projectId:
        typeof parsed.projectId === 'string' || parsed.projectId === null
          ? parsed.projectId
          : undefined,
      path: await resolveProjectRoot([parsed.projectPath]),
    };
  } catch {
    return null;
  }
}

async function savePreference(
  deps: ProjectRootControllerDeps,
  projectId: string | null,
): Promise<boolean> {
  try {
    const current = await readPreferenceFile(deps.preferenceFile);
    await writeFile(
      deps.preferenceFile,
      JSON.stringify({
        version: 1,
        selections: { ...current.selections, [deps.rootId]: projectId },
      } satisfies ProjectPreferenceFile),
      'utf8',
    );
    return true;
  } catch {
    // Selection persistence is best-effort and never blocks the active window.
    return false;
  }
}

async function readPreferenceFile(file: string): Promise<ProjectPreferenceFile> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<ProjectPreferenceFile>;
    if (parsed.version === 1 && parsed.selections && typeof parsed.selections === 'object') {
      return { version: 1, selections: parsed.selections as Record<string, string | null> };
    }
  } catch {
    // Start a new preference file below.
  }
  return { version: 1, selections: {} };
}
