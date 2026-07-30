import type { MakaToolContext } from '@maka/runtime';
import {
  isAcceptedHeavyTaskSelfCheck,
  validateHeavyTaskPublicSelfCheck,
} from './heavy-task-self-check.js';
import type {
  HeavyTaskArtifactEvidence,
  HeavyTaskCommandEvidence,
  HeavyTaskCompactEvidenceEnvelope,
  HeavyTaskDiffSummary,
  HeavyTaskOutputSummary,
  HeavyTaskProgressSource,
  HeavyTaskSemanticSelfCheckState,
  HeavyTaskToolEvidenceName,
  HeavyTaskTruncationRef,
  TaskRunArtifact,
} from './task-contracts.js';
import type { TaskRunWriter } from './task-run-store.js';
import type {
  IsolatedCommandInput,
  IsolatedCommandResult,
  IsolatedEditFileInput,
  IsolatedEditFileResult,
  IsolatedGlobInput,
  IsolatedGlobResult,
  IsolatedGrepInput,
  IsolatedGrepResult,
  IsolatedReadFileInput,
  IsolatedReadFileResult,
  IsolatedWriteFileInput,
  IsolatedWriteFileResult,
} from './isolation.js';

export const HEAVY_TASK_EVIDENCE_SCHEMA_VERSION = 1;
export const DEFAULT_TEXT_EVIDENCE_LIMIT_CHARS = 2_000;
export const DEFAULT_PROMPT_EVIDENCE_LIMIT = 8;
export const DEFAULT_EXPORT_EVIDENCE_LIMIT = 25;
const NON_PUBLIC_EVIDENCE_PLACEHOLDER = '[omitted: non-public benchmark evidence pattern]';

export interface CompactTextEvidenceOptions {
  stream: HeavyTaskOutputSummary['stream'];
  limitChars?: number;
  ref?: string;
  refKind?: HeavyTaskTruncationRef['refKind'];
  forceTruncated?: boolean;
}

export interface HeavyTaskCompactEvidenceInput {
  evidenceId: string;
  taskRunId: string;
  attemptId?: string;
  ts: number;
  source: HeavyTaskCompactEvidenceEnvelope['source'];
}

export type HeavyTaskToolEvidenceInput =
  | {
      name: 'Bash';
      input: IsolatedCommandInput;
      result: IsolatedCommandResult;
      error?: unknown;
    }
  | {
      name: 'Read';
      input: IsolatedReadFileInput;
      result: IsolatedReadFileResult;
    }
  | {
      name: 'Grep';
      input: IsolatedGrepInput;
      result: IsolatedGrepResult;
    }
  | {
      name: 'Write';
      input: IsolatedWriteFileInput;
      result: IsolatedWriteFileResult;
    }
  | {
      name: 'Edit';
      input: IsolatedEditFileInput;
      result: IsolatedEditFileResult;
    }
  | {
      name: 'ApplyPatch';
      input: { cwd: string; patch: string };
      result: {
        ok: boolean;
        operations: Array<{
          operation: string;
          path: string;
          fromPath?: string;
          status: string;
          bytes?: number;
        }>;
        completed: string[];
        uncompleted: string[];
        partial?: boolean;
        error?: string;
      };
    }
  | {
      name: 'Glob';
      input: IsolatedGlobInput;
      result: IsolatedGlobResult;
    };

export interface HeavyTaskEvidenceRecorder {
  recordToolEvidence(
    input: HeavyTaskToolEvidenceInput,
    ctx: MakaToolContext,
  ): Promise<HeavyTaskCompactEvidenceEnvelope>;
  recordArtifactEvidence(
    artifact: TaskRunArtifact,
    ctx?: Partial<MakaToolContext>,
  ): Promise<HeavyTaskCompactEvidenceEnvelope>;
}

