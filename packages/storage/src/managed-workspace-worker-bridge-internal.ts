import {
  createManagedExecutionBoundary,
  createReadOnlyPermissionProfile,
  type ExecutionBoundary,
} from '@maka/core';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import {
  requireManagedWorkspaceExecutionScopeInternal,
  type ManagedWorkspaceExecutionScope,
} from './managed-workspace-execution-authority-internal.js';

export type ManagedWorkspaceReadOnlyOperation =
  | {
      readonly kind: 'read';
      readonly path: string;
      readonly offset?: number;
      readonly limit?: number;
    }
  | {
      readonly kind: 'glob';
      readonly path: string;
      readonly pattern: string;
      readonly limit?: number;
    }
  | {
      readonly kind: 'grep';
      readonly path: string;
      readonly pattern: string;
      readonly glob?: string;
      readonly maxCountPerFile: number;
      readonly limit: number;
      readonly timeoutMs: number;
    };

interface ManagedWorkspaceFilesystemWorkerInput {
  readonly operation: ManagedWorkspaceReadOnlyOperation;
  readonly cwd: string;
  readonly executionBoundary: ExecutionBoundary;
  readonly abortSignal?: AbortSignal;
}

export type ManagedWorkspaceReadOnlyResult =
  | { readonly kind: 'read'; readonly content: string }
  | {
      readonly kind: 'read_image';
      readonly base64: string;
      readonly mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    }
  | { readonly kind: 'glob'; readonly files: readonly string[] }
  | { readonly kind: 'grep'; readonly matches: readonly string[] };

export interface ManagedWorkspaceFilesystemWorker {
  /**
   * Resolves only after the one-shot filesystem operation and every process it
   * owns have reached a terminal lifecycle state. Implementations must not
   * return a detached filesystem effect to the caller. The production adapter
   * satisfies this contract through FilesystemWorkerClient; M1.2 admits only
   * read-only operations, so a host crash cannot leave a workspace mutation.
   */
  execute(input: ManagedWorkspaceFilesystemWorkerInput): Promise<ManagedWorkspaceReadOnlyResult>;
}

export type ManagedWorkspaceWorkerBridgeErrorCode = 'managed_workspace_operation_denied';

export class ManagedWorkspaceWorkerBridgeError extends Error {
  constructor(
    readonly code: ManagedWorkspaceWorkerBridgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ManagedWorkspaceWorkerBridgeError';
  }
}

export interface ManagedWorkspaceWorkerBridgeInternal {
  execute(
    scope: ManagedWorkspaceExecutionScope,
    operation: ManagedWorkspaceReadOnlyOperation,
    abortSignal?: AbortSignal,
  ): Promise<ManagedWorkspaceReadOnlyResult>;
}

/**
 * Owner-bound bridge from an opaque, revocable scope to the filesystem worker.
 * The caller never supplies or receives cwd. Runtime validation intentionally
 * repeats the TypeScript allowlist so JavaScript/forged inputs fail closed.
 */
export function createManagedWorkspaceWorkerBridgeInternal(
  ownerToken: object,
  worker: ManagedWorkspaceFilesystemWorker,
): ManagedWorkspaceWorkerBridgeInternal {
  const bridge: ManagedWorkspaceWorkerBridgeInternal = {
    async execute(
      scope: ManagedWorkspaceExecutionScope,
      operation: ManagedWorkspaceReadOnlyOperation,
      abortSignal?: AbortSignal,
    ) {
      if (!isReadOnlyOperation(operation)) {
        throw new ManagedWorkspaceWorkerBridgeError(
          'managed_workspace_operation_denied',
          'Managed workspace execution currently permits only Read, Glob, and Grep operations',
        );
      }
      const state = requireManagedWorkspaceExecutionScopeInternal(ownerToken, scope);
      if (state.workspaceEffect !== 'none') {
        throw new ManagedWorkspaceWorkerBridgeError(
          'managed_workspace_operation_denied',
          'Managed workspace execution scope does not permit filesystem mutation',
        );
      }
      const route = routeDependencyOperation(operation, state.cwd, state.dependencyRoot);
      const baseProfile = createReadOnlyPermissionProfile();
      const profile = state.dependencyRoot
        ? {
            ...baseProfile,
            name: 'custom' as const,
            fileSystem: {
              ...baseProfile.fileSystem,
              entries: [
                ...baseProfile.fileSystem.entries,
                {
                  kind: 'path' as const,
                  access: 'read' as const,
                  path: state.dependencyRoot,
                  match: 'subtree' as const,
                },
              ],
            },
          }
        : baseProfile;
      const result = await worker.execute({
        operation: route.operation,
        cwd: state.cwd,
        executionBoundary: createManagedExecutionBoundary(profile, 0),
        ...(abortSignal ? { abortSignal } : {}),
      });
      return remapDependencyResult(result, state.dependencyRoot, route.provenance);
    },
  };
  return Object.freeze(bridge);
}

