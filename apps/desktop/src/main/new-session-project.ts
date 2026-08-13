import type { ProjectCatalog } from '@maka/storage';
import type { WorkspaceTarget } from '@maka/runtime-host/protocol';

export interface DesktopSessionWorkspaceInput {
  readonly cwd?: string;
  readonly projectId?: string | null;
}

interface DesktopSessionWorkspaceSelection {
  current(): Promise<{ projectId: string | null | undefined; path: string }>;
  select(projectId: unknown): Promise<{ project: { id: string } | null; path: string }>;
  defaultProjectId?(): Promise<string | undefined>;
}

export async function resolveDesktopSessionWorkspace(
  input: DesktopSessionWorkspaceInput,
  selection: DesktopSessionWorkspaceSelection,
  catalog: Pick<ProjectCatalog, 'register'>,
  options: { readonly allowHostPath?: boolean } = {},
): Promise<WorkspaceTarget> {
  if (input.cwd) {
    if (input.projectId === null) {
      if (options.allowHostPath === false) throw remoteProjectRequired();
      return { kind: 'host_path', path: input.cwd };
    }
    if (typeof input.projectId === 'string') {
      return { kind: 'project', projectId: input.projectId };
    }
    if (options.allowHostPath === false) throw remoteProjectRequired();
    return { kind: 'project', projectId: (await catalog.register(input.cwd)).id };
  }

  if (input.projectId !== undefined) {
    if (input.projectId === null) {
      if (options.allowHostPath === false) throw remoteProjectRequired();
      return { kind: 'host_path', path: (await selection.current()).path };
    }
    const selected = await selection.select(input.projectId);
    if (!selected.project) throw new Error(`Project does not exist: ${input.projectId}`);
    return { kind: 'project', projectId: selected.project.id };
  }

  const configuredDefault = await selection.defaultProjectId?.();
  if (configuredDefault !== undefined) {
    const selected = await selection.select(configuredDefault);
    if (selected.project) return { kind: 'project', projectId: selected.project.id };
  }

  const current = await selection.current();
  if (typeof current.projectId === 'string') {
    return { kind: 'project', projectId: current.projectId };
  }
  if (options.allowHostPath === false) throw remoteProjectRequired();
  return { kind: 'host_path', path: current.path };
}

function remoteProjectRequired(): Error {
  return new Error('Select a project from the remote Runtime Host first');
}
