import { RetryError } from 'ai';
import { truncateUtf8 } from '@maka/core/diagnostic-log';
import { isProviderFailureClass, type ProviderFailureResult } from '@maka/core/provider-failure';
import { isAuthenticationErrorText, redactSecrets } from '@maka/core/redaction';

/**
 * Structured provider error identifiers that mean the INPUT exceeded the
 * model's context window. These come from the provider's error JSON and are
 * the ONLY unconditional overflow evidence: free-text signals are vetoable.
 */
const CONTEXT_OVERFLOW_PROVIDER_CODES: ReadonlySet<string> = new Set([
  'context_length_exceeded', // OpenAI & OpenAI-compatible: error.code
  'model_context_window_exceeded', // z.ai: error.code
  'request_too_large', // Anthropic byte-size overflow (HTTP 413): error.type
]);

/** Stable account-state meanings exposed by provider-owned structured fields. */
const PROVIDER_AUTH_CODES: ReadonlySet<string> = new Set([
  'authentication',
  'authentication_error',
  'invalid_api_key',
]);
const PROVIDER_BILLING_CODES: ReadonlySet<string> = new Set([
  'insufficient_quota',
  'payment_required',
]);
const PROVIDER_PERMISSION_CODES: ReadonlySet<string> = new Set(['permission_denied']);
const PROVIDER_USAGE_LIMIT_CODES: ReadonlySet<string> = new Set(['usage_limit_reached']);
const PROVIDER_RATE_LIMIT_CODES: ReadonlySet<string> = new Set([
  'rate_limit_error',
  'rate_limit_exceeded',
  'rate_limited',
]);
const PROVIDER_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  'overloaded_error',
  'provider_overloaded',
  'provider_unavailable',
]);

/**
 * A provider failure normalized into classification evidence. classifyError's
 * real input domain is NOT just Error instances: a request-level failure is
 * an AI SDK `APICallError` (provider JSON parsed in `data`, raw in
 * `responseBody`; no top-level `.code`), while an in-stream error part
 * carries the provider's parsed error VALUE — OpenAI Chat emits the inner
 * `{message, type?, code?}` object, OpenAI Responses the whole
 * `{type:'error', error:{type, code, message}}` chunk, Anthropic the inner
 * `{type, message}` object, and openai-compatible a bare message string.
 * Shapes read from the provider sources, never invented.
 */
interface ProviderErrorEvidence {
  /** Lowercased composite of the textual fields, for pattern evidence. */
  text: string;
  /** Explicit HTTP status from a field ('' when absent) — never a substring. */
  statusCode: string;
  /** Top-level code field as a string ('' when absent). */
  code: string;
  /** Structured provider identifiers (code/type/error_type/provider_code), lowercased. */
  structuredCodes: string[];
}

interface ProviderErrorFacts {
  target: unknown;
  evidence: ProviderErrorEvidence;
  summarySources: ProviderFailureSources;
  messageSources?: ProviderFailureSources;
  boundedProviderMessageSource?: boolean;
  bareMessage?: string;
  responseHeaders?: Record<string, string>;
}

export interface ProviderRetryMetadata {
  retryable: boolean;
  retryAfterMs?: number;
}

/** Bounded provider facts safe for durable telemetry (no presentation text). */
export type ProviderFailureDiagnostic = Pick<
  ProviderFailureResult,
  'errorClass' | 'httpStatus' | 'providerCode' | 'providerRequestId' | 'retryable'
>;

interface ProviderFailureSummary {
  message: string;
  code?: string;
}

interface ProviderFailureSummaryEvidence extends ProviderFailureSummary {
  boundedProviderMessage: boolean;
}

const PROVIDER_FAILURE_SUMMARY_MAX_BYTES = 2 * 1024;
const PROVIDER_FAILURE_FIELD_MAX_BYTES = 256;

const MAX_SAFE_TIMER_DELAY_MS = 2_147_483_647;
const OPENAI_RESPONSES_WEBSOCKET_TRANSPORT_ERROR = 'OPENAI_RESPONSES_WEBSOCKET_TRANSPORT_ERROR';
const RUNTIME_RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  OPENAI_RESPONSES_WEBSOCKET_TRANSPORT_ERROR,
  'OPENAI_RESPONSES_CONTINUATION_UNAVAILABLE',
]);

