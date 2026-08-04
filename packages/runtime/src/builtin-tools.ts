// packages/runtime/src/builtin-tools.ts
// Baseline tool set. ToolRuntime settlement decorates each tool with durable
// execution facts, while the active session ExecutionBoundary constrains local
// filesystem, shell, and network effects.

import { z } from 'zod';
import { jsonSchema, zodSchema } from 'ai';
import {
  closeSync,
  constants,
  fstatSync,
  futimesSync,
  lstatSync,
  openSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute } from 'node:path';
import {
  canWritePath,
  compilePermissionProfile,
  type SandboxBoundaryExpansion,
  type StorageRef,
  type PermissionProfile,
} from '@maka/core';
import { computeEditedSource } from './edit-replace.js';
import { bashToolResultToModelOutput } from './bash-model-output.js';
export type { EditingProtocol } from '@maka/core/apply-patch';
import {
  executeApplyPatchWithAdapter,
  type ApplyPatchAccessIntent,
  type ApplyPatchFsAdapter,
} from './apply-patch-engine.js';
import {
  buildManagedBashTool,
  buildStopBackgroundTaskTool,
  buildWriteStdinTool,
  shapeTerminalResult,
  withShellGuidance,
} from './shell-tools.js';
import type { ShellRunLauncher } from './shell-tools.js';
import { defaultShellPlan, type ShellPlan } from './shell-detect.js';
import type {
  BackgroundTaskStopper,
  PtyControlWriter,
  RuntimeResourceReader,
} from './shell-run-contract.js';
import {
  createLocalWorkspaceExecutor,
  type WorkspaceExecResult,
  type WorkspaceExecutor,
} from './workspace-executor.js';
import { lstat, mkdir, open, realpath, unlink, writeFile } from 'node:fs/promises';
import { isPathInside } from './path-containment.js';

// tool-runtime.ts is the single source of truth for the tool shape; this
// re-export only keeps back-compat for callers that imported from
// builtin-tools directly.
import type { MakaTool, MakaToolContext } from './tool-runtime.js';
export type { MakaTool, MakaToolContext };
import { withFileWriteLock } from './file-write-lock.js';
import { profileRequiresSandbox, type SandboxManager } from './sandbox/sandbox-manager.js';
import { SandboxCommandError } from './sandbox/errors.js';
import { isLikelySandboxDenial } from './sandbox/detect.js';
import { linuxExecutableRoots } from './sandbox/linux-sandbox.js';
import { pinExistingLinuxProfilePath } from './sandbox/linux-profile-path.js';
import type { SandboxPlatform, SandboxType } from './sandbox/types.js';
import type { ChildFdInput } from './child-fd-input.js';
import { buildArchiveReadTool } from './archive-read-tool.js';
import type { ToolResultArchiveResourceReader } from './tool-result-archive-resource.js';
import { normalizeSandboxBoundaryPath } from './sandbox-boundary-path.js';
import {
  FilesystemWorkerClientError,
  filesystemWorkerRuntimeWritableRoots,
  type FilesystemWorkerClient,
} from './filesystem-worker/client.js';
import {
  preflightDeclaredSandboxBoundary,
  sandboxBoundaryExpansionSchema,
} from './sandbox-boundary-declaration.js';

// Generous wall-clock cap for the ripgrep-backed Grep tool. A search should be
// near-instant; this only bounds a pathological hang now that the stream
// watchdog is paused during tool execution.
const GREP_TIMEOUT_MS = 120_000;

export interface BuildBuiltinToolsOptions {
  shellRuns?: ShellRunLauncher;
  runtimeResources?: RuntimeResourceReader;
  archiveResources?: ToolResultArchiveResourceReader;
  backgroundTasks?: BackgroundTaskStopper;
  ptyControls?: PtyControlWriter;
  executor?: WorkspaceExecutor;
  /** Shell that runs Bash commands. Defaults to the process-wide detected shell. */
  shell?: ShellPlan;
  permissionProfile?: PermissionProfile;
  sandboxManager?: SandboxManager;
  /** Sandboxed worker used for all local filesystem tools. */
  filesystemWorker?: Pick<FilesystemWorkerClient, 'execute'>;
  /** Host-surface gate for Edit. Defaults to enabled. */
  includeEdit?: boolean;
  /** Test/embedding override. Production callers use the current process platform. */
  sandboxPlatform?: SandboxPlatform;
  snapshotImage?: (input: {
    sessionId: string;
    turnId: string;
    name: string;
    bytes: Uint8Array;
    mimeType: string;
  }) => Promise<Extract<StorageRef, { kind: 'session_file' }>>;
}