export function compactTextEvidence(
  value: string,
  options: CompactTextEvidenceOptions,
): HeavyTaskOutputSummary {
  const limitChars = options.limitChars ?? DEFAULT_TEXT_EVIDENCE_LIMIT_CHARS;
  const originalBytes = Buffer.byteLength(value, 'utf8');
  const lineCount = value.length === 0 ? 0 : value.split(/\r?\n/).length;
  const truncatedByLength = value.length > limitChars;
  const rawExcerpt =
    value.length === 0 ? undefined : oneLine(value.slice(0, limitChars), limitChars);
  const redactedBySourceGuard = rawExcerpt !== undefined && !isPublicEvidenceString(rawExcerpt);
  const truncated = Boolean(options.forceTruncated || truncatedByLength || redactedBySourceGuard);
  const excerpt = redactedBySourceGuard ? NON_PUBLIC_EVIDENCE_PLACEHOLDER : rawExcerpt;
  const visibleBytes = redactedBySourceGuard || !excerpt ? 0 : Buffer.byteLength(excerpt, 'utf8');
  const truncationRef: HeavyTaskTruncationRef = {
    truncated,
    originalBytes,
    visibleBytes,
    omittedBytes: Math.max(0, originalBytes - visibleBytes),
    ...(options.ref ? { ref: options.ref } : {}),
    ...(options.refKind ? { refKind: options.refKind } : {}),
  };
  return {
    stream: options.stream,
    ...(excerpt ? { excerpt } : {}),
    lineCount,
    byteCount: originalBytes,
    truncated,
    truncationRef,
  };
}

export function compactToolEvidence(
  input: HeavyTaskCompactEvidenceInput & HeavyTaskToolEvidenceInput,
): HeavyTaskCompactEvidenceEnvelope {
  const base = envelopeBase(input, 'tool', { ...input.source, toolName: input.name });
  switch (input.name) {
    case 'Bash':
      return {
        ...base,
        tool: {
          name: 'Bash',
          inputSummary: {
            command: compactPublicString(input.input.command, 500),
            cwd: compactPublicString(input.input.cwd, 500),
            timeoutMs: input.input.timeoutMs,
          },
          exitCode: input.result.exitCode,
          timedOut: input.result.timedOut ?? false,
          ok: input.result.exitCode === 0,
          outputs: [
            compactTextEvidence(input.result.stdout, {
              stream: 'stdout',
              refKind: 'future_storage',
            }),
            compactTextEvidence(input.result.stderr, {
              stream: 'stderr',
              refKind: 'future_storage',
            }),
          ],
          diff: { status: 'not_applicable' },
        },
      };
    case 'Read':
      return {
        ...base,
        tool: {
          name: 'Read',
          inputSummary: {
            path: compactPublicString(input.input.path, 500),
            offset: input.input.offset,
            limit: input.input.limit,
          },
          ok: true,
          outputs:
            'content' in input.result
              ? [
                  compactTextEvidence(input.result.content, {
                    stream: 'content',
                    refKind: 'future_storage',
                    forceTruncated: input.input.limit !== undefined,
                  }),
                ]
              : [
                  compactTextEvidence(`[image snapshot: ${input.result.mimeType}]`, {
                    stream: 'content',
                  }),
                ],
          diff: { status: 'not_applicable' },
        },
      };
    case 'Grep': {
      const matches = input.result.matches.join('\n');
      return {
        ...base,
        tool: {
          name: 'Grep',
          inputSummary: {
            pattern: compactPublicString(input.input.pattern, 240),
            path: input.input.path ? compactPublicString(input.input.path, 500) : undefined,
            glob: input.input.glob ? compactPublicString(input.input.glob, 240) : undefined,
            matchCount: input.result.matches.length,
          },
          ok: true,
          outputs: [
            compactTextEvidence(matches, {
              stream: 'matches',
              refKind: 'future_storage',
              forceTruncated: input.result.matches.length >= 200,
            }),
          ],
          diff: { status: 'not_applicable' },
        },
      };
    }
    case 'Write':
      return {
        ...base,
        tool: {
          name: 'Write',
          inputSummary: {
            path: compactPublicString(input.input.path, 500),
            contentBytes: Buffer.byteLength(input.input.content, 'utf8'),
            contentOmitted: true,
          },
          ok: input.result.ok,
          outputs: [omittedOutput('content', Buffer.byteLength(input.input.content, 'utf8'))],
          diff: notCapturedDiff(input.result.path),
        },
      };
    case 'Edit':
      return {
        ...base,
        tool: {
          name: 'Edit',
          inputSummary: {
            path: compactPublicString(input.input.path, 500),
            oldStringBytes: Buffer.byteLength(input.input.oldString, 'utf8'),
            newStringBytes: Buffer.byteLength(input.input.newString, 'utf8'),
            oldStringOmitted: true,
            newStringOmitted: true,
            replacements: input.result.replacements,
          },
          ok: input.result.ok,
          outputs: [omittedOutput('diff')],
          diff: notCapturedDiff(input.result.path),
        },
      };
    case 'ApplyPatch': {
      const completedPaths = input.result.completed;
      const primaryPath = completedPaths[0] ?? input.result.operations[0]?.path;
      return {
        ...base,
        tool: {
          name: 'ApplyPatch',
          inputSummary: {
            cwd: compactPublicString(input.input.cwd, 500),
            patchBytes: Buffer.byteLength(input.input.patch, 'utf8'),
            patchOmitted: true,
            operationCount: input.result.operations.length,
            completedPaths: completedPaths.map((path) => compactPublicString(path, 500)),
            uncompletedPaths: input.result.uncompleted.map((path) =>
              compactPublicString(path, 500),
            ),
            ...(input.result.partial !== undefined ? { partial: input.result.partial } : {}),
          },
          ok: input.result.ok,
          outputs: [omittedOutput('content', Buffer.byteLength(input.input.patch, 'utf8'))],
          diff: primaryPath ? notCapturedDiff(primaryPath) : { status: 'not_captured' },
        },
      };
    }
    case 'Glob':
      return {
        ...base,
        tool: {
          name: 'Glob',
          inputSummary: {
            pattern: compactPublicString(input.input.pattern, 240),
            searchCwd: input.input.searchCwd
              ? compactPublicString(input.input.searchCwd, 500)
              : undefined,
            fileCount: input.result.files.length,
          },
          ok: true,
          outputs: [
            compactTextEvidence(input.result.files.join('\n'), {
              stream: 'output',
              refKind: 'future_storage',
              forceTruncated: input.result.files.length >= 200,
            }),
          ],
          diff: { status: 'not_applicable' },
        },
      };
  }
}

