import type { JSONValue, ModelMessage } from './model-protocol.js';

import {
  ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
  serializeToolResultForArchive,
} from './tool-result-archive.js';
import {
  buildToolResultArchiveResourceRef,
  TOOL_RESULT_ARCHIVE_READ_INSTRUCTIONS,
} from './tool-result-archive-resource.js';
import {
  estimateTokens,
  finitePositive,
  sha256,
  utf8ByteLength,
} from './context-budget-helpers.js';
import {
  planActiveToolResultSupersession,
  type ActiveToolResultCall,
  type ActiveToolResultObservation,
  type ActiveToolResultSupersession,
} from './active-tool-result-working-set.js';

export const ACTIVE_ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND = 'maka.active_archived_tool_result';

export type ActiveArchivedToolResultReason =
  'active_current_turn_tool_result_pruned_before_next_step';

export interface ActiveToolResultPrunePolicy {
  enabled: boolean;
  /** Tool result payloads above this estimate are archived and replaced. Defaults to 2048. */
  maxCurrentResultEstimatedTokens?: number;
  /** Superseded results below this estimate stay verbatim. Defaults to 256. */
  minSupersededResultEstimatedTokens?: number;
  /** Do not rewrite before this SDK step. Defaults to 1, so step 0 is untouched. */
  minStepNumber?: number;
}

export interface ActiveToolResultArchiveCandidate {
  turnId: string;
  toolCallId: string;
  toolName: string;
  result: unknown;
  serializedResult: string;
  originalEstimatedTokens: number;
  originalBytes: number;
  rewriteVersion: typeof ARCHIVED_TOOL_RESULT_REWRITE_VERSION;
  reason: ActiveArchivedToolResultReason;
  runtimeEventId?: string;
}

export interface ActiveArchivedToolResultPlaceholder {
  kind: typeof ACTIVE_ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND;
  rewriteVersion: typeof ARCHIVED_TOOL_RESULT_REWRITE_VERSION;
  artifactId: string;
  /** First-class, model-readable resource URI. Optional for persisted v1 compatibility. */
  resourceRef?: string;
  /** Explicit recovery action for the provider-visible placeholder. */
  readInstructions?: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  bodySha256: string;
  originalEstimatedTokens: number;
  originalBytes: number;
  reason: ActiveArchivedToolResultReason;
  /** Why a newer completed step made this provider-visible result redundant. */
  supersession?: ActiveToolResultSupersession;
}

const DEFAULT_MAX_CURRENT_RESULT_ESTIMATED_TOKENS = 2048;
const DEFAULT_MIN_SUPERSEDED_RESULT_ESTIMATED_TOKENS = 256;
const DEFAULT_CHARS_PER_TOKEN = 4;

export interface ActiveToolResultPruneArchiveInput extends ActiveToolResultArchiveCandidate {
  bodySha256: string;
}

export interface ActiveToolResultPruneInput {
  messages: readonly ModelMessage[];
  policy: ActiveToolResultPrunePolicy | undefined;
  stepNumber: number;
  turnId: string;
  charsPerToken?: number;
  eligibleToolCallIds?: ReadonlySet<string>;
  completedToolCalls?: readonly ActiveToolResultCall[];
  archiveToolResult?: (
    input: ActiveToolResultPruneArchiveInput,
  ) => Promise<{ artifactId: string } | void> | { artifactId: string } | void;
  archivedPlaceholders?: Map<string, ActiveArchivedToolResultPlaceholder>;
}

export interface ActiveToolResultPruneResult {
  messages: ModelMessage[];
  rewritten: number;
  archiveFailures: number;
  diagnosticPatch: ActiveToolResultPruneDiagnosticPatch;
}

export interface ActiveToolResultPruneDiagnosticPatch {
  activePrunedToolResults?: number;
  activeSupersededToolResults?: number;
  activeDuplicateToolResults?: number;
  activeArchiveFailures?: number;
  activeEstimatedTokensSaved?: number;
}

export interface ActiveToolResultLineageIdentity {
  toolCallId: string;
  toolName: string;
  bodySha256: string;
  payloadField: 'output' | 'result';
  outputKind?: string;
}

type ToolResultPartish = {
  type?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  output?: unknown;
  result?: unknown;
  [key: string]: unknown;
};

type Replacement =
  | { changed: false; archiveFailure?: boolean }
  | {
      changed: true;
      part: ToolResultPartish;
      estimatedTokensSaved: number;
      supersession?: ActiveToolResultSupersession;
    };