export function buildBuiltinTools(options: BuildBuiltinToolsOptions = {}): MakaTool[] {
  const executor = options.executor ?? createLocalWorkspaceExecutor();
  const executionFacts = executor.facts;
  const readDescription = `Read a text file${options.snapshotImage ? ' or supported image' : ''} from disk${options.runtimeResources ? ', or read a whole runtime resource using ref' : ''}.`;
  const pathField = z
    .string()
    .describe('A file path; relative paths are resolved from the session cwd');
  const offsetField = z
    .number()
    .int()
    .nonnegative()
    .describe('Zero-based text file line offset')
    .optional();
  const limitField = z
    .number()
    .int()
    .positive()
    .describe('Maximum text file lines to read')
    .optional();
  const refField = z.string().describe('A runtime resource ref returned by another tool');
  const fileReadParameters = z
    .object({
      path: pathField,
      offset: offsetField,
      limit: limitField,
    })
    .strict();
  const runtimeResourceReadParameters = z
    .object({
      ref: refField,
    })
    .strict();
  // Some providers serialize unused optional fields as empty strings, so a
  // model may send `ref: ""` on an ordinary file read. A blank ref means "no
  // ref provided": drop the key before the strict union judges it, keeping the
  // canonical input a pure file-or-ref union — `{path, ref: ""}` reads the
  // file, while a lone `{ref: ""}` fails validation (no readable target).
  const dropEmptyRef = (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null || !('ref' in value)) return value;
    const ref = (value as { ref?: unknown }).ref;
    if (typeof ref !== 'string' || ref.trim() !== '') return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'ref'),
    );
  };
  const strictReadParameters = z.preprocess(
    dropEmptyRef,
    z
      .union([fileReadParameters, runtimeResourceReadParameters])
      .describe('Read a file with path, or a whole runtime resource with ref; provide exactly one'),
  );
  // Provider-facing schema: a single top-level object with every field optional.
  // Anthropic rejects a tool definition whose input schema carries a top-level
  // `anyOf`, so the file-vs-ref exclusivity is stated in the field descriptions
  // here and enforced authoritatively by the strict union in `validate` below
  // (see #1228 — a union-generated `anyOf` had been leaking onto the wire).
  const providerReadParameters = z
    .object({
      path: pathField
        .describe(
          'A file path; relative paths are resolved from the session cwd. Provide either path (optionally with offset/limit) or ref, never both.',
        )
        .optional(),
      offset: offsetField,
      limit: limitField,
      ref: refField
        .describe(
          'A runtime resource ref returned by another tool. Provide ref on its own, without path/offset/limit; omit it (or leave it empty) when reading a file.',
        )
        .optional(),
    })
    .describe(
      'Read a file with path (optionally offset/limit), or a whole runtime resource with ref; provide exactly one of path or ref.',
    );
  const providerReadSchema = zodSchema(providerReadParameters);
  const readParameters = options.runtimeResources
    ? jsonSchema(async () => await providerReadSchema.jsonSchema, {
        validate: async (value) => {
          const result = await strictReadParameters.safeParseAsync(value);
          return result.success
            ? { success: true, value: result.data }
            : { success: false, error: result.error };
        },
      })
    : fileReadParameters;
  const shell = options.shell ?? defaultShellPlan();
  const sandboxPlatform = options.sandboxPlatform ?? process.platform;
  const bashTools = options.shellRuns
    ? [
        buildManagedBashTool(options.shellRuns, {
          executionFacts,
          shell,
          ...(options.sandboxManager
            ? {
                transformCommand: ({ command, pty, requiredBoundary, ctx }) =>
                  sandboxCommand(
                    options.sandboxManager!,
                    options.permissionProfile,
                    sandboxPlatform,
                    command,
                    pty,
                    ctx,
                    requiredBoundary,
                    'background_command',
                  ),
              }
            : {}),
        }),
      ]
    : [
        buildExecutorBashTool(executor, shell, {
          ...(options.permissionProfile ? { permissionProfile: options.permissionProfile } : {}),
          ...(options.sandboxManager ? { sandboxManager: options.sandboxManager } : {}),
          sandboxPlatform,
        }),
      ];
  const backgroundTools = [
    ...(options.backgroundTasks ? [buildStopBackgroundTaskTool(options.backgroundTasks)] : []),
    ...(options.ptyControls ? [buildWriteStdinTool(options.ptyControls)] : []),
  ];
  const tools: MakaTool[] = [
    ...bashTools,
    ...backgroundTools,
    ...(options.archiveResources ? [buildArchiveReadTool(options.archiveResources)] : []),
    {
      name: 'Read',
      activityKind: 'read',
      description: readDescription,
      parameters: readParameters,
      executionFacts,
      impl: async (input, ctx) => {
        const { cwd, sessionId, abortSignal } = ctx;
        if ('ref' in input) {
          const { ref } = input;
          if (classifyRuntimeResourceRef(ref) !== 'runtime') {
            throw new Error(`Unsupported runtime resource ref: ${ref}`);
          }
          if (!options.runtimeResources)
            throw new Error('Runtime resources are not available in this toolset');
          return await options.runtimeResources.readRuntimeResource(sessionId, ref, abortSignal);
        }

        const { path, offset, limit } = input;
        const runtimeRef = classifyRuntimeResourceRef(path);
        if (runtimeRef === 'unsupported')
          throw new Error(`Unsupported runtime resource ref: ${path}`);
        if (runtimeRef === 'runtime') {
          throw new Error('Runtime resources must be read with the ref parameter, not path');
        }
        const filesystemWorker = filesystemWorkerForExecution(options.filesystemWorker, ctx);
        if (filesystemWorker) {
          const canonicalCwd = canonicalExistingPath(cwd);
          const result = await filesystemWorker.execute({
            operation: {
              kind: 'read',
              path,
              ...(offset !== undefined ? { offset } : {}),
              ...(limit !== undefined ? { limit } : {}),
            },
            cwd: canonicalCwd,
            ...(ctx.executionBoundary ? { executionBoundary: ctx.executionBoundary } : {}),
            mode: ctx.permissionMode ?? 'ask',
            ...(options.permissionProfile ? { permissionProfile: options.permissionProfile } : {}),
            ...(abortSignal ? { abortSignal } : {}),
          });
          if (result.kind === 'read_image') {
            if (!options.snapshotImage)
              throw new Error('Read image snapshots are not available in this toolset.');
            const ref = await options.snapshotImage({
              sessionId,
              turnId: ctx.turnId,
              name: basename(path),
              bytes: Buffer.from(result.base64, 'base64'),
              mimeType: result.mimeType,
            });
            return { kind: 'image' as const, mimeType: result.mimeType, ref };
          }
          if (result.kind !== 'read')
            throw new Error('Filesystem worker returned a mismatched Read result.');
          return { content: result.content };
        }
        const { path: resolvedPath } = await executor.resolveExistingPath({
          cwd,
          path,
          label: 'Read',
        });
        const result = await executor.readFile({
          cwd,
          path: resolvedPath,
          ...(offset !== undefined ? { offset } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        if ('bytes' in result) {
          if (!options.snapshotImage)
            throw new Error('Read image snapshots are not available in this toolset.');
          const ref = await options.snapshotImage({
            sessionId,
            turnId: ctx.turnId,
            name: basename(path),
            bytes: result.bytes,
            mimeType: result.mimeType,
          });
          return { kind: 'image' as const, mimeType: result.mimeType, ref };
        }
        return result;
      },
    },
    {
      name: 'Write',
      activityKind: 'edit',
      description:
        'Write content to a file using a path relative to the session cwd. ' +
        'Absolute paths and parent traversal are rejected. Subject to permission policy.',
      parameters: z.object({
        path: z
          .string()
          .describe(
            'Path relative to the session cwd. Absolute paths and parent traversal are rejected.',
          ),
        content: z.string(),
      }),
      executionFacts,
      impl: async ({ path, content }, ctx) => {
        const { cwd } = ctx;
        const filesystemWorker = filesystemWorkerForExecution(options.filesystemWorker, ctx);
        const canonicalCwd = filesystemWorker ? canonicalExistingPath(cwd) : cwd;
        const key = filesystemWorker
          ? await fileToolWriteLockKey(canonicalCwd, path)
          : (await executor.writeLockKey({ cwd, path })).key;
        return await withFileWriteLock(key, async () => {
          if (filesystemWorker) {
            const result = await filesystemWorker.execute({
              operation: { kind: 'write', path, content },
              cwd: canonicalCwd,
              ...(ctx.executionBoundary ? { executionBoundary: ctx.executionBoundary } : {}),
              mode: ctx.permissionMode ?? 'ask',
              ...(options.permissionProfile
                ? { permissionProfile: options.permissionProfile }
                : {}),
              ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
            });
            if (result.kind !== 'write')
              throw new Error('Filesystem worker returned a mismatched Write result.');
            return { ok: result.ok, path: result.path, bytes: result.bytes };
          }
          const { path: resolvedPath } = await executor.resolveWritablePath({
            cwd,
            path,
            label: 'Write',
          });
          return await executor.writeFile({ cwd, path: resolvedPath, content });
        });
      },
    },
    {
      name: 'Edit',
      activityKind: 'edit',
      description:
        'Replace old_string with new_string in a file. Prefers an exact, unique match; ' +
        'if exact fails it tolerates limited whitespace/indentation/escape drift in old_string, ' +
        'but only when the match is unambiguous (otherwise it errors — re-read and retry with exact text). ' +
        'new_string is written verbatim, so provide the exact final text/indentation you want. ' +
        'Errors if old_string is not found or not unique.',
      parameters: z.object({
        path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
      }),
      executionFacts,
      impl: async ({ path, old_string, new_string }, ctx) => {
        const { cwd } = ctx;
        const filesystemWorker = filesystemWorkerForExecution(options.filesystemWorker, ctx);
        const canonicalCwd = filesystemWorker ? canonicalExistingPath(cwd) : cwd;
        const key = filesystemWorker
          ? await fileToolWriteLockKey(canonicalCwd, path)
          : (await executor.writeLockKey({ cwd, path })).key;
        return await withFileWriteLock(key, async () => {
          if (filesystemWorker) {
            const result = await filesystemWorker.execute({
              operation: {
                kind: 'edit',
                path,
                oldString: old_string,
                newString: new_string,
              },
              cwd: canonicalCwd,
              ...(ctx.executionBoundary ? { executionBoundary: ctx.executionBoundary } : {}),
              mode: ctx.permissionMode ?? 'ask',
              ...(options.permissionProfile
                ? { permissionProfile: options.permissionProfile }
                : {}),
              ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
            });
            if (result.kind !== 'edit')
              throw new Error('Filesystem worker returned a mismatched Edit result.');
            return {
              ok: result.ok,
              path: result.path,
              replacements: result.replacements,
              matchedVia: result.matchedVia,
              startLine: result.startLine,
              endLine: result.endLine,
            };
          }
          const { path: resolvedPath } = await executor.resolveExistingPath({
            cwd,
            path,
            label: 'Edit',
          });
          const read = await executor.readFile({ cwd, path: resolvedPath });
          if ('bytes' in read) throw new Error('Edit does not support image files.');
          const current = read.content;
          const result = computeEditedSource(current, old_string, new_string, path);
          await executor.writeFile({ cwd, path: resolvedPath, content: result.content });
          return {
            ok: true,
            path: resolvedPath,
            replacements: 1,
            matchedVia: result.matchedVia,
            startLine: result.startLine,
            endLine: result.endLine,
          };
        });
      },
    },
    {
      name: 'ApplyPatch',
      activityKind: 'edit',
      categoryHint: 'file_write',
      description:
        'Apply a Codex-compatible multi-file patch in one call. Pass the full patch ' +
        'envelope (*** Begin Patch … *** End Patch) with Add File / Update File ' +
        '(optional Move to) / Delete File operations. Paths must be relative to the ' +
        'session cwd. The complete patch is parsed and preflighted before any mutation; ' +
        'syntax errors, path escapes, missing targets, and hunk mismatches leave the ' +
        'workspace unchanged. Subject to permission policy.',
      parameters: z.object({
        patch: z
          .string()
          .describe('Full *** Begin Patch … *** End Patch text (Codex apply_patch envelope).'),
      }),
      executionFacts,
      impl: async ({ patch }, ctx) => {
        const fs = createRuntimeApplyPatchFs({
          ctx,
          executor,
          filesystemWorker: options.filesystemWorker,
          permissionProfile: options.permissionProfile,
        });
        return await executeApplyPatchWithAdapter(patch, fs, withFileWriteLock);
      },
    },
    {
      name: 'FormatJson',
      activityKind: 'edit',
      description:
        'Validate and normalize a JSON file in place. Reads the file at `path`, ' +
        'parses it (throwing a parse-error hint on invalid JSON), optionally sorts ' +
        'object keys lexicographically, and rewrites it with canonical 2-space ' +
        'indentation. Returns only a diagnostic (valid + byte delta) — the content ' +
        'is never round-tripped back through the prompt. Useful for config hygiene ' +
        'after a Write.',
      parameters: z.object({
        path: z
          .string()
          .describe(
            'Path to the JSON file to validate and normalize, relative to the session cwd.',
          ),
        sort_keys: z
          .boolean()
          .optional()
          .describe('Sort object keys lexicographically; default false.'),
      }),
      executionFacts,
      impl: async ({ path, sort_keys }, ctx) => {
        const { cwd } = ctx;
        const filesystemWorker = filesystemWorkerForExecution(options.filesystemWorker, ctx);
        const canonicalCwd = filesystemWorker ? canonicalExistingPath(cwd) : cwd;
        const key = filesystemWorker
          ? await fileToolWriteLockKey(canonicalCwd, path)
          : (await executor.writeLockKey({ cwd, path })).key;
        return await withFileWriteLock(key, async () => {
          if (filesystemWorker) {
            const result = await filesystemWorker.execute({
              operation: { kind: 'format_json', path, sortKeys: sort_keys ?? false },
              cwd: canonicalCwd,
              ...(ctx.executionBoundary ? { executionBoundary: ctx.executionBoundary } : {}),
              mode: ctx.permissionMode ?? 'ask',
              ...(options.permissionProfile
                ? { permissionProfile: options.permissionProfile }
                : {}),
              ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
            });
            if (result.kind !== 'format_json') {
              throw new Error('Filesystem worker returned a mismatched FormatJson result.');
            }
            return result;
          }
          const { path: resolvedPath } = await executor.resolveExistingPath({
            cwd,
            path,
            label: 'FormatJson',
          });
          const read = await executor.readFile({ cwd, path: resolvedPath });
          if ('bytes' in read) throw new Error('FormatJson does not support image files.');
          const original = read.content;
          const bytesBefore = Buffer.byteLength(original, 'utf8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(original);
          } catch (e) {
            return {
              ok: false,
              valid: false,
              error: `FormatJson: invalid JSON: ${(e as Error).message}`,
              path: resolvedPath,
              bytesBefore,
              byteDelta: 0,
              changed: false,
            };
          }
          const value = sort_keys ? sortKeysDeep(parsed) : parsed;
          const formatted = JSON.stringify(value, null, 2);
          const { bytes: bytesAfter } = await executor.writeFile({
            cwd,
            path: resolvedPath,
            content: formatted,
          });
          return {
            ok: true,
            path: resolvedPath,
            valid: true,
            bytesBefore,
            bytesAfter,
            byteDelta: bytesAfter - bytesBefore,
            changed: formatted !== original,
          };
        });
      },
    },
    {
      name: 'Glob',
      activityKind: 'search',
      description:
        'Find files matching a glob pattern (case-insensitive, capped at 200, sorted by walk order).',
      parameters: z.object({
        pattern: z
          .string()
          .describe(
            'Relative glob pattern without an absolute path or "..", for example "**/*.txt".',
          ),
        cwd: z
          .string()
          .optional()
          .describe(
            'Optional search directory inside the session cwd. Absolute or relative directory paths are accepted.',
          ),
      }),
      executionFacts,
      impl: async ({ pattern, cwd: relCwd }, ctx) => {
        const { cwd } = ctx;
        assertRelativeGlobPattern(pattern);
        const filesystemWorker = filesystemWorkerForExecution(options.filesystemWorker, ctx);
        if (filesystemWorker) {
          const canonicalCwd = canonicalExistingPath(cwd);
          const result = await filesystemWorker.execute({
            operation: { kind: 'glob', path: relCwd ?? '.', pattern, limit: 200 },
            cwd: canonicalCwd,
            ...(ctx.executionBoundary ? { executionBoundary: ctx.executionBoundary } : {}),
            mode: ctx.permissionMode ?? 'ask',
            ...(options.permissionProfile ? { permissionProfile: options.permissionProfile } : {}),
            ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
          });
          if (result.kind !== 'glob')
            throw new Error('Filesystem worker returned a mismatched Glob result.');
          return { files: result.files };
        }
        const { path: base } = await executor.resolveExistingPath({
          cwd,
          path: relCwd ?? '.',
          label: 'Glob cwd',
        });
        return await executor.globFiles({ cwd: base, pattern, limit: 200 });
      },
    },
    {
      name: 'Grep',
      activityKind: 'search',
      description: 'Search file contents with a regex via ripgrep.',
      parameters: z.object({
        pattern: z.string(),
        path: z.string().optional(),
        glob: z.string().optional(),
      }),
      executionFacts,
      impl: async ({ pattern, path, glob }, ctx) => {
        const { cwd, abortSignal } = ctx;
        const filesystemWorker = filesystemWorkerForExecution(options.filesystemWorker, ctx);
        if (filesystemWorker) {
          const canonicalCwd = canonicalExistingPath(cwd);
          const result = await filesystemWorker.execute({
            operation: {
              kind: 'grep',
              path: path ?? '.',
              pattern,
              ...(glob ? { glob } : {}),
              maxCountPerFile: 50,
              limit: 200,
              timeoutMs: GREP_TIMEOUT_MS,
            },
            cwd: canonicalCwd,
            ...(ctx.executionBoundary ? { executionBoundary: ctx.executionBoundary } : {}),
            mode: ctx.permissionMode ?? 'ask',
            ...(options.permissionProfile ? { permissionProfile: options.permissionProfile } : {}),
            ...(abortSignal ? { abortSignal } : {}),
          });
          if (result.kind !== 'grep')
            throw new Error('Filesystem worker returned a mismatched Grep result.');
          return { matches: result.matches };
        }
        const { path: searchPath } = await executor.resolveExistingPath({
          cwd,
          path: path ?? '.',
          label: 'Grep',
        });
        // Self-bound: ripgrep finishes in well under a second normally, but a
        // pathological tree (network mount, /proc, a FIFO) could hang it. The
        // stream watchdog no longer caps tool execution, so each spawning tool
        // must carry its own wall-clock timeout and honour the turn's abort.
        return await executor.grepFiles({
          cwd,
          pattern,
          path: searchPath,
          ...(glob ? { glob } : {}),
          maxCountPerFile: 50,
          limit: 200,
          timeoutMs: GREP_TIMEOUT_MS,
          ...(abortSignal ? { abortSignal } : {}),
        });
      },
    },
  ];
  // Builders bind implementations only. The normalized per-run product-tool
  // policy is the single authority that selects the editing protocol.
  return tools.filter((tool) => tool.name !== 'Edit' || options.includeEdit !== false);
}

function filesystemWorkerForExecution(
  worker: Pick<FilesystemWorkerClient, 'execute'> | undefined,
  ctx: MakaToolContext,
): Pick<FilesystemWorkerClient, 'execute'> | undefined {
  if (ctx.executionBoundary?.kind === 'bypass' || ctx.executionBoundary?.kind === 'external') {
    return undefined;
  }
  if (worker) return worker;
  if (ctx.executionBoundary?.kind !== 'managed') return undefined;
  throw new SandboxCommandError({
    domain: 'filesystem',
    stage: 'capability',
    reason: 'requires_bypass',
    recoverable: false,
    profileName: ctx.executionBoundary.profile.name ?? ctx.executionBoundary.profile.type,
    message:
      'Managed filesystem execution is unavailable because the sandboxed worker cannot be enforced.',
  });
}

interface ExecutorBashSandboxOptions {
  permissionProfile?: PermissionProfile;
  sandboxManager?: SandboxManager;
  sandboxPlatform: SandboxPlatform;
}

function buildExecutorBashTool(
  executor: WorkspaceExecutor,
  shell: ShellPlan,
  sandboxOptions: ExecutorBashSandboxOptions,
): MakaTool {
  return {
    name: 'Bash',
    activityKind: 'command',
    description:
      withShellGuidance('Run a shell command in the session cwd.', shell) +
      ' Enforced by the current session sandbox boundary.',
    parameters: z
      .object({
        command: z.string().describe('The shell command to execute'),
        timeout_ms: z.number().int().positive().max(600_000).optional(),
        required_boundary: sandboxBoundaryExpansionSchema
          .optional()
          .describe(
            'Declare the exact filesystem or network sandbox authority this command requires. Do not infer it from command text.',
          ),
      })
      .strict(),
    toModelOutput: ({ output }) => bashToolResultToModelOutput(output),
    executionFacts: executor.facts,
    impl: async ({ command, timeout_ms, required_boundary }, ctx) => {
      const normalizedRequiredBoundary = await preflightDeclaredSandboxBoundary(
        required_boundary,
        ctx,
      );
      const { cwd, abortSignal, emitOutput } = ctx;
      const timeout = timeout_ms ?? 120_000;
      if (
        !sandboxOptions.sandboxManager &&
        ctx.executionBoundary?.kind === 'managed' &&
        profileRequiresSandbox(ctx.executionBoundary.profile)
      ) {
        throw new SandboxCommandError({
          domain: 'command',
          stage: 'capability',
          reason: 'requires_bypass',
          recoverable: false,
          profileName: ctx.executionBoundary.profile.name ?? ctx.executionBoundary.profile.type,
          message:
            'Managed Bash execution is unavailable because a command sandbox cannot be enforced.',
        });
      }
      const transformed = sandboxOptions.sandboxManager
        ? sandboxCommand(
            sandboxOptions.sandboxManager,
            sandboxOptions.permissionProfile,
            sandboxOptions.sandboxPlatform,
            command,
            false,
            ctx,
            normalizedRequiredBoundary,
          )
        : undefined;
      let successful = false;
      try {
        const result = await executor.exec({
          command,
          cwd: transformed?.cwd ?? cwd,
          ...(transformed?.argv ? { argv: transformed.argv } : {}),
          ...(transformed?.env ? { env: transformed.env } : {}),
          ...(transformed?.fdInputs ? { fdInputs: transformed.fdInputs } : {}),
          timeoutMs: timeout,
          ...(abortSignal ? { abortSignal } : {}),
          emitOutput,
          shell,
        });
        const executionResult = {
          ...result,
          ...(transformed?.sandboxType ? { sandboxType: transformed.sandboxType } : {}),
          ...(transformed?.profileName ? { profileName: transformed.profileName } : {}),
          sandboxed:
            transformed?.sandboxType === 'macos-seatbelt' || transformed?.sandboxType === 'linux',
        };
        if (executionResult.timedOut)
          throw terminalError(`Command timed out after ${timeout}ms`, executionResult, 124);
        if (executionResult.aborted) throw terminalError('Command aborted', executionResult, 130);
        if (executionResult.exitCode !== 0) {
          throw terminalError(
            `Command failed with exit code ${executionResult.exitCode}`,
            executionResult,
            executionResult.exitCode,
          );
        }
        successful = true;
        return shapeTerminalResult({ cwd, command, result: executionResult });
      } finally {
        transformed?.onCompletion?.({ successful });
      }
    },
  };
}

function sandboxCommand(
  manager: SandboxManager,
  explicitProfile: PermissionProfile | undefined,
  platform: SandboxPlatform,
  command: string,
  pty: boolean,
  ctx: MakaToolContext,
  requiredBoundary?: SandboxBoundaryExpansion,
  domain: 'command' | 'background_command' = 'command',
):
  | {
      argv?: readonly string[];
      cwd: string;
      env?: NodeJS.ProcessEnv;
      fdInputs?: readonly ChildFdInput[];
      sandboxType?: SandboxType;
      profileName?: string;
      onCompletion?: (outcome: { successful: boolean }) => void;
    }
  | undefined {
  const cwd = canonicalExistingPath(ctx.cwd);
  const boundary = ctx.executionBoundary;
  if (boundary?.kind === 'bypass' || boundary?.kind === 'external') return undefined;
  const effective =
    boundary?.kind === 'managed'
      ? { profile: boundary.profile, workspaceRoots: [cwd] }
      : effectivePermissionProfile(explicitProfile, ctx.permissionMode ?? 'ask', cwd);
  const env = { ...process.env };
  if (pty) {
    if (profileRequiresSandbox(effective.profile)) {
      throw new SandboxCommandError({
        domain,
        stage: 'capability',
        reason: boundary ? 'requires_bypass' : 'pty_sandbox_unavailable',
        recoverable: false,
        profileName: effective.profile.name ?? effective.profile.type,
        message:
          'PTY Bash is unavailable while the active permission profile requires command sandboxing.',
      });
    }
    return undefined;
  }
  if (!manager.canEnforce({ profile: effective.profile, platform })) {
    if (profileRequiresSandbox(effective.profile)) {
      const selection = manager.selectInitial({ profile: effective.profile, platform });
      throw new SandboxCommandError({
        domain,
        stage: selection.ok ? 'capability' : 'selection',
        reason: selection.ok ? 'backend_not_available' : selection.reason,
        backend: selection.sandboxType,
        recoverable: false,
        profileName: effective.profile.name ?? effective.profile.type,
        message: `Command sandbox is required but unavailable on platform ${platform}.`,
      });
    }
    return undefined;
  }

  let preparedProfile: PreparedLinuxProfilePaths = { paths: [], unavailablePaths: [] };
  try {
    preparedProfile = prepareLinuxBashProfilePaths(
      platform,
      effective.profile,
      effective.workspaceRoots,
      requiredBoundary,
    );
  } catch {
    throw new SandboxCommandError({
      domain,
      stage: 'validation',
      reason: 'sandbox_path_changed',
      backend: 'linux',
      recoverable: false,
      profileName: effective.profile.name ?? effective.profile.type,
      message: 'An approved sandbox path could not be pinned safely.',
    });
  }
  const onCompletion = preparedProfilePathCompletion(preparedProfile.paths);

  let result: ReturnType<SandboxManager['transform']>;
  try {
    result = manager.transform({
      platform,
      command: {
        program: '/bin/sh',
        args: ['-c', command],
        cwd,
        env,
        profile: effective.profile,
        pathContext: {
          workspaceRoots: effective.workspaceRoots,
          tmpdir: tmpdir(),
          slashTmp: '/tmp',
          ...(platform === 'darwin'
            ? {
                executableRoots: macosRuntimeExecutableRoots(process.execPath),
              }
            : {}),
          ...(platform === 'linux'
            ? {
                minimalRoots: linuxExecutableRoots({
                  execPath: process.execPath,
                  path: env.PATH,
                }),
                ...(preparedProfile.paths.length > 0
                  ? {
                      pinnedProfilePaths: preparedProfile.paths.map((path) => ({
                        path: path.path,
                        access: path.access,
                        fd: path.childFd,
                        sourceFd: path.sourceFd,
                        releaseSource: path.releaseSource,
                      })),
                    }
                  : {}),
                ...(preparedProfile.unavailablePaths.length > 0
                  ? { unavailableProfilePaths: preparedProfile.unavailablePaths }
                  : {}),
              }
            : {}),
        },
      },
    });
  } catch (error) {
    onCompletion?.({ successful: false });
    throw error;
  }
  if (!result.ok) {
    onCompletion?.({ successful: false });
    throw new SandboxCommandError({
      domain,
      stage: 'transform',
      reason: result.reason,
      backend: result.sandboxType,
      recoverable: false,
      profileName: effective.profile.name ?? effective.profile.type,
      message: result.message ?? `Sandbox transform failed: ${result.reason}`,
    });
  }
  return {
    argv: result.exec.argv,
    cwd: result.exec.cwd,
    ...(result.exec.env ? { env: { ...result.exec.env } } : {}),
    ...(result.exec.fdInputs ? { fdInputs: result.exec.fdInputs } : {}),
    sandboxType: result.exec.sandboxType,
    profileName: result.exec.effectiveProfile.name ?? result.exec.effectiveProfile.type,
    ...(onCompletion ? { onCompletion } : {}),
  };
}

interface PreparedProfilePath {
  readonly path: string;
  readonly access: 'read' | 'write';
  readonly created: boolean;
  readonly sourceFd: number;
  readonly releaseSource: () => void;
  readonly childFd: number;
  readonly device: bigint;
  readonly inode: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface PreparedLinuxProfilePaths {
  readonly paths: readonly PreparedProfilePath[];
  readonly unavailablePaths: readonly string[];
}

function prepareLinuxBashProfilePaths(
  platform: SandboxPlatform,
  profile: PermissionProfile,
  workspaceRoots: readonly string[],
  requiredBoundary?: SandboxBoundaryExpansion,
): PreparedLinuxProfilePaths {
  if (
    platform !== 'linux' ||
    profile.type !== 'managed' ||
    profile.fileSystem.kind !== 'restricted'
  ) {
    return { paths: [], unavailablePaths: [] };
  }
  const activeExactPaths = new Set(
    (requiredBoundary?.filesystem?.entries ?? []).flatMap((entry) =>
      entry.scope === 'exact' ? [entry.path] : [],
    ),
  );
  const candidates = new Map<string, { access: 'read' | 'write'; match: 'exact' | 'subtree' }>();
  for (const entry of profile.fileSystem.entries) {
    if (entry.access === 'deny') continue;
    if (entry.kind === 'special') {
      if (entry.special !== ':workspace_roots') continue;
      for (const workspaceRoot of workspaceRoots) {
        const existing = candidates.get(workspaceRoot);
        candidates.set(
          workspaceRoot,
          existing?.access === 'write' ? existing : { access: entry.access, match: 'subtree' },
        );
      }
      continue;
    }
    const match = entry.match ?? 'subtree';
    if (match === 'exact' && !activeExactPaths.has(entry.path)) continue;
    const existing = candidates.get(entry.path);
    candidates.set(
      entry.path,
      existing?.access === 'write' ? existing : { access: entry.access, match },
    );
  }
  const prepared: PreparedProfilePath[] = [];
  const unavailablePaths: string[] = [];
  try {
    for (const [target, { access, match }] of candidates) {
      const existing = (() => {
        try {
          return lstatSync(target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        }
      })();
      if (!existing) {
        if (match !== 'exact' || access !== 'write') {
          unavailablePaths.push(target);
          continue;
        }
        const fd = openMissingExactWriteTarget(target);
        let sourceOpen = true;
        const releaseSource = () => {
          if (!sourceOpen) return;
          sourceOpen = false;
          closeSync(fd);
        };
        try {
          // A deliberately old marker distinguishes a successful no-op from an
          // intentional empty write, which updates mtime/ctime even at size zero.
          futimesSync(fd, 1, 1);
          const metadata = fstatSync(fd, { bigint: true });
          prepared.push({
            path: target,
            access,
            created: true,
            sourceFd: fd,
            releaseSource,
            childFd: 4 + prepared.length,
            device: metadata.dev,
            inode: metadata.ino,
            mtimeNs: metadata.mtimeNs,
            ctimeNs: metadata.ctimeNs,
          });
        } catch (error) {
          releaseSource();
          throw error;
        }
        continue;
      }
      const pinned = pinExistingLinuxProfilePath({
        path: target,
        access,
        targetType: match === 'exact' ? 'file' : 'directory',
        childFd: 4 + prepared.length,
      });
      if (!pinned) throw new Error(`Approved sandbox path disappeared: ${target}`);
      prepared.push({ ...pinned, created: false });
    }
    return { paths: prepared, unavailablePaths };
  } catch (error) {
    completePreparedProfilePaths(prepared);
    throw error;
  }
}

/** @internal Exported for the Linux parent-swap regression test. */
export function openMissingExactWriteTarget(path: string, afterParentPinned?: () => void): number {
  const parent = dirname(path);
  if (realpathSync(parent) !== parent) throw new Error('Exact write target parent changed.');

  const createFlags =
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0);
  if (process.platform !== 'linux') return openSync(path, createFlags, 0o666);

  const linuxConstants = constants as typeof constants & { O_PATH?: number };
  const parentFlags =
    (linuxConstants.O_PATH ?? constants.O_RDONLY) |
    (constants.O_DIRECTORY ?? 0) |
    (constants.O_NOFOLLOW ?? 0);
  const parentFd = openSync(parent, parentFlags);
  try {
    const pinnedParent = `/proc/self/fd/${parentFd}`;
    afterParentPinned?.();
    if (realpathSync(pinnedParent) !== parent) {
      throw new Error('Exact write target parent changed after pinning.');
    }
    return openSync(`${pinnedParent}/${basename(path)}`, createFlags, 0o666);
  } finally {
    closeSync(parentFd);
  }
}

function preparedProfilePathCompletion(
  paths: readonly PreparedProfilePath[],
): ((outcome: { successful: boolean }) => void) | undefined {
  if (paths.length === 0) return undefined;
  let completed = false;
  return () => {
    if (completed) return;
    completed = true;
    completePreparedProfilePaths(paths);
  };
}

function completePreparedProfilePaths(paths: readonly PreparedProfilePath[]): void {
  for (const target of paths) {
    try {
      target.releaseSource();
    } catch {
      // Launch cleanup is best effort; the close-once owner prevents fd-number reuse bugs.
    }
    if (!target.created) continue;
    try {
      const metadata = lstatSync(target.path, { bigint: true });
      const untouched = metadata.mtimeNs === target.mtimeNs && metadata.ctimeNs === target.ctimeNs;
      if (
        metadata.isFile() &&
        metadata.dev === target.device &&
        metadata.ino === target.inode &&
        metadata.size === 0n &&
        untouched
      ) {
        unlinkSync(target.path);
      }
    } catch {
      // The target was already removed or changed; never delete an unverified replacement.
    }
  }
}

function canonicalExistingPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function macosRuntimeExecutableRoots(execPath: string): readonly string[] {
  return [
    ...linuxExecutableRoots({ execPath }),
    ...(execPath.startsWith('/opt/homebrew/') ? ['/opt/homebrew'] : []),
    ...(execPath.startsWith('/usr/local/') ? ['/usr/local'] : []),
  ];
}

function effectivePermissionProfile(
  explicitProfile: PermissionProfile | undefined,
  permissionMode: NonNullable<MakaToolContext['permissionMode']>,
  cwd: string,
): { profile: PermissionProfile; workspaceRoots: readonly string[] } {
  const canonicalCwd = canonicalExistingPath(cwd);
  if (explicitProfile) return { profile: explicitProfile, workspaceRoots: [canonicalCwd] };
  const compiled = compilePermissionProfile({ mode: permissionMode, cwd: canonicalCwd });
  return { profile: compiled.profile, workspaceRoots: compiled.workspaceRoots };
}

async function fileToolWriteLockKey(cwd: string, path: string): Promise<string> {
  const target = await normalizeSandboxBoundaryPath({
    path,
    access: 'write',
    scope: 'exact',
    cwd,
  });
  return target.enforcementPath;
}

interface RuntimeApplyPatchDeps {
  ctx: MakaToolContext;
  executor: WorkspaceExecutor;
  filesystemWorker?: Pick<FilesystemWorkerClient, 'execute'>;
  permissionProfile?: PermissionProfile;
}

function createRuntimeApplyPatchFs(input: RuntimeApplyPatchDeps): ApplyPatchFsAdapter {
  const { cwd } = input.ctx;
  const filesystemWorker = filesystemWorkerForExecution(input.filesystemWorker, input.ctx);
  const canonicalCwd = filesystemWorker ? canonicalExistingPath(cwd) : cwd;

  const workerExecute = async (operation: {
    kind: 'lstat' | 'read' | 'write' | 'delete';
    path: string;
    content?: string;
    mode?: 'create' | 'replace';
  }) => {
    if (!filesystemWorker) throw new Error('Filesystem worker is unavailable.');
    return filesystemWorker.execute({
      operation:
        operation.kind === 'write'
          ? {
              kind: 'write',
              path: operation.path,
              content: operation.content ?? '',
              ...(operation.mode ? { mode: operation.mode } : {}),
            }
          : operation.kind === 'delete'
            ? { kind: 'delete', path: operation.path }
            : operation.kind === 'lstat'
              ? { kind: 'lstat', path: operation.path }
              : { kind: 'read', path: operation.path },
      cwd: canonicalCwd,
      ...(input.ctx.executionBoundary ? { executionBoundary: input.ctx.executionBoundary } : {}),
      mode: input.ctx.permissionMode ?? 'ask',
      ...(input.permissionProfile ? { permissionProfile: input.permissionProfile } : {}),
      ...(input.ctx.abortSignal ? { abortSignal: input.ctx.abortSignal } : {}),
    });
  };

  return {
    async lockKey(path) {
      if (filesystemWorker) {
        await assertApplyPatchPathContained(canonicalCwd, path);
        return fileToolWriteLockKey(canonicalCwd, path);
      }
      return (await input.executor.writeLockKey({ cwd, path })).key;
    },
    async lstat(path) {
      if (filesystemWorker) {
        const result = await workerExecute({ kind: 'lstat', path });
        if (result.kind !== 'lstat')
          throw new Error('Filesystem worker returned mismatched lstat.');
        return result.targetType;
      }
      const target = await assertApplyPatchPathContained(cwd, path, false);
      try {
        const metadata = await lstat(target.displayPath);
        if (metadata.isSymbolicLink()) return 'symlink';
        if (metadata.isFile()) return 'file';
        return 'other';
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error.code === 'ENOENT' || error.code === 'ENOTDIR')
        ) {
          return 'missing';
        }
        throw error;
      }
    },
    async readText(path, label) {
      if (filesystemWorker) {
        const result = await workerExecute({ kind: 'read', path });
        if (result.kind === 'read_image') throw new Error(`${label} does not support image files.`);
        if (result.kind !== 'read') throw new Error(`${label}: unexpected read result for ${path}`);
        return result.content;
      }
      const { path: resolvedPath } = await input.executor.resolveExistingPath({
        cwd,
        path,
        label,
      });
      const read = await input.executor.readFile({ cwd, path: resolvedPath });
      if ('bytes' in read) throw new Error(`${label} does not support image files.`);
      return read.content;
    },
    async writeText(path, content, mode) {
      if (filesystemWorker) {
        const result = await workerExecute({ kind: 'write', path, content, mode });
        if (result.kind !== 'write') {
          throw new Error('Filesystem worker returned a mismatched write.');
        }
        return { path: result.path, bytes: result.bytes };
      }
      const target = await assertApplyPatchPathContained(cwd, path, false);
      await mkdir(dirname(target.enforcementPath), { recursive: true });
      if (mode === 'create') {
        await writeFile(target.displayPath, content, { encoding: 'utf8', flag: 'wx' });
        return { path: target.displayPath, bytes: Buffer.byteLength(content, 'utf8') };
      }
      const metadata = await lstat(target.displayPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`ApplyPatch Update target must be a regular file: ${path}`);
      }
      const handle = await open(
        target.displayPath,
        constants.O_NOFOLLOW === undefined ? 'r+' : constants.O_WRONLY | constants.O_NOFOLLOW,
      );
      try {
        await handle.truncate(0);
        await handle.writeFile(content, 'utf8');
      } finally {
        await handle.close();
      }
      return { path: target.displayPath, bytes: Buffer.byteLength(content, 'utf8') };
    },
    async deletePath(path) {
      if (filesystemWorker) {
        const result = await workerExecute({ kind: 'delete', path });
        if (result.kind !== 'delete') {
          throw new Error('Filesystem worker returned a mismatched delete.');
        }
        return { path: result.path };
      }
      const target = await assertApplyPatchPathContained(cwd, path, false);
      await unlink(target.displayPath);
      return { path: target.displayPath };
    },
    async preflightPermissions(accesses: readonly ApplyPatchAccessIntent[]) {
      await preflightApplyPatchPermissions({
        accesses,
        cwd,
        canonicalCwd,
        ctx: input.ctx,
        executor: input.executor,
        filesystemWorker,
        permissionProfile: input.permissionProfile,
      });
    },
  };
}

