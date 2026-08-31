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

import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  decodeProviderType,
  decodeCanonicalConnectionCatalogEntry,
  decodeCredentialVersionBasis,
  decodeConnectionSlug,
  decodeRuntimePolicyEntityId,
  normalizeCatalogConnectionBaseUrl,
  normalizeConnectionCatalogEntryUpdateForProvider,
  normalizeConnectionModelDiscoveryResult,
  normalizeCredentialSecret,
  type ConnectionModelDiscoveryResult,
  type ConnectionCatalogEntry,
  type CredentialVersionBasis,
} from '@maka/core/runtime-policy';
import {
  deriveConnectionSlug,
  PROVIDER_DEFAULTS,
  providerAuthSupportsApiKey,
  type ProviderType,
} from '@maka/core/llm-connections';
import { syncDirectory } from '../stable-storage.js';
import { record } from './codec.js';
import {
  codecError,
  commitOutcomeUnknown,
  decodeConnectionInput,
  decodeCredentialInput,
  decodePersistedDomain,
  ioFailed,
} from './errors.js';
import type { InteractiveOAuthLoginTarget, InteractiveOAuthLoginProvider } from './operations.js';
import { readBoundedJsonDocument, writeJsonDocument } from './document-io.js';
const FILE = 'runtime-policy-onboarding.json';
const SCHEMA_VERSION = 2 as const;
const OAUTH_SCHEMA_VERSION = 3 as const;
const MAX_BYTES = 5 * 1024 * 1024;

export interface ConnectionOnboardingTransactionInput {
  readonly connectionId: unknown;
  readonly slug: unknown;
  readonly providerType: unknown;
  readonly suppliedSecret: unknown;
  readonly baseUrl: unknown;
  readonly enabledModelIds: unknown;
  readonly discovery: unknown;
  readonly invalidateLastTest: unknown;
}

export interface ConnectionOnboardingIntent {
  readonly schemaVersion: 1 | typeof SCHEMA_VERSION;
  readonly connectionId: string;
  /** Absent only while replaying a schema-v1 identity-first intent. */
  readonly slug: string | null;
  readonly providerType: ProviderType;
  readonly suppliedSecret: string | null;
  readonly baseUrl: string | null;
  readonly enabledModelIds: readonly string[];
  readonly discovery: ConnectionModelDiscoveryResult;
  readonly invalidateLastTest: boolean;
}

export interface InteractiveOAuthEnrollmentIntent {
  readonly schemaVersion: typeof OAUTH_SCHEMA_VERSION;
  readonly kind: 'oauth_enrollment';
  readonly attemptId: string;
  readonly target: InteractiveOAuthLoginTarget;
  readonly connectionBefore: ConnectionCatalogEntry | null;
  readonly connectionAfter: ConnectionCatalogEntry & {
    readonly providerType: InteractiveOAuthLoginProvider;
  };
  readonly credentialBasis: CredentialVersionBasis | null;
  readonly secret: string;
}

export type RuntimePolicyOnboardingIntent =
  | ConnectionOnboardingIntent
  | InteractiveOAuthEnrollmentIntent;

export type CurrentConnectionOnboardingIntent = ConnectionOnboardingIntent & {
  readonly schemaVersion: 2;
  readonly slug: string;
};

export function prepareConnectionOnboardingIntent(
  input: ConnectionOnboardingTransactionInput,
  source: 'input' | 'persisted' = 'input',
): CurrentConnectionOnboardingIntent {
  const decode = source === 'persisted' ? decodePersistedDomain : decodeConnectionInput;
  const providerType = decode(() => decodeProviderType(input.providerType));
  if (!providerAuthSupportsApiKey(providerType)) {
    throw codecError(
      source === 'persisted' ? 'invalid_document' : 'invalid_connection_input',
      'Onboarding requires an API-key provider',
    );
  }
  const definition = PROVIDER_DEFAULTS[providerType];
  const discovery = decode(() => normalizeConnectionModelDiscoveryResult(input.discovery));
  // Non-empty is the requirement; `source` is write provenance, not a
  // quality bar. A provider without a model-list endpoint runs discovery by
  // replaying the array this build shipped, and that inventory onboards a
  // connection exactly as well (#1584).
  if (discovery.models.length === 0) {
    throw codecError(
      source === 'persisted' ? 'invalid_document' : 'invalid_connection_input',
      'Onboarding requires a non-empty model inventory',
    );
  }
  // Legacy intents predate the field (`undefined` when replayed) and mean
  // the same thing as an explicit null: no endpoint override.
  const baseUrl =
    input.baseUrl === null || input.baseUrl === undefined
      ? null
      : (decode(() => normalizeCatalogConnectionBaseUrl(input.baseUrl, providerType)) ?? null);
  const normalized = decode(() =>
    normalizeConnectionCatalogEntryUpdateForProvider(
      {
        name: definition.label,
        ...((baseUrl ?? definition.baseUrl) ? { baseUrl: baseUrl ?? definition.baseUrl } : {}),
        enabled: true,
        enabledModelIds: input.enabledModelIds,
      },
      providerType,
    ),
  );
  const available = new Set(discovery.models.map(({ id }) => id));
  if (
    normalized.enabledModelIds.length === 0 ||
    normalized.enabledModelIds.some((modelId) => !available.has(modelId))
  ) {
    throw codecError(
      source === 'persisted' ? 'invalid_document' : 'invalid_connection_input',
      'Onboarding enabled models must come from the fetched inventory',
    );
  }
  const suppliedSecret =
    input.suppliedSecret === null
      ? null
      : source === 'persisted'
        ? decodePersistedDomain(() => normalizeCredentialSecret(input.suppliedSecret))
        : decodeCredentialInput(() => normalizeCredentialSecret(input.suppliedSecret));
  if (typeof input.invalidateLastTest !== 'boolean') {
    throw codecError(
      source === 'persisted' ? 'invalid_document' : 'invalid_connection_input',
      'Onboarding last-test invalidation must be a boolean',
    );
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    connectionId: decode(() => decodeRuntimePolicyEntityId(input.connectionId)),
    slug: decode(() => decodeConnectionSlug(input.slug)),
    providerType,
    suppliedSecret,
    baseUrl,
    enabledModelIds: normalized.enabledModelIds,
    discovery,
    invalidateLastTest: input.invalidateLastTest,
  };
}

