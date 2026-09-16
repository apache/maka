/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

// packages/runtime/src/builtin-tools.ts
// Baseline tool set. ToolRuntime settlement decorates each tool with durable
// execution facts and reviews actions before direct host execution.

import { z } from 'zod';
import {
  READ_DESCRIPTION,
  readParameters,
  readToolResultPage,
  resolveReadInput,
  type ReadInput,
} from './read-page.js';
import { parseAttachmentResourceRef } from '@maka/core/attachments';
import { isStorageRef, type StorageRef, type ToolResultContent } from '@maka/core/events';
import { bashToolResultToModelOutput } from './bash-model-output.js';
import { fileWriteToolResultToModelOutput } from './file-tool-model-output.js';
import { toolResultOutput } from './tool-result-output.js';
import { GREP_MAX_LINES, GREP_MAX_LINES_PER_FILE, GREP_MAX_MATCH_BYTES } from './grep-search.js';
import { openAiApplyPatchInputSchema } from './openai-apply-patch.js';
import { parseCodexV4aPatch } from './codex-v4a-patch.js';
import { executeApplyPatchOperations } from './apply-patch-batch.js';
import {
  buildManagedBashTool,
  buildStopBackgroundTaskTool,
  buildWriteStdinTool,
  shapeTerminalResult,
  withTurnShellGuidance,
} from './shell-tools.js';
import type { ShellRunLauncher } from './shell-tools.js';
import { defaultShellPlan, throwIfShellSetupFailed, type TurnShellPlan } from './shell-detect.js';
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
import { createFilesystemExecutor, type FilesystemExecuteInput } from './filesystem-executor.js';

// tool-runtime.ts is the single source of truth for the tool shape; this
// re-export only keeps back-compat for callers that imported from
// builtin-tools directly.
import type { MakaTool, MakaToolContext } from './tool-runtime.js';
export type { MakaTool, MakaToolContext };
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
  /**
   * Turn-scoped shell resolution that runs Bash commands. Defaults to the
   * process-wide detected shell. A broken saved preference rides along as
   * `setupError` and fails closed at the Bash boundary.
   */
  shell?: TurnShellPlan;
  /** Host-only environment overlay for a pre-bound Plugin Shell invocation. */
  shellEnvironment?: Readonly<Record<string, string>>;
  snapshotImage?: (input: {
    sessionId: string;
    ownerId: string;
    bytes: Uint8Array;
    mimeType: string;
  }) => Promise<Extract<StorageRef, { kind: 'session_context' }>>;
  releaseImageSnapshot?: (input: { sessionId: string; refId: string }) => Promise<void>;
}

