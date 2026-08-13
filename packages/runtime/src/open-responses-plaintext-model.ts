import { createOpenResponses } from '@ai-sdk/open-responses';
import {
  isJSONValue,
  type JSONObject,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4Message,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  SharedV4ProviderOptions,
} from '@ai-sdk/provider';
import { responseWithBody } from './http-response.js';

const OPENAI_CUSTOM_TOOL_ID = 'openai.custom';
const OPENAI_WEB_SEARCH_TOOL_ID = 'openai.web_search';
const APPLY_PATCH_TOOL_NAME = 'apply_patch';
const WEB_SEARCH_TOOL_NAME = 'WebSearch';
const APPLY_PATCH_SENTINEL_NAME = 'maka_open_responses_apply_patch';
const WEB_SEARCH_SENTINEL_NAME = 'maka_open_responses_web_search';
const REASONING_EFFORT_HEADER = 'x-maka-open-responses-reasoning-effort';

export interface PlaintextOpenResponsesModelOptions {
  readonly providerName: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly fetch: typeof globalThis.fetch;
}

/**
 * Serve the standard plaintext Open Responses dialect behind one model seam.
 *
 * The upstream provider owns the standard request/response codec, including
 * plaintext reasoning replay. This adapter keeps Maka's one measured extension
 * local: DeepSeek V4's freeform ApplyPatch tool uses OpenAI custom-tool items,
 * which @ai-sdk/open-responses does not yet expose. Internally presenting that
 * tool as a function lets the upstream codec retain ordering; the fetch adapter
 * restores the exact custom-tool wire before dispatch and translates it back on
 * the response side.
 */
export function createPlaintextOpenResponsesModel(
  options: PlaintextOpenResponsesModelOptions,
): LanguageModelV4 {
  const delegate = createOpenResponses({
    name: options.providerName,
    apiKey: options.apiKey,
    url: openResponsesUrl(options.baseUrl),
    fetch: createDialectFetch(options.fetch),
  })(options.modelId);

  return {
    specificationVersion: 'v4',
    provider: delegate.provider,
    modelId: delegate.modelId,
    supportedUrls: delegate.supportedUrls,
    async doGenerate(callOptions) {
      return projectGenerateResult(
        await delegate.doGenerate(projectCallOptions(callOptions, options.providerName)),
      );
    },
    async doStream(callOptions) {
      return projectStreamResult(
        await delegate.doStream(projectCallOptions(callOptions, options.providerName)),
      );
    },
  };
}

function projectCallOptions(
  options: LanguageModelV4CallOptions,
  providerName: string,
): LanguageModelV4CallOptions {
  const providerOptions = options.providerOptions
    ? { ...options.providerOptions }
    : ({} as SharedV4ProviderOptions);
  const dialectOptions = providerOptions[providerName];
  const reasoningEffort = reasoningEffortFrom(dialectOptions?.reasoningEffort);
  if (dialectOptions) {
    const { reasoningEffort: _reasoningEffort, ...upstreamOptions } = dialectOptions;
    if (Object.keys(upstreamOptions).length > 0) providerOptions[providerName] = upstreamOptions;
    else delete providerOptions[providerName];
  }

  return {
    ...options,
    prompt: options.prompt.map(projectPromptMessage),
    ...(options.tools ? { tools: options.tools.map(projectTool) } : {}),
    ...(options.toolChoice?.type === 'tool'
      ? {
          toolChoice: {
            type: 'tool' as const,
            toolName:
              options.toolChoice.toolName === APPLY_PATCH_TOOL_NAME
                ? APPLY_PATCH_SENTINEL_NAME
                : options.toolChoice.toolName === WEB_SEARCH_TOOL_NAME
                  ? WEB_SEARCH_SENTINEL_NAME
                  : options.toolChoice.toolName,
          },
        }
      : {}),
    ...(reasoningEffort && reasoningEffort !== 'max' && options.reasoning === undefined
      ? { reasoning: reasoningEffort }
      : {}),
    ...(reasoningEffort === 'max' && options.reasoning === undefined
      ? {
          headers: {
            ...options.headers,
            [REASONING_EFFORT_HEADER]: reasoningEffort,
          },
        }
      : {}),
    providerOptions,
  };
}

