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

import type {
  Experimental_OpenResponsesExtension,
  Experimental_OpenResponsesExtensionContentPart,
  Experimental_OpenResponsesExtensionInputPart,
  Experimental_OpenResponsesExtensionItem,
  Experimental_OpenResponsesExtensionStreamPart,
} from '@ai-sdk/open-responses';
import type { JSONObject, JSONValue, LanguageModelV4ProviderTool } from '@ai-sdk/provider';
import type { ProviderType } from '@maka/core/llm-connections';
import type { CustomPart, ProviderOptions } from './model-protocol.js';
import { NATIVE_WEB_SEARCH_TOOL_NAME } from './native-web-search-tool.js';

/**
 * DeepSeek Open Responses codecs for hosted `web_search` (#4107).
 *
 * Product routing stays fail-closed (`implemented: false`); this registers
 * encode/decode/replay only. `@ai-sdk/open-responses@2.0.44` still requires
 * namespaced `<implementor>:<type>` registrations, so a DeepSeek-only
 * allowlisted discriminator wrap maps those to DeepSeek's documented bare
 * `web_search` / `web_search_call` / `response.web_search_call.*` wire.
 * Namespaced registration plus the discriminator wrap already emit DeepSeek's
 * bare wire. Do not register a bare `allowBareTypes` variant: a flag-only
 * upstream (vercel/ai#19939) would accept the probe and then silently stop
 * decoding because the SDK parsers still require a `:`.
 */

/**
 * AI SDK provider-tool ID for the compiled Open Responses search descriptor.
 * DeepSeek's first-party wire uses the bare `web_search` tool instead.
 */
export const DEEPSEEK_OPEN_RESPONSES_WEB_SEARCH_EXTENSION_ID = 'openai.web_search';

/** SDK custom part that carries the original extension item for lossless replay. */
export const OPEN_RESPONSES_EXTENSION_REPLAY_KIND = 'open-responses.extension-replay';

const WEB_SEARCH_ITEM = 'web_search_call';
const WEB_SEARCH_TOOL = 'web_search';
const NAMESPACED_WEB_SEARCH_TOOL = 'openai:web_search';
const NAMESPACED_WEB_SEARCH_ITEM = 'openai:web_search_call';

const WEB_SEARCH_EVENTS = {
  inProgress: 'response.web_search_call.in_progress',
  searching: 'response.web_search_call.searching',
  completed: 'response.web_search_call.completed',
} as const;

const NAMESPACED_WEB_SEARCH_EVENTS = {
  inProgress: 'openai:web_search_call.in_progress',
  searching: 'openai:web_search_call.searching',
  completed: 'openai:web_search_call.completed',
} as const;

const OUTGOING_TOOL_TYPES = new Map<string, string>([
  [NAMESPACED_WEB_SEARCH_TOOL, WEB_SEARCH_TOOL],
  [NAMESPACED_WEB_SEARCH_ITEM, WEB_SEARCH_ITEM],
]);

const INCOMING_TOOL_TYPES = new Map<string, string>([
  [WEB_SEARCH_TOOL, NAMESPACED_WEB_SEARCH_TOOL],
  ['web_search_2025_08_26', NAMESPACED_WEB_SEARCH_TOOL],
  [WEB_SEARCH_ITEM, NAMESPACED_WEB_SEARCH_ITEM],
]);

const INCOMING_EVENT_TYPES = new Map<string, string>([
  [WEB_SEARCH_EVENTS.inProgress, NAMESPACED_WEB_SEARCH_EVENTS.inProgress],
  [WEB_SEARCH_EVENTS.searching, NAMESPACED_WEB_SEARCH_EVENTS.searching],
  [WEB_SEARCH_EVENTS.completed, NAMESPACED_WEB_SEARCH_EVENTS.completed],
]);

export function usesDeepSeekOpenResponsesExtensions(providerType: ProviderType): boolean {
  return providerType === 'deepseek';
}

