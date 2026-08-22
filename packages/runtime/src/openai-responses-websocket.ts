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

import { isDeepStrictEqual } from 'node:util';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import WebSocket from 'ws';

import type { ModelMessage } from './model-protocol.js';
import { matchesBypassList } from './network/bypass-matcher.js';
import { FETCH_PROXY_SNAPSHOT, type ProxiedFetchProxy } from './network/scoped-fetch-transport.js';
import { bracketIfIpv6, buildProxyUrl } from './network/proxy-parser.js';
import type { OpenAiResponsesSemanticBaseline } from './openai-responses-continuation.js';

export const OPENAI_RESPONSES_LANE_HEADER = 'x-maka-openai-responses-lane';
const RESPONSES_WEBSOCKET_PROTOCOL = 'responses_websockets=2026-02-06';
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_FAILURE_COOLDOWN_MS = 5 * 60_000;

interface WireBaseline {
  fullBody: Record<string, unknown>;
  responseId: string;
  responseOutput: unknown[];
}

interface LaneState {
  socket?: WebSocket;
  busy: boolean;
  httpFallback: boolean;
  wire?: WireBaseline;
  semantic?: OpenAiResponsesSemanticBaseline;
  pendingSemantic?: Omit<OpenAiResponsesSemanticBaseline, 'responseMessages'>;
}

export interface OpenAiResponsesTransportOptions {
  webSocketUrl?: string;
  connectTimeoutMs?: number;
  /** Suppress new socket attempts after a transport failure. Defaults to five minutes. */
  failureCooldownMs?: number;
  /** Injectable clock for deterministic cooldown tests. */
  now?: () => number;
}

export class OpenAiResponsesTransportState {
  private readonly lanes = new Map<string, LaneState>();
  private webSocketUnavailableUntil = 0;

  constructor(private readonly options: OpenAiResponsesTransportOptions = {}) {}

  semanticBaseline(lane: string): OpenAiResponsesSemanticBaseline | undefined {
    return this.lanes.get(lane)?.semantic;
  }

  hasPendingSemantic(lane: string): boolean {
    return this.lanes.get(lane)?.pendingSemantic !== undefined;
  }

  recordSemanticRequest(
    lane: string,
    baseline: Omit<OpenAiResponsesSemanticBaseline, 'responseMessages'>,
  ): void {
    const state = this.lanes.get(lane);
    if (!state || state.httpFallback || state.wire?.responseId !== baseline.responseId) return;
    state.semantic = undefined;
    state.pendingSemantic = baseline;
  }

  recordSemanticResponse(lane: string, responseMessages: readonly ModelMessage[]): void {
    const state = this.lanes.get(lane);
    const pending = state?.pendingSemantic;
    if (!state || !pending || state.httpFallback || state.wire?.responseId !== pending.responseId) {
      if (state) {
        state.semantic = undefined;
        state.pendingSemantic = undefined;
      }
      return;
    }
    state.semantic = {
      ...pending,
      responseMessages: structuredClone(responseMessages),
    };
    state.pendingSemantic = undefined;
  }

  clearSemantic(lane: string): void {
    const state = this.lanes.get(lane);
    if (state) {
      state.semantic = undefined;
      state.pendingSemantic = undefined;
    }
  }

  canRecordSemantic(lane: string, responseId: string): boolean {
    const state = this.lanes.get(lane);
    return state?.httpFallback === false && state.wire?.responseId === responseId;
  }

  wrapFetch(httpFetch: typeof globalThis.fetch): typeof globalThis.fetch {
    return async (input, init) => await this.fetch(input, init, httpFetch);
  }

  endLane(lane: string): void {
    const state = this.lanes.get(lane);
    if (!state) return;
    terminate(state.socket);
    this.lanes.delete(lane);
  }

  close(): void {
    for (const state of this.lanes.values()) terminate(state.socket);
    this.lanes.clear();
  }