function projectPromptMessage(message: LanguageModelV4Message): LanguageModelV4Message {
  if (message.role !== 'assistant' && message.role !== 'tool') return message;
  let changed = false;
  const content = message.content.map((part) => {
    if (part.type === 'tool-call' && part.toolName === APPLY_PATCH_TOOL_NAME) {
      changed = true;
      return {
        ...part,
        toolName: APPLY_PATCH_SENTINEL_NAME,
        input: { input: part.input },
      };
    }
    if (part.type === 'tool-result' && part.toolName === APPLY_PATCH_TOOL_NAME) {
      changed = true;
      return { ...part, toolName: APPLY_PATCH_SENTINEL_NAME };
    }
    if (
      (part.type === 'tool-call' || part.type === 'tool-result') &&
      part.toolName === WEB_SEARCH_TOOL_NAME
    ) {
      changed = true;
      return { ...part, toolName: WEB_SEARCH_SENTINEL_NAME };
    }
    return part;
  });
  return changed ? ({ ...message, content } as LanguageModelV4Message) : message;
}

function projectTool(
  tool: NonNullable<LanguageModelV4CallOptions['tools']>[number],
): NonNullable<LanguageModelV4CallOptions['tools']>[number] {
  if (tool.type !== 'provider') return tool;
  if (tool.id !== OPENAI_CUSTOM_TOOL_ID || tool.name !== APPLY_PATCH_TOOL_NAME) {
    if (tool.id !== OPENAI_WEB_SEARCH_TOOL_ID || tool.name !== WEB_SEARCH_TOOL_NAME) {
      throw new Error(`open_responses_provider_tool_unsupported:${tool.id}:${tool.name}`);
    }
    return {
      type: 'function',
      name: WEB_SEARCH_SENTINEL_NAME,
      description: JSON.stringify(tool.args),
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      strict: true,
    };
  }
  return {
    type: 'function' as const,
    name: APPLY_PATCH_SENTINEL_NAME,
    description: 'Apply a patch to the local workspace.',
    inputSchema: {
      type: 'object' as const,
      properties: { input: { type: 'string' as const } },
      required: ['input'],
      additionalProperties: false,
    },
    strict: true,
  };
}

function reasoningEffortFrom(
  value: unknown,
): LanguageModelV4CallOptions['reasoning'] | 'max' | undefined {
  return value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
    ? value
    : undefined;
}

function projectGenerateResult(
  result: LanguageModelV4GenerateResult,
): LanguageModelV4GenerateResult {
  return {
    ...result,
    content: result.content.flatMap(projectModelContent),
    ...(result.request?.body !== undefined
      ? { request: { ...result.request, body: projectRequestBody(result.request.body) } }
      : {}),
  };
}

function projectStreamResult(result: LanguageModelV4StreamResult): LanguageModelV4StreamResult {
  return {
    ...result,
    stream: result.stream.pipeThrough(
      new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
        transform(part, controller) {
          for (const projected of projectStreamPart(part)) controller.enqueue(projected);
        },
      }),
    ),
    ...(result.request?.body !== undefined
      ? { request: { ...result.request, body: projectRequestBody(result.request.body) } }
      : {}),
  };
}

function projectModelContent(content: LanguageModelV4Content): LanguageModelV4Content[] {
  if (content.type !== 'tool-call') return [content];
  if (content.toolName === WEB_SEARCH_SENTINEL_NAME) {
    return projectWebSearchContent(content);
  }
  if (content.toolName !== APPLY_PATCH_SENTINEL_NAME) {
    return [content];
  }
  return [
    {
      ...content,
      toolName: APPLY_PATCH_TOOL_NAME,
      input: customToolInputForModel(content.input),
    },
  ];
}

function projectStreamPart(part: LanguageModelV4StreamPart): LanguageModelV4StreamPart[] {
  if (part.type === 'tool-input-start') {
    if (part.toolName === APPLY_PATCH_SENTINEL_NAME) {
      return [{ ...part, toolName: APPLY_PATCH_TOOL_NAME }];
    }
    if (part.toolName === WEB_SEARCH_SENTINEL_NAME) {
      return [{ ...part, toolName: WEB_SEARCH_TOOL_NAME, providerExecuted: true }];
    }
  }
  if (part.type !== 'tool-call') return [part];
  return projectModelContent(part) as LanguageModelV4StreamPart[];
}

function projectWebSearchContent(
  content: Extract<LanguageModelV4Content, { type: 'tool-call' }>,
): LanguageModelV4Content[] {
  let payload: Record<string, unknown> = {};
  try {
    payload = asRecord(JSON.parse(content.input) as unknown) ?? {};
  } catch {
    // A malformed hosted result remains visible as an empty provider result.
  }
  const result: JSONObject = {};
  if (isJSONValue(payload.action)) result.action = payload.action;
  if (isJSONValue(payload.sources)) result.sources = payload.sources;
  return [
    {
      ...content,
      toolName: WEB_SEARCH_TOOL_NAME,
      input: '{}',
      providerExecuted: true,
    },
    {
      type: 'tool-result',
      toolCallId: content.toolCallId,
      toolName: WEB_SEARCH_TOOL_NAME,
      result,
    },
  ];
}

