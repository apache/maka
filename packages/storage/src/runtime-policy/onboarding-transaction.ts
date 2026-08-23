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
  decodeRuntimePolicyEntityId,
  normalizeConnectionCatalogEntryUpdateForProvider,
  normalizeConnectionModelDiscoveryResult,
  normalizeCredentialSecret,
  type ConnectionModelDiscoveryResult,
} from '@maka/core/runtime-policy';
import {
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
import { readBoundedJsonDocument, writeJsonDocument } from './document-io.js';
const FILE = 'runtime-policy-onboarding.json';
const SCHEMA_VERSION = 1 as const;
const MAX_BYTES = 5 * 1024 * 1024;

export interface ConnectionOnboardingTransactionInput {
  readonly connectionId: unknown;
  readonly providerType: unknown;
  readonly suppliedSecret: unknown;
  readonly enabledModelIds: unknown;
  readonly discovery: unknown;
  readonly invalidateLastTest: unknown;
}

export interface ConnectionOnboardingIntent {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly connectionId: string;
  readonly providerType: ProviderType;
  readonly suppliedSecret: string | null;
  readonly enabledModelIds: readonly string[];
  readonly discovery: ConnectionModelDiscoveryResult;
  readonly invalidateLastTest: boolean;
}

export function prepareConnectionOnboardingIntent(
  input: ConnectionOnboardingTransactionInput,
  source: 'input' | 'persisted' = 'input',
): ConnectionOnboardingIntent {
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
  const normalized = decode(() =>
    normalizeConnectionCatalogEntryUpdateForProvider(
      {
        name: definition.label,
        ...(definition.baseUrl ? { baseUrl: definition.baseUrl } : {}),
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
    providerType,
    suppliedSecret,
    enabledModelIds: normalized.enabledModelIds,
    discovery,
    invalidateLastTest: input.invalidateLastTest,
  };
}

export async function readConnectionOnboardingIntent(
  root: string,
): Promise<ConnectionOnboardingIntent | undefined> {
  const value = await readBoundedJsonDocument(root, FILE, MAX_BYTES);
  if (value === undefined) return undefined;
  const raw = record(value, FILE, 'invalid_document', [
    'schemaVersion',
    'connectionId',
    'providerType',
    'suppliedSecret',
    'enabledModelIds',
    'discovery',
    'invalidateLastTest',
  ]);
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    throw codecError('invalid_document', `${FILE} has an unsupported schema version`);
  }
  return prepareConnectionOnboardingIntent(
    {
      providerType: raw.providerType,
      connectionId: raw.connectionId,
      suppliedSecret: raw.suppliedSecret,
      enabledModelIds: raw.enabledModelIds,
      discovery: raw.discovery,
      invalidateLastTest: raw.invalidateLastTest,
    },
    'persisted',
  );
}

export function writeConnectionOnboardingIntent(
  root: string,
  intent: ConnectionOnboardingIntent,
): Promise<void> {
  return writeJsonDocument(root, FILE, intent, MAX_BYTES);
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