export function isOpenResponsesExtensionReplayChunk(chunk: {
  type: string;
  kind?: unknown;
}): boolean {
  return chunk.type === 'custom' && chunk.kind === OPEN_RESPONSES_EXTENSION_REPLAY_KIND;
}

/** Original opaque item stored on an Open Responses extension replay carrier. */
export function openResponsesExtensionReplayItem(container: unknown): JSONObject | undefined {
  if (!isRecord(container)) return undefined;
  for (const value of Object.values(container)) {
    if (!isRecord(value) || !isRecord(value.openResponsesExtension)) continue;
    const item = jsonObject(value.openResponsesExtension.item);
    if (item && typeof item.id === 'string') return item;
  }
  return undefined;
}

export function attachOpenResponsesExtensionReplayItem(
  toolCallProviderOptions: unknown,
  carrierProviderOptions: unknown,
): ProviderOptions | undefined {
  const item = openResponsesExtensionReplayItem(carrierProviderOptions);
  const base = isRecord(toolCallProviderOptions)
    ? { ...toolCallProviderOptions }
    : isRecord(carrierProviderOptions)
      ? { ...carrierProviderOptions }
      : {};
  if (!item || !isRecord(carrierProviderOptions)) {
    return Object.keys(base).length > 0 ? (base as ProviderOptions) : undefined;
  }
  for (const [key, value] of Object.entries(carrierProviderOptions)) {
    if (!isRecord(value) || !isRecord(value.openResponsesExtension)) continue;
    const existing = isRecord(base[key]) ? base[key] : {};
    const existingExt = isRecord(existing.openResponsesExtension)
      ? existing.openResponsesExtension
      : {};
    base[key] = {
      ...existing,
      openResponsesExtension: {
        ...existingExt,
        ...value.openResponsesExtension,
        item,
      },
    };
  }
  return base as ProviderOptions;
}

export function openResponsesExtensionReplayCarrierPart(
  providerOptions: unknown,
): CustomPart | undefined {
  if (!openResponsesExtensionReplayItem(providerOptions) || !isRecord(providerOptions)) {
    return undefined;
  }
  return {
    type: 'custom',
    kind: OPEN_RESPONSES_EXTENSION_REPLAY_KIND,
    providerOptions: providerOptions as ProviderOptions,
  };
}

export function openResponsesExtensionReplayReferenceOptions(
  providerOptions: unknown,
): ProviderOptions | undefined {
  if (!isRecord(providerOptions)) return undefined;
  const next: Record<string, unknown> = {};
  let rewritten = false;
  for (const [key, value] of Object.entries(providerOptions)) {
    if (!isRecord(value) || !isRecord(value.openResponsesExtension)) {
      next[key] = value;
      continue;
    }
    const extension = value.openResponsesExtension;
    const item = jsonObject(extension.item);
    const id = typeof extension.id === 'string' ? extension.id : undefined;
    const itemId =
      typeof extension.itemId === 'string'
        ? extension.itemId
        : item && typeof item.id === 'string'
          ? item.id
          : undefined;
    if (!id || !itemId) {
      next[key] = value;
      continue;
    }
    next[key] = { ...value, openResponsesExtension: { id, itemId } };
    rewritten = true;
  }
  return rewritten ? (next as ProviderOptions) : undefined;
}

export function createDeepSeekOpenResponsesExtensions(): readonly Experimental_OpenResponsesExtension[] {
  return [
    {
      id: DEEPSEEK_OPEN_RESPONSES_WEB_SEARCH_EXTENSION_ID,
      toolType: NAMESPACED_WEB_SEARCH_TOOL,
      itemTypes: [NAMESPACED_WEB_SEARCH_ITEM],
      eventTypes: [
        NAMESPACED_WEB_SEARCH_EVENTS.inProgress,
        NAMESPACED_WEB_SEARCH_EVENTS.searching,
        NAMESPACED_WEB_SEARCH_EVENTS.completed,
      ],
      encodeTool: encodeDeepSeekWebSearchTool,
      decodeItem: decodeDeepSeekWebSearchItem,
      encodeInputItem: (options) =>
        encodeDeepSeekWebSearchInputItem(options, NAMESPACED_WEB_SEARCH_ITEM),
      decodeEvent: decodeDeepSeekWebSearchEvent,
    },
  ];
}

