import { promises as fs } from 'node:fs';
import { exec, execFile } from 'node:child_process';
import { glob as nodeGlob } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import {
  isPathInside,
  realpathAllowMissing,
  resolveCanonicalDirectoryEntryTarget,
} from './path-containment.js';
import { createPatchedFile, updatePatchedFile } from './apply-patch-file.js';
import { promisify } from 'node:util';
import type { ToolExecutionFacts } from '@maka/core/permission';
import { runProcessWithBoundedTail, runShellWithBoundedTail } from './shell-exec.js';
import type { ChildFdInput } from './child-fd-input.js';
import type { ShellPlan } from './shell-detect.js';
import { isSupportedImagePath, readWorkspaceImage } from './image-file.js';
import type { ImageMimeType } from './image-file.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export type WorkspaceIsolationKind = ToolExecutionFacts['isolation'];
export type WorkspaceWriteBackMode = ToolExecutionFacts['writeBack'];
export type WorkspaceNetworkMode = ToolExecutionFacts['network'];
export type WorkspaceSecretMode = ToolExecutionFacts['secrets'];
export type WorkspaceExecutorFacts = ToolExecutionFacts;

export const LOCAL_WORKSPACE_EXECUTOR_FACTS: WorkspaceExecutorFacts = {
  isolation: 'none',
  writesAffectHost: true,
  writeBack: 'direct',
  network: 'host',
  secrets: 'host_env',
};

export interface WorkspaceExecInput {
  command: string;
  /** Final executable argv. When provided, bypasses host-shell parsing. */
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  fdInputs?: readonly ChildFdInput[];
  cwd: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  emitOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
  /** Shell to run the command with. The local executor defaults to the process-wide detected shell. */
  shell?: ShellPlan;
}

export interface WorkspaceExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  timedOut: boolean;
  aborted: boolean;
}

export interface WorkspaceReadFileInput {
  cwd: string;
  path: string;
  offset?: number;
  limit?: number;
}

export interface WorkspaceReadTextResult {
  content: string;
}

export interface WorkspaceReadImageResult {
  bytes: Uint8Array;
  mimeType: ImageMimeType;
}

export type WorkspaceReadFileResult = WorkspaceReadTextResult | WorkspaceReadImageResult;

export interface WorkspaceWriteFileInput {
  cwd: string;
  path: string;
  content: string;
}

export interface WorkspaceWriteFileResult {
  ok: boolean;
  path: string;
  bytes: number;
}

export type WorkspaceApplyPatchInput = WorkspaceResolvePathInput &
  ({ action: 'create' | 'update'; diff: string } | { action: 'delete' });

export interface WorkspaceApplyPatchResult {
  ok: true;
  path: string;
}

/**
 * Which path space a resolution may land in.
 *
 * `workspace` keeps the resolved path inside the session cwd; `host` accepts
 * any canonical path on the host. This is a *mechanism* parameter: the caller
 * decides it from the active ExecutionBoundary, so no executor has to carry a
 * containment policy of its own. Executors whose transport cannot express host
 * paths (a remote or isolated workspace) reject `host` explicitly.
 */
export type WorkspacePathScope = 'workspace' | 'host';

export interface WorkspaceResolvePathInput {
  cwd: string;
  path: string;
  label: string;
  scope: WorkspacePathScope;
}

export interface WorkspaceResolvePathResult {
  path: string;
}

export interface WorkspaceWriteLockKeyInput {
  cwd: string;
  path: string;
  semantics?: 'target' | 'entry';
}

export interface WorkspaceWriteLockKeyResult {
  key: string;
}

export interface WorkspaceGlobInput {
  cwd: string;
  pattern: string;
  limit?: number;
}

export interface WorkspaceGlobResult {
  files: string[];
}

export interface WorkspaceGrepInput {
  cwd: string;
  pattern: string;
  path: string;
  glob?: string;
  maxCountPerFile: number;
  limit: number;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}

export interface WorkspaceGrepResult {
  matches: string[];
}

export interface WorkspaceExecutorFactsProvider {
  readonly facts: WorkspaceExecutorFacts;
}

export interface WorkspaceCommandExecutor {
  exec(input: WorkspaceExecInput): Promise<WorkspaceExecResult>;
}

export interface WorkspaceReadFileExecutor {
  readFile(input: WorkspaceReadFileInput): Promise<WorkspaceReadFileResult>;
}

export interface WorkspaceWriteFileExecutor {
  writeFile(input: WorkspaceWriteFileInput): Promise<WorkspaceWriteFileResult>;
}

export interface WorkspaceApplyPatchExecutor {
  applyPatch(input: WorkspaceApplyPatchInput): Promise<WorkspaceApplyPatchResult>;
}

export interface WorkspaceExistingPathResolver {
  resolveExistingPath(input: WorkspaceResolvePathInput): Promise<WorkspaceResolvePathResult>;
}

export interface WorkspaceWritablePathResolver {
  resolveWritablePath(input: WorkspaceResolvePathInput): Promise<WorkspaceResolvePathResult>;
}

