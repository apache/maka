import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { findProjectByIdentity, type ProjectRecord } from '@maka/core/project';
import {
  type ProjectCatalog,
  ProjectArchivedError,
  ProjectNotFoundError,
  ProjectPathMismatchError,
  ProjectUnavailableError,
} from '@maka/storage';
import type { WorkspaceTarget } from '../protocol/index.js';
import type { HostProjectMembershipGate } from './project-membership-gate.js';

export type WorkspaceResolutionErrorCode = 'invalid_request' | 'not_found' | 'operation_conflict';

export class WorkspaceResolutionError extends Error {
  constructor(
    readonly code: WorkspaceResolutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceResolutionError';
  }
}

export type ResolvedWorkspace =
  | {
      readonly target: Extract<WorkspaceTarget, { readonly kind: 'host_path' }>;
      readonly cwd: string;
      readonly projectId: null;
    }
  | {
      readonly target: Extract<WorkspaceTarget, { readonly kind: 'project' }>;
      readonly cwd: string;
      readonly projectId: string;
      readonly project: ProjectRecord;
    };

export class HostWorkspaceResolver {
  constructor(
    private readonly catalog: Pick<ProjectCatalog, 'list' | 'touch'>,
    private readonly membership: HostProjectMembershipGate,
    private readonly onProjectChanged: () => void,
  ) {}

  resolve(target: WorkspaceTarget): Promise<ResolvedWorkspace> {
    return this.run(target, async (workspace) => workspace);
  }

  run<Result>(
    target: WorkspaceTarget,
    operation: (workspace: ResolvedWorkspace) => Promise<Result>,
  ): Promise<Result> {
    return this.membership.run(async () => operation(await this.#resolve(target)));
  }

  runWithUsageRecorded<Result>(
    target: WorkspaceTarget,
    operation: (workspace: ResolvedWorkspace) => Promise<Result>,
  ): Promise<Result> {
    return this.membership.run(async () => {
      const workspace = await this.#resolve(target);
      if (workspace.projectId !== null) {
        try {
          await this.catalog.touch(workspace.projectId, workspace.cwd);
        } catch (error) {
          if (error instanceof ProjectNotFoundError) {
            throw new WorkspaceResolutionError('not_found', error.message);
          }
          if (
            error instanceof ProjectArchivedError ||
            error instanceof ProjectUnavailableError ||
            error instanceof ProjectPathMismatchError
          ) {
            throw new WorkspaceResolutionError('operation_conflict', error.message);
          }
          throw error;
        }
        this.onProjectChanged();
      }
      return operation(workspace);
    });
  }

  async #resolve(target: WorkspaceTarget): Promise<ResolvedWorkspace> {
    if (target.kind === 'host_path') {
      const cwd = await canonicalHostDirectory(target.path);
      return { target: { kind: 'host_path', path: cwd }, cwd, projectId: null };
    }

    const project = findProjectByIdentity(await this.catalog.list(), target.projectId);
    if (!project) {
      throw new WorkspaceResolutionError(
        'not_found',
        `Project does not exist: ${target.projectId}`,
      );
    }
    if (project.archivedAt !== undefined) {
      throw new WorkspaceResolutionError(
        'operation_conflict',
        `Project is archived: ${target.projectId}`,
      );
    }
    if (!project.available || !project.preferredPath) {
      throw new WorkspaceResolutionError(
        'operation_conflict',
        `Project is unavailable: ${target.projectId}`,
      );
    }
    return {
      target: { kind: 'project', projectId: project.id },
      cwd: project.preferredPath,
      projectId: project.id,
      project,
    };
  }
}

async function canonicalHostDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new WorkspaceResolutionError('invalid_request', 'Workspace Host path must be absolute');
  }
  try {
    const canonical = await realpath(resolve(path));
    if ((await stat(canonical)).isDirectory()) return canonical;
  } catch {
    // Project a stable request error below.
  }
  throw new WorkspaceResolutionError(
    'invalid_request',
    'Workspace Host path is not an existing directory',
  );
}
