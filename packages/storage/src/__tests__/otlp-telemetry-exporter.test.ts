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

import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  PersistedLlmCallRecord,
  PersistedToolInvocationRecord,
} from '../telemetry-file-schema.js';
import {
  createOtlpTelemetryExporter,
  type OtlpTelemetryExporterOptions,
} from '../otlp-telemetry-exporter.js';

test('exports bounded usage spans through OTLP/HTTP', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const options: OtlpTelemetryExporterOptions = {
    env: {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test',
      OTEL_EXPORTER_OTLP_HEADERS:
        'authorization=Bearer%20secret,content-type=text/plain,bad%20name=x,x-control=ok%0Aevil',
      OTEL_SERVICE_NAME: 'maka-test',
      OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment=ci,empty=',
    },
    fetch: async (url, init) => {
      requests.push({ url, init: init ?? {} });
      return new Response(null, { status: 200 });
    },
  };
  const exporter = createOtlpTelemetryExporter(options);
  assert.ok(exporter);

  const record: PersistedLlmCallRecord = {
    id: 'usage-1',
    providerId: 'openai',
    modelId: 'gpt-test',
    inputTokens: 12,
    outputTokens: 7,
    totalTokens: 19,
    cacheHitInputTokens: 0,
    cacheMissInputTokens: 12,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0.01,
    latencyMs: 25,
    startedAt: 1_000,
    status: 'success',
    date: '1970-01-01',
    ts: 1_025,
  };
  await exporter.exportLlmCall(record);
  await exporter.close();

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, 'https://collector.example.test/v1/traces');
  const headers = requests[0]?.init.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer secret');
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['bad name'], undefined);
  assert.equal(headers['x-control'], undefined);
  const payload = JSON.parse(String(requests[0]?.init.body));
  const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(payload.resourceSpans[0].resource.attributes[0].value.stringValue, 'maka-test');
  assert.equal(span.name, 'maka.llm.call');
  assert.equal(
    span.attributes.some((item: { key: string }) => item.key === 'argsSummary'),
    false,
  );
});

test('bounds exported error classes and preserves exact nanosecond timestamps', async () => {
  const requests: RequestInit[] = [];
  const exporter = createOtlpTelemetryExporter({
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test' },
    fetch: async (_url, init) => {
      requests.push(init ?? {});
      return new Response(null, { status: 200 });
    },
  });
  assert.ok(exporter);

  await exporter.exportLlmCall({
    id: 'usage-bounded-error',
    providerId: 'openai',
    modelId: 'gpt-test',
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    cacheHitInputTokens: 0,
    cacheMissInputTokens: 1,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    latencyMs: 3,
    startedAt: 1_234_567_890_123,
    status: 'error',
    errorClass: `  ${'x'.repeat(200)}\n`,
    date: '2009-02-13',
    ts: 1_234_567_890_126,
  });
  await exporter.close();

  const payload = JSON.parse(String(requests[0]?.body)) as {
    resourceSpans: Array<{
      scopeSpans: Array<{
        spans: Array<{
          startTimeUnixNano: string;
          endTimeUnixNano: string;
          attributes: Array<{ key: string; value: { stringValue?: string } }>;
        }>;
      }>;
    }>;
  };
  const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.startTimeUnixNano, '1234567890123000000');
  assert.equal(span.endTimeUnixNano, '1234567890126000000');
  const errorClass = span.attributes.find((item) => item.key === 'maka.error.class')?.value
    .stringValue;
  assert.equal(errorClass, 'Other');
});

test('warns when authorization is configured for a non-HTTPS collector', () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
  try {
    const exporter = createOtlpTelemetryExporter({
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector-warning.example.test',
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer%20secret',
      },
      fetch: async () => new Response(null, { status: 200 }),
    });
    assert.ok(exporter);
    const secondExporter = createOtlpTelemetryExporter({
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector-warning.example.test',
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer%20secret',
      },
      fetch: async () => new Response(null, { status: 200 }),
    });
    assert.ok(secondExporter);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /not using HTTPS/);
});

test('does not create an exporter without an OTLP endpoint', () => {
  assert.equal(createOtlpTelemetryExporter({ env: {} }), undefined);
});

