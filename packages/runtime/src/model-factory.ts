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

import { createAnthropic } from '@ai-sdk/anthropic';
// Load-bearing until the public Anthropic API exposes model thinking mode:
// replace this capability lookup when upgrading if the exported internal path disappears.
import { getModelCapabilities as getAnthropicModelCapabilities } from '@ai-sdk/anthropic/internal';
import { createCohere } from '@ai-sdk/cohere';
import { createGoogle } from '@ai-sdk/google';
import { createOpenResponses } from '@ai-sdk/open-responses';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible, type MetadataExtractor } from '@ai-sdk/openai-compatible';
import {
  isJSONArray,
  type JSONArray,
  type LanguageModelV4,
  type LanguageModelV4StreamPart,
  type SharedV4ProviderMetadata,
  type SharedV4ProviderOptions,
} from '@ai-sdk/provider';
import { type RuntimeExecutionConnection } from '@maka/core/llm-connections';
import { lookupModelMetadata } from '@maka/core/model-metadata';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import {
  resolveThinkingLevel,
  supportsRelayFastServiceTier,
  thinkingOptionsForModel,
  thinkingVariantsForConnection,
  type ThinkingOptions,
} from '@maka/core/model-thinking';
import {
  createOpenAiChatReasoningTransport,
  createOpenAiChatReasoningTransportState,
  type OpenAiChatReasoningTransportState,
} from './openai-chat-reasoning-transport.js';
import type { OpenAiResponsesTransportState } from './openai-responses-websocket.js';
import {
  anthropicV1BaseUrl,
  googleV1BetaBaseUrl,
  openAiResponsesBaseUrl,
  openResponsesUrl,
} from './provider-urls.js';
import { createOpenResponsesCompatibilityFinalizer } from './open-responses-compatibility.js';
import { resolveModelRuntime, type ResolvedModelRuntime } from './model-runtime.js';
import { runtimeProviderName, type RuntimeProviderAdapter } from './provider-runtime-policy.js';
import { openAiCodexHeaders } from './subscription-auth.js';
import { createRequestCustomizationFetch } from './request-customization-fetch.js';
import { createStreamUsageFallbackFetch } from './stream-usage-fallback-fetch.js';

export interface ModelFactoryInput {
  connection: RuntimeExecutionConnection;
  apiKey: string;
  modelId: string;
  fetch?: typeof globalThis.fetch;
  requestHeaders?: Readonly<Record<string, string>>;
  resolvedRuntime?: ResolvedModelRuntime;
  openAiChatReasoningTransportState?: OpenAiChatReasoningTransportState;
  openAiResponsesTransportState?: OpenAiResponsesTransportState;
}