function customToolInputForModel(input: string): string {
  try {
    const parsed = JSON.parse(input) as unknown;
    const record = asRecord(parsed);
    if (record && typeof record.input === 'string') return JSON.stringify(record.input);
  } catch {
    // Preserve malformed provider input so the AI SDK's ordinary validation path owns the error.
  }
  return input;
}

function createDialectFetch(fetchImpl: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, projectRequestInit(init));
    return projectResponse(response);
  };
}

function projectRequestInit(init: RequestInit | undefined): RequestInit | undefined {
  if (!init) return init;
  const headers = new Headers(init.headers);
  const reasoningEffort = headers.get(REASONING_EFFORT_HEADER);
  headers.delete(REASONING_EFFORT_HEADER);
  if (typeof init.body !== 'string') {
    return reasoningEffort ? { ...init, headers } : init;
  }
  let body: unknown;
  try {
    body = JSON.parse(init.body) as unknown;
  } catch {
    return reasoningEffort ? { ...init, headers } : init;
  }
  const projected = projectRequestBody(body);
  const record = asRecord(projected);
  const reasoning = asRecord(record?.reasoning);
  return {
    ...init,
    headers,
    body: JSON.stringify(
      record && reasoningEffort === 'max'
        ? { ...record, reasoning: { ...reasoning, effort: reasoningEffort } }
        : projected,
    ),
  };
}

function projectRequestBody(body: unknown): unknown {
  const record = asRecord(body);
  if (!record) return body;
  const customCallIds = new Set<string>();
  const webSearchCallIds = new Set<string>();
  const input = Array.isArray(record.input)
    ? record.input.flatMap((item) => {
        const itemRecord = asRecord(item);
        if (!itemRecord) return [item];
        if (itemRecord.type === 'function_call' && itemRecord.name === APPLY_PATCH_SENTINEL_NAME) {
          if (typeof itemRecord.call_id !== 'string') {
            throw new Error('open_responses_custom_call_id');
          }
          const customInput = customToolInputFromArguments(itemRecord.arguments);
          customCallIds.add(itemRecord.call_id);
          return [
            {
              type: 'custom_tool_call',
              call_id: itemRecord.call_id,
              name: APPLY_PATCH_TOOL_NAME,
              input: customInput,
            },
          ];
        }
        if (itemRecord.type === 'function_call' && itemRecord.name === WEB_SEARCH_SENTINEL_NAME) {
          if (typeof itemRecord.call_id !== 'string') {
            throw new Error('open_responses_web_search_call_id');
          }
          webSearchCallIds.add(itemRecord.call_id);
          return [{ type: 'item_reference', id: itemRecord.call_id }];
        }
        if (
          itemRecord.type === 'function_call_output' &&
          typeof itemRecord.call_id === 'string' &&
          webSearchCallIds.has(itemRecord.call_id)
        ) {
          return [];
        }
        if (
          itemRecord.type === 'function_call_output' &&
          typeof itemRecord.call_id === 'string' &&
          customCallIds.has(itemRecord.call_id)
        ) {
          return [
            {
              type: 'custom_tool_call_output',
              call_id: itemRecord.call_id,
              output: itemRecord.output,
            },
          ];
        }
        return [item];
      })
    : record.input;
  const tools = Array.isArray(record.tools)
    ? record.tools.map((tool) => {
        const toolRecord = asRecord(tool);
        if (toolRecord?.type !== 'function') return tool;
        if (toolRecord.name === APPLY_PATCH_SENTINEL_NAME) {
          return { type: 'custom', name: APPLY_PATCH_TOOL_NAME };
        }
        if (toolRecord.name === WEB_SEARCH_SENTINEL_NAME) {
          return projectWebSearchTool(toolRecord.description);
        }
        return tool;
      })
    : record.tools;
  return {
    ...record,
    store: false,
    ...(input !== undefined ? { input } : {}),
    ...(tools !== undefined ? { tools } : {}),
  };
}

function customToolInputFromArguments(argumentsValue: unknown): string {
  if (typeof argumentsValue !== 'string') throw new Error('open_responses_custom_arguments');
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsValue) as unknown;
  } catch {
    throw new Error('open_responses_custom_arguments');
  }
  const record = asRecord(parsed);
  if (!record || typeof record.input !== 'string') {
    throw new Error('open_responses_custom_arguments');
  }
  return record.input;
}

function webSearchArgsFromDescription(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    return asRecord(JSON.parse(value) as unknown) ?? {};
  } catch {
    return {};
  }
}