  private async fetch(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    httpFetch: typeof globalThis.fetch,
  ): Promise<Response> {
    const url = requestUrl(input);
    const headers = new Headers(init?.headers);
    const lane = headers.get(OPENAI_RESPONSES_LANE_HEADER) ?? undefined;
    headers.delete(OPENAI_RESPONSES_LANE_HEADER);
    const cleanInit = { ...init, headers };
    const body = parseStreamingResponsesBody(url, cleanInit);
    if (!lane || !body) return await httpFetch(input, cleanInit);

    const state = this.lanes.get(lane) ?? { busy: false, httpFallback: false };
    this.lanes.set(lane, state);
    const prepared = prepareWireRequest(body, state.wire);
    if (!prepared) {
      state.semantic = undefined;
      state.pendingSemantic = undefined;
      state.httpFallback = true;
      return failedStream(
        retryableTransportError(
          'OpenAI Responses continuation state is unavailable',
          'OPENAI_RESPONSES_CONTINUATION_UNAVAILABLE',
        ),
      );
    }

    // A failure on one concurrent lane should prevent new connection attempts,
    // not evict another lane's already healthy socket.
    const failureCooldownActive =
      state.socket?.readyState !== WebSocket.OPEN && this.failureCooldownActive();
    if (state.httpFallback || failureCooldownActive || state.busy) {
      state.semantic = undefined;
      state.pendingSemantic = undefined;
      return await httpFetch(input, withJsonBody(cleanInit, prepared.fullBody));
    }

    // `store: false` continuations exist only in the server memory attached to
    // this exact socket. A reconnect must start a fresh chain with the complete
    // reconstructed body; sending the old id on a new socket is guaranteed to
    // produce previous_response_not_found.
    const wireBody =
      body.previous_response_id !== undefined && state.socket?.readyState !== WebSocket.OPEN
        ? prepared.fullBody
        : prepared.wireBody;
    state.busy = true;
    try {
      state.socket = await this.openSocketIfNeeded(state, url, headers, httpFetch, init?.signal);
    } catch (error) {
      state.busy = false;
      state.httpFallback = true;
      state.semantic = undefined;
      state.pendingSemantic = undefined;
      terminate(state.socket);
      state.socket = undefined;
      if (isAbort(error, init?.signal)) throw error;
      this.deferWebSocketRetry();
      return await httpFetch(input, withJsonBody(cleanInit, prepared.fullBody));
    }

    return websocketResponse({
      socket: state.socket,
      body: wireBody,
      signal: init?.signal ?? undefined,
      onComplete: (response) => {
        state.busy = false;
        const responseId = typeof response.id === 'string' ? response.id : undefined;
        const output = Array.isArray(response.output) ? response.output : undefined;
        if (!responseId || !output) {
          invalidateLane(state, false);
          return;
        }
        state.wire = {
          fullBody: prepared.fullBody,
          responseId,
          responseOutput: structuredClone(output),
        };
      },
      onFailure: (fallback) => {
        state.busy = false;
        state.semantic = undefined;
        state.pendingSemantic = undefined;
        state.wire = undefined;
        if (fallback) {
          state.httpFallback = true;
          this.deferWebSocketRetry();
        }
        terminate(state.socket);
        state.socket = undefined;
      },
    });
  }

  private failureCooldownActive(): boolean {
    return this.webSocketUnavailableUntil > (this.options.now ?? Date.now)();
  }

  private deferWebSocketRetry(): void {
    const cooldownMs = this.options.failureCooldownMs ?? DEFAULT_FAILURE_COOLDOWN_MS;
    this.webSocketUnavailableUntil = (this.options.now ?? Date.now)() + Math.max(0, cooldownMs);
  }

  private async openSocketIfNeeded(
    state: LaneState,
    httpUrl: string,
    headers: Headers,
    httpFetch: typeof globalThis.fetch,
    signal: AbortSignal | null | undefined,
  ): Promise<WebSocket> {
    if (state.socket?.readyState === WebSocket.OPEN) return state.socket;
    terminate(state.socket);
    const wsUrl = this.options.webSocketUrl ?? httpUrl.replace(/^http/, 'ws');
    const wsHeaders = Object.fromEntries(headers.entries());
    delete wsHeaders['content-length'];
    wsHeaders['openai-beta'] ??= RESPONSES_WEBSOCKET_PROTOCOL;
    return await connectWebSocket(
      wsUrl,
      wsHeaders,
      this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      webSocketProxyAgent(httpFetch, httpUrl),
      signal ?? undefined,
    );
  }
}