const ANTHROPIC_BETA = 'interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14';
export function getAIModel(input: ModelFactoryInput): LanguageModelV4 {
  const {
    connection,
    apiKey,
    modelId,
    fetch,
    requestHeaders,
    resolvedRuntime,
    openAiChatReasoningTransportState,
    openAiResponsesTransportState,
  } = input;
  const runtime = resolvedRuntime ?? resolveModelRuntime(connection, modelId);
  const { adapter, baseUrl: baseURL, wire, reasoningReplay } = runtime;
  const hasRequestCustomization =
    Object.keys(requestHeaders ?? {}).length > 0 ||
    Object.keys(connection.requestBodyOverlay ?? {}).length > 0;
  const baseFetch = fetch ?? globalThis.fetch;
  const requestCustomization = {
    headers: requestHeaders,
    bodyOverlay: connection.requestBodyOverlay,
  } as const;
  const requestFetch = createRequestCustomizationFetch(baseFetch, requestCustomization);

  if (adapter.kind === 'google' && adapter.normalizeBaseUrl === false) {
    return createGoogle({ apiKey, baseURL, fetch: requestFetch }).chat(modelId);
  }

  switch (adapter.kind) {
    case 'anthropic':
      return createAnthropic({
        ...(adapter.auth === 'bearer' ? { authToken: apiKey } : { apiKey }),
        baseURL: adapter.normalizeBaseUrl ? anthropicV1BaseUrl(baseURL) : baseURL,
        fetch: requestFetch,
        headers: { 'anthropic-beta': ANTHROPIC_BETA },
      }).chat(modelId);

    case 'unavailable':
      // A retired provider must never reach model construction. The pickers
      // filter it out and `resolveModelRuntime` refuses earlier; this is the
      // backstop that keeps a stored connection from silently sending.
      throw new Error('This provider is retired and can no longer be used to send.');

    case 'openai-codex':
      return createOpenAI({
        apiKey,
        baseURL,
        fetch:
          !hasRequestCustomization && openAiResponsesTransportState
            ? openAiResponsesTransportState.wrapFetch(requestFetch)
            : requestFetch,
        headers: openAiCodexHeaders(apiKey),
      }).responses(modelId);

    case 'github-copilot': {
      if (wire === 'openai-responses') {
        return createOpenAI({ apiKey, baseURL, fetch: requestFetch }).responses(modelId);
      }
      if (wire === 'anthropic-messages') {
        return createAnthropic({
          authToken: apiKey,
          baseURL: anthropicV1BaseUrl(baseURL),
          fetch: requestFetch,
        }).chat(modelId);
      }
      if (reasoningReplay.kind !== 'openai-chat-plaintext') {
        throw new Error('Copilot OpenAI Chat wire requires plaintext reasoning replay');
      }
      const reasoningTransport = createOpenAiChatReasoningTransport(
        requestFetch,
        openAiChatReasoningTransportState ??
          createOpenAiChatReasoningTransportState(reasoningReplay.requestField),
      );
      return createOpenAICompatible({
        name: 'github-copilot',
        apiKey,
        baseURL,
        fetch: reasoningTransport.fetch,
        transformRequestBody: reasoningTransport.transformRequestBody,
      }).chatModel(modelId);
    }

    case 'openai': {
      const openai = createOpenAI({
        apiKey,
        // The native adapter appends `/responses`; reduce endpoint-form
        // overrides back to their base so probe-approved relay URLs work.
        baseURL: wire === 'openai-responses' && baseURL ? openAiResponsesBaseUrl(baseURL) : baseURL,
        fetch:
          !hasRequestCustomization && openAiResponsesTransportState
            ? openAiResponsesTransportState.wrapFetch(requestFetch)
            : requestFetch,
      });
      return wire === 'openai-responses' ? openai.responses(modelId) : openai.chat(modelId);
    }

    case 'google':
      return createGoogle({
        apiKey,
        baseURL: googleV1BetaBaseUrl(baseURL),
        fetch: requestFetch,
      }).chat(modelId);

    case 'cohere':
      return createCohere({ apiKey, baseURL, fetch: requestFetch })(modelId);

    case 'openai-compatible': {
      if (adapter.requireBaseUrl && !baseURL) {
        throw new Error(
          `${connection.providerType} connection ${connection.slug} requires a base URL`,
        );
      }
      if (wire === 'openai-responses') {
        if (reasoningReplay.kind !== 'responses') {
          throw new Error('Responses wire requires a Responses continuation contract');
        }
        if (reasoningReplay.contract.adapter === 'open-responses') {
          const finalizeBody = createOpenResponsesCompatibilityFinalizer(
            reasoningReplay.contract.compatibility,
          );
          // Request customization is applied first; provider compatibility is
          // the final authority before network dispatch, so an overlay cannot
          // re-enable storage or violate the provider's tool-choice contract.
          const responsesFetch = finalizeBody
            ? createRequestCustomizationFetch(baseFetch, {
                ...requestCustomization,
                finalizeBody,
              })
            : requestFetch;
          return createOpenResponses({
            name: runtimeProviderName(adapter, connection),
            apiKey,
            url: openResponsesUrl(baseURL),
            fetch: responsesFetch,
          })(modelId);
        }
        return createOpenAI({
          apiKey,
          // Endpoint-form overrides (`…/responses`) probe successfully; the
          // native adapter appends `/responses` itself, so pass the base.
          baseURL: baseURL ? openAiResponsesBaseUrl(baseURL) : baseURL,
          fetch: requestFetch,
        }).responses(modelId);
      }
      if (reasoningReplay.kind !== 'openai-chat-plaintext') {
        throw new Error('OpenAI-compatible Chat wire requires plaintext reasoning replay');
      }
      const reasoningTransport = createOpenAiChatReasoningTransport(
        requestFetch,
        openAiChatReasoningTransportState ??
          createOpenAiChatReasoningTransportState(reasoningReplay.requestField),
        connection.providerType === 'kimi-coding-plan',
      );
      const transformRequestBody = adapter.replayAssistantReasoningDetails
        ? composeRequestTransforms(
            reasoningTransport.transformRequestBody,
            replayAssistantReasoning('reasoning', true),
          )
        : reasoningTransport.transformRequestBody;
      const model = createOpenAICompatible({
        name: runtimeProviderName(adapter, connection),
        apiKey,
        baseURL,
        // Ask every Chat Completions server for stream usage unless the
        // registry opts a provider out. Usage is the only signal the runtime's
        // context handling reads (#4559): without `stream_options.include_usage`
        // an OpenAI-compatible relay or a local Ollama returns none, and the
        // proactive compaction baseline, the eviction check, and the usage
        // indicator all go dark for exactly the connections that need them.
        includeUsage: adapter.includeUsage ?? true,
        fetch: createStreamUsageFallbackFetch(reasoningTransport.fetch, baseURL),
        transformRequestBody,
        ...(adapter.replayAssistantReasoningDetails
          ? { metadataExtractor: reasoningDetailsMetadataExtractor() }
          : {}),
      }).chatModel(modelId);
      return adapter.replayAssistantReasoningDetails ? attachReasoningDetails(model) : model;
    }
  }
}

