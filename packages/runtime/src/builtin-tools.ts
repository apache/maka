// packages/runtime/src/builtin-tools.ts
// Phase 1 baseline tool set. Each tool returned as MakaTool[] so
// ToolRuntime settlement decorates these with permission and durable tool facts.
//
// Read / Glob / Grep auto-approve.
// Bash / Write / Edit go through PermissionEngine.

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
  applyAdditionalPermissionProfile,
  compilePermissionProfile,
  type StorageRef,
  type PermissionProfile,
} from '@maka/core';
import { computeEditedSource } from './edit-replace.js';
import { bashToolResultToModelOutput } from './bash-model-output.js';
import {
  buildManagedBashTool,
  buildStopBackgroundTaskTool,
  buildWriteStdinTool,
  bashSandboxPermissionsSchema,
  shapeTerminalResult,
  withShellGuidance,
} from './shell-tools.js';
import type { ManagedBashPermissionArgs, ShellRunLauncher } from './shell-tools.js';
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

// tool-runtime.ts is the single source of truth for the tool shape; this
// re-export only keeps back-compat for callers that imported from
// builtin-tools directly.
import type { MakaTool, MakaToolContext } from './tool-runtime.js';
export type { MakaTool, MakaToolContext };
import { withFileWriteLock } from './file-write-lock.js';
import type { SandboxManager } from './sandbox/sandbox-manager.js';
import { SandboxCommandError } from './sandbox/errors.js';
import { isLikelySandboxDenial } from './sandbox/detect.js';
import { linuxExecutableRoots } from './sandbox/linux-sandbox.js';
import type { SandboxPlatform, SandboxType } from './sandbox/types.js';
import type { ChildFdInput } from './child-fd-input.js';
import { buildArchiveReadTool } from './archive-read-tool.js';
import type { ToolResultArchiveResourceReader } from './tool-result-archive-resource.js';
import {
  normalizeAdditionalPermissionPath,
  planDeclaredBashAdditionalPermission,
  planFileToolAdditionalPermission,
  type AdditionalPermissionGrant,
  type AdditionalPermissionPlannerContext,
  type AdditionalPermissionPlanResult,
} from './additional-permissions.js';
import type { FilesystemWorkerClient } from './filesystem-worker/client.js';
import {
  assertSandboxEscalationGrantForExecution,
  planDeclaredBashSandboxEscalation,
  type SandboxEscalationPlannerContext,
  type SandboxEscalationPlanResult,
} from './sandbox-escalation.js';

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
  /** Enable only when the host consumes additional-permission approval events. */
  enableBashAdditionalPermissions?: boolean;
  /** Sandboxed worker used for all local filesystem tools. */
  filesystemWorker?: Pick<FilesystemWorkerClient, 'execute'>;
  /** Enable inferred one-call path expansion for filesystem tools. */
  enableFileToolAdditionalPermissions?: boolean;
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
  if (options.enableBashAdditionalPermissions && !options.sandboxManager) {
    throw new Error('Bash additional permissions require a sandbox manager.');
  }
  if (options.enableFileToolAdditionalPermissions && !options.filesystemWorker) {
    throw new Error('File tool additional permissions require a sandboxed filesystem worker.');
  }
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
  const strictReadParameters = z
    .union([fileReadParameters, runtimeResourceReadParameters])
    .describe('Read a file with path, or a whole runtime resource with ref; provide exactly one');
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
          'A runtime resource ref returned by another tool. Provide ref on its own, without path/offset/limit.',
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
  if (
    options.enableBashAdditionalPermissions &&
    sandboxPlatform !== 'darwin' &&
    sandboxPlatform !== 'linux'
  ) {
    throw new Error('Bash additional permissions are currently supported only on macOS and Linux.');
  }
  if (
    options.enableFileToolAdditionalPermissions &&
    sandboxPlatform !== 'darwin' &&
    sandboxPlatform !== 'linux'
  ) {
    throw new Error(
      'File tool additional permissions are currently supported only on macOS and Linux.',
    );
  }
  const bashAdditionalPermissionPlanner =
    options.sandboxManager && options.enableBashAdditionalPermissions
      ? createBashAdditionalPermissionPlanner(
          options.sandboxManager,
          options.permissionProfile,
          sandboxPlatform,
        )
      : undefined;
  const bashSandboxEscalationPlanner =
    options.sandboxManager && options.enableBashAdditionalPermissions
      ? createBashSandboxEscalationPlanner()
      : undefined;
  const filePermissionPlanner = options.enableFileToolAdditionalPermissions
    ? createFileToolAdditionalPermissionPlanner(options.permissionProfile)
    : undefined;
  const bashTools = options.shellRuns
    ? [
        buildManagedBashTool(options.shellRuns, {
          executionFacts,
          shell,
          ...(options.sandboxManager
            ? {
                sandbox: sandboxAvailabilityResolver(
                  options.sandboxManager,
                  options.permissionProfile,
                  sandboxPlatform,
                ),
                transformCommand: ({ command, pty, ctx }) =>
                  sandboxCommand(
                    options.sandboxManager!,
                    options.permissionProfile,
                    sandboxPlatform,
                    command,
                    pty,
                    ctx,
                    'background_command',
                  ),
              }
            : {}),
          ...(bashAdditionalPermissionPlanner
            ? { planAdditionalPermissions: bashAdditionalPermissionPlanner }
            : {}),
          ...(bashSandboxEscalationPlanner
            ? { planSandboxEscalation: bashSandboxEscalationPlanner }
            : {}),
        }),
      ]
    : [
        buildExecutorBashTool(executor, shell, {
          ...(options.permissionProfile ? { permissionProfile: options.permissionProfile } : {}),
          ...(options.sandboxManager ? { sandboxManager: options.sandboxManager } : {}),
          ...(bashAdditionalPermissionPlanner
            ? { planAdditionalPermissions: bashAdditionalPermissionPlanner }
            : {}),
          ...(bashSandboxEscalationPlanner
            ? { planSandboxEscalation: bashSandboxEscalationPlanner }
            : {}),
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
      permissionRequired: false,
      executionFacts,
      ...(filePermissionPlanner
        ? {
            planAdditionalPermissions: filePermissionPlanner('Read', (args) =>
              typeof args.path === 'string' && classifyRuntimeResourceRef(args.path) === 'file'
                ? args.path
                : undefined,
            ),
          }
        : {}),
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
        if (options.filesystemWorker) {
          const canonicalCwd = canonicalExistingPath(cwd);
          const result = await options.filesystemWorker.execute({
            operation: {
              kind: 'read',
              path,
              ...(offset !== undefined ? { offset } : {}),
              ...(limit !== undefined ? { limit } : {}),
            },
            cwd: canonicalCwd,
            mode: ctx.permissionMode ?? 'ask',
            ...(options.permissionProfile ? { permissionProfile: options.permissionProfile } : {}),
            ...(ctx.permissionContext?.additionalGrant
              ? { additionalGrant: ctx.permissionContext.additionalGrant }
              : {}),
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
      description: 'Write content to a file (creates or overwrites). Subject to permission policy.',
      parameters: z.object({ path: z.string(), content: z.string() }),
      permissionRequired: true,
      executionFacts,
      ...(filePermissionPlanner
        ? {
            planAdditionalPermissions: filePermissionPlanner('Write', (args) => args.path),
          }
        : {}),
      impl: async ({ path, content }, ctx) => {
        const { cwd } = ctx;
        const canonicalCwd = options.filesystemWorker ? canonicalExistingPath(cwd) : cwd;
        const key = options.filesystemWorker
          ? await fileToolWriteLockKey(canonicalCwd, path)
          : (await executor.writeLockKey({ cwd, path })).key;
        return await withFileWriteLock(key, async () => {
          if (options.filesystemWorker) {
            const result = await options.filesystemWorker.execute({
              operation: { kind: 'write', path, content },
              cwd: canonicalCwd,
              mode: ctx.permissionMode ?? 'ask',
              ...(options.permissionProfile
                ? { permissionProfile: options.permissionProfile }
                : {}),
              ...(ctx.permissionContext?.additionalGrant
                ? { additionalGrant: ctx.permissionContext.additionalGrant }
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
      permissionRequired: true,
      executionFacts,
      ...(filePermissionPlanner
        ? {
            planAdditionalPermissions: filePermissionPlanner('Edit', (args) => args.path),
          }
        : {}),
      impl: async ({ path, old_string, new_string }, ctx) => {
        const { cwd } = ctx;
        const canonicalCwd = options.filesystemWorker ? canonicalExistingPath(cwd) : cwd;
        const key = options.filesystemWorker
          ? await fileToolWriteLockKey(canonicalCwd, path)
          : (await executor.writeLockKey({ cwd, path })).key;
        return await withFileWriteLock(key, async () => {
          if (options.filesystemWorker) {
            const result = await options.filesystemWorker.execute({
              operation: {
                kind: 'edit',
                path,
                oldString: old_string,
                newString: new_string,
              },
              cwd: canonicalCwd,
              mode: ctx.permissionMode ?? 'ask',
              ...(options.permissionProfile
                ? { permissionProfile: options.permissionProfile }
                : {}),
              ...(ctx.permissionContext?.additionalGrant
                ? { additionalGrant: ctx.permissionContext.additionalGrant }
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
      permissionRequired: true,
      executionFacts,
      ...(filePermissionPlanner
        ? {
            planAdditionalPermissions: filePermissionPlanner('FormatJson', (args) => args.path),
          }
        : {}),
      impl: async ({ path, sort_keys }, ctx) => {
        const { cwd } = ctx;
        const canonicalCwd = options.filesystemWorker ? canonicalExistingPath(cwd) : cwd;
        const key = options.filesystemWorker
          ? await fileToolWriteLockKey(canonicalCwd, path)
          : (await executor.writeLockKey({ cwd, path })).key;
        return await withFileWriteLock(key, async () => {
          if (options.filesystemWorker) {
            const result = await options.filesystemWorker.execute({
              operation: { kind: 'format_json', path, sortKeys: sort_keys ?? false },
              cwd: canonicalCwd,
              mode: ctx.permissionMode ?? 'ask',
              ...(options.permissionProfile
                ? { permissionProfile: options.permissionProfile }
                : {}),
              ...(ctx.permissionContext?.additionalGrant
                ? { additionalGrant: ctx.permissionContext.additionalGrant }
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
        pattern: z.string(),
        cwd: z.string().optional(),
      }),
      permissionRequired: false,
      executionFacts,
      ...(filePermissionPlanner
        ? {
            planAdditionalPermissions: filePermissionPlanner('Glob', (args) => args.cwd ?? '.'),
          }
        : {}),
      impl: async ({ pattern, cwd: relCwd }, ctx) => {
        const { cwd } = ctx;
        assertRelativeGlobPattern(pattern);
        if (options.filesystemWorker) {
          const canonicalCwd = canonicalExistingPath(cwd);
          const result = await options.filesystemWorker.execute({
            operation: { kind: 'glob', path: relCwd ?? '.', pattern, limit: 200 },
            cwd: canonicalCwd,
            mode: ctx.permissionMode ?? 'ask',
            ...(options.permissionProfile ? { permissionProfile: options.permissionProfile } : {}),
            ...(ctx.permissionContext?.additionalGrant
              ? { additionalGrant: ctx.permissionContext.additionalGrant }
              : {}),
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
      permissionRequired: false,
      executionFacts,
      ...(filePermissionPlanner
        ? {
            planAdditionalPermissions: filePermissionPlanner('Grep', (args) => args.path ?? '.'),
          }
        : {}),
      impl: async ({ pattern, path, glob }, ctx) => {
        const { cwd, abortSignal } = ctx;
        if (options.filesystemWorker) {
          const canonicalCwd = canonicalExistingPath(cwd);
          const result = await options.filesystemWorker.execute({
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
            mode: ctx.permissionMode ?? 'ask',
            ...(options.permissionProfile ? { permissionProfile: options.permissionProfile } : {}),
            ...(ctx.permissionContext?.additionalGrant
              ? { additionalGrant: ctx.permissionContext.additionalGrant }
              : {}),
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
  return tools.filter((tool) => options.includeEdit !== false || tool.name !== 'Edit');
}

interface ExecutorBashSandboxOptions {
  permissionProfile?: PermissionProfile;
  sandboxManager?: SandboxManager;
  sandboxPlatform: SandboxPlatform;
  planAdditionalPermissions?: BashAdditionalPermissionPlanner;
  planSandboxEscalation?: BashSandboxEscalationPlanner;
}

type BashAdditionalPermissionPlanner = (
  args: ManagedBashPermissionArgs,
  context: AdditionalPermissionPlannerContext,
) => Promise<AdditionalPermissionPlanResult> | AdditionalPermissionPlanResult;

type BashSandboxEscalationPlanner = (
  args: ManagedBashPermissionArgs,
  context: SandboxEscalationPlannerContext,
) => Promise<SandboxEscalationPlanResult> | SandboxEscalationPlanResult;

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
      ' Subject to permission policy.' +
      (sandboxOptions.planAdditionalPermissions || sandboxOptions.planSandboxEscalation
        ? ' Request minimal one-call access with sandbox_permissions; use require_escalated only when sandboxed execution cannot work.'
        : ''),
    parameters: z
      .object({
        command: z.string().describe('The shell command to execute'),
        timeout_ms: z.number().int().positive().max(600_000).optional(),
        ...(sandboxOptions.planAdditionalPermissions || sandboxOptions.planSandboxEscalation
          ? {
              sandbox_permissions: bashSandboxPermissionsSchema
                .describe(
                  'Optional one-call filesystem/network permission or explicit unsandboxed execution request.',
                )
                .optional(),
            }
          : {}),
      })
      .strict(),
    permissionRequired: true,
    toModelOutput: ({ output }) => bashToolResultToModelOutput(output),
    executionFacts: executor.facts,
    ...(sandboxOptions.planAdditionalPermissions
      ? { planAdditionalPermissions: sandboxOptions.planAdditionalPermissions }
      : {}),
    ...(sandboxOptions.planSandboxEscalation
      ? { planSandboxEscalation: sandboxOptions.planSandboxEscalation }
      : {}),
    ...(sandboxOptions.sandboxManager
      ? {
          sandbox: sandboxAvailabilityResolver(
            sandboxOptions.sandboxManager,
            sandboxOptions.permissionProfile,
            sandboxOptions.sandboxPlatform,
          ),
        }
      : {}),
    impl: async ({ command, timeout_ms }, ctx) => {
      const { cwd, abortSignal, emitOutput } = ctx;
      const timeout = timeout_ms ?? 120_000;
      const transformed = sandboxOptions.sandboxManager
        ? sandboxCommand(
            sandboxOptions.sandboxManager,
            sandboxOptions.permissionProfile,
            sandboxOptions.sandboxPlatform,
            command,
            false,
            ctx,
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

function sandboxAvailabilityResolver(
  manager: SandboxManager,
  explicitProfile: PermissionProfile | undefined,
  platform: SandboxPlatform,
): NonNullable<MakaTool['sandbox']> {
  return ({ permissionMode, cwd, args }) => {
    const effective = effectivePermissionProfile(explicitProfile, permissionMode, cwd);
    if (isPtyBashArgs(args) && profileRequiresSandbox(effective.profile)) {
      return { platformSandboxAvailable: false };
    }
    return {
      platformSandboxAvailable: manager.canEnforce({
        profile: effective.profile,
        platform,
      }),
    };
  };
}

function sandboxCommand(
  manager: SandboxManager,
  explicitProfile: PermissionProfile | undefined,
  platform: SandboxPlatform,
  command: string,
  pty: boolean,
  ctx: MakaToolContext,
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
  const effective = effectivePermissionProfile(explicitProfile, ctx.permissionMode ?? 'ask', cwd);
  const env = { ...process.env };
  const additionalGrant = ctx.permissionContext?.additionalGrant;
  const escalationGrant = ctx.permissionContext?.sandboxEscalationGrant;
  if (additionalGrant && escalationGrant) {
    throw new SandboxCommandError({
      domain,
      stage: 'validation',
      reason: 'conflicting_permission_context',
      recoverable: false,
      profileName: effective.profile.name ?? effective.profile.type,
      message: 'Additional permissions and sandbox escalation cannot be applied together.',
    });
  }
  if (escalationGrant) {
    assertSandboxEscalationGrantForExecution({ grant: escalationGrant, command, cwd });
  }
  if (pty) {
    if (escalationGrant) return { cwd, env, sandboxType: 'none' };
    if (profileRequiresSandbox(effective.profile)) {
      throw new SandboxCommandError({
        domain,
        stage: 'capability',
        reason: 'pty_sandbox_unavailable',
        recoverable: false,
        profileName: effective.profile.name ?? effective.profile.type,
        message:
          'PTY Bash is unavailable while the active permission profile requires command sandboxing.',
      });
    }
    return undefined;
  }
  if (!escalationGrant && !manager.canEnforce({ profile: effective.profile, platform })) {
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

  let preparedTargets: readonly PreparedExactWriteTarget[] = [];
  try {
    preparedTargets = prepareLinuxBashExactWriteTargets(platform, additionalGrant);
  } catch {
    throw new SandboxCommandError({
      domain,
      stage: 'validation',
      reason: 'exact_write_target_changed',
      backend: 'linux',
      recoverable: false,
      profileName: effective.profile.name ?? effective.profile.type,
      message: 'An approved exact write target could not be prepared safely.',
    });
  }
  const onCompletion = preparedExactWriteCompletion(preparedTargets);

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
                ...(preparedTargets.length > 0
                  ? {
                      pinnedWritableFiles: preparedTargets.map((target) => ({
                        path: target.path,
                        fd: target.childFd,
                        sourceFd: target.sourceFd,
                        releaseSource: target.releaseSource,
                      })),
                    }
                  : {}),
              }
            : {}),
        },
      },
      ...(additionalGrant ? { additionalPermissions: additionalGrant.profile } : {}),
      ...(escalationGrant ? { preference: 'forbid' as const } : {}),
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

interface PreparedExactWriteTarget {
  readonly path: string;
  readonly sourceFd: number;
  readonly releaseSource: () => void;
  readonly childFd: number;
  readonly device: bigint;
  readonly inode: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

function prepareLinuxBashExactWriteTargets(
  platform: SandboxPlatform,
  grant: AdditionalPermissionGrant | undefined,
): readonly PreparedExactWriteTarget[] {
  if (platform !== 'linux' || !grant) return [];
  const exactWrites = new Set(
    grant.profile.fileSystem?.entries
      .filter((entry) => entry.access === 'write' && entry.scope === 'exact')
      .map((entry) => entry.path) ?? [],
  );
  const prepared: PreparedExactWriteTarget[] = [];
  try {
    for (const target of grant.normalizedPaths) {
      if (
        target.access !== 'write' ||
        target.scope !== 'exact' ||
        target.targetType !== 'missing' ||
        !exactWrites.has(target.enforcementPath)
      ) {
        continue;
      }
      const fd = openMissingExactWriteTarget(target.enforcementPath);
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
          path: target.enforcementPath,
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
    }
    return prepared;
  } catch (error) {
    completePreparedExactWriteTargets(prepared);
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

function preparedExactWriteCompletion(
  targets: readonly PreparedExactWriteTarget[],
): ((outcome: { successful: boolean }) => void) | undefined {
  if (targets.length === 0) return undefined;
  let completed = false;
  return () => {
    if (completed) return;
    completed = true;
    completePreparedExactWriteTargets(targets);
  };
}

function completePreparedExactWriteTargets(targets: readonly PreparedExactWriteTarget[]): void {
  for (const target of targets) {
    try {
      target.releaseSource();
    } catch {
      // Launch cleanup is best effort; the close-once owner prevents fd-number reuse bugs.
    }
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

function profileRequiresSandbox(profile: PermissionProfile): boolean {
  return profile.type === 'managed' && profile.fileSystem.kind === 'restricted';
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

function createBashAdditionalPermissionPlanner(
  manager: SandboxManager,
  explicitProfile: PermissionProfile | undefined,
  platform: SandboxPlatform,
): BashAdditionalPermissionPlanner {
  return async (args, context) => {
    const effective = effectivePermissionProfile(explicitProfile, context.mode, context.cwd);
    const plan = await planDeclaredBashAdditionalPermission({
      declaration: args.sandbox_permissions,
      cwd: context.cwd,
      mode: context.mode,
      command: args.command,
      args: context.args,
      context: {
        profile: effective.profile,
        workspaceRoots: effective.workspaceRoots,
        pathContext: {
          tmpdir: canonicalExistingPath(tmpdir()),
          slashTmp: canonicalExistingPath('/tmp'),
        },
      },
    });
    if (plan.kind !== 'request') return plan;
    if (args.pty === true) {
      return {
        kind: 'block',
        reason: 'invalid_additional_permissions',
        message: 'Additional Bash permissions cannot be applied to PTY execution.',
      };
    }

    const effectiveWithAdditional = applyAdditionalPermissionProfile(
      effective.profile,
      plan.proposal.profile,
    );
    if (!manager.canEnforce({ profile: effectiveWithAdditional, platform })) {
      return {
        kind: 'block',
        reason: 'invalid_additional_permissions',
        message: `Additional Bash permissions cannot be enforced on platform ${platform}.`,
      };
    }
    return plan;
  };
}

function createBashSandboxEscalationPlanner(): BashSandboxEscalationPlanner {
  return (args, context) =>
    planDeclaredBashSandboxEscalation({
      declaration: args.sandbox_permissions,
      command: args.command,
      cwd: canonicalExistingPath(context.cwd),
      mode: context.mode,
      args: context.args,
      recentSandboxDenial: context.recentSandboxDenial,
    });
}

type FileToolAdditionalPermissionName = 'Read' | 'Write' | 'Edit' | 'FormatJson' | 'Glob' | 'Grep';
type FileToolPathSelector = (args: Record<string, any>) => string | undefined;

function createFileToolAdditionalPermissionPlanner(
  explicitProfile: PermissionProfile | undefined,
): (
  toolName: FileToolAdditionalPermissionName,
  selectPath: FileToolPathSelector,
) => NonNullable<MakaTool['planAdditionalPermissions']> {
  return (toolName, selectPath) => async (args, context) => {
    const path = selectPath(args as Record<string, any>);
    if (!path) return { kind: 'not_required' };
    const effective = effectivePermissionProfile(explicitProfile, context.mode, context.cwd);
    return await planFileToolAdditionalPermission({
      toolName,
      path,
      cwd: context.cwd,
      mode: context.mode,
      args: context.args,
      context: {
        profile: effective.profile,
        workspaceRoots: effective.workspaceRoots,
        pathContext: {
          tmpdir: canonicalExistingPath(tmpdir()),
          slashTmp: canonicalExistingPath('/tmp'),
        },
      },
    });
  };
}

async function fileToolWriteLockKey(cwd: string, path: string): Promise<string> {
  const target = await normalizeAdditionalPermissionPath({
    path,
    access: 'write',
    scope: 'exact',
    cwd,
  });
  return target.enforcementPath;
}

function isPtyBashArgs(args: unknown): boolean {
  return typeof args === 'object' && args !== null && (args as { pty?: unknown }).pty === true;
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
