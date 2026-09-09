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

import { RetryError } from 'ai';
import { MODEL_FAILURE_MESSAGE_MAX_BYTES } from '@maka/core/model-failure';
import { truncateUtf8 } from '@maka/core/diagnostic-log';
import { isAuthenticationErrorText } from '@maka/core/redaction';
import type { ModelFailure, ModelFailureKind } from './model-protocol.js';

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

const PROVIDER_UNAVAILABLE_PROVIDER_CODES: ReadonlySet<string> = new Set([
  'server_error', // OpenAI-compatible stream errors can omit the HTTP status.
]);
const OPENAI_CODEX_EDGE_REJECTION_CODE = 'openai_codex_edge_rejection';

// Node, TLS, and undici codes that identify transport failures before an HTTP response.
const TRANSPORT_FAILURE_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/**
 * xAI emits this code for transient model capacity failures, including when
 * the same payload is relayed through an OpenAI-compatible gateway. Do not
 * add the generic gRPC/Google `resource_exhausted` spelling here: that code
 * represents quota exhaustion and needs different user guidance.
 */
const PROVIDER_CAPACITY_CODES: ReadonlySet<string> = new Set(['resource-exhausted']);

/**
 * Structured provider error identifiers that mean an ACCOUNT-level usage or
 * billing condition — exhausted credits or a closed plan/quota window —
 * rather than an invalid credential. Providers disagree on which HTTP status
 * travels with them (402, 401/403, even 429); the structured code is the
 * stable evidence, so it outranks every numeric fallback below.
 */
const PROVIDER_BILLING_PROVIDER_CODES: ReadonlySet<string> = new Set([
  'insufficient_quota', // OpenAI & OpenAI-compatible: error.code
  'insufficient_balance', // DeepSeek: error.code
  'quota_exceeded', // OpenAI-compatible variants: error.code
]);

/**
 * Free-text usage/billing wording that overrides a credential-shaped HTTP
 * status (401/403): some providers report exhausted plan windows, credits,
 * or subscriptions through auth-style statuses for validly signed-in users,
 * and "Authentication failed" would send them to re-authenticate (#2516).
 * Matched only on that status branch, so genuine throttles keep their
 * RateLimit path and plain invalid-key / permission messages — which carry
 * none of this vocabulary — still project to Auth.
 */
const USAGE_LIMIT_TEXT_PATTERNS: readonly RegExp[] = [
  /\bquota\b/i,
  /usage limit/i,
  /plan (?:limit|allowance)/i,
  /(?:credit|balance|allowance)[^.]{0,40}(?:exhaust|reached)|exhaust[^.]{0,20}(?:credit|balance)/i,
  /subscription/i,
];

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
  /** Structured provider identifiers (code/type), lowercased. */
  structuredCodes: string[];
  /** Structured pre-response transport evidence from SDK metadata or cause codes. */
  transportFailure: boolean;
}

interface ProviderErrorFacts {
  aborted?: boolean;
  target: unknown;
  evidence: ProviderErrorEvidence;
  summarySources: ProviderFailureSources;
  bareMessage?: string;
  responseHeaders?: Record<string, string>;
}

/** Bounded, allowlisted provider failure facts safe for durable telemetry. */
export interface ProviderFailureDiagnostic {
  errorClass: ModelFailureKind;
  httpStatus?: number;
  providerCode?: string;
  providerRequestId?: string;
  retryable: boolean;
}

interface ProviderFailureSummary {
  message: string;
  code?: string;
}

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

function isTransportFailure(target: unknown, statusCode: string): boolean {
  if (statusCode) return false;
  const record = objectRecord(target);
  if (!record) return false;
  if (
    target instanceof Error &&
    target.name === 'AI_APICallError' &&
    safeField(record, 'isRetryable') === true
  ) {
    return true;
  }

  let current: unknown = target;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 5 && current !== undefined && !seen.has(current); depth += 1) {
    seen.add(current);
    const currentRecord = objectRecord(current);
    if (!currentRecord) return false;
    const code = safeField(currentRecord, 'code');
    if (
      typeof code === 'string' &&
      (TRANSPORT_FAILURE_CODES.has(code) ||
        code.startsWith('ERR_SSL_') ||
        code.startsWith('ERR_TLS_') ||
        code.startsWith('UND_ERR_'))
    ) {
      return true;
    }
    current = safeField(currentRecord, 'cause');
  }
  return false;
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

