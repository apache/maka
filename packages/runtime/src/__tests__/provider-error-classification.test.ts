import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createJsonErrorResponseHandler } from '@ai-sdk/provider-utils';
import { RetryError } from 'ai';
import { z } from 'zod/v4';

import { classifyError, errorPresentationFromClass } from '../provider-error-classification.js';

describe('Provider error classification', () => {
  test('classifies provider context-length overflow errors as ContextLength', () => {
    const overflow = (message: string, extra: Record<string, unknown> = {}) =>
      classifyError(Object.assign(new Error(message), { name: 'AI_APICallError', ...extra }));

    // A representative sample across the providers Maka supports.
    assert.equal(
      overflow('prompt is too long: 213462 tokens > 200000 maximum', { statusCode: 400 }),
      'ContextLength',
    ); // Anthropic
    assert.equal(
      overflow('413 request_too_large: Request exceeds the maximum size', { statusCode: 413 }),
      'ContextLength',
    ); // Anthropic 413
    assert.equal(
      overflow('Your input exceeds the context window of this model', { statusCode: 400 }),
      'ContextLength',
    ); // OpenAI
    assert.equal(
      overflow(
        "Requested token count exceeds the model's maximum context length of 131072 tokens",
        { statusCode: 400 },
      ),
      'ContextLength',
    ); // LiteLLM
    assert.equal(
      overflow(
        'The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)',
        { statusCode: 400 },
      ),
      'ContextLength',
    ); // Google
    assert.equal(
      overflow(
        "This model's maximum prompt length is 131072 but the request contains 537812 tokens",
        { statusCode: 400 },
      ),
      'ContextLength',
    ); // xAI
    assert.equal(
      overflow('Please reduce the length of the messages or completion', { statusCode: 400 }),
      'ContextLength',
    ); // Groq
    assert.equal(
      overflow("This endpoint's maximum context length is 262144 tokens", { statusCode: 400 }),
      'ContextLength',
    ); // OpenRouter
    assert.equal(
      overflow(
        'Prompt contains 5000 tokens; too large for model with 4096 maximum context length',
        { statusCode: 400 },
      ),
      'ContextLength',
    ); // Mistral
    assert.equal(
      overflow('invalid params, context window exceeds limit', { statusCode: 400 }),
      'ContextLength',
    ); // MiniMax
    assert.equal(
      overflow('Your request exceeded model token limit: 200000 (requested: 260000)', {
        statusCode: 400,
      }),
      'ContextLength',
    ); // Kimi
    assert.equal(
      overflow('prompt token count of 21000 exceeds the limit of 16384', { statusCode: 400 }),
      'ContextLength',
    ); // GitHub Copilot
    assert.equal(
      overflow('the prompt contains too many tokens', { statusCode: 400 }),
      'ContextLength',
    ); // generic prompt-overflow wording

    // The classification covers the ORIGINAL error fields, not just the message.
    // A real AI SDK APICallError carries the provider's structured error JSON in
    // `data` (parsed by createJsonErrorResponseHandler) or `responseBody` — there
    // is NO top-level `.code` — so a structured code with a generic HTTP message
    // must classify from those fields (review round-7 P1-1).
    assert.equal(
      overflow('Bad Request', {
        statusCode: 400,
        data: {
          error: {
            message: 'Bad Request',
            type: 'invalid_request_error',
            code: 'context_length_exceeded',
          },
        },
      }),
      'ContextLength',
    );
    // Same provider JSON reachable only through the raw response body. The
    // body must be a shape the OpenAI errorSchema genuinely REJECTS (here:
    // missing the required error.message), because that is the only way a
    // real createJsonErrorResponseHandler leaves `data` absent while keeping
    // `responseBody` — a schema-valid body always produces `data` (round-8 P3).
    assert.equal(
      overflow('Bad Request', {
        statusCode: 400,
        responseBody: '{"error":{"code":"context_length_exceeded"}}',
      }),
      'ContextLength',
    );
    // Anthropic puts the structured identifier in data.error.type.
    assert.equal(
      overflow('Request Entity Too Large', {
        statusCode: 413,
        data: {
          type: 'error',
          error: { type: 'request_too_large', message: 'Request Entity Too Large' },
        },
      }),
      'ContextLength',
    );

    // Stream error parts are NOT Error instances: each provider enqueues its
    // parsed error value as `{type:'error', error}` on the stream, and the
    // classifier must accept the real shapes (review round-8 P1-1):
    // OpenAI Chat emits the INNER error object (openai-chat-language-model.ts:479)…
    assert.equal(
      classifyError({
        message: 'Bad Request',
        type: 'invalid_request_error',
        param: null,
        code: 'context_length_exceeded',
      }),
      'ContextLength',
    );
    // …OpenAI Responses emits the WHOLE error chunk (openai-responses-language-model.ts:2105)…
    assert.equal(
      classifyError({
        type: 'error',
        sequence_number: 3,
        error: {
          type: 'invalid_request_error',
          code: 'context_length_exceeded',
          message: 'Bad Request',
          param: null,
        },
      }),
      'ContextLength',
    );
    // …Anthropic emits the inner {type, message} object (anthropic-messages-language-model.ts:2441)…
    assert.equal(
      classifyError({
        type: 'invalid_request_error',
        message: 'prompt is too long: 213462 tokens > 200000 maximum',
      }),
      'ContextLength',
    );
    assert.equal(
      classifyError({ type: 'request_too_large', message: 'Request exceeds the maximum size' }),
      'ContextLength',
    );
    // …and openai-compatible emits a bare message STRING (openai-compatible-chat-language-model.ts:466).
    assert.equal(
      classifyError(
        "Requested token count exceeds the model's maximum context length of 131072 tokens.",
      ),
      'ContextLength',
    );
    // Non-overflow object/string errors do not become ContextLength.
    assert.equal(
      classifyError({ type: 'invalid_request_error', message: 'missing required field' }),
      'Other',
    );

    // Specific overflow evidence outranks a generic 5xx (review round-8 P1-2):
    // LiteLLM-style proxies surface a provider overflow through a 503 wrapper,
    // both as a structured code and as message text (pi overflow fixture).
    assert.equal(
      overflow('Service Unavailable', {
        statusCode: 503,
        data: { error: { message: 'Service Unavailable', code: 'context_length_exceeded' } },
      }),
      'ContextLength',
    );
    assert.equal(
      overflow(
        "503 litellm.ServiceUnavailableError: litellm.MidStreamFallbackError: litellm.APIConnectionError: APIConnectionError: OpenAIException - Requested token count exceeds the model's maximum context length of 131072 tokens.",
        { statusCode: 503 },
      ),
      'ContextLength',
    );
    // A bare 413 with no body is itself input-side evidence: HTTP request
    // entity too large (Cerebras returns exactly this — review round-8 P1-3).
    assert.equal(overflow('Request Entity Too Large', { statusCode: 413 }), 'ContextLength');
    assert.equal(overflow('Payload Too Large', { statusCode: 413 }), 'ContextLength');
    assert.equal(overflow('', { statusCode: 413 }), 'ContextLength');
    // A structured code embedded in free text must not be misread by a weaker
    // substring heuristic checked earlier: "generate" contains "rate", and the
    // rate/auth substring heuristics rank BELOW overflow evidence (round-7 P1-2).
    assert.equal(
      overflow('Failed to generate response: context_length_exceeded', { statusCode: 400 }),
      'ContextLength',
    );
    // Explicit numeric statuses still outrank every text heuristic: a 5xx that
    // happens to mention rate stays ProviderUnavailable.
    assert.equal(
      overflow('Please rate limit your requests', { statusCode: 503 }),
      'ProviderUnavailable',
    );
    // The weak rate heuristic is word-shaped, not a substring: "generate" and
    // "separate" are not rate limits (review round-8 P2)…
    assert.notEqual(overflow('Failed to generate response', { statusCode: 400 }), 'RateLimit');
    assert.notEqual(
      overflow('Unable to separate response chunks', { statusCode: 400 }),
      'RateLimit',
    );
    // …while genuine rate wording without an explicit 429 still classifies.
    assert.equal(overflow('Please rate limit your requests', {}), 'RateLimit');
    assert.equal(overflow('rate_limit_exceeded: slow down', {}), 'RateLimit');

    // Exclusion-first: throttling/rate-limit wording must NOT be read as overflow
    // even when it superficially mentions tokens.
    assert.equal(
      overflow('Rate limit reached: too many tokens, please wait before trying again', {
        statusCode: 429,
      }),
      'RateLimit',
    );
    assert.notEqual(
      overflow('ThrottlingException: too many tokens, please wait before trying again', {
        statusCode: 400,
      }),
      'ContextLength',
    );
    // Unrelated 400s stay in their own buckets, never ContextLength: a token-free
    // size limit and an output-parameter error merely mention limits/tokens, and
    // misreading either would run (and persist) a pointless compaction + retry.
    assert.notEqual(
      overflow('invalid request: missing required field', { statusCode: 400 }),
      'ContextLength',
    );
    assert.notEqual(
      overflow('file size exceeds the limit of 10485760', { statusCode: 400 }),
      'ContextLength',
    );
    assert.notEqual(
      overflow('max_tokens is too many tokens for this model', { statusCode: 400 }),
      'ContextLength',
    );
    // An OUTPUT token cap is not an input overflow: compacting the history
    // cannot fix it, so it must never trigger a persisted compaction retry.
    assert.notEqual(overflow('Output token limit exceeded', { statusCode: 400 }), 'ContextLength');
    assert.notEqual(
      overflow('Maximum output token limit exceeded', { statusCode: 400 }),
      'ContextLength',
    );
    assert.notEqual(
      overflow('output token count of 8192 exceeds the limit of 4096', { statusCode: 400 }),
      'ContextLength',
    );
    assert.notEqual(
      overflow('completion token count of 8192 exceeds the limit of 4096', { statusCode: 400 }),
      'ContextLength',
    );
    assert.notEqual(
      overflow('max output token count of 8192 exceeds the limit of 4096', { statusCode: 400 }),
      'ContextLength',
    );
    // A generic prefix must not smuggle an output cap past the input-subject
    // constraints ("request" in "Invalid request:" is not the token subject):
    // output caps are excluded at the exclusion-first owner, wording-wide.
    assert.notEqual(
      overflow('Invalid request: output token count of 8192 exceeds the limit of 4096', {
        statusCode: 400,
      }),
      'ContextLength',
    );
    assert.notEqual(
      overflow('Invalid request: completion token count of 8192 exceeds the limit of 4096', {
        statusCode: 400,
      }),
      'ContextLength',
    );
    assert.notEqual(
      overflow('Invalid request: max output token count of 8192 exceeds the limit of 4096', {
        statusCode: 400,
      }),
      'ContextLength',
    );
    assert.notEqual(
      overflow('Invalid request: max_tokens is too many tokens for this model', {
        statusCode: 400,
      }),
      'ContextLength',
    );
    assert.notEqual(
      overflow('Invalid request: Maximum output token limit exceeded', { statusCode: 400 }),
      'ContextLength',
    );
    // Complete output-cap RELATIONS are excluded even when reworded — the
    // veto is not a fixed word order.
    assert.notEqual(
      overflow('Invalid request: completion has too many tokens for this model', {
        statusCode: 400,
      }),
      'ContextLength',
    );
    assert.notEqual(
      overflow('Invalid request: max_tokens token limit exceeded', { statusCode: 400 }),
      'ContextLength',
    );
    // ...including the passive voice, where the output subject FOLLOWS the
    // token predicate (review round-7 P1-3).
    assert.notEqual(
      overflow('Invalid input: too many tokens were requested for the completion', {
        statusCode: 400,
      }),
      'ContextLength',
    );
    // ...and the embedded-role permutation, where the output word sits INSIDE
    // the token phrase — even when a capacity statement follows in the same
    // message (review round-8 P1-4).
    assert.notEqual(
      overflow(
        "Too many completion tokens were requested. This endpoint's maximum context length is 262144 tokens.",
        { statusCode: 400 },
      ),
      'ContextLength',
    );
    assert.notEqual(
      overflow('Too many output tokens requested for this model', { statusCode: 400 }),
      'ContextLength',
    );
    assert.notEqual(
      overflow(
        "Maximum completion tokens exceeded. This endpoint's maximum context length is 262144 tokens.",
        { statusCode: 400 },
      ),
      'ContextLength',
    );
    // A bare capacity STATEMENT inside an unrelated error is not an overflow
    // relation: throttle/quota wording vetoes every free-text signal — only a
    // structured provider code is unconditional (review round-7 P1-4).
    assert.notEqual(
      overflow(
        "ThrottlingException: quota exceeded. This endpoint's maximum context length is 262144 tokens.",
        { statusCode: 400 },
      ),
      'ContextLength',
    );
    // ...while the input-side form of the same wording still classifies.
    assert.equal(
      overflow('Input token limit exceeded: 250000 tokens > 200000 maximum', { statusCode: 400 }),
      'ContextLength',
    );
    // The output-cap exclusions stay adjacency-tight: OpenAI's classic input
    // overflow mentions the completion and max_tokens without being an output
    // cap, and must keep classifying.
    assert.equal(
      overflow(
        "This model's maximum context length is 8192 tokens. However, you requested 10240 tokens (10140 in the messages, 100 in the completion). Please reduce the length of the messages or completion.",
        { statusCode: 400 },
      ),
      'ContextLength',
    );
    assert.equal(
      overflow(
        "This model's maximum context length is 8192 tokens. However, you requested 10240 tokens (10140 in the messages, 100 in max_tokens). Please reduce the length of the messages or completion.",
        { statusCode: 400 },
      ),
      'ContextLength',
    );
    // Structured provider evidence is the ONLY unconditional signal: a genuine
    // input overflow may word its message as an output-cap relation the text
    // vetoes would reject, and the context_length_exceeded code must still win.
    assert.equal(
      overflow('Invalid request: completion has too many tokens for this model', {
        statusCode: 400,
        data: {
          error: {
            message: 'Invalid request: completion has too many tokens for this model',
            code: 'context_length_exceeded',
          },
        },
      }),
      'ContextLength',
    );
    assert.equal(
      classifyError(Object.assign(new Error('401 Authorization'), { statusCode: 401 })),
      'Auth',
    );
  });

  test('classifies overflow wording that only survives in a schema-invalid responseBody (review round-9 P2)', async () => {
    // The REAL failed-response handler, with the OpenAI-family error schema
    // (error must be an OBJECT with a message). When the provider body does
    // not match — `{error: string}` genuinely exists among OpenAI-compatible
    // providers — the handler degrades `message` to the statusText and keeps
    // the provider's wording ONLY in `responseBody`.
    const handler = createJsonErrorResponseHandler({
      errorSchema: z.object({ error: z.object({ message: z.string() }) }),
      errorToMessage: (data) => data.error.message,
    });
    const errorFromBody = async (body: string) =>
      (
        await handler({
          response: new Response(body, { status: 400, statusText: 'Bad Request' }),
          url: 'https://api.example.test/v1/chat/completions',
          requestBodyValues: {},
        })
      ).value;

    const overflowError = await errorFromBody(
      '{"error":"Your input exceeds the context window of this model"}',
    );
    // Prove the degradation is real before asserting on classification.
    assert.equal(overflowError.message, 'Bad Request');
    assert.equal(overflowError.data, undefined);
    assert.equal(classifyError(overflowError), 'ContextLength');
    // The veto layer runs on the same full text: an output-cap relation in the
    // body must not classify even with a capacity statement next to it.
    const outputCapError = await errorFromBody(
      '{"error":"Too many completion tokens were requested. This endpoint\'s maximum context length is 262144 tokens."}',
    );
    assert.notEqual(classifyError(outputCapError), 'ContextLength');
  });

  test('preserves provider evidence through the official AI SDK retry wrapper', async () => {
    const handler = createJsonErrorResponseHandler({
      errorSchema: z.object({
        error: z.object({
          message: z.string(),
          code: z.string().optional(),
        }),
      }),
      errorToMessage: (data) => data.error.message,
    });
    const apiCallError = async (status: number, body: string) =>
      (
        await handler({
          response: new Response(body, { status, statusText: `HTTP ${status}` }),
          url: 'https://api.example.test/v1/chat/completions',
          requestBodyValues: {},
        })
      ).value;
    const retried = (
      lastError: unknown,
      reason: 'maxRetriesExceeded' | 'errorNotRetryable' = 'maxRetriesExceeded',
    ) =>
      new RetryError({
        message: 'Provider request failed after retries',
        reason,
        errors: [lastError, lastError, lastError],
      });

    const rateLimit = await apiCallError(429, '{"error":{"message":"Too many requests"}}');
    const unavailable = await apiCallError(503, '{"error":{"message":"Service unavailable"}}');
    const overflow = await apiCallError(
      503,
      '{"error":{"message":"Service unavailable","code":"context_length_exceeded"}}',
    );

    assert.equal(classifyError(retried(rateLimit)), 'RateLimit');
    assert.equal(classifyError(retried(unavailable)), 'ProviderUnavailable');
    assert.equal(classifyError(retried(overflow, 'errorNotRetryable')), 'ContextLength');

    const aborted = new RetryError({
      message: 'Retry stopped',
      reason: 'abort',
      errors: [new Error('transport stopped')],
    });
    assert.equal(classifyError(aborted), 'Abort');

    const empty = new RetryError({
      message: 'Provider request failed after retries',
      reason: 'maxRetriesExceeded',
      errors: [],
    });
    assert.equal(classifyError(empty), 'AI_RetryError');

    const spoofed = Object.assign(new Error('Provider request failed after retries'), {
      name: 'AI_RetryError',
      lastError: rateLimit,
    });
    assert.equal(classifyError(spoofed), 'AI_RetryError');
  });

  test('maps provider classes to stable user-safe presentations', () => {
    assert.deepEqual(errorPresentationFromClass('ContextLength'), {
      reason: 'context_overflow',
      message: 'Context window exceeded',
    });
    assert.deepEqual(errorPresentationFromClass('Timeout'), {
      reason: 'timeout',
      message: 'Request timed out',
    });
    assert.deepEqual(errorPresentationFromClass('Auth'), {
      reason: 'auth',
      message: 'Authentication failed',
    });
    assert.deepEqual(errorPresentationFromClass('ProviderBilling'), {
      reason: 'provider_billing',
      message: 'Provider billing required',
    });
    assert.deepEqual(errorPresentationFromClass('ProviderUnavailable'), {
      reason: 'provider_unavailable',
      message: 'Provider returned an error',
    });
    assert.deepEqual(errorPresentationFromClass('RateLimit'), {
      reason: 'rate_limit',
      message: 'Rate limit exceeded',
    });
    assert.deepEqual(errorPresentationFromClass('Network'), {
      reason: 'network',
      message: 'Network error',
    });
    assert.deepEqual(errorPresentationFromClass('Other'), {});
  });
});
test('auth classification preserves broad provider spellings without matching authority', () => {
  for (const message of [
    'AuthenticationError',
    'OAuth2 token expired',
    'User is not authorized',
    'Please authenticate',
    'authToken is missing',
  ]) {
    assert.equal(classifyError(new Error(message)), 'Auth');
  }
  assert.equal(
    classifyError(new Error('Conversation copy contains durable runtime authority facts')),
    'Error',
  );
});