export function compactArtifactEvidence(
  input: HeavyTaskCompactEvidenceInput & {
    artifact: TaskRunArtifact | HeavyTaskArtifactEvidence;
    source?: HeavyTaskProgressSource;
  },
): HeavyTaskCompactEvidenceEnvelope {
  const artifact = input.artifact;
  const isTaskRunArtifact = 'schemaVersion' in artifact && 'artifactId' in artifact;
  const source = input.source;
  return {
    ...envelopeBase(input, 'artifact', source),
    artifact: {
      ...(isTaskRunArtifact ? { artifactId: compactPublicString(artifact.artifactId, 500) } : {}),
      ...(artifact.path ? { path: compactPublicString(artifact.path, 500) } : {}),
      ...('workspacePath' in artifact && artifact.workspacePath
        ? { workspacePath: compactPublicString(artifact.workspacePath, 500) }
        : {}),
      ...('artifactRef' in artifact && artifact.artifactRef
        ? { artifactRef: compactPublicString(artifact.artifactRef, 500) }
        : {}),
      kind: compactPublicString(artifact.kind, 200),
      ...('exists' in artifact && artifact.exists !== undefined ? { exists: artifact.exists } : {}),
      ...('sizeBytes' in artifact && artifact.sizeBytes !== undefined
        ? { sizeBytes: artifact.sizeBytes }
        : {}),
      ...(artifact.hash ? { hash: compactPublicString(artifact.hash, 200) } : {}),
      ...('mimeType' in artifact && artifact.mimeType
        ? { mimeType: compactPublicString(artifact.mimeType, 200) }
        : {}),
      ...(artifact.metadata ? { metadata: sanitizeMetadata(artifact.metadata) } : {}),
      ...(isTaskRunArtifact
        ? { authority: compactAuthority(artifact.authority) }
        : compactAuthorityFromSource(source)),
    },
    links: isTaskRunArtifact
      ? { artifactIds: [compactPublicString(artifact.artifactId, 500)] }
      : undefined,
  };
}