function collectSupersessionDecisions(
  input: ActiveToolResultPruneInput,
): Map<string, ActiveToolResultSupersession> {
  if (!input.completedToolCalls || input.completedToolCalls.length === 0) return new Map();
  const calls = new Map(input.completedToolCalls.map((call) => [call.toolCallId, call]));
  const observations: ActiveToolResultObservation[] = [];
  for (const message of input.messages) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const part of message.content as unknown[]) {
      if (!isToolResultPartish(part) || typeof part.toolCallId !== 'string') continue;
      const call = calls.get(part.toolCallId);
      if (!call || call.toolName !== part.toolName) continue;
      const payload = extractPayload(part);
      if (!payload || isArchivedPayload(payload.value)) continue;
      observations.push({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
        stepNumber: call.stepNumber,
        bodySha256: sha256(serializeToolResultForArchive(payload.value)),
        isError:
          payload.field === 'output' &&
          (payload.outputKind === 'error-text' || payload.outputKind === 'error-json'),
        eligible:
          input.eligibleToolCallIds === undefined || input.eligibleToolCallIds.has(call.toolCallId),
      });
    }
  }
  return planActiveToolResultSupersession(observations);
}

export async function rewriteActiveToolResultsInMessages(
  input: ActiveToolResultPruneInput,
): Promise<ActiveToolResultPruneResult> {
  const policy = input.policy;
  const minStepNumber = Math.max(0, Math.floor(policy?.minStepNumber ?? 1));
  if (policy?.enabled !== true || input.stepNumber < minStepNumber) {
    return { messages: [...input.messages], rewritten: 0, archiveFailures: 0, diagnosticPatch: {} };
  }

  const maxResultEstimatedTokens =
    finitePositive(policy.maxCurrentResultEstimatedTokens) ??
    DEFAULT_MAX_CURRENT_RESULT_ESTIMATED_TOKENS;
  const minSupersededResultEstimatedTokens =
    finitePositive(policy.minSupersededResultEstimatedTokens) ??
    DEFAULT_MIN_SUPERSEDED_RESULT_ESTIMATED_TOKENS;
  const charsPerToken = input.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  const archivedPlaceholders =
    input.archivedPlaceholders ?? new Map<string, ActiveArchivedToolResultPlaceholder>();
  const supersessionDecisions = collectSupersessionDecisions(input);

  let rewritten = 0;
  let activeSupersededToolResults = 0;
  let activeDuplicateToolResults = 0;
  let archiveFailures = 0;
  let activeEstimatedTokensSaved = 0;
  let anyChanged = false;
  const nextMessages: ModelMessage[] = [];

  for (const message of input.messages) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) {
      nextMessages.push(message);
      continue;
    }

    let nextContent: unknown[] | undefined;
    const originalContent = message.content as unknown[];
    for (let index = 0; index < originalContent.length; index += 1) {
      const part = originalContent[index];
      if (!isToolResultPartish(part)) {
        if (nextContent) nextContent.push(part);
        continue;
      }

      const replacement = await rewriteToolResultPart({
        part,
        policy,
        turnId: input.turnId,
        charsPerToken,
        maxResultEstimatedTokens,
        minSupersededResultEstimatedTokens,
        eligibleToolCallIds: input.eligibleToolCallIds,
        archiveToolResult: input.archiveToolResult,
        archivedPlaceholders,
        supersession: supersessionDecisions.get(part.toolCallId as string),
      });

      if (replacement.changed) {
        rewritten += 1;
        if (replacement.supersession) {
          activeSupersededToolResults += 1;
          if (replacement.supersession.reason === 'exact_duplicate') {
            activeDuplicateToolResults += 1;
          }
        }
        activeEstimatedTokensSaved += replacement.estimatedTokensSaved;
        anyChanged = true;
        if (!nextContent) nextContent = originalContent.slice(0, index);
        nextContent.push(replacement.part);
      } else {
        if (replacement.archiveFailure) archiveFailures += 1;
        if (nextContent) nextContent.push(part);
      }
    }

    if (nextContent) {
      nextMessages.push({ ...message, content: nextContent } as ModelMessage);
    } else {
      nextMessages.push(message);
    }
  }

  return {
    messages: anyChanged ? nextMessages : [...input.messages],
    rewritten,
    archiveFailures,
    diagnosticPatch: {
      ...(rewritten > 0 ? { activePrunedToolResults: rewritten } : {}),
      ...(activeSupersededToolResults > 0 ? { activeSupersededToolResults } : {}),
      ...(activeDuplicateToolResults > 0 ? { activeDuplicateToolResults } : {}),
      ...(archiveFailures > 0 ? { activeArchiveFailures: archiveFailures } : {}),
      ...(activeEstimatedTokensSaved > 0 ? { activeEstimatedTokensSaved } : {}),
    },
  };
}

