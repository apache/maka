import type { CreateSessionInput } from '@maka/core';
import { isProjectPathMismatchError, type ProjectCatalog } from '@maka/storage';

export type DesktopCreateSessionInput = Omit<CreateSessionInput, 'cwd'> & {
  cwd?: string;
};

export async function resolveDesktopSessionSelection(
  input: DesktopCreateSessionInput,
  selection: {
    current(): Promise<{
      projectId: string | null | undefined;
      path: string;
    }>;
    select(
      projectId: unknown,
    ): Promise<{ project: { id: string } | null; path: string }>;
  },
): Promise<CreateSessionInput> {
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

export async function resolveNewSessionProjectInput(
  input: CreateSessionInput,
  catalog: Pick<ProjectCatalog, 'list' | 'register' | 'touch'>,
): Promise<CreateSessionInput> {
  if (input.projectId === null) {
    return input;
  }

  if (input.projectId) {
    const project = (await catalog.list()).find(
      (candidate) =>
        candidate.id === input.projectId || candidate.aliases?.includes(input.projectId!),
    );
    if (!project) throw new Error(`Project does not match the selected directory: ${input.projectId}`);
    if (project.archivedAt !== undefined) throw new Error(`Project is archived: ${input.projectId}`);
    if (!project.available) throw new Error(`Project is unavailable: ${input.projectId}`);
    try {
      const touched = await catalog.touch(project.id, input.cwd);
      return {
        ...input,
        cwd: touched.preferredPath ?? input.cwd,
        projectId: touched.id,
      };
    } catch (error) {
      if (!isProjectPathMismatchError(error)) throw error;
      throw new Error(`Project does not match the selected directory: ${input.projectId}`);
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