export function createOpenAiResponsesTransportState(
  options?: OpenAiResponsesTransportOptions,
): OpenAiResponsesTransportState {
  return new OpenAiResponsesTransportState(options);
}

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof URL ? input.toString() : typeof input === 'string' ? input : input.url;
}

function parseStreamingResponsesBody(
  url: string,
  init: RequestInit | undefined,
): Record<string, unknown> | undefined {
  if (init?.method !== 'POST' || !new URL(url).pathname.endsWith('/responses')) return undefined;
  if (typeof init.body !== 'string') return undefined;
  try {
    const value = JSON.parse(init.body) as unknown;
    return isRecord(value) && value.stream === true ? value : undefined;
  } catch {
    return undefined;
  }
}

function prepareWireRequest(
  body: Record<string, unknown>,
  baseline: WireBaseline | undefined,
): { wireBody: Record<string, unknown>; fullBody: Record<string, unknown> } | undefined {
  const previousResponseId = body.previous_response_id;
  if (previousResponseId === undefined) {
    return { wireBody: body, fullBody: body };
  }
  if (
    typeof previousResponseId !== 'string' ||
    baseline?.responseId !== previousResponseId ||
    !Array.isArray(baseline.fullBody.input) ||
    !Array.isArray(body.input)
  ) {
    return undefined;
  }

  const { previous_response_id: _previousResponseId, ...currentProperties } = body;
  const fullBody = {
    ...currentProperties,
    input: [
      ...structuredClone(baseline.fullBody.input),
      ...structuredClone(baseline.responseOutput),
      ...structuredClone(body.input),
    ],
  };
  const sameProperties = isDeepStrictEqual(
    requestProperties(baseline.fullBody),
    requestProperties(fullBody),
  );
  return {
    wireBody: sameProperties ? body : fullBody,
    fullBody,
  };
}

function requestProperties(body: Record<string, unknown>): Record<string, unknown> {
  const { input: _input, previous_response_id: _previousResponseId, ...properties } = body;
  return properties;
}

function withJsonBody(init: RequestInit | undefined, body: Record<string, unknown>): RequestInit {
  const headers = new Headers(init?.headers);
  headers.delete('content-length');
  return { ...init, headers, body: JSON.stringify(body) };
}

