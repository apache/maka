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

import { proxiedFetch, type ProxiedFetchInit } from './bots/proxied-fetch.js';
import { ConnectionEffectInvalidResponseError } from './connection-effect-outcome.js';

export type ConnectionEffectFetch = typeof globalThis.fetch;
export const CONNECTION_EFFECT_JSON_BODY_MAX_BYTES = 4 * 1024 * 1024;
export const CONNECTION_EFFECT_ERROR_BODY_MAX_BYTES = 16 * 1024;

export interface ConnectionEffectFetchOptions {
  readonly fetch?: ConnectionEffectFetch;
}

export interface ConnectionEffectFetchDependency {
  readonly fetch: ConnectionEffectFetch;
}

export class ConnectionEffectFetchError extends Error {
  constructor(
    public readonly kind: 'timeout' | 'network',
    options?: ErrorOptions,
  ) {
    super(kind === 'timeout' ? 'Fetch timeout' : 'Network request failed', options);
    this.name = 'ConnectionEffectFetchError';
  }
}

export interface ConnectionEffectResponse {
  readonly ok: boolean;
  readonly status: number;
  readJson<T>(): Promise<T>;
  readText(maxBytes?: number): Promise<string>;
  cancel(): Promise<void>;
}

export async function fetchForConnectionEffect(
  fetchFn: ConnectionEffectFetch | undefined,
  input: string | URL,
  init: ProxiedFetchInit = {},
): Promise<ConnectionEffectResponse> {
  const { timeoutMs = 15_000, signal, ...requestInit } = init;
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const abortFromCaller = () => {
    if (isTimeoutReason(signal?.reason)) timedOut = true;
    controller.abort(signal?.reason);
  };
  if (signal) {
    if (signal.aborted) abortFromCaller();
    else signal.addEventListener('abort', abortFromCaller, { once: true });
  }
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new ConnectionEffectFetchError('timeout'));
    }, timeoutMs);
  }

  try {
    // Own the timeout above both transports so it remains active until the
    // response body is consumed or cancelled. proxiedFetch's native timeout
    // ends at headers because it also serves streaming callers.
    const response = fetchFn
      ? await fetchFn(input, {
          ...requestInit,
          signal: controller.signal,
        } as RequestInit)
      : await proxiedFetch(input.toString(), {
          ...requestInit,
          signal: controller.signal,
          timeoutMs: 0,
        });
    return manageConnectionEffectResponse(response, {
      didTimeOut: () => timedOut,
      finish: () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', abortFromCaller);
      },
    });
  } catch (error) {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromCaller);
    throw connectionEffectFetchFailure(error, timedOut);
  }
}

function manageConnectionEffectResponse(
  response: Response,
  lifecycle?: {
    readonly didTimeOut: () => boolean;
    readonly finish: () => void;
  },
): ConnectionEffectResponse {
  let claimed = false;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    lifecycle?.finish();
  };
  const claim = () => {
    if (claimed) {
      throw new ConnectionEffectInvalidResponseError(
        'Connection effect response body was already handled',
      );
    }
    claimed = true;
  };
  const cancel = async (): Promise<void> => {
    if (claimed) return;
    claimed = true;
    try {
      await response.body?.cancel();
    } catch {
      // Cancellation is best-effort; the owning transport is still closed by the effect.
    } finally {
      finish();
    }
    if (lifecycle?.didTimeOut() === true) {
      throw new ConnectionEffectFetchError('timeout');
    }
  };
  const readText = async (maxBytes = CONNECTION_EFFECT_ERROR_BODY_MAX_BYTES): Promise<string> => {
    claim();
    try {
      return new TextDecoder().decode(await readBoundedBody(response, maxBytes));
    } catch (error) {
      throw connectionEffectFetchFailure(error, lifecycle?.didTimeOut() === true);
    } finally {
      finish();
    }
  };

  return {
    ok: response.ok,
    status: response.status,
    readJson: async <T>(): Promise<T> => {
      const text = await readText(CONNECTION_EFFECT_JSON_BODY_MAX_BYTES);
      try {
        return JSON.parse(text) as T;
      } catch (error) {
        throw new ConnectionEffectInvalidResponseError('Invalid provider JSON response', {
          cause: error,
        });
      }
    },
    readText,
    cancel,
  };
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new ConnectionEffectInvalidResponseError('Invalid connection effect body limit');
  }
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ConnectionEffectInvalidResponseError('Provider response body exceeded its limit');
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ConnectionEffectInvalidResponseError('Provider response body exceeded its limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function connectionEffectFetchFailure(error: unknown, timedOut: boolean): Error {
  if (timedOut) return new ConnectionEffectFetchError('timeout', { cause: error });
  if (
    error instanceof ConnectionEffectFetchError ||
    error instanceof ConnectionEffectInvalidResponseError
  ) {
    return error;
  }
  return new ConnectionEffectFetchError('network', { cause: error });
}

function isTimeoutReason(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'TimeoutError';
}
