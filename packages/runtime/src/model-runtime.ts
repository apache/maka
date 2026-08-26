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

import {
  PROVIDER_DEFAULTS,
  effectiveBaseUrl,
  type ModelInfo,
  type ProviderRuntimeAdapter,
  type ProviderType,
} from '@maka/core/llm-connections';
import {
  lookupModelMetadata,
  lookupModelProviderOverride,
  openAiAdapterApiProtocol,
} from '@maka/core/model-metadata';
import { isRetiredProvider } from '@maka/core/provider-registry';
import { resolveApplyPatchProfile, type ApplyPatchProfile } from './apply-patch-profile.js';
import {
  resolveRuntimeProviderAdapter,
  runtimeProviderName,
  type RuntimeProviderAdapter,
  type RuntimeProviderResponsesContract,
} from './provider-runtime-policy.js';

export type ModelRuntimeWire =
  | 'anthropic-messages'
  | 'openai-chat'
  | 'openai-responses'
  | 'google-generate'
  | 'cohere-v2';

export type ReasoningReplayContract =
  | { kind: 'none' }
  | { kind: 'anthropic-signed' }
  | { kind: 'openai-chat-plaintext'; requestField: 'observed' | 'reasoning' }
  | { kind: 'responses'; contract: RuntimeProviderResponsesContract };

export interface ResolvedModelRuntime {
  adapter: RuntimeProviderAdapter;
  baseUrl: string;
  /** Account-advertised request wire for adapters that route per model. */
  apiProtocol?: ModelInfo['apiProtocol'];
  /** Effective wire after account, adapter, and model defaults are resolved. */
  wire: ModelRuntimeWire;
  /** Durable reasoning replay semantics carried by that wire. */
  reasoningReplay: ReasoningReplayContract;
  /** Effective parallel-tool-call support after model facts and wire defaults are resolved. */
  parallelToolCalls?: boolean;
  /** Provider-options namespace used by durable plaintext-summary replay. */
  responsesProviderOptionsKey?: string;
  /** Stable connection identity that issued a durable plaintext-summary item. */
  responsesReplayProfile?: string;
  /** Effective ApplyPatch contract after provider, model, and request wire are resolved. */
  applyPatchProfile: ApplyPatchProfile | null;
}

export interface ModelRuntimeConnection {
  readonly slug?: string;
  readonly providerType: ProviderType;
  readonly baseUrl?: string;
  readonly models?: readonly ModelInfo[];
}

export function resolveModelRuntime(
  connection: ModelRuntimeConnection,
  modelId: string,
): ResolvedModelRuntime {
  // Ahead of the override lookup: an override builds its own active adapter,
  // so consulting it first would let a per-model entry hand a retired provider
  // a working adapter and skip the `unavailable` refusal below entirely. No
  // such entry exists today, but that table is generated from an external
  // source — one row should not be able to undo a retirement.
  if (isRetiredProvider(connection.providerType)) {
    throw new Error(
      `"${connection.providerType}" is retired and can no longer resolve a model runtime.`,
    );
  }
  const override = lookupModelProviderOverride(connection.providerType, modelId);
  const defaults = PROVIDER_DEFAULTS[connection.providerType];
  // Unknown providerType with no per-model override → can't resolve an adapter.
  // Throw a clear error rather than crashing on `.runtimeAdapter`. Mirrors
  // `isRealConnection` in @maka/core/connection-readiness.ts.
  if (!override && !defaults) {
    throw new Error(
      `Unknown provider type "${connection.providerType}"; cannot resolve model runtime.`,
    );
  }
  const apiProtocol = connection.models?.find((model) => model.id === modelId)?.apiProtocol;
  if (
    connection.providerType === 'kimi-coding-plan' &&
    apiProtocol !== undefined &&
    apiProtocol !== 'anthropic-messages' &&
    apiProtocol !== 'openai-chat'
  ) {
    throw new Error(
      `Kimi Coding Plan protocol must be openai-chat or anthropic-messages, received ${apiProtocol}`,
    );
  }
  const baseAdapter: ProviderRuntimeAdapter =
    connection.providerType === 'kimi-coding-plan' && apiProtocol === 'openai-chat'
      ? ({
          kind: 'openai-compatible',
          name: 'provider',
          includeUsage: true,
        } as const)
      : override
        ? runtimeAdapterOverride(override.npm)
        : defaults.runtimeAdapter;
  const adapter = resolveRuntimeProviderAdapter(baseAdapter);
  const configuredBaseUrl = connection.baseUrl?.trim();
  const resolvedBaseUrl = configuredBaseUrl
    ? effectiveBaseUrl(connection)
    : (override?.api ?? effectiveBaseUrl(connection));
  const wire = resolveModelRuntimeWire(connection.providerType, modelId, adapter, apiProtocol);
  const parallelToolCalls = resolveParallelToolCalls(connection, modelId, adapter);
  const replay = reasoningReplayContract(adapter, wire);
  return {
    adapter,
    baseUrl:
      connection.providerType === 'kimi-coding-plan' && apiProtocol === 'openai-chat'
        ? kimiOpenAiBaseUrl(resolvedBaseUrl)
        : resolvedBaseUrl,
    ...(apiProtocol ? { apiProtocol } : {}),
    wire,
    reasoningReplay: replay,
    ...(parallelToolCalls === undefined ? {} : { parallelToolCalls }),
    ...(replay.kind === 'responses' &&
    replay.contract.adapter === 'open-responses' &&
    replay.contract.reasoningReplay === 'plaintext-summary'
      ? {
          responsesProviderOptionsKey: runtimeProviderName(adapter, connection),
          responsesReplayProfile: connection.slug ?? connection.providerType,
        }
      : {}),
    applyPatchProfile: resolveApplyPatchProfile(
      {
        wire,
        applyPatchProtocol: adapter.applyPatchProtocol,
      },
      modelId,
    ),
  };
}

