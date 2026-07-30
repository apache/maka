/**
 * Shared ApplyPatch planner + settlement (#1552).
 *
 * Hosts supply a filesystem adapter; this module owns path safety, locking
 * order, preflight-under-lock, mutation, and result projection so Runtime and
 * Headless cannot drift.
 */
import {
  applyUpdateChunksToContent,
  assertSafePatchPath,
  collectPatchPaths,
  parseApplyPatch,
  type ApplyPatchHunk,
} from '@maka/core/apply-patch';
import { posix as pathPosix } from 'node:path';

/** Write/delete intent used for permission preflight before any mutation. */
export type ApplyPatchAccessIntent =
  | { access: 'write'; path: string }
  | { access: 'delete'; path: string };

export interface ApplyPatchFsAdapter {
  /** Stable exclusive lock key for a relative path (may not exist yet). */
  lockKey(path: string): Promise<string>;
  pathExists(path: string): Promise<boolean>;
  readText(path: string, label: string): Promise<string>;
  writeText(path: string, content: string): Promise<{ path: string; bytes: number }>;
  deletePath(path: string): Promise<{ path: string }>;
  /**
   * Optional: assert every planned mutation path is currently permitted.
   * Must not mutate. Throws structured permission/sandbox errors (including
   * `requiredExpansion`) so ToolRuntime can offer boundary retry before any write.
   */
  preflightPermissions?(accesses: readonly ApplyPatchAccessIntent[]): Promise<void>;
}

export interface ApplyPatchOperationResult {
  operation: 'add' | 'update' | 'delete' | 'move';
  path: string;
  fromPath?: string;
  status: 'completed' | 'failed' | 'skipped';
  error?: string;
  bytes?: number;
}

export interface ApplyPatchEngineResult {
  ok: boolean;
  operations: ApplyPatchOperationResult[];
  completed: string[];
  uncompleted: string[];
  error?: string;
  partial?: boolean;
}

type PreparedStep =
  | { kind: 'add'; path: string; content: string }
  | { kind: 'update'; path: string; content: string }
  | { kind: 'move'; path: string; fromPath: string; content: string }
  | { kind: 'delete'; path: string };

/**
 * Parse, plan, lock, revalidate, and settle a Codex ApplyPatch envelope.
 * All filesystem reads used for matching and existence checks run under the
 * acquired path locks so concurrent writers cannot race the plan.
 *
 * Permission coverage for every mutation path is checked before the first
 * write/delete when the adapter implements `preflightPermissions`. Structured
 * sandbox/boundary errors rethrow so hosts keep `requiredExpansion`.
 */
export async function executeApplyPatchWithAdapter(
  patchText: string,
  fs: ApplyPatchFsAdapter,
  withLock: <T>(key: string, run: () => Promise<T>) => Promise<T>,
): Promise<ApplyPatchEngineResult> {
  const parsed = parseApplyPatch(patchText);
  if (!parsed.ok) {
    const message =
      parsed.error.code === 'invalid_hunk'
        ? `ApplyPatch parse error at line ${parsed.error.lineNumber}: ${parsed.error.message}`
        : `ApplyPatch parse error: ${parsed.error.message}`;
    throw new Error(message);
  }

  for (const path of collectPatchPaths(parsed.value.hunks)) {
    const pathError = assertSafePatchPath(path);
    if (pathError) {
      throw new Error(`ApplyPatch rejected path ${JSON.stringify(path)}: ${pathError}`);
    }
  }
  const hunks = parsed.value.hunks.map(canonicalizeHunkPaths);

  const lockKeySet = new Set<string>();
  for (const path of collectPatchPaths(hunks)) {
    lockKeySet.add(await fs.lockKey(path));
  }
  const orderedKeys = [...lockKeySet].sort();

  const run = async (): Promise<ApplyPatchEngineResult> => {
    const prepared = await planUnderLocks(hunks, fs);
    if (fs.preflightPermissions) {
      await fs.preflightPermissions(collectAccessIntents(prepared));
    }
    return settlePrepared(prepared, fs);
  };

  return withNestedLocks(orderedKeys, withLock, run);
}

