import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createJsonErrorResponseHandler } from '@ai-sdk/provider-utils';
import { RetryError } from 'ai';
import { z } from 'zod/v4';

import {
  classifyError,
  providerFailureDiagnostic,
  providerFailureResult,
  errorPresentationFromClass,
  providerFailureSummary,
  providerRetryMetadata,
  taxonomySafeProviderCode,
} from '../provider-error-classification.js';

describe('Provider error classification', () => {
  test('projects only bounded allowlisted facts into durable diagnostics', () => {
    const diagnostic = providerFailureDiagnostic(
      Object.assign(new Error('must not persist sk-secret-or-prompt'), {
        name: 'AI_APICallError',
        statusCode: 429,
        responseHeaders: {
          'x-request-id': 'req-123',
          authorization: 'Bearer secret',
        },
        data: {
          error: {
            code: 'rate_limit_exceeded',
            message: 'private provider payload',
          },
          prompt: 'private customer text',
        },
        requestBodyValues: { input: 'private request body' },
      }),
    );

    assert.deepEqual(diagnostic, {
      errorClass: 'RateLimit',
      httpStatus: 429,
      providerCode: 'rate_limit_exceeded',
      providerRequestId: 'req-123',
      retryable: false,
    });
    const serialized = JSON.stringify(diagnostic);
    assert.doesNotMatch(serialized, /secret|private|authorization|request body/i);
  });

  test('recovers structured Codex HTTP facts through an SDK wrapper and truncates identifiers', () => {
    const cause = Object.assign(new Error('Codex OAuth request failed'), {
      name: 'OpenAiCodexHttpError',
      statusCode: 400,
      data: { error: { code: 'x'.repeat(1_024) } },
      responseHeaders: { 'x-request-id': 'r'.repeat(1_024) },
    });
    const diagnostic = providerFailureDiagnostic(
      Object.assign(new Error('Cannot connect to API'), {
        name: 'AI_APICallError',
        code: 'FETCH_FAILED',
        cause,
      }),
    );

    assert.equal(diagnostic.errorClass, 'RequestRejected');
    assert.equal(diagnostic.httpStatus, 400);
    assert.ok((diagnostic.providerCode?.length ?? 0) <= 256);
    assert.ok((diagnostic.providerRequestId?.length ?? 0) <= 256);
    assert.equal(diagnostic.retryable, false);
  });

  test('ranks structured cause semantics above an outer HTTP status', () => {
    const wrapped = (cause: unknown) =>
      Object.assign(new Error('transport wrapper rejected the request'), {
        status: 403,
        code: 'FETCH_FAILED',
        cause,
      });
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ error: { code: 'usage_limit_reached' } }, 'UsageLimit', 'usage_limit_reached'],
      [{ error: { type: 'permission_denied' } }, 'ProviderPermission', 'permission_denied'],
      [{ error: { code: 'context_length_exceeded' } }, 'ContextLength', 'context_length_exceeded'],
    ];

    for (const [cause, expectedClass, expectedCode] of cases) {
      const result = providerFailureResult(wrapped(cause));
      assert.equal(result.errorClass, expectedClass);
      assert.equal(result.httpStatus, 403);
      assert.equal(result.providerCode, expectedCode);
      assert.equal(result.retryable, false);
      assert.deepEqual(providerRetryMetadata(wrapped(cause)), { retryable: false });
    }
  });

  test('ranks structured context overflow above numeric and text fallbacks', () => {
    const cases = [
      Object.assign(new Error('provider rejected the request'), {
        statusCode: 429,
        data: { error: { code: 'context_length_exceeded' } },
      }),
      Object.assign(new Error('request aborted because the prompt is too long'), {
        data: { error: { code: 'context_length_exceeded' } },
      }),
      Object.assign(new Error('proxy service unavailable'), {
        statusCode: 503,
        data: { error: { code: 'context_length_exceeded' } },
      }),
    ];

    for (const error of cases) {
      assert.equal(classifyError(error), 'ContextLength');
      assert.deepEqual(providerRetryMetadata(error), { retryable: false });
    }
  });

  test('durable diagnostics distinguish the provider failure classes used by fail-open handling', () => {
    const cases: Array<[unknown, string]> = [
      [Object.assign(new Error('bad request'), { statusCode: 400 }), 'RequestRejected'],
      [Object.assign(new Error('slow down'), { statusCode: 429 }), 'RateLimit'],
      [Object.assign(new Error('upstream failed'), { statusCode: 503 }), 'ProviderUnavailable'],
      [
        Object.assign(new Error('access denied'), {
          statusCode: 403,
          data: { error: { type: 'permission_denied' } },
        }),
        'ProviderPermission',
      ],
      [
        Object.assign(new Error('plan exhausted'), {
          statusCode: 429,
          data: { error: { type: 'usage_limit_reached' } },
        }),
        'UsageLimit',
      ],
      [{ error: { type: 'permission_denied' } }, 'ProviderPermission'],
      [{ error: { type: 'usage_limit_reached' } }, 'UsageLimit'],
      [new DOMException('request timed out', 'TimeoutError'), 'Timeout'],
      [new TypeError('fetch failed'), 'Network'],
      [
        Object.assign(new Error('input rejected'), {
          statusCode: 400,
          data: { error: { code: 'context_length_exceeded' } },
        }),
        'ContextLength',
      ],
    ];

    for (const [error, expected] of cases) {
      assert.equal(providerFailureDiagnostic(error).errorClass, expected);
    }
  });

  test('extracts allowlisted fields from JSON string failures without copying the payload', () => {
    const summary = providerFailureSummary(
      JSON.stringify({
        error: { message: 'provider rejected request', code: 'bad_request' },
        request_id: 'req-123',
        prompt: 'private customer text',
        headers: { 'x-debug': 'internal' },
      }),
    );

    assert.deepEqual(summary, {
      message: 'provider rejected request (code=bad_request, requestId=req-123)',
      code: 'bad_request',
    });
    assert.equal(JSON.stringify(summary).includes('private customer text'), false);
    assert.equal(JSON.stringify(summary).includes('x-debug'), false);
    assert.deepEqual(
      providerFailureSummary({
        error: JSON.stringify({
          message: 'nested provider rejection',
          code: 'nested_error',
          prompt: 'another private prompt',
        }),
      }),
      {
        message: 'nested provider rejection (code=nested_error)',
        code: 'nested_error',
      },
    );
    assert.equal(
      providerFailureSummary(JSON.stringify([{ prompt: 'private list payload' }])),
      undefined,
    );
  });

  test('retries incremental Responses transport failures with stable classification', () => {
    const websocketFailure = Object.assign(new Error('closed before completion'), {
      name: 'OpenAiResponsesTransportError',
      code: 'OPENAI_RESPONSES_WEBSOCKET_TRANSPORT_ERROR',
    });
    const missingContinuation = Object.assign(new Error('continuation unavailable'), {
      name: 'OpenAiResponsesTransportError',
      code: 'OPENAI_RESPONSES_CONTINUATION_UNAVAILABLE',
    });

    assert.equal(classifyError(websocketFailure), 'Network');
    assert.deepEqual(providerRetryMetadata(websocketFailure), { retryable: true });
    assert.deepEqual(providerRetryMetadata(missingContinuation), { retryable: true });
  });

  test('retries a rate limit only when the provider names a retry delay', () => {
    const bareRateLimit = Object.assign(new Error('Rate limit exceeded'), {
      name: 'AI_APICallError',
      statusCode: 429,
      data: { error: { code: 'FreeUsageLimitError', message: 'Rate limit exceeded' } },
    });
    const delayedRateLimit = Object.assign(new Error('Too many requests'), {
      name: 'AI_APICallError',
      statusCode: 429,
      responseHeaders: { 'retry-after': '40' },
    });

    assert.deepEqual(providerRetryMetadata(bareRateLimit), { retryable: false });
    assert.deepEqual(providerRetryMetadata(delayedRateLimit), {
      retryable: true,
      retryAfterMs: 40_000,
    });
    assert.equal(providerFailureDiagnostic(bareRateLimit).retryable, false);
    assert.equal(providerFailureDiagnostic(delayedRateLimit).retryable, true);
  });

  test('classifies context overflow by predicate, carrier shape, and evidence precedence', () => {
    const overflow = (message: string, extra: Record<string, unknown> = {}) =>
      classifyError(Object.assign(new Error(message), { name: 'AI_APICallError', ...extra }));

    const textCases = [
      'prompt is too long: 213462 tokens > 200000 maximum',
      'request_too_large: Request exceeds the maximum size',
      'Your input exceeds the context window of this model',
      "Requested token count exceeds the model's maximum context length of 131072 tokens",
      'The input token count (1196265) exceeds the maximum number of tokens allowed',
      "This model's maximum prompt length is 131072 but the request contains 537812 tokens",
      'Please reduce the length of the messages or completion',
      "This endpoint's maximum context length is 262144 tokens",
      'Prompt contains 5000 tokens; too large for model with 4096 maximum context length',
      'invalid params, context window exceeds limit',
      'Your request exceeded model token limit: 200000',
      'prompt token count of 21000 exceeds the limit of 16384',
      'the prompt contains too many tokens',
      'Input token limit exceeded: 250000 tokens > 200000 maximum',
      'Failed to generate response: context_length_exceeded',
    ];
    for (const message of textCases) {
      assert.equal(overflow(message, { statusCode: 400 }), 'ContextLength', message);
    }

    assert.equal(
      overflow('Bad Request', {
        statusCode: 400,
        data: { error: { message: 'Bad Request', code: 'context_length_exceeded' } },
      }),
      'ContextLength',
    );
    assert.equal(
      overflow('Bad Request', {
        statusCode: 400,
        responseBody: '{"error":{"code":"context_length_exceeded"}}',
      }),
      'ContextLength',
    );
    assert.equal(
      overflow('Request Entity Too Large', {
        statusCode: 400,
        data: { error: { type: 'request_too_large', message: 'Request Entity Too Large' } },
      }),
      'ContextLength',
    );

    assert.equal(
      classifyError({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          code: 'context_length_exceeded',
          message: 'Bad Request',
        },
      }),
      'ContextLength',
    );
    assert.equal(
      classifyError(
        "Requested token count exceeds the model's maximum context length of 131072 tokens.",
      ),
      'ContextLength',
    );
    assert.equal(
      classifyError({ type: 'invalid_request_error', message: 'missing required field' }),
      'Other',
    );

    assert.equal(
      overflow('Service Unavailable', {
        statusCode: 503,
        data: { error: { message: 'Service Unavailable', code: 'context_length_exceeded' } },
      }),
      'ContextLength',
    );
    assert.equal(
      overflow(
        "503 proxy error: Requested token count exceeds the model's maximum context length",
        { statusCode: 503 },
      ),
      'ContextLength',
    );
    assert.equal(overflow('', { statusCode: 413 }), 'ContextLength');
    assert.equal(
      overflow('Please rate limit your requests', { statusCode: 503 }),
      'ProviderUnavailable',
    );
    assert.notEqual(overflow('Failed to generate response', { statusCode: 400 }), 'RateLimit');
    assert.equal(overflow('rate_limit_exceeded: slow down'), 'RateLimit');

    const vetoedTextCases = [
      'Rate limit reached: too many tokens, please wait',
      "Too many requests. This endpoint's maximum context length is 262144 tokens.",
      "ThrottlingException. This endpoint's maximum context length is 262144 tokens.",
      "Quota exceeded. This endpoint's maximum context length is 262144 tokens.",
      "Completion has too many tokens. This endpoint's maximum context length is 262144 tokens.",
      "Too many tokens were requested for the completion. This endpoint's maximum context length is 262144 tokens.",
      "Output token count of 8192 exceeds the limit. This endpoint's maximum context length is 262144 tokens.",
      "Too many completion tokens were requested. This endpoint's maximum context length is 262144 tokens.",
      "Maximum completion tokens exceeded. This endpoint's maximum context length is 262144 tokens.",
    ];
    for (const message of vetoedTextCases) {
      assert.notEqual(overflow(message, { statusCode: 400 }), 'ContextLength', message);
    }
    for (const message of [
      'invalid request: missing required field',
      'file size exceeds the limit of 10485760',
    ]) {
      assert.notEqual(overflow(message, { statusCode: 400 }), 'ContextLength', message);
    }

    assert.equal(
      overflow(
        "This model's maximum context length is 8192 tokens. However, you requested 10240 tokens (10140 in the messages, 100 in the completion).",
        { statusCode: 400 },
      ),
      'ContextLength',
    );
    assert.equal(
      overflow('Completion has too many tokens for this model', {
        statusCode: 400,
        data: {
          error: {
            message: 'Completion has too many tokens for this model',
            code: 'context_length_exceeded',
          },
        },
      }),
      'ContextLength',
    );
  });

  test('classifies wording retained only in schema-invalid response bodies', async () => {
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
    assert.equal(overflowError.message, 'Bad Request');
    assert.equal(overflowError.data, undefined);
    assert.equal(classifyError(overflowError), 'ContextLength');

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
    assert.equal(
      classifyError(
        new RetryError({
          message: 'Retry stopped',
          reason: 'abort',
          errors: [new Error('transport stopped')],
        }),
      ),
      'Abort',
    );
    assert.equal(
      classifyError(
        new RetryError({
          message: 'Provider request failed after retries',
          reason: 'maxRetriesExceeded',
          errors: [],
        }),
      ),
      'AI_RetryError',
    );
    assert.equal(
      classifyError(
        Object.assign(new Error('Provider request failed after retries'), {
          name: 'AI_RetryError',
          lastError: rateLimit,
        }),
      ),
      'AI_RetryError',
    );
  });

  test('separates structured account limits, permission, and transient throttling', () => {
    const providerError = (
      statusCode: number,
      message: string,
      structured: Record<string, unknown> = {},
    ) =>
      Object.assign(new Error(message), {
        name: 'AI_APICallError',
        statusCode,
        data: { error: { message, ...structured } },
      });

    const insufficientQuota = providerError(429, 'You exceeded your current quota', {
      type: 'insufficient_quota',
      code: 'insufficient_quota',
    });
    assert.equal(classifyError(insufficientQuota), 'ProviderBilling');
    assert.deepEqual(providerRetryMetadata(insufficientQuota), { retryable: false });

    const planUsageLimit = providerError(429, 'Your subscription usage limit has been reached', {
      type: 'usage_limit_reached',
    });
    assert.equal(classifyError(planUsageLimit), 'UsageLimit');
    assert.deepEqual(providerRetryMetadata(planUsageLimit), { retryable: false });

    const abortedUsageLimit = providerError(429, 'The request was aborted at the account limit', {
      type: 'usage_limit_reached',
    });
    assert.equal(classifyError(abortedUsageLimit), 'UsageLimit');

    const permission = providerError(403, 'This key cannot access the requested model', {
      type: 'permission_denied',
    });
    assert.equal(classifyError(permission), 'ProviderPermission');
    assert.deepEqual(providerRetryMetadata(permission), { retryable: false });

    const throttle = providerError(429, 'Too many requests', {
      code: 'rate_limit_exceeded',
    });
    assert.equal(classifyError(throttle), 'RateLimit');
    // A bare rate limit fails closed; automatic retries need a named delay.
    assert.deepEqual(providerRetryMetadata(throttle), { retryable: false });
    const delayedThrottle = Object.assign(
      providerError(429, 'Too many requests', { code: 'rate_limit_exceeded' }),
      { responseHeaders: { 'retry-after': '40' } },
    );
    assert.deepEqual(providerRetryMetadata(delayedThrottle), {
      retryable: true,
      retryAfterMs: 40_000,
    });

    assert.equal(classifyError(providerError(401, 'Invalid API key')), 'Auth');
    assert.equal(classifyError(providerError(403, 'Request forbidden')), 'AI_APICallError');
    assert.equal(classifyError(providerError(400, 'Quota exceeded')), 'AI_APICallError');
  });

  test('keeps the observed Kimi plan-limit explanation without guessing its account state', async () => {
    const handler = createJsonErrorResponseHandler({
      errorSchema: z.object({
        type: z.literal('error'),
        error: z.object({
          type: z.string(),
          message: z.string(),
        }),
      }),
      errorToMessage: (data) => data.error.message,
    });
    const observedMessage =
      "You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/code/#pricing";
    const planCycleLimit = (
      await handler({
        response: new Response(
          JSON.stringify({
            error: { type: 'permission_error', message: observedMessage },
            type: 'error',
          }),
          {
            status: 403,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          },
        ),
        url: 'https://api.example.test/coding/v1/messages',
        requestBodyValues: {},
      })
    ).value;

    assert.equal(classifyError(planCycleLimit), 'AI_APICallError');
    assert.deepEqual(providerRetryMetadata(planCycleLimit), { retryable: false });
    assert.deepEqual(providerFailureSummary(planCycleLimit), {
      message: `${observedMessage} (code=permission_error, status=403)`,
      code: 'permission_error',
    });
    assert.deepEqual(providerFailureResult(planCycleLimit), {
      errorClass: 'RequestRejected',
      httpStatus: 403,
      providerCode: 'permission_error',
      retryable: false,
      message: `${observedMessage} (code=permission_error, status=403)`,
      boundedProviderMessage: true,
    });
    assert.deepEqual(providerFailureDiagnostic(planCycleLimit), {
      errorClass: 'RequestRejected',
      httpStatus: 403,
      providerCode: 'permission_error',
      retryable: false,
    });
  });

  test('does not mark a metadata-only fallback as provider wording', () => {
    assert.deepEqual(providerFailureResult({ statusCode: 403 }), {
      errorClass: 'RequestRejected',
      httpStatus: 403,
      retryable: false,
    });
  });

  test('requires positive provider provenance before certifying a cause message (#2521)', () => {
    // A plain-object cause whose only message is its own `.message` is
    // internal text, not a bounded provider message.
    const result = providerFailureResult(
      new Error('Request failed', {
        cause: { message: 'internal maka path /Users/x/.maka/keys.json missing' },
      }),
    );
    assert.equal(result.boundedProviderMessage, undefined);
    assert.equal(result.message, undefined);
  });

  test('numeric status outranks abort wording anywhere in the chain text (#2521)', () => {
    const rateLimited = Object.assign(new Error('request aborted: too many requests'), {
      name: 'AI_APICallError',
      statusCode: 429,
      data: { error: { message: 'request aborted: too many requests' } },
    });
    assert.equal(classifyError(rateLimited), 'RateLimit');
    const unavailable = Object.assign(new Error('request aborted by gateway'), {
      name: 'AI_APICallError',
      statusCode: 500,
      data: { error: { message: 'request aborted by gateway' } },
    });
    assert.equal(classifyError(unavailable), 'ProviderUnavailable');
    // Even a JSON key name carrying "aborted" must not reclassify a 5xx.
    assert.equal(classifyError({ statusCode: 500, aborted: false }), 'ProviderUnavailable');
  });

  test('never reports a text-derived Abort as retryable (#2521)', () => {
    const result = providerFailureResult(new Error('The operation was aborted'));
    assert.equal(result.errorClass, 'Abort');
    assert.equal(result.retryable, false);
  });

  test('selects the message and the provider code from the same chain link (#2521)', () => {
    const error = Object.assign(new Error('Request failed'), {
      name: 'AI_APICallError',
      statusCode: 429,
      data: { error: { code: 'rate_limit_exceeded' } },
      cause: { error: { message: 'transport detail: socket hang up' } },
    });
    const result = providerFailureResult(error);
    // Classification still sees the aggregated structured code...
    assert.equal(result.errorClass, 'RateLimit');
    // ...but the projected message is never stamped with a code from a
    // different link.
    assert.equal(result.providerCode, undefined);
    assert.match(result.message ?? '', /socket hang up/);
    assert.doesNotMatch(result.message ?? '', /rate_limit/i);
  });

  test('admits only closed-vocabulary provider codes into the taxonomy input (#2521)', () => {
    assert.equal(taxonomySafeProviderCode('rate_limit_exceeded'), 'rate_limit_exceeded');
    assert.equal(taxonomySafeProviderCode('429'), '429');
    // Free-form tokens containing taxonomy-matched substrings are refused.
    assert.equal(taxonomySafeProviderCode('tool_choice_invalid'), undefined);
    assert.equal(taxonomySafeProviderCode('auth_custom_scheme'), undefined);
    assert.equal(taxonomySafeProviderCode(undefined), undefined);
  });

  test('maps provider classes to stable user-safe presentations', () => {
    assert.deepEqual(errorPresentationFromClass('ProviderBilling'), {
      reason: 'provider_billing',
      message: 'Provider billing required',
    });
    assert.deepEqual(errorPresentationFromClass('ProviderPermission'), {
      reason: 'provider_permission',
      message: 'Provider access denied',
    });
    assert.deepEqual(errorPresentationFromClass('RateLimit'), {
      reason: 'rate_limit',
      message: 'Rate limit exceeded',
    });
    assert.deepEqual(errorPresentationFromClass('UsageLimit'), {
      reason: 'usage_limit',
      message: 'Usage limit reached',
    });
  });
});

test('auth classification matches authentication without matching authority', () => {
  assert.equal(classifyError(new Error('OAuth2 token expired')), 'Auth');
  assert.equal(
    classifyError(new Error('Conversation copy contains durable runtime authority facts')),
    'Error',
  );
});
