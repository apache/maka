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

import type { ApplyPatchProtocol } from '@maka/core/llm-connections';
import { parseCodexV4aPatch } from './codex-v4a-patch.js';
import type { ApplyPatchOperation } from './filesystem-executor.js';
import type { ModelRuntimeWire } from './model-runtime.js';
import { openAiModelSupportsApplyPatch } from './openai-apply-patch.js';
import type { MakaTool } from './tool-runtime.js';

export type ApplyPatchProfile = { readonly kind: 'openai-structured' };

export interface ApplyPatchProfileRuntime {
  readonly wire: ModelRuntimeWire;
  readonly applyPatchProtocol?: ApplyPatchProtocol;
}

/** Resolve the exact provider/model/wire contract; unknown combinations fail closed. */
export function resolveApplyPatchProfile(
  runtime: ApplyPatchProfileRuntime,
  modelId: string,
): ApplyPatchProfile | null {
  if (runtime.wire !== 'openai-responses' || !runtime.applyPatchProtocol) return null;
  const id = modelId.trim().toLowerCase();
  if (runtime.applyPatchProtocol === 'openai-structured' && openAiModelSupportsApplyPatch(id)) {
    return { kind: 'openai-structured' };
  }
  return null;
}

/** Project one verified profile into an exclusive model-facing editing surface. */
export function routeApplyPatchTools(
  tools: readonly MakaTool[],
  profile: ApplyPatchProfile | null,
): MakaTool[] {
  const applyPatchTool = tools.find((tool) => tool.providerTool?.kind === 'openai-apply-patch');
  if (!applyPatchTool) return [...tools];
  if (!profile) return tools.filter((tool) => tool !== applyPatchTool);

  return tools.filter((tool) => tool.name !== 'Write' && tool.name !== 'Edit');
}

/** Convert historical freeform calls for a structured target, or reject an undeclared target. */
export function normalizeApplyPatchReplayInput(
  profile: ApplyPatchProfile | null,
  toolCallId: string,
  input: unknown,
): unknown | null {
  // A missing profile means the target request does not advertise ApplyPatch.
  // Returning the historical input would serialize a call to an undeclared
  // tool; route it through the durable-fact downgrade instead.
  if (!profile) return null;
  if (typeof input !== 'string') return input;
  try {
    const operations = parseCodexV4aPatch(input);
    return operations.length === 1 ? { callId: toolCallId, operation: operations[0] } : null;
  } catch {
    return null;
  }
}

/** Preserve an executed multi-file patch when the target wire cannot replay one call for it. */
export function applyPatchReplayFactText(
  input: unknown,
  output: unknown,
  isError: boolean,
): string | null {
  let operations: ApplyPatchOperation[];
  if (typeof input === 'string') {
    try {
      operations = parseCodexV4aPatch(input);
    } catch {
      return null;
    }
  } else {
    const operation = structuredApplyPatchOperation(input);
    if (!operation) return null;
    operations = [operation];
  }
  const recorded = recordedAppliedOperations(output);
  const applied = recorded ?? (isError ? [] : operations.map(operationFact));
  const facts = applied.map((item) => `${item.type} ${item.path}`).join(', ');
  if (!isError) {
    return `ApplyPatch completed ${applied.length} file operation${applied.length === 1 ? '' : 's'}: ${facts}.`;
  }
  const attempted = operations.map(operationFact);
  const attemptedFacts = attempted.map((item) => `${item.type} ${item.path}`).join(', ');
  return applied.length > 0
    ? `ApplyPatch failed after applying ${applied.length} file operation${applied.length === 1 ? '' : 's'}: ${facts}.`
    : `ApplyPatch failed while attempting ${attempted.length} file operation${attempted.length === 1 ? '' : 's'}: ${attemptedFacts}. No applied operation was recorded.`;
}

function operationFact(operation: ApplyPatchOperation): {
  type: ApplyPatchOperation['type'];
  path: string;
} {
  return { type: operation.type, path: operation.path };
}

function recordedAppliedOperations(
  output: unknown,
): Array<{ type: ApplyPatchOperation['type']; path: string }> | null {
  const candidate = unwrapToolResultValue(output);
  if (!candidate || typeof candidate !== 'object') return null;
  const applied = (candidate as { applied?: unknown }).applied;
  if (!Array.isArray(applied)) return null;
  const facts: Array<{ type: ApplyPatchOperation['type']; path: string }> = [];
  for (const item of applied) {
    if (!item || typeof item !== 'object') return null;
    const { type, path } = item as { type?: unknown; path?: unknown };
    if (
      (type !== 'create_file' && type !== 'update_file' && type !== 'delete_file') ||
      typeof path !== 'string'
    ) {
      return null;
    }
    facts.push({ type, path });
  }
  return facts;
}

function unwrapToolResultValue(output: unknown): unknown {
  if (!output || typeof output !== 'object') return output;
  const record = output as { kind?: unknown; value?: unknown };
  return record.kind === 'json' ? record.value : output;
}

function structuredApplyPatchOperation(input: unknown): ApplyPatchOperation | null {
  if (!input || typeof input !== 'object') return null;
  const operation = (input as { operation?: unknown }).operation;
  if (!operation || typeof operation !== 'object') return null;
  const candidate = operation as { type?: unknown; path?: unknown; diff?: unknown };
  if (typeof candidate.path !== 'string' || /[\r\n]/.test(candidate.path)) return null;
  if (candidate.type === 'delete_file') return { type: candidate.type, path: candidate.path };
  if (
    (candidate.type === 'create_file' || candidate.type === 'update_file') &&
    typeof candidate.diff === 'string'
  ) {
    return { type: candidate.type, path: candidate.path, diff: candidate.diff };
  }
  return null;
}