function providerErrorTarget(error: unknown): unknown {
  return RetryError.isInstance(error) && error.lastError !== undefined && error.lastError !== error
    ? error.lastError
    : error;
}

function responseHeadersFromError(error: unknown): Record<string, string> | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = (error as { responseHeaders?: unknown }).responseHeaders;
  if (typeof value !== 'object' || value === null) return undefined;
  const headers: Record<string, string> = {};
  for (const [key, header] of Object.entries(value)) {
    if (typeof header === 'string') headers[key.toLowerCase()] = header;
  }
  return headers;
}

function parseRetryAfterMs(headers: Record<string, string>): number | null | undefined {
  const rawMilliseconds = headers['retry-after-ms'];
  const rawRetryAfter = headers['retry-after'];
  if (rawMilliseconds === undefined && rawRetryAfter === undefined) return undefined;

  let delayMs: number;
  if (rawMilliseconds !== undefined) {
    delayMs = Number(rawMilliseconds);
  } else {
    const seconds = Number(rawRetryAfter);
    delayMs = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(rawRetryAfter!) - Date.now();
  }
  if (!Number.isFinite(delayMs) || delayMs <= 0 || delayMs > MAX_SAFE_TIMER_DELAY_MS) return null;
  return Math.ceil(delayMs);
}

/**
 * Normalizes provider retry facts without leaking SDK error objects or raw
 * response headers across the ModelAdapter boundary.
 */
export function providerRetryMetadata(error: unknown): ProviderRetryMetadata {
  const facts = providerFailureDiagnosticFacts(error);
  if (!facts) return { retryable: false };
  return providerRetryMetadataFromFacts(facts);
}

