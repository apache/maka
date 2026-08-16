import {
  createManagedExecutionBoundary,
  type ExecutionBoundary,
} from '@maka/core/sandbox-boundary';
import { createReadOnlyPermissionProfile } from '@maka/core/permission-profile';
import { isAbsolute, join, normalize, parse, relative, sep } from 'node:path';
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
      const hasDependencyRoot = typeof state.dependencyRoot === 'string';
      if (
        state.workspaceEffect !== 'none' ||
        (state.provisioning === 'dependency_environment_v1') !== hasDependencyRoot
      ) {
        throw new ManagedWorkspaceWorkerBridgeError(
          'managed_workspace_operation_denied',
          'Managed workspace execution scope does not permit filesystem mutation',
        );
      }
      const routedOperation = routeDependencyOperation(operation, state.cwd, state.dependencyRoot);
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
        operation: routedOperation,
        cwd: state.cwd,
        executionBoundary: createManagedExecutionBoundary(profile, 0),
        ...(abortSignal ? { abortSignal } : {}),
      });
      return remapDependencyResult(result, state.dependencyRoot, routedOperation);
    },
  };
  return Object.freeze(bridge);
}

function routeDependencyOperation(
  operation: ManagedWorkspaceReadOnlyOperation,
  cwd: string,
  dependencyRoot: string | undefined,
): ManagedWorkspaceReadOnlyOperation {
  if (!dependencyRoot) return operation;
  let segments: string[];
  if (isAbsolute(operation.path)) {
    assertCanonicalPathSegments(operation.path.slice(parse(operation.path).root.length));
    const logicalDependencyRoot = join(cwd, 'node_modules');
    const suffix = relative(logicalDependencyRoot, operation.path);
    if (suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) return operation;
    segments = suffix === '' ? [] : suffix.split(/[\\/]/u);
  } else {
    const portableSegments = operation.path.replaceAll('\\', '/').split('/');
    assertCanonicalSegments(portableSegments);
    if (!isNodeModulesSegment(portableSegments[0])) return operation;
    segments = portableSegments.slice(1);
  }
  assertCanonicalSegments(segments, { allowEmpty: true });
  const routedPath = join(dependencyRoot, ...segments);
  if (!isPathWithin(routedPath, dependencyRoot)) {
    throw new ManagedWorkspaceWorkerBridgeError(
      'managed_workspace_operation_denied',
      'Managed dependency path escapes its environment',
    );
  }
  return Object.freeze({ ...operation, path: routedPath });
}

function assertCanonicalPathSegments(path: string): void {
  assertCanonicalSegments(path.replaceAll('\\', '/').split('/'), { allowEmpty: true });
}

function assertCanonicalSegments(
  segments: readonly string[],
  options: { readonly allowEmpty?: boolean } = {},
): void {
  if (
    (!options.allowEmpty && segments.length === 0) ||
    segments.some(
      (segment) =>
        segment === '..' ||
        segment === '.' ||
        segment === '' ||
        segment.includes('\0') ||
        segment.includes(':'),
    )
  ) {
    throw new ManagedWorkspaceWorkerBridgeError(
      'managed_workspace_operation_denied',
      'Managed dependency path is invalid',
    );
  }
}

function isNodeModulesSegment(segment: string | undefined): boolean {
  if (segment === undefined) return false;
  return process.platform === 'win32'
    ? segment.toLowerCase() === 'node_modules'
    : segment === 'node_modules';
}

function remapDependencyResult(
  result: ManagedWorkspaceReadOnlyResult,
  dependencyRoot: string | undefined,
  routedOperation: ManagedWorkspaceReadOnlyOperation,
): ManagedWorkspaceReadOnlyResult {
  if (!dependencyRoot) return result;
  if (result.kind === 'grep') {
    return Object.freeze({
      kind: 'grep',
      matches: result.matches.map((match) => remapDependencyPath(match, dependencyRoot)),
    });
  }
  if (result.kind === 'glob') {
    return Object.freeze({
      kind: 'glob',
      files: result.files.map((path) =>
        remapDependencyGlobPath(path, dependencyRoot, routedOperation),
      ),
    });
  }
  return result;
}

function remapDependencyGlobPath(
  path: string,
  dependencyRoot: string,
  routedOperation: ManagedWorkspaceReadOnlyOperation,
): string {
  const absolute = remapDependencyPath(path, dependencyRoot);
  if (absolute !== path || isAbsolute(path) || routedOperation.kind !== 'glob') return absolute;
  if (!isPathWithin(routedOperation.path, dependencyRoot)) return path;

  const relativeOperationRoot = relative(dependencyRoot, routedOperation.path);
  const operationSegments =
    relativeOperationRoot === '' ? [] : relativeOperationRoot.split(/[\\/]/u);
  const resultSegments = path.replaceAll('\\', '/').split('/');
  assertCanonicalSegments(operationSegments, { allowEmpty: true });
  assertCanonicalSegments(resultSegments);
  return ['node_modules', ...operationSegments, ...resultSegments].join('/');
}

function remapDependencyPath(path: string, dependencyRoot: string): string {
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
