import { MAX_READ_IMAGE_BYTES, type BackendKind, type StorageRef } from '@maka/core';
import type {
  EffectiveProductToolSurface,
  MakaTool,
  ToolResultArchiveResourceReader,
} from '@maka/runtime';
import {
  assertProductBindingCatalogClean,
  bashToolShellGuidance,
  buildArchiveReadTool,
  buildForegroundBashTool,
  buildParentAgentTools,
  computeEditedSource,
  isSupportedImagePath,
  projectEffectiveProductToolSurface,
  validateImageBytes,
} from '@maka/runtime';
import { withFileWriteLock } from '@maka/runtime/file-write-lock';
import { createHash } from 'node:crypto';
import { posix as pathPosix } from 'node:path';
import { z } from 'zod';
import type { HeavyTaskEvidenceRecorder } from './heavy-task-evidence.js';
import {
  buildHeavyTaskProgressTools,
  type HeavyTaskProgressRecorder,
} from './heavy-task-progress.js';
import {
  buildHeavyTaskSelfCheckTools,
  type HeavyTaskSelfCheckRecorder,
} from './heavy-task-self-check.js';
import type { IsolatedToolExecutor } from './isolation.js';
import {
  buildTaskLedgerExperimentTools,
  type TaskLedgerExperimentStore,
} from './task-ledger-experiment.js';

export interface BuildIsolatedHeadlessToolsOptions {
  agentTools?: boolean;
  /**
   * Ref-addressed archive reader. Supplying it binds `ArchiveRead`, which pruned
   * tool results name explicitly in their placeholders. Pass it whenever the host
   * also archives tool results, or the model is told to call a tool it does not have.
   */
  archiveResources?: ToolResultArchiveResourceReader;
  heavyTaskEvidence?: HeavyTaskEvidenceRecorder;
  heavyTaskProgress?: HeavyTaskProgressRecorder;
  heavyTaskSelfCheck?: HeavyTaskSelfCheckRecorder;
  taskLedgerExperiment?: {
    store: TaskLedgerExperimentStore;
  };
  snapshotImage?: (input: {
    sessionId: string;
    turnId: string;
    name: string;
    bytes: Uint8Array;
    mimeType: string;
  }) => Promise<Extract<StorageRef, { kind: 'session_file' }>>;
}

// Key Write and Edit on a JSON [cwd, path] pair (JSON.stringify so no path
// character can pose as the separator) and serialize them with the shared
// withFileWriteLock — see its definition for why concurrent writes are serialized
// and which aliases a lexical key cannot merge. The path is lexically normalized
// so spellings of one file ("a.txt", "./a.txt", "d//a.txt") share a key. Keying
// stays lexical here by necessity: the executor boundary hides the filesystem
// (which may be remote, with its own symlink / hard-link / case-fold semantics),
// so the executor — not this layer — owns canonicalization.
const fileWriteKey = (cwd: string, normalizedPath: string) =>
  JSON.stringify([pathPosix.normalize(cwd), pathPosix.normalize(normalizedPath)]);

const EDIT_READ_FRAME_END = 'MAKA_EDIT_BYTES_END';
const EDIT_READ_FRAME_HEADER_PATTERN =
  /^MAKA_EDIT_BYTES_V1 length=(0|[1-9]\d*) sha256=([a-f0-9]{64})$/;
const FILE_TOOL_OUTPUT_FRAME_END = 'MAKA_FILE_TOOL_OUTPUT_END';
const FILE_TOOL_OUTPUT_FRAME_HEADER_PATTERN =
  /^MAKA_FILE_TOOL_OUTPUT_V1 tool=([A-Za-z]+) nonce=(0|[1-9]\d*)$/;
const FILE_TOOL_OUTPUT_STATUS_PREFIX = '\0MAKA_FILE_TOOL_STATUS_';
const CANONICAL_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
type FramedFileToolName = 'Read' | 'Glob' | 'Grep';

// Base64 expands the decoded tool payload by 4/3 before the local executor sees
// it. Keep the framed transport budget above the existing 10 MiB decoded-output
// capacity, with room for the embedded status marker and frame lines.
const FRAMED_FILE_TOOL_MAX_DECODED_BYTES = 10 * 1024 * 1024;
export const FRAMED_FILE_TOOL_MAX_TRANSPORT_BYTES = 16 * 1024 * 1024;
/**
 * Build Maka's standard headless tool surface with shell and file operations
 * routed through the isolated executor boundary.
 */
export function buildIsolatedHeadlessTools(
  executor: IsolatedToolExecutor,
  options: BuildIsolatedHeadlessToolsOptions = {},
): MakaTool[] {
  const productSurface = buildIsolatedHeadlessProductToolSurface(executor, options);
  return [...productSurface.tools, ...buildIsolatedHeadlessSupplementalTools(options)];
}