function providerRetryMetadataFromFacts(facts: ProviderErrorFacts): ProviderRetryMetadata {
  const { evidence } = facts;

  if (RUNTIME_RETRYABLE_ERROR_CODES.has(evidence.code)) return { retryable: true };

  const status = Number(evidence.statusCode || evidence.code);
  const errorClass = classifyProviderFacts(facts);
  // Account state cannot be repaired by immediately repeating the same
  // physical request, even when a provider reports it through HTTP 429.
  if (
    errorClass === 'Auth' ||
    errorClass === 'ProviderBilling' ||
    errorClass === 'ProviderPermission' ||
    errorClass === 'UsageLimit' ||
    errorClass === 'ContextLength'
  ) {
    return { retryable: false };
  }
  const retryAfterMs = parseRetryAfterMs(facts.responseHeaders ?? {});
  if (errorClass === 'RateLimit' || status === 429) {
    if (retryAfterMs === undefined || retryAfterMs === null) return { retryable: false };
    return { retryable: true, retryAfterMs };
  }
  const sdkRetryable =
    typeof facts.target === 'object' &&
    facts.target !== null &&
    typeof (facts.target as { isRetryable?: unknown }).isRetryable === 'boolean'
      ? (facts.target as { isRetryable: boolean }).isRetryable
      : undefined;
  const retryable =
    sdkRetryable ??
    (errorClass === 'Network' ||
      status === 408 ||
      status === 409 ||
      (status >= 500 && status <= 599));
  if (!retryable) return { retryable: false };
  if (retryAfterMs === null) return { retryable: false };
  return {
    retryable: true,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

/** Collects stable identifiers from the provider envelopes Maka receives. */
function collectStructuredCodes(payload: unknown, out: string[]): void {
  const fromRecord = (record: Record<string, unknown> | undefined) => {
    if (!record) return;
    for (const key of ['code', 'type', 'error_type', 'provider_code'] as const) {
      const value = safeField(record, key);
      if (typeof value === 'string' && value) out.push(value.toLowerCase());
    }
  };
  const record = providerRecord(payload);
  fromRecord(record);
  if (!record) return;
  fromRecord(providerRecord(safeField(record, 'metadata')));
  const error = providerRecord(safeField(record, 'error'));
  fromRecord(error);
  fromRecord(error ? providerRecord(safeField(error, 'metadata')) : undefined);
  const response = providerRecord(safeField(record, 'response'));
  fromRecord(response);
  const responseError = response ? providerRecord(safeField(response, 'error')) : undefined;
  fromRecord(responseError);
  fromRecord(responseError ? providerRecord(safeField(responseError, 'metadata')) : undefined);
}

function normalizeProviderError(error: unknown): ProviderErrorFacts | undefined {
  const target = providerErrorTarget(error);
  if (target instanceof Error) {
    const responseHeaders = responseHeadersFromError(target);
    const code = 'code' in target ? String((target as { code?: unknown }).code) : '';
    const statusCode =
      'statusCode' in target
        ? String((target as { statusCode?: unknown }).statusCode)
        : 'status' in target
          ? String((target as { status?: unknown }).status)
          : '';
    const rawBody = (target as { responseBody?: unknown }).responseBody;
    const body = typeof rawBody === 'string' ? rawBody : '';
    const structuredCodes: string[] = [];
    collectStructuredCodes(target, structuredCodes);
    collectStructuredCodes((target as { data?: unknown }).data, structuredCodes);
    if (body) {
      // The failed-response handler keeps the raw body even when the provider
      // JSON failed the schema (which is exactly when `data` is absent).
      try {
        collectStructuredCodes(JSON.parse(body), structuredCodes);
      } catch {
        // Not JSON — no structured evidence.
      }
    }
    return {
      target,
      // The raw body joins the text evidence: when the provider JSON fails
      // the error schema, `message` degrades to the statusText and the body
      // is the ONLY carrier of the provider's wording (e.g. an
      // OpenAI-compatible `{error: string}` overflow). Positives and vetoes
      // both run over the same full text.
      evidence: {
        text: `${target.name} ${code} ${statusCode} ${target.message}${body ? ` ${body}` : ''}`.toLowerCase(),
        statusCode,
        code,
        structuredCodes,
      },
      summarySources: providerFailureSources(target),
      ...(responseHeaders ? { responseHeaders } : {}),
    };
  }
  if (typeof target === 'string') {
    const parsed = parsedProviderValue(target);
    const structuredCodes: string[] = [];
    if (parsed !== undefined) collectStructuredCodes(parsed, structuredCodes);
    return {
      target,
      evidence: { text: target.toLowerCase(), statusCode: '', code: '', structuredCodes },
      summarySources: providerFailureSources(parsed),
      ...(parsed === undefined
        ? { bareMessage: target }
        : typeof parsed === 'string'
          ? { bareMessage: parsed }
          : {}),
    };
  }
  if (typeof target === 'object' && target !== null) {
    const record = target as Record<string, unknown>;
    const responseHeaders = responseHeadersFromError(target);
    const field = (key: string): string => {
      const value = record[key];
      return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    };
    const structuredCodes: string[] = [];
    collectStructuredCodes(record, structuredCodes);
    const rawBody = safeField(record, 'responseBody');
    if (typeof rawBody === 'string') {
      const parsedBody = parsedProviderValue(rawBody);
      if (parsedBody !== undefined) collectStructuredCodes(parsedBody, structuredCodes);
    }
    let text: string;
    try {
      // Serialize the whole value so message/code text is evidence no matter
      // which of the known provider shapes carried it.
      text = JSON.stringify(target).toLowerCase();
    } catch {
      text = String(target).toLowerCase();
    }
    return {
      target,
      evidence: {
        text,
        statusCode: field('statusCode') || field('status'),
        code: field('code'),
        structuredCodes,
      },
      summarySources: providerFailureSources(target),
      ...(responseHeaders ? { responseHeaders } : {}),
    };
  }
  return undefined;
}

/**
 * Retains only allowlisted provider failure fields. The provider value may also
 * contain request bodies, headers, or credentials, so it must never be copied
 * or serialized as diagnostic output wholesale.
 */
export function providerFailureSummary(error: unknown): ProviderFailureSummary | undefined {
  const facts = providerFailureDiagnosticFacts(error);
  if (!facts) return undefined;
  const summary = providerFailureSummaryFromFacts(facts);
  if (!summary) return undefined;
  return {
    message: summary.message,
    ...(summary.code !== undefined ? { code: summary.code } : {}),
  };
}

function providerFailureSummaryFromFacts(
  facts: ProviderErrorFacts,
): ProviderFailureSummaryEvidence | undefined {
  const sources = facts.summarySources;
  const message = firstProviderMessage(facts);
  const code = strongestProviderCode(facts);
  const statusCode = firstProviderField(sources, ['statusCode', 'status']);
  const requestId =
    firstProviderField(sources, ['requestId', 'request_id']) ??
    boundedProviderField(facts.responseHeaders?.['x-request-id']);
  const metadata = [
    ...(code ? [`code=${code}`] : []),
    ...(statusCode && statusCode !== code ? [`status=${statusCode}`] : []),
    ...(requestId ? [`requestId=${requestId}`] : []),
  ];
  if (!message && metadata.length === 0) return undefined;
  const suffix = metadata.length > 0 ? ` (${metadata.join(', ')})` : '';
  const messageBudget = Math.max(
    1,
    PROVIDER_FAILURE_SUMMARY_MAX_BYTES - Buffer.byteLength(suffix, 'utf8'),
  );
  const summary = `${truncateUtf8(
    redactSecrets(message ?? 'Provider request failed'),
    messageBudget,
    '…',
  )}${suffix}`;
  return {
    message: truncateUtf8(summary, PROVIDER_FAILURE_SUMMARY_MAX_BYTES, '…'),
    ...(code || statusCode ? { code: code ?? statusCode } : {}),
    boundedProviderMessage: message !== undefined && hasProviderMessageSource(facts),
  };
}

/**
 * Projects provider errors into a small durable fingerprint. Unlike the
 * presentation summary, this intentionally excludes provider messages and
 * response bodies: even redacted free text can echo prompts or credentials.
 */
export function providerFailureDiagnostic(error: unknown): ProviderFailureDiagnostic {
  const failure = providerFailureResult(error);
  return {
    errorClass: failure.errorClass,
    ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}),
    ...(failure.providerCode !== undefined ? { providerCode: failure.providerCode } : {}),
    ...(failure.providerRequestId !== undefined
      ? { providerRequestId: failure.providerRequestId }
      : {}),
    retryable: failure.retryable,
  };
}