export interface WorkspaceWriteLockProvider {
  writeLockKey(input: WorkspaceWriteLockKeyInput): Promise<WorkspaceWriteLockKeyResult>;
}

export interface WorkspaceGlobFilesExecutor {
  globFiles(input: WorkspaceGlobInput): Promise<WorkspaceGlobResult>;
}

export interface WorkspaceGrepFilesExecutor {
  grepFiles(input: WorkspaceGrepInput): Promise<WorkspaceGrepResult>;
}

export type WorkspaceBashExecutor = WorkspaceExecutorFactsProvider & WorkspaceCommandExecutor;

export type WorkspaceReadExecutor = WorkspaceExecutorFactsProvider &
  WorkspaceExistingPathResolver &
  WorkspaceReadFileExecutor;

export type WorkspaceWriteExecutor = WorkspaceExecutorFactsProvider &
  WorkspaceWritablePathResolver &
  WorkspaceWriteLockProvider &
  WorkspaceWriteFileExecutor;

export type WorkspaceEditExecutor = WorkspaceExecutorFactsProvider &
  WorkspaceExistingPathResolver &
  WorkspaceWriteLockProvider &
  WorkspaceReadFileExecutor &
  WorkspaceWriteFileExecutor;

export type WorkspaceGlobExecutor = WorkspaceExecutorFactsProvider &
  WorkspaceExistingPathResolver &
  WorkspaceGlobFilesExecutor;

export type WorkspaceGrepExecutor = WorkspaceExecutorFactsProvider &
  WorkspaceExistingPathResolver &
  WorkspaceGrepFilesExecutor;

export type WorkspaceSearchExecutor = WorkspaceGlobExecutor & WorkspaceGrepExecutor;

export interface WorkspaceExecutor
  extends WorkspaceBashExecutor,
    WorkspaceReadExecutor,
    WorkspaceWriteExecutor,
    WorkspaceEditExecutor,
    WorkspaceGlobExecutor,
    WorkspaceGrepExecutor,
    Partial<WorkspaceApplyPatchExecutor> {}

export class LocalWorkspaceExecutor implements WorkspaceExecutor {
  readonly facts = LOCAL_WORKSPACE_EXECUTOR_FACTS;

  async exec(input: WorkspaceExecInput): Promise<WorkspaceExecResult> {
    const options = {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      ...(input.env ? { env: input.env } : {}),
      ...(input.fdInputs ? { fdInputs: input.fdInputs } : {}),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      ...(input.emitOutput ? { emitOutput: input.emitOutput } : {}),
      ...(input.shell ? { shell: input.shell } : {}),
    };
    const result = input.argv
      ? await runProcessWithBoundedTail(input.argv[0] ?? '', input.argv.slice(1), options)
      : await runShellWithBoundedTail(input.command, options);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.timedOut ? 124 : result.aborted ? 130 : result.exitCode,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      timedOut: result.timedOut,
      aborted: result.aborted,
    };
  }

  async readFile(input: WorkspaceReadFileInput): Promise<WorkspaceReadFileResult> {
    if (isSupportedImagePath(input.path)) {
      return await readWorkspaceImage(input.path);
    }
    const content = await fs.readFile(input.path, 'utf8');
    if (input.offset === undefined && input.limit === undefined) return { content };
    const lines = content.split('\n');
    const start = input.offset ?? 0;
    const end = input.limit ? start + input.limit : lines.length;
    return { content: lines.slice(start, end).join('\n') };
  }

  async writeFile(input: WorkspaceWriteFileInput): Promise<WorkspaceWriteFileResult> {
    await fs.writeFile(input.path, input.content, 'utf8');
    return {
      ok: true,
      path: input.path,
      bytes: Buffer.byteLength(input.content, 'utf8'),
    };
  }

  async applyPatch(input: WorkspaceApplyPatchInput): Promise<WorkspaceApplyPatchResult> {
    if (input.action !== 'update') {
      const path = await resolveDirectoryEntryPathInScope(
        input.cwd,
        input.path,
        input.label,
        input.scope,
      );
      if (input.action === 'create') await createPatchedFile(path, input.diff);
      else await fs.unlink(path);
      return { ok: true, path };
    }
    const path = await resolveExistingPathInScope(input.cwd, input.path, input.label, input.scope);
    await updatePatchedFile(path, input.diff);
    return { ok: true, path };
  }

  async resolveExistingPath(input: WorkspaceResolvePathInput): Promise<WorkspaceResolvePathResult> {
    return {
      path: await resolveExistingPathInScope(input.cwd, input.path, input.label, input.scope),
    };
  }

  async resolveWritablePath(input: WorkspaceResolvePathInput): Promise<WorkspaceResolvePathResult> {
    return {
      path: (await canonicalPathInScope(input.cwd, input.path, input.label, input.scope)).path,
    };
  }

  async writeLockKey(input: WorkspaceWriteLockKeyInput): Promise<WorkspaceWriteLockKeyResult> {
    // The resolvers' canonicalisation without their containment check, so every
    // spelling of one file — relative, absolute, or through a symlink — takes
    // the same lock. Escapes are rejected by the resolvers inside the lock, not
    // here. Sharing the canonicalisation is what keeps the lock-key space and
    // the resolved-path space from drifting apart.
    const path =
      input.semantics === 'entry'
        ? (await resolveCanonicalDirectoryEntryTarget(input.cwd, input.path)).path
        : (await canonicalPathUnderCwd(input.cwd, input.path)).path;
    return { key: path };
  }

  async globFiles(input: WorkspaceGlobInput): Promise<WorkspaceGlobResult> {
    const files: string[] = [];
    const limit = input.limit ?? 200;
    for await (const file of nodeGlob(input.pattern, { cwd: input.cwd })) {
      files.push(typeof file === 'string' ? file : (file as { name: string }).name);
      if (files.length >= limit) break;
    }
    return { files };
  }

  async grepFiles(input: WorkspaceGrepInput): Promise<WorkspaceGrepResult> {
    const args = ['-n', '--no-heading', `--max-count=${input.maxCountPerFile}`];
    if (input.glob) args.push('--glob', input.glob);
    args.push('--', input.pattern, input.path);
    try {
      const { stdout } = await execFileAsync('rg', args, {
        cwd: input.cwd,
        maxBuffer: 5 * 1024 * 1024,
        timeout: input.timeoutMs,
        ...(input.abortSignal ? { signal: input.abortSignal } : {}),
      });
      return { matches: stdout.split('\n').filter(Boolean).slice(0, input.limit) };
    } catch (error: any) {
      if (error?.code === 1) return { matches: [] };
      throw error;
    }
  }
}