function composeRequestTransforms(
  first: (body: Record<string, unknown>) => Record<string, unknown>,
  second: (body: Record<string, unknown>) => Record<string, unknown>,
) {
  return (body: Record<string, unknown>) => second(first(body));
}

function replayAssistantReasoning(field: 'reasoning', replayDetails: boolean) {
  return (body: Record<string, unknown>): Record<string, unknown> => {
    if (!Array.isArray(body.messages)) return body;
    let changed = false;
    const messages = body.messages.map((value) => {
      if (!isRecord(value)) return value;
      if (value.role !== 'assistant') {
        if (!replayDetails || !Array.isArray(value.reasoning_details)) return value;
        const { reasoning_details: _reasoningDetails, ...message } = value;
        changed = true;
        return message;
      }
      let message = value;
      if (typeof message.reasoning_content === 'string') {
        const { reasoning_content: reasoningContent, ...rest } = message;
        message = { ...rest, [field]: reasoningContent };
        changed = true;
      }
      if (!replayDetails || !Array.isArray(message.tool_calls)) return message;
      let reasoningDetails: unknown[] | undefined;
      const toolCalls = message.tool_calls.map((toolCall) => {
        if (!isRecord(toolCall) || !Array.isArray(toolCall.reasoning_details)) return toolCall;
        reasoningDetails ??= toolCall.reasoning_details;
        const { reasoning_details: _reasoningDetails, ...rest } = toolCall;
        changed = true;
        return rest;
      });
      return reasoningDetails
        ? { ...message, reasoning_details: reasoningDetails, tool_calls: toolCalls }
        : message;
    });
    return changed ? { ...body, messages } : body;
  };
}

function reasoningDetailsMetadataExtractor(): MetadataExtractor {
  return {
    async extractMetadata({ parsedBody }) {
      const details = reasoningDetailsFromBody(parsedBody);
      return details ? { zenmux: { reasoningDetails: details } } : undefined;
    },
    createStreamExtractor() {
      let details: JSONArray | undefined;
      return {
        processChunk(parsedChunk) {
          details = reasoningDetailsFromBody(parsedChunk) ?? details;
        },
        buildMetadata() {
          return details ? { zenmux: { reasoningDetails: details } } : undefined;
        },
      };
    },
  };
}