/** The single structured provider-failure authority for Runtime consumers. */
export function providerFailureResult(error: unknown): ProviderFailureResult {
  if (RetryError.isInstance(error) && error.reason === 'abort') {
    return { errorClass: 'Abort', retryable: false };
  }
  const facts = providerFailureDiagnosticFacts(error);
  if (!facts) return { errorClass: 'Other', retryable: false };
  const sources = facts.summarySources;
  const rawStatus =
    facts.evidence.statusCode || firstProviderField(sources, ['statusCode', 'status']);
  const numericStatus = Number(rawStatus);
  const httpStatus =
    Number.isInteger(numericStatus) && numericStatus >= 100 && numericStatus <= 599
      ? numericStatus
      : undefined;
  const classified = classifyProviderFacts(facts);
  const errorClass = normalizedProviderFailureClass(
    classified === 'Auth' &&
      httpStatus !== undefined &&
      httpStatus !== 401 &&
      !facts.evidence.structuredCodes.some((value) => PROVIDER_AUTH_CODES.has(value))
      ? 'Other'
      : classified,
    httpStatus,
  );
  const providerCode = strongestProviderCode(facts);
  const providerRequestId =
    firstProviderField(sources, ['requestId', 'request_id']) ??
    boundedProviderField(facts.responseHeaders?.['x-request-id']);
  const retry = providerRetryMetadataFromFacts(facts);
  const summary = providerFailureSummaryFromFacts(facts);
  return {
    errorClass,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(providerCode !== undefined ? { providerCode } : {}),
    ...(providerRequestId !== undefined ? { providerRequestId } : {}),
    retryable: retry.retryable,
    ...(retry.retryAfterMs !== undefined ? { retryAfterMs: retry.retryAfterMs } : {}),
    ...(summary?.boundedProviderMessage === true
      ? {
          message: summary.message,
          boundedProviderMessage: true as const,
        }
      : {}),
  };
}

