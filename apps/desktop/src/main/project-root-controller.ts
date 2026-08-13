import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolveProjectRoot } from '@maka/runtime/system-prompt/project-context';

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
  setSelection(projectId: string | null, projectPath: string): Promise<void>;
}

export interface ProjectRootControllerDeps {
  readonly rootId: string;
  readonly preferenceFile: string;
  readonly fallbackRoots: () => string[];
}

interface ProjectPreferenceFile {
  readonly version: 1;
  readonly selections: Readonly<Record<string, string | null>>;
}

const preferenceWriteTails = new Map<string, Promise<void>>();

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

  function setSelection(projectId: string | null, projectPath: string): Promise<void> {
    selectedProject = { projectId, path: projectPath };
    return persistSelection(deps, projectId);
  }

  return { current, currentSelection, resolveExplicit, setSelection };
}

async function loadInitialSelection(
  deps: ProjectRootControllerDeps,
): Promise<CurrentProjectSelection> {
  const fallbackPath = await resolveProjectRoot(deps.fallbackRoots());
  const preference = await readPreference(deps.preferenceFile, deps.rootId);
  return { projectId: preference, path: fallbackPath };
}

async function persistSelection(
  deps: ProjectRootControllerDeps,
  projectId: string | null,
): Promise<void> {
  await savePreference(deps, projectId);
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

async function savePreference(
  deps: ProjectRootControllerDeps,
  projectId: string | null,
): Promise<boolean> {
  return enqueuePreferenceWrite(deps.preferenceFile, async () => {
    try {
      const current = await readPreferenceFile(deps.preferenceFile);
      await writePreferenceFile(deps.preferenceFile, {
        version: 1,
        selections: { ...current.selections, [deps.rootId]: projectId },
      });
      return true;
    } catch {
      // Selection persistence is best-effort and never blocks the active window.
      return false;
    }
  });
}

function enqueuePreferenceWrite<Result>(
  file: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  const previous = preferenceWriteTails.get(file) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  preferenceWriteTails.set(file, tail);
  void tail.then(() => {
    if (preferenceWriteTails.get(file) === tail) preferenceWriteTails.delete(file);
  });
  return result;
}

async function writePreferenceFile(file: string, value: ProjectPreferenceFile): Promise<void> {
  const temporaryFile = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryFile, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryFile, file);
  } catch (error) {
    await rm(temporaryFile, { force: true }).catch(() => undefined);
    throw error;
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
