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

/**
 * Command Code CLI transport: the `/alpha/generate` wire, exposed as an AI SDK
 * language model. The Go plan's keys are answered by
 * `/provider/v1/chat/completions` with `403 upgrade_required`, so this is the
 * wire that serves them.
 *
 * Shape (see also the MIT-licensed `pi-commandcode-provider` and
 * `dsh-commandcode-provider`):
 *   POST {apiBase}/alpha/generate
 *   body   { config, memory, taste, skills, params: { model, messages, tools,
 *            system, max_tokens, temperature, stream, reasoning_effort? }, threadId }
 *   events SSE `data:` lines carrying AI SDK stream parts: `text-delta`,
 *          `reasoning-start|delta|end`, `tool-call`, `finish`, `error`.
 *   errors 403 `upgrade_required` is a plan gate, not a bad key.
 */

import { randomUUID } from 'node:crypto';
import {
  APICallError,
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type LanguageModelV4Content,
  type LanguageModelV4FilePart,
  type LanguageModelV4FinishReason,
  type LanguageModelV4GenerateResult,
  type LanguageModelV4Prompt,
  type LanguageModelV4StreamPart,
  type LanguageModelV4StreamResult,
  type LanguageModelV4ToolResultOutput,
  type LanguageModelV4Usage,
  type SharedV4Warning,
} from '@ai-sdk/provider';

/** The official CLI release whose wire this mirrors; sent as its version header. */
export const COMMANDCODE_CLI_VERSION = '1.54.0';
const DEFAULT_MAX_TOKENS = 64_000;
const DEFAULT_TEMPERATURE = 0.3;
/** The gateway rejects `call_id` values longer than this. */
const MAX_WIRE_TOOL_CALL_ID_LENGTH = 64;
const SCHEMA_NORMALIZE_MAX_DEPTH = 8;

export function commandCodeCliGenerateUrl(apiBase: string): string {
  return `${apiBase.replace(/\/+$/u, '')}/alpha/generate`;
}

/** The identity headers the official CLI sends; the gateway keys plan gating on them. */
export function commandCodeCliHeaders(apiKey: string, workingDir: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
    'x-command-code-version': COMMANDCODE_CLI_VERSION,
    'x-cli-environment': 'production',
    'x-project-slug': projectSlugFromPath(workingDir),
    'x-taste-learning': 'true',
    'x-co-flag': 'false',
  };
}

export function projectSlugFromPath(pathName: string): string {
  const slug = pathName
    .toLowerCase()
    .replace(/^[a-z]:/iu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|(?<!-)-+$/gu, '');
  return slug || 'project';
}

export interface CommandCodeCliLanguageModelConfig {
  readonly modelId: string;
  readonly apiKey: string;
  /** Provider API root, e.g. `https://api.commandcode.ai`. */
  readonly apiBase: string;
  readonly fetch?: typeof globalThis.fetch;
  /** What the CLI would call the working directory; only its slug crosses the wire. */
  readonly workingDir?: string;
  readonly now?: () => Date;
  readonly threadId?: () => string;
}

export interface CommandCodeCliRequestBody {
  readonly config: Record<string, unknown>;
  readonly memory: null;
  readonly taste: null;
  readonly skills: null;
  readonly params: Record<string, unknown>;
  readonly threadId: string;
}

