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
import { type RuntimeExecutionConnection } from '@maka/core/llm-connections';
import type { ProviderRuntimeAdapter } from '@maka/core/llm-connections';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import {
  thinkingOptionsForModel,
  thinkingVariantsForModel,
  type ThinkingOptions,
} from '@maka/core/model-thinking';
import {
  createOpenAiChatReasoningTransport,
  createOpenAiChatReasoningTransportState,
  type OpenAiChatReasoningTransportState,
} from './openai-chat-reasoning-transport.js';
import type { OpenAiResponsesTransportState } from './openai-responses-websocket.js';
import { anthropicV1BaseUrl, googleV1BetaBaseUrl } from './provider-urls.js';
import { resolveModelRuntime, type ResolvedModelRuntime } from './model-runtime.js';
import { claudeSubscriptionHeaders, openAiCodexHeaders } from './subscription-auth.js';

export interface ModelFactoryInput {
  connection: RuntimeExecutionConnection;
  apiKey: string;
  modelId: string;
  fetch?: typeof globalThis.fetch;
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
    resolvedRuntime,
    openAiChatReasoningTransportState,
    openAiResponsesTransportState,
  } = input;
  const runtime = resolvedRuntime ?? resolveModelRuntime(connection, modelId);
  const { adapter, baseUrl: baseURL, wire, reasoningReplay } = runtime;

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
        fetch: openAiResponsesTransportState?.wrapFetch(fetch ?? globalThis.fetch) ?? fetch,
        headers: openAiCodexHeaders(apiKey),
      }).responses(modelId);

    case 'github-copilot': {
      if (wire === 'openai-responses') {
        return createOpenAI({ apiKey, baseURL, fetch }).responses(modelId);
      }
      if (wire === 'anthropic-messages') {
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
      const openai = createOpenAI({
        apiKey,
        baseURL,
        fetch: openAiResponsesTransportState?.wrapFetch(fetch ?? globalThis.fetch) ?? fetch,
      });
      return wire === 'openai-responses' ? openai.responses(modelId) : openai.chat(modelId);
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
      if (wire === 'openai-responses') {
        return createOpenAI({ apiKey, baseURL, fetch }).responses(modelId);
      }
      if (reasoningReplay.kind !== 'openai-chat-plaintext') {
        throw new Error('OpenAI-compatible Chat wire requires plaintext reasoning replay');
      }
      const reasoningTransport = createOpenAiChatReasoningTransport(
        fetch ?? globalThis.fetch,
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
        name: openAiCompatibleProviderOptionsName(adapter, connection),
        apiKey,
        baseURL,
        includeUsage: adapter.includeUsage,
        fetch: reasoningTransport.fetch,
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

export function buildProviderOptions(
  connection: RuntimeExecutionConnection,
  modelId: string,
  thinkingLevel?: ThinkingLevel,
): SharedV4ProviderOptions {
  const thinkingOptions = thinkingOptionsForModel(connection.providerType, modelId);
  const variants = thinkingVariantsForModel(connection.providerType, modelId);
  const level = thinkingLevel && variants.includes(thinkingLevel) ? thinkingLevel : undefined;
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
      return buildFamilyWire(connection, modelId, level, thinkingOptions);
    case 'volcengine-ark':
      return {
        [connection.providerType]: {
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
            [connection.providerType]:
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
      return buildFamilyWire(connection, modelId, level, thinkingOptions);
  }
}

function buildFamilyWire(
  connection: RuntimeExecutionConnection,
  modelId: string,
  level: ThinkingLevel | undefined,
  thinkingOptions: ThinkingOptions | undefined,
): SharedV4ProviderOptions {
  if (!level) return {};
  const { adapter } = resolveModelRuntime(connection, modelId);
  const reasoningEffort = level === 'off' ? 'none' : level;
  switch (adapter.kind) {
    case 'openai-compatible':
      return {
        [openAiCompatibleProviderOptionsName(adapter, connection)]: { reasoningEffort },
      };
    case 'openai':
      return { openai: { reasoningEffort } };
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
      // getAIModel case), defaulting to its OpenAI-compatible chat wire.
      const copilotProtocol = connection.models?.find((model) => model.id === modelId)?.apiProtocol;
      if (copilotProtocol === 'anthropic-messages') {
        return level !== 'off' ? { anthropic: { effort: level } } : {};
      }
      if (copilotProtocol === 'openai-responses') {
        return { openai: { reasoningEffort } };
      }
      return { 'github-copilot': { reasoningEffort } };
    }
    default:
      return {};
  }
}

/**
 * providerOptions namespace matches the `name` passed to `createOpenAICompatible`
 * in `getAIModel`; both derive it from this one rule so the two can never drift.
 */
function openAiCompatibleProviderOptionsName(
  adapter: ProviderRuntimeAdapter,
  connection: RuntimeExecutionConnection,
): string {
  return adapter.kind === 'openai-compatible' && adapter.name === 'connection'
    ? connection.slug
    : connection.providerType;
}
