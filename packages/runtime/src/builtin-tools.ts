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
import { compilePermissionProfile } from '@maka/core/permission-profile-compiler';
import { parseAttachmentResourceRef } from '@maka/core/attachments';
import { type SandboxBoundaryExpansion } from '@maka/core/sandbox-boundary';
import { type StorageRef, type ToolResultContent } from '@maka/core/events';
import { type PermissionProfile } from '@maka/core/permission-profile';
import { bashToolResultToModelOutput } from './bash-model-output.js';
import { fileWriteToolResultToModelOutput } from './file-tool-model-output.js';
import { openAiApplyPatchInputSchema } from './openai-apply-patch.js';
import { parseCodexV4aPatch } from './codex-v4a-patch.js';
import { executeApplyPatchOperations } from './apply-patch-batch.js';
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
import {
  createBoundaryFilesystemExecutor,
  type FilesystemExecuteInput,
} from './filesystem-executor.js';

// tool-runtime.ts is the single source of truth for the tool shape; this
// re-export only keeps back-compat for callers that imported from
// builtin-tools directly.
import type { MakaTool, MakaToolContext } from './tool-runtime.js';
export type { MakaTool, MakaToolContext };
import { profileRequiresSandbox, type SandboxManager } from './sandbox/sandbox-manager.js';
import { SandboxCommandError } from './sandbox/errors.js';
import { isLikelySandboxDenial } from './sandbox/detect.js';
import { linuxExecutableRoots } from './sandbox/linux-sandbox.js';
import { pinExistingLinuxProfilePath } from './sandbox/linux-profile-path.js';
import type { SandboxPlatform, SandboxType } from './sandbox/types.js';
import type { ChildFdInput } from './child-fd-input.js';
import { normalizeSandboxBoundaryPath } from './sandbox-boundary-path.js';
import type { FilesystemWorkerClient } from './filesystem-worker/client.js';
import {
  preflightDeclaredSandboxBoundary,
  sandboxBoundaryExpansionSchema,
} from './sandbox-boundary-declaration.js';

// Generous wall-clock cap for the ripgrep-backed Grep tool. A search should be
// near-instant; this only bounds a pathological hang now that the stream
// watchdog is paused during tool execution.
const GREP_TIMEOUT_MS = 120_000;

/**
 * The filesystem worker answered with a well-formed result of a different
 * operation than the one that was requested.
 *
 * Naming the worker told the model about an internal component it cannot
 * address, and the original wording read like an argument complaint — on Edit
 * the likeliest reaction was another `old_string` guess, which can never fix
 * this. But the replacement has to be careful about two things it cannot say.
 *
 * It cannot say the write did not land. Real failures throw; this branch fires
 * on a mislabelled success, and a mislabelled success is still a success as far
 * as the disk is concerned. "Nothing was written to disk" is a claim about a
 * file this code did not look at.
 *
 * And it cannot phrase a failed read as an empty one. "Grep could not be
 * completed inside Maka, so no matches were produced" reads as a search that
 * ran and found nothing, and a model that takes it that way concludes the
 * pattern is absent from the repository — the opposite of what happened.
 *
 * So a read says no result came back, and says what that does not mean. A write
 * says Maka cannot tell what happened to the file, and sends the model to look
 * rather than to retry a call that may have already taken effect.
 *
 * Neither may name Bash. Read, Glob and Grep are the entire tool set of a
 * `local_read` child (`agent-catalog.ts`), and `buildToolsForAgentDefinition`
 * hands that child those three tools and nothing else. "Use Bash to do the same
 * work" is, for the caller most likely to be running a bare Grep, an
 * instruction it cannot carry out — a dead end dressed as a way out. The
 * fallback is therefore offered on a condition the model can check for itself,
 * and the sentence ends on a move that is available to every caller.
 *
 * The worker-protocol violation itself still has to reach an operator, so it
 * travels as the `cause`: out of the model's sight, in every log and stack.
 */
function mismatchedWorkerResult(tool: string): Error {
  return new Error(`Filesystem worker returned a mismatched ${tool} result.`);
}

function internalFilesystemReadFailure(tool: string, missing: string, notMeaning: string): Error {
  return new Error(
    `${tool} could not be completed inside Maka, so ${missing}. ` +
      `This is an internal failure, not a problem with your arguments, and it does not mean ${notMeaning}. ` +
      `Retry the same ${tool} call once. If it fails again, stop calling ${tool}: do the same ` +
      `work with a shell tool if you have one, and otherwise report that ${tool} is failing inside Maka.`,
    { cause: mismatchedWorkerResult(tool) },
  );
}

function internalFilesystemWriteFailure(tool: string, subject: string, extra?: string): Error {
  return new Error(
    `${tool} could not be completed inside Maka. Maka cannot tell whether ${subject}, ` +
      `so treat the file as being in an unknown state. ` +
      `This is an internal failure, not a problem with your arguments${extra ? ` — ${extra}` : ''}. ` +
      `Read the file to find out what it now contains before writing to it again.`,
    { cause: mismatchedWorkerResult(tool) },
  );
}

