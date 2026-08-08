import { isProjectPathMismatchError, type ProjectCatalog } from '@maka/storage';

export type SessionProjectInput = {
  readonly cwd?: string;
  readonly projectId?: string | null;
};

export async function resolveDesktopSessionSelection<T extends SessionProjectInput>(
  input: T,
  selection: {
    current(): Promise<{ projectId: string | null | undefined; path: string }>;
    select(projectId: unknown): Promise<{ project: { id: string } | null; path: string }>;
  },
): Promise<T & { cwd: string; projectId?: string | null }> {
  if (input.cwd) return { ...input, cwd: input.cwd };

  if (input.projectId !== undefined) {
    const selected = await selection.select(input.projectId);
    return {
      ...input,
      cwd: selected.path,
      projectId: selected.project?.id ?? null,
    };
  }

  const selected = await selection.current();
  return {
    ...input,
    cwd: selected.path,
    projectId: selected.projectId,
  };
}

export async function resolveNewSessionProjectInput<T extends SessionProjectInput & { cwd: string }>(
  input: T,
  catalog: Pick<ProjectCatalog, 'list' | 'register' | 'touch'>,
): Promise<T & { cwd: string; projectId?: string | null }> {
  if (input.projectId === null) return input;

  if (input.projectId) {
    const requestedId = input.projectId;
    const project = (await catalog.list()).find(
      (candidate) => candidate.id === requestedId || candidate.aliases?.includes(requestedId),
    );
    if (!project) throw projectMismatch(requestedId);
    if (project.archivedAt !== undefined) throw new Error(`Project is archived: ${requestedId}`);
    if (!project.available) throw new Error(`Project is unavailable: ${requestedId}`);
    try {
      const touched = await catalog.touch(project.id, input.cwd);
      return {
        ...input,
        cwd: touched.preferredPath ?? input.cwd,
        projectId: touched.id,
      };
    } catch (error) {
      if (!isProjectPathMismatchError(error)) throw error;
      throw projectMismatch(requestedId);
    }
  }

  const project = await catalog.register(input.cwd);
  if (project.archivedAt !== undefined) throw new Error(`Project is archived: ${project.id}`);
  return {
    ...input,
    cwd: project.preferredPath ?? input.cwd,
    projectId: project.id,
  };
}

function projectMismatch(projectId: string): Error {
  return new Error(`Project does not match the selected directory: ${projectId}`);
}