/**
 * Allowlisted discriminator adapter. Namespaced registration stays in place
 * even if vercel/ai#19939 ships a flag-only `allowBareTypes`. Unknown types
 * are left untouched.
 */
export function wrapFetchForDeepSeekOpenResponsesExtensions(
  upstream: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const signal =
      init?.signal !== undefined
        ? init.signal
        : input instanceof Request
          ? input.signal
          : undefined;
    const headers = new Headers(request.headers);
    const rewrittenBody = await rewriteOutgoingRequestBody(request);
    if (rewrittenBody !== undefined) headers.delete('content-length');
    const response = await upstream(
      request.url,
      requestInit(request, headers, rewrittenBody ?? (await cloneOutgoingBody(request)), signal),
    );
    return rewriteIncomingResponse(response);
  };
}

export function rewriteDeepSeekOpenResponsesOutgoingBody(
  body: Record<string, unknown>,
): Record<string, unknown> | undefined {
  let next: Record<string, unknown> | undefined;
  const assign = (key: string, value: unknown) => {
    next ??= { ...body };
    next[key] = value;
  };
  if (Array.isArray(body.tools)) {
    const original = body.tools;
    const tools = original.map((tool) => rewriteMappedType(tool, OUTGOING_TOOL_TYPES));
    if (tools.some((tool, index) => tool !== original[index])) assign('tools', tools);
  }
  if (isRecord(body.tool_choice)) {
    const toolChoice = rewriteMappedType(body.tool_choice, OUTGOING_TOOL_TYPES);
    if (toolChoice !== body.tool_choice) assign('tool_choice', toolChoice);
  }
  if (Array.isArray(body.input)) {
    const original = body.input;
    const input = original.map((item) => rewriteMappedType(item, OUTGOING_TOOL_TYPES));
    if (input.some((item, index) => item !== original[index])) assign('input', input);
  }
  return next;
}

export function rewriteDeepSeekOpenResponsesIncomingValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteDeepSeekOpenResponsesIncomingValue(entry));
  }
  if (!isRecord(value)) return value;
  let next: Record<string, unknown> = value;
  const rewrittenType =
    mapType(value.type, INCOMING_EVENT_TYPES) ?? mapType(value.type, INCOMING_TOOL_TYPES);
  if (rewrittenType !== undefined && rewrittenType !== value.type) {
    next = { ...next, type: rewrittenType };
  }
  if (isRecord(next.item)) {
    const item = rewriteMappedType(next.item, INCOMING_TOOL_TYPES);
    if (item !== next.item) next = { ...next, item };
  }
  if (Array.isArray(next.output)) {
    next = {
      ...next,
      output: next.output.map((item) => rewriteMappedType(item, INCOMING_TOOL_TYPES)),
    };
  }
  if (isRecord(next.response)) {
    const response = rewriteDeepSeekOpenResponsesIncomingValue(next.response);
    if (response !== next.response) next = { ...next, response };
  }
  return next;
}

function encodeDeepSeekWebSearchTool(): JSONObject {
  // DeepSeek documents `{ type: "web_search" }` and ignores search_context_size
  // and user_location. The adapter supplies the registered tool type.
  return {};
}

