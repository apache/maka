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

/**
 * Current-Turn Tool Result pruning (#4283).
 *
 * The decision is still local to one request: which completed step's result is
 * large enough, and superseded enough, to be worth replacing before the next
 * provider step. What is no longer local is the RESULT of that decision. Every
 * replacement is committed as a durable projection transition first, so the
 * live continuation, the next Turn, a restart, a branch and a compaction all
 * read the same replaced projection instead of the old per-Turn placeholder map
 * that only the current `send()` could see.
 *
 * A result the durable ledger cannot address — no committed `function_response`
 * for the tool call yet, or a provider-native opaque result — is left alone. A
 * lossy rewrite the ledger cannot explain is exactly the state this protocol
 * exists to make unrepresentable.
 */

import type { JSONValue, ModelMessage } from './model-protocol.js';
import type { DurableToolResultProjection } from '@maka/core/durable-tool-result-projection';

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
import {
  archiveToolResultAsTransition,
  serializedToolResultProjection,
  type ToolResultArchiveTransitionServices,
} from './tool-result-archive-transition.js';
import {
  isArchivedToolResultPlaceholder,
  serializeToolResultForArchive,
  type ArchivedToolResultPlaceholder,
} from './tool-result-archive.js';

export interface ActiveToolResultPrunePolicy {
  enabled: boolean;
  /** Tool result payloads above this estimate are archived and replaced. Defaults to 2048. */
  maxCurrentResultEstimatedTokens?: number;
  /** Superseded results below this estimate stay verbatim. Defaults to 256. */
  minSupersededResultEstimatedTokens?: number;
  /** Do not rewrite before this SDK step. Defaults to 1, so step 0 is untouched. */
  minStepNumber?: number;
}

const DEFAULT_MAX_CURRENT_RESULT_ESTIMATED_TOKENS = 2048;
const DEFAULT_MIN_SUPERSEDED_RESULT_ESTIMATED_TOKENS = 256;
const DEFAULT_CHARS_PER_TOKEN = 4;

/**
 * The durable address of one in-flight tool result.
 *
 * The prune walks provider messages, but a transition names a RuntimeEvent, so
 * the caller must be able to map a provider tool-call id onto the committed
 * response event and the projection currently in effect for it.
 */
export interface ActiveToolResultProjectionSource {
  runtimeEventId: string;
  turnId: string;
  toolName: string;
  projection: DurableToolResultProjection;
  /** The transition currently in effect for this target, if any. */
  previousTransitionId?: string;
}

export type ActiveToolResultProjectionResolver = (
  toolCallId: string,
) =>
  | ActiveToolResultProjectionSource
  | undefined
  | PromiseLike<ActiveToolResultProjectionSource | undefined>;

export interface ActiveToolResultPruneInput {
  messages: readonly ModelMessage[];
  policy: ActiveToolResultPrunePolicy | undefined;
  stepNumber: number;
  turnId: string;
  charsPerToken?: number;
  eligibleToolCallIds?: ReadonlySet<string>;
  completedToolCalls?: readonly ActiveToolResultCall[];
  /** Durable address lookup; without it no rewrite may happen. */
  resolveProjection: ActiveToolResultProjectionResolver;
  /** Archive + transition writer. */
  transitions: ToolResultArchiveTransitionServices;
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
        input,
        charsPerToken,
        maxResultEstimatedTokens,
        minSupersededResultEstimatedTokens,
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
  input: ActiveToolResultPruneInput;
  charsPerToken: number;
  maxResultEstimatedTokens: number;
  minSupersededResultEstimatedTokens: number;
  supersession?: ActiveToolResultSupersession;
}): Promise<Replacement> {
  const { part } = input;
  if (typeof part.toolCallId !== 'string' || typeof part.toolName !== 'string') {
    return { changed: false };
  }
  const eligible = input.input.eligibleToolCallIds;
  if (eligible && !eligible.has(part.toolCallId)) return { changed: false };

  const payload = extractPayload(part);
  if (!payload) return { changed: false };
  if (isArchivedPayload(payload.value)) return { changed: false };

  // No durable address, no rewrite: the ledger must be able to explain any
  // content the model stops seeing.
  const address = await Promise.resolve(input.input.resolveProjection(part.toolCallId));
  if (!address || address.toolName !== part.toolName) return { changed: false };
  const sourceProjection = address.projection;
  const serializedResult = serializedToolResultProjection(sourceProjection);
  const originalEstimatedTokens = estimateTokens(serializedResult.length, input.charsPerToken);
  if (
    input.supersession
      ? originalEstimatedTokens < input.minSupersededResultEstimatedTokens
      : originalEstimatedTokens <= input.maxResultEstimatedTokens
  ) {
    return { changed: false };
  }

  const outcome = await archiveToolResultAsTransition(input.input.transitions, {
    runtimeEventId: address.runtimeEventId,
    turnId: address.turnId,
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    sourceProjection,
    serializedResult,
    originalBytes: utf8ByteLength(serializedResult),
    originalEstimatedTokens,
    reason: 'active_current_turn_tool_result_pruned_before_next_step',
    ...(address.previousTransitionId ? { previousTransitionId: address.previousTransitionId } : {}),
    ...(input.supersession ? { supersession: input.supersession } : {}),
    result: payload.value,
  });
  if (!outcome) return { changed: false, archiveFailure: true };

  const placeholderText =
    payload.field === 'output' &&
    (payload.outputKind === 'text' || payload.outputKind === 'error-text')
      ? JSON.stringify(outcome.placeholder)
      : serializeToolResultForArchive(outcome.placeholder);
  const placeholderEstimatedTokens = estimateTokens(placeholderText.length, input.charsPerToken);

  return {
    changed: true,
    part: replacePayload(part, payload, outcome.placeholder),
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
  placeholder: ArchivedToolResultPlaceholder,
): ToolResultPartish {
  if (payload.field === 'result') {
    return { ...part, result: placeholder };
  }

  const output = part.output as Record<string, unknown>;
  const nextValue =
    payload.outputKind === 'text' || payload.outputKind === 'error-text'
      ? JSON.stringify(placeholder)
      : (placeholder as unknown as JSONValue);
  return {
    ...part,
    output: {
      ...output,
      value: nextValue,
    },
  };
}

/**
 * A payload that already IS a placeholder, in either shape the provider format
 * allows: the JSON object, or the serialized text a `text` output carries.
 * Re-archiving one would archive a pointer, not a body.
 */
function isArchivedPayload(value: unknown): boolean {
  if (isArchivedToolResultPlaceholder(value)) return true;
  if (typeof value !== 'string') return false;
  try {
    return isArchivedToolResultPlaceholder(JSON.parse(value));
  } catch {
    return false;
  }
}

function isToolResultPartish(value: unknown): value is ToolResultPartish {
  return Boolean(
    value && typeof value === 'object' && (value as ToolResultPartish).type === 'tool-result',
  );
}
