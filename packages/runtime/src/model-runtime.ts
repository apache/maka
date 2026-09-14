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
  PROVIDER_REGISTRY,
  effectiveBaseUrl,
  type ModelInfo,
  type ProviderType,
} from '@maka/core/llm-connections';
import {
  lookupModelMetadata,
  lookupModelRuntimeOverride,
  openAiAdapterApiProtocol,
} from '@maka/core/model-metadata';
import { isRetiredProvider } from '@maka/core/provider-registry';
import {
  anthropicV1BaseUrl,
  googleV1BetaBaseUrl,
  openAiResponsesBaseUrl,
} from './provider-urls.js';
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

type ModelRuntimeCall =
  | {
      wire: 'anthropic-messages';
      adapter: Extract<RuntimeProviderAdapter, { kind: 'anthropic' }>;
      reasoningReplay: { kind: 'anthropic-signed' };
    }
  | {
      wire: 'openai-chat';
      adapter: Extract<RuntimeProviderAdapter, { kind: 'openai' | 'openai-compatible' }>;
      reasoningReplay: Extract<ReasoningReplayContract, { kind: 'none' | 'openai-chat-plaintext' }>;
    }
  | {
      wire: 'openai-responses';
      adapter: Extract<
        RuntimeProviderAdapter,
        { kind: 'openai' | 'openai-compatible' | 'openai-codex' }
      >;
      reasoningReplay: Extract<ReasoningReplayContract, { kind: 'responses' }>;
    }
  | {
      wire: 'google-generate';
      adapter: Extract<RuntimeProviderAdapter, { kind: 'google' }>;
      reasoningReplay: { kind: 'none' };
    }
  | {
      wire: 'cohere-v2';
      adapter: Extract<RuntimeProviderAdapter, { kind: 'cohere' }>;
      reasoningReplay: { kind: 'none' };
    };

export type ResolvedModelRuntime = ModelRuntimeCall & {
  baseUrl: string;
  /** Effective parallel-tool-call support after model facts and wire defaults are resolved. */
  parallelToolCalls?: boolean;
  /** Provider-options namespace used by durable plaintext-summary replay. */
  responsesProviderOptionsKey?: string;
  /** Stable connection identity that issued a durable plaintext-summary item. */
  responsesReplayProfile?: string;
  /** Effective ApplyPatch contract after provider, model, and request wire are resolved. */
  applyPatchProfile: ApplyPatchProfile | null;
};

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
  // Model metadata cannot reactivate a retired provider.
  if (isRetiredProvider(connection.providerType)) {
    throw new Error(
      `"${connection.providerType}" is retired and can no longer resolve a model runtime.`,
    );
  }
  const override = lookupModelRuntimeOverride(connection.providerType, modelId);
  const defaults = PROVIDER_REGISTRY[connection.providerType];
  if (!override && !defaults) {
    throw new Error(
      `Unknown provider type "${connection.providerType}"; cannot resolve model runtime.`,
    );
  }
  const apiProtocol = connection.models?.find((model) => model.id === modelId)?.apiProtocol;
  const baseAdapter = resolveRuntimeProviderAdapter(override?.adapter ?? defaults.runtimeAdapter);
  const calls = adapterCalls(baseAdapter);
  const preferred = openAiAdapterApiProtocol(modelId, connection.providerType);
  const defaultCall = calls.find((call) => call.wire === preferred) ?? calls[0]!;
  const declared = apiProtocol ? defaults.protocolAdapters?.[apiProtocol] : undefined;
  const call =
    apiProtocol === undefined
      ? defaultCall
      : (calls.find((candidate) => candidate.wire === apiProtocol) ??
        (declared
          ? adapterCalls(resolveRuntimeProviderAdapter(declared)).find(
              (candidate) => candidate.wire === apiProtocol,
            )
          : undefined) ??
        adapterCalls(resolveRuntimeProviderAdapter(defaults.runtimeAdapter)).find(
          (candidate) => candidate.wire === apiProtocol,
        ));
  if (!call)
    throw new Error(`${defaults.label} does not support ${apiProtocol} for model ${modelId}`);
  const { adapter, wire, reasoningReplay: replay } = call;
  const configuredBaseUrl = connection.baseUrl?.trim();
  const resolvedBaseUrl = configuredBaseUrl
    ? effectiveBaseUrl(connection)
    : ((calls.includes(call) ? override?.baseUrl : undefined) ?? effectiveBaseUrl(connection));
  const baseUrl =
    adapter.kind === 'anthropic' && adapter.normalizeBaseUrl
      ? anthropicV1BaseUrl(resolvedBaseUrl)
      : adapter.kind === 'google' && adapter.normalizeBaseUrl !== false
        ? googleV1BetaBaseUrl(resolvedBaseUrl)
        : adapter.kind === 'openai-compatible' && adapter.normalizeBaseUrl
          ? anthropicV1BaseUrl(resolvedBaseUrl)
          : wire === 'openai-responses' && resolvedBaseUrl
            ? openAiResponsesBaseUrl(resolvedBaseUrl)
            : resolvedBaseUrl;
  const parallelToolCalls = resolveParallelToolCalls(connection, modelId, baseAdapter);
  return {
    ...call,
    baseUrl,
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

function adapterCalls(adapter: RuntimeProviderAdapter): ModelRuntimeCall[] {
  switch (adapter.kind) {
    case 'anthropic':
      return [
        { adapter, wire: 'anthropic-messages', reasoningReplay: { kind: 'anthropic-signed' } },
      ];
    case 'google':
      return [{ adapter, wire: 'google-generate', reasoningReplay: { kind: 'none' } }];
    case 'cohere':
      return [{ adapter, wire: 'cohere-v2', reasoningReplay: { kind: 'none' } }];
    case 'openai-codex':
      return [
        {
          adapter,
          wire: 'openai-responses',
          reasoningReplay: {
            kind: 'responses',
            contract: { adapter: 'openai', reasoningReplay: 'encrypted-content' },
          },
        },
      ];
    case 'openai': {
      const calls: ModelRuntimeCall[] = [];
      if (adapter.apiProtocol !== 'openai-responses')
        calls.push({ adapter, wire: 'openai-chat', reasoningReplay: { kind: 'none' } });
      if (adapter.apiProtocol !== 'openai-chat')
        calls.push({
          adapter,
          wire: 'openai-responses',
          reasoningReplay: {
            kind: 'responses',
            contract: { adapter: 'openai', reasoningReplay: 'encrypted-content' },
          },
        });
      return calls;
    }
    case 'openai-compatible': {
      const calls: ModelRuntimeCall[] = [
        {
          adapter,
          wire: 'openai-chat',
          reasoningReplay: {
            kind: 'openai-chat-plaintext',
            requestField: adapter.replayAssistantReasoningAs ?? 'observed',
          },
        },
      ];
      if (adapter.responses)
        calls.push({
          adapter,
          wire: 'openai-responses',
          reasoningReplay: { kind: 'responses', contract: adapter.responses },
        });
      return calls;
    }
    case 'unavailable':
      throw new Error('This provider has no Runtime adapter and cannot resolve a wire.');
  }
}