function strongestProviderCode(facts: ProviderErrorFacts): string | undefined {
  const semantic = facts.evidence.structuredCodes.find(
    (value) =>
      PROVIDER_AUTH_CODES.has(value) ||
      PROVIDER_BILLING_CODES.has(value) ||
      PROVIDER_PERMISSION_CODES.has(value) ||
      PROVIDER_USAGE_LIMIT_CODES.has(value) ||
      PROVIDER_RATE_LIMIT_CODES.has(value) ||
      PROVIDER_UNAVAILABLE_CODES.has(value) ||
      CONTEXT_OVERFLOW_PROVIDER_CODES.has(value),
  );
  return (
    boundedProviderField(semantic) ??
    firstProviderField(facts.summarySources, ['code']) ??
    firstProviderField(facts.summarySources, ['type'])
  );
}

function normalizedProviderFailureClass(
  classified: string,
  httpStatus: number | undefined,
): ProviderFailureResult['errorClass'] {
  // The semantic class already includes structured provider identifiers and
  // therefore outranks the transport status used only as a fallback.
  if (isProviderFailureClass(classified) && classified !== 'Other') return classified;
  if (httpStatus === 401) return 'Auth';
  if (httpStatus === 402) return 'ProviderBilling';
  if (httpStatus === 408) return 'Timeout';
  if (httpStatus === 413) return 'ContextLength';
  if (httpStatus === 429) return 'RateLimit';
  if (httpStatus !== undefined && httpStatus >= 400 && httpStatus <= 499) {
    return 'RequestRejected';
  }
  if (httpStatus !== undefined && httpStatus >= 500 && httpStatus <= 599) {
    return 'ProviderUnavailable';
  }
  return 'Other';
}

function providerFailureDiagnosticFacts(error: unknown): ProviderErrorFacts | undefined {
  let current = providerErrorTarget(error);
  const chain: ProviderErrorFacts[] = [];
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 4 && current !== undefined && !seen.has(current); depth += 1) {
    seen.add(current);
    const facts = normalizeProviderError(current);
    if (facts) chain.push(facts);
    current =
      current && typeof current === 'object'
        ? safeField(current as Record<string, unknown>, 'cause')
        : undefined;
  }
  if (chain.length === 0) return undefined;

  // Provider semantics can sit below an SDK/transport wrapper that also owns
  // the HTTP status. Aggregate the bounded cause chain instead of letting the
  // first status-bearing object discard stronger structured codes. Provider
  // sources are ordered inner-first for message/code projection; transport
  // status and retry hints remain available as fallback evidence.
  const providerFirst = [...chain].reverse();
  const messageFacts = providerFirst.filter((facts) => hasProviderMessageSource(facts));
  const responseHeaders = Object.assign({}, ...chain.map((facts) => facts.responseHeaders ?? {})) as
    | Record<string, string>
    | undefined;
  const bareMessage = messageFacts.find((facts) => facts.bareMessage)?.bareMessage;
  return {
    target: chain[0]!.target,
    evidence: {
      text: chain.map((facts) => facts.evidence.text).join(' '),
      statusCode: chain.find((facts) => facts.evidence.statusCode)?.evidence.statusCode ?? '',
      code: chain.find((facts) => facts.evidence.code)?.evidence.code ?? '',
      structuredCodes: [...new Set(chain.flatMap((facts) => facts.evidence.structuredCodes))],
    },
    summarySources: {
      records: providerFirst.flatMap((facts) => facts.summarySources.records),
      stringErrors: providerFirst.flatMap((facts) => facts.summarySources.stringErrors),
    },
    messageSources: {
      records: messageFacts.flatMap((facts) => facts.summarySources.records),
      stringErrors: messageFacts.flatMap((facts) => facts.summarySources.stringErrors),
    },
    boundedProviderMessageSource: messageFacts.length > 0,
    ...(bareMessage ? { bareMessage } : {}),
    ...(responseHeaders && Object.keys(responseHeaders).length > 0 ? { responseHeaders } : {}),
  };
}

interface ProviderFailureSources {
  records: readonly Record<string, unknown>[];
  stringErrors: readonly unknown[];
}

