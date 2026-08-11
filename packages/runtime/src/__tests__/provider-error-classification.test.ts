import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createJsonErrorResponseHandler } from '@ai-sdk/provider-utils';
import { RetryError } from 'ai';
import { z } from 'zod/v4';

import {
  classifyError,
  providerFailureSummary,
  providerRetryMetadata,
} from '../provider-error-classification.js';

describe('Provider error classification', () => {
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
});

test('auth classification matches authentication without matching authority', () => {
  assert.equal(classifyError(new Error('OAuth2 token expired')), 'Auth');
  assert.equal(
    classifyError(new Error('Conversation copy contains durable runtime authority facts')),
    'Error',
  );
});