export class CommandCodeCliLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = 'v4' as const;
  readonly provider = 'commandcode-cli';
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};
  readonly #config: CommandCodeCliLanguageModelConfig;

  constructor(config: CommandCodeCliLanguageModelConfig) {
    this.#config = config;
    this.modelId = config.modelId;
  }

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const { stream, request, response } = await this.doStream(options);
    const content: LanguageModelV4Content[] = [];
    const warnings: SharedV4Warning[] = [];
    let finishReason: LanguageModelV4FinishReason = { unified: 'other', raw: undefined };
    let usage = emptyUsage();
    let openText: { id: string; text: string } | undefined;
    let openReasoning: { id: string; text: string } | undefined;
    const reader = stream.getReader();
    for (;;) {
      const { done, value: part } = await reader.read();
      if (done) break;
      switch (part.type) {
        case 'stream-start':
          warnings.push(...part.warnings);
          break;
        case 'text-start':
          openText = { id: part.id, text: '' };
          break;
        case 'text-delta':
          if (openText) openText.text += part.delta;
          break;
        case 'text-end':
          if (openText) content.push({ type: 'text', text: openText.text });
          openText = undefined;
          break;
        case 'reasoning-start':
          openReasoning = { id: part.id, text: '' };
          break;
        case 'reasoning-delta':
          if (openReasoning) openReasoning.text += part.delta;
          break;
        case 'reasoning-end':
          if (openReasoning) content.push({ type: 'reasoning', text: openReasoning.text });
          openReasoning = undefined;
          break;
        case 'tool-call':
          content.push(part);
          break;
        case 'finish':
          finishReason = part.finishReason;
          usage = part.usage;
          break;
        case 'error':
          throw part.error;
        default:
          break;
      }
    }
    return {
      content,
      finishReason,
      usage,
      warnings,
      request,
      response: { headers: response?.headers },
    };
  }

  async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    const { body, warnings } = buildCommandCodeCliRequest(options, this.#config);
    const url = commandCodeCliGenerateUrl(this.#config.apiBase);
    const fetchFn = this.#config.fetch ?? globalThis.fetch;
    const headers: Record<string, string> = {
      ...commandCodeCliHeaders(this.#config.apiKey, this.#config.workingDir ?? DEFAULT_WORKING_DIR),
      ...definedHeaders(options.headers),
    };
    let response: Response;
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.abortSignal,
      });
    } catch (error) {
      if (options.abortSignal?.aborted) throw error;
      throw new APICallError({
        message: `Command Code GO request failed: ${errorMessage(error)}`,
        url,
        requestBodyValues: body,
        cause: error,
        isRetryable: true,
      });
    }
    const responseHeaders = headersToRecord(response.headers);
    if (!response.ok) {
      const responseBody = await response.text().catch(() => '');
      throw new APICallError({
        message: `Command Code GO rejected the request (${response.status}): ${responseBody.slice(0, 500)}`,
        url,
        requestBodyValues: body,
        statusCode: response.status,
        responseHeaders,
        responseBody,
        isRetryable: response.status === 429 || response.status >= 500,
      });
    }
    if (!response.body) {
      throw new APICallError({
        message: 'Command Code GO returned no body',
        url,
        requestBodyValues: body,
        statusCode: response.status,
        responseHeaders,
        isRetryable: true,
      });
    }
    const stream = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(sseDataLines())
      .pipeThrough(cliEventsToStreamParts({ warnings, url, body, modelId: this.modelId }));
    return { stream, request: { body }, response: { headers: responseHeaders } };
  }
}

const DEFAULT_WORKING_DIR = 'maka';

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export function buildCommandCodeCliRequest(
  options: LanguageModelV4CallOptions,
  config: Pick<CommandCodeCliLanguageModelConfig, 'modelId' | 'workingDir' | 'now' | 'threadId'>,
): { body: CommandCodeCliRequestBody; warnings: SharedV4Warning[] } {
  const warnings: SharedV4Warning[] = [];
  const unsupported: Array<[string, unknown]> = [
    ['topP', options.topP],
    ['topK', options.topK],
    ['presencePenalty', options.presencePenalty],
    ['frequencyPenalty', options.frequencyPenalty],
    ['stopSequences', options.stopSequences],
    ['seed', options.seed],
  ];
  for (const [setting, value] of unsupported) {
    if (value !== undefined) warnings.push({ type: 'unsupported', feature: setting });
  }
  if (options.responseFormat && options.responseFormat.type !== 'text') {
    warnings.push({ type: 'unsupported', feature: 'responseFormat' });
  }
  if (options.toolChoice && options.toolChoice.type !== 'auto') {
    warnings.push({
      type: 'unsupported',
      feature: 'toolChoice',
      details: 'Command Code GO always lets the model choose',
    });
  }

  const { system, messages } = convertPrompt(options.prompt, warnings);
  const tools = (options.tools ?? []).flatMap((tool) => {
    if (tool.type !== 'function') {
      warnings.push({ type: 'unsupported', feature: `provider tool ${tool.name}` });
      return [];
    }
    return [
      {
        type: 'function',
        name: tool.name,
        description: tool.description,
        input_schema: toolParametersSchema(tool.inputSchema),
      },
    ];
  });
  const reasoningEffort = resolveReasoningEffort(options);
  const now = config.now?.() ?? new Date();
  const body: CommandCodeCliRequestBody = {
    config: {
      workingDir: config.workingDir ?? DEFAULT_WORKING_DIR,
      date: now.toISOString().split('T')[0],
      environment: `${process.platform}-${process.arch}, Node.js ${process.version}`,
      structure: [],
      isGitRepo: false,
      currentBranch: '',
      mainBranch: '',
      gitStatus: '',
      recentCommits: [],
    },
    memory: null,
    taste: null,
    skills: null,
    params: {
      model: config.modelId,
      messages,
      tools,
      system,
      max_tokens: options.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      temperature: options.temperature ?? DEFAULT_TEMPERATURE,
      stream: true,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    },
    threadId: config.threadId?.() ?? randomUUID(),
  };
  return { body, warnings };
}