export async function readConnectionOnboardingIntent(
  root: string,
): Promise<RuntimePolicyOnboardingIntent | undefined> {
  const value = await readBoundedJsonDocument(root, FILE, MAX_BYTES);
  if (value === undefined) return undefined;
  const envelope = record(
    value,
    FILE,
    'invalid_document',
    [
      'schemaVersion',
      'kind',
      'attemptId',
      'target',
      'connectionBefore',
      'connectionAfter',
      'credentialBasis',
      'secret',
      'connectionId',
      'slug',
      'providerType',
      'suppliedSecret',
      'baseUrl',
      'enabledModelIds',
      'discovery',
      'invalidateLastTest',
    ],
    ['schemaVersion'],
  );
  if (envelope.schemaVersion === OAUTH_SCHEMA_VERSION) {
    return decodeInteractiveOAuthEnrollmentIntent(value);
  }
  // `baseUrl` is allowed but not required for the oldest v1 journal shape.
  const raw = record(
    value,
    FILE,
    'invalid_document',
    [
      'schemaVersion',
      'connectionId',
      'slug',
      'providerType',
      'suppliedSecret',
      'baseUrl',
      'enabledModelIds',
      'discovery',
      'invalidateLastTest',
    ],
    [
      'schemaVersion',
      'connectionId',
      'providerType',
      'suppliedSecret',
      'enabledModelIds',
      'discovery',
      'invalidateLastTest',
    ],
  );
  if (raw.schemaVersion !== 1 && raw.schemaVersion !== SCHEMA_VERSION) {
    throw codecError('invalid_document', `${FILE} has an unsupported schema version`);
  }
  const prepared = prepareConnectionOnboardingIntent(
    {
      providerType: raw.providerType,
      connectionId: raw.connectionId,
      slug:
        raw.schemaVersion === 1 ? deriveLegacyIntentPlaceholderSlug(raw.providerType) : raw.slug,
      suppliedSecret: raw.suppliedSecret,
      baseUrl: raw.baseUrl,
      enabledModelIds: raw.enabledModelIds,
      discovery: raw.discovery,
      invalidateLastTest: raw.invalidateLastTest,
    },
    'persisted',
  );
  return raw.schemaVersion === 1 ? { ...prepared, schemaVersion: 1, slug: null } : prepared;
}

export function writeConnectionOnboardingIntent(
  root: string,
  intent: CurrentConnectionOnboardingIntent | InteractiveOAuthEnrollmentIntent,
): Promise<void> {
  return writeJsonDocument(root, FILE, intent, MAX_BYTES);
}

export function prepareInteractiveOAuthEnrollmentIntent(input: {
  readonly attemptId: unknown;
  readonly target: InteractiveOAuthLoginTarget;
  readonly connectionBefore: ConnectionCatalogEntry | null;
  readonly connectionAfter: ConnectionCatalogEntry;
  readonly credentialBasis: CredentialVersionBasis | null;
  readonly secret: unknown;
}): InteractiveOAuthEnrollmentIntent {
  const connectionAfter = decodeConnectionInput(() =>
    decodeCanonicalConnectionCatalogEntry(input.connectionAfter),
  );
  if (!isOAuthProvider(connectionAfter.providerType)) {
    throw codecError('invalid_connection_input', 'OAuth enrollment requires an OAuth provider');
  }
  return {
    schemaVersion: OAUTH_SCHEMA_VERSION,
    kind: 'oauth_enrollment',
    attemptId: decodeOAuthAttemptId(input.attemptId, 'invalid_connection_input'),
    target: structuredClone(input.target),
    connectionBefore:
      input.connectionBefore === null
        ? null
        : decodeConnectionInput(() =>
            decodeCanonicalConnectionCatalogEntry(input.connectionBefore),
          ),
    connectionAfter: connectionAfter as InteractiveOAuthEnrollmentIntent['connectionAfter'],
    credentialBasis: input.credentialBasis ? structuredClone(input.credentialBasis) : null,
    secret: decodeCredentialInput(() => normalizeCredentialSecret(input.secret)),
  };
}