export function createLocalWorkspaceExecutor(): WorkspaceExecutor {
  return new LocalWorkspaceExecutor();
}

/**
 * Canonical session cwd and the canonical path `inputPath` names under it, with
 * no containment check — the single place that decides which path space every
 * caller works in. Both the root and the candidate are realpath'd, the candidate
 * through its deepest existing ancestor since the target may not exist yet.
 * Comparing a realpath'd root against a merely resolved candidate rejected every
 * legitimate absolute path whenever the session cwd sat under a symlink — macOS
 * tmpdirs (`/var` → `/private/var`) and symlinked workspace roots.
 */
async function canonicalPathUnderCwd(
  cwd: string,
  inputPath: string,
): Promise<{ root: string; path: string }> {
  const root = await fs.realpath(cwd);
  const requested = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath);
  return { root, path: await realpathAllowMissing(requested) };
}

/**
 * The same canonical path, rejected unless it stays inside the session cwd when
 * the caller asked for `workspace` scope. Following the symlinks does not weaken
 * containment: a link inside the cwd that points out of it resolves to its
 * outside target and is rejected.
 *
 * Under `host` scope the canonicalisation is identical and only the containment
 * assertion is skipped, so both scopes work in one path space and a scope change
 * cannot move a path.
 */
async function canonicalPathInScope(
  cwd: string,
  inputPath: string,
  label: string,
  scope: WorkspacePathScope,
): Promise<{ root: string; path: string }> {
  const { root, path } = await canonicalPathUnderCwd(cwd, inputPath);
  if (scope === 'host') return { root, path };
  return { root, path: assertInsideCwd(root, path, inputPath, label) };
}

async function resolveExistingPathInScope(
  cwd: string,
  inputPath: string,
  label: string,
  scope: WorkspacePathScope,
): Promise<string> {
  const { root, path: candidate } = await canonicalPathInScope(cwd, inputPath, label, scope);
  if (scope === 'host') return await fs.realpath(candidate);
  // The read/search callers depend on the target existing; surface that here
  // rather than as a downstream open/spawn failure.
  //
  // Do not drop the second assertion: it closes the window between the two
  // awaits, where a segment that was missing during canonicalisation can become
  // a symlink out of the cwd before the realpath runs. It is deliberately
  // defence-in-depth and no deterministic test can drive that race, so nothing
  // will fail if it is removed.
  return assertInsideCwd(root, await fs.realpath(candidate), inputPath, label);
}

async function resolveDirectoryEntryPathInScope(
  cwd: string,
  inputPath: string,
  label: string,
  scope: WorkspacePathScope,
): Promise<string> {
  const target = await resolveCanonicalDirectoryEntryTarget(cwd, inputPath);
  return scope === 'host'
    ? target.path
    : assertInsideCwd(target.root, target.path, inputPath, label);
}

function assertInsideCwd(
  root: string,
  candidate: string,
  inputPath: string,
  label: string,
): string {
  if (!isPathInside(root, candidate)) {
    throw new Error(
      `${label} path must stay inside session cwd ${JSON.stringify(root)}; ` +
        `received ${JSON.stringify(inputPath)}, which resolves to ${JSON.stringify(candidate)}.`,
    );
  }
  return candidate;
}
