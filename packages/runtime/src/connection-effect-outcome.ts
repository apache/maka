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

import type { ModelDiscoverySource, ModelInfo, ProviderType } from '@maka/core/llm-connections';

export interface ConnectionEffectConnection {
  readonly providerType: ProviderType;
  readonly baseUrl?: string;
  readonly defaultModel?: string;
  readonly enabledModelIds?: readonly string[];
  readonly models?: readonly ModelInfo[];
  readonly modelSource?: ModelDiscoverySource;
}

export type ConnectionEffectErrorKind =
  | 'auth'
  | 'timeout'
  | 'provider_unavailable'
  | 'network'
  | 'invalid_response'
  | 'unknown';

export interface ConnectionEffectError {
  readonly kind: ConnectionEffectErrorKind;
  readonly statusCode?: number;
}

export type ConnectionModelDiscoveryEffectOutcome =
  | { readonly ok: true; readonly models: readonly ModelInfo[] }
  | { readonly ok: false; readonly error: ConnectionEffectError };

export type ConnectionTestEffectOutcome =
  | {
      readonly ok: true;
      readonly modelId: string;
      readonly latencyMs: number;
    }
  | {
      readonly ok: false;
      readonly error: ConnectionEffectError;
      readonly modelId?: string;
      readonly latencyMs?: number;
    };

export class ConnectionEffectHttpError extends Error {
  constructor(public readonly status: number) {
    super(`HTTP ${status}`);
    this.name = 'ConnectionEffectHttpError';
  }
}

export class ConnectionEffectInvalidResponseError extends Error {
  constructor(message = 'Invalid provider response', options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConnectionEffectInvalidResponseError';
  }
}

export function classifyConnectionEffectStatus(statusCode: number): ConnectionEffectError {
  if (statusCode === 401 || statusCode === 403) return { kind: 'auth', statusCode };
  if (statusCode === 408) return { kind: 'timeout', statusCode };
  if (statusCode === 429 || (statusCode >= 500 && statusCode <= 599)) {
    return { kind: 'provider_unavailable', statusCode };
  }
  return { kind: 'unknown', statusCode };
}