function resolveReasoningEffort(options: LanguageModelV4CallOptions): string | undefined {
  const override = options.providerOptions?.['commandcode-cli']?.reasoningEffort;
  if (typeof override === 'string' && override !== '') return override;
  const level = options.reasoning;
  if (level === undefined || level === 'provider-default' || level === 'none') return undefined;
  return level;
}

/**
 * The CLI wire's message shape, converted from the AI SDK prompt. System
 * messages fold into `params.system`; only tool calls with a paired result
 * are replayed; assistant reasoning IS replayed (the gateway rebuilds the
 * upstream request from these blocks and DeepSeek thinking mode rejects a
 * tool loop whose history lacks it).
 */
function convertPrompt(
  prompt: LanguageModelV4Prompt,
  warnings: SharedV4Warning[],
): { system: string; messages: unknown[] } {
  const systemParts: string[] = [];
  const callIds = new Set<string>();
  const callNames = new Map<string, string>();
  const resultIds = new Set<string>();
  for (const message of prompt) {
    if (message.role === 'assistant') {
      for (const part of message.content) {
        if (part.type === 'tool-call') {
          callIds.add(part.toolCallId);
          callNames.set(part.toolCallId, part.toolName);
        }
      }
    }
    if (message.role === 'tool') {
      for (const part of message.content) {
        if (part.type === 'tool-result') resultIds.add(part.toolCallId);
      }
    }
  }
  const paired = new Set([...callIds].filter((id) => resultIds.has(id)));
  const wireIds = wireToolCallIds(paired);

  const messages: unknown[] = [];
  for (const message of prompt) {
    switch (message.role) {
      case 'system':
        systemParts.push(message.content);
        break;
      case 'user': {
        const parts: unknown[] = [];
        for (const part of message.content) {
          if (part.type === 'text') {
            parts.push({ type: 'text', text: part.text });
            continue;
          }
          const image = imagePart(part, warnings);
          if (image) parts.push(image);
        }
        if (parts.length > 0) messages.push({ role: 'user', content: parts });
        break;
      }
      case 'assistant': {
        const parts: unknown[] = [];
        for (const part of message.content) {
          if (part.type === 'text') parts.push({ type: 'text', text: part.text });
          else if (part.type === 'reasoning') parts.push({ type: 'reasoning', text: part.text });
          else if (part.type === 'tool-call' && paired.has(part.toolCallId)) {
            parts.push({
              type: 'tool-call',
              toolCallId: wireIds.get(part.toolCallId) ?? part.toolCallId,
              toolName: part.toolName,
              input: recordOrEmpty(part.input),
            });
          }
        }
        if (parts.length > 0) messages.push({ role: 'assistant', content: parts });
        break;
      }
      case 'tool': {
        for (const part of message.content) {
          if (part.type !== 'tool-result' || !paired.has(part.toolCallId)) continue;
          const { text, isError } = toolResultText(part.output, warnings);
          messages.push({
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: wireIds.get(part.toolCallId) ?? part.toolCallId,
                toolName: callNames.get(part.toolCallId) || part.toolName || 'unknown',
                output: isError
                  ? { type: 'error-text', value: text }
                  : { type: 'text', value: text },
              },
            ],
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return { system: systemParts.join('\n\n'), messages };
}

function imagePart(
  part: LanguageModelV4FilePart,
  warnings: SharedV4Warning[],
): unknown | undefined {
  if (!part.mediaType.startsWith('image/')) {
    warnings.push({ type: 'unsupported', feature: `file input ${part.mediaType}` });
    return undefined;
  }
  if (part.data.type !== 'data') {
    warnings.push({
      type: 'unsupported',
      feature: `image ${part.data.type} input`,
      details: 'Command Code GO carries images inline only',
    });
    return undefined;
  }
  const encoded =
    typeof part.data.data === 'string'
      ? part.data.data
      : Buffer.from(part.data.data).toString('base64');
  // The pinned CLI serializes an image block in the AI SDK message shape it
  // builds its request from — a data URL under `image`, beside `mimeType` —
  // not Anthropic's `source` object. The rest of this wire is AI SDK shaped
  // too (`toolCallId`, `toolName`, `input`), and for an unpublished endpoint
  // the pinned CLI is the protocol authority.
  return {
    type: 'image',
    image: encoded.startsWith('data:') ? encoded : `data:${part.mediaType};base64,${encoded}`,
    mimeType: part.mediaType,
  };
}

function toolResultText(
  output: LanguageModelV4ToolResultOutput,
  warnings: SharedV4Warning[],
): { text: string; isError: boolean } {
  switch (output.type) {
    case 'text':
      return { text: output.value, isError: false };
    case 'error-text':
      return { text: output.value, isError: true };
    case 'json':
      return { text: JSON.stringify(output.value), isError: false };
    case 'error-json':
      return { text: JSON.stringify(output.value), isError: true };
    case 'execution-denied':
      return { text: output.reason ?? 'Tool execution was denied.', isError: true };
    case 'content': {
      const texts: string[] = [];
      for (const item of output.value) {
        if (item.type === 'text') texts.push(item.text);
        else warnings.push({ type: 'unsupported', feature: `tool result ${item.type}` });
      }
      return { text: texts.join('\n'), isError: false };
    }
    default:
      return { text: '', isError: false };
  }
}

/** Overlong paired ids get a per-request `cc-<n>` alias; the pair resolves through one map. */
export function wireToolCallIds(paired: ReadonlySet<string>): Map<string, string> {
  const wire = new Map<string, string>();
  const taken = new Set<string>();
  for (const id of paired) {
    if (id.length <= MAX_WIRE_TOOL_CALL_ID_LENGTH) {
      wire.set(id, id);
      taken.add(id);
    }
  }
  let seq = 1;
  for (const id of paired) {
    if (wire.has(id)) continue;
    let alias = `cc-${seq++}`;
    while (taken.has(alias)) alias = `cc-${seq++}`;
    wire.set(id, alias);
    taken.add(alias);
  }
  return wire;
}

/**
 * The gateway validates a tool schema's root `type` against the literal
 * string "object". Schemas generators emit as `["object","null"]`, a bare
 * `$ref`, or a combinator get the declared type they mean.
 */
export function toolParametersSchema(parameters: unknown, depth = 0): Record<string, unknown> {
  if (!isRecord(parameters)) return { type: 'object', properties: {}, additionalProperties: true };
  if (parameters.type === 'object') return parameters;
  if (Array.isArray(parameters.type) && parameters.type.includes('object')) {
    return { ...parameters, type: 'object' };
  }
  if (parameters.type === undefined || parameters.type === null) {
    if (typeof parameters.$ref === 'string' && depth < SCHEMA_NORMALIZE_MAX_DEPTH) {
      const target = resolveLocalRef(parameters, parameters.$ref);
      if (target !== undefined) {
        const { $ref: _ref, ...rest } = parameters;
        return toolParametersSchema({ ...target, ...rest }, depth + 1);
      }
    }
    if (isRecord(parameters.properties) || parameters.additionalProperties !== undefined) {
      return { ...parameters, type: 'object' };
    }
    for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
      const branches = parameters[key];
      if (Array.isArray(branches) && depth < SCHEMA_NORMALIZE_MAX_DEPTH) {
        const merged = branches.map((branch) => toolParametersSchema(branch, depth + 1));
        const properties = Object.assign({}, ...merged.map((b) => b.properties ?? {}));
        const required = [
          ...new Set(merged.flatMap((b) => (Array.isArray(b.required) ? b.required : []))),
        ];
        return {
          type: 'object',
          properties,
          ...(required.length > 0 ? { required } : {}),
          additionalProperties: true,
        };
      }
    }
    if (typeof parameters.$ref === 'string') return { ...parameters, type: 'object' };
  }
  return { type: 'object', properties: {}, additionalProperties: true };
}

function resolveLocalRef(
  root: Record<string, unknown>,
  ref: string,
): Record<string, unknown> | undefined {
  if (!ref.startsWith('#/')) return undefined;
  let current: unknown = root;
  for (const segment of ref.slice(2).split('/')) {
    if (!isRecord(current)) return undefined;
    current = current[segment.replace(/~1/gu, '/').replace(/~0/gu, '~')];
  }
  return isRecord(current) ? current : undefined;
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/** Splits SSE text into the JSON payload of each `data:` line, dropping comments and `[DONE]`. */
/** One SSE line's event payload, or undefined when the line carries none. */
export function parseCommandCodeCliEventLine(line: string): unknown | undefined {
  let trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':') || trimmed.startsWith('event:')) return undefined;
  if (trimmed.startsWith('data:')) trimmed = trimmed.slice(5).trim();
  if (!trimmed || trimmed === '[DONE]') return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // A non-JSON line is not an event on this wire.
    return undefined;
  }
}

export interface CommandCodeCliStreamOutcome {
  /** The wire said the turn ended. An unterminated stream was truncated. */
  readonly finished: boolean;
  /** The in-band `error` event that ended the turn, if one arrived. */
  readonly error?: { readonly message: string; readonly statusCode?: number };
}

/**
 * Reads one complete CLI stream body the way {@link CommandCodeCliLanguageModel}
 * reads it incrementally. HTTP 200 is only the handshake on this wire, so a
 * caller that stops at the status (the connection probe) would accept a body
 * whose first event is a rejection.
 */
export function summarizeCommandCodeCliStream(body: string): CommandCodeCliStreamOutcome {
  for (const line of body.split('\n')) {
    const event = parseCommandCodeCliEventLine(line);
    if (!isRecord(event)) continue;
    if (event.type === 'error') {
      const { message, statusCode } = streamErrorFacts(event);
      return {
        finished: false,
        error: { message, ...(statusCode === undefined ? {} : { statusCode }) },
      };
    }
    if (event.type === 'finish') return { finished: true };
  }
  return { finished: false };
}

function sseDataLines(): TransformStream<string, unknown> {
  let buffer = '';
  const emit = (line: string, controller: TransformStreamDefaultController<unknown>) => {
    const event = parseCommandCodeCliEventLine(line);
    if (event !== undefined) controller.enqueue(event);
  };
  return new TransformStream<string, unknown>({
    transform(chunk, controller) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) emit(line, controller);
    },
    flush(controller) {
      if (buffer) emit(buffer, controller);
    },
  });
}

