import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import * as telemetry from '../provider-request-telemetry.js';

describe('strict provider-request usage', () => {
  test('preserves Anthropic cache fields as provider-reported values', () => {
    const usage = telemetry.strictProviderRequestUsage({
      inputTokens: { total: 100, noCache: 40, cacheRead: 50, cacheWrite: 10 },
      outputTokens: { total: 12, text: undefined, reasoning: undefined },
      raw: {
        input_tokens: 40,
        output_tokens: 12,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 50,
      },
    });

    assert.deepEqual(usage, {
      inputTokens: 100,
      cacheReadInputTokens: 50,
      cacheReadInputSource: 'provider',
      cacheMissInputTokens: 40,
      cacheMissInputSource: 'provider',
      cacheWriteInputTokens: 10,
      cacheWriteInputSource: 'provider',
      outputTokens: 12,
    });
  });

  test('reconciles Anthropic compaction iterations with normalized input usage', () => {
    const usage = telemetry.strictProviderRequestUsage({
      inputTokens: { total: 115, noCache: 105, cacheRead: 10, cacheWrite: 0 },
      outputTokens: { total: 9, text: 9, reasoning: undefined },
      raw: {
        input_tokens: 5,
        output_tokens: 9,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 10,
        iterations: [
          { type: 'message', input_tokens: 5, output_tokens: 4 },
          { type: 'compaction', input_tokens: 100, output_tokens: 5 },
        ],
      },
    });

    assert.deepEqual(usage, {
      inputTokens: 115,
      cacheReadInputTokens: 10,
      cacheReadInputSource: 'provider',
      cacheMissInputTokens: 105,
      cacheMissInputSource: 'provider',
      cacheWriteInputTokens: 0,
      cacheWriteInputSource: 'provider',
      outputTokens: 9,
    });
  });

  test('marks OpenAI cache miss as derived and leaves unsupported cache-write missing', () => {
    const usage = telemetry.strictProviderRequestUsage({
      inputTokens: { total: 100, noCache: 30, cacheRead: 70, cacheWrite: undefined },
      outputTokens: { total: 20, text: 15, reasoning: 5 },
      raw: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 70 },
        completion_tokens_details: { reasoning_tokens: 5 },
      },
    });

    assert.deepEqual(usage, {
      inputTokens: 100,
      cacheReadInputTokens: 70,
      cacheReadInputSource: 'provider',
      cacheMissInputTokens: 30,
      cacheMissInputSource: 'derived',
      outputTokens: 20,
      reasoningTokens: 5,
    });
  });

  test('preserves OpenAI Chat cache-write and derives cache miss from the raw total', () => {
    const usage = telemetry.strictProviderRequestUsage({
      inputTokens: { total: 100, noCache: 50, cacheRead: 20, cacheWrite: 30 },
      outputTokens: { total: 20, text: 20, reasoning: 0 },
      raw: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 },
      },
    });

    assert.deepEqual(usage, {
      inputTokens: 100,
      cacheReadInputTokens: 20,
      cacheReadInputSource: 'provider',
      cacheMissInputTokens: 50,
      cacheMissInputSource: 'derived',
      cacheWriteInputTokens: 30,
      cacheWriteInputSource: 'provider',
      outputTokens: 20,
    });
  });

  test('preserves Google usage and derives cache miss from raw usage metadata', () => {
    const usage = telemetry.strictProviderRequestUsage({
      inputTokens: { total: 100, noCache: 60, cacheRead: 40, cacheWrite: undefined },
      outputTokens: { total: 20, text: 15, reasoning: 5 },
      raw: {
        promptTokenCount: 100,
        candidatesTokenCount: 15,
        cachedContentTokenCount: 40,
        thoughtsTokenCount: 5,
      },
    });

    assert.deepEqual(usage, {
      inputTokens: 100,
      cacheReadInputTokens: 40,
      cacheReadInputSource: 'provider',
      cacheMissInputTokens: 60,
      cacheMissInputSource: 'derived',
      outputTokens: 20,
      reasoningTokens: 5,
    });
  });

  test('does not inherit Google adapter zeroes for omitted raw cache and reasoning fields', () => {
    const usage = telemetry.strictProviderRequestUsage({
      inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: undefined },
      outputTokens: { total: 20, text: 20, reasoning: 0 },
      raw: {
        promptTokenCount: 100,
        candidatesTokenCount: 20,
      },
    });

    assert.deepEqual(usage, { inputTokens: 100, outputTokens: 20 });
  });

  test('does not turn omitted provider cache details into zero-valued evidence', () => {
    const usage = telemetry.strictProviderRequestUsage({
      inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: undefined },
      outputTokens: { total: 20, text: 20, reasoning: 0 },
      raw: { prompt_tokens: 100, completion_tokens: 20 },
    });

    assert.deepEqual(usage, { inputTokens: 100, outputTokens: 20 });
  });

  test('does not inherit normalized zero totals when the raw provider fields are missing', () => {
    const usage = telemetry.strictProviderRequestUsage({
      inputTokens: { total: 0, noCache: 0, cacheRead: 10, cacheWrite: undefined },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
      raw: { prompt_tokens_details: { cached_tokens: 10 } },
    });

    assert.deepEqual(usage, {
      cacheReadInputTokens: 10,
      cacheReadInputSource: 'provider',
    });
  });

  test('keeps normalized totals when no raw provider payload is available', () => {
    const usage = telemetry.strictProviderRequestUsage({
      inputTokens: { total: 8, noCache: 8, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 3, text: 3, reasoning: undefined },
    });

    assert.deepEqual(usage, { inputTokens: 8, outputTokens: 3 });
  });

  test('does not derive cache miss from inconsistent provider components', () => {
    const usage = telemetry.strictProviderRequestUsage({
      inputTokens: { total: 10, noCache: 0, cacheRead: 20, cacheWrite: undefined },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
      raw: {
        prompt_tokens: 10,
        prompt_tokens_details: { cached_tokens: 20 },
      },
    });

    assert.deepEqual(usage, {
      inputTokens: 10,
      cacheReadInputTokens: 20,
      cacheReadInputSource: 'provider',
    });
  });
});

