import { isProjectPathMismatchError, type ProjectCatalog } from '@maka/storage';

export type SessionProjectInput = {
  readonly cwd?: string;
  readonly projectId?: string | null;
};

export async function resolveDesktopSessionSelection<T extends SessionProjectInput>(
  input: T,
  selection: {
    current(): Promise<{
      projectId: string | null | undefined;
      path: string;
    }>;
    select(
      projectId: unknown,
    ): Promise<{ project: { id: string } | null; path: string }>;
    /**
     * Settings -> 偏好 -> 项目 -> 默认项目, or undefined for "no preference".
     * Optional so the pure-selection callers and tests that predate the
     * setting keep their two-argument shape.
     */
    defaultProjectId?(): Promise<string | undefined>;
  },
): Promise<T & { cwd: string; projectId?: string | null }> {
  if (input.cwd) return { ...input, cwd: input.cwd };

  // An explicit project id is this conversation's own choice (the composer
  // picker) and outranks the configured default -- that override is the whole
  // reason the picker still exists once a default is set.
  if (input.projectId !== undefined) {
    const selected = await selection.select(input.projectId);
    return {
      ...input,
      cwd: selected.path,
      projectId: selected.project?.id ?? null,
    };
  }

  // No per-conversation choice: the configured default wins over the
  // last-used project. A default that only applied when nothing was
  // remembered would be a default in name only, since something is almost
  // always remembered.
  const configuredDefault = await selection.defaultProjectId?.();
  if (configuredDefault !== undefined) {
    try {
      const selected = await selection.select(configuredDefault);
      if (selected.project) {
        return { ...input, cwd: selected.path, projectId: selected.project.id };
      }
    } catch {
      // Archived, unavailable, or deleted since it was chosen. Creating the
      // session still has to succeed, so fall through to the last-used
      // project; the settings page is where that degradation is reported,
      // because a toast at session-create time would blame the wrong action.
    }
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
