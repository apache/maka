import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { glob as nodeGlob } from 'node:fs/promises';
import { dirname, isAbsolute, parse, resolve } from 'node:path';
import {
  isPathInside,
  realpathAllowMissing,
  resolveCanonicalDirectoryEntryTarget,
} from '../path-containment.js';
import { sandboxBoundaryExpansionAllowsPath } from '@maka/core/sandbox-boundary';
import {
  ApplyPatchRejectedError,
  createPatchedFile,
  updatePatchedFile,
} from '../apply-patch-file.js';

import { computeEditedSource } from '../edit-replace.js';
import { createUnifiedDiff } from '../unified-diff.js';
import { isSupportedImagePath, readWorkspaceImage } from '../image-file.js';
import {
  FILESYSTEM_WORKER_PROTOCOL_VERSION,
  operationUsesDirectoryEntry,
  type FilesystemWorkerErrorCode,
  type FilesystemWorkerOperation,
  type FilesystemWorkerRequest,
  type FilesystemWorkerResponse,
  type FilesystemWorkerResult,
  type FilesystemWorkerTarget,
} from './protocol.js';
import { isLikelySandboxDenial } from '../sandbox/detect.js';

const DEFAULT_GLOB_LIMIT = 200;
const MAX_GREP_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_GREP_STDERR_BYTES = 16 * 1024;

export interface FilesystemWorkerOperationDependencies {
  grepExecutable?: string;
  runGrep?: FilesystemWorkerGrepRunner;
}

export interface FilesystemWorkerGrepRunInput {
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
}

export interface FilesystemWorkerGrepRunResult {
  exitCode: number;
  stdout: string;
  stderrTail: string;
}

export type FilesystemWorkerGrepRunner = (
  input: FilesystemWorkerGrepRunInput,
) => Promise<FilesystemWorkerGrepRunResult>;

export async function executeFilesystemWorkerRequest(
  request: FilesystemWorkerRequest,
  dependencies: FilesystemWorkerOperationDependencies = {},
): Promise<FilesystemWorkerResponse> {
  try {
    await assertTargetUnchanged(
      request.operation.cwd,
      request.operation.path,
      request.expectedTarget,
      operationUsesDirectoryEntry(request.operation),
    );
    return {
      version: FILESYSTEM_WORKER_PROTOCOL_VERSION,
      requestId: request.requestId,
      ok: true,
      result: await executeFilesystemOperation(
        request.operation,
        request.operationBoundary,
        dependencies,
      ),
    };
  } catch (error) {
    const normalized = normalizeOperationError(error);
    return {
      version: FILESYSTEM_WORKER_PROTOCOL_VERSION,
      requestId: request.requestId,
      ok: false,
      error: { code: normalized.code, message: normalized.message },
    };
  }
}

