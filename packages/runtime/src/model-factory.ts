import { createAnthropic } from '@ai-sdk/anthropic';
import { createCohere } from '@ai-sdk/cohere';
import { createGoogle } from '@ai-sdk/google';
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
import { type LlmConnection, type ProviderType } from '@maka/core/llm-connections';
import { openAiAdapterApiProtocol } from '@maka/core/model-metadata';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import { thinkingOptionsForModel, thinkingVariantsForModel } from '@maka/core/model-thinking';
import {
  createKimiOpenAiTransport,
  type KimiOpenAiTransportState,
} from './kimi-openai-transport.js';
import { anthropicV1BaseUrl, googleV1BetaBaseUrl } from './provider-urls.js';
import { resolveModelRuntime } from './model-runtime.js';
import { claudeSubscriptionHeaders, openAiCodexHeaders } from './subscription-auth.js';

export interface ModelFactoryInput {
  connection: LlmConnection;
  apiKey: string;
  modelId: string;
  fetch?: typeof globalThis.fetch;
  kimiOpenAiTransportState?: KimiOpenAiTransportState;
}

const ANTHROPIC_BETA = 'interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14';
export function getAIModel(input: ModelFactoryInput): LanguageModelV4 {
  const { connection, apiKey, modelId, fetch, kimiOpenAiTransportState } = input;
  const { adapter, baseUrl: baseURL, apiProtocol } = resolveModelRuntime(connection, modelId);

  if (adapter.kind === 'google' && adapter.normalizeBaseUrl === false) {
    return createGoogle({ apiKey, baseURL, fetch }).chat(modelId);
  }

  switch (adapter.kind) {
    case 'anthropic':
      return createAnthropic({
        ...(adapter.auth === 'bearer' ? { authToken: apiKey } : { apiKey }),
        baseURL: adapter.normalizeBaseUrl ? anthropicV1BaseUrl(baseURL) : baseURL,
        fetch,
        headers: { 'anthropic-beta': ANTHROPIC_BETA },
      }).chat(modelId);

    case 'claude-subscription':
      return createAnthropic({
        authToken: apiKey,
        baseURL: anthropicV1BaseUrl(baseURL),
        fetch,
        headers: claudeSubscriptionHeaders(),
      }).chat(modelId);

    case 'openai-codex':
      return createOpenAI({
        apiKey,
        baseURL,
        fetch,
        headers: openAiCodexHeaders(apiKey),
      }).responses(modelId);

    case 'github-copilot': {
      if (apiProtocol === 'openai-responses') {
        return createOpenAI({ apiKey, baseURL, fetch }).responses(modelId);
      }
      if (apiProtocol === 'anthropic-messages') {
        return createAnthropic({
          authToken: apiKey,
          baseURL: anthropicV1BaseUrl(baseURL),
          fetch,
        }).chat(modelId);
      }
      return createOpenAICompatible({
        name: 'github-copilot',
        apiKey,
        baseURL,
        fetch,
      }).chatModel(modelId);
    }

    case 'unavailable':
      throw new Error(`${connection.providerType} is experimental and not wired yet`);

    case 'openai': {
      const openai = createOpenAI({ apiKey, baseURL, fetch });
      // Routing is declaration-driven via the ModelInfo.apiProtocol seam: an
      // account-declared protocol wins (mirrors the github-copilot case above);
      // otherwise the model's declared OpenAI-adapter protocol decides. gpt-5*
      // families are Responses-only; everything else uses Chat Completions.
      const apiProtocol =
        adapter.apiProtocol ??
        connection.models?.find((model) => model.id === modelId)?.apiProtocol ??
        openAiAdapterApiProtocol(modelId, connection.providerType);
      return apiProtocol === 'openai-responses' ? openai.responses(modelId) : openai.chat(modelId);
    }

    case 'google':
      return createGoogle({
        apiKey,
        baseURL: googleV1BetaBaseUrl(baseURL),
        fetch,
      }).chat(modelId);

    case 'cohere':
      return createCohere({ apiKey, baseURL, fetch })(modelId);

    case 'openai-compatible': {
      if (adapter.requireBaseUrl && !baseURL) {
        throw new Error(
          `${connection.providerType} connection ${connection.slug} requires a base URL`,
        );
      }
      const resolvedApiProtocol =
        apiProtocol ?? openAiAdapterApiProtocol(modelId, connection.providerType);
      if (adapter.supportsOpenAiResponses === true && resolvedApiProtocol === 'openai-responses') {
        return createOpenAI({ apiKey, baseURL, fetch }).responses(modelId);
      }
      const name = adapter.name === 'connection' ? connection.slug : connection.providerType;
      const kimiTransport =
        connection.providerType === 'kimi-coding-plan' && apiProtocol === 'openai-chat'
          ? createKimiOpenAiTransport(fetch ?? globalThis.fetch, kimiOpenAiTransportState)
          : undefined;
      const model = createOpenAICompatible({
        name,
        apiKey,
        baseURL,
        includeUsage: adapter.includeUsage,
        ...(kimiTransport
          ? { fetch: kimiTransport.fetch }
          : adapter.passFetch || fetch
            ? { fetch }
            : {}),
        ...(kimiTransport
          ? { transformRequestBody: kimiTransport.transformRequestBody }
          : adapter.replayAssistantReasoningAs
            ? {
                transformRequestBody: replayAssistantReasoning(
                  adapter.replayAssistantReasoningAs,
                  adapter.replayAssistantReasoningDetails === true,
                ),
              }
            : {}),
        ...(adapter.replayAssistantReasoningDetails
          ? { metadataExtractor: reasoningDetailsMetadataExtractor() }
          : {}),
      }).chatModel(modelId);
      return adapter.replayAssistantReasoningDetails ? attachReasoningDetails(model) : model;
    }
  }
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

export function buildProviderOptions(
  connection: LlmConnection,
  modelId: string,
  thinkingLevel?: ThinkingLevel,
): SharedV4ProviderOptions {
  const thinkingOptions = thinkingOptionsForModel(connection.providerType, modelId);
  const variants = thinkingVariantsForModel(connection.providerType, modelId);
  const level = thinkingLevel && variants.includes(thinkingLevel) ? thinkingLevel : undefined;
  switch (connection.providerType) {
    case 'kimi-coding-plan':
      if (connection.models?.find((model) => model.id === modelId)?.apiProtocol === 'openai-chat') {
        return {
          kimiCodingPlan: { reasoningEffort: 'max' },
        };
      }
      return {
        anthropic:
          modelId === 'k3'
            ? {
                // K3 supports adaptive thinking only and currently fixes effort
                // at max on Kimi Coding Plan.
                thinking: { type: 'adaptive' as const },
                effort: 'max',
              }
            : modelId === 'kimi-for-coding'
              ? {
                  // Kimi's managed coding route requires enabled thinking and max
                  // effort. The Anthropic AI SDK also requires a compatibility
                  // budget and otherwise injects the same value with a warning.
                  thinking: { type: 'enabled' as const, budgetTokens: 1_024 },
                  effort: 'max',
                }
              : {},
      };
    // Anthropic-protocol: effort enum models send `effort`; toggle/budget
    // models send `thinking.disabled` for off. No budget-token mapping — the
    // provider's native effort values pass through unchanged.
    case 'anthropic':
    case 'MiniMax':
    case 'MiniMax-cn':
    case 'claude-subscription': {
      let reasoning = {};
      if (level === 'off' && thinkingOptions?.offBehavior === 'anthropic-thinking-disabled') {
        reasoning = { thinking: { type: 'disabled' as const } };
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
    case 'openai-codex':
      return {
        openai: {
          store: false,
          textVerbosity: 'medium',
          ...(level ? { reasoningEffort: level === 'off' ? 'none' : level } : {}),
        },
      };
    case 'openai':
      return {
        openai: {
          store: false,
          ...(level ? { reasoningEffort: level === 'off' ? 'none' : level } : {}),
        },
      };
    case 'xai':
    case 'xai-oauth':
      return modelId === 'grok-4.5'
        ? {
            openai: {
              store: false,
              forceReasoning: true,
              reasoningSummary: null,
              include: ['reasoning.encrypted_content'],
              ...(level ? { reasoningEffort: level } : {}),
            },
          }
        : {};
    case 'cohere':
      return {
        cohere:
          level === 'off' && thinkingOptions?.offBehavior === 'cohere-thinking-disabled'
            ? { thinking: { type: 'disabled' as const } }
            : {},
      };
    case 'volcengine-ark':
      return {
        [openaiCompatibleNamespace(connection.providerType)]: {
          thinking: { type: level === 'off' ? 'disabled' : 'enabled' },
          ...(level && level !== 'off' ? { reasoningEffort: level } : {}),
        },
      };
    case 'vercel':
    case 'ollama-cloud':
      return level
        ? {
            [openaiCompatibleNamespace(connection.providerType)]: {
              reasoningEffort: level === 'off' ? 'none' : level,
            },
          }
        : {};
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
            [openaiCompatibleNamespace(connection.providerType)]:
              level === 'off'
                ? thinkingOptions?.offBehavior === 'cloudflare-chat-template-thinking-false'
                  ? { chat_template_kwargs: { thinking: false } }
                  : {}
                : { reasoningEffort: level },
          }
        : {};
    // DeepInfra and OpenRouter document `none` as their real off wire. Other
    // compatible providers below expose only their confirmed non-off effort values.
    case 'deepinfra':
    case 'openrouter':
      return level
        ? {
            [openaiCompatibleNamespace(connection.providerType)]: {
              reasoningEffort: level === 'off' ? 'none' : level,
            },
          }
        : {};
    // Groq accepts `reasoning_effort` for gpt-oss-120b / gpt-oss-20b only, with
    // low/medium/high (no `none`). Per-model thinkingOptions constrain which
    // levels reach this case, so Groq only ever receives a non-off effort here
    // and shares the non-off branch below.
    case 'groq':
    case 'deepseek':
    case 'moonshot':
    case 'tencent-token-plan':
    case 'zai-coding-plan':
    case 'stepfun-step-plan':
    case 'stepfun-ai-step-plan':
      return level && level !== 'off'
        ? { [openaiCompatibleNamespace(connection.providerType)]: { reasoningEffort: level } }
        : {};
    default:
      return {};
  }
}

/** providerOptions namespace matches the `name` passed to `createOpenAICompatible` in `getAIModel`. */
function openaiCompatibleNamespace(providerType: ProviderType): string {
  switch (providerType) {
    case 'deepseek':
      return 'deepseek';
    case 'moonshot':
      return 'moonshot';
    case 'zai-coding-plan':
      return 'zai-coding-plan';
    case 'ollama':
      return 'ollama';
    default:
      return providerType;
  }
}