function providerFailureSources(error: unknown): ProviderFailureSources {
  const record = objectRecord(error);
  if (!record) return { records: [], stringErrors: [] };
  const data = objectRecord(safeField(record, 'data'));
  const nestedError = providerRecord(safeField(record, 'error'));
  const dataError = providerRecord(data ? safeField(data, 'error') : undefined);
  const parsedBody = parsedProviderBody(safeField(record, 'responseBody'));
  const parsedBodyError = providerRecord(parsedBody ? safeField(parsedBody, 'error') : undefined);
  return {
    records: [dataError, data, parsedBodyError, parsedBody, nestedError, record].filter(
      (source): source is Record<string, unknown> => source !== undefined,
    ),
    stringErrors: [
      data ? safeField(data, 'error') : undefined,
      parsedBody ? safeField(parsedBody, 'error') : undefined,
      safeField(record, 'error'),
    ],
  };
}

function providerRecord(value: unknown): Record<string, unknown> | undefined {
  return objectRecord(typeof value === 'string' ? (parsedProviderValue(value) ?? value) : value);
}

function firstProviderMessage(facts: ProviderErrorFacts): string | undefined {
  if (facts.bareMessage !== undefined) return boundedProviderMessage(facts.bareMessage);
  const sources = facts.messageSources ?? facts.summarySources;
  const candidates = [
    ...sources.records.map((source) => safeField(source, 'message')),
    ...sources.stringErrors,
  ];
  return candidates
    .map((candidate) => boundedProviderMessage(candidate))
    .find((value) => value !== undefined);
}

function hasProviderMessageSource(facts: ProviderErrorFacts): boolean {
  if (facts.boundedProviderMessageSource !== undefined) {
    return facts.boundedProviderMessageSource;
  }
  if (!(facts.target instanceof Error)) return true;
  const targetRecord = objectRecord(facts.target);
  return (
    facts.summarySources.records.some(
      (source) =>
        source !== targetRecord &&
        boundedProviderMessage(safeField(source, 'message')) !== undefined,
    ) ||
    facts.summarySources.stringErrors.some(
      (candidate) => boundedProviderMessage(candidate) !== undefined,
    )
  );
}

function firstProviderField(
  sources: ProviderFailureSources,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    for (const source of sources.records) {
      const value = boundedProviderField(safeField(source, key));
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function parsedProviderBody(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined;
  return objectRecord(parsedProviderValue(value));
}

function parsedProviderValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeField(record: Record<string, unknown>, key: string): unknown {
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

function boundedProviderField(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const normalized = String(value).trim();
  if (!normalized) return undefined;
  return truncateUtf8(redactSecrets(normalized), PROVIDER_FAILURE_FIELD_MAX_BYTES, '…');
}

function boundedProviderMessage(value: unknown, parseJson = true): string | undefined {
  if (typeof value !== 'string') return undefined;
  let normalized = value.trim();
  if (!normalized) return undefined;
  if (parseJson) {
    const parsed = parsedProviderValue(normalized);
    if (parsed !== undefined) {
      if (typeof parsed === 'string') {
        normalized = parsed.trim();
      } else {
        const sources = providerFailureSources(parsed);
        const candidates = [
          ...sources.records.map((source) => safeField(source, 'message')),
          ...sources.stringErrors,
        ];
        return candidates
          .map((candidate) => boundedProviderMessage(candidate, false))
          .find((candidate) => candidate !== undefined);
      }
    }
  }
  if (!normalized) return undefined;
  return truncateUtf8(redactSecrets(normalized), PROVIDER_FAILURE_SUMMARY_MAX_BYTES, '…');
}

/**
 * Provider context-length overflow signatures. A request-level 400/413 whose
 * message matches one of these means the input exceeded the model's context
 * window — the reactive-recovery trigger (issue #882 PR 2). The set is ported
 * from pi's battle-tested table and covers the providers Maka ships in its
 * registry (Anthropic, OpenAI/-compatible, Google, xAI, Groq, OpenRouter,
 * Mistral, MiniMax, Kimi/Moonshot, Together, llama.cpp/LM Studio/Ollama, …).
 * Matched against the ORIGINAL error's composite fields (name, code, status,
 * message), never the generalized string. All of these are free-text evidence
 * and can be vetoed by NON_CONTEXT_OVERFLOW_PATTERNS: a capacity statement or
 * overflow phrase quoted inside a throttling/quota error must not trigger
 * recovery — only a structured provider code is unconditional.
 */
const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /prompt is too long/i, // Anthropic token overflow
  /request_too_large/i, // Anthropic request byte-size overflow (HTTP 413)
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI (Completions & Responses)
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))?/i, // OpenAI-compatible proxies (LiteLLM)
  /input token count.*exceeds the maximum/i, // Google (Gemini)
  /maximum prompt length is \d+/i, // xAI (Grok)
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter (most backends)
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
  // GitHub Copilot: "prompt token count of X exceeds the limit of Y". The INPUT
  // subject is required — a bare "token count of N exceeds the limit of M" also
  // matches output/completion caps, and a bare "exceeds the limit of N" matches
  // file-size and other quota errors; neither is fixable by history compaction.
  /(?:prompt|input|context|message)[^.]{0,80}token count of [\d,]+ exceeds the limit of [\d,]+/i,
  /exceeds the available context size/i, // llama.cpp server
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi For Coding
  /too large for model with \d+ maximum context length/i, // Mistral
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // DS4 server
  /model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
  /prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow error
  /context[_ ]length[_ ]exceeded/i, // OpenAI structured error code (also generic)
  // Ambiguous token-limit wording that is an input overflow only when an
  // input-like word is the subject. `request` is deliberately NOT in the
  // subject list: it appears in generic prefixes ("Invalid request: ...")
  // without saying anything about which side of the token budget overflowed.
  /(?:prompt|input|context|message)[^.]{0,80}too many tokens/i,
  /(?:prompt|input|context|message)[^.]{0,80}token limit exceeded/i,
];

