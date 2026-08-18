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
import type { ProviderFailureResult } from '@maka/core/provider-failure';
import { providerFailureResult } from './provider-error-classification.js';

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
  readonly providerFailure?: ProviderFailureResult;
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
  // Status-only evidence still routes through the shared provider-failure
  // authority. A bare 403 is intentionally not authentication: providers use
  // it for valid-key permission failures, guardrails, and subscription limits.
  const providerFailure = providerFailureResult({ statusCode });
  switch (providerFailure.errorClass) {
    case 'Auth':
      return { kind: 'auth', statusCode, providerFailure };
    case 'RateLimit':
    case 'ProviderUnavailable':
    case 'ProviderBilling':
    case 'ProviderPermission':
    case 'UsageLimit':
      return { kind: 'provider_unavailable', statusCode, providerFailure };
    default:
      break;
  }
  if (statusCode === 408) return { kind: 'timeout', statusCode, providerFailure };
  return { kind: 'unknown', statusCode, providerFailure };
}