async function assertApplyPatchPathContained(
  cwd: string,
  path: string,
  followFinalSymlink = true,
): Promise<Awaited<ReturnType<typeof normalizeSandboxBoundaryPath>>> {
  const root = await realpath(cwd);
  const target = await normalizeSandboxBoundaryPath({
    path,
    access: 'write',
    scope: 'exact',
    cwd: root,
    followFinalSymlink,
  });
  if (!isPathInside(root, target.displayPath) || !isPathInside(root, target.enforcementPath)) {
    throw new Error(`ApplyPatch path must stay inside session cwd: ${path}`);
  }
  return target;
}

async function preflightApplyPatchPermissions(input: {
  accesses: readonly ApplyPatchAccessIntent[];
  cwd: string;
  canonicalCwd: string;
  ctx: MakaToolContext;
  executor: WorkspaceExecutor;
  filesystemWorker?: Pick<FilesystemWorkerClient, 'execute'>;
  permissionProfile?: PermissionProfile;
}): Promise<void> {
  if (input.accesses.length === 0) return;

  // Without a managed filesystem worker, path resolve is the host safety check.
  if (!input.filesystemWorker) {
    for (const intent of input.accesses) {
      if (intent.access === 'write') {
        await assertApplyPatchPathContained(input.cwd, intent.path);
      } else {
        await input.executor.resolveExistingPath({
          cwd: input.cwd,
          path: intent.path,
          label: 'ApplyPatch preflight',
        });
      }
    }
    return;
  }

  const managed = input.ctx.executionBoundary?.kind === 'managed';
  const platform = process.platform as SandboxPlatform;
  const compiled =
    managed && input.ctx.executionBoundary?.kind === 'managed'
      ? {
          profile: input.ctx.executionBoundary.profile,
          workspaceRoots: [input.canonicalCwd],
        }
      : input.permissionProfile
        ? {
            profile: input.permissionProfile,
            workspaceRoots: [input.canonicalCwd],
          }
        : compilePermissionProfile({
            mode: input.ctx.permissionMode ?? 'ask',
            cwd: input.canonicalCwd,
          });

  const tmpCanonical = await realpath(tmpdir()).catch(() => tmpdir());
  const slashTmpCanonical = await realpath('/tmp').catch(() => '/tmp');
  const missingEntries: Array<{
    path: string;
    access: 'write';
    scope: 'exact';
  }> = [];

  for (const intent of input.accesses) {
    const target = await normalizeSandboxBoundaryPath({
      path: intent.path,
      access: 'write',
      scope: 'exact',
      cwd: input.canonicalCwd,
      followFinalSymlink: false,
    });
    const runtimeWritableRoots = filesystemWorkerRuntimeWritableRoots({
      platform,
      access: 'write',
      enforcementPath: target.enforcementPath,
      targetType: target.targetType,
      ...(isPathInside(input.canonicalCwd, target.enforcementPath)
        ? { workspaceRoot: input.canonicalCwd }
        : {}),
    });
    const pathContext = {
      workspaceRoots: compiled.workspaceRoots,
      tmpdir: tmpCanonical,
      slashTmp: slashTmpCanonical,
      ...(runtimeWritableRoots ? { runtimeWritableRoots } : {}),
    };
    const allowed = canWritePath(compiled.profile, target.enforcementPath, pathContext);
    if (!allowed) {
      missingEntries.push({
        path: target.enforcementPath,
        access: 'write',
        scope: 'exact',
      });
    }
  }

  if (missingEntries.length === 0) return;

  throw new FilesystemWorkerClientError({
    reason: managed ? 'sandbox_boundary_required' : 'path_denied',
    stage: 'validation',
    recoverable: true,
    message: managed
      ? 'ApplyPatch requires sandbox boundary expansion for one or more paths before mutation.'
      : 'ApplyPatch path is not writable under the current permission profile.',
    ...(managed
      ? {
          requiredExpansion: {
            filesystem: {
              entries: missingEntries,
            },
          },
        }
      : {}),
  });
}