/**
 * Wording that looks token-shaped but is NOT an input overflow: throttling /
 * quota / rate limiting, and complete OUTPUT-cap relations in every observed
 * permutation of role word (output/completion/max_tokens) and token
 * predicate — subject before predicate ("completion has too many tokens",
 * "max_tokens token limit exceeded"), predicate before subject ("too many
 * tokens were requested for the completion"), the count-of form ("output
 * token count of N exceeds"), the role word embedded inside the phrase
 * ("too many completion tokens were requested"), and the role-tokens-exceed
 * form ("Maximum completion tokens exceeded"). Noun phrases alone (e.g.
 * "completion token count") are not excluded: they also appear as usage
 * breakdowns inside genuine input-overflow messages, and "(prompt +
 * completion) exceed" combined-budget wording stays classifiable because the
 * role word is not adjacent to "tokens".
 */
const NON_CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /rate limit/i,
  /too many requests/i,
  /throttl/i,
  /quota/i,
  /(?:output|completion|max_tokens)\b[^.]{0,60}(?:too many tokens|token limit exceeded)/i,
  /(?:too many tokens|token limit exceeded)[^.]{0,60}\b(?:output|completion|max_tokens)/i,
  /(?:output|completion)\s+token\s+(?:count|limit)[^.]{0,40}exceed/i,
  /too many (?:output|completion|max_tokens)[^.]{0,20}tokens/i,
  /\b(?:output|completion|max_tokens)\s+tokens?\b[^.]{0,20}exceed/i,
];

/**
 * Two-layer overflow detection on an error's raw text (the composite of its
 * original name/code/status/message). Triggering recovery requires positive
 * evidence of an INPUT overflow — the one class history compaction can fix:
 * 1. Vetoes first: throttling/quota wording and complete output-cap relations
 *    disqualify every free-text signal. Free text is never unconditional — a
 *    capacity statement quoted inside a throttle error is not an overflow.
 * 2. Positive overflow relations count only when nothing vetoed. Structured
 *    provider codes (the unconditional evidence) are classifyError's job,
 *    checked before this text layer ever runs.
 */