test('preserves an explicitly configured traces endpoint including its trailing slash', async () => {
  const requests: string[] = [];
  const exporter = createOtlpTelemetryExporter({
    env: { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://collector.example.test/v1/traces/' },
    fetch: async (url) => {
      requests.push(url);
      return new Response(null, { status: 200 });
    },
  });
  assert.ok(exporter);

  await exporter.exportLlmCall({
    id: 'usage-2',
    providerId: 'openai',
    modelId: 'gpt-test',
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    cacheHitInputTokens: 0,
    cacheMissInputTokens: 1,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    latencyMs: 1,
    startedAt: 1,
    status: 'success',
    date: '1970-01-01',
    ts: 2,
  });
  await exporter.close();

  assert.deepEqual(requests, ['https://collector.example.test/v1/traces/']);
});

test('flush drains spans queued while another batch is in flight', async () => {
  let releaseFirst!: () => void;
  const firstBatch = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const payloads: Array<{ spanCount: number }> = [];
  const exporter = createOtlpTelemetryExporter({
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test' },
    fetch: async (_url, init) => {
      const payload = JSON.parse(String(init?.body)) as {
        resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }>;
      };
      payloads.push({ spanCount: payload.resourceSpans[0]?.scopeSpans[0]?.spans.length ?? 0 });
      if (payloads.length === 1) await firstBatch;
      return new Response(null, { status: 200 });
    },
  });
  assert.ok(exporter);

  const record: PersistedLlmCallRecord = {
    id: 'usage-batch',
    providerId: 'openai',
    modelId: 'gpt-test',
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    cacheHitInputTokens: 0,
    cacheMissInputTokens: 1,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    latencyMs: 1,
    startedAt: 1,
    status: 'success',
    date: '1970-01-01',
    ts: 2,
  };
  for (let index = 0; index < 32; index += 1) {
    void exporter.exportLlmCall({ ...record, id: `usage-batch-${index}` });
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  void exporter.exportLlmCall({ ...record, id: 'usage-batch-late' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseFirst();
  await exporter.close();

  assert.deepEqual(payloads, [{ spanCount: 32 }, { spanCount: 1 }]);
});

test('uses trace endpoints verbatim and appends the signal path only to a generic endpoint', async () => {
  for (const [env, expected] of [
    [
      {
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://collector.example/custom/traces?route=a',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://ignored.example',
      },
      'https://collector.example/custom/traces?route=a',
    ],
    [
      { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://collector.example/' },
      'https://collector.example/',
    ],
    [
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example/base/',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '',
      },
      'https://collector.example/base/v1/traces',
    ],
  ] as const) {
    const urls: string[] = [];
    const exporter = createOtlpTelemetryExporter({
      env,
      fetch: async (url) => {
        urls.push(url);
        return new Response(null);
      },
    });
    assert.ok(exporter);
    await exporter.exportToolInvocation(toolRecord());
    await exporter.close();
    assert.deepEqual(urls, [expected]);
  }
});

test('trace headers override generic headers and retain outbound validation', async () => {
  for (const traceHeaders of [
    'authorization=Bearer%20trace-token,content-type=text/plain,x-bad=bad%0Avalue',
    '',
    undefined,
  ]) {
    let headers: Record<string, string> = {};
    const exporter = createOtlpTelemetryExporter({
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example',
        OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20generic-token,x-generic=yes',
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: traceHeaders,
      },
      fetch: async (_url, init) => {
        headers = init?.headers as Record<string, string>;
        return new Response(null);
      },
    });
    assert.ok(exporter);
    await exporter.exportToolInvocation(toolRecord());
    await exporter.close();
    assert.equal(
      headers.authorization,
      traceHeaders ? 'Bearer trace-token' : 'Bearer generic-token',
    );
    assert.equal(headers['x-generic'], traceHeaders ? undefined : 'yes');
    assert.equal(headers['content-type'], 'application/json');
    assert.equal(headers['x-bad'], undefined);
  }
});

test('exports only known error classes for arbitrary tool Error.name values', async () => {
  const classes: string[] = [];
  const exporter = createOtlpTelemetryExporter({
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example' },
    fetch: async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      for (const span of payload.resourceSpans[0].scopeSpans[0].spans) {
        classes.push(
          span.attributes.find((item: { key: string }) => item.key === 'maka.error.class').value
            .stringValue,
        );
      }
      assert.equal(String(init?.body).includes('sk-live-secret-value'), false);
      return new Response(null);
    },
  });
  assert.ok(exporter);
  for (const errorClass of [
    'sk-live-secret-value',
    'password=two words',
    'Timeout',
    'InvalidArguments',
  ]) {
    await exporter.exportToolInvocation({ ...toolRecord(), errorClass, status: 'error' });
  }
  await exporter.close();
  assert.deepEqual(classes, ['Other', 'Other', 'Timeout', 'InvalidArguments']);
});

test('logs collector failures once until a successful export', async (t) => {
  const errors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args));
  const statuses = [400, 400, 200, 400, 400];
  const exporter = createOtlpTelemetryExporter({
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example' },
    fetch: async () => new Response(null, { status: statuses.shift() }),
  });
  assert.ok(exporter);
  for (let index = 0; index < 5; index += 1) {
    await exporter.exportToolInvocation(toolRecord());
    await exporter.flush();
  }
  await exporter.close();
  assert.equal(errors.length, 2);
});