function cliEventsToStreamParts(input: {
  warnings: SharedV4Warning[];
  url: string;
  body: unknown;
  modelId: string;
}): TransformStream<unknown, LanguageModelV4StreamPart> {
  let textId: string | undefined;
  let reasoningId: string | undefined;
  let nextId = 0;
  let finished = false;
  const closeText = (controller: TransformStreamDefaultController<LanguageModelV4StreamPart>) => {
    if (textId === undefined) return;
    controller.enqueue({ type: 'text-end', id: textId });
    textId = undefined;
  };
  const closeReasoning = (
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
  ) => {
    if (reasoningId === undefined) return;
    controller.enqueue({ type: 'reasoning-end', id: reasoningId });
    reasoningId = undefined;
  };
  return new TransformStream<unknown, LanguageModelV4StreamPart>({
    start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: input.warnings });
      controller.enqueue({ type: 'response-metadata', modelId: input.modelId });
    },
    transform(event, controller) {
      if (!isRecord(event) || finished) return;
      switch (event.type) {
        case 'text-delta': {
          closeReasoning(controller);
          if (textId === undefined) {
            textId = `text-${nextId++}`;
            controller.enqueue({ type: 'text-start', id: textId });
          }
          controller.enqueue({
            type: 'text-delta',
            id: textId,
            delta: stringValue(event.text) ?? '',
          });
          break;
        }
        case 'text-end':
          closeText(controller);
          break;
        case 'reasoning-start':
          closeText(controller);
          break;
        case 'reasoning-delta': {
          closeText(controller);
          if (reasoningId === undefined) {
            reasoningId = `reasoning-${nextId++}`;
            controller.enqueue({ type: 'reasoning-start', id: reasoningId });
          }
          controller.enqueue({
            type: 'reasoning-delta',
            id: reasoningId,
            delta: stringValue(event.text) ?? '',
          });
          break;
        }
        case 'reasoning-end':
          closeReasoning(controller);
          break;
        case 'tool-call': {
          closeText(controller);
          closeReasoning(controller);
          const id = stringValue(event.toolCallId) ?? randomUUID();
          const toolName = stringValue(event.toolName) ?? '';
          const args = JSON.stringify(recordOrEmpty(event.input ?? event.args ?? event.arguments));
          controller.enqueue({ type: 'tool-input-start', id, toolName });
          controller.enqueue({ type: 'tool-input-delta', id, delta: args });
          controller.enqueue({ type: 'tool-input-end', id });
          controller.enqueue({ type: 'tool-call', toolCallId: id, toolName, input: args });
          break;
        }
        case 'finish': {
          closeText(controller);
          closeReasoning(controller);
          finished = true;
          controller.enqueue({
            type: 'finish',
            usage: usageFromEvent(event.totalUsage),
            finishReason: mapFinishReason(event.finishReason),
          });
          break;
        }
        case 'error': {
          closeText(controller);
          closeReasoning(controller);
          finished = true;
          controller.enqueue({ type: 'error', error: streamErrorToApiCallError(event, input) });
          break;
        }
        default:
          break;
      }
    },
    flush(controller) {
      closeText(controller);
      closeReasoning(controller);
      if (!finished) {
        // The connection closed before the wire said it was done: report the
        // truncation instead of a clean stop so the caller can retry.
        controller.enqueue({
          type: 'error',
          error: new APICallError({
            message: 'Command Code GO stream ended without a finish event',
            url: input.url,
            requestBodyValues: input.body,
            isRetryable: true,
          }),
        });
      }
    },
  });
}

