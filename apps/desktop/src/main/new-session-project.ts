import type { CreateSessionInput } from '@maka/core';
import { isProjectPathMismatchError, type ProjectCatalog } from '@maka/storage';

export async function resolveNewSessionProjectInput(
  input: CreateSessionInput,
  catalog: Pick<ProjectCatalog, 'list' | 'register' | 'touch'>,
): Promise<CreateSessionInput> {
  if (input.projectId === null) {
    return input;
  }

  if (input.projectId) {
    const project = (await catalog.list()).find((candidate) => candidate.id === input.projectId);
    if (!project) throw new Error(`Project does not match the selected directory: ${input.projectId}`);
    if (project.archivedAt !== undefined) throw new Error(`Project is archived: ${input.projectId}`);
    if (!project.available) throw new Error(`Project is unavailable: ${input.projectId}`);
    try {
      await catalog.touch(project.id, input.cwd);
    } catch (error) {
      if (!isProjectPathMismatchError(error)) throw error;
      throw new Error(`Project does not match the selected directory: ${input.projectId}`);
    }
    return input;
  }

  const project = await catalog.register(input.cwd);
  if (project.archivedAt !== undefined) throw new Error(`Project is archived: ${project.id}`);
  return { ...input, projectId: project.id };
}
