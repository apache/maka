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
import type { PersistedLlmCallRecord } from '../telemetry-file-schema.js';
import {
  createOtlpTelemetryExporter,
  type OtlpTelemetryExporterOptions,
} from '../otlp-telemetry-exporter.js';

test('exports bounded usage spans through OTLP/HTTP', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const options: OtlpTelemetryExporterOptions = {
    env: {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test',
      OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20secret,invalid',
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
  const payload = JSON.parse(String(requests[0]?.init.body));
  const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(payload.resourceSpans[0].resource.attributes[0].value.stringValue, 'maka-test');
  assert.equal(span.name, 'maka.llm.call');
  assert.equal(
    span.attributes.some((item: { key: string }) => item.key === 'argsSummary'),
    false,
  );
});

test('does not create an exporter without an OTLP endpoint', () => {
  assert.equal(createOtlpTelemetryExporter({ env: {} }), undefined);
});

test('normalizes an explicitly configured traces endpoint with a trailing slash', async () => {
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

  assert.deepEqual(requests, ['https://collector.example.test/v1/traces']);
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
