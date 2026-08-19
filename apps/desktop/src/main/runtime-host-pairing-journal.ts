import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  decodeRemoteRuntimeHostProfile,
  RUNTIME_HOST_ACCESS_CREDENTIAL_MAX_BYTES,
  sameResolvedRuntimeHostProfileTarget,
  type RemoteRuntimeHostProfile,
  type ResolvedRuntimeHostProfile,
} from '@maka/runtime-host/client';
import { createFileCredentialStore } from '@maka/storage';

const PAIRING_JOURNAL_SCHEMA_VERSION = 1;
const PAIRING_JOURNAL_CREDENTIAL_SLOT = 'runtime-host-pairing-recovery';
const PAIRING_JOURNAL_MAX_BYTES = 512 * 1024;
const PAIRING_JOURNAL_MAX_ENTRIES = 32;

export interface DesktopRuntimeHostPairingIntent {
  readonly id: string;
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
    id: randomUUID(),
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
  clientDataRoot: string,
): Promise<readonly DesktopRuntimeHostPairingIntent[]> {
  const contents = await pairingCredentialStore(clientDataRoot).getSecret(
    PAIRING_JOURNAL_CREDENTIAL_SLOT,
    'runtime_host_access',
  );
  if (contents === null) return [];
  if (Buffer.byteLength(contents, 'utf8') > PAIRING_JOURNAL_MAX_BYTES) {
    throw new Error('Runtime Host pairing recovery journal exceeds its size limit');
  }
  try {
    return decodePairingJournal(JSON.parse(contents));
  } catch (error) {
    throw new Error('Runtime Host pairing recovery journal is invalid', { cause: error });
  }
}

export async function writeDesktopRuntimeHostPairingIntents(
  clientDataRoot: string,
  intents: readonly DesktopRuntimeHostPairingIntent[],
): Promise<void> {
  const credentials = pairingCredentialStore(clientDataRoot);
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
  if (journal.schemaVersion !== PAIRING_JOURNAL_SCHEMA_VERSION || !Array.isArray(journal.intents)) {
    throw new Error('Unsupported Runtime Host pairing recovery journal');
  }
  if (journal.intents.length > PAIRING_JOURNAL_MAX_ENTRIES) {
    throw new Error('Runtime Host pairing recovery journal contains too many entries');
  }
  const intents = journal.intents.map(decodePairingIntent);
  if (new Set(intents.map((intent) => intent.target.profile.id)).size !== intents.length) {
    throw new Error('Duplicate Runtime Host pairing recovery profile');
  }
  return intents;
}

function decodePairingIntent(value: unknown): DesktopRuntimeHostPairingIntent {
  const record = requireExactRecord(value, ['id', 'target', 'previous', 'wasEnabled'], [
    'previous',
  ]);
  if (typeof record.id !== 'string' || !/^[0-9a-f-]{36}$/u.test(record.id)) {
    throw new Error('Invalid Runtime Host pairing recovery identity');
  }
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
    id: record.id,
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

function pairingCredentialStore(clientDataRoot: string) {
  return createFileCredentialStore(join(clientDataRoot, 'runtime-host-client'));
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