function decodeDeepSeekWebSearchItem(options: {
  item: Experimental_OpenResponsesExtensionItem;
  mode: 'generate' | 'stream';
}): Experimental_OpenResponsesExtensionContentPart[] | undefined {
  const item = options.item;
  if (!isWebSearchCallType(item.type) || typeof item.id !== 'string' || item.id.length === 0) {
    return undefined;
  }
  if (typeof item.status !== 'string' || item.status.length === 0) return undefined;
  const action = jsonObject(item.action) ?? {};
  const toolCallId = item.id;
  const input = JSON.stringify(action);
  const result = jsonValue({
    type: WEB_SEARCH_ITEM,
    status: item.status,
    ...(Object.keys(action).length > 0 ? { action } : {}),
  });
  if (result === undefined) return undefined;
  const parts: Experimental_OpenResponsesExtensionContentPart[] = [
    {
      type: 'tool-call',
      toolCallId,
      toolName: NATIVE_WEB_SEARCH_TOOL_NAME,
      input,
      providerExecuted: true,
    },
  ];
  // Streaming materializes the call/result from `output_item.done`, so
  // non-terminal statuses stay as tool-input-start only. generate() has no
  // later item, so emit the result even for `in_progress` to keep doGenerate
  // callers on a complete provider-executed pair.
  if (item.status === 'completed' || item.status === 'failed' || options.mode === 'generate') {
    parts.push({
      type: 'tool-result',
      toolCallId,
      toolName: NATIVE_WEB_SEARCH_TOOL_NAME,
      result,
      // LanguageModelV4ToolResult carries providerExecuted; the extension
      // content-part union omits it on tool-results, so the codec type
      // needs this assertion. Maka drops provider-executed results unless
      // the flag is present (model-adapter translateChunk).
      providerExecuted: true,
      ...(item.status === 'failed' ? { isError: true } : {}),
    } as Experimental_OpenResponsesExtensionContentPart);
  }
  return parts;
}

function encodeDeepSeekWebSearchInputItem(
  options: {
    part: Experimental_OpenResponsesExtensionInputPart;
    tool: LanguageModelV4ProviderTool;
  },
  registeredItemType: string,
): Experimental_OpenResponsesExtensionItem | undefined {
  const part = options.part;
  if (part.type !== 'tool-call') return undefined;
  const stored =
    openResponsesExtensionReplayItem(part.providerOptions) ??
    openResponsesExtensionReplayItem((part as { providerMetadata?: unknown }).providerMetadata);
  if (stored && isWebSearchCallType(String(stored.type))) {
    return {
      ...stored,
      type: registeredItemType,
    } as Experimental_OpenResponsesExtensionItem;
  }
  // The SDK dedups extension input items on `${type}:${id}`. Distinct searches
  // must keep distinct item ids. Whether DeepSeek reuses `web_search_call` ids
  // across responses is unverified, so replay treats id uniqueness as a
  // request-history invariant.
  if (part.toolCallId.length === 0) return undefined;
  const action = actionFromToolInput(part.input);
  return {
    id: part.toolCallId,
    type: registeredItemType,
    status: 'completed',
    ...(action ? { action } : {}),
  } as Experimental_OpenResponsesExtensionItem;
}

function decodeDeepSeekWebSearchEvent(options: {
  event: { type: string; sequence_number: number } & JSONObject;
  state: Map<string, unknown>;
}): Experimental_OpenResponsesExtensionStreamPart[] | undefined {
  const eventType = String(options.event.type);
  if (
    eventType !== WEB_SEARCH_EVENTS.inProgress &&
    eventType !== NAMESPACED_WEB_SEARCH_EVENTS.inProgress
  ) {
    return [];
  }
  const itemId =
    typeof options.event.item_id === 'string'
      ? options.event.item_id
      : isRecord(options.event.item) && typeof options.event.item.id === 'string'
        ? options.event.item.id
        : undefined;
  if (!itemId) return undefined;
  if (options.state.get(itemId) === 'started') return [];
  options.state.set(itemId, 'started');
  return [
    {
      type: 'tool-input-start',
      id: itemId,
      toolName: NATIVE_WEB_SEARCH_TOOL_NAME,
      providerExecuted: true,
    },
  ];
}

function isWebSearchCallType(type: string): boolean {
  return type === WEB_SEARCH_ITEM || type === NAMESPACED_WEB_SEARCH_ITEM;
}

function actionFromToolInput(input: unknown): JSONObject | undefined {
  if (typeof input === 'string') {
    try {
      return jsonObject(JSON.parse(input));
    } catch {
      return undefined;
    }
  }
  return jsonObject(input);
}