export function isContextOverflowErrorText(text: string): boolean {
  if (!text) return false;
  if (NON_CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Classifies a provider error by DESCENDING evidence strength over the
 * normalized evidence (Error, string, or plain stream-error-part object):
 * abort wrapper → structured account state → the provider's structured
 * overflow code → text/status fallbacks (abort, 402, 429, 401; numeric fields,
 * never substrings) → bare 413
 * (HTTP: request entity too large — itself input-side evidence, Cerebras sends it with no body) →
 * vetoable free-text overflow relations → generic 5xx → weak word
 * heuristics. Specific overflow evidence outranks a generic 5xx because
 * proxies (LiteLLM) wrap provider overflows in 503s; the weak heuristics
 * rank last so "generate" can never become a rate limit.
 */
export function classifyError(error: unknown): string {
  if (RetryError.isInstance(error) && error.reason === 'abort') return 'Abort';
  const facts = providerFailureDiagnosticFacts(error);
  return facts ? classifyProviderFacts(facts) : 'Other';
}

function classifyProviderFacts(facts: ProviderErrorFacts): string {
  const { target: classificationTarget, evidence } = facts;
  const { text, statusCode, code, structuredCodes } = evidence;
  if (code === OPENAI_RESPONSES_WEBSOCKET_TRANSPORT_ERROR) return 'Network';
  if (structuredCodes.some((value) => PROVIDER_AUTH_CODES.has(value))) return 'Auth';
  if (structuredCodes.some((value) => PROVIDER_BILLING_CODES.has(value))) return 'ProviderBilling';
  if (structuredCodes.some((value) => PROVIDER_PERMISSION_CODES.has(value)))
    return 'ProviderPermission';
  if (structuredCodes.some((value) => PROVIDER_USAGE_LIMIT_CODES.has(value))) return 'UsageLimit';
  if (structuredCodes.some((value) => PROVIDER_RATE_LIMIT_CODES.has(value))) return 'RateLimit';
  if (structuredCodes.some((value) => PROVIDER_UNAVAILABLE_CODES.has(value)))
    return 'ProviderUnavailable';
  // The provider's structured context code is unconditional input-overflow
  // evidence. It outranks outer transport status and message fallbacks.
  if (structuredCodes.some((c) => CONTEXT_OVERFLOW_PROVIDER_CODES.has(c))) return 'ContextLength';
  if (text.includes('abort')) return 'Abort';
  if (statusCode === '402' || code === '402') return 'ProviderBilling';
  if (statusCode === '429' || code === '429') return 'RateLimit';
  if (statusCode === '401' || code === '401') return 'Auth';
  // A bare 403 is intentionally unknown: providers use it for valid-key
  // permission failures, guardrails, subscription limits, and occasionally
  // authentication. The provider's bounded diagnostic remains available.
  if (statusCode === '413' || code === '413') return 'ContextLength';
  // Free-text overflow relations on the composite text, veto-first inside.
  if (isContextOverflowErrorText(text)) return 'ContextLength';
  if (/^5\d\d$/.test(statusCode) || /^5\d\d$/.test(code)) return 'ProviderUnavailable';
  // Weak word heuristics remain as compatibility fallbacks after all stronger
  // provider facts. They must not override a structured account state.
  if (/\brate\b|rate[_-]?limit/.test(text)) return 'RateLimit';
  if (isAuthenticationErrorText(text)) return 'Auth';
  if (text.includes('timeout')) return 'Timeout';
  if (
    text.includes('network') ||
    text.includes('fetch') ||
    /\btypeerror\b.*\bterminated\b/.test(text)
  )
    return 'Network';
  return classificationTarget instanceof Error ? classificationTarget.name || 'Other' : 'Other';
}

export function errorPresentationFromClass(errorClass: string): {
  reason?: string;
  message?: string;
} {
  switch (errorClass) {
    case 'ContextLength':
      return { reason: 'context_overflow', message: 'Context window exceeded' };
    case 'Timeout':
      return { reason: 'timeout', message: 'Request timed out' };
    case 'Auth':
      return { reason: 'auth', message: 'Authentication failed' };
    case 'ProviderBilling':
      return { reason: 'provider_billing', message: 'Provider billing required' };
    case 'ProviderPermission':
      return { reason: 'provider_permission', message: 'Provider access denied' };
    case 'ProviderUnavailable':
      return { reason: 'provider_unavailable', message: 'Provider returned an error' };
    case 'RateLimit':
      return { reason: 'rate_limit', message: 'Rate limit exceeded' };
    case 'UsageLimit':
      return { reason: 'usage_limit', message: 'Usage limit reached' };
    case 'Network':
      return { reason: 'network', message: 'Network error' };
    default:
      return {};
  }
}