function websocketResponse(input: {
  socket: WebSocket;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  onComplete: (response: Record<string, unknown>) => void;
  onFailure: (fallback: boolean) => void;
}): Response {
  const encoder = new TextEncoder();
  let settled = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;

  const cleanup = () => {
    input.socket.off('message', onMessage);
    input.socket.off('error', onError);
    input.socket.off('close', onClose);
    input.signal?.removeEventListener('abort', onAbort);
  };
  const fail = (error: Error, fallback: boolean) => {
    if (settled) return;
    settled = true;
    cleanup();
    input.onFailure(fallback);
    controller.error(error);
  };
  const failTransport = (error: Error) =>
    fail(
      retryableTransportError(
        error.message || 'OpenAI Responses WebSocket transport failed',
        'OPENAI_RESPONSES_WEBSOCKET_TRANSPORT_ERROR',
      ),
      true,
    );
  const finish = (response: Record<string, unknown>) => {
    if (settled) return;
    settled = true;
    cleanup();
    input.onComplete(response);
    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    controller.close();
  };
  const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
    if (isBinary) {
      failTransport(new Error('Unexpected binary OpenAI Responses WebSocket frame'));
      return;
    }
    const text = data.toString();
    let event: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (isRecord(parsed)) event = parsed;
    } catch {
      // Let the SDK report malformed provider data after receiving the SSE line.
    }
    controller.enqueue(encoder.encode(`data: ${text}\n\n`));
    if (!event) return;
    if (
      event.type === 'response.completed' ||
      event.type === 'response.done' ||
      (event.type === 'response.incomplete' && incompleteReason(event) === 'max_output_tokens')
    ) {
      finish(isRecord(event.response) ? event.response : {});
    } else if (event.type === 'response.incomplete') {
      const reason = incompleteReason(event) ?? 'unknown';
      fail(new Error(`OpenAI Responses stream incomplete (${reason})`), false);
    } else if (event.type === 'response.failed' || event.type === 'error') {
      settled = true;
      cleanup();
      input.onFailure(false);
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    }
  };
  const onError = (error: Error) => failTransport(error);
  const onClose = (code: number, reason: Buffer) =>
    failTransport(
      new Error(
        `OpenAI Responses WebSocket closed before completion (code ${code}${reason.length ? `: ${reason.toString()}` : ''})`,
      ),
    );
  const onAbort = () =>
    fail(
      input.signal?.reason instanceof Error
        ? input.signal.reason
        : new DOMException('Aborted', 'AbortError'),
      false,
    );

  return new Response(
    new ReadableStream<Uint8Array>({
      start(next) {
        controller = next;
        input.socket.on('message', onMessage);
        input.socket.once('error', onError);
        input.socket.once('close', onClose);
        input.signal?.addEventListener('abort', onAbort, { once: true });
        if (input.signal?.aborted) {
          onAbort();
          return;
        }
        const { stream: _stream, background: _background, ...body } = input.body;
        input.socket.send(JSON.stringify({ type: 'response.create', ...body }), (error) => {
          if (error) failTransport(error);
        });
      },
      cancel() {
        if (settled) return;
        settled = true;
        cleanup();
        input.onFailure(false);
        terminate(input.socket);
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function connectWebSocket(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  agent: HttpsProxyAgent<string> | SocksProxyAgent | undefined,
  signal?: AbortSignal,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'),
      );
      return;
    }
    const socket = new WebSocket(url, { headers, ...(agent ? { agent } : {}) });
    // `websocketResponse` removes its request-scoped listener after a successful
    // stream while the OPEN socket remains reusable. ws emits idle protocol
    // errors unconditionally, so retain one process-safety listener for the
    // socket's entire lifetime.
    socket.on('error', ignoreWebSocketError);
    const timer = setTimeout(
      () => finish(new Error('OpenAI Responses WebSocket connect timed out')),
      timeoutMs,
    );
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('open', onOpen);
      socket.off('error', onError);
      socket.off('close', onClose);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (error?: Error) => {
      cleanup();
      if (error) {
        terminate(socket);
        reject(error);
      } else {
        resolve(socket);
      }
    };
    const onOpen = () => finish();
    const onError = (error: Error) => finish(error);
    const onClose = (code: number) => finish(new Error(`WebSocket closed during setup (${code})`));
    const onAbort = () =>
      finish(
        signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'),
      );
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function failedStream(error: Error): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(error);
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function invalidateLane(state: LaneState, fallback: boolean): void {
  state.busy = false;
  state.semantic = undefined;
  state.pendingSemantic = undefined;
  state.wire = undefined;
  state.httpFallback ||= fallback;
  terminate(state.socket);
  state.socket = undefined;
}

function terminate(socket: WebSocket | undefined): void {
  if (!socket) return;
  socket.terminate();
}

function ignoreWebSocketError(): void {}

function retryableTransportError(message: string, code: string): Error {
  return Object.assign(new Error(message), { name: 'OpenAiResponsesTransportError', code });
}

function incompleteReason(event: Record<string, unknown>): string | undefined {
  const response = isRecord(event.response) ? event.response : undefined;
  const details = isRecord(response?.incomplete_details) ? response.incomplete_details : undefined;
  return typeof details?.reason === 'string' ? details.reason : undefined;
}

function isAbort(error: unknown, signal: AbortSignal | null | undefined): boolean {
  return signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError');
}

export function webSocketProxyAgent(
  httpFetch: typeof globalThis.fetch,
  url: string,
): HttpsProxyAgent<string> | SocksProxyAgent | undefined {
  const proxy = (
    httpFetch as typeof globalThis.fetch & {
      [FETCH_PROXY_SNAPSHOT]?: ProxiedFetchProxy | null;
    }
  )[FETCH_PROXY_SNAPSHOT];
  if (!proxy?.enabled || matchesBypassList(new URL(url).hostname, [...proxy.bypassList])) {
    return undefined;
  }
  if (proxy.type === 'socks5') {
    const auth = proxy.username
      ? `${encodeURIComponent(proxy.username)}${
          proxy.password ? `:${encodeURIComponent(proxy.password)}` : ''
        }@`
      : '';
    return new SocksProxyAgent(
      `socks5://${auth}${bracketIfIpv6(proxy.host)}:${String(proxy.port)}`,
    );
  }
  return new HttpsProxyAgent(buildProxyUrl({ ...proxy, bypassList: [...proxy.bypassList] }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