function routeDependencyOperation(
  operation: ManagedWorkspaceReadOnlyOperation,
  cwd: string,
  dependencyRoot: string | undefined,
): {
  readonly operation: ManagedWorkspaceReadOnlyOperation;
  readonly provenance: 'workspace' | 'dependency';
} {
  if (!dependencyRoot) return Object.freeze({ operation, provenance: 'workspace' });
  let segments: string[];
  if (isAbsolute(operation.path)) {
    const logicalDependencyRoot = join(cwd, 'node_modules');
    const suffix = relative(logicalDependencyRoot, operation.path);
    if (suffix.startsWith('..') || isAbsolute(suffix)) {
      return Object.freeze({ operation, provenance: 'workspace' });
    }
    segments = suffix === '' ? [] : suffix.split(/[\\/]/u);
  } else {
    const portable = operation.path.replaceAll('\\', '/');
    const portableSegments = portable.split('/');
    if (portableSegments[0] !== 'node_modules') {
      return Object.freeze({ operation, provenance: 'workspace' });
    }
    segments = portableSegments.slice(1);
  }
  if (
    segments.some(
      (segment) =>
        segment === '..' ||
        segment === '' ||
        segment.includes(':') ||
        segment.includes('\0'),
    )
  ) {
    throw new ManagedWorkspaceWorkerBridgeError(
      'managed_workspace_operation_denied',
      'Managed dependency path is invalid',
    );
  }
  const routedPath = join(dependencyRoot, ...segments);
  if (!isPathWithin(routedPath, dependencyRoot)) {
    throw new ManagedWorkspaceWorkerBridgeError(
      'managed_workspace_operation_denied',
      'Managed dependency path escapes its environment',
    );
  }
  return Object.freeze({
    operation: Object.freeze({ ...operation, path: routedPath }),
    provenance: 'dependency' as const,
  });
}

function remapDependencyResult(
  result: ManagedWorkspaceReadOnlyResult,
  dependencyRoot: string | undefined,
  provenance: 'workspace' | 'dependency',
): ManagedWorkspaceReadOnlyResult {
  if (!dependencyRoot || provenance !== 'dependency') return result;
  if (result.kind === 'grep') {
    return Object.freeze({
      kind: 'grep',
      matches: result.matches.map((match) => remapDependencyPath(match, dependencyRoot)),
    });
  }
  if (result.kind === 'glob') {
    return Object.freeze({
      kind: 'glob',
      files: result.files.map((path) => remapDependencyPath(path, dependencyRoot)),
    });
  }
  return result;
}

function remapDependencyPath(path: string, dependencyRoot: string): string {
  if (!isAbsolute(path)) {
    return `node_modules/${path.replaceAll('\\', '/')}`;
  }
  const prefix = normalize(dependencyRoot);
  if (path !== prefix && !path.startsWith(`${prefix}${sep}`)) return path;
  return `node_modules${path.slice(prefix.length)}`.replaceAll('\\', '/');
}

function isPathWithin(candidate: string, root: string): boolean {
  const path = relative(normalize(root), normalize(candidate));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function isReadOnlyOperation(input: unknown): input is ManagedWorkspaceReadOnlyOperation {
  if (!input || typeof input !== 'object') return false;
  const kind = (input as { kind?: unknown }).kind;
  return kind === 'read' || kind === 'glob' || kind === 'grep';
}