async function rewriteToolResultPart(input: {
  part: ToolResultPartish;
  policy: ActiveToolResultPrunePolicy;
  turnId: string;
  charsPerToken: number;
  maxResultEstimatedTokens: number;
  minSupersededResultEstimatedTokens: number;
  eligibleToolCallIds?: ReadonlySet<string>;
  archiveToolResult?: ActiveToolResultPruneInput['archiveToolResult'];
  archivedPlaceholders: Map<string, ActiveArchivedToolResultPlaceholder>;
  supersession?: ActiveToolResultSupersession;
}): Promise<Replacement> {
  if (typeof input.part.toolCallId !== 'string' || typeof input.part.toolName !== 'string') {
    return { changed: false };
  }
  if (input.eligibleToolCallIds && !input.eligibleToolCallIds.has(input.part.toolCallId)) {
    return { changed: false };
  }

  const payload = extractPayload(input.part);
  if (!payload) return { changed: false };
  if (isArchivedPayload(payload.value)) return { changed: false };

  const serializedResult = serializeToolResultForArchive(payload.value);
  const originalEstimatedTokens = estimateTokens(serializedResult.length, input.charsPerToken);
  if (
    input.supersession
      ? originalEstimatedTokens < input.minSupersededResultEstimatedTokens
      : originalEstimatedTokens <= input.maxResultEstimatedTokens
  ) {
    return { changed: false };
  }

  const originalBytes = utf8ByteLength(serializedResult);
  const bodySha256 = sha256(serializedResult);
  const cacheKey = `${input.part.toolCallId}:${bodySha256}`;
  let placeholder = input.archivedPlaceholders.get(cacheKey);

  if (!placeholder) {
    const candidate: ActiveToolResultPruneArchiveInput = {
      turnId: input.turnId,
      toolCallId: input.part.toolCallId,
      toolName: input.part.toolName,
      result: payload.value,
      serializedResult,
      originalEstimatedTokens,
      originalBytes,
      bodySha256,
      rewriteVersion: ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
      reason: 'active_current_turn_tool_result_pruned_before_next_step',
    };
    let archived: { artifactId: string } | void;
    try {
      archived = await Promise.resolve(input.archiveToolResult?.(candidate));
    } catch {
      archived = undefined;
    }
    if (!isUsableArtifactId(archived?.artifactId)) {
      return { changed: false, archiveFailure: true };
    }
    placeholder = {
      kind: ACTIVE_ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND,
      rewriteVersion: ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
      artifactId: archived.artifactId,
      resourceRef: buildToolResultArchiveResourceRef({
        artifactId: archived.artifactId,
        bodySha256,
        originalBytes,
      }),
      readInstructions: TOOL_RESULT_ARCHIVE_READ_INSTRUCTIONS,
      turnId: input.turnId,
      toolCallId: input.part.toolCallId,
      toolName: input.part.toolName,
      bodySha256,
      originalEstimatedTokens,
      originalBytes,
      reason: 'active_current_turn_tool_result_pruned_before_next_step',
      ...(input.supersession ? { supersession: input.supersession } : {}),
    };
    input.archivedPlaceholders.set(cacheKey, placeholder);
  } else if (input.supersession) {
    placeholder = { ...placeholder, supersession: input.supersession };
    input.archivedPlaceholders.set(cacheKey, placeholder);
  } else if (placeholder.supersession) {
    const { supersession: _supersession, ...genericPlaceholder } = placeholder;
    placeholder = genericPlaceholder;
    input.archivedPlaceholders.set(cacheKey, placeholder);
  }

  const placeholderText =
    payload.field === 'output' &&
    (payload.outputKind === 'text' || payload.outputKind === 'error-text')
      ? activePlaceholderText(placeholder)
      : serializeToolResultForArchive(placeholder);
  const placeholderEstimatedTokens = estimateTokens(placeholderText.length, input.charsPerToken);
  if (input.supersession && placeholderEstimatedTokens >= originalEstimatedTokens) {
    return { changed: false };
  }

  return {
    changed: true,
    part: replacePayload(input.part, payload, placeholder),
    estimatedTokensSaved: Math.max(0, originalEstimatedTokens - placeholderEstimatedTokens),
    ...(input.supersession ? { supersession: input.supersession } : {}),
  };
}

function extractPayload(
  part: ToolResultPartish,
):
  | { field: 'output'; value: unknown; outputKind: string }
  | { field: 'result'; value: unknown }
  | undefined {
  if ('output' in part) {
    const output = part.output;
    if (!output || typeof output !== 'object') return undefined;
    const candidate = output as { type?: unknown; value?: unknown };
    if (
      (candidate.type === 'text' ||
        candidate.type === 'json' ||
        candidate.type === 'error-text' ||
        candidate.type === 'error-json') &&
      'value' in candidate
    ) {
      return { field: 'output', value: candidate.value, outputKind: candidate.type };
    }
    return undefined;
  }

  if ('result' in part) {
    return { field: 'result', value: part.result };
  }

  return undefined;
}