function projectWebSearchTool(description: unknown): Record<string, unknown> {
  const args = webSearchArgsFromDescription(description);
  const filters = asRecord(args.filters);
  const userLocation = asRecord(args.userLocation);
  return {
    type: 'web_search',
    ...(args.searchContextSize === 'low' ||
    args.searchContextSize === 'medium' ||
    args.searchContextSize === 'high'
      ? { search_context_size: args.searchContextSize }
      : {}),
    ...(typeof args.externalWebAccess === 'boolean'
      ? { external_web_access: args.externalWebAccess }
      : {}),
    ...(filters
      ? {
          filters: {
            ...(stringArray(filters.allowedDomains)
              ? { allowed_domains: filters.allowedDomains }
              : {}),
            ...(stringArray(filters.blockedDomains)
              ? { blocked_domains: filters.blockedDomains }
              : {}),
          },
        }
      : {}),
    ...(userLocation ? { user_location: userLocation } : {}),
  };
}

function projectResponse(response: Response): Response {
  if (!response.ok || !response.body) return response;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    return responseWithBody(response, response.body.pipeThrough(projectEventStream()));
  }
  if (!contentType.includes('application/json')) return response;
  return responseWithBody(
    response,
    new ReadableStream<Uint8Array>({
      async start(controller) {
        const body = await response.text();
        controller.enqueue(new TextEncoder().encode(projectJsonResponse(body)));
        controller.close();
      },
    }),
  );
}

function projectJsonResponse(body: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    return body;
  }
  const record = asRecord(payload);
  if (!record || !Array.isArray(record.output)) return body;
  const output = record.output.map(projectResponseItem);
  return JSON.stringify({ ...record, output });
}

function projectResponseItem(item: unknown): unknown {
  const record = asRecord(item);
  if (!record) return item;
  if (record.type === 'web_search_call' && typeof record.id === 'string') {
    return {
      ...record,
      type: 'function_call',
      call_id: record.id,
      name: WEB_SEARCH_SENTINEL_NAME,
      arguments: JSON.stringify({
        ...(record.action !== undefined ? { action: record.action } : {}),
        ...(record.sources !== undefined ? { sources: record.sources } : {}),
      }),
    };
  }
  if (record.type !== 'custom_tool_call' || record.name !== APPLY_PATCH_TOOL_NAME) {
    return item;
  }
  const { input, ...rest } = record;
  return {
    ...rest,
    type: 'function_call',
    name: APPLY_PATCH_SENTINEL_NAME,
    arguments: JSON.stringify({ input: typeof input === 'string' ? input : '' }),
  };
}

function projectEventStream(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '';
  return new TransformStream({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const projectedLines = projectEventLine(line);
        for (const [index, projected] of projectedLines.entries()) {
          controller.enqueue(
            encoder.encode(`${projected}\n${index < projectedLines.length - 1 ? '\n' : ''}`),
          );
        }
      }
    },
    flush(controller) {
      pending += decoder.decode();
      if (!pending) return;
      for (const projected of projectEventLine(pending)) {
        controller.enqueue(encoder.encode(projected));
      }
    },
  });
}

function projectEventLine(line: string): string[] {
  if (!line.startsWith('data:')) return [line];
  const raw = line.slice('data:'.length).trim();
  if (!raw || raw === '[DONE]') return [line];
  let event: unknown;
  try {
    event = JSON.parse(raw) as unknown;
  } catch {
    return [line];
  }
  const eventRecord = asRecord(event);
  if (!eventRecord) return [line];
  if (eventRecord.type === 'response.custom_tool_call_input.delta') return [];
  if (
    (eventRecord.type === 'response.output_item.added' ||
      eventRecord.type === 'response.output_item.done') &&
    ((asRecord(eventRecord.item)?.type === 'custom_tool_call' &&
      asRecord(eventRecord.item)?.name === APPLY_PATCH_TOOL_NAME) ||
      asRecord(eventRecord.item)?.type === 'web_search_call')
  ) {
    const customItem = asRecord(eventRecord.item)!;
    const item = projectResponseItem(customItem);
    const projectedItem = asRecord(item);
    const projectedEvent = `data: ${JSON.stringify({ ...eventRecord, item })}`;
    if (eventRecord.type !== 'response.output_item.done') return [projectedEvent];
    const argumentsDone = {
      type: 'response.function_call_arguments.done',
      sequence_number:
        typeof eventRecord.sequence_number === 'number' ? eventRecord.sequence_number : 0,
      item_id: projectedItem?.id,
      output_index: eventRecord.output_index,
      call_id: projectedItem?.call_id,
      arguments: typeof projectedItem?.arguments === 'string' ? projectedItem.arguments : '{}',
    };
    return [`data: ${JSON.stringify(argumentsDone)}`, projectedEvent];
  }
  return [line];
}

function openResponsesUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, '').replace(/\/responses$/i, '');
  url.pathname = `${basePath}/responses`;
  return url.toString();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
