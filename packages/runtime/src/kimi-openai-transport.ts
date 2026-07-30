interface KimiOpenAiTransport {
  fetch: typeof globalThis.fetch;
  transformRequestBody: (body: Record<string, unknown>) => Record<string, unknown>;
}

export type KimiReasoningField = 'reasoning_content' | 'reasoning';

const EMPTY_REASONING_MARKER = '\0MAKA_KIMI_EMPTY_REASONING\0';

export interface KimiOpenAiTransportState {
  reasoningField: KimiReasoningField;
}

const MAKA_PROVIDER_OPTIONS_NAMESPACE = 'maka';

export function kimiReasoningFieldProviderOptions(
  field: KimiReasoningField,
): Record<string, Record<string, string>> {
  return { [MAKA_PROVIDER_OPTIONS_NAMESPACE]: { kimiReasoningField: field } };
}

export function kimiReasoningFieldFromProviderOptions(
  providerOptions: Record<string, unknown> | undefined,
): KimiReasoningField | undefined {
  const maka = providerOptions?.[MAKA_PROVIDER_OPTIONS_NAMESPACE];
  if (!isRecord(maka)) return undefined;
  return maka.kimiReasoningField === 'reasoning' || maka.kimiReasoningField === 'reasoning_content'
    ? maka.kimiReasoningField
    : undefined;
}

export function createKimiOpenAiTransportState(): KimiOpenAiTransportState {
  return { reasoningField: 'reasoning_content' };
}

export function restoreKimiEmptyReasoning(text: string): string {
  return text === EMPTY_REASONING_MARKER ? '' : text;
}

export function createKimiOpenAiTransport(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  state: KimiOpenAiTransportState = createKimiOpenAiTransportState(),
): KimiOpenAiTransport {
  return {
    fetch: async (input, init) =>
      normalizeKimiOpenAiResponse(await fetchImpl(input, init), (observed) => {
        state.reasoningField = observed;
      }),
    transformRequestBody: (body) => replayAssistantReasoning(body, state.reasoningField),
  };
}

async function normalizeKimiOpenAiResponse(
  response: Response,
  observeReasoning: (field: KimiReasoningField) => void,
): Promise<Response> {
  if (!response.ok) return response;
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('text/event-stream') && response.body) {
    return responseWithBody(
      response,
      response.body.pipeThrough(kimiSseNormalizer(observeReasoning)),
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
      JSON.stringify(normalizeKimiPayload(parsed, observeReasoning)),
    );
  }
  return response;
}

function kimiSseNormalizer(
  observeReasoning: (field: KimiReasoningField) => void,
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
          encoder.encode(normalizeSseLine(buffered.slice(0, newline + 1), observeReasoning)),
        );
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
      }
    },
    flush(controller) {
      buffered += decoder.decode();
      if (buffered) {
        controller.enqueue(encoder.encode(normalizeSseLine(buffered, observeReasoning)));
      }
    },
  });
}

function normalizeSseLine(
  line: string,
  observeReasoning: (field: KimiReasoningField) => void,
): string {
  const newline = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '';
  const body = newline ? line.slice(0, -newline.length) : line;
  const match = /^(\s*data:\s*)(.*)$/.exec(body);
  if (!match || match[2] === '[DONE]') return line;
  try {
    return `${match[1]}${JSON.stringify(normalizeKimiPayload(JSON.parse(match[2]!), observeReasoning))}${newline}`;
  } catch {
    return line;
  }
}

function normalizeKimiPayload(
  value: unknown,
  observeReasoning: (field: KimiReasoningField) => void,
): unknown {
  if (!isRecord(value)) return value;
  const normalizedValue = normalizeKimiReasoningFields(value, observeReasoning);
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

function normalizeKimiReasoningFields(
  payload: Record<string, unknown>,
  observe: (field: KimiReasoningField) => void,
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
  field: KimiReasoningField,
): Record<string, unknown> {
  if (!Array.isArray(body.messages)) return body;
  let changed = false;
  const messages = body.messages.map((value) => {
    if (!isRecord(value) || value.role !== 'assistant') return value;
    if (typeof value.reasoning_content !== 'string') return value;
    const restoredReasoning = restoreKimiEmptyReasoning(value.reasoning_content);
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

function responseWithBody(response: Response, body: BodyInit): Response {
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