function terminalError(
  message: string,
  result: Pick<WorkspaceExecResult, 'stdout' | 'stderr' | 'stdoutTruncated' | 'stderrTruncated'> & {
    sandboxType?: SandboxType;
    sandboxed?: boolean;
    profileName?: string;
  },
  code: number,
): Error {
  const sandboxDenied = isLikelySandboxDenial({
    stdout: result.stdout,
    stderr: result.stderr,
    sandboxed: result.sandboxed === true,
  });
  const error = sandboxDenied
    ? new SandboxCommandError({
        domain: 'command',
        stage: 'operation',
        reason: 'sandbox_denial',
        backend: result.sandboxType,
        recoverable: true,
        profileName: result.profileName,
        message,
      })
    : new Error(message);
  Object.assign(error, {
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    code,
    ...(result.sandboxType ? { sandboxType: result.sandboxType } : {}),
    sandboxed: result.sandboxed === true,
    ...(sandboxDenied ? { reason: 'sandbox_denial', recoverable: true } : {}),
  });
  return error;
}

function assertRelativeGlobPattern(pattern: string): void {
  if (isAbsolute(pattern) || pattern.split(/[\\/]+/).includes('..')) {
    throw new Error('Glob pattern must stay inside session cwd');
  }
}

export function classifyRuntimeResourceRef(path: string): 'runtime' | 'file' | 'unsupported' {
  let url: URL;
  try {
    url = new URL(path);
  } catch {
    return path.trimStart().toLowerCase().startsWith('maka:') ? 'unsupported' : 'file';
  }
  if (url.protocol !== 'maka:') return 'file';
  if (
    url.hostname !== 'runtime' ||
    url.username ||
    url.password ||
    url.port ||
    !url.pathname ||
    url.pathname === '/'
  ) {
    return 'unsupported';
  }
  return 'runtime';
}

// Object.fromEntries creates own data properties, so special keys like
// "__proto__" are preserved instead of triggering the inherited setter.
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
