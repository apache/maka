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

import { responseWithBody } from './http-response.js';

export interface OpenAiChatReasoningTransport {
  fetch: typeof globalThis.fetch;
  transformRequestBody: (body: Record<string, unknown>) => Record<string, unknown>;
}

export type OpenAiChatReasoningField = 'reasoning_content' | 'reasoning';

const EMPTY_REASONING_MARKER = '\0MAKA_OPENAI_CHAT_EMPTY_REASONING\0';

export interface OpenAiChatReasoningTransportState {
  reasoningField: OpenAiChatReasoningField;
  requestField: 'observed' | 'reasoning';
}

const MAKA_PROVIDER_OPTIONS_NAMESPACE = 'maka';

export function openAiChatReasoningFieldProviderOptions(
  field: OpenAiChatReasoningField,
): Record<string, Record<string, string>> {
  return { [MAKA_PROVIDER_OPTIONS_NAMESPACE]: { openAiChatReasoningField: field } };
}

export function openAiChatReasoningFieldFromProviderOptions(
  providerOptions: Record<string, unknown> | undefined,
): OpenAiChatReasoningField | undefined {
  const maka = providerOptions?.[MAKA_PROVIDER_OPTIONS_NAMESPACE];
  if (!isRecord(maka)) return undefined;
  const field = maka.openAiChatReasoningField ?? maka.kimiReasoningField;
  return field === 'reasoning' || field === 'reasoning_content' ? field : undefined;
}

export function createOpenAiChatReasoningTransportState(
  requestField: OpenAiChatReasoningTransportState['requestField'] = 'observed',
): OpenAiChatReasoningTransportState {
  return { reasoningField: 'reasoning_content', requestField };
}

export function restoreOpenAiChatEmptyReasoning(text: string): string {
  return text === EMPTY_REASONING_MARKER ? '' : text;
}

export function createOpenAiChatReasoningTransport(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  state: OpenAiChatReasoningTransportState = createOpenAiChatReasoningTransportState(),
  normalizeUsage = false,
): OpenAiChatReasoningTransport {
  return {
    fetch: async (input, init) =>
      normalizeOpenAiChatReasoningResponse(
        await fetchImpl(input, init),
        (observed) => {
          state.reasoningField = observed;
        },
        normalizeUsage,
      ),
    transformRequestBody: (body) =>
      replayAssistantReasoning(
        body,
        state.requestField === 'reasoning' ? 'reasoning' : state.reasoningField,
      ),
  };
}

async function normalizeOpenAiChatReasoningResponse(
  response: Response,
  observeReasoning: (field: OpenAiChatReasoningField) => void,
  normalizeUsage: boolean,
): Promise<Response> {
  if (!response.ok) return response;
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('text/event-stream') && response.body) {
    return responseWithBody(
      response,
      response.body.pipeThrough(openAiChatSseNormalizer(observeReasoning, normalizeUsage)),
    );
  }
  if (contentType.includes('application/json')) {
    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return responseWithBody(response, raw);
    }
    return responseWithBody(
      response,
      JSON.stringify(normalizeOpenAiChatPayload(parsed, observeReasoning, normalizeUsage)),
    );
  }
  return response;
}

function openAiChatSseNormalizer(
  observeReasoning: (field: OpenAiChatReasoningField) => void,
  normalizeUsage: boolean,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = '';
  return new TransformStream({
    transform(chunk, controller) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        controller.enqueue(
          encoder.encode(
            normalizeSseLine(buffered.slice(0, newline + 1), observeReasoning, normalizeUsage),
          ),
        );
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
      }
    },
    flush(controller) {
      buffered += decoder.decode();
      if (buffered) {
        controller.enqueue(
          encoder.encode(normalizeSseLine(buffered, observeReasoning, normalizeUsage)),
        );
      }
    },
  });
}

function normalizeSseLine(
  line: string,
  observeReasoning: (field: OpenAiChatReasoningField) => void,
  normalizeUsage: boolean,
): string {
  const newline = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '';
  const body = newline ? line.slice(0, -newline.length) : line;
  const match = /^(\s*data:\s*)(.*)$/.exec(body);
  if (!match || match[2] === '[DONE]') return line;
  try {
    return `${match[1]}${JSON.stringify(
      normalizeOpenAiChatPayload(JSON.parse(match[2]!), observeReasoning, normalizeUsage),
    )}${newline}`;
  } catch {
    return line;
  }
}

function normalizeOpenAiChatPayload(
  value: unknown,
  observeReasoning: (field: OpenAiChatReasoningField) => void,
  normalizeUsage: boolean,
): unknown {
  if (!isRecord(value)) return value;
  const normalizedValue = normalizeOpenAiChatReasoningFields(value, observeReasoning);
  if (!normalizeUsage) return normalizedValue;
  const nestedUsage = Array.isArray(normalizedValue.choices)
    ? normalizedValue.choices.find((choice) => isRecord(choice) && isRecord(choice.usage))
    : undefined;
  const usage = isRecord(normalizedValue.usage)
    ? normalizedValue.usage
    : isRecord(nestedUsage)
      ? nestedUsage.usage
      : undefined;
  if (!isRecord(usage)) return normalizedValue;
  const normalizedUsage = normalizeKimiUsage(usage);
  return normalizedValue.usage === normalizedUsage
    ? normalizedValue
    : { ...normalizedValue, usage: normalizedUsage };
}

function normalizeOpenAiChatReasoningFields(
  payload: Record<string, unknown>,
  observe: (field: OpenAiChatReasoningField) => void,
): Record<string, unknown> {
  if (!Array.isArray(payload.choices)) return payload;
  let changed = false;
  const choices = payload.choices.map((choice) => {
    if (!isRecord(choice)) return choice;
    let normalizedChoice = choice;
    for (const key of ['message', 'delta'] as const) {
      const carrier: unknown = choice[key];
      if (!isRecord(carrier)) continue;
      const field =
        typeof carrier.reasoning_content === 'string'
          ? 'reasoning_content'
          : typeof carrier.reasoning === 'string'
            ? 'reasoning'
            : undefined;
      if (!field) continue;
      observe(field);
      if (carrier[field] !== '') continue;
      normalizedChoice = {
        ...normalizedChoice,
        [key]: { ...carrier, [field]: EMPTY_REASONING_MARKER },
      };
      changed = true;
    }
    return normalizedChoice;
  });
  return changed ? { ...payload, choices } : payload;
}

function replayAssistantReasoning(
  body: Record<string, unknown>,
  field: OpenAiChatReasoningField,
): Record<string, unknown> {
  if (!Array.isArray(body.messages)) return body;
  let changed = false;
  const messages = body.messages.map((value) => {
    if (!isRecord(value) || value.role !== 'assistant') return value;
    if (typeof value.reasoning_content !== 'string') return value;
    const restoredReasoning = restoreOpenAiChatEmptyReasoning(value.reasoning_content);
    if (field === 'reasoning_content') {
      if (restoredReasoning === value.reasoning_content) return value;
      changed = true;
      return { ...value, reasoning_content: restoredReasoning };
    }
    const { reasoning_content: _reasoningContent, ...message } = value;
    changed = true;
    return { ...message, reasoning: restoredReasoning };
  });
  return changed ? { ...body, messages } : body;
}

function normalizeKimiUsage(usage: Record<string, unknown>): Record<string, unknown> {
  if (typeof usage.cached_tokens !== 'number') return usage;
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  if (typeof details.cached_tokens === 'number') return usage;
  return {
    ...usage,
    prompt_tokens_details: { ...details, cached_tokens: usage.cached_tokens },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