function retryMetadataFromFacts(
  facts: ProviderErrorFacts,
  errorClass = classifyProviderFacts(facts),
): Pick<ModelFailure, 'retryable' | 'retryAfterMs'> {
  if (facts.aborted) return { retryable: false };
  const { evidence } = facts;

  if (RUNTIME_RETRYABLE_ERROR_CODES.has(evidence.code)) return { retryable: true };
  // The Codex transport already spent its complete 2/10/30-second budget.
  // Do not let the outer model loop restart that same transport budget.
  if (isTrustedCodexEdgeRejection(facts)) return { retryable: false };

  const status = Number(evidence.statusCode || evidence.code);
  const retryAfterMs = parseRetryAfterMs(facts.responseHeaders ?? {});
  if (errorClass === 'provider_capacity') {
    // Capacity is transient even when the provider sends a malformed delay;
    // fall back to the adapter's bounded local backoff in that case.
    return {
      retryable: true,
      ...(retryAfterMs !== undefined && retryAfterMs !== null ? { retryAfterMs } : {}),
    };
  }
  if (errorClass === 'rate_limit' || status === 429) {
    if (retryAfterMs === undefined || retryAfterMs === null) return { retryable: false };
    return { retryable: true, retryAfterMs };
  }
  const retryable =
    errorClass === 'network' ||
    errorClass === 'provider_unavailable' ||
    status === 408 ||
    status === 409 ||
    (status >= 500 && status <= 599);
  if (!retryable) return { retryable: false };
  if (retryAfterMs === null) return { retryable: false };
  return {
    retryable: true,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

/** Collects `code`/`type` strings from a payload and from its `error` wrapper. */
function collectStructuredCodes(payload: unknown, out: string[]): void {
  const fromRecord = (record: Record<string, unknown> | undefined) => {
    if (!record) return;
    for (const key of ['code', 'type'] as const) {
      const value = safeField(record, key);
      if (typeof value === 'string' && value) out.push(value.toLowerCase());
    }
  };
  const record = providerRecord(payload);
  fromRecord(record);
  fromRecord(record ? providerRecord(safeField(record, 'error')) : undefined);
}

function normalizeProviderError(error: unknown): ProviderErrorFacts | undefined {
  const target = providerErrorTarget(error);
  if (target instanceof Error) {
    const responseHeaders = responseHeadersFromError(target);
    const record = target as unknown as Record<string, unknown>;
    const field = (key: string): string => {
      const value = safeField(record, key);
      return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    };
    const code = field('code');
    const statusCode = field('statusCode') || field('status');
    const rawBody = (target as { responseBody?: unknown }).responseBody;
    const body = typeof rawBody === 'string' ? rawBody : '';
    const structuredCodes: string[] = [];
    collectStructuredCodes((target as { data?: unknown }).data, structuredCodes);
    if (structuredCodes.length === 0 && body) {
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
        transportFailure: isTransportFailure(target, statusCode),
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
      evidence: {
        text: target.toLowerCase(),
        statusCode: '',
        code: '',
        structuredCodes,
        transportFailure: false,
      },
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
    const statusCode = field('statusCode') || field('status');
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
        statusCode,
        code: field('code'),
        structuredCodes,
        transportFailure: isTransportFailure(target, statusCode),
      },
      summarySources: providerFailureSources(target),
      ...(responseHeaders ? { responseHeaders } : {}),
    };
  }
  return undefined;
}

function failureSummaryFromFacts(facts: ProviderErrorFacts): ProviderFailureSummary | undefined {
  const sources = facts.summarySources;
  const message = firstProviderMessage(facts);
  const code = firstProviderField(sources, ['code']) ?? firstProviderField(sources, ['type']);
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
    MODEL_FAILURE_MESSAGE_MAX_BYTES - Buffer.byteLength(suffix, 'utf8'),
  );
  const summary = `${truncateUtf8(
    message ?? 'Provider request failed',
    messageBudget,
    '…',
  )}${suffix}`;
  return {
    message: truncateUtf8(summary, MODEL_FAILURE_MESSAGE_MAX_BYTES, '…'),
    ...(code || statusCode ? { code: code ?? statusCode } : {}),
  };
}