export function compactSelfCheckEvidence(input: {
  selfCheck: HeavyTaskSemanticSelfCheckState;
  newId: () => string;
}): HeavyTaskCompactEvidenceEnvelope[] {
  const selfCheck = input.selfCheck;
  if (!isAcceptedHeavyTaskSelfCheck(selfCheck)) return [];
  const base = {
    taskRunId: selfCheck.taskRunId,
    attemptId: selfCheck.attemptId,
    ts: selfCheck.ts,
    source: selfCheck.source,
  };
  const checkEnvelope: HeavyTaskCompactEvidenceEnvelope = {
    ...envelopeBase(
      { ...base, evidenceId: input.newId(), source: selfCheck.source },
      'check',
      selfCheck.source,
    ),
    check: {
      status: selfCheck.status,
      linkedSelfCheckId: selfCheck.selfCheckId,
    },
  };
  const commands = selfCheck.commandEvidence.map((command) =>
    compactSelfCheckCommandEvidence({
      ...base,
      evidenceId: input.newId(),
      source: { ...selfCheck.source, toolName: 'self_check_submit' },
      command,
      selfCheckId: selfCheck.selfCheckId,
    }),
  );
  const artifacts = selfCheck.artifactEvidence.map((artifact) => ({
    ...compactArtifactEvidence({
      ...base,
      evidenceId: input.newId(),
      source: { ...selfCheck.source, toolName: 'self_check_submit' },
      artifact,
    }),
    links: { checkIds: [selfCheck.selfCheckId] },
  }));
  return [checkEnvelope, ...commands, ...artifacts];
}

export function createHeavyTaskEvidenceRecorder(input: {
  taskRunId: string;
  attemptId?: string;
  store: TaskRunWriter;
  now: () => number;
  newId: () => string;
}): HeavyTaskEvidenceRecorder {
  return {
    async recordToolEvidence(toolInput, ctx) {
      const ts = input.now();
      const evidence = compactToolEvidence({
        ...toolInput,
        evidenceId: input.newId(),
        taskRunId: input.taskRunId,
        ...(input.attemptId ? { attemptId: input.attemptId } : {}),
        ts,
        source: sourceFromContext(ctx, toolInput.name),
      } as HeavyTaskCompactEvidenceInput & HeavyTaskToolEvidenceInput);
      await input.store.appendEvent(input.taskRunId, {
        type: 'heavy_task_evidence_recorded',
        id: input.newId(),
        taskRunId: input.taskRunId,
        ts,
        evidence,
      });
      return evidence;
    },
    async recordArtifactEvidence(artifact, ctx) {
      const ts = input.now();
      const evidence = compactArtifactEvidence({
        evidenceId: input.newId(),
        taskRunId: input.taskRunId,
        ...(input.attemptId ? { attemptId: input.attemptId } : {}),
        ts,
        source: sourceFromPartialContext(ctx),
        artifact,
      });
      await input.store.appendEvent(input.taskRunId, {
        type: 'heavy_task_evidence_recorded',
        id: input.newId(),
        taskRunId: input.taskRunId,
        ts,
        evidence,
      });
      return evidence;
    },
  };
}