function replacePayload(
  part: ToolResultPartish,
  payload: { field: 'output'; outputKind: string } | { field: 'result' },
  placeholder: ActiveArchivedToolResultPlaceholder,
): ToolResultPartish {
  if (payload.field === 'result') {
    return { ...part, result: placeholder };
  }

  const output = part.output as Record<string, unknown>;
  const nextValue =
    payload.outputKind === 'text' || payload.outputKind === 'error-text'
      ? activePlaceholderText(placeholder)
      : (placeholder as unknown as JSONValue);
  return {
    ...part,
    output: {
      ...output,
      value: nextValue,
    },
  };
}

export function isActiveArchivedToolResultPlaceholder(
  value: unknown,
): value is ActiveArchivedToolResultPlaceholder {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ActiveArchivedToolResultPlaceholder>;
  return (
    candidate.kind === ACTIVE_ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND &&
    candidate.rewriteVersion === ARCHIVED_TOOL_RESULT_REWRITE_VERSION &&
    typeof candidate.artifactId === 'string' &&
    isUsableArtifactId(candidate.artifactId) &&
    typeof candidate.turnId === 'string' &&
    candidate.turnId.length > 0 &&
    typeof candidate.toolCallId === 'string' &&
    candidate.toolCallId.length > 0 &&
    typeof candidate.toolName === 'string' &&
    candidate.toolName.length > 0 &&
    typeof candidate.bodySha256 === 'string' &&
    candidate.bodySha256.length > 0 &&
    typeof candidate.originalEstimatedTokens === 'number' &&
    Number.isFinite(candidate.originalEstimatedTokens) &&
    candidate.originalEstimatedTokens > 0 &&
    typeof candidate.originalBytes === 'number' &&
    Number.isFinite(candidate.originalBytes) &&
    candidate.originalBytes > 0 &&
    candidate.reason === 'active_current_turn_tool_result_pruned_before_next_step' &&
    isValidSupersession(candidate.supersession)
  );
}

/**
 * Return the stable identity of a tool-result part across active pruning.
 * The raw payload and its archive placeholder intentionally share the hash of
 * the serialized raw result, so compaction lineage can treat pruning as a
 * representation change rather than a divergent source history.
 */
export function activeToolResultLineageIdentity(
  value: unknown,
): ActiveToolResultLineageIdentity | undefined {
  if (!isToolResultPartish(value)) return undefined;
  if (typeof value.toolCallId !== 'string' || typeof value.toolName !== 'string') return undefined;
  const payload = extractPayload(value);
  if (!payload) return undefined;
  const placeholder = isActiveArchivedToolResultPlaceholder(payload.value)
    ? payload.value
    : typeof payload.value === 'string' && isActiveArchivedToolResultPlaceholderText(payload.value)
      ? (JSON.parse(payload.value) as ActiveArchivedToolResultPlaceholder)
      : undefined;
  return {
    toolCallId: value.toolCallId,
    toolName: value.toolName,
    bodySha256: placeholder?.bodySha256 ?? sha256(serializeToolResultForArchive(payload.value)),
    payloadField: payload.field,
    ...(payload.field === 'output' ? { outputKind: payload.outputKind } : {}),
  };
}

function isToolResultPartish(value: unknown): value is ToolResultPartish {
  return Boolean(
    value && typeof value === 'object' && (value as ToolResultPartish).type === 'tool-result',
  );
}

function activePlaceholderText(placeholder: ActiveArchivedToolResultPlaceholder): string {
  return JSON.stringify(placeholder);
}

function isArchivedPayload(value: unknown): boolean {
  return (
    isActiveArchivedToolResultPlaceholder(value) ||
    (typeof value === 'string' && isActiveArchivedToolResultPlaceholderText(value))
  );
}

function isValidSupersession(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ActiveToolResultSupersession>;
  return (
    (candidate.reason === 'exact_duplicate' ||
      candidate.reason === 'newer_read_covers_range' ||
      candidate.reason === 'newer_snapshot' ||
      candidate.reason === 'failure_resolved') &&
    typeof candidate.supersededByToolCallId === 'string' &&
    candidate.supersededByToolCallId.length > 0 &&
    (candidate.reason === 'failure_resolved'
      ? typeof candidate.failureBodySha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(candidate.failureBodySha256)
      : candidate.failureBodySha256 === undefined)
  );
}

function isActiveArchivedToolResultPlaceholderText(value: string): boolean {
  try {
    return isActiveArchivedToolResultPlaceholder(JSON.parse(value));
  } catch {
    return false;
  }
}

function isUsableArtifactId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
