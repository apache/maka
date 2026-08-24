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
  decodeRemoteRuntimeHostProfile,
  RUNTIME_HOST_ACCESS_CREDENTIAL_MAX_BYTES,
  sameResolvedRuntimeHostProfileTarget,
  type RemoteRuntimeHostProfile,
  type ResolvedRuntimeHostProfile,
} from '@maka/runtime-host/client';
import type { CredentialStore } from '@maka/storage/credential-store';

const PAIRING_JOURNAL_SCHEMA_VERSION = 1;
const PAIRING_JOURNAL_CREDENTIAL_SLOT = 'runtime-host-pairing-recovery';
const PAIRING_JOURNAL_MAX_BYTES = 512 * 1024;
const PAIRING_JOURNAL_MAX_ENTRIES = 32;

export class DesktopRuntimeHostPairingJournalInvalidError extends Error {
  override readonly name = 'DesktopRuntimeHostPairingJournalInvalidError';
}

export interface DesktopRuntimeHostPairingIntent {
  readonly target: {
    readonly profile: RemoteRuntimeHostProfile;
    readonly credential: string;
  };
  readonly previous?: {
    readonly profile: RemoteRuntimeHostProfile;
    readonly credential: string;
  };
  readonly wasEnabled: boolean;
}

export function createDesktopRuntimeHostPairingIntent(input: {
  readonly target: ResolvedRuntimeHostProfile;
  readonly previous?: ResolvedRuntimeHostProfile;
  readonly wasEnabled: boolean;
}): DesktopRuntimeHostPairingIntent {
  return {
    target: requireRemoteTarget(input.target, 'pairing target'),
    ...(input.previous
      ? { previous: requireRemoteTarget(input.previous, 'previous pairing target') }
      : {}),
    wasEnabled: input.wasEnabled,
  };
}

export function pairingIntentMatchesTarget(
  intentTarget: DesktopRuntimeHostPairingIntent['target'],
  target: ResolvedRuntimeHostProfile,
): boolean {
  return sameResolvedRuntimeHostProfileTarget(intentTarget, target);
}

export async function readDesktopRuntimeHostPairingIntents(
  credentials: Pick<CredentialStore, 'getSecret'>,
): Promise<readonly DesktopRuntimeHostPairingIntent[]> {
  const contents = await credentials.getSecret(
    PAIRING_JOURNAL_CREDENTIAL_SLOT,
    'runtime_host_access',
  );
  if (contents === null) return [];
  if (Buffer.byteLength(contents, 'utf8') > PAIRING_JOURNAL_MAX_BYTES) {
    throw new DesktopRuntimeHostPairingJournalInvalidError(
      'Runtime Host pairing recovery journal exceeds its size limit',
    );
  }
  try {
    return decodePairingJournal(JSON.parse(contents));
  } catch (error) {
    throw new DesktopRuntimeHostPairingJournalInvalidError(
      'Runtime Host pairing recovery journal is invalid',
      { cause: error },
    );
  }
}

export async function writeDesktopRuntimeHostPairingIntents(
  credentials: Pick<CredentialStore, 'setSecret' | 'deleteSecret'>,
  intents: readonly DesktopRuntimeHostPairingIntent[],
): Promise<void> {
  if (intents.length > PAIRING_JOURNAL_MAX_ENTRIES) {
    throw new Error('Runtime Host pairing recovery journal has too many entries');
  }
  if (intents.length === 0) {
    await credentials.deleteSecret(
      PAIRING_JOURNAL_CREDENTIAL_SLOT,
      'runtime_host_access',
    );
    return;
  }
  const contents = JSON.stringify({
    schemaVersion: PAIRING_JOURNAL_SCHEMA_VERSION,
    intents,
  });
  if (Buffer.byteLength(contents) > PAIRING_JOURNAL_MAX_BYTES) {
    throw new Error('Runtime Host pairing recovery journal exceeds its size limit');
  }
  await credentials.setSecret(
    PAIRING_JOURNAL_CREDENTIAL_SLOT,
    'runtime_host_access',
    contents,
  );
}

function decodePairingJournal(value: unknown): readonly DesktopRuntimeHostPairingIntent[] {
  const journal = requireExactRecord(value, ['schemaVersion', 'intents']);
  if (
    journal.schemaVersion !== PAIRING_JOURNAL_SCHEMA_VERSION ||
    !Array.isArray(journal.intents) ||
    journal.intents.length > PAIRING_JOURNAL_MAX_ENTRIES
  ) {
    throw new Error('Unsupported Runtime Host pairing recovery journal');
  }
  const intents = journal.intents.map(decodePairingIntent);
  if (new Set(intents.map((intent) => intent.target.profile.id)).size !== intents.length) {
    throw new Error('Duplicate Runtime Host pairing recovery profile');
  }
  return intents;
}

function decodePairingIntent(value: unknown): DesktopRuntimeHostPairingIntent {
  const record = requireExactRecord(value, ['target', 'previous', 'wasEnabled'], [
    'previous',
  ]);
  if (typeof record.wasEnabled !== 'boolean') {
    throw new Error('Invalid Runtime Host pairing recovery enablement');
  }
  const target = decodePairingTarget(record.target);
  const previous = record.previous === undefined
    ? undefined
    : decodePairingTarget(record.previous);
  if (
    previous &&
    (previous.profile.id !== target.profile.id || previous.profile.rootId !== target.profile.rootId)
  ) {
    throw new Error('Runtime Host pairing recovery target changed Host identity');
  }
  return {
    target,
    ...(previous ? { previous } : {}),
    wasEnabled: record.wasEnabled,
  };
}

function decodePairingTarget(
  value: unknown,
): DesktopRuntimeHostPairingIntent['target'] {
  const record = requireExactRecord(value, ['profile', 'credential']);
  return {
    profile: decodeRemoteRuntimeHostProfile(record.profile),
    credential: requireCredential(record.credential),
  };
}

function requireRemoteTarget(
  target: ResolvedRuntimeHostProfile,
  label: string,
): DesktopRuntimeHostPairingIntent['target'] {
  if (target.profile.kind !== 'remote' || !target.credential) {
    throw new Error(`Runtime Host ${label} must be a resolved remote profile`);
  }
  return {
    profile: decodeRemoteRuntimeHostProfile(target.profile),
    credential: requireCredential(target.credential),
  };
}

function requireCredential(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    /\s/u.test(value) ||
    Buffer.byteLength(value, 'utf8') > RUNTIME_HOST_ACCESS_CREDENTIAL_MAX_BYTES
  ) {
    throw new Error('Runtime Host pairing recovery credential is invalid');
  }
  return value;
}

function requireExactRecord(
  value: unknown,
  allowedKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Runtime Host pairing recovery record is invalid');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error('Runtime Host pairing recovery record contains unknown fields');
  }
  const optional = new Set(optionalKeys);
  if (allowedKeys.some((key) => !optional.has(key) && !Object.hasOwn(record, key))) {
    throw new Error('Runtime Host pairing recovery record is incomplete');
  }
  return record;
}