export function renderHeavyTaskEvidenceForPrompt(projection: {
  heavyTaskEvidence?: HeavyTaskCompactEvidenceEnvelope[];
}): string | undefined {
  const evidence = projection.heavyTaskEvidence ?? [];
  if (evidence.length === 0) return undefined;
  const recent = evidence.slice(-DEFAULT_PROMPT_EVIDENCE_LIMIT);
  const lines = ['Heavy-task compact evidence from prior public tool/check/artifact observations:'];
  for (const item of recent) {
    if (item.tool) {
      const status = toolStatus(item.tool);
      lines.push(
        `- ${item.evidenceId} tool:${item.tool.name} ${status} ${inputSummary(item.tool.inputSummary)}`,
      );
      for (const output of item.tool.outputs.slice(0, 2)) {
        lines.push(
          `  - ${output.stream}: ${output.excerpt ? oneLine(output.excerpt, 180) : '[omitted]'}${truncationSuffix(output)}`,
        );
      }
      if (item.tool.diff && item.tool.diff.status !== 'not_applicable') {
        lines.push(
          `  - diff: ${item.tool.diff.status}${item.tool.diff.truncationRef?.ref ? ` ref=${item.tool.diff.truncationRef.ref}` : ''}`,
        );
      }
    } else if (item.artifact) {
      lines.push(
        `- ${item.evidenceId} artifact:${item.artifact.kind ?? 'unknown'} ${oneLine(item.artifact.path ?? item.artifact.workspacePath ?? item.artifact.artifactRef ?? item.artifact.artifactId ?? 'unknown', 180)}`,
      );
    } else if (item.check) {
      lines.push(
        `- ${item.evidenceId} check:${item.check.status ?? 'unknown'} selfCheck=${item.check.linkedSelfCheckId ?? 'none'}`,
      );
    }
  }
  if (evidence.length > recent.length) {
    lines.push(`- ${evidence.length - recent.length} older compact evidence item(s) omitted`);
  }
  lines.push(
    'Use these summaries and refs only; do not assume omitted raw stdout, stderr, file content, or diffs are available.',
  );
  return lines.join('\n');
}

function compactSelfCheckCommandEvidence(
  input: HeavyTaskCompactEvidenceInput & {
    command: HeavyTaskCommandEvidence;
    selfCheckId: string;
  },
): HeavyTaskCompactEvidenceEnvelope {
  return {
    ...envelopeBase(input, 'tool', input.source),
    tool: {
      name: 'self_check_submit',
      inputSummary: {
        command: compactPublicString(input.command.command, 500),
        artifactRefs: (input.command.artifactRefs ?? []).map((ref) =>
          compactPublicString(ref, 500),
        ),
      },
      exitCode: input.command.exitCode,
      ...(input.command.timedOut !== undefined ? { timedOut: input.command.timedOut } : {}),
      ...(input.command.exitCode === undefined || input.command.exitCode === null
        ? {}
        : { ok: input.command.exitCode === 0 }),
      outputs: input.command.outputExcerpt
        ? [
            compactTextEvidence(input.command.outputExcerpt, {
              stream: 'output',
              refKind: 'future_storage',
            }),
          ]
        : [],
      diff: { status: 'not_applicable' },
    },
    links: {
      checkIds: [input.selfCheckId],
      artifactIds: (input.command.artifactRefs ?? []).map((ref) => compactPublicString(ref, 500)),
    },
  };
}

function envelopeBase(
  input: HeavyTaskCompactEvidenceInput,
  kind: HeavyTaskCompactEvidenceEnvelope['kind'],
  source: HeavyTaskCompactEvidenceEnvelope['source'],
): Omit<HeavyTaskCompactEvidenceEnvelope, 'tool' | 'artifact' | 'check' | 'links'> {
  return {
    schemaVersion: HEAVY_TASK_EVIDENCE_SCHEMA_VERSION,
    evidenceId: input.evidenceId,
    taskRunId: input.taskRunId,
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    ts: input.ts,
    kind,
    public: true,
    source,
  };
}

function sourceFromContext(
  ctx: MakaToolContext,
  toolName: HeavyTaskToolEvidenceName,
): HeavyTaskCompactEvidenceEnvelope['source'] {
  return {
    kind: 'model_tool',
    toolCallId: ctx.toolCallId,
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.runId ? { agentRunId: ctx.runId } : {}),
    ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
    toolName,
  };
}

function sourceFromPartialContext(
  ctx: Partial<MakaToolContext> | undefined,
): HeavyTaskCompactEvidenceEnvelope['source'] {
  return {
    kind: 'model_tool',
    toolCallId: ctx?.toolCallId ?? 'system-artifact',
    ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx?.runId ? { agentRunId: ctx.runId } : {}),
    ...(ctx?.turnId ? { turnId: ctx.turnId } : {}),
  };
}