test('cancels stalled export requests with generic and trace-specific timeouts', async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const timeoutEnv of [
    { OTEL_EXPORTER_OTLP_TIMEOUT: '40' },
    { OTEL_EXPORTER_OTLP_TIMEOUT: '40', OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: '' },
    { OTEL_EXPORTER_OTLP_TIMEOUT: '60000', OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: '40' },
  ]) {
    let signal: AbortSignal | undefined;
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const exporter = createOtlpTelemetryExporter({
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example', ...timeoutEnv },
      fetch: async (_url, init) => {
        signal = init?.signal ?? undefined;
        return pending;
      },
    });
    assert.ok(exporter);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await exporter.exportToolInvocation(toolRecord());
      const completed = await Promise.race([
        exporter.flush().then(() => true),
        new Promise<boolean>((resolve) => {
          deadline = setTimeout(() => resolve(false), 500);
        }),
      ]);
      assert.equal(completed, true, 'request must settle even if a transport ignores cancellation');
      assert.equal(signal?.aborted, true);
    } finally {
      clearTimeout(deadline);
      release(new Response(null));
      await exporter.close();
    }
  }
});

function toolRecord(): PersistedToolInvocationRecord {
  return {
    id: 'tool-export',
    toolName: 'Bash',
    durationMs: 1,
    status: 'success',
    bytesIn: 1,
    bytesOut: 2,
    date: '1970-01-01',
    startedAt: 1,
    ts: 2,
  };
}

test('retries retryable collector responses without changing the batch identity', async () => {
  for (const status of [429, 502, 503, 504]) {
    const requests: string[] = [];
    let bodyCancelled = false;
    const exporter = createOtlpTelemetryExporter({
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example' },
      fetch: async (_url, init) => {
        requests.push(String(init?.body));
        if (requests.length > 1) {
          assert.equal(bodyCancelled, true);
          return new Response(null);
        }
        return new Response(
          new ReadableStream({
            cancel() {
              bodyCancelled = true;
            },
          }),
          {
            status,
            headers: { 'retry-after': '0' },
          },
        );
      },
    });
    assert.ok(exporter);
    await exporter.exportToolInvocation(toolRecord());
    await exporter.flush();
    await exporter.close();
    assert.equal(requests.length, 2);
    assert.equal(requests[0], requests[1]);
  }
});

test('retries connection failures using exponential backoff with jitter', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  const requestTimes: number[] = [];
  const exporter = createOtlpTelemetryExporter({
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example' },
    fetch: async () => {
      requestTimes.push(performance.now());
      if (requestTimes.length < 3) throw new Error('connection reset');
      return new Response(null);
    },
  });
  assert.ok(exporter);
  t.after(() => exporter.close());
  await exporter.exportToolInvocation(toolRecord());
  await exporter.flush();
  assert.equal(requestTimes.length, 3);
  assert.ok(requestTimes[1] - requestTimes[0] >= 490);
  assert.ok(requestTimes[2] - requestTimes[1] >= 990);
});

test('bounds Retry-After waits by the batch timeout and the shutdown grace period', async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const close of [false, true]) {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
    let requests = 0;
    let signal: AbortSignal | undefined;
    const exporter = createOtlpTelemetryExporter({
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example',
        OTEL_EXPORTER_OTLP_TIMEOUT: close ? '60000' : '40',
      },
      fetch: async (_url, init) => {
        requests += 1;
        signal = init?.signal ?? undefined;
        return new Response(null, {
          status: 503,
          headers: { 'retry-after': new Date(Date.now() + 120_000).toUTCString() },
        });
      },
    });
    assert.ok(exporter);
    await exporter.exportToolInvocation(toolRecord());
    const flushed = exporter.flush();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const closed = close ? exporter.close() : undefined;
    t.mock.timers.tick(close ? 1_000 : 40);
    await flushed;
    await closed;
    assert.equal(requests, 1);
    assert.equal(signal?.aborted, true);
    await exporter.close();
    t.mock.timers.reset();
  }
});