export function buildIsolatedHeadlessProductToolSurface(
  executor: IsolatedToolExecutor,
  options: Pick<
    BuildIsolatedHeadlessToolsOptions,
    'agentTools' | 'archiveResources' | 'heavyTaskEvidence' | 'snapshotImage'
  > = {},
): EffectiveProductToolSurface {
  const productTools = [
    buildIsolatedBashTool(executor, options),
    buildIsolatedReadTool(executor, options),
    buildIsolatedWriteTool(executor, options),
    buildIsolatedEditTool(executor, options),
    buildIsolatedGlobTool(executor, options),
    buildIsolatedGrepTool(executor, options),
    ...buildParentAgentTools(),
    ...(options.archiveResources ? [buildArchiveReadTool(options.archiveResources)] : []),
  ];
  assertProductBindingCatalogClean(
    'headless',
    productTools.map((tool) => tool.name),
  );
  return projectEffectiveProductToolSurface({
    host: 'headless',
    tools: productTools,
    policy: {
      economy: true,
      ...(options.agentTools ? {} : { disabledSurfaceIds: ['agent'] }),
    },
  });
}

export function headlessBackendBindsMakaProductTools(backend: BackendKind): boolean {
  return backend === 'ai-sdk';
}

export function buildHeadlessProductToolSurfaceForBackend(
  backend: BackendKind,
  executor: IsolatedToolExecutor | undefined,
  options: Pick<
    BuildIsolatedHeadlessToolsOptions,
    'agentTools' | 'archiveResources' | 'heavyTaskEvidence' | 'snapshotImage'
  > = {},
): EffectiveProductToolSurface | undefined {
  if (!headlessBackendBindsMakaProductTools(backend) || !executor) return undefined;
  return buildIsolatedHeadlessProductToolSurface(executor, options);
}

export function buildIsolatedHeadlessSupplementalTools(
  options: Pick<
    BuildIsolatedHeadlessToolsOptions,
    'heavyTaskProgress' | 'heavyTaskSelfCheck' | 'taskLedgerExperiment'
  > = {},
): MakaTool[] {
  const tools: MakaTool[] = [];
  if (options.heavyTaskProgress) {
    tools.push(...buildHeavyTaskProgressTools(options.heavyTaskProgress));
  }
  if (options.heavyTaskSelfCheck) {
    tools.push(...buildHeavyTaskSelfCheckTools(options.heavyTaskSelfCheck));
  }
  if (options.taskLedgerExperiment) {
    tools.push(...buildTaskLedgerExperimentTools(options.taskLedgerExperiment));
  }
  return tools;
}

export function buildIsolatedBashTool(
  executor: IsolatedToolExecutor,
  options: Pick<BuildIsolatedHeadlessToolsOptions, 'heavyTaskEvidence'> = {},
): MakaTool {
  const guidance = executor.shell ? bashToolShellGuidance(executor.shell) : '';
  return buildForegroundBashTool({
    description:
      'Run a shell command in the isolated headless task workspace. ' +
      'Use it for inspection, builds, and task-local generation; prefer Read/Grep/Write/Edit for exact file operations and preserve required deliverables.' +
      (guidance ? ` ${guidance}` : ''),
    defaultTimeoutMs: cleanupCommandTimeoutMs,
    emitReturnedOutput: true,
    execute: async ({ command, cwd, timeoutMs, ctx }) => {
      // boundedTail: Bash is the one caller that wants a recoverable tail of a
      // huge, never-killed output. Read/Glob/Grep deliberately omit it so they
      // get full, head-first content from the executor.
      return await executor.exec(
        {
          command,
          cwd,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          boundedTail: true,
        },
        { abortSignal: ctx.abortSignal },
      );
    },
    afterResult: async (input, result, ctx) => {
      await options.heavyTaskEvidence?.recordToolEvidence({ name: 'Bash', input, result }, ctx);
    },
  });
}

function cleanupCommandTimeoutMs(command: string): number | undefined {
  // Existing Harbor cleanup can exceed the default in large gcov tasks. Keep the
  // match exact so only the known generated cleanup command gets the allowance.
  return command === 'rm -f *.gcda *.gcno *.gcov' ? 120_000 : undefined;
}

export function buildIsolatedReadTool(
  executor: IsolatedToolExecutor,
  options: Pick<BuildIsolatedHeadlessToolsOptions, 'heavyTaskEvidence' | 'snapshotImage'> = {},
): MakaTool {
  return {
    name: 'Read',
    description:
      'Read a text file or view a PNG, JPEG, GIF, or WebP image from the isolated headless task workspace. Use Read on screenshots when visual inspection is needed.',
    parameters: z.object({
      path: z.string(),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().optional(),
    }),
    impl: async ({ path, offset, limit }, ctx) => {
      const { cwd } = ctx;
      const normalizedPath = normalizeWorkspacePath(path, cwd, 'Read path');
      const input = { cwd, path: normalizedPath, offset, limit };
      if (isSupportedImagePath(normalizedPath)) {
        if (!options.snapshotImage) {
          throw new Error('Read image snapshots are not available in this toolset.');
        }
        const bytes = await readIsolatedFileBytes(
          executor,
          cwd,
          normalizedPath,
          ctx.abortSignal,
          READ_IMAGE_BYTES_SCRIPT,
          'Read image',
        );
        const image = validateImageBytes(bytes);
        const ref = await options.snapshotImage({
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          name: pathPosix.basename(normalizedPath),
          bytes: image.bytes,
          mimeType: image.mimeType,
        });
        const result = { kind: 'image' as const, mimeType: image.mimeType, ref };
        await options.heavyTaskEvidence?.recordToolEvidence({ name: 'Read', input, result }, ctx);
        return result;
      }
      // Read has no native fast path: every result must go through READ_SCRIPT so
      // it carries the line-number / line+byte-cap / binary-guard contract (#92).
      const stdout = await execFramedFileCommand(
        executor,
        cwd,
        'Read',
        READ_SCRIPT,
        [normalizedPath, numberArg(offset), numberArg(limit)],
        ctx.abortSignal,
      );
      const result = { content: stdout };
      await options.heavyTaskEvidence?.recordToolEvidence({ name: 'Read', input, result }, ctx);
      return result;
    },
  };
}