function canonicalizeHunkPaths(hunk: ApplyPatchHunk): ApplyPatchHunk {
  const path = canonicalPatchPath(hunk.path);
  if (hunk.kind === 'add') return { ...hunk, path };
  if (hunk.kind === 'delete') return { ...hunk, path };
  return {
    ...hunk,
    path,
    ...(hunk.movePath ? { movePath: canonicalPatchPath(hunk.movePath) } : {}),
  };
}

function canonicalPatchPath(path: string): string {
  return pathPosix.normalize(path.replaceAll('\\', '/').trim());
}

function collectAccessIntents(prepared: readonly PreparedStep[]): ApplyPatchAccessIntent[] {
  const byKey = new Map<string, ApplyPatchAccessIntent>();
  for (const step of prepared) {
    if (step.kind === 'add' || step.kind === 'update') {
      byKey.set(`write:${step.path}`, { access: 'write', path: step.path });
      continue;
    }
    if (step.kind === 'delete') {
      byKey.set(`delete:${step.path}`, { access: 'delete', path: step.path });
      continue;
    }
    // move: destination write + source delete
    byKey.set(`write:${step.path}`, { access: 'write', path: step.path });
    byKey.set(`delete:${step.fromPath}`, { access: 'delete', path: step.fromPath });
  }
  return [...byKey.values()];
}

async function planUnderLocks(
  hunks: readonly ApplyPatchHunk[],
  fs: ApplyPatchFsAdapter,
): Promise<PreparedStep[]> {
  const prepared: PreparedStep[] = [];
  // Track planned creates so later hunks in the same patch see them.
  const plannedCreates = new Set<string>();
  const plannedDeletes = new Set<string>();

  for (const hunk of hunks) {
    if (hunk.kind === 'add') {
      if (plannedCreates.has(hunk.path) || (await fs.pathExists(hunk.path))) {
        throw new Error(`ApplyPatch Add File target already exists: ${hunk.path}`);
      }
      prepared.push({ kind: 'add', path: hunk.path, content: hunk.contents });
      plannedCreates.add(hunk.path);
      continue;
    }

    if (hunk.kind === 'delete') {
      if (plannedDeletes.has(hunk.path)) {
        throw new Error(`ApplyPatch Delete File target missing: ${hunk.path}`);
      }
      if (!plannedCreates.has(hunk.path) && !(await fs.pathExists(hunk.path))) {
        throw new Error(`ApplyPatch Delete File target missing: ${hunk.path}`);
      }
      prepared.push({ kind: 'delete', path: hunk.path });
      plannedDeletes.add(hunk.path);
      plannedCreates.delete(hunk.path);
      continue;
    }

    // update (+ optional move)
    if (plannedDeletes.has(hunk.path)) {
      throw new Error(`ApplyPatch Update File target missing: ${hunk.path}`);
    }
    let original: string;
    if (plannedCreates.has(hunk.path)) {
      const prior = [...prepared]
        .reverse()
        .find(
          (step) =>
            (step.kind === 'add' || step.kind === 'update' || step.kind === 'move') &&
            step.path === hunk.path,
        );
      if (!prior || prior.kind === 'delete') {
        throw new Error(`ApplyPatch Update File target missing: ${hunk.path}`);
      }
      original = prior.content;
    } else {
      original = await fs.readText(hunk.path, 'ApplyPatch Update');
    }

    const applied = applyUpdateChunksToContent(original, hunk.chunks, hunk.path);
    if (!applied.ok) throw new Error(applied.error.message);

    if (hunk.movePath) {
      if (
        plannedCreates.has(hunk.movePath) ||
        (!plannedDeletes.has(hunk.movePath) && (await fs.pathExists(hunk.movePath)))
      ) {
        throw new Error(`ApplyPatch Move destination already exists: ${hunk.movePath}`);
      }
      prepared.push({
        kind: 'move',
        path: hunk.movePath,
        fromPath: hunk.path,
        content: applied.content,
      });
      plannedCreates.add(hunk.movePath);
      plannedDeletes.add(hunk.path);
      plannedCreates.delete(hunk.path);
    } else {
      prepared.push({ kind: 'update', path: hunk.path, content: applied.content });
      plannedCreates.add(hunk.path);
    }
  }

  return prepared;
}

