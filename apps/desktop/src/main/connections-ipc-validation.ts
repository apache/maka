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

import {
  normalizeConnectionBaseUrl,
  type CreateConnectionInput,
  type ProviderType,
  type UpdateConnectionInput,
} from '@maka/core/llm-connections';
import {
  normalizeOptionalRequestBodyOverlay,
  normalizeRequestHeaders,
  normalizeRequestHeaderUpdates,
  type RequestHeaderUpdate,
} from '@maka/core/runtime-policy';
import { PROVIDER_DEFAULTS } from '@maka/core/llm-connections';
import { normalizeRelayModelProfiles } from '@maka/core/model-thinking';

const IPC_CONNECTION_SLUG_MAX_LENGTH = 64;
const IPC_CONNECTION_SECRET_MAX_LENGTH = 4096;
const IPC_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;
const IPC_CONNECTION_SLUG_PATTERN = /^[A-Za-z0-9._-]+$/;

export function normalizeConnectionSlugForIpc(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  if (value.length === 0) throw new Error(`${label} is required`);
  if (value.length > IPC_CONNECTION_SLUG_MAX_LENGTH) {
    throw new Error(`${label} must be ${IPC_CONNECTION_SLUG_MAX_LENGTH} characters or fewer`);
  }
  if (!IPC_CONNECTION_SLUG_PATTERN.test(value) || IPC_CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`${label} contains invalid characters`);
  }
  if (value.split('.').some((segment) => segment.length === 0)) {
    throw new Error(`${label} contains invalid path traversal segments`);
  }
  return value;
}

export function normalizeConnectionApiKeyForIpc(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  if (value.length > IPC_CONNECTION_SECRET_MAX_LENGTH) {
    throw new Error(`${label} must be ${IPC_CONNECTION_SECRET_MAX_LENGTH} characters or fewer`);
  }
  if (IPC_CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`${label} contains invalid characters`);
  }
  return value;
}

export function normalizeCreateConnectionInputForIpc(value: unknown): CreateConnectionInput {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid Connection input');
  const input = value as Partial<CreateConnectionInput>;
  if (
    typeof input.name !== 'string' ||
    input.name.length === 0 ||
    typeof input.providerType !== 'string' ||
    !(input.providerType in PROVIDER_DEFAULTS)
  ) {
    throw new Error('Invalid Connection input');
  }
  const apiKey = input.apiKey === undefined
    ? undefined
    : normalizeConnectionApiKeyForIpc(input.apiKey, 'apiKey');
  const slug = normalizeConnectionSlugForIpc(input.slug, 'connection slug');
  const relayModelProfiles =
    input.relayModelProfiles === undefined
      ? undefined
      : normalizeRelayModelProfiles(input.relayModelProfiles);
  const requestHeaders =
    input.requestHeaders === undefined ? undefined : normalizeRequestHeaders(input.requestHeaders);
  const requestBodyOverlay =
    input.requestBodyOverlay === undefined
      ? undefined
      : normalizeOptionalRequestBodyOverlay(input.requestBodyOverlay);
  const normalized = {
    ...input,
    slug,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(relayModelProfiles === undefined ? {} : { relayModelProfiles }),
    ...(requestHeaders === undefined ? {} : { requestHeaders }),
    ...(requestBodyOverlay === undefined ? {} : { requestBodyOverlay }),
  } as CreateConnectionInput;
  return normalizeConnectionBaseUrlForIpc(normalized);
}

export function normalizeConnectionPatchSecretsForIpc(value: unknown): UpdateConnectionInput {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid Connection update');
  const patch = value as UpdateConnectionInput;
  const normalized = {
    ...patch,
    ...(Object.prototype.hasOwnProperty.call(patch, 'apiKey') && patch.apiKey !== undefined
      ? { apiKey: normalizeConnectionApiKeyForIpc(patch.apiKey, 'apiKey') }
      : {}),
  };
  if (patch.requestBodyOverlay === undefined || patch.requestBodyOverlay === null) return normalized;
  return {
    ...normalized,
    requestBodyOverlay: normalizeOptionalRequestBodyOverlay(patch.requestBodyOverlay) ?? null,
  };
}

export function normalizeConnectionBaseUrlForIpc<T extends CreateConnectionInput>(input: T): T {
  if (PROVIDER_DEFAULTS[input.providerType].authKind === 'oauth_token') {
    return { ...input, baseUrl: PROVIDER_DEFAULTS[input.providerType].baseUrl };
  }
  if (input.baseUrl === undefined) return input;
  return {
    ...input,
    baseUrl: normalizeConnectionBaseUrlValueForIpc(input.providerType, input.baseUrl),
  };
}

export function normalizeConnectionBaseUrlValueForIpc(
  providerType: CreateConnectionInput['providerType'],
  value: string,
): string {
  const defaults = PROVIDER_DEFAULTS[providerType];
  if (defaults.authKind === 'oauth_token') return defaults.baseUrl;
  const result = normalizeConnectionBaseUrl(value);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

/** The probe's contract over the renderer boundary: a provider type, the
 * endpoint the catalog should be read from, an optional API key, and the
 * custom request headers the form carries. */
export interface ConnectionCatalogProbeInput {
  readonly providerType: ProviderType;
  readonly baseUrl: string;
  readonly apiKey: string | null;
  readonly requestHeaders?: readonly RequestHeaderUpdate[];
}

/**
 * Validate and canonicalize the catalog-probe IPC payload. The endpoint is
 * required — this probe exists to read a catalog from an endpoint the app
 * has not met yet, so there is nothing to probe without one. Reuses the
 * connection base URL normalization so a malformed endpoint rejects with the
 * same copy the connection form already shows.
 */
export function normalizeConnectionCatalogProbeInput(value: unknown): ConnectionCatalogProbeInput {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid connection catalog probe');
  }
  const raw = value as Record<string, unknown>;
  const providerType = raw.providerType;
  if (typeof providerType !== 'string' || !PROVIDER_DEFAULTS[providerType as ProviderType]) {
    throw new Error('Invalid provider type');
  }
  const typedProviderType = providerType as ProviderType;
  const apiKey = typeof raw.apiKey === 'string' && raw.apiKey.trim().length > 0
    ? raw.apiKey.trim()
    : null;
  const baseUrl = normalizeConnectionBaseUrlValueForIpc(
    typedProviderType,
    String(raw.baseUrl ?? ''),
  );
  if (baseUrl.length === 0) throw new Error('An endpoint is required to probe the model catalog');
  const requestHeaders =
    raw.requestHeaders === undefined
      ? undefined
      : normalizeRequestHeaderUpdates(raw.requestHeaders);
  return {
    providerType: typedProviderType,
    baseUrl,
    apiKey,
    ...(requestHeaders && requestHeaders.length > 0 ? { requestHeaders } : {}),
  };
}