/**
 * Projects provider errors into a small durable fingerprint. Unlike the
 * presentation summary, this intentionally excludes provider messages and
 * response bodies: free text can echo prompts or credentials.
 */
export function providerFailureDiagnostic(error: unknown): ProviderFailureDiagnostic {
  const facts = extractProviderErrorFacts(error);
  if (!facts) return { errorClass: 'unknown', retryable: false };
  const sources = facts.summarySources;
  const httpStatus = providerHttpStatus(facts);
  const errorClass = classifyProviderFacts(facts);
  const providerCode =
    firstProviderField(sources, ['code']) ?? firstProviderField(sources, ['type']);
  const providerRequestId =
    firstProviderField(sources, ['requestId', 'request_id']) ??
    boundedProviderField(facts.responseHeaders?.['x-request-id']);
  return {
    errorClass,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(providerCode !== undefined ? { providerCode } : {}),
    ...(providerRequestId !== undefined ? { providerRequestId } : {}),
    retryable: retryMetadataFromFacts(facts, errorClass).retryable,
  };
}

function extractProviderErrorFacts(error: unknown): ProviderErrorFacts | undefined {
  if (RetryError.isInstance(error) && error.reason === 'abort') {
    const facts = normalizeProviderError(error);
    return facts ? { ...facts, aborted: true } : undefined;
  }
  let current = providerErrorTarget(error);
  let fallback: ProviderErrorFacts | undefined;
  let codedFallback: ProviderErrorFacts | undefined;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 4 && current !== undefined && !seen.has(current); depth += 1) {
    seen.add(current);
    const facts = normalizeProviderError(current);
    fallback ??= facts;
    if (facts && (facts.evidence.statusCode || facts.evidence.structuredCodes.length > 0)) {
      return facts;
    }
    if (facts?.evidence.code) codedFallback ??= facts;
    current =
      current && typeof current === 'object'
        ? safeField(current as Record<string, unknown>, 'cause')
        : undefined;
  }
  return codedFallback ?? fallback;
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
  const sources = facts.summarySources;
  const candidates = [
    ...sources.records.map((source) => safeField(source, 'message')),
    ...sources.stringErrors,
  ];
  return candidates
    .map((candidate) => boundedProviderMessage(candidate))
    .find((value) => value !== undefined);
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
  return truncateUtf8(normalized, PROVIDER_FAILURE_FIELD_MAX_BYTES, '…');
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
  return truncateUtf8(normalized, MODEL_FAILURE_MESSAGE_MAX_BYTES, '…');
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
 * normalized evidence (Error, string, or plain stream-error-part object): an
 * explicit RetryError abort → known transport codes → the provider's
 * structured capacity and overflow codes → numeric HTTP fallbacks →
 * vetoable free-text relations → generic 5xx → weak word heuristics. Exact
 * provider evidence outranks generic HTTP/text evidence because gateways can
 * wrap a provider failure in a misleading status or message; the weak
 * heuristics rank last so "generate" can never become a rate limit.
 */
export function providerModelFailure(error: unknown): ModelFailure {
  const facts = extractProviderErrorFacts(error);
  const kind = facts ? classifyProviderFacts(facts) : 'unknown';
  const summary = facts ? failureSummaryFromFacts(facts) : undefined;
  const retry = facts ? retryMetadataFromFacts(facts, kind) : { retryable: false };
  return {
    type: 'model_failure',
    kind,
    ...retry,
    ...(summary?.code !== undefined ? { code: summary.code } : {}),
    message: summary?.message ?? 'Model request failed',
  };
}

export function classifyError(error: unknown): ModelFailureKind {
  const facts = extractProviderErrorFacts(error);
  return facts ? classifyProviderFacts(facts) : 'unknown';
}