async function settlePrepared(
  prepared: readonly PreparedStep[],
  fs: ApplyPatchFsAdapter,
): Promise<ApplyPatchEngineResult> {
  const operations: ApplyPatchOperationResult[] = [];
  const completed: string[] = [];
  let failure: string | undefined;

  for (const step of prepared) {
    if (failure) {
      operations.push({
        operation: step.kind,
        path: step.path,
        ...(step.kind === 'move' ? { fromPath: step.fromPath } : {}),
        status: 'skipped',
      });
      continue;
    }

    try {
      if (step.kind === 'add' || step.kind === 'update') {
        const written = await fs.writeText(step.path, step.content);
        operations.push({
          operation: step.kind,
          path: written.path,
          status: 'completed',
          bytes: written.bytes,
        });
        completed.push(written.path);
        continue;
      }

      if (step.kind === 'delete') {
        const deleted = await fs.deletePath(step.path);
        operations.push({ operation: 'delete', path: deleted.path, status: 'completed' });
        completed.push(deleted.path);
        continue;
      }

      // move: write destination first, then delete source. A failed source
      // delete after a successful write is an explicit partial failure.
      const written = await fs.writeText(step.path, step.content);
      completed.push(written.path);
      try {
        await fs.deletePath(step.fromPath);
        operations.push({
          operation: 'move',
          path: written.path,
          fromPath: step.fromPath,
          status: 'completed',
          bytes: written.bytes,
        });
      } catch (error) {
        if (shouldRethrowBoundaryError(error, completed.length - 1)) {
          // Destination already written — treat as partial, not a clean rethrow.
        }
        failure = error instanceof Error ? error.message : String(error);
        operations.push({
          operation: 'move',
          path: written.path,
          fromPath: step.fromPath,
          status: 'failed',
          error: failure,
          bytes: written.bytes,
        });
      }
    } catch (error) {
      // Before any successful mutation, preserve structured sandbox errors so
      // ToolRuntime can surface requiredExpansion for boundary retry.
      if (shouldRethrowBoundaryError(error, completed.length)) {
        throw error;
      }
      failure = error instanceof Error ? error.message : String(error);
      operations.push({
        operation: step.kind,
        path: step.path,
        ...(step.kind === 'move' ? { fromPath: step.fromPath } : {}),
        status: 'failed',
        error: failure,
      });
    }
  }

  const uncompleted = operations
    .filter((op) => op.status !== 'completed')
    .map((op) =>
      op.operation === 'move' && op.status === 'failed' && op.bytes !== undefined && op.fromPath
        ? op.fromPath
        : op.path,
    );

  if (!failure) {
    return { ok: true, operations, completed, uncompleted: [] };
  }
  return {
    ok: false,
    partial: completed.length > 0,
    error: failure,
    operations,
    completed,
    uncompleted,
  };
}

/**
 * Boundary / permission errors must reach ToolRuntime when the workspace is
 * still clean (no completed mutations). Once a mutation has landed we keep the
 * partial-failure result shape instead.
 */
function shouldRethrowBoundaryError(error: unknown, completedCount: number): boolean {
  if (completedCount > 0) return false;
  if (!error || typeof error !== 'object') return false;
  const value = error as {
    requiredExpansion?: unknown;
    reason?: unknown;
    domain?: unknown;
  };
  if (value.requiredExpansion !== undefined) return true;
  if (value.domain === 'filesystem' && value.reason === 'sandbox_boundary_required') return true;
  return false;
}

async function withNestedLocks<T>(
  keys: readonly string[],
  withLock: <U>(key: string, run: () => Promise<U>) => Promise<U>,
  run: () => Promise<T>,
): Promise<T> {
  if (keys.length === 0) return run();
  const [head, ...rest] = keys;
  return withLock(head!, () => withNestedLocks(rest, withLock, run));
}
