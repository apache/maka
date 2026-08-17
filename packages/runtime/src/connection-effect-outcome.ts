import type { ModelDiscoverySource, ModelInfo, ProviderType } from '@maka/core/llm-connections';
import { classifyError } from './provider-error-classification.js';

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
  // Status-only evidence still routes through the shared provider-failure
  // authority. A bare 403 is intentionally not authentication: providers use
  // it for valid-key permission failures, guardrails, and subscription limits.
  switch (classifyError({ statusCode })) {
    case 'Auth':
      return { kind: 'auth', statusCode };
    case 'RateLimit':
    case 'ProviderUnavailable':
    case 'ProviderBilling':
    case 'ProviderPermission':
    case 'UsageLimit':
      return { kind: 'provider_unavailable', statusCode };
    default:
      break;
  }
  if (statusCode === 408) return { kind: 'timeout', statusCode };
  return { kind: 'unknown', statusCode };
}
