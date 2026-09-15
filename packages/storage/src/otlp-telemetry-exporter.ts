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

import { randomUUID } from 'node:crypto';
import type {
  PersistedLlmCallRecord,
  PersistedToolInvocationRecord,
} from './telemetry-file-schema.js';

const BATCH_SIZE = 32;
const FLUSH_DELAY_MS = 1_000;
const DEFAULT_SERVICE_NAME = 'maka';
const MAX_HEADER_COUNT = 32;
const MAX_HEADER_NAME_LENGTH = 128;
const MAX_HEADER_VALUE_LENGTH = 8_192;
const MAX_HEADER_BYTES = 64 * 1_024;
const DEFAULT_TIMEOUT_MS = 10_000;
// Host 在 10 秒后强制终止；导出器关闭最多占用 1 秒，为其余资源清理保留时间。
const CLOSE_TIMEOUT_MS = 1_000;
const ERROR_CLASSES = new Set([
  'Abort',
  'Auth',
  'ContextLength',
  'Network',
  'Timeout',
  'RateLimit',
  'ProviderBilling',
  'ProviderCapacity',
  'ProviderUnavailable',
  'Other',
  'ExclusiveStepConflict',
  'InvalidArguments',
  'AmbiguousComputerTarget',
  'LoopGate',
  'DeferredNotLoaded',
  'ExecutionBoundaryUnavailable',
  'ClientCapabilityBoundary',
  'ClientCapabilityPreparation',
  'RuntimeLimit',
  'OutcomeUnknown',
]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const PROTECTED_HEADERS = new Set([
  'connection',
  'content-length',
  'content-type',
  'host',
  'proxy-connection',
  'transfer-encoding',
]);
const insecureAuthorizationWarnings = new Set<string>();

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Environment = Record<string, string | undefined>;
type OtlpAttributeValue = { stringValue: string } | { intValue: string } | { doubleValue: number };
type OtlpAttribute = { key: string; value: OtlpAttributeValue };
type OtlpSpan = {
  traceId: string;
  spanId: string;
  name: string;
  kind: 1;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  status: { code: 0 | 1 | 2 };
};

export interface OtlpTelemetryExporter {
  exportLlmCall(record: PersistedLlmCallRecord): Promise<void>;
  exportToolInvocation(record: PersistedToolInvocationRecord): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface OtlpTelemetryExporterOptions {
  readonly env?: Environment;
  readonly fetch?: FetchLike;
}

export function createOtlpTelemetryExporter(
  options: OtlpTelemetryExporterOptions = {},
): OtlpTelemetryExporter | undefined {
  const env = options.env ?? process.env;
  const endpoint = resolveEndpoint(env);
  if (!endpoint) return undefined;
  const headers = parseHeaders(
    env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS,
  );
  warnForInsecureAuthorization(endpoint, headers);
  return new OtlpTelemetryExporterImpl(
    endpoint,
    headers,
    resourceAttributes(env),
    options.fetch ?? fetch,
    resolveTimeout(env),
  );
}

class OtlpTelemetryExporterImpl implements OtlpTelemetryExporter {
  readonly #endpoint: string;
  readonly #headers: Record<string, string>;
  readonly #resourceAttributes: OtlpAttribute[];
  readonly #fetch: FetchLike;
  readonly #pending: OtlpSpan[] = [];
  readonly #timeoutMs: number;
  readonly #shutdown = new AbortController();
  #timer: NodeJS.Timeout | undefined;
  #flushPromise: Promise<void> | undefined;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #failureReported = false;

  constructor(
    endpoint: string,
    headers: Record<string, string>,
    resourceAttributes: OtlpAttribute[],
    fetchFn: FetchLike,
    timeoutMs: number,
  ) {
    this.#endpoint = endpoint;
    this.#headers = headers;
    this.#resourceAttributes = resourceAttributes;
    this.#fetch = fetchFn;
    this.#timeoutMs = timeoutMs;
  }

  async exportLlmCall(record: PersistedLlmCallRecord): Promise<void> {
    const errorClass = boundedErrorClass(record.errorClass);
    await this.enqueue({
      name: 'maka.llm.call',
      startedAt: record.startedAt,
      durationMs: record.latencyMs,
      status: record.status,
      attributes: [
        stringAttribute('maka.telemetry.kind', 'llm'),
        stringAttribute('maka.provider.id', record.providerId),
        stringAttribute('maka.model.id', record.modelId),
        ...(record.callKind ? [stringAttribute('maka.call.kind', record.callKind)] : []),
        numberAttribute('maka.usage.input_tokens', record.inputTokens),
        numberAttribute('maka.usage.output_tokens', record.outputTokens),
        numberAttribute('maka.usage.total_tokens', record.totalTokens),
        numberAttribute('maka.usage.cost_usd', record.costUsd),
        ...(errorClass ? [stringAttribute('maka.error.class', errorClass)] : []),
      ],
    });
  }

  async exportToolInvocation(record: PersistedToolInvocationRecord): Promise<void> {
    const errorClass = boundedErrorClass(record.errorClass);
    await this.enqueue({
      name: 'maka.tool.invocation',
      startedAt: record.startedAt,
      durationMs: record.durationMs,
      status: record.status,
      attributes: [
        stringAttribute('maka.telemetry.kind', 'tool'),
        stringAttribute('maka.tool.name', record.toolName),
        ...(record.providerId ? [stringAttribute('maka.provider.id', record.providerId)] : []),
        ...(record.modelId ? [stringAttribute('maka.model.id', record.modelId)] : []),
        numberAttribute('maka.tool.bytes_in', record.bytesIn),
        numberAttribute('maka.tool.bytes_out', record.bytesOut),
        ...(errorClass ? [stringAttribute('maka.error.class', errorClass)] : []),
      ],
    });
  }

  async flush(): Promise<void> {
    if (this.#flushPromise) await this.#flushPromise;
    while (this.#pending.length > 0) {
      const spans = this.#pending.splice(0);
      if (this.#timer) {
        clearTimeout(this.#timer);
        this.#timer = undefined;
      }
      this.#flushPromise = this.send(spans).finally(() => {
        this.#flushPromise = undefined;
      });
      await this.#flushPromise;
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    const timer = setTimeout(() => this.#shutdown.abort(), CLOSE_TIMEOUT_MS);
    this.#closePromise = this.flush().finally(() => clearTimeout(timer));
    return this.#closePromise;
  }

  private async enqueue(input: {
    name: string;
    startedAt: number;
    durationMs: number;
    status: PersistedLlmCallRecord['status'];
    attributes: OtlpAttribute[];
  }): Promise<void> {
    if (this.#closed) return;
    this.#pending.push(toSpan(input));
    if (this.#pending.length >= BATCH_SIZE) {
      await this.flush();
      return;
    }
    if (!this.#timer) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        void this.flush();
      }, FLUSH_DELAY_MS);
    }
  }

  private async send(spans: OtlpSpan[]): Promise<void> {
    if (this.#shutdown.signal.aborted) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, this.#timeoutMs);
    this.#shutdown.signal.addEventListener('abort', abort, { once: true });
    const cancelled = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(new Error('OTLP request cancelled')),
        { once: true },
      );
    });
    try {
      // 同时约束请求及响应释放；即使注入的 transport 不响应 AbortSignal，也不阻塞关闭。
      const response = await Promise.race([this.sendRequest(spans, controller.signal), cancelled]);
      if (response.ok) {
        this.#failureReported = false;
      } else {
        this.reportFailure(`HTTP ${response.status}`);
      }
    } catch {
      this.reportFailure('request error');
    } finally {
      clearTimeout(timer);
      this.#shutdown.signal.removeEventListener('abort', abort);
    }
  }

  private async sendRequest(spans: OtlpSpan[], signal: AbortSignal): Promise<Response> {
    const response = await this.#fetch(this.#endpoint, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', ...this.#headers },
      body: JSON.stringify({
        resourceSpans: [
          {
            resource: { attributes: this.#resourceAttributes },
            scopeSpans: [{ scope: { name: 'maka.storage' }, spans }],
          },
        ],
      }),
    });
    await response.body?.cancel();
    return response;
  }

  private reportFailure(reason: string): void {
    if (this.#failureReported) return;
    this.#failureReported = true;
    console.error(`[telemetry] OTLP export failed: ${reason}`);
  }
}

function toSpan(input: {
  name: string;
  startedAt: number;
  durationMs: number;
  status: PersistedLlmCallRecord['status'];
  attributes: OtlpAttribute[];
}): OtlpSpan {
  const traceId = randomUUID().replaceAll('-', '');
  const startedAt = normalizeTimestamp(input.startedAt);
  const endedAt = normalizeTimestamp(input.startedAt + Math.max(0, input.durationMs));
  return {
    traceId,
    spanId: traceId.slice(0, 16),
    name: input.name,
    kind: 1,
    startTimeUnixNano: unixNanoseconds(startedAt),
    endTimeUnixNano: unixNanoseconds(endedAt),
    attributes: input.attributes,
    status: { code: input.status === 'success' ? 1 : input.status === 'error' ? 2 : 0 },
  };
}

function stringAttribute(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}

function numberAttribute(key: string, value: number): OtlpAttribute {
  return { key, value: { doubleValue: value } };
}

function resolveEndpoint(env: Environment): string | undefined {
  const configured = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!configured) return undefined;
  try {
    const url = new URL(configured);
    if (env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT === undefined) {
      url.pathname = `${url.pathname.replace(/\/+$/u, '')}/v1/traces`;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function resolveTimeout(env: Environment): number {
  const configured = env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT ?? env.OTEL_EXPORTER_OTLP_TIMEOUT;
  const timeout = Number(configured);
  return Number.isInteger(timeout) && timeout > 0 && timeout <= 2_147_483_647
    ? timeout
    : DEFAULT_TIMEOUT_MS;
}

function parseHeaders(value: string | undefined): Record<string, string> {
  if (!value) return {};
  const headers = Object.create(null) as Record<string, string>;
  const names = new Set<string>();
  let encodedBytes = 0;
  for (const item of value.split(',')) {
    const separator = item.indexOf('=');
    if (separator <= 0) continue;
    const key = item.slice(0, separator).trim();
    const raw = item.slice(separator + 1).trim();
    if (
      !key ||
      key.length > MAX_HEADER_NAME_LENGTH ||
      !HEADER_NAME.test(key) ||
      PROTECTED_HEADERS.has(key.toLowerCase())
    ) {
      continue;
    }
    const lowerKey = key.toLowerCase();
    if (names.has(lowerKey) || names.size >= MAX_HEADER_COUNT) continue;
    const decoded = decodeValue(raw);
    if (
      !raw ||
      decoded.length > MAX_HEADER_VALUE_LENGTH ||
      /[^\t\u0020-\u007e\u0080-\u00ff]/u.test(decoded)
    ) {
      continue;
    }
    const entryBytes = new TextEncoder().encode(`${key}:${decoded}`).byteLength;
    if (encodedBytes + entryBytes > MAX_HEADER_BYTES) break;
    encodedBytes += entryBytes;
    names.add(lowerKey);
    headers[key] = decoded;
  }
  return headers;
}

function warnForInsecureAuthorization(endpoint: string, headers: Record<string, string>): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return;
  }
  if (url.protocol === 'https:') return;
  const hasAuthorization = Object.keys(headers).some(
    (name) => name.toLowerCase() === 'authorization',
  );
  if (hasAuthorization && !insecureAuthorizationWarnings.has(endpoint)) {
    insecureAuthorizationWarnings.add(endpoint);
    console.warn(
      '[telemetry] OTLP endpoint is not using HTTPS while an authorization header is configured; credentials and telemetry will be sent without transport encryption',
    );
  }
}

function boundedErrorClass(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // Error.name 可由工具任意设置，长度限制不能保证其中不含凭据。
  return ERROR_CLASSES.has(value) ? value : 'Other';
}

function normalizeTimestamp(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function unixNanoseconds(milliseconds: number): string {
  return (BigInt(milliseconds) * 1_000_000n).toString();
}

function resourceAttributes(env: Environment): OtlpAttribute[] {
  const attributes = new Map<string, string>();
  attributes.set('service.name', env.OTEL_SERVICE_NAME?.trim() || DEFAULT_SERVICE_NAME);
  for (const item of env.OTEL_RESOURCE_ATTRIBUTES?.split(',') ?? []) {
    const separator = item.indexOf('=');
    if (separator <= 0) continue;
    const key = item.slice(0, separator).trim();
    if (key) attributes.set(key, decodeValue(item.slice(separator + 1).trim()));
  }
  return [...attributes].map(([key, value]) => stringAttribute(key, value));
}

function decodeValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