describe('provider request capture commit', () => {
  test('links body-free metadata and returns the committed artifact reference', async () => {
    const ledgerCaptures: Array<Record<string, unknown>> = [];
    const recordCapture = telemetry.createProviderRequestCaptureRecorder({
      persistArtifact: async () => ({ artifactId: 'artifact-capture-1' }),
      recordLedger: async (capture) => {
        ledgerCaptures.push(capture as unknown as Record<string, unknown>);
      },
    });

    const result = await recordCapture({
      schemaVersion: 2,
      traceId: 'trace-1',
      captureId: 'capture-1',
      turnId: 'turn-1',
      step: 0,
      providerId: 'openai',
      modelId: 'gpt-test',
      requestHash: 'sha256:request',
      requestPayloadWithoutProviderOptionsHash: 'sha256:shared-request',
      requestBytes: 2,
      segments: [],
      serializedRequest: '{}',
    });

    assert.deepEqual(result, { artifactId: 'artifact-capture-1' });
    assert.equal(ledgerCaptures.length, 1);
    assert.equal(ledgerCaptures[0]?.artifactId, 'artifact-capture-1');
    assert.equal(Object.hasOwn(ledgerCaptures[0]!, 'serializedRequest'), false);
  });

  test('retains the request artifact when a failed ledger append may have landed', async () => {
    const ledgerError = new Error('capture ledger append failed');
    const ledgerCaptures: Array<Record<string, unknown>> = [];
    const persistedArtifactIds = new Set<string>();
    const createRecorder = Reflect.get(
      telemetry,
      'createProviderRequestCaptureRecorder',
    ) as unknown as
      | ((input: Record<string, unknown>) => (capture: Record<string, unknown>) => Promise<unknown>)
      | undefined;
    assert.equal(typeof createRecorder, 'function');
    const recordCapture = createRecorder!({
      persistArtifact: async () => {
        persistedArtifactIds.add('artifact-capture-1');
        return { artifactId: 'artifact-capture-1' };
      },
      recordLedger: async (capture: Record<string, unknown>) => {
        ledgerCaptures.push(capture);
        throw ledgerError;
      },
    });

    await assert.rejects(
      recordCapture({
        schemaVersion: 2,
        traceId: 'trace-1',
        captureId: 'capture-1',
        turnId: 'turn-1',
        step: 0,
        providerId: 'openai',
        modelId: 'gpt-test',
        requestHash: 'sha256:request',
        requestPayloadWithoutProviderOptionsHash: 'sha256:shared-request',
        requestBytes: 2,
        segments: [],
        serializedRequest: '{}',
      }),
      (error) => error === ledgerError,
    );
    assert.equal(ledgerCaptures.length, 1);
    assert.deepEqual([...persistedArtifactIds], ['artifact-capture-1']);
  });
});