function resolveParallelToolCalls(
  connection: ModelRuntimeConnection,
  modelId: string,
  adapter: RuntimeProviderAdapter,
): boolean | undefined {
  const stored = connection.models?.find((model) => model.id === modelId)?.capabilities
    ?.parallelToolCalls;
  if (stored !== undefined) return stored;
  const metadata = lookupModelMetadata(connection.providerType, modelId).capabilities
    ?.parallelToolCalls;
  if (metadata !== undefined) return metadata;

  // The native OpenAI adapters expose the parallel_tool_calls request switch
  // on both Chat Completions and Responses. Compatible providers vary, so
  // they require an explicit model declaration instead of inheriting this.
  return adapter.kind === 'openai' || adapter.kind === 'openai-codex' ? true : undefined;
}

export function modelUsesAnthropicMessages(
  connection: ModelRuntimeConnection,
  modelId: string,
): boolean {
  return resolveModelRuntime(connection, modelId).wire === 'anthropic-messages';
}

/** Native OpenAI lanes keep mutable continuation state inside ModelAdapter. */
export function modelUsesNativeOpenAiResponses(
  connection: ModelRuntimeConnection,
  modelId: string,
): boolean {
  return (
    connection.providerType === 'openai' &&
    resolveModelRuntime(connection, modelId).wire === 'openai-responses'
  );
}

function resolveModelRuntimeWire(
  providerType: ProviderType,
  modelId: string,
  adapter: RuntimeProviderAdapter,
  apiProtocol: ModelInfo['apiProtocol'] | undefined,
): ModelRuntimeWire {
  switch (adapter.kind) {
    case 'anthropic':
      return 'anthropic-messages';
    case 'unavailable':
      // Reached only if something selected a retired provider despite the
      // pickers filtering it out; failing here beats sending on a wire we
      // cannot name.
      throw new Error('This provider has no Runtime adapter and cannot resolve a wire.');
    case 'openai-codex':
      return 'openai-responses';
    case 'github-copilot':
      return apiProtocol === 'anthropic-messages'
        ? 'anthropic-messages'
        : apiProtocol === 'openai-responses'
          ? 'openai-responses'
          : 'openai-chat';
    case 'openai':
      return (adapter.apiProtocol ??
        apiProtocol ??
        openAiAdapterApiProtocol(modelId, providerType)) === 'openai-responses'
        ? 'openai-responses'
        : 'openai-chat';
    case 'openai-compatible':
      return adapter.responses !== undefined &&
        (apiProtocol ?? openAiAdapterApiProtocol(modelId, providerType)) === 'openai-responses'
        ? 'openai-responses'
        : 'openai-chat';
    case 'google':
      return 'google-generate';
    case 'cohere':
      return 'cohere-v2';
  }
}

function reasoningReplayContract(
  adapter: RuntimeProviderAdapter,
  wire: ModelRuntimeWire,
): ReasoningReplayContract {
  switch (wire) {
    case 'anthropic-messages':
      return { kind: 'anthropic-signed' };
    case 'openai-responses':
      return { kind: 'responses', contract: responsesContract(adapter) };
    case 'openai-chat':
      return adapter.kind === 'openai-compatible'
        ? {
            kind: 'openai-chat-plaintext',
            requestField:
              adapter.replayAssistantReasoningAs === 'reasoning' ? 'reasoning' : 'observed',
          }
        : { kind: 'none' };
    case 'google-generate':
    case 'cohere-v2':
      return { kind: 'none' };
  }
}

function responsesContract(adapter: RuntimeProviderAdapter): RuntimeProviderResponsesContract {
  if (adapter.kind === 'openai-compatible' && adapter.responses) return adapter.responses;
  return { adapter: 'openai', reasoningReplay: 'encrypted-content' };
}

function kimiOpenAiBaseUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '')}/v1`;
}

function runtimeAdapterOverride(packageName: string): ProviderRuntimeAdapter {
  switch (packageName) {
    case '@ai-sdk/anthropic':
      return { kind: 'anthropic', auth: 'api-key', normalizeBaseUrl: true };
    case '@ai-sdk/google':
      return { kind: 'google', normalizeBaseUrl: false };
    case '@ai-sdk/openai':
      return { kind: 'openai' };
    case '@ai-sdk/openai-compatible':
      return { kind: 'openai-compatible', name: 'provider' };
    default:
      throw new Error(`models.dev model runtime package ${packageName} is unsupported`);
  }
}