export function buildIsolatedWriteTool(
  executor: IsolatedToolExecutor,
  options: Pick<BuildIsolatedHeadlessToolsOptions, 'heavyTaskEvidence'> = {},
): MakaTool {
  return {
    name: 'Write',
    description:
      'Write content to a file in the isolated headless task workspace using a path ' +
      'relative to the session cwd. Absolute paths and parent traversal are rejected.',
    parameters: z.object({
      path: z
        .string()
        .describe(
          'Path relative to the session cwd. Absolute paths and parent traversal are rejected.',
        ),
      content: z.string(),
    }),
    impl: async ({ path, content }, ctx) => {
      const { cwd } = ctx;
      const normalizedPath = normalizeWorkspacePath(path, cwd, 'Write path');
      const input = { cwd, path: normalizedPath, content };
      return await withFileWriteLock(fileWriteKey(cwd, normalizedPath), async () => {
        if (executor.writeFile) {
          const result = await executor.writeFile(input, { abortSignal: ctx.abortSignal });
          await options.heavyTaskEvidence?.recordToolEvidence(
            { name: 'Write', input, result },
            ctx,
          );
          return result;
        }
        await execFileCommand(
          executor,
          cwd,
          shellFileCommand(WRITE_SCRIPT, [normalizedPath, content]),
          ctx.abortSignal,
        );
        const result = {
          ok: true,
          path: normalizedPath,
          bytes: Buffer.byteLength(content, 'utf8'),
        };
        await options.heavyTaskEvidence?.recordToolEvidence({ name: 'Write', input, result }, ctx);
        return result;
      });
    },
  };
}

export function buildIsolatedEditTool(
  executor: IsolatedToolExecutor,
  options: Pick<BuildIsolatedHeadlessToolsOptions, 'heavyTaskEvidence'> = {},
): MakaTool {
  return {
    name: 'Edit',
    description:
      'Replace old_string with new_string in a file in the isolated headless task workspace. ' +
      'Prefers an exact, unique match; if exact fails it tolerates limited whitespace/indentation/escape ' +
      'drift in old_string, but only when the match is unambiguous (otherwise it errors — re-read and retry ' +
      'with exact text). new_string is written verbatim, so provide the exact final text/indentation you want. ' +
      'Errors if old_string is not found or not unique.',
    parameters: z.object({
      path: z.string(),
      old_string: z.string(),
      new_string: z.string(),
    }),
    impl: async ({ path, old_string, new_string }, ctx) => {
      const { cwd } = ctx;
      const normalizedPath = normalizeWorkspacePath(path, cwd, 'Edit path');
      const input = { cwd, path: normalizedPath, oldString: old_string, newString: new_string };
      return await withFileWriteLock(fileWriteKey(cwd, normalizedPath), async () => {
        const raw = await readIsolatedFileBytes(executor, cwd, normalizedPath, ctx.abortSignal);
        const { content, ...metadata } = computeEditBytes(
          raw,
          old_string,
          new_string,
          normalizedPath,
        );
        await writeIsolatedFileBytes(executor, cwd, normalizedPath, content, ctx.abortSignal);
        const stored = await readIsolatedFileBytes(executor, cwd, normalizedPath, ctx.abortSignal);
        if (!stored.equals(content)) {
          throw new Error(
            `Edit post-write verification failed for ${normalizedPath}: stored bytes differ from the replacement result`,
          );
        }
        const result = { ok: true, path: normalizedPath, replacements: 1, ...metadata };
        await options.heavyTaskEvidence?.recordToolEvidence({ name: 'Edit', input, result }, ctx);
        return result;
      });
    },
  };
}

export function buildIsolatedGlobTool(
  executor: IsolatedToolExecutor,
  options: Pick<BuildIsolatedHeadlessToolsOptions, 'heavyTaskEvidence'> = {},
): MakaTool {
  return {
    name: 'Glob',
    description: 'Find files in the isolated headless task workspace matching a glob pattern.',
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
    impl: async ({ pattern, cwd: relCwd }, ctx) => {
      const { cwd } = ctx;
      const normalizedPattern = normalizeWorkspaceGlobPattern(pattern, cwd, 'Glob pattern');
      const normalizedRelCwd =
        relCwd === undefined ? undefined : normalizeWorkspacePath(relCwd, cwd, 'Glob cwd');
      const input = { cwd, pattern: normalizedPattern, searchCwd: normalizedRelCwd };
      if (executor.globFiles) {
        const result = await executor.globFiles(input, { abortSignal: ctx.abortSignal });
        await options.heavyTaskEvidence?.recordToolEvidence({ name: 'Glob', input, result }, ctx);
        return result;
      }
      const stdout = await execFramedFileCommand(
        executor,
        cwd,
        'Glob',
        GLOB_SCRIPT,
        [normalizedPattern, globPatternToEre(normalizedPattern), normalizedRelCwd ?? ''],
        ctx.abortSignal,
      );
      const result = { files: parseLineArray(stdout) };
      await options.heavyTaskEvidence?.recordToolEvidence({ name: 'Glob', input, result }, ctx);
      return result;
    },
  };
}