export async function executeFilesystemOperation(
  operation: FilesystemWorkerOperation,
  operationBoundary: FilesystemWorkerRequest['operationBoundary'],
  dependencies: FilesystemWorkerOperationDependencies = {},
): Promise<FilesystemWorkerResult> {
  switch (operation.kind) {
    case 'read': {
      const path = await resolveExistingAllowed(
        operation.cwd,
        operation.path,
        'Read',
        'read',
        operationBoundary,
      );
      if (isSupportedImagePath(path)) {
        try {
          const image = await readWorkspaceImage(path);
          return {
            kind: 'read_image',
            base64: Buffer.from(image.bytes).toString('base64'),
            mimeType: image.mimeType,
          };
        } catch (error) {
          throw operationError(
            'filesystem_error',
            error instanceof Error ? error.message : 'Image could not be read.',
          );
        }
      }
      const content = await fs.readFile(path, 'utf8');
      if (operation.offset === undefined && operation.limit === undefined)
        return { kind: 'read', content };
      const lines = content.split('\n');
      const start = operation.offset ?? 0;
      const end = operation.limit ? start + operation.limit : lines.length;
      return { kind: 'read', content: lines.slice(start, end).join('\n') };
    }
    case 'write': {
      const path = await resolveWritableAllowed(
        operation.cwd,
        operation.path,
        'Write',
        operationBoundary,
      );
      // Read-before-write: the diff of an overwrite is what tells the reader
      // what was lost. Only a missing file means the whole content is new —
      // any other read failure leaves the previous state unknown, and
      // claiming `--- /dev/null` would report the file as created.
      let previous: 'new' | 'unknown' | string;
      try {
        previous = await fs.readFile(path, 'utf8');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        previous = code === 'ENOENT' || code === 'ENOTDIR' ? 'new' : 'unknown';
      }
      await fs.writeFile(path, operation.content, 'utf8');
      const diff =
        previous === 'unknown'
          ? undefined
          : createUnifiedDiff(path, previous === 'new' ? undefined : previous, operation.content);
      return {
        kind: 'write',
        ok: true,
        path,
        bytes: Buffer.byteLength(operation.content, 'utf8'),
        ...(diff !== undefined ? { diff } : {}),
      };
    }
    case 'apply_patch': {
      if (operation.action !== 'update') {
        const path = await resolveDirectoryEntryAllowed(
          operation.cwd,
          operation.path,
          operation.action === 'create' ? 'ApplyPatch create' : 'ApplyPatch delete',
          operationBoundary,
        );
        if (operation.action === 'create') await createPatchedFile(path, operation.diff);
        else await fs.unlink(path);
        return { kind: 'apply_patch', ok: true, path };
      }
      const path = await resolveExistingAllowed(
        operation.cwd,
        operation.path,
        'ApplyPatch update',
        'write',
        operationBoundary,
      );
      await updatePatchedFile(path, operation.diff);
      return { kind: 'apply_patch', ok: true, path };
    }
    case 'edit': {
      const path = await resolveExistingAllowed(
        operation.cwd,
        operation.path,
        'Edit',
        'write',
        operationBoundary,
      );
      const content = await fs.readFile(path, 'utf8');
      let edited: ReturnType<typeof computeEditedSource>;
      try {
        edited = computeEditedSource(
          content,
          operation.oldString,
          operation.newString,
          operation.path,
        );
      } catch (error) {
        throw operationError(
          'edit_conflict',
          error instanceof Error ? error.message : 'Edit could not be applied.',
        );
      }
      await fs.writeFile(path, edited.content, 'utf8');
      const diff = createUnifiedDiff(path, content, edited.content);
      return {
        kind: 'edit',
        ok: true,
        path,
        replacements: 1,
        matchedVia: edited.matchedVia,
        startLine: edited.startLine,
        endLine: edited.endLine,
        ...(diff !== undefined ? { diff } : {}),
      };
    }
    case 'format_json': {
      const path = await resolveExistingAllowed(
        operation.cwd,
        operation.path,
        'FormatJson',
        'write',
        operationBoundary,
      );
      const original = await fs.readFile(path, 'utf8');
      const bytesBefore = Buffer.byteLength(original, 'utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(original);
      } catch (error) {
        return {
          kind: 'format_json',
          ok: false,
          valid: false,
          path,
          error: `FormatJson: invalid JSON: ${error instanceof Error ? error.message : 'parse failed'}`,
          bytesBefore,
          byteDelta: 0,
          changed: false,
        };
      }
      const formatted = JSON.stringify(operation.sortKeys ? sortKeysDeep(parsed) : parsed, null, 2);
      await fs.writeFile(path, formatted, 'utf8');
      const bytesAfter = Buffer.byteLength(formatted, 'utf8');
      const diff =
        formatted === original ? undefined : createUnifiedDiff(path, original, formatted);
      return {
        kind: 'format_json',
        ok: true,
        valid: true,
        path,
        bytesBefore,
        bytesAfter,
        byteDelta: bytesAfter - bytesBefore,
        changed: formatted !== original,
        ...(diff !== undefined ? { diff } : {}),
      };
    }
    case 'glob': {
      assertContainedGlobPattern(operation.pattern);
      const path = await resolveExistingAllowed(
        operation.cwd,
        operation.path,
        'Glob cwd',
        'read',
        operationBoundary,
      );
      const files: string[] = [];
      const limit = operation.limit ?? DEFAULT_GLOB_LIMIT;
      for await (const file of nodeGlob(operation.pattern, { cwd: path })) {
        files.push(typeof file === 'string' ? file : (file as { name: string }).name);
        if (files.length >= limit) break;
      }
      return { kind: 'glob', files };
    }
    case 'grep': {
      const path = await resolveExistingAllowed(
        operation.cwd,
        operation.path,
        'Grep',
        'read',
        operationBoundary,
      );
      if (!dependencies.grepExecutable)
        throw operationError('grep_unavailable', 'Grep is unavailable in this runtime.');
      const args = ['-n', '--no-heading', `--max-count=${operation.maxCountPerFile}`];
      if (operation.glob) args.push('--glob', operation.glob);
      args.push(operation.pattern, path);
      const result = await (dependencies.runGrep ?? runRipgrep)({
        executable: dependencies.grepExecutable,
        args,
        // The target is canonical and absolute. Running from its filesystem root avoids
        // requiring operation-scoped workers to read the broader session workspace.
        cwd: parse(path).root,
        timeoutMs: operation.timeoutMs,
      });
      if (result.exitCode === 1) return { kind: 'grep', matches: [] };
      if (result.exitCode !== 0) {
        const detail = result.stderrTail.trim();
        throw operationError(
          isLikelySandboxDenial({ stdout: result.stdout, stderr: detail, sandboxed: true })
            ? 'sandbox_denied'
            : 'filesystem_error',
          detail
            ? `Grep failed while searching files.\n${detail}`
            : 'Grep failed while searching files.',
        );
      }
      return {
        kind: 'grep',
        matches: result.stdout.split('\n').filter(Boolean).slice(0, operation.limit),
      };
    }
  }
}

