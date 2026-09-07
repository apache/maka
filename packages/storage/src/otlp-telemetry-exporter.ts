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
const MAX_ERROR_CLASS_LENGTH = 128;
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
  const headers = parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS);
  warnForInsecureAuthorization(endpoint, headers);
  return new OtlpTelemetryExporterImpl(
    endpoint,
    headers,
    resourceAttributes(env),
    options.fetch ?? fetch,
  );
}

class OtlpTelemetryExporterImpl implements OtlpTelemetryExporter {
  readonly #endpoint: string;
  readonly #headers: Record<string, string>;
  readonly #resourceAttributes: OtlpAttribute[];
  readonly #fetch: FetchLike;
  readonly #pending: OtlpSpan[] = [];
  #timer: NodeJS.Timeout | undefined;
  #flushPromise: Promise<void> | undefined;
  #closed = false;

  constructor(
    endpoint: string,
    headers: Record<string, string>,
    resourceAttributes: OtlpAttribute[],
    fetchFn: FetchLike,
  ) {
    this.#endpoint = endpoint;
    this.#headers = headers;
    this.#resourceAttributes = resourceAttributes;
    this.#fetch = fetchFn;
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

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.flush();
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
    try {
      const response = await this.#fetch(this.#endpoint, {
        method: 'POST',
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
      if (!response.ok) {
        console.error(`[telemetry] OTLP export failed: HTTP ${response.status}`);
      }
    } catch {
      console.error('[telemetry] OTLP export failed: request error');
    }
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
    const pathname = url.pathname.replace(/\/+$/u, '');
    url.pathname = pathname.endsWith('/v1/traces') ? pathname : `${pathname}/v1/traces`;
    return url.toString();
  } catch {
    return undefined;
  }
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
  const sanitized = value.trim().replace(/[\u0000-\u001f\u007f-\u009f]/gu, '');
  if (!sanitized) return undefined;
  return Array.from(sanitized).slice(0, MAX_ERROR_CLASS_LENGTH).join('');
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
