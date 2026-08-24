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

import type { OAuthSubscriptionTokens } from './subscription-credentials.js';
import {
  OAUTH_MAX_TOKEN_CHARS,
  OAuthTokenEndpointError,
  oauthExpiresAt,
  optionalOAuthBoundedString,
  requireOAuthBoundedString,
  requireOAuthDataRecord,
  requireOAuthPositiveInteger,
} from './oauth-provider-contracts.js';

export { OAuthTokenEndpointError } from './oauth-provider-contracts.js';
export type { OAuthTokenEndpointErrorCategory } from './oauth-provider-contracts.js';

export type OAuthInitialTokenProvider = 'xai-oauth' | 'openai-codex';

export const OAUTH_LOGIN_MAX_RESPONSE_BYTES = 64 * 1024;
export const OAUTH_LOGIN_MAX_TOKEN_CHARS = OAUTH_MAX_TOKEN_CHARS;
export const OAUTH_LOGIN_DEFAULT_TIMEOUT_MS = 15_000;

export function isDeterministicOAuthCredentialRejection(error: unknown): boolean {
  return (
    error instanceof OAuthTokenEndpointError &&
    (error.category === 'invalid_grant' || error.category === 'invalid_token')
  );
}

export interface OAuthTokenEndpointJsonRequestInput {
  endpoint: string;
  init: RequestInit;
  fetchFn: typeof fetch;
  /** Optional caller cancellation; the endpoint deadline remains independently enforced. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface OAuthTokenEndpointJsonResponse {
  payload: unknown;
  status: number;
}

export interface OAuthEndpointJsonResponse extends OAuthTokenEndpointJsonResponse {
  ok: boolean;
}

export async function requestOAuthTokenEndpointJson(
  input: OAuthTokenEndpointJsonRequestInput,
): Promise<OAuthTokenEndpointJsonResponse> {
  const response = await requestOAuthEndpointJson(input);
  if (!response.ok) {
    const code = findProviderErrorCode(response.payload);
    const category =
      code === 'invalid_grant' || code === 'invalid_token' ? code : 'provider_rejected';
    throw new OAuthTokenEndpointError(category, response.status);
  }
  return { payload: response.payload, status: response.status };
}

export async function requestOAuthEndpointJson(
  input: OAuthTokenEndpointJsonRequestInput,
): Promise<OAuthEndpointJsonResponse> {
  const timeoutMs = input.timeoutMs ?? OAUTH_LOGIN_DEFAULT_TIMEOUT_MS;
  assertTokenEndpointTimeout(timeoutMs);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  input.signal?.addEventListener('abort', onAbort, { once: true });
  if (input.signal?.aborted) controller.abort();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (controller.signal.aborted) throw new OAuthTokenEndpointError('outcome_unknown');
    let response: Response;
    try {
      response = await raceWithAbort(
        input.fetchFn(input.endpoint, { ...input.init, signal: controller.signal }),
        controller.signal,
      );
    } catch {
      throw new OAuthTokenEndpointError('outcome_unknown');
    }
    return {
      payload: await readBoundedOAuthJson(response, controller.signal),
      status: response.status,
      ok: response.ok,
    };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', onAbort);
  }
}

export function decodeOAuthInitialTokenPayload(
  provider: OAuthInitialTokenProvider,
  payload: unknown,
  now = Date.now(),
): OAuthSubscriptionTokens {
  if (!Number.isFinite(now) || now < 0) throw new OAuthTokenEndpointError('invalid_response');
  const record = requireOAuthDataRecord(payload);
  const accessToken = requireOAuthBoundedString(record.access_token, OAUTH_LOGIN_MAX_TOKEN_CHARS);
  const refreshToken = requireOAuthBoundedString(record.refresh_token, OAUTH_LOGIN_MAX_TOKEN_CHARS);
  const expiresAt = oauthExpiresAt(
    now,
    requireOAuthPositiveInteger(record.expires_in, 366 * 24 * 60 * 60),
  );

  const idToken = optionalOAuthBoundedString(record.id_token, OAUTH_LOGIN_MAX_TOKEN_CHARS);
  const tokenType = optionalOAuthBoundedString(record.token_type, 256);
  const scope = optionalOAuthBoundedString(record.scope, 4 * 1024);
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    ...(idToken !== undefined ? { id_token: idToken } : {}),
    ...(tokenType !== undefined ? { token_type: tokenType } : {}),
    ...(scope !== undefined ? { scope } : {}),
  };
}

function assertTokenEndpointTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new OAuthTokenEndpointError('invalid_response');
  }
}

export async function readBoundedOAuthJson(
  response: Response,
  signal?: AbortSignal,
): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > OAUTH_LOGIN_MAX_RESPONSE_BYTES) {
      cancelBodyBestEffort(response.body);
      throw new OAuthTokenEndpointError('response_too_large', response.status);
    }
  }
  if (!response.body) throw new OAuthTokenEndpointError('invalid_response', response.status);
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    throw new OAuthTokenEndpointError('invalid_response', response.status);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cancelScheduled = false;
  let reachedEof = false;
  try {
    while (true) {
      const result = await readStreamChunk(reader, signal);
      if (result.done) {
        reachedEof = true;
        break;
      }
      total += result.value.byteLength;
      if (total > OAUTH_LOGIN_MAX_RESPONSE_BYTES) {
        cancelScheduled = true;
        cancelReaderBestEffort(reader);
        throw new OAuthTokenEndpointError('response_too_large', response.status);
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof OAuthTokenEndpointError) {
      throw error.status === undefined
        ? new OAuthTokenEndpointError(error.category, response.status)
        : error;
    }
    throw new OAuthTokenEndpointError('outcome_unknown', response.status);
  } finally {
    if (!cancelScheduled && (reachedEof || !signal?.aborted)) {
      try {
        reader.releaseLock();
      } catch {
        // A failed stream may leave a read pending. Lock cleanup cannot
        // hold up or replace the exchange verdict.
      }
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new OAuthTokenEndpointError('invalid_response', response.status);
  }
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) {
    try {
      return await reader.read();
    } catch {
      throw new OAuthTokenEndpointError('outcome_unknown');
    }
  }
  if (signal.aborted) {
    cancelReaderBestEffort(reader);
    throw new OAuthTokenEndpointError('outcome_unknown');
  }
  return await new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(new OAuthTokenEndpointError('outcome_unknown'));
      cancelReaderBestEffort(reader);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reader
      .read()
      .then(resolve, () => reject(new OAuthTokenEndpointError('outcome_unknown')))
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function cancelReaderBestEffort(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  queueMicrotask(() => {
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      // Cancellation is cleanup only and cannot replace the exchange verdict.
    }
  });
}

function cancelBodyBestEffort(body: ReadableStream<Uint8Array> | null): void {
  if (!body) return;
  queueMicrotask(() => {
    try {
      void body.cancel().catch(() => undefined);
    } catch {
      // Cancellation is cleanup only and cannot replace the endpoint verdict.
    }
  });
}

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new OAuthTokenEndpointError('outcome_unknown');
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new OAuthTokenEndpointError('outcome_unknown'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function findProviderErrorCode(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  if (typeof record.error === 'string') return record.error.toLowerCase();
  if (record.error && typeof record.error === 'object' && !Array.isArray(record.error)) {
    const nested = record.error as Record<string, unknown>;
    for (const value of [nested.code, nested.type]) {
      if (typeof value === 'string') return value.toLowerCase();
    }
  }
  if (typeof record.code === 'string') return record.code.toLowerCase();
  return undefined;
}
