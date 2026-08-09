import type { ProviderType } from '@maka/core/llm-connections';
import { z } from 'zod';
import type { ModelRuntimeWire } from './model-runtime.js';
import { parseCodexV4aPatch, serializeCodexV4aOperation } from './codex-v4a-patch.js';
import type { ApplyPatchOperation } from './filesystem-executor.js';
import { openAiModelSupportsApplyPatch } from './openai-apply-patch.js';
import type { MakaTool } from './tool-runtime.js';

export type ApplyPatchProfile =
  | { readonly kind: 'openai-structured' }
  | { readonly kind: 'codex-v4a-freeform' };

export interface ApplyPatchProfileRuntime {
  readonly providerType: ProviderType;
  readonly wire: ModelRuntimeWire;
  /** Resolved endpoint. Omitted only by catalog-only callers that assume the provider default. */
  readonly baseUrl?: string;
}

function usesOfficialEndpoint(baseUrl: string | undefined, hostname: string): boolean {
  if (baseUrl === undefined) return true;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === hostname;
  } catch {
    return false;
  }
}

/** Resolve the exact provider/model/wire contract; unknown combinations fail closed. */
export function resolveApplyPatchProfile(
  runtime: ApplyPatchProfileRuntime,
  modelId: string,
): ApplyPatchProfile | null {
  if (runtime.wire !== 'openai-responses') return null;
  const id = modelId.trim().toLowerCase();
  if (
    runtime.providerType === 'openai' &&
    usesOfficialEndpoint(runtime.baseUrl, 'api.openai.com') &&
    openAiModelSupportsApplyPatch(id)
  ) {
    return { kind: 'openai-structured' };
  }
  if (
    runtime.providerType === 'deepseek' &&
    usesOfficialEndpoint(runtime.baseUrl, 'api.deepseek.com') &&
    id === 'deepseek-v4-flash'
  ) {
    return { kind: 'codex-v4a-freeform' };
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

  return tools
    .filter((tool) => tool.name !== 'Write' && tool.name !== 'Edit')
    .map((tool) => {
      if (tool !== applyPatchTool || profile.kind !== 'codex-v4a-freeform') return tool;
      return {
        ...tool,
        parameters: z.string(),
        providerTool: { kind: 'openai-custom-apply-patch' as const },
        toModelOutput: ({ output }) => ({
          type: 'text' as const,
          value: freeformApplyPatchResultText(output),
        }),
      };
    });
}

export function freeformApplyPatchResultText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object') {
    const record = output as { output?: unknown; error?: unknown };
    if (typeof record.output === 'string') return record.output;
    if (typeof record.error === 'string') return record.error;
  }
  return 'ApplyPatch completed.';
}

/** Convert historical calls when a session switches between the two patch contracts. */
export function normalizeApplyPatchReplayInput(
  profile: ApplyPatchProfile | null,
  toolCallId: string,
  input: unknown,
): unknown | null {
  if (!profile) return input;
  if (profile.kind === 'codex-v4a-freeform') {
    if (typeof input === 'string') return input;
    const operation = structuredApplyPatchOperation(input);
    return operation ? serializeCodexV4aOperation(operation) : null;
  }
  if (typeof input !== 'string') return input;
  try {
    const operations = parseCodexV4aPatch(input);
    return operations.length === 1 ? { callId: toolCallId, operation: operations[0] } : null;
  } catch {
    return null;
  }
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