describe('provider request tracker', () => {
  test('persists a logical capture before each physical attempt and reuses it for retries', async () => {
    const captures: Array<{
      captureId: string;
      requestHash: string;
      serializedRequest: string;
    }> = [];
    const attempts: Array<{ step: number; attempt: number; status: string; captureId: string }> =
      [];
    const Tracker = Reflect.get(telemetry, 'ProviderRequestTracker') as unknown as
      | (new (
          input: Record<string, unknown>,
        ) => {
          setStep(step: number): void;
          trackStream(input: Record<string, unknown>): Promise<{ stream: ReadableStream<unknown> }>;
        })
      | undefined;
    assert.equal(typeof Tracker, 'function');
    let id = 0;
    const tracker = new Tracker!({
      traceId: 'trace-1',
      turnId: 'turn-1',
      now: () => Date.now(),
      newId: () => `id-${++id}`,
      persistCapture: async (capture: {
        captureId: string;
        requestHash: string;
        serializedRequest: string;
      }) => {
        captures.push(capture);
        return { artifactId: `artifact-${captures.length}` };
      },
      recordAttempt: async (attempt: {
        step: number;
        attempt: number;
        status: string;
        captureId: string;
      }) => attempts.push(attempt),
    });
    tracker.setStep(2);
    const params = preparedParams('hello');

    await assert.rejects(
      tracker.trackStream({
        providerId: 'openai',
        modelId: 'gpt-test',
        params,
        abortSignal: new AbortController().signal,
        doStream: async () => {
          throw new Error('network');
        },
      }),
      /network/,
    );
    const result = await tracker.trackStream({
      providerId: 'openai',
      modelId: 'gpt-test',
      params,
      abortSignal: new AbortController().signal,
      doStream: async () => ({
        stream: streamOf([
          { type: 'text-delta', id: 'text-1', delta: 'ok' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 10, noCache: 6, cacheRead: 4, cacheWrite: undefined },
              outputTokens: { total: 2, text: 2, reasoning: 0 },
              raw: {
                prompt_tokens: 10,
                completion_tokens: 2,
                prompt_tokens_details: { cached_tokens: 4 },
              },
            },
          },
        ]),
      }),
    });
    await drain(result.stream);

    assert.equal(captures.length, 1);
    assert.deepEqual(JSON.parse(captures[0]!.serializedRequest), params);
    assert.deepEqual(
      attempts.map(({ step, attempt, status, captureId }) => ({
        step,
        attempt,
        status,
        captureId,
      })),
      [
        { step: 2, attempt: 1, status: 'failed', captureId: captures[0]!.captureId },
        { step: 2, attempt: 2, status: 'completed', captureId: captures[0]!.captureId },
      ],
    );
    assert.equal((attempts[1] as Record<string, unknown>).cacheReadInputSource, 'provider');
    assert.equal((attempts[1] as Record<string, unknown>).cacheMissInputSource, 'derived');
  });

  test('captures a changed logical body separately and blocks provider calls on capture failure', async () => {
    const captures: string[] = [];
    const Tracker = Reflect.get(telemetry, 'ProviderRequestTracker') as unknown as new (
      input: Record<string, unknown>,
    ) => {
      setStep(step: number): void;
      trackStream(input: Record<string, unknown>): Promise<{ stream: ReadableStream<unknown> }>;
    };
    let providerCalls = 0;
    const tracker = new Tracker({
      traceId: 'trace-2',
      turnId: 'turn-2',
      now: () => Date.now(),
      newId: () => `capture-${captures.length + 1}`,
      persistCapture: async (capture: { requestHash: string }) => {
        captures.push(capture.requestHash);
        if (captures.length === 2) throw new Error('capture unavailable');
        return { artifactId: 'artifact-1' };
      },
      recordAttempt: () => {},
    });
    tracker.setStep(0);
    const completed = await tracker.trackStream({
      providerId: 'anthropic',
      modelId: 'claude-test',
      params: preparedParams('before'),
      abortSignal: new AbortController().signal,
      doStream: async () => {
        providerCalls += 1;
        return { stream: streamOf([finishPart()]) };
      },
    });
    await drain(completed.stream);

    await assert.rejects(
      tracker.trackStream({
        providerId: 'anthropic',
        modelId: 'claude-test',
        params: preparedParams('after'),
        abortSignal: new AbortController().signal,
        doStream: async () => {
          providerCalls += 1;
          return { stream: streamOf([finishPart()]) };
        },
      }),
      /capture unavailable/,
    );
    assert.equal(providerCalls, 1);
    assert.equal(captures.length, 2);
    assert.notEqual(captures[0], captures[1]);
  });

  test('records an errored stream after output as interrupted', async () => {
    const attempts: Array<{ status: string }> = [];
    const Tracker = Reflect.get(telemetry, 'ProviderRequestTracker') as unknown as new (
      input: Record<string, unknown>,
    ) => {
      setStep(step: number): void;
      trackStream(input: Record<string, unknown>): Promise<{ stream: ReadableStream<unknown> }>;
    };
    const tracker = new Tracker({
      traceId: 'trace-3',
      turnId: 'turn-3',
      now: () => Date.now(),
      newId: () => 'id',
      persistCapture: async () => ({ artifactId: 'artifact' }),
      recordAttempt: async (attempt: { status: string }) => attempts.push(attempt),
    });
    tracker.setStep(0);
    const result = await tracker.trackStream({
      providerId: 'openai',
      modelId: 'gpt-test',
      params: preparedParams('hello'),
      abortSignal: new AbortController().signal,
      doStream: async () => ({ stream: interruptedStream() }),
    });
    await assert.rejects(drain(result.stream), /stream broke/);
    assert.equal(attempts[0]?.status, 'interrupted');
  });

  test('records an in-flight attempt as aborted when its signal is cancelled', async () => {
    const attempts: Array<{ status: string }> = [];
    const abort = new AbortController();
    const tracker = new telemetry.ProviderRequestTracker({
      traceId: 'trace-4',
      turnId: 'turn-4',
      now: () => Date.now(),
      newId: () => 'id',
      persistCapture: async () => ({ artifactId: 'artifact' }),
      recordAttempt: async (attempt) => {
        attempts.push(attempt);
      },
    });
    tracker.setStep(0);
    await tracker.trackStream({
      providerId: 'openai',
      modelId: 'gpt-test',
      params: preparedParams('hello'),
      abortSignal: abort.signal,
      doStream: async () => ({ stream: new ReadableStream() }),
    });

    abort.abort();
    await Promise.resolve();

    assert.equal(attempts[0]?.status, 'aborted');
  });

  test('does not capture or record an attempt when cancellation predates dispatch', async () => {
    let captures = 0;
    let attempts = 0;
    let providerCalls = 0;
    const abort = new AbortController();
    abort.abort();
    const tracker = new telemetry.ProviderRequestTracker({
      traceId: 'trace-5',
      turnId: 'turn-5',
      now: () => Date.now(),
      newId: () => 'id',
      persistCapture: async () => {
        captures += 1;
        return { artifactId: 'artifact' };
      },
      recordAttempt: async () => {
        attempts += 1;
      },
    });

    await assert.rejects(
      tracker.trackStream({
        providerId: 'openai',
        modelId: 'gpt-test',
        params: preparedParams('hello'),
        abortSignal: abort.signal,
        doStream: async () => {
          providerCalls += 1;
          return { stream: streamOf([finishPart()]) };
        },
      }),
      { name: 'AbortError' },
    );

    assert.equal(captures, 0);
    assert.equal(attempts, 0);
    assert.equal(providerCalls, 0);
  });

  test('does not dispatch or record an attempt when cancellation happens during capture', async () => {
    let captures = 0;
    let attempts = 0;
    let providerCalls = 0;
    const abort = new AbortController();
    const tracker = new telemetry.ProviderRequestTracker({
      traceId: 'trace-6',
      turnId: 'turn-6',
      now: () => Date.now(),
      newId: () => 'id',
      persistCapture: async () => {
        captures += 1;
        abort.abort();
        return { artifactId: 'artifact' };
      },
      recordAttempt: async () => {
        attempts += 1;
      },
    });

    await assert.rejects(
      tracker.trackStream({
        providerId: 'openai',
        modelId: 'gpt-test',
        params: preparedParams('hello'),
        abortSignal: abort.signal,
        doStream: async () => {
          providerCalls += 1;
          return { stream: streamOf([finishPart()]) };
        },
      }),
      { name: 'AbortError' },
    );

    assert.equal(captures, 1);
    assert.equal(attempts, 0);
    assert.equal(providerCalls, 0);
  });
});

function preparedParams(text: string): Record<string, unknown> {
  return {
    prompt: [
      { role: 'system', content: 'system' },
      { role: 'user', content: [{ type: 'text', text }] },
    ],
    tools: [{ type: 'function', name: 'Read', inputSchema: { type: 'object' } }],
    providerOptions: { test: { cacheControl: true } },
  };
}

function finishPart(): Record<string, unknown> {
  return {
    type: 'finish',
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
      raw: { input_tokens: 1, output_tokens: 1 },
    },
  };
}

function streamOf(parts: unknown[]): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

function interruptedStream(): ReadableStream<unknown> {
  let pulls = 0;
  return new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls === 1) {
        controller.enqueue({ type: 'text-delta', id: 'text', delta: 'partial' });
      } else {
        controller.error(new Error('stream broke'));
      }
    },
  });
}

async function drain(stream: ReadableStream<unknown>): Promise<void> {
  for await (const _part of stream) {
    // Drain to trigger terminal telemetry.
  }
}
