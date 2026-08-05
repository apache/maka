import type { ModelInfo, ProviderType } from './llm-connections.js';

export type HostedWebSearchAdapter =
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-grounding'
  | 'zai-web-search'
  | 'mistral-agents'
  | 'groq-compound'
  | 'openrouter-web-plugin';

export interface HostedWebSearchCapability {
  readonly adapter: HostedWebSearchAdapter;
  /** Whether Maka currently has an executor for this provider wire. */
  readonly implemented: boolean;
}

/**
 * Resolves provider-hosted search for one exact model.
 *
 * Stored model metadata can explicitly deny search, or grant it when the
 * selected request wire can carry the provider tool. Unknown models use
 * narrow provider rules backed by the provider's public API contract. Unknown
 * never means supported: sending an unsupported built-in tool can be silently
 * ignored by several OpenAI-compatible providers.
 *
 * The connection provider/wire is authoritative when a service supports both
 * Responses and Anthropic Messages. Search never switches wire independently
 * from the primary model request.
 */
export function resolveHostedWebSearchCapability(
  providerType: ProviderType,
  models: readonly ModelInfo[] | undefined,
  modelId: string,
): HostedWebSearchCapability | null {
  const id = modelId.trim();
  if (!id) return null;
  const stored = models?.find((model) => model.id === id);
  if (stored?.capabilities?.webSearch === false) return null;

  const adapter = providerHostedWebSearchAdapter(providerType);
  if (!adapter) return null;
  if (
    stored?.apiProtocol !== undefined &&
    ((adapter.adapter === 'openai-responses' && stored.apiProtocol !== 'openai-responses') ||
      (adapter.adapter === 'anthropic-messages' && stored.apiProtocol !== 'anthropic-messages'))
  ) {
    return null;
  }
  if (stored?.capabilities?.webSearch === true) {
    // A capability declaration does not select a request protocol. These
    // providers expose both Chat Completions and Responses, so an omitted
    // apiProtocol must still follow the same narrow model-family default as
    // the model factory. Otherwise metadata such as `webSearch: true` on a
    // Chat model would make Runtime compile a Responses-only provider tool for
    // the wrong wire.
    if (
      stored.apiProtocol === undefined &&
      adapter.adapter === 'openai-responses' &&
      providerSelectsOpenAiWireByModel(providerType)
    ) {
      return providerDefaultHostedWebSearchCapability(providerType, id, adapter);
    }
    return adapter;
  }
  return providerDefaultHostedWebSearchCapability(providerType, id, adapter);
}

function providerSelectsOpenAiWireByModel(providerType: ProviderType): boolean {
  return (
    providerType === 'deepseek' ||
    providerType === 'openai' ||
    providerType === 'xai' ||
    providerType === 'xai-oauth'
  );
}

function providerHostedWebSearchAdapter(
  providerType: ProviderType,
): HostedWebSearchCapability | null {
  switch (providerType) {
    case 'deepseek':
    case 'openai':
    case 'openai-responses-compatible':
    case 'xai':
    case 'xai-oauth':
      return { adapter: 'openai-responses', implemented: true };
    case 'alibaba':
      return { adapter: 'openai-responses', implemented: false };
    case 'anthropic':
    case 'claude-subscription':
    case 'MiniMax':
    case 'MiniMax-cn':
    case 'minimax-coding-plan':
    case 'anthropic-compatible':
      return { adapter: 'anthropic-messages', implemented: true };
    case 'google':
    case 'gemini-cli':
      return { adapter: 'google-grounding', implemented: false };
    case 'zai':
    case 'zai-coding-plan':
      return { adapter: 'zai-web-search', implemented: false };
    case 'mistral':
      return { adapter: 'mistral-agents', implemented: false };
    case 'groq':
      return { adapter: 'groq-compound', implemented: false };
    case 'openrouter':
      return { adapter: 'openrouter-web-plugin', implemented: false };
    default:
      return null;
  }
}

function providerDefaultHostedWebSearchCapability(
  providerType: ProviderType,
  modelId: string,
  capability: HostedWebSearchCapability,
): HostedWebSearchCapability | null {
  switch (providerType) {
    case 'deepseek':
      return modelId === 'deepseek-v4-flash' ? capability : null;
    case 'openai':
      return /^gpt-5(?:[.-]|$)/i.test(modelId) ? capability : null;
    case 'xai':
    case 'xai-oauth':
      return modelId === 'grok-4.5' ? capability : null;
    case 'alibaba':
      return /^qwen3\.5-(?:plus|flash)(?:[.-]|$)/i.test(modelId) ? capability : null;
    case 'anthropic':
    case 'claude-subscription':
      return /^claude-(?:[\d.]+-)*(?:opus|sonnet|haiku|fable)\b/i.test(modelId) ? capability : null;
    case 'MiniMax':
    case 'MiniMax-cn':
    case 'minimax-coding-plan':
      return /^MiniMax-M(?:2\.7|3)(?:[.-]|$)/i.test(modelId) ? capability : null;
    case 'anthropic-compatible':
      return modelId === 'deepseek-v4-flash' ? capability : null;
    case 'openai-responses-compatible':
      return null;
    case 'google':
    case 'gemini-cli':
      return /^gemini-(?:2\.0|2\.5|3|3\.1|3\.5)(?:[.-]|$)/i.test(modelId) ? capability : null;
    case 'zai':
    case 'zai-coding-plan':
      return /^glm-(?:4\.5|4\.6|4\.7|5)(?:[.-]|$)/i.test(modelId) ? capability : null;
    case 'mistral':
      return capability;
    case 'groq':
      return /^groq\/compound(?:-mini)?$/i.test(modelId) ? capability : null;
    case 'openrouter':
      return capability;
    default:
      return null;
  }
}