class FilesystemOperationError extends Error {
  constructor(
    readonly code: FilesystemWorkerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FilesystemOperationError';
  }
}

function operationError(
  code: FilesystemWorkerErrorCode,
  message: string,
): FilesystemOperationError {
  return new FilesystemOperationError(code, message);
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeysDeep((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function normalizeOperationError(error: unknown): FilesystemOperationError {
  if (error instanceof FilesystemOperationError) return error;
  if (error instanceof ApplyPatchRejectedError) {
    return operationError('edit_conflict', error.message);
  }
  const code = nodeErrorCode(error);
  if (code === 'ENOENT' || code === 'ENOTDIR')
    return operationError('not_found', 'The requested path was not found.');
  if (code === 'EACCES' || code === 'EPERM')
    return operationError('filesystem_denied', 'Filesystem access was denied.');
  return operationError('filesystem_error', 'Filesystem operation failed.');
}

async function assertTargetUnchanged(
  cwd: string,
  path: string,
  expected: FilesystemWorkerTarget,
  noFollowFinalSymlink = false,
): Promise<void> {
  const enforcementPath = noFollowFinalSymlink
    ? (await resolveCanonicalDirectoryEntryTarget(cwd, path)).path
    : await realpathAllowMissing(path);
  const targetType = noFollowFinalSymlink
    ? await lstatTargetTypeOf(enforcementPath)
    : await targetTypeOf(enforcementPath);
  if (enforcementPath !== expected.enforcementPath || targetType !== expected.targetType) {
    throw operationError(
      'path_changed',
      'The approved filesystem target changed before execution.',
    );
  }
}

async function resolveWritableAllowed(
  cwd: string,
  inputPath: string,
  label: string,
  permission: FilesystemWorkerRequest['operationBoundary'],
): Promise<string> {
  const { root, candidate } = await resolveCandidate(cwd, inputPath, label, 'write', permission);
  try {
    const target = await fs.realpath(candidate);
    assertAllowed(root, target, label, 'write', permission);
    return target;
  } catch (error) {
    if (nodeErrorCode(error) !== 'ENOENT') throw error;
  }
  // The target does not exist, but it can still be a dangling symlink, and a
  // write lands on what the link names rather than on the link. Authorise the
  // followed path — the same one `assertTargetUnchanged` pins the request to —
  // so the worker enforces its own boundary instead of trusting the caller to
  // have canonicalised the path for it.
  const followed = await realpathAllowMissing(candidate);
  const parent = await fs.realpath(dirname(followed));
  assertAllowed(root, followed, label, 'write', permission);
  if (!isPathInside(root, parent) && !exactWriteCoversParent(permission, followed, parent)) {
    throw operationError(
      'path_denied',
      `${label} parent was not covered by the operation boundary.`,
    );
  }
  return followed;
}

async function resolveDirectoryEntryAllowed(
  cwd: string,
  inputPath: string,
  label: string,
  permission: FilesystemWorkerRequest['operationBoundary'],
): Promise<string> {
  const target = await resolveCanonicalDirectoryEntryTarget(cwd, inputPath);
  assertAllowed(target.root, target.path, label, 'write', permission);
  return target.path;
}

async function resolveExistingAllowed(
  cwd: string,
  inputPath: string,
  label: string,
  access: 'read' | 'write',
  permission: FilesystemWorkerRequest['operationBoundary'],
): Promise<string> {
  const { root, candidate } = await resolveCandidate(cwd, inputPath, label, access, permission);
  const target = await fs.realpath(candidate);
  assertAllowed(root, target, label, access, permission);
  return target;
}

async function resolveCandidate(
  cwd: string,
  inputPath: string,
  label: string,
  access: 'read' | 'write',
  permission: FilesystemWorkerRequest['operationBoundary'],
): Promise<{ root: string; candidate: string }> {
  const root = await fs.realpath(cwd);
  const candidate = resolve(root, inputPath);
  if (
    !isPathInside(root, candidate) &&
    !sandboxBoundaryExpansionAllowsPath(permission, candidate, access)
  ) {
    throw operationError('path_denied', `${label} path was not covered by the operation boundary.`);
  }
  return { root, candidate };
}

function assertAllowed(
  root: string,
  target: string,
  label: string,
  access: 'read' | 'write',
  permission: FilesystemWorkerRequest['operationBoundary'],
): void {
  if (isPathInside(root, target) || sandboxBoundaryExpansionAllowsPath(permission, target, access))
    return;
  throw operationError('path_denied', `${label} path escaped its approved target.`);
}

function exactWriteCoversParent(
  permission: FilesystemWorkerRequest['operationBoundary'],
  target: string,
  parent: string,
): boolean {
  return (
    permission.filesystem?.entries.some(
      (entry) =>
        entry.access === 'write' &&
        entry.scope === 'exact' &&
        entry.path === target &&
        dirname(entry.path) === parent,
    ) ?? false
  );
}

function assertContainedGlobPattern(pattern: string): void {
  if (isAbsolute(pattern) || pattern.split(/[\\/]+/).includes('..')) {
    throw operationError('path_denied', 'Glob pattern must stay inside its search root.');
  }
}

async function targetTypeOf(path: string): Promise<FilesystemWorkerTarget['targetType']> {
  try {
    const metadata = await fs.stat(path);
    if (metadata.isFile()) return 'file';
    if (metadata.isDirectory()) return 'directory';
    return 'other';
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return 'missing';
    throw error;
  }
}

async function lstatTargetTypeOf(path: string): Promise<FilesystemWorkerTarget['targetType']> {
  try {
    const metadata = await fs.lstat(path);
    if (metadata.isSymbolicLink()) return 'symlink';
    if (metadata.isFile()) return 'file';
    if (metadata.isDirectory()) return 'directory';
    return 'other';
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return 'missing';
    throw error;
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

async function runRipgrep(
  input: FilesystemWorkerGrepRunInput,
): Promise<FilesystemWorkerGrepRunResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(input.executable, [...input.args], {
      cwd: input.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderrTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectOnce(operationError('filesystem_error', 'Grep timed out.'));
    }, input.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_GREP_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        rejectOnce(operationError('filesystem_error', 'Grep output exceeded the worker limit.'));
      } else {
        chunks.push(chunk);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = appendBoundedTail(stderrTail, chunk, MAX_GREP_STDERR_BYTES);
    });
    child.once('error', (error) => rejectOnce(error));
    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        exitCode: exitCode ?? 2,
        stdout: Buffer.concat(chunks).toString('utf8'),
        stderrTail: stderrTail.toString('utf8'),
      });
    });

    function rejectOnce(error: unknown): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
  });
}

function appendBoundedTail(current: Buffer, chunk: Buffer, limit: number): Buffer {
  if (chunk.length >= limit) return chunk.subarray(chunk.length - limit);
  if (current.length + chunk.length <= limit) return Buffer.concat([current, chunk]);
  return Buffer.concat([current.subarray(current.length - (limit - chunk.length)), chunk]);
}
