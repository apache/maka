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
import { modelApplyPatchEnabled } from '@maka/core/model-thinking';
import { z } from 'zod';
import { CODEX_PATCH_DESCRIPTION, parseCodexV4aPatch } from './codex-v4a-patch.js';
import type { ApplyPatchOperation } from './filesystem-executor.js';
import type { ModelRuntimeWire } from './model-runtime.js';
import { openAiModelSupportsApplyPatch } from './openai-apply-patch.js';
import type { MakaTool } from './tool-runtime.js';

export type ApplyPatchProfile =
  | { readonly kind: 'openai-structured' }
  | { readonly kind: 'codex-v4a-freeform' }
  | { readonly kind: 'portable-v4a' };

export interface ApplyPatchProfileRuntime {
  readonly wire: ModelRuntimeWire;
  readonly applyPatchProtocol?: ApplyPatchProtocol;
  readonly enabled?: boolean;
  readonly customTools?: boolean;
}

const portableApplyPatchParameters = z.object({ patch: z.string() });

/** Project a provider-native ApplyPatch tool into the portable client-executed shape. */
export function portableApplyPatchTool(tool: MakaTool): MakaTool {
  return {
    ...tool,
    description: CODEX_PATCH_DESCRIPTION,
    parameters: portableApplyPatchParameters,
    providerTool: undefined,
  };
}

/** User overrides take precedence; new models can opt in through ordinary function calling. */
export function resolveApplyPatchProfile(
  runtime: ApplyPatchProfileRuntime,
  modelId: string,
): ApplyPatchProfile | null {
  if (!modelApplyPatchEnabled(modelId, { applyPatch: runtime.enabled })) return null;
  const structured =
    runtime.wire === 'openai-responses' &&
    runtime.applyPatchProtocol === 'openai-structured' &&
    openAiModelSupportsApplyPatch(modelId.trim().toLowerCase());
  if (structured) return { kind: 'openai-structured' };
  return runtime.customTools ? { kind: 'codex-v4a-freeform' } : { kind: 'portable-v4a' };
}

/** Project one verified profile into an exclusive model-facing editing surface. */
export function routeApplyPatchTools(
  tools: readonly MakaTool[],
  profile: ApplyPatchProfile | null,
): MakaTool[] {
  const applyPatchTool = tools.find((tool) => tool.providerTool?.kind === 'openai-apply-patch');
  if (!applyPatchTool) return [...tools];
  if (!profile) return tools.filter((tool) => tool !== applyPatchTool);

  const routed = tools.filter((tool) => tool.name !== 'Write' && tool.name !== 'Edit');
  if (profile.kind === 'openai-structured') return routed;
  return routed.map((tool) =>
    tool !== applyPatchTool
      ? tool
      : profile.kind === 'codex-v4a-freeform'
        ? {
            ...tool,
            description: CODEX_PATCH_DESCRIPTION,
            parameters: z.string(),
            providerTool: { kind: 'codex-apply-patch' as const },
          }
        : portableApplyPatchTool(tool),
  );
}

/** Re-encode history for the current tool transport, or preserve it as facts when disabled. */
export function normalizeApplyPatchReplayInput(
  profile: ApplyPatchProfile | null,
  toolCallId: string,
  input: unknown,
): unknown | null {
  // A missing profile means the target request does not advertise ApplyPatch.
  // Returning the historical input would serialize a call to an undeclared
  // tool; route it through the durable-fact downgrade instead.
  if (!profile) return null;
  const patch = patchText(input);
  if (profile.kind !== 'openai-structured') {
    const text = patch ?? structuredPatchText(input);
    if (text === null) return null;
    if (profile.kind === 'codex-v4a-freeform') return text;
    return patch !== null && typeof input === 'object' ? input : { patch: text };
  }
  if (patch === null) return structuredApplyPatchOperation(input) ? input : null;
  try {
    const operations = parseCodexV4aPatch(patch);
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
  const patch = patchText(input);
  if (patch !== null) {
    try {
      operations = parseCodexV4aPatch(patch);
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

function patchText(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object' && 'patch' in input && typeof input.patch === 'string')
    return input.patch;
  return null;
}

function structuredPatchText(input: unknown): string | null {
  const op = structuredApplyPatchOperation(input);
  if (!op) return null;
  const action =
    op.type === 'create_file' ? 'Add' : op.type === 'delete_file' ? 'Delete' : 'Update';
  const body = op.type === 'delete_file' ? '' : op.diff.endsWith('\n') ? op.diff : `${op.diff}\n`;
  return `*** Begin Patch\n*** ${action} File: ${op.path}\n${body}*** End Patch`;
}