export function buildIsolatedGrepTool(
  executor: IsolatedToolExecutor,
  options: Pick<BuildIsolatedHeadlessToolsOptions, 'heavyTaskEvidence'> = {},
): MakaTool {
  return {
    name: 'Grep',
    description: 'Search file contents with a regex in the isolated headless task workspace.',
    parameters: z.object({
      pattern: z.string(),
      path: z.string().optional(),
      glob: z.string().optional(),
    }),
    impl: async ({ pattern, path, glob }, ctx) => {
      const { cwd } = ctx;
      const normalizedPath =
        path === undefined ? undefined : normalizeWorkspacePath(path, cwd, 'Grep path');
      const normalizedGlob =
        glob === undefined ? undefined : normalizeWorkspaceGlobPattern(glob, cwd, 'Grep glob');
      const input = {
        cwd,
        pattern,
        path: normalizedPath,
        glob: normalizedGlob,
      };
      if (executor.grepFiles) {
        const result = await executor.grepFiles(input, { abortSignal: ctx.abortSignal });
        await options.heavyTaskEvidence?.recordToolEvidence({ name: 'Grep', input, result }, ctx);
        return result;
      }
      const stdout = await execFramedFileCommand(
        executor,
        cwd,
        'Grep',
        GREP_SCRIPT,
        [
          pattern,
          normalizedPath ?? '',
          normalizedGlob ?? '',
          normalizedGlob === undefined ? '' : globPatternToEre(normalizedGlob),
        ],
        ctx.abortSignal,
      );
      const result = { matches: parseLineArray(stdout) };
      await options.heavyTaskEvidence?.recordToolEvidence({ name: 'Grep', input, result }, ctx);
      return result;
    },
  };
}

async function execFileCommand(
  executor: IsolatedToolExecutor,
  cwd: string,
  command: string,
  abortSignal: AbortSignal,
): Promise<string> {
  const result = await executor.exec({ command, cwd, timeoutMs: 120_000 }, { abortSignal });
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || `isolated file command failed with exit code ${result.exitCode}`,
    );
  }
  return result.stdout;
}

async function execFramedFileCommand(
  executor: IsolatedToolExecutor,
  cwd: string,
  toolName: FramedFileToolName,
  script: string,
  args: string[],
  abortSignal: AbortSignal,
): Promise<string> {
  const result = await executor.exec(
    {
      command: framedShellFileCommand(toolName, script, args),
      cwd,
      timeoutMs: 120_000,
    },
    { abortSignal },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || `isolated file command failed with exit code ${result.exitCode}`,
    );
  }
  const frame = parseFileToolOutputFrame(result.stdout, toolName);
  if (frame.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || `isolated file command failed with exit code ${frame.exitCode}`,
    );
  }
  return frame.content;
}

async function readIsolatedFileBytes(
  executor: IsolatedToolExecutor,
  cwd: string,
  path: string,
  abortSignal: AbortSignal,
  script = EDIT_READ_BYTES_SCRIPT,
  integrityLabel = 'Edit read',
): Promise<Buffer> {
  const stdout = await execFileCommand(
    executor,
    cwd,
    shellFileCommand(script, [path]),
    abortSignal,
  );
  return parseEditReadFrame(stdout, integrityLabel);
}

function parseEditReadFrame(stdout: string, integrityLabel = 'Edit read'): Buffer {
  const lines = stdout.split('\n');
  if (lines.length !== 4 || lines[3] !== '' || lines[2] !== EDIT_READ_FRAME_END) {
    throw editReadIntegrityError(
      'expected exactly one complete frame with no surrounding output',
      integrityLabel,
    );
  }

  const header = lines[0]?.match(EDIT_READ_FRAME_HEADER_PATTERN);
  if (!header) throw editReadIntegrityError('frame header is missing or malformed', integrityLabel);
  const expectedLength = Number(header[1]);
  if (!Number.isSafeInteger(expectedLength))
    throw editReadIntegrityError('declared byte length is not safe', integrityLabel);

  const payload = lines[1] ?? '';
  if (!CANONICAL_BASE64_PATTERN.test(payload)) {
    throw editReadIntegrityError('payload is not canonical Base64', integrityLabel);
  }
  const decoded = Buffer.from(payload, 'base64');
  if (decoded.toString('base64') !== payload) {
    throw editReadIntegrityError('payload is not canonical Base64', integrityLabel);
  }
  if (decoded.length !== expectedLength) {
    throw editReadIntegrityError(
      `declared ${expectedLength} bytes but decoded ${decoded.length}`,
      integrityLabel,
    );
  }
  const actualDigest = createHash('sha256').update(decoded).digest('hex');
  if (actualDigest !== header[2])
    throw editReadIntegrityError('SHA-256 digest mismatch', integrityLabel);
  return decoded;
}