function usageFromEvent(value: unknown): LanguageModelV4Usage {
  if (!isRecord(value)) return emptyUsage();
  const inputDetails = isRecord(value.inputTokenDetails) ? value.inputTokenDetails : undefined;
  const outputDetails = isRecord(value.outputTokenDetails) ? value.outputTokenDetails : undefined;
  const total = numberValue(value.inputTokens);
  const cacheRead = numberValue(inputDetails?.cacheReadTokens);
  const cacheWrite = numberValue(inputDetails?.cacheWriteTokens);
  const noCache =
    numberValue(inputDetails?.noCacheTokens) ??
    (total === undefined ? undefined : Math.max(0, total - (cacheRead ?? 0) - (cacheWrite ?? 0)));
  return {
    inputTokens: { total, noCache, cacheRead, cacheWrite },
    outputTokens: {
      total: numberValue(value.outputTokens),
      text: undefined,
      reasoning: numberValue(outputDetails?.reasoningTokens),
    },
    raw: value as LanguageModelV4Usage['raw'],
  };
}

function emptyUsage(): LanguageModelV4Usage {
  return {
    inputTokens: {
      total: undefined,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  };
}

export function mapFinishReason(reason: unknown): LanguageModelV4FinishReason {
  const raw = stringValue(reason);
  if (raw === 'tool-calls' || raw === 'tool_calls') return { unified: 'tool-calls', raw };
  if (
    raw === 'length' ||
    raw === 'max_tokens' ||
    raw === 'max-tokens' ||
    raw === 'max_output_tokens'
  ) {
    return { unified: 'length', raw };
  }
  if (raw === 'content-filter' || raw === 'content_filter')
    return { unified: 'content-filter', raw };
  if (raw === 'error') return { unified: 'error', raw };
  return { unified: 'stop', raw };
}

/**
 * An in-band `error` event becomes the same error shape a rejected HTTP
 * response produces, so the runtime's provider-error classification reads
 * status and structured code from one place.
 */
/** What one in-band `error` event states, shared by the stream and the probe. */
function streamErrorFacts(event: Record<string, unknown>): {
  message: string;
  statusCode?: number;
  detail?: Record<string, unknown>;
  explicitRetryable?: boolean;
} {
  const detail = isRecord(event.error) ? event.error : undefined;
  const message =
    stringValue(detail?.message) ??
    stringValue(event.message) ??
    (detail ? JSON.stringify(detail) : stringValue(event.error)) ??
    'Stream error';
  const statusCode = numberValue(detail?.statusCode) ?? numberValue(detail?.status);
  return {
    message,
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(detail !== undefined ? { detail } : {}),
    ...(typeof detail?.isRetryable === 'boolean' ? { explicitRetryable: detail.isRetryable } : {}),
  };
}

function streamErrorToApiCallError(
  event: Record<string, unknown>,
  input: { url: string; body: unknown },
): APICallError {
  const { message, statusCode, detail, explicitRetryable } = streamErrorFacts(event);
  const isRetryable =
    explicitRetryable ??
    (statusCode !== undefined ? statusCode === 429 || statusCode >= 500 : false);
  return new APICallError({
    message: `Command Code GO stream error: ${message}`,
    url: input.url,
    requestBodyValues: input.body,
    ...(statusCode !== undefined ? { statusCode } : {}),
    responseBody: JSON.stringify({ error: detail ?? { message } }),
    isRetryable,
    data: detail,
  });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Not JSON: the model produced no usable arguments.
    }
  }
  return {};
}

function definedHeaders(
  headers: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