function omittedOutput(
  stream: HeavyTaskOutputSummary['stream'],
  byteCount = 0,
): HeavyTaskOutputSummary {
  return {
    stream,
    byteCount,
    lineCount: 0,
    truncated: true,
    truncationRef: {
      truncated: true,
      originalBytes: byteCount,
      visibleBytes: 0,
      omittedBytes: byteCount,
      refKind: 'future_storage',
    },
  };
}

function notCapturedDiff(path: string): HeavyTaskDiffSummary {
  return {
    status: 'not_captured',
    files: [{ path: compactPublicString(path, 500) }],
    truncationRef: { truncated: true, refKind: 'future_storage' },
  };
}

function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata).slice(0, 30)) {
    if (/^(?:body|content|stdout|stderr|output|diff|old_string|new_string)$/i.test(key)) continue;
    if (!isPublicEvidenceString(key)) continue;
    const next = sanitizeMetadataValue(value, 0);
    if (next !== undefined) out[key] = next;
  }
  return out;
}

function sanitizeMetadataValue(value: unknown, depth: number): unknown {
  if (depth > 3) return undefined;
  if (typeof value === 'string') {
    const clean = oneLine(value, 500);
    return isPublicEvidenceString(clean) ? clean : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value))
    return value
      .slice(0, 30)
      .map((item) => sanitizeMetadataValue(item, depth + 1))
      .filter((item) => item !== undefined);
  if (recordValue(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 30)) {
      if (/^(?:body|content|stdout|stderr|output|diff|old_string|new_string)$/i.test(key)) continue;
      if (!isPublicEvidenceString(key)) continue;
      const next = sanitizeMetadataValue(item, depth + 1);
      if (next !== undefined) out[key] = next;
    }
    return out;
  }
  return undefined;
}

function toolStatus(item: NonNullable<HeavyTaskCompactEvidenceEnvelope['tool']>): string {
  if (item.exitCode !== undefined) return `exit=${item.exitCode ?? 'unknown'}`;
  if (item.ok !== undefined) return `ok=${item.ok ? 'true' : 'false'}`;
  return 'status=unknown';
}

function inputSummary(input: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input).slice(0, 4)) {
    if (value === undefined) continue;
    parts.push(`${key}=${oneLine(String(value), 80)}`);
  }
  return parts.join(' ');
}

function truncationSuffix(output: HeavyTaskOutputSummary): string {
  const ref = output.truncationRef?.ref ? ` ref=${output.truncationRef.ref}` : '';
  const omitted = output.truncationRef?.omittedBytes
    ? ` omittedBytes=${output.truncationRef.omittedBytes}`
    : '';
  return output.truncated || ref || omitted
    ? ` [truncated=${output.truncated}${omitted}${ref}]`
    : '';
}

function oneLine(value: string, maxChars: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length <= maxChars ? clean : `${clean.slice(0, Math.max(0, maxChars - 3))}...`;
}

function compactPublicString(value: string, maxChars: number): string {
  const clean = oneLine(value, maxChars);
  return isPublicEvidenceString(clean) ? clean : NON_PUBLIC_EVIDENCE_PLACEHOLDER;
}

function compactAuthority(
  authority: TaskRunArtifact['authority'],
): NonNullable<HeavyTaskCompactEvidenceEnvelope['artifact']>['authority'] {
  return {
    source: compactPublicString(authority.source, 200),
    authoritative: authority.authoritative,
    ...(authority.label ? { label: compactPublicString(authority.label, 500) } : {}),
  };
}

function compactAuthorityFromSource(
  source: HeavyTaskCompactEvidenceEnvelope['source'],
): Pick<NonNullable<HeavyTaskCompactEvidenceEnvelope['artifact']>, 'authority'> {
  if (source.toolName !== 'self_check_submit') return {};
  return { authority: { source: 'self_check', authoritative: false } };
}

function isPublicEvidenceString(value: string): boolean {
  if (value.length === 0) return true;
  return validateHeavyTaskPublicSelfCheck({ publicReason: value }, 0).ok;
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