function editReadIntegrityError(reason: string, label: string): Error {
  return new Error(`${label} transport integrity check failed: ${reason}`);
}

function parseFileToolOutputFrame(
  stdout: string,
  expectedTool: FramedFileToolName,
): { content: string; exitCode: number } {
  const lines = stdout.split('\n');
  const fail = (reason: string): never => {
    throw new Error(`${expectedTool} output transport integrity check failed: ${reason}`);
  };
  if (lines.length < 4 || lines.at(-1) !== '' || lines.at(-2) !== FILE_TOOL_OUTPUT_FRAME_END) {
    return fail('expected exactly one complete frame with no surrounding output');
  }

  const header = lines[0]?.match(FILE_TOOL_OUTPUT_FRAME_HEADER_PATTERN);
  if (!header) return fail('frame header is missing or malformed');
  if (header[1] !== expectedTool)
    return fail(`expected ${expectedTool} frame but received ${header[1]}`);

  const payload = lines.slice(1, -2).join('');
  const decoded = Buffer.from(payload, 'base64');
  if (decoded.toString('base64') !== payload) return fail('payload is not canonical Base64');
  const statusMarker = Buffer.from(`${FILE_TOOL_OUTPUT_STATUS_PREFIX}${header[2]}=`, 'ascii');
  const markerIndex = decoded.lastIndexOf(statusMarker);
  if (markerIndex < 0) return fail('inner command status is missing');
  if (markerIndex > FRAMED_FILE_TOOL_MAX_DECODED_BYTES) {
    return fail(`decoded payload exceeds ${FRAMED_FILE_TOOL_MAX_DECODED_BYTES} bytes`);
  }
  const status = decoded.subarray(markerIndex + statusMarker.length).toString('ascii');
  if (!/^(0|[1-9]\d*)$/.test(status)) return fail('inner command status is malformed');
  const exitCode = Number(status);
  if (!Number.isSafeInteger(exitCode)) return fail('inner command status is not safe');
  return { content: decoded.subarray(0, markerIndex).toString('utf8'), exitCode };
}

async function writeIsolatedFileBytes(
  executor: IsolatedToolExecutor,
  cwd: string,
  path: string,
  content: Buffer,
  abortSignal: AbortSignal,
): Promise<void> {
  await execFileCommand(
    executor,
    cwd,
    shellFileCommand(EDIT_WRITE_BYTES_SCRIPT, [path, content.toString('base64')]),
    abortSignal,
  );
}

function computeEditBytes(
  raw: Buffer,
  oldString: string,
  newString: string,
  inputPath: string,
): { content: Buffer; matchedVia: string; startLine: number; endLine: number } {
  const source = raw.toString('utf8');
  if (Buffer.compare(Buffer.from(source, 'utf8'), raw) === 0) {
    const result = computeEditedSource(source, oldString, newString, inputPath);
    return {
      content: Buffer.from(result.content, 'utf8'),
      matchedVia: result.matchedVia,
      startLine: result.startLine,
      endLine: result.endLine,
    };
  }

  const oldBuf = Buffer.from(oldString, 'utf8');
  const newBuf = Buffer.from(newString, 'utf8');
  if (oldBuf.length === 0) throw new Error(`old_string must not be empty in ${inputPath}`);
  const first = raw.indexOf(oldBuf);
  if (first === -1) {
    throw new Error(
      `Refusing a non-exact match in ${inputPath}: the file is not valid UTF-8 (looks binary). Re-read it and pass the exact bytes to replace.`,
    );
  }
  if (raw.indexOf(oldBuf, first + oldBuf.length) !== -1) {
    throw new Error(
      `old_string is not unique in ${inputPath} (binary file: the exact bytes match more than once)`,
    );
  }
  const startLine = countNewlines(raw, first) + 1;
  const endsWithNewline = oldBuf[oldBuf.length - 1] === 10;
  const spanLineCount = Math.max(
    countNewlines(oldBuf, oldBuf.length) + 1 - (endsWithNewline ? 1 : 0),
    1,
  );
  return {
    content: Buffer.concat([raw.slice(0, first), newBuf, raw.slice(first + oldBuf.length)]),
    matchedVia: 'exact',
    startLine,
    endLine: startLine + spanLineCount - 1,
  };
}

function countNewlines(buffer: Buffer, end: number): number {
  let count = 0;
  for (let i = 0; i < end; i += 1) {
    if (buffer[i] === 10) count += 1;
  }
  return count;
}

function shellFileCommand(script: string, args: string[]): string {
  return ['sh', '-c', shellQuote(script), '--', ...args.map(shellQuote)].join(' ');
}