export function buildBuiltinTools(options: BuildBuiltinToolsOptions = {}): MakaTool[] {
  const executor = options.executor ?? createLocalWorkspaceExecutor();
  const filesystem = createFilesystemExecutor({ workspace: executor });
  const executionFacts = executor.facts;
  const shell = options.shell ?? { plan: defaultShellPlan() };
  const bashTools = options.shellRuns
    ? [
        buildManagedBashTool(options.shellRuns, {
          executionFacts,
          shell,
          ...(options.shellEnvironment
            ? {
                transformCommand: ({ ctx }) => ({
                  cwd: ctx.cwd,
                  env: { ...process.env, ...options.shellEnvironment },
                }),
              }
            : {}),
        }),
      ]
    : [buildExecutorBashTool(executor, shell)];
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
      description: READ_DESCRIPTION,
      parameters: readParameters,
      executionFacts,
      toModelOutput: ({ input, output }) => {
        const args = input as ReadInput;
        const { path } = resolveReadInput(args);
        if (
          classifyRuntimeResourceRef(path) !== 'runtime' ||
          path.startsWith('maka://runtime/tool-results/')
        )
          return undefined;
        if (output && typeof output === 'object' && 'kind' in output && output.kind === 'image')
          return undefined;
        try {
          return toolResultOutput(readToolResultPage(JSON.stringify(output), args), false);
        } catch (error) {
          return {
            type: 'error-text',
            value:
              error instanceof Error
                ? error.message
                : 'This Read page could not be generated. Read the original path again.',
          };
        }
      },
      ...(options.releaseImageSnapshot
        ? {
            compensateDurableOutcomeCommitFailure: async (input: {
              readonly result: unknown;
              readonly sessionId: string;
            }) => {
              const result = input.result;
              if (
                !result ||
                typeof result !== 'object' ||
                (result as { kind?: unknown }).kind !== 'image'
              ) {
                return;
              }
              const ref = (result as { ref?: unknown }).ref;
              if (
                !isStorageRef(ref) ||
                ref.kind !== 'session_context' ||
                ref.sessionId !== input.sessionId
              ) {
                return;
              }
              await options.releaseImageSnapshot!({
                sessionId: ref.sessionId,
                refId: ref.refId,
              });
            },
          }
        : {}),
      impl: async (input, ctx) => {
        const { cwd, sessionId, abortSignal } = ctx;
        const resolved = resolveReadInput(input);
        const path = resolved.path;
        const runtimeRef = classifyRuntimeResourceRef(path);
        if (runtimeRef === 'unsupported')
          throw new Error(`Unsupported Maka address: ${path}. Use a path returned by a tool.`);
        if (runtimeRef === 'runtime') {
          const attachment = parseAttachmentResourceRef(path);
          if (attachment) {
            if (!options.attachmentResources)
              throw new Error('Attachment resources are not available in this toolset');
            const result = await options.attachmentResources.readAttachmentResource(
              sessionId,
              attachment.artifactId,
              abortSignal,
            );
            return result;
          }
          if (!options.runtimeResources)
            throw new Error('Runtime resources are not available in this toolset');
          const result = await options.runtimeResources.readRuntimeResource(
            sessionId,
            path,
            abortSignal,
          );
          return result;
        }
        const result = await filesystem.execute({
          operation: {
            kind: 'read',
            path,
            ...(input.offset === undefined ? {} : { offset: input.offset }),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
            ...(resolved.position === undefined
              ? {}
              : {
                  continuation: { position: resolved.position, digest: resolved.digest! },
                }),
          },
          ...filesystemCall(ctx),
        });
        if (result.kind === 'read_image') {
          if (!options.snapshotImage)
            throw new Error('Read image snapshots are not available in this toolset.');
          if (!ctx.operationId) {
            throw new Error('Read image snapshots require a durable tool operation identity.');
          }
          const ref = await options.snapshotImage({
            sessionId,
            ownerId: ctx.operationId,
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
        const { kind: _kind, ...page } = result;
        return page;
      },
    },
    ...(executor.applyPatch ? [applyPatchTool] : []),
    {
      name: 'Write',
      activityKind: 'edit',
      description:
        'Create a text file or overwrite its entire contents; does not append. The parent directory must exist. Use Edit for partial changes. Relative paths resolve from the session cwd; ' +
        'how far outside it a path may reach is decided by the session permissions.',
      parameters: z.object({
        path: z.string().describe('A file path; relative paths are resolved from the session cwd'),
        content: z.string().describe('The complete text to write to the file.'),
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
        'Find file and directory paths matching a glob pattern. Case sensitivity follows platform defaults. Hidden entries require an explicit dot-prefixed pattern component. Returns at most 200 matches in traversal order, without sorting.',
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
      description: `Search file contents with a ripgrep regex. Scans files as text, including binary files; directory traversal respects ripgrep ignore rules and glob filters. Returns path:line:content matches and exact matchedLines, returnedLines, omittedLines, and truncated from one completed search. Keeps at most ${GREP_MAX_LINES_PER_FILE} lines per file, ${GREP_MAX_LINES} total, and ${GREP_MAX_MATCH_BYTES / 1024} KiB of JSON matches; oversized or non-UTF8 lines/paths may be omitted. Narrow path, glob, or pattern for more matches, or use Read to inspect a file. Failed searches have unknown totals.`,
      parameters: z.object({
        pattern: z
          .string()
          .describe('Ripgrep regular expression; use an empty pattern to match every line.'),
        path: z
          .string()
          .optional()
          .describe('File or directory to search; defaults to the session working directory.'),
        glob: z.string().optional().describe('Optional ripgrep file glob, for example **/*.ts.'),
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
            path: path || '.',
            pattern,
            ...(glob ? { glob } : {}),
            maxCountPerFile: GREP_MAX_LINES_PER_FILE,
            limit: GREP_MAX_LINES,
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
        const { kind: _kind, ...searchResult } = result;
        return searchResult;
      },
    },
  ];
  return tools;
}

/** The per-call context for host filesystem operations. */
function filesystemCall(ctx: MakaToolContext): Pick<FilesystemExecuteInput, 'cwd' | 'abortSignal'> {
  return { cwd: ctx.cwd, abortSignal: ctx.abortSignal };
}

function buildExecutorBashTool(executor: WorkspaceExecutor, shell: TurnShellPlan): MakaTool {
  return {
    name: 'Bash',
    activityKind: 'command',
    description: withTurnShellGuidance('Run a shell command in the session cwd.', shell),
    parameters: z
      .object({
        command: z.string().describe('The shell command to execute'),
        timeout_ms: z.number().int().positive().max(600_000).optional(),
      })
      .strict(),
    toModelOutput: ({ output }) => bashToolResultToModelOutput(output),
    executionFacts: executor.facts,
    impl: async ({ command, timeout_ms }, ctx) => {
      throwIfShellSetupFailed(shell);
      const timeout = timeout_ms ?? 120_000;
      const result = await executor.exec({
        command,
        cwd: ctx.cwd,
        timeoutMs: timeout,
        abortSignal: ctx.abortSignal,
        emitOutput: ctx.emitOutput,
        shell: shell.plan,
      });
      if (result.timedOut) throw terminalError(`Command timed out after ${timeout}ms`, result, 124);
      if (result.aborted) throw terminalError('Command aborted', result, 130);
      if (result.exitCode !== 0)
        throw terminalError(
          `Command failed with exit code ${result.exitCode}`,
          result,
          result.exitCode,
        );
      return shapeTerminalResult({ cwd: ctx.cwd, command, result });
    },
  };
}

function terminalError(
  message: string,
  result: Pick<WorkspaceExecResult, 'stdout' | 'stderr' | 'stdoutTruncated' | 'stderrTruncated'>,
  code: number,
): Error {
  return Object.assign(new Error(message), {
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    code,
  });
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
