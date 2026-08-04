/**
 * Shared ApplyPatch planner + settlement (#1552).
 *
 * Hosts supply a filesystem adapter; this module owns path safety, locking
 * order, preflight-under-lock, mutation, and result projection so Runtime and
 * Headless cannot drift.
 */
import {
  assertSafePatchPath,
  canonicalizeApplyPatchHunks,
  collectPatchPaths,
  parseApplyPatch,
  planApplyPatchMutations,
  type ApplyPatchPathState,
  type PlannedPatchMutation,
} from '@maka/core/apply-patch';

/** Write/delete intent used for permission preflight before any mutation. */
export type ApplyPatchAccessIntent =
  | { access: 'write'; path: string }
  | { access: 'delete'; path: string };

export interface ApplyPatchFsAdapter {
  /** Stable exclusive lock key for a relative path (may not exist yet). */
  lockKey(path: string): Promise<string>;
  /** Inspect the directory entry without following its final symlink. */
  lstat(path: string): Promise<'missing' | 'file' | 'directory' | 'symlink' | 'other'>;
  readText(path: string, label: string): Promise<string>;
  /**
   * Atomically create or replace a regular file. `create` must fail rather
   * than clobber an entry that appeared after planning.
   */
  writeText(
    path: string,
    content: string,
    mode: 'create' | 'replace',
  ): Promise<{ path: string; bytes: number }>;
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
  const hunks = canonicalizeApplyPatchHunks(parsed.value.hunks);

  const lockKeySet = new Set<string>();
  for (const path of collectPatchPaths(hunks)) {
    lockKeySet.add(await fs.lockKey(path));
  }
  const orderedKeys = [...lockKeySet].sort();

  const run = async (): Promise<ApplyPatchEngineResult> => {
    const state = new Map<string, ApplyPatchPathState>();
    for (const path of collectPatchPaths(hunks)) {
      if (state.has(path)) continue;
      const kind = await fs.lstat(path);
      state.set(
        path,
        kind === 'file'
          ? { kind, content: await fs.readText(path, 'ApplyPatch preflight') }
          : { kind: kind === 'directory' ? 'other' : kind },
      );
    }
    const prepared = planApplyPatchMutations(hunks, state);
    if (fs.preflightPermissions) {
      await fs.preflightPermissions(collectAccessIntents(prepared));
    }
    return settlePrepared(prepared, fs);
  };

  return withNestedLocks(orderedKeys, withLock, run);
}

function collectAccessIntents(prepared: readonly PlannedPatchMutation[]): ApplyPatchAccessIntent[] {
  const byKey = new Map<string, ApplyPatchAccessIntent>();
  for (const step of prepared) {
    if (step.operation === 'add' || step.operation === 'update') {
      byKey.set(`write:${step.path}`, { access: 'write', path: step.path });
      continue;
    }
    if (step.operation === 'delete') {
      byKey.set(`delete:${step.path}`, { access: 'delete', path: step.path });
      continue;
    }
    // move: destination write + source delete
    byKey.set(`write:${step.path}`, { access: 'write', path: step.path });
    byKey.set(`delete:${step.fromPath}`, { access: 'delete', path: step.fromPath });
  }
  return [...byKey.values()];
}

async function settlePrepared(
  prepared: readonly PlannedPatchMutation[],
  fs: ApplyPatchFsAdapter,
): Promise<ApplyPatchEngineResult> {
  const operations: ApplyPatchOperationResult[] = [];
  const completed: string[] = [];
  let failure: string | undefined;

  for (const step of prepared) {
    if (failure) {
      operations.push({
        operation: step.operation,
        path: step.path,
        ...(step.operation === 'move' ? { fromPath: step.fromPath } : {}),
        status: 'skipped',
      });
      continue;
    }

    try {
      if (step.operation === 'add' || step.operation === 'update') {
        const written = await fs.writeText(
          step.path,
          step.content,
          step.operation === 'add' ? 'create' : 'replace',
        );
        operations.push({
          operation: step.operation,
          path: written.path,
          status: 'completed',
          bytes: written.bytes,
        });
        completed.push(written.path);
        continue;
      }

      if (step.operation === 'delete') {
        const deleted = await fs.deletePath(step.path);
        operations.push({ operation: 'delete', path: deleted.path, status: 'completed' });
        completed.push(deleted.path);
        continue;
      }

      // move: write destination first, then delete source. A failed source
      // delete after a successful write is an explicit partial failure.
      const written = await fs.writeText(step.path, step.content, 'create');
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
        // Destination already written — treat as partial, not a clean rethrow:
        // the error is captured below instead of propagating to ToolRuntime.
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
        operation: step.operation,
        path: step.path,
        ...(step.operation === 'move' ? { fromPath: step.fromPath } : {}),
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