function framedShellFileCommand(
  toolName: FramedFileToolName,
  script: string,
  args: string[],
): string {
  return shellFileCommand(FRAME_FILE_TOOL_OUTPUT_SCRIPT, [
    toolName,
    shellFileCommand(script, args),
  ]);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function numberArg(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

function parseLineArray(stdout: string): string[] {
  if (!stdout) return [];
  return stdout
    .replace(/\n$/, '')
    .split('\n')
    .filter((line) => line.length > 0);
}

function globPatternToEre(pattern: string): string {
  let output = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    const next = pattern[i + 1];
    if (ch === '*' && next === '*') {
      output += '.*';
      i += 1;
    } else if (ch === '*') {
      output += '[^/]*';
    } else if (ch === '?') {
      output += '[^/]';
    } else {
      output += escapeEreChar(ch);
    }
  }
  return `${output}$`;
}

function escapeEreChar(ch: string): string {
  return /[\\.^$+{}()[\]|]/.test(ch) ? `\\${ch}` : ch;
}

function normalizeWorkspacePath(inputPath: string, cwd: string, label: string): string {
  assertNoDriveOrParentSegment(inputPath, label);
  if (inputPath.startsWith('/')) {
    return assertNormalizedRelativePath(
      pathPosix.relative(normalizeWorkspaceRoot(cwd), pathPosix.normalize(inputPath)) || '.',
      label,
    );
  }
  return assertNormalizedRelativePath(inputPath, label);
}

function normalizeWorkspaceGlobPattern(pattern: string, cwd: string, label: string): string {
  assertNoDriveOrParentSegment(pattern, label);
  if (!pattern.startsWith('/')) return assertNormalizedRelativePath(pattern, label);
  return assertNormalizedRelativePath(
    pathPosix.relative(normalizeWorkspaceRoot(cwd), pattern) || '.',
    label,
  );
}

function normalizeWorkspaceRoot(cwd: string): string {
  return pathPosix.normalize(cwd);
}

function assertNoDriveOrParentSegment(inputPath: string, label: string): void {
  if (
    inputPath.length === 0 ||
    /^[A-Za-z]:[\\/]/.test(inputPath) ||
    inputPath.split(/[\\/]+/).includes('..')
  ) {
    throw new Error(`${label} must stay inside the isolated workspace`);
  }
}

function assertNormalizedRelativePath(inputPath: string, label: string): string {
  if (
    inputPath.length === 0 ||
    inputPath.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(inputPath) ||
    inputPath.split(/[\\/]+/).includes('..')
  ) {
    throw new Error(`${label} must stay inside the isolated workspace`);
  }
  return inputPath;
}

const COMMON_SHELL_HELPERS = String.raw`
fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

inside_workspace() {
  case "$root" in
    /)
      case "$1" in /*) return 0 ;; esac
      ;;
    *)
      case "$1" in "$root"|"$root"/*) return 0 ;; esac
      ;;
  esac
  return 1
}

existing_target() {
  input_path=$1
  label=$2
  target=$root/$input_path
  [ -L "$target" ] && fail "$label must stay inside workspace"
  [ -e "$target" ] || fail "$label does not exist: $input_path"
  if [ -d "$target" ]; then
    real=$(cd -P "$target" 2>/dev/null && pwd -P) || fail "$label must stay inside workspace"
  else
    parent=$(dirname "$target")
    base=$(basename "$target")
    parent_real=$(cd -P "$parent" 2>/dev/null && pwd -P) || fail "$label must stay inside workspace"
    real=$parent_real/$base
  fi
  inside_workspace "$real" || fail "$label must stay inside workspace"
  printf '%s\n' "$real"
}

writable_target() {
  input_path=$1
  label=$2
  target=$root/$input_path
  parent=$(dirname "$target")
  base=$(basename "$target")
  parent_real=$(cd -P "$parent" 2>/dev/null && pwd -P) || fail "$label must stay inside workspace"
  inside_workspace "$parent_real" || fail "$label must stay inside workspace"
  real=$parent_real/$base
  [ -L "$real" ] && fail "$label must stay inside workspace"
  printf '%s\n' "$real"
}
`;

const FRAME_FILE_TOOL_OUTPUT_SCRIPT = String.raw`
tool=$1
command=$2
nonce=$$
printf 'MAKA_FILE_TOOL_OUTPUT_V1 tool=%s nonce=%s\n' "$tool" "$nonce"
{
  sh -c "$command"
  status=$?
  printf '\000MAKA_FILE_TOOL_STATUS_%s=%s' "$nonce" "$status"
} | base64
encoded_status=$?
[ "$encoded_status" -eq 0 ] || exit "$encoded_status"
printf 'MAKA_FILE_TOOL_OUTPUT_END\n'
`;

const READ_SCRIPT = `${COMMON_SHELL_HELPERS}
root=$(pwd -P) || exit 1
target=$(existing_target "$1" 'Read path') || exit 1
offset=\${2:-0}
limit=\${3:-2000}
# Binary guard: a NUL byte in the head means this is not text. Dumping it would
# flood the model with garbage (and command substitution strips NULs anyway), so
# report it instead. Matches Claude Code / opencode behavior. LC_ALL=C is
# mandatory: in a UTF-8 locale, BSD/macOS tr aborts on an invalid high byte
# ("Illegal byte sequence") and, with no pipefail, the count silently becomes 0,
# letting a binary file with a high byte before its first NUL slip through.
nul=$(head -c 8192 "$target" | LC_ALL=C tr -dc '\\000' | wc -c | tr -d ' ')
if [ "\${nul:-0}" -gt 0 ]; then
  size=$(wc -c < "$target" | tr -d ' ')
  printf '[binary file: %s bytes, contents omitted]' "$size"
  exit 0
fi
# cat -n style: each line carries its absolute 1-based number; over-long lines are
# clipped at maxcol bytes. Output stops at the line cap ("limit" lines from
# "offset") OR a ~50KB byte budget, whichever comes first — both keep a large file
# from flooding the model's context (#92) — with a hint giving the offset to resume.
# LC_ALL=C so awk treats the file as bytes and never aborts on invalid UTF-8 in a
# non-NUL file; line content is byte-for-byte and length()/maxcol/maxbytes count bytes.
LC_ALL=C awk -v start="$offset" -v limit="$limit" '
  BEGIN { first = start + 1; last = start + limit; maxcol = 2000; maxbytes = 51200 }
  NR < first { next }
  {
    if (NR > last) { stopped = 1; exit }
    line = $0
    if (length(line) > maxcol) line = substr(line, 1, maxcol) "... [line truncated]"
    out = sprintf("%6d\\t%s\\n", NR, line)
    # Always emit at least one line (shown > 0 guard); otherwise stop before the
    # budget is exceeded so total output stays under maxbytes.
    if (shown > 0 && bytes + length(out) > maxbytes) { stopped = 1; exit }
    printf "%s", out
    bytes += length(out)
    shown += 1
    lastline = NR
  }
  END { if (stopped) printf "... (truncated at line %d; pass offset=%d to read more)\\n", lastline, lastline }
' "$target"
`;

const WRITE_SCRIPT = `${COMMON_SHELL_HELPERS}
root=$(pwd -P) || exit 1
target=$(writable_target "$1" 'Write path') || exit 1
printf '%s' "$2" > "$target"
`;

const EDIT_READ_BYTES_SCRIPT = `${COMMON_SHELL_HELPERS}
root=$(pwd -P) || exit 1
target=$(existing_target "$1" 'Edit path') || exit 1
size=$(wc -c < "$target" | tr -d '[:space:]') || exit 1
if command -v sha256sum >/dev/null 2>&1; then
  digest=$(sha256sum "$target" | awk '{print $1}') || exit 1
elif command -v shasum >/dev/null 2>&1; then
  digest=$(shasum -a 256 "$target" | awk '{print $1}') || exit 1
else
  fail 'SHA-256 utility is required for Edit transport'
fi
printf 'MAKA_EDIT_BYTES_V1 length=%s sha256=%s\n' "$size" "$digest"
base64 < "$target" | LC_ALL=C tr -d '\\r\\n'
printf '\nMAKA_EDIT_BYTES_END\n'
`;

const READ_IMAGE_BYTES_SCRIPT = `${COMMON_SHELL_HELPERS}
root=$(pwd -P) || exit 1
target=$(existing_target "$1" 'Read path') || exit 1
size=$(wc -c < "$target" | tr -d '[:space:]') || exit 1
[ "$size" -le ${MAX_READ_IMAGE_BYTES} ] || fail 'Image exceeds the 5MB model input limit; downscale it and try again.'
if command -v sha256sum >/dev/null 2>&1; then
  digest=$(sha256sum "$target" | awk '{print $1}') || exit 1
elif command -v shasum >/dev/null 2>&1; then
  digest=$(shasum -a 256 "$target" | awk '{print $1}') || exit 1
else
  fail 'SHA-256 utility is required for Read image transport'
fi
printf 'MAKA_EDIT_BYTES_V1 length=%s sha256=%s\n' "$size" "$digest"
base64 < "$target" | LC_ALL=C tr -d '\\r\\n'
printf '\nMAKA_EDIT_BYTES_END\n'
`;

const EDIT_WRITE_BYTES_SCRIPT = `${COMMON_SHELL_HELPERS}
root=$(pwd -P) || exit 1
target=$(existing_target "$1" 'Edit path') || exit 1
payload=$2
tmp=
created=
cleanup() {
  [ -n "$created" ] && [ -n "$tmp" ] && rm -f "$tmp"
}
trap cleanup EXIT HUP INT TERM
tmp=$(mktemp "$target.maka-edit.XXXXXX") || fail 'Edit temp file creation failed'
created=1
if printf '%s' "$payload" | base64 -d > "$tmp" 2>/dev/null; then
  :
elif printf '%s' "$payload" | base64 -D > "$tmp" 2>/dev/null; then
  :
else
  fail 'base64 decode failed for Edit payload'
fi
mode=$( (stat -c '%a' "$target" 2>/dev/null || stat -f '%Lp' "$target" 2>/dev/null) | head -n 1 )
[ -n "$mode" ] && chmod "$mode" "$tmp" 2>/dev/null || true
mv "$tmp" "$target" || fail 'Edit atomic rename failed'
created=
trap - EXIT HUP INT TERM
`;

const GLOB_SCRIPT = `${COMMON_SHELL_HELPERS}
root=$(pwd -P) || exit 1
pattern=$1
pattern_re=$2
search_cwd=$3
if [ -n "$search_cwd" ]; then
  base=$(existing_target "$search_cwd" 'Glob cwd') || exit 1
else
  base=$root
fi
# Enumerate with ripgrep when present (fast), else POSIX find. Both branches emit
# root-relative paths filtered by the shared ERE ($pattern_re) -- membership never
# depends on rg's glob dialect -- then sort under a fixed locale BEFORE the 200 cap
# so a truncated result is the same set either way. rg's listing goes to a temp
# file (not a shell var) so the full set streams into the filter without being
# buffered in memory, while its exit code is still checked in this shell: rc>1
# surfaces a real error instead of "no files" (mirrors the Grep rg branch).
# rg flags: --no-config keeps it hermetic (a host RIPGREP_CONFIG_PATH cannot
# inject --follow/--glob); --no-ignore --hidden match find's file set; an explicit
# path avoids rg's never-closing stdin.
rel_base=.
[ "$base" != "$root" ] && rel_base=\${base#"$root"/}
if command -v rg >/dev/null 2>&1; then
  list=$(mktemp) || exit 1
  trap 'rm -f "$list"' EXIT
  ( cd "$root" && rg --no-config --files --no-ignore --hidden -- "$rel_base" ) > "$list"
  rc=$?
  [ "$rc" -gt 1 ] && { echo "ripgrep failed (exit $rc)" >&2; exit "$rc"; }
  sed 's#^\\./##' "$list" | awk -v re="$pattern_re" '$0 ~ re' | LC_ALL=C sort | awk 'NR <= 200'
else
  find "$base" -type f -print | awk -v root="$root" -v re="$pattern_re" '
    BEGIN { prefix = root "/" }
    {
      rel = $0
      if (index(rel, prefix) == 1) rel = substr(rel, length(prefix) + 1)
      if (rel ~ re) print rel
    }
  ' | LC_ALL=C sort | awk 'NR <= 200'
fi
`;

const GREP_SCRIPT = `${COMMON_SHELL_HELPERS}
root=$(pwd -P) || exit 1
grep_pattern=$1
input_path=$2
glob=$3
glob_re=$4
if [ -n "$input_path" ]; then
  start=$(existing_target "$input_path" 'Grep path') || exit 1
else
  start=$root
fi
# Prefer rg for the common no-glob case: faster, skips binaries, and a far richer
# regex than awk. rg's gitignore-style --glob is a different dialect from the
# fallback's ERE, so routing every glob through the single fallback path keeps
# results identical with or without rg installed; otherwise the POSIX find/awk
# walk runs. Output stays "<relpath>:<line>:<text>" and the per-file (50) / total
# (200) caps are preserved. existing_target above already enforced the inside-
# workspace + no-symlink-escape invariant for the search root in both paths;
# input_path is workspace-relative so rg, run from root, emits workspace-relative
# paths.
if [ -z "$glob" ] && command -v rg >/dev/null 2>&1; then
  # Always pass an explicit path: with none, rg reads from its (never-closing)
  # stdin pipe and hangs. "." searches the whole workspace; rg prefixes those
  # hits with "./", stripped below to the bare relative-path contract.
  search=$input_path
  [ -n "$search" ] || search=.
  # The rg arg list is fixed — no glob is routed here, so nothing is assembled
  # dynamically (and --glob is never re-grown into this branch):
  # --no-config: ignore RIPGREP_CONFIG_PATH so a host-set rg config cannot inject
  #   flags (e.g. --follow) that would break the no-workspace-escape invariant.
  # --no-follow: never traverse symlinks, matching the find/awk fallback (find
  #   without -L), so a workspace-internal symlink cannot leak external files.
  # --no-ignore --hidden: search the same file set as the fallback, so results do
  #   not depend on whether rg happens to be installed (rg still skips binaries).
  # --with-filename keeps the filename on single-file searches so the
  #   "<relpath>:<line>:<text>" contract holds in every case.
  # Capture only stdout; rg's stderr flows through to the script's stderr so a
  # real error is surfaced to the agent (via the executor) instead of swallowed.
  # rg exit: 0 = matched, 1 = no match (-> empty result), >1 = a real error (bad
  # regex, I/O) that must surface instead of masquerading as "no hits".
  matches=$(rg --no-config --no-follow --line-number --no-heading --with-filename --color never --no-ignore --hidden --max-count 50 -e "$grep_pattern" -- "$search")
  rc=$?
  [ "$rc" -gt 1 ] && { echo "ripgrep failed (exit $rc)" >&2; exit "$rc"; }
  printf '%s\n' "$matches" | sed 's#^\\./##' | awk 'NR <= 200'
else
  if [ -f "$start" ]; then
    file_list=$start
  else
    file_list=$(find "$start" -type f -print)
  fi
  printf '%s\n' "$file_list" | while IFS= read -r file; do
    [ -n "$file" ] || continue
    rel=$file
    prefix=$root/
    case "$rel" in "$prefix"*) rel=\${rel#"$prefix"} ;; esac
    if [ -n "$glob_re" ]; then
      printf '%s\n' "$rel" | awk -v re="$glob_re" 'BEGIN { ok = 1 } $0 ~ re { ok = 0 } END { exit ok }' || continue
    fi
    awk -v rel="$rel" -v pattern="$grep_pattern" '
      $0 ~ pattern {
        print rel ":" NR ":" $0
        count += 1
        if (count >= 50) exit
      }
    ' "$file"
  done | awk 'NR <= 200'
fi
`;