function reasoningDetailsFromBody(body: unknown): JSONArray | undefined {
  if (!isRecord(body) || !Array.isArray(body.choices)) return undefined;
  for (const choice of body.choices) {
    if (!isRecord(choice)) continue;
    for (const carrier of [choice.message, choice.delta]) {
      if (isRecord(carrier) && isJSONArray(carrier.reasoning_details)) {
        return carrier.reasoning_details;
      }
    }
  }
  return undefined;
}

function attachReasoningDetails(model: LanguageModelV4): LanguageModelV4 {
  return new Proxy(model, {
    get(target, property, receiver) {
      if (property === 'doGenerate') {
        return async (...args: Parameters<LanguageModelV4['doGenerate']>) => {
          const result = await target.doGenerate(...args);
          const details = reasoningDetailsFromMetadata(result.providerMetadata);
          return details
            ? { ...result, content: withReasoningDetails(result.content, details) }
            : result;
        };
      }
      if (property === 'doStream') {
        return async (...args: Parameters<LanguageModelV4['doStream']>) => {
          const result = await target.doStream(...args);
          let pendingToolCalls: Array<Extract<LanguageModelV4StreamPart, { type: 'tool-call' }>> =
            [];
          const stream = result.stream.pipeThrough(
            new TransformStream({
              transform(chunk, controller) {
                if (chunk.type === 'tool-call') {
                  pendingToolCalls.push(chunk);
                  return;
                }
                if (chunk.type === 'finish') {
                  const details = reasoningDetailsFromMetadata(chunk.providerMetadata);
                  for (const toolCall of pendingToolCalls) {
                    controller.enqueue(
                      details ? withReasoningDetails([toolCall], details)[0] : toolCall,
                    );
                  }
                  pendingToolCalls = [];
                }
                controller.enqueue(chunk);
              },
              flush(controller) {
                for (const toolCall of pendingToolCalls) controller.enqueue(toolCall);
              },
            }),
          );
          return { ...result, stream };
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function reasoningDetailsFromMetadata(
  metadata: SharedV4ProviderMetadata | undefined,
): JSONArray | undefined {
  const details = metadata?.zenmux?.reasoningDetails;
  return isJSONArray(details) ? details : undefined;
}

function withReasoningDetails<
  Content extends { type: string; providerMetadata?: SharedV4ProviderMetadata },
>(content: Content[], details: JSONArray): Content[] {
  return content.map((part) =>
    part.type === 'tool-call'
      ? {
          ...part,
          providerMetadata: {
            ...part.providerMetadata,
            openaiCompatible: {
              ...part.providerMetadata?.openaiCompatible,
              reasoning_details: details,
            },
          },
        }
      : part,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function modelFamilyId(modelId: string): string {
  return modelId.includes('/') ? modelId.slice(modelId.lastIndexOf('/') + 1) : modelId;
}

function claudeFamilyId(modelId: string): string {
  return modelFamilyId(modelId).replace(
    /^(claude-(?:haiku|opus|sonnet)-\d+)\.(\d+)(?=$|-)/,
    '$1-$2',
  );
}

function defaultOpenAiReasoningEffort(modelId: string): ThinkingLevel | undefined {
  const familyModelId = modelFamilyId(modelId);
  return thinkingOptionsForModel('openai', familyModelId)?.efforts?.includes('medium')
    ? 'medium'
    : undefined;
}

function openAiResponsesSummary(modelId: string, reasoningEffort: string | undefined) {
  return reasoningEffort !== 'none' && defaultOpenAiReasoningEffort(modelId) !== undefined
    ? { reasoningSummary: 'auto' as const }
    : {};
}

function visibleClaudeThinking(
  providerType: RuntimeExecutionConnection['providerType'],
  modelId: string,
  thinkingOptions: ThinkingOptions | undefined,
  effort: string | undefined,
) {
  const mode = claudeThinkingMode(providerType, modelId, thinkingOptions);
  if (!mode) return undefined;

  const thinking =
    mode === 'adaptive'
      ? { type: 'adaptive' as const, display: 'summarized' as const }
      : { type: 'enabled' as const, budgetTokens: 1_024 };
  return {
    thinking,
    ...(effort ? { effort } : {}),
  };
}

function claudeThinkingMode(
  providerType: RuntimeExecutionConnection['providerType'],
  modelId: string,
  thinkingOptions: ThinkingOptions | undefined,
): 'adaptive' | 'legacy' | undefined {
  const familyModelId = claudeFamilyId(modelId);
  if (!familyModelId.startsWith('claude-')) return undefined;

  const providerMetadata = lookupModelMetadata(providerType, modelId);
  const anthropicMetadata = lookupModelMetadata('anthropic', familyModelId);
  const isKnownBareLegacyClaude4 = /^claude-(?:opus|sonnet)-4$/.test(familyModelId);
  const effectiveOptions =
    thinkingOptions ??
    providerMetadata.thinkingOptions ??
    anthropicMetadata.thinkingOptions ??
    thinkingOptionsForModel('anthropic', familyModelId);
  const supportsThinking =
    effectiveOptions?.toggle === true ||
    (effectiveOptions?.efforts?.length ?? 0) > 0 ||
    providerMetadata.capabilities?.reasoning === true ||
    anthropicMetadata.capabilities?.reasoning === true ||
    isKnownBareLegacyClaude4;
  if (!supportsThinking) return undefined;

  // The SDK's capability table only recognizes dated Claude 4 aliases. The
  // active bare aliases are the same legacy budget-thinking families.
  if (isKnownBareLegacyClaude4) return 'legacy';

  return getAnthropicModelCapabilities(familyModelId).supportsAdaptiveThinking
    ? 'adaptive'
    : 'legacy';
}

export function buildProviderOptions(
  connection: RuntimeExecutionConnection,
  modelId: string,
  thinkingLevel?: ThinkingLevel,
): SharedV4ProviderOptions {
  return withParallelToolCallOptions(
    connection,
    modelId,
    buildThinkingProviderOptions(connection, modelId, thinkingLevel),
  );
}

function buildThinkingProviderOptions(
  connection: RuntimeExecutionConnection,
  modelId: string,
  thinkingLevel?: ThinkingLevel,
): SharedV4ProviderOptions {
  const thinkingOptions = thinkingOptionsForModel(connection.providerType, modelId);
  const level = resolveThinkingLevel(connection, modelId, thinkingLevel);
  switch (connection.providerType) {
    case 'kimi-coding-plan': {
      // Kimi's coding route has no off wire. Check the raw argument, not the
      // normalized level: the entry gate above drops unsupported levels to
      // undefined (default max), but an explicit off must be rejected, never
      // silently upgraded to max. Today off cannot reach this branch through
      // the UI (variants exclude it), but a direct runtime caller or a future
      // models.dev `none` declaration must fail loudly, and the wire-contract
      // sweep keeps that tripwire armed.
      if (thinkingLevel === 'off') return {};
      const effort = level ?? 'max';
      if (connection.models?.find((model) => model.id === modelId)?.apiProtocol === 'openai-chat') {
        // The kimiCodingPlan provider-options namespace is the
        // openai-compatible adapter name; ai-sdk resolves its camelCase
        // alias to the kimi-coding-plan schema key (reasoning_effort).
        return {
          kimiCodingPlan: { reasoningEffort: effort },
        };
      }
      return {
        anthropic:
          modelId === 'k3' || modelId === 'k3-256k'
            ? {
                // K3 (and its 256k-context variant) supports adaptive thinking
                // only; effort defaults to max when unset.
                thinking: { type: 'adaptive' as const },
                effort,
              }
            : modelId === 'kimi-for-coding'
              ? {
                  // Kimi's managed coding route requires enabled thinking; the
                  // Anthropic AI SDK also requires a compatibility budget and
                  // otherwise injects the same value with a warning.
                  thinking: { type: 'enabled' as const, budgetTokens: 1_024 },
                  effort,
                }
              : {
                  // kimi-for-coding-highspeed has no declared effort and no
                  // known thinking requirements; send nothing rather than
                  // inventing a wire (mirrors main's prior behavior).
                },
      };
    }
    // Anthropic-protocol: effort enum models send `effort`; toggle/budget
    // models send `thinking.disabled` for off. No budget-token mapping — the
    // provider's native effort values pass through unchanged.
    case 'anthropic':
    case 'MiniMax':
    case 'MiniMax-cn': {
      let reasoning = {};
      const summarizedThinking =
        connection.providerType === 'anthropic' &&
        (thinkingLevel === undefined || level !== undefined)
          ? visibleClaudeThinking(connection.providerType, modelId, thinkingOptions, level)
          : undefined;
      if (level === 'off' && thinkingOptions?.offBehavior === 'anthropic-thinking-disabled') {
        reasoning = { thinking: { type: 'disabled' as const } };
      } else if (summarizedThinking) {
        reasoning = summarizedThinking;
      } else if (level && level !== 'off') {
        reasoning = { effort: level };
      }
      return {
        anthropic: {
          ...(connection.providerType === 'anthropic'
            ? { cacheControl: { type: 'ephemeral' as const } }
            : {}),
          ...reasoning,
        },
      };
    }
    case 'openai-codex': {
      const reasoningEffort =
        level === 'off'
          ? 'none'
          : (level ??
            (thinkingLevel === undefined ? defaultOpenAiReasoningEffort(modelId) : undefined));
      return {
        openai: {
          store: false,
          textVerbosity: 'medium',
          ...openAiResponsesSummary(modelId, reasoningEffort),
          ...(reasoningEffort ? { reasoningEffort } : {}),
        },
      };
    }
    case 'openai': {
      const usesResponses = resolveModelRuntime(connection, modelId).wire === 'openai-responses';
      const reasoningEffort =
        level === 'off'
          ? 'none'
          : (level ??
            (thinkingLevel === undefined ? defaultOpenAiReasoningEffort(modelId) : undefined));
      return {
        openai: {
          store: false,
          ...(usesResponses ? openAiResponsesSummary(modelId, reasoningEffort) : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
        },
      };
    }
    case 'volcengine-agent-plan':
      return {
        openai: {
          store: false,
          forceReasoning: true,
        },
      };
    case 'xai':
    case 'xai-oauth':
      // Only grok-4.5 needs the Responses reasoning extras; every other xAI
      // model serves the plain OpenAI-compatible chat wire handled below.
      if (modelId === 'grok-4.5') {
        return {
          openai: {
            store: false,
            forceReasoning: true,
            reasoningSummary: null,
            include: ['reasoning.encrypted_content'],
            ...(level ? { reasoningEffort: level } : {}),
          },
        };
      }
      return buildFamilyWire(connection, modelId, level, thinkingOptions, thinkingLevel);
    case 'volcengine-ark':
      return {
        [toCamelCase(connection.providerType)]: {
          thinking: { type: level === 'off' ? 'disabled' : 'enabled' },
          ...(level && level !== 'off' ? { reasoningEffort: level } : {}),
        },
      };
    case 'google':
      return {
        google: {
          safetySettings: [
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          ],
          // Google effort models use thinkingLevel; Gemini 2.5 Flash disables
          // thinking via the budget-zero wire. Omitting thinkingConfig means
          // provider default, not "off".
          ...(level === 'off' && thinkingOptions?.offBehavior === 'google-thinking-budget-zero'
            ? { thinkingConfig: { thinkingBudget: 0 } }
            : level && level !== 'off'
              ? { thinkingConfig: { includeThoughts: true, thinkingLevel: level } }
              : {}),
        },
      };
    case 'cloudflare-workers-ai':
      return level
        ? {
            [toCamelCase(connection.providerType)]:
              level === 'off'
                ? thinkingOptions?.offBehavior === 'cloudflare-chat-template-thinking-false'
                  ? { chat_template_kwargs: { thinking: false } }
                  : {}
                : { reasoningEffort: level },
          }
        : {};
    // Every remaining path resolves to one of a handful of wire families.
    // Keying the fallback on the resolved adapter — the same object
    // `getAIModel` switches on, including per-model models.dev package
    // overrides — keeps declaration and wire in one seam. The variant gate
    // above (level is defined only when metadata declares it) is what makes
    // this safe to generalize: undeclared models never reach the wire.
    default:
      return buildFamilyWire(connection, modelId, level, thinkingOptions, thinkingLevel);
  }
}

function withParallelToolCallOptions(
  connection: RuntimeExecutionConnection,
  modelId: string,
  options: SharedV4ProviderOptions,
): SharedV4ProviderOptions {
  const runtime = resolveModelRuntime(connection, modelId);
  if (runtime.parallelToolCalls === undefined) return options;

  let providerKey: string;
  let optionKey: 'parallelToolCalls' | 'parallel_tool_calls';
  if (runtime.adapter.kind === 'openai' || runtime.adapter.kind === 'openai-codex') {
    providerKey = 'openai';
    optionKey = 'parallelToolCalls';
  } else if (runtime.adapter.kind === 'github-copilot') {
    if (runtime.wire === 'anthropic-messages') return options;
    providerKey = runtime.wire === 'openai-responses' ? 'openai' : 'githubCopilot';
    optionKey = runtime.wire === 'openai-responses' ? 'parallelToolCalls' : 'parallel_tool_calls';
  } else if (runtime.adapter.kind === 'openai-compatible') {
    if (runtime.wire === 'openai-responses') {
      if (
        runtime.reasoningReplay.kind !== 'responses' ||
        runtime.reasoningReplay.contract.adapter !== 'openai'
      ) {
        return options;
      }
      providerKey = 'openai';
      optionKey = 'parallelToolCalls';
    } else {
      providerKey = openAiCompatibleProviderOptionsKey(runtime.adapter, connection);
      optionKey = 'parallel_tool_calls';
    }
  } else {
    return options;
  }

  const current = options[providerKey];
  return {
    ...options,
    [providerKey]: {
      ...(isRecord(current) ? current : {}),
      [optionKey]: runtime.parallelToolCalls,
    },
  };
}

function buildFamilyWire(
  connection: RuntimeExecutionConnection,
  modelId: string,
  level: ThinkingLevel | undefined,
  thinkingOptions: ThinkingOptions | undefined,
  requestedLevel: ThinkingLevel | undefined,
): SharedV4ProviderOptions {
  const { adapter, wire, reasoningReplay } = resolveModelRuntime(connection, modelId);
  const explicitReasoningEffort = level ? (level === 'off' ? 'none' : level) : undefined;
  const serviceTier =
    wire === 'openai-responses' &&
    reasoningReplay.kind === 'responses' &&
    reasoningReplay.contract.adapter === 'openai' &&
    supportsRelayFastServiceTier(connection.providerType, modelId)
      ? connection.relayModelProfiles?.[modelId]?.serviceTier
      : undefined;
  // Provider selection and reasoning continuation are independent. The OpenAI
  // provider reads its provider-options namespace; the Open Responses provider
  // consumes a provider-native reasoningEffort through the same namespace,
  // keyed by the provider name getAIModel passes to createOpenResponses.
  if (wire === 'openai-responses') {
    if (reasoningReplay.kind !== 'responses') {
      throw new Error('Responses wire requires a Responses continuation contract');
    }
    // Connection-aware: a relay model's declared variants count too.
    const reasons = thinkingVariantsForConnection(connection, modelId).length > 0;
    if (reasoningReplay.contract.adapter === 'open-responses') {
      // @ai-sdk/open-responses@2.0.34 passes a provider-native reasoningEffort
      // through verbatim, ahead of the cross-provider top-level `reasoning`
      // enum that cannot express DeepSeek's `max` (whose documented mapping
      // sends `xhigh` to high, not max). The SDK resolves providerOptions
      // under the raw provider `name` — no camelCase alias, unlike
      // openai-compatible — so key by the same name getAIModel passes.
      return explicitReasoningEffort || serviceTier
        ? {
            [runtimeProviderName(adapter, connection)]: {
              ...(explicitReasoningEffort ? { reasoningEffort: explicitReasoningEffort } : {}),
              ...(serviceTier ? { serviceTier } : {}),
            },
          }
        : {};
    }
    const reasoningEffort =
      explicitReasoningEffort ??
      (requestedLevel === undefined ? defaultOpenAiReasoningEffort(modelId) : undefined);
    return {
      openai: {
        store: false,
        ...(reasons || reasoningReplay.contract.reasoningReplay === 'encrypted-content'
          ? { forceReasoning: true }
          : {}),
        ...openAiResponsesSummary(modelId, reasoningEffort),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(serviceTier ? { serviceTier } : {}),
      },
    };
  }
  if (wire === 'anthropic-messages' && (requestedLevel === undefined || level !== undefined)) {
    const reasoning = visibleClaudeThinking(
      connection.providerType,
      modelId,
      thinkingOptions,
      explicitReasoningEffort,
    );
    if (reasoning) return { anthropic: reasoning };
  }
  if (wire === 'openai-chat' && adapter.kind === 'openai-compatible') {
    const reasoningEffort =
      explicitReasoningEffort ??
      (requestedLevel === undefined ? defaultOpenAiReasoningEffort(modelId) : undefined);
    if (reasoningEffort) {
      return {
        [openAiCompatibleProviderOptionsKey(adapter, connection)]: { reasoningEffort },
      };
    }
  }
  if (!explicitReasoningEffort && !serviceTier) return {};
  switch (adapter.kind) {
    case 'openai-compatible':
      return {
        [openAiCompatibleProviderOptionsKey(adapter, connection)]: {
          ...(explicitReasoningEffort ? { reasoningEffort: explicitReasoningEffort } : {}),
        },
      };
    case 'openai':
      return {
        openai: {
          ...(explicitReasoningEffort ? { reasoningEffort: explicitReasoningEffort } : {}),
        },
      };
    case 'anthropic':
      // Anthropic-protocol models declare no `none` effort, so an off
      // choice only exists where an explicit case wires it.
      return level !== 'off' ? { anthropic: { effort: level } } : {};
    case 'google':
      return level !== 'off'
        ? { google: { thinkingConfig: { includeThoughts: true, thinkingLevel: level } } }
        : {};
    case 'cohere':
      return {
        cohere:
          level === 'off' && thinkingOptions?.offBehavior === 'cohere-thinking-disabled'
            ? { thinking: { type: 'disabled' as const } }
            : {},
      };
    case 'github-copilot': {
      // Copilot routes per account-declared model protocol (mirrors the
      // getAIModel case), defaulting to its OpenAI-compatible chat wire. Its
      // Responses protocol is answered by the wire branch above.
      const copilotProtocol = connection.models?.find((model) => model.id === modelId)?.apiProtocol;
      if (copilotProtocol === 'anthropic-messages') {
        return level !== 'off' ? { anthropic: { effort: level } } : {};
      }
      return { githubCopilot: { reasoningEffort: explicitReasoningEffort } };
    }
    default:
      return {};
  }
}

// Mirrors @ai-sdk/openai-compatible's own toCamelCase derivation, so the
// key we emit always matches the alias the SDK resolves.
function toCamelCase(name: string): string {
  return name.replace(/[_-]([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/**
 * The providerOptions key for an openai-compatible model: the camelCase
 * alias of the identity passed to `createOpenAICompatible`. The SDK
 * resolves both spellings — known options and passthrough fields alike —
 * but flags dashed keys as deprecated (a `type: 'deprecated'` warning on
 * every doGenerate result), so the camelCase alias is the canonical key.
 *
 * The same alias also selects the SDK's *response* metadata namespace:
 * once options are keyed `zaiCodingPlan`, provider metadata comes back as
 * `providerMetadata.zaiCodingPlan`, not `providerMetadata['zai-coding-plan']`.
 * A metadata reader keyed by the raw `connection.providerType` would
 * silently read nothing for dashed providers.
 */
function openAiCompatibleProviderOptionsKey(
  adapter: RuntimeProviderAdapter,
  connection: RuntimeExecutionConnection,
): string {
  return toCamelCase(runtimeProviderName(adapter, connection));
}