function jsonObject(value: unknown): JSONObject | undefined {
  const json = jsonValue(value);
  return json !== null && typeof json === 'object' && !Array.isArray(json) ? json : undefined;
}

function jsonValue(value: unknown): JSONValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const items: JSONValue[] = [];
    for (const entry of value) {
      const json = jsonValue(entry);
      if (json === undefined) return undefined;
      items.push(json);
    }
    return items;
  }
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const result: Record<string, JSONValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    const json = jsonValue(entry);
    if (json === undefined) continue;
    result[key] = json;
  }
  return result;
}

function rewriteMappedType(
  value: unknown,
  table: ReadonlyMap<string, string>,
): Record<string, unknown> | unknown {
  if (!isRecord(value)) return value;
  const mapped = mapType(value.type, table);
  return mapped === undefined || mapped === value.type ? value : { ...value, type: mapped };
}

function mapType(type: unknown, table: ReadonlyMap<string, string>): string | undefined {
  return typeof type === 'string' ? table.get(type) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function rewriteOutgoingRequestBody(request: Request): Promise<string | undefined> {
  if (!requestHasJsonBody(request)) return undefined;
  const raw = await request.clone().arrayBuffer();
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const rewritten = rewriteDeepSeekOpenResponsesOutgoingBody(parsed);
  return rewritten === undefined ? undefined : JSON.stringify(rewritten);
}

async function cloneOutgoingBody(request: Request): Promise<BodyInit | null> {
  if (request.body === null) return null;
  const raw = await request.clone().arrayBuffer();
  // Keep JSON as text so callers that `JSON.parse(String(init.body))` still
  // work, and so a no-op wrap does not re-serialize the original payload.
  return requestHasJsonBody(request) ? new TextDecoder().decode(raw) : raw;
}

async function rewriteIncomingResponse(response: Response): Promise<Response> {
  const contentType = response.headers.get('content-type');
  if (isEventStream(contentType) && response.body) {
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    return new Response(rewriteSseStream(response.body), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  if (!isJsonContentType(contentType)) return response;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.clone().text());
  } catch {
    return response;
  }
  const rewritten = rewriteDeepSeekOpenResponsesIncomingValue(parsed);
  if (rewritten === parsed) return response;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(JSON.stringify(rewritten), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function rewriteSseStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '';
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          controller.enqueue(encoder.encode(`${rewriteSseLine(line)}\n`));
        }
      },
      flush(controller) {
        pending += decoder.decode();
        if (pending.length > 0) controller.enqueue(encoder.encode(rewriteSseLine(pending)));
      },
    }),
  );
}

function rewriteSseLine(line: string): string {
  const cr = line.endsWith('\r');
  const core = cr ? line.slice(0, -1) : line;
  if (!core.startsWith('data:')) return line;
  const payload = core.slice(5).trim();
  if (payload.length === 0 || payload === '[DONE]') return line;
  try {
    const rewritten = rewriteDeepSeekOpenResponsesIncomingValue(JSON.parse(payload));
    return `data: ${JSON.stringify(rewritten)}${cr ? '\r' : ''}`;
  } catch {
    return line;
  }
}

function requestHasJsonBody(request: Request): boolean {
  if (request.method === 'GET' || request.method === 'HEAD' || request.body === null) return false;
  return isJsonContentType(request.headers.get('content-type'));
}

function isJsonContentType(contentType: string | null): boolean {
  return (
    contentType === null || /(^|\s|;)application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(contentType)
  );
}

function isEventStream(contentType: string | null): boolean {
  return contentType !== null && /(^|\s|;)text\/event-stream(?:\s|;|$)/i.test(contentType);
}

function requestInit(
  request: Request,
  headers: Headers,
  body: BodyInit | null,
  signal: AbortSignal | null | undefined,
): RequestInit {
  return {
    method: request.method,
    headers: [...headers.entries()],
    ...(body === null ? {} : { body, duplex: 'half' }),
    signal,
    cache: request.cache,
    credentials: request.credentials,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
  } as RequestInit;
}