export interface BuildBuiltinToolsOptions {
  shellRuns?: ShellRunLauncher;
  runtimeResources?: RuntimeResourceReader;
  attachmentResources?: {
    readAttachmentResource(
      sessionId: string,
      artifactId: string,
      abortSignal: AbortSignal,
    ): Promise<ToolResultContent>;
  };
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
  const filesystem = createBoundaryFilesystemExecutor({
    workspace: executor,
    ...(options.filesystemWorker ? { worker: options.filesystemWorker } : {}),
    ...(options.permissionProfile ? { permissionProfile: options.permissionProfile } : {}),
  });
  const executionFacts = executor.facts;
  const acceptsResourceRefs = Boolean(options.runtimeResources || options.attachmentResources);
  const readDescription = `Read a text file${options.snapshotImage ? ' or supported image' : ''} from disk${acceptsResourceRefs ? ', or read a whole runtime resource using ref' : ''}.`;
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
  const refField = z
    .string()
    .describe('A runtime resource ref provided in the conversation or returned by another tool');
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
  // Some providers serialize every optional field with a default. Normalize
  // only empty fields that cannot carry intent, then let the strict union keep
  // rejecting genuinely ambiguous file-and-resource requests.
  const normalizeProviderReadInput = (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    const input = value as Record<string, unknown>;
    const ref = input.ref;
    const path = input.path;
    if (typeof ref === 'string' && ref.trim() !== '') {
      if (typeof path !== 'string' || path.trim() !== '') return value;
      return Object.fromEntries(
        Object.entries(input).filter(
          ([key]) => key !== 'path' && key !== 'offset' && key !== 'limit',
        ),
      );
    }
    if (typeof ref !== 'string' || ref.trim() !== '') return value;
    return Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'ref'));
  };
  const strictReadParameters = z.preprocess(
    normalizeProviderReadInput,
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
          'A runtime resource ref provided in the conversation or returned by another tool. Provide ref on its own, without path/offset/limit; omit it (or leave it empty) when reading a file.',
        )
        .optional(),
    })
    .describe(
      'Read a file with path (optionally offset/limit), or a whole runtime resource with ref; provide exactly one of path or ref.',
    );
  const providerReadSchema = zodSchema(providerReadParameters);
  const readParameters = acceptsResourceRefs
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
  const applyPatchTool = {
    name: 'apply_patch',
    activityKind: 'edit',
    categoryHint: 'file_write',
    description: 'Apply one or more file changes using the selected provider patch protocol.',
    parameters: openAiApplyPatchInputSchema,
    providerTool: { kind: 'openai-apply-patch' },
    executionFacts,
    impl: async (input, ctx) => {
      if (typeof input !== 'string') {
        return await filesystem.applyPatch({ operation: input.operation, ...filesystemCall(ctx) });
      }
      const operations = parseCodexV4aPatch(input);
      return await executeApplyPatchOperations(
        operations,
        async (operation) => {
          await filesystem.applyPatch({ operation, ...filesystemCall(ctx) });
        },
        ctx.abortSignal,
      );
    },
  } satisfies MakaTool;
  const tools: MakaTool[] = [
    ...bashTools,
    ...backgroundTools,
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
          const attachment = parseAttachmentResourceRef(ref);
          if (attachment) {
            if (!options.attachmentResources) {
              throw new Error('Attachment resources are not available in this toolset');
            }
            return await options.attachmentResources.readAttachmentResource(
              sessionId,
              attachment.artifactId,
              abortSignal,
            );
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
        const result = await filesystem.execute({
          operation: {
            kind: 'read',
            path,
            ...(offset !== undefined ? { offset } : {}),
            ...(limit !== undefined ? { limit } : {}),
          },
          ...filesystemCall(ctx),
        });
        if (result.kind === 'read_image') {
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
        if (result.kind !== 'read')
          throw internalFilesystemReadFailure(
            'Read',
            'no file content came back',
            'the file is empty or missing',
          );
        return { content: result.content };
      },
    },
    ...(executor.applyPatch ? [applyPatchTool] : []),
    {
      name: 'Write',
      activityKind: 'edit',
      description:
        'Write content to a file. Relative paths resolve from the session cwd; ' +
        'how far outside it a path may reach is decided by the session permissions.',
      parameters: z.object({
        path: z.string().describe('A file path; relative paths are resolved from the session cwd'),
        content: z.string(),
      }),
      executionFacts,
      impl: async ({ path, content }, ctx) => {
        const result = await filesystem.execute({
          operation: { kind: 'write', path, content },
          ...filesystemCall(ctx),
        });
        if (result.kind !== 'write')
          throw internalFilesystemWriteFailure('Write', 'the file was written');
        if (result.diff !== undefined)
          return { kind: 'file_diff' as const, paths: [result.path], diff: result.diff };
        return { kind: 'file_write' as const, path: result.path, bytes: result.bytes };
      },
      toModelOutput: ({ output }) => fileWriteToolResultToModelOutput('Write', output),
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
        const result = await filesystem.execute({
          operation: {
            kind: 'edit',
            path,
            oldString: old_string,
            newString: new_string,
          },
          ...filesystemCall(ctx),
        });
        if (result.kind !== 'edit')
          throw internalFilesystemWriteFailure(
            'Edit',
            'the edit was applied',
            'a different old_string will not help',
          );
        if (result.diff !== undefined)
          return { kind: 'file_diff' as const, paths: [result.path], diff: result.diff };
        return {
          ok: result.ok,
          path: result.path,
          replacements: result.replacements,
          matchedVia: result.matchedVia,
          startLine: result.startLine,
          endLine: result.endLine,
        };
      },
      toModelOutput: ({ output }) => fileWriteToolResultToModelOutput('Edit', output),
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
            'Path to the JSON file to validate and normalize; relative paths are resolved from the session cwd.',
          ),
        sort_keys: z
          .boolean()
          .optional()
          .describe('Sort object keys lexicographically; default false.'),
      }),
      executionFacts,
      impl: async ({ path, sort_keys }, ctx) => {
        const result = await filesystem.execute({
          operation: {
            kind: 'format_json',
            path,
            sortKeys: sort_keys ?? false,
          },
          ...filesystemCall(ctx),
        });
        if (result.kind !== 'format_json') {
          throw internalFilesystemWriteFailure('FormatJson', 'the file was rewritten');
        }
        if (result.diff !== undefined)
          return { kind: 'file_diff' as const, paths: [result.path], diff: result.diff };
        // The discriminator is how the backends name their results to each
        // other; the model is owed the payload, as with every other file tool.
        const { kind: _kind, ...diagnostic } = result;
        return diagnostic;
      },
      toModelOutput: ({ output }) => fileWriteToolResultToModelOutput('FormatJson', output),
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
            'Glob pattern, for example "**/*.txt". Whether it may leave the search root is decided by the session permissions.',
          ),
        cwd: z
          .string()
          .optional()
          .describe(
            'Optional search directory. Absolute or relative directory paths are accepted; how far outside the session cwd it may reach is decided by the session permissions.',
          ),
      }),
      executionFacts,
      impl: async ({ pattern, cwd: relCwd }, ctx) => {
        const result = await filesystem.execute({
          operation: { kind: 'glob', path: relCwd ?? '.', pattern, limit: 200 },
          ...filesystemCall(ctx),
        });
        if (result.kind !== 'glob')
          throw internalFilesystemReadFailure(
            'Glob',
            'no file list came back',
            'no files match the pattern',
          );
        return { files: result.files };
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
        // Self-bound: ripgrep finishes in well under a second normally, but a
        // pathological tree (network mount, /proc, a FIFO) could hang it. The
        // stream watchdog no longer caps tool execution, so each spawning tool
        // must carry its own wall-clock timeout and honour the turn's abort.
        const result = await filesystem.execute({
          operation: {
            kind: 'grep',
            path: path ?? '.',
            pattern,
            ...(glob ? { glob } : {}),
            maxCountPerFile: 50,
            limit: 200,
            timeoutMs: GREP_TIMEOUT_MS,
          },
          ...filesystemCall(ctx),
        });
        if (result.kind !== 'grep')
          throw internalFilesystemReadFailure(
            'Grep',
            'no search result came back',
            'the pattern is absent',
          );
        return { matches: result.matches };
      },
    },
  ];
  return tools.filter((tool) => options.includeEdit !== false || tool.name !== 'Edit');
}

/** The per-call context every file tool hands to the filesystem authority. */
function filesystemCall(
  ctx: MakaToolContext,
): Pick<FilesystemExecuteInput, 'cwd' | 'executionBoundary' | 'permissionMode' | 'abortSignal'> {
  return {
    cwd: ctx.cwd,
    ...(ctx.executionBoundary ? { executionBoundary: ctx.executionBoundary } : {}),
    ...(ctx.permissionMode ? { permissionMode: ctx.permissionMode } : {}),
    ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
  };
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
      const selection = manager.selectInitial({
        profile: effective.profile,
        platform,
      });
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

  let preparedProfile: PreparedLinuxProfilePaths = {
    paths: [],
    unavailablePaths: [],
  };
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
                  ? {
                      unavailableProfilePaths: preparedProfile.unavailablePaths,
                    }
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
  const compiled = compilePermissionProfile({
    mode: permissionMode,
    cwd: canonicalCwd,
  });
  return { profile: compiled.profile, workspaceRoots: compiled.workspaceRoots };
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