function decodeInteractiveOAuthEnrollmentIntent(value: unknown): InteractiveOAuthEnrollmentIntent {
  const raw = record(value, FILE, 'invalid_document', [
    'schemaVersion',
    'kind',
    'attemptId',
    'target',
    'connectionBefore',
    'connectionAfter',
    'credentialBasis',
    'secret',
  ]);
  if (raw.schemaVersion !== OAUTH_SCHEMA_VERSION || raw.kind !== 'oauth_enrollment') {
    throw codecError('invalid_document', `${FILE} has an invalid OAuth enrollment intent`);
  }
  const connectionAfter = decodePersistedDomain(() =>
    decodeCanonicalConnectionCatalogEntry(raw.connectionAfter),
  );
  if (!isOAuthProvider(connectionAfter.providerType)) {
    throw codecError('invalid_document', 'OAuth enrollment intent provider is invalid');
  }
  const connectionBefore =
    raw.connectionBefore === null
      ? null
      : decodePersistedDomain(() => decodeCanonicalConnectionCatalogEntry(raw.connectionBefore));
  const credentialBasis =
    raw.credentialBasis === null
      ? null
      : decodePersistedDomain(() => decodeCredentialVersionBasis(raw.credentialBasis));
  const target = decodeOAuthTarget(raw.target);
  if (
    (target.kind === 'create' && connectionBefore !== null) ||
    (target.kind === 'create' && target.providerType !== connectionAfter.providerType) ||
    (target.kind === 'existing' &&
      (connectionBefore === null || connectionBefore.connectionId !== target.connectionId)) ||
    connectionAfter.connectionId !==
      (target.kind === 'existing' ? target.connectionId : connectionAfter.connectionId) ||
    (connectionBefore !== null &&
      (connectionBefore.connectionId !== connectionAfter.connectionId ||
        connectionBefore.slug !== connectionAfter.slug ||
        connectionBefore.providerType !== connectionAfter.providerType))
  ) {
    throw codecError('invalid_document', 'OAuth enrollment intent identity is inconsistent');
  }
  return {
    schemaVersion: OAUTH_SCHEMA_VERSION,
    kind: 'oauth_enrollment',
    attemptId: decodeOAuthAttemptId(raw.attemptId, 'invalid_document'),
    target,
    connectionBefore,
    connectionAfter: connectionAfter as InteractiveOAuthEnrollmentIntent['connectionAfter'],
    credentialBasis,
    secret: decodePersistedDomain(() => normalizeCredentialSecret(raw.secret)),
  };
}

function decodeOAuthTarget(value: unknown): InteractiveOAuthLoginTarget {
  const base = record(
    value,
    'OAuth enrollment target',
    'invalid_document',
    ['kind', 'providerType', 'connectionId'],
    ['kind'],
  );
  if (base.kind === 'create') {
    const item = record(value, 'OAuth create target', 'invalid_document', ['kind', 'providerType']);
    const providerType = decodePersistedDomain(() => decodeProviderType(item.providerType));
    if (!isOAuthProvider(providerType)) {
      throw codecError('invalid_document', 'OAuth create target provider is invalid');
    }
    return { kind: 'create', providerType };
  }
  if (base.kind === 'existing') {
    const item = record(value, 'OAuth existing target', 'invalid_document', [
      'kind',
      'connectionId',
    ]);
    return {
      kind: 'existing',
      connectionId: decodePersistedDomain(() => decodeRuntimePolicyEntityId(item.connectionId)),
    };
  }
  throw codecError('invalid_document', 'OAuth enrollment target kind is invalid');
}

function isOAuthProvider(
  providerType: ProviderType,
): providerType is InteractiveOAuthLoginProvider {
  return providerType === 'openai-codex' || providerType === 'xai-oauth';
}

function decodeOAuthAttemptId(
  value: unknown,
  source: 'invalid_connection_input' | 'invalid_document',
): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw codecError(source, 'OAuth attempt id is invalid');
  }
  return value;
}

function deriveLegacyIntentPlaceholderSlug(rawProviderType: unknown): string {
  const providerType = decodePersistedDomain(() => decodeProviderType(rawProviderType));
  return deriveConnectionSlug(providerType);
}

export async function clearConnectionOnboardingIntent(root: string): Promise<void> {
  try {
    await unlink(join(root, FILE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw ioFailed(`${FILE} could not be removed`, error);
  }
  try {
    await syncDirectory(root);
  } catch (error) {
    throw commitOutcomeUnknown(`${FILE} removal outcome is unknown`, error);
  }
}