function classifyProviderFacts(facts: ProviderErrorFacts): ModelFailureKind {
  if (facts.aborted) return 'abort';
  const { evidence } = facts;
  const { text, statusCode, code, structuredCodes } = evidence;
  const normalizedCode = code.toLowerCase();
  if (code === OPENAI_RESPONSES_WEBSOCKET_TRANSPORT_ERROR) return 'network';
  if (
    PROVIDER_CAPACITY_CODES.has(normalizedCode) ||
    structuredCodes.some((c) => PROVIDER_CAPACITY_CODES.has(c))
  ) {
    return 'provider_capacity';
  }
  // Structured provider evidence: the parsed error JSON's code/type is the
  // only unconditional signal for a context overflow.
  if (structuredCodes.some((c) => CONTEXT_OVERFLOW_PROVIDER_CODES.has(c)))
    return 'context_overflow';
  if (
    PROVIDER_BILLING_PROVIDER_CODES.has(normalizedCode) ||
    structuredCodes.some((c) => PROVIDER_BILLING_PROVIDER_CODES.has(c))
  ) {
    return 'provider_billing';
  }
  if (text.includes('abort')) return 'abort';
  if (statusCode === '402' || code === '402') return 'provider_billing';
  if (statusCode === '429' || code === '429') return 'rate_limit';
  if (
    structuredCodes.includes(OPENAI_CODEX_EDGE_REJECTION_CODE) &&
    isTrustedCodexEdgeRejection(facts)
  ) {
    return 'provider_unavailable';
  }
  if (statusCode === '401' || statusCode === '403' || code === '401' || code === '403') {
    // Credential-shaped statuses can still carry account-level usage
    // evidence: an exhausted plan/credit window for a validly signed-in
    // user must not tell them to re-authenticate (#2516).
    if (USAGE_LIMIT_TEXT_PATTERNS.some((pattern) => pattern.test(text))) {
      return 'provider_billing';
    }
    return 'auth';
  }
  if (statusCode === '413' || code === '413') return 'context_overflow';
  // Free-text overflow relations on the composite text, veto-first inside.
  if (isContextOverflowErrorText(text)) return 'context_overflow';
  if (/^5\d\d$/.test(statusCode) || /^5\d\d$/.test(code)) return 'provider_unavailable';
  if (structuredCodes.some((c) => PROVIDER_UNAVAILABLE_PROVIDER_CODES.has(c))) {
    return 'provider_unavailable';
  }
  if (evidence.transportFailure) return 'network';
  if (isTruncatedStreamText(text)) return 'stream_truncated';
  const httpStatus = providerHttpStatus(facts);
  if (httpStatus === 408) return 'timeout';
  if (httpStatus !== undefined && httpStatus >= 500 && httpStatus <= 599) {
    return 'provider_unavailable';
  }
  if (httpStatus !== undefined && httpStatus >= 400 && httpStatus <= 499) {
    return 'request_rejected';
  }
  // Weak word heuristics, last: they only catch errors that carried no
  // stronger evidence for any other class. `rate` must be word-shaped
  // ("generate"/"separate" are not rate limits) while still matching the
  // rate_limit/RateLimitError identifier spellings.
  if (/\brate\b|rate[_-]?limit/.test(text)) return 'rate_limit';
  if (isAuthenticationErrorText(text)) return 'auth';
  if (text.includes('timeout')) return 'timeout';
  if (
    text.includes('network') ||
    text.includes('fetch') ||
    /\btypeerror\b.*\bterminated\b/.test(text)
  )
    return 'network';
  return 'unknown';
}

function isTruncatedStreamText(text: string): boolean {
  return (
    text.includes('response stream ended without a finish reason') ||
    text.includes('model stream ended without a finish chunk') ||
    (text.includes('stream disconnected before completion') &&
      text.includes('stream closed before response.completed'))
  );
}

function providerHttpStatus(facts: ProviderErrorFacts): number | undefined {
  const raw =
    facts.evidence.statusCode || firstProviderField(facts.summarySources, ['statusCode', 'status']);
  const numeric = Number(raw);
  return Number.isInteger(numeric) && numeric >= 100 && numeric <= 599 ? numeric : undefined;
}

function isTrustedCodexEdgeRejection(facts: ProviderErrorFacts): boolean {
  let current: unknown = facts.target;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 5 && current !== undefined && !seen.has(current); depth += 1) {
    seen.add(current);
    if (current instanceof Error && current.name === 'OpenAiCodexEdgeRejectionError') return true;
    current =
      typeof current === 'object' && current !== null
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}
