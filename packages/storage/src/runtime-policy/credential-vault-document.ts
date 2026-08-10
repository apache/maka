import { randomUUID } from 'node:crypto';
import {
  decodeCredentialVersionBasis,
  normalizeCredentialSecret,
  normalizeDeleteCredentialInput,
  normalizeSetCredentialInput,
  type CredentialLocator,
  type CredentialMutationResult,
  type CredentialStatus,
  type CredentialVaultSnapshot,
  type CredentialVersionBasis,
  type DeleteCredentialInput,
  type SetCredentialInput,
} from '@maka/core/runtime-policy';
import { deepFreeze, integer, nextRevision, record, revision, unique } from './codec.js';
import {
  codecError,
  decodeCredentialInput,
  decodePersistedDomain,
  RuntimePolicyStoreError,
} from './errors.js';
import {
  readBoundedJsonDocument,
  serializeJsonDocument,
  VAULT_DOCUMENT_MAX_BYTES,
  writeJsonDocument,
} from './document-io.js';
import type { RuntimePolicyCredentialMaterial } from './operations.js';

const FILE = 'credential-vault.json';
export const CREDENTIAL_VAULT_SCHEMA_VERSION_V1 = 1 as const;
export const CREDENTIAL_VAULT_SCHEMA_VERSION_V2 = 2 as const;
export type CredentialVaultSchemaVersion =
  | typeof CREDENTIAL_VAULT_SCHEMA_VERSION_V1
  | typeof CREDENTIAL_VAULT_SCHEMA_VERSION_V2;
const MAX_SECRET_LENGTH = 64 * 1024;
const MAX_VAULT_ENTRIES = 2_048;

export interface CredentialVaultEntry extends CredentialVersionBasis {
  readonly secret: string;
  readonly updatedAt: number;
}

/**
 * Lazy-migrated vault document. v1 locators are preserved byte-for-byte; the
 * document is only persisted as v2 once the first secondary
 * (`connection_profile`) locator mutation touches it, so legacy-only
 * installations never pay the migration cost.
 */
export interface CredentialVaultDocument {
  readonly schemaVersion: CredentialVaultSchemaVersion;
  readonly revision: number;
  readonly entries: readonly CredentialVaultEntry[];
}

interface PreparedCredentialSet {
  readonly kind: 'ready';
  readonly document: CredentialVaultDocument;
  readonly entry: CredentialVaultEntry;
}

interface PreparedCredentialDelete {
  readonly kind: 'ready';
  readonly document: CredentialVaultDocument;
}

export class CredentialVaultDocumentOwner {
  async read(root: string): Promise<CredentialVaultDocument> {
    const value = await readBoundedJsonDocument(root, FILE, VAULT_DOCUMENT_MAX_BYTES);
    if (value === undefined) {
      return {
        schemaVersion: CREDENTIAL_VAULT_SCHEMA_VERSION_V1,
        revision: 0,
        entries: [],
      };
    }
    const raw = record(value, FILE, 'invalid_document', ['schemaVersion', 'revision', 'entries']);
    if (
      raw.schemaVersion !== CREDENTIAL_VAULT_SCHEMA_VERSION_V1 &&
      raw.schemaVersion !== CREDENTIAL_VAULT_SCHEMA_VERSION_V2
    ) {
      throw codecError('invalid_document', `${FILE} has an unsupported schema version`);
    }
    if (!Array.isArray(raw.entries) || raw.entries.length > MAX_VAULT_ENTRIES) {
      throw codecError('invalid_document', `${FILE}.entries must be a bounded array`);
    }
    const entries = raw.entries.map((item, index) => parseEntry(item, `${FILE}.entries[${index}]`));
    unique(
      entries.map((entry) => locatorKey(entry.locator)),
      `${FILE} locators`,
      'invalid_document',
    );
    unique(
      entries.map((entry) => entry.credentialId),
      `${FILE} credential ids`,
      'invalid_document',
    );
    return {
      schemaVersion: raw.schemaVersion,
      revision: revision(raw.revision, `${FILE}.revision`, 'invalid_document'),
      entries,
    };
  }

  async set(root: string, rawInput: SetCredentialInput): Promise<CredentialMutationResult> {
    const prepared = this.prepareSet(await this.read(root), rawInput);
    if (prepared.kind !== 'ready') return prepared;
    await this.commitSet(root, prepared);
    return committed(prepared.document);
  }

  prepareSet(
    current: CredentialVaultDocument,
    rawInput: SetCredentialInput,
  ): PreparedCredentialSet | CredentialMutationResult {
    const input = decodeCredentialInput(() => normalizeSetCredentialInput(rawInput));
    assertCredentialInputSecretLimit(input.secret, 'set credential secret');
    const index = findCredentialIndex(current, input.locator);
    const previous = index < 0 ? undefined : current.entries[index];
    if (!matchesExpectation(previous, input.expected)) {
      return credentialStale(
        input.expected ? { locator: input.locator, ...input.expected } : null,
        previous ? credentialBasis(previous) : null,
      );
    }
    if (index < 0 && current.entries.length >= MAX_VAULT_ENTRIES) {
      throw codecError('invalid_credential_input', 'Credential vault entry limit has been reached');
    }
    const entry: CredentialVaultEntry = previous
      ? {
          ...previous,
          revision: nextRevision(previous.revision),
          secret: input.secret,
          updatedAt: Date.now(),
        }
      : {
          locator: input.locator,
          credentialId: randomUUID(),
          revision: 1,
          secret: input.secret,
          updatedAt: Date.now(),
        };
    const entries = [...current.entries];
    if (index < 0) entries.push(entry);
    else entries[index] = entry;
    const next = {
      schemaVersion: documentSchemaVersionForLocator(current, input.locator),
      revision: nextRevision(current.revision),
      entries,
    };
    this.assertDocumentSize(next);
    return { kind: 'ready', document: next, entry };
  }

  async commitSet(root: string, prepared: PreparedCredentialSet): Promise<void> {
    await this.write(root, prepared.document);
  }

  async delete(root: string, rawInput: DeleteCredentialInput): Promise<CredentialMutationResult> {
    const prepared = this.prepareDelete(await this.read(root), rawInput);
    if (prepared.kind !== 'ready') return prepared;
    return this.commitDelete(root, prepared);
  }

  prepareDelete(
    current: CredentialVaultDocument,
    rawInput: DeleteCredentialInput,
  ): PreparedCredentialDelete | CredentialMutationResult {
    const input = decodeCredentialInput(() => normalizeDeleteCredentialInput(rawInput));
    const index = findCredentialIndex(current, input.expected.locator);
    const previous = index < 0 ? undefined : current.entries[index];
    if (!sameCredentialBasis(previous, input.expected)) {
      return credentialStale(input.expected, previous ? credentialBasis(previous) : null);
    }
    const next = {
      schemaVersion: documentSchemaVersionForLocator(current, input.expected.locator),
      revision: nextRevision(current.revision),
      entries: current.entries.filter((_entry, candidate) => candidate !== index),
    };
    this.assertDocumentSize(next);
    return { kind: 'ready', document: next };
  }

  async commitDelete(
    root: string,
    prepared: PreparedCredentialDelete,
  ): Promise<CredentialMutationResult> {
    await this.write(root, prepared.document);
    return committed(prepared.document);
  }

  async deleteConnectionCredentials(
    root: string,
    current: CredentialVaultDocument,
    connectionId: string,
  ): Promise<CredentialVaultSnapshot> {
    const entries = current.entries.filter(
      (entry) => !connectionLocatorForConnection(entry.locator, connectionId),
    );
    return this.replaceEntries(root, current, entries);
  }

  async deleteOrphanedConnectionCredentials(
    root: string,
    current: CredentialVaultDocument,
    liveConnectionIds: ReadonlySet<string>,
  ): Promise<CredentialVaultSnapshot> {
    const entries = current.entries.filter(
      (entry) =>
        !isConnectionFamilyLocator(entry.locator) ||
        liveConnectionIds.has(entry.locator.connectionId),
    );
    return this.replaceEntries(root, current, entries);
  }

  private async replaceEntries(
    root: string,
    current: CredentialVaultDocument,
    entries: CredentialVaultDocument['entries'],
  ): Promise<CredentialVaultSnapshot> {
    if (entries.length === current.entries.length) return vaultSnapshot(current);
    const next = {
      schemaVersion: current.schemaVersion,
      revision: nextRevision(current.revision),
      entries,
    };
    await this.write(root, next);
    return vaultSnapshot(next);
  }

  private async write(root: string, document: CredentialVaultDocument): Promise<void> {
    this.assertDocumentSize(document);
    await writeJsonDocument(root, FILE, document, VAULT_DOCUMENT_MAX_BYTES);
  }

  private assertDocumentSize(document: CredentialVaultDocument): void {
    if (serializeJsonDocument(document).length > VAULT_DOCUMENT_MAX_BYTES) {
      throw new RuntimePolicyStoreError(
        'invalid_credential_input',
        `credential vault exceeds its ${VAULT_DOCUMENT_MAX_BYTES} byte limit`,
      );
    }
  }
}

export function vaultSnapshot(document: CredentialVaultDocument): CredentialVaultSnapshot {
  return deepFreeze({
    revision: document.revision,
    entries: document.entries.map((entry) => credentialStatusFromEntry(entry)),
  });
}

export function credentialStatus(
  document: CredentialVaultDocument,
  locator: CredentialLocator,
): CredentialStatus {
  const entry = findCredential(document, locator);
  return deepFreeze(
    entry
      ? credentialStatusFromEntry(entry)
      : {
          locator: structuredClone(locator),
          configured: false,
          credentialId: null,
          revision: null,
          updatedAt: null,
        },
  );
}

export function credentialMaterial(entry: CredentialVaultEntry): RuntimePolicyCredentialMaterial {
  return deepFreeze({ ...credentialBasis(entry), secret: entry.secret });
}

export function credentialBasis(entry: CredentialVaultEntry): CredentialVersionBasis {
  return {
    locator: structuredClone(entry.locator),
    credentialId: entry.credentialId,
    revision: entry.revision,
  };
}

export function findCredential(
  document: CredentialVaultDocument,
  locator: CredentialLocator,
): CredentialVaultEntry | undefined {
  return document.entries.find((entry) => sameLocator(entry.locator, locator));
}

export function sameCredentialBasis(
  actual: CredentialVaultEntry | undefined,
  expected: CredentialVersionBasis,
): boolean {
  return (
    actual !== undefined &&
    sameLocator(actual.locator, expected.locator) &&
    actual.credentialId === expected.credentialId &&
    actual.revision === expected.revision
  );
}

function parseEntry(value: unknown, context: string): CredentialVaultEntry {
  const item = record(value, context, 'invalid_document', [
    'locator',
    'credentialId',
    'revision',
    'secret',
    'updatedAt',
  ]);
  const basis = decodePersistedDomain(() =>
    decodeCredentialVersionBasis({
      locator: item.locator,
      credentialId: item.credentialId,
      revision: item.revision,
    }),
  );
  const secret = decodePersistedDomain(() => normalizeCredentialSecret(item.secret));
  assertPersistedSecretLimit(secret, `${context}.secret`);
  return {
    ...basis,
    secret,
    updatedAt: integer(
      item.updatedAt,
      `${context}.updatedAt`,
      0,
      Number.MAX_SAFE_INTEGER,
      'invalid_document',
    ),
  };
}

function assertCredentialInputSecretLimit(value: string, context: string): void {
  if (value.length > MAX_SECRET_LENGTH) {
    throw codecError(
      'invalid_credential_input',
      `${context} must be no longer than ${MAX_SECRET_LENGTH} characters`,
    );
  }
}

function assertPersistedSecretLimit(value: string, context: string): void {
  if (value.length > MAX_SECRET_LENGTH) {
    throw codecError(
      'invalid_document',
      `${context} must be no longer than ${MAX_SECRET_LENGTH} characters`,
    );
  }
}

function credentialStatusFromEntry(entry: CredentialVaultEntry): CredentialStatus {
  return {
    locator: structuredClone(entry.locator),
    configured: true,
    credentialId: entry.credentialId,
    revision: entry.revision,
    updatedAt: entry.updatedAt,
  };
}

function findCredentialIndex(
  document: CredentialVaultDocument,
  locator: CredentialLocator,
): number {
  return document.entries.findIndex((entry) => sameLocator(entry.locator, locator));
}

function sameLocator(left: CredentialLocator, right: CredentialLocator): boolean {
  if (left.scope !== right.scope || left.kind !== right.kind) return false;
  if (left.scope === 'connection' && right.scope === 'connection') {
    return left.connectionId === right.connectionId;
  }
  if (left.scope === 'connection_profile' && right.scope === 'connection_profile') {
    return left.connectionId === right.connectionId && left.profileId === right.profileId;
  }
  if (left.scope === 'web_search' && right.scope === 'web_search') {
    return left.provider === right.provider;
  }
  return left.scope === 'network_proxy' && right.scope === 'network_proxy';
}

function locatorKey(locator: CredentialLocator): string {
  switch (locator.scope) {
    case 'connection':
      return `connection:${locator.connectionId}:${locator.kind}`;
    case 'connection_profile':
      return `connection_profile:${locator.connectionId}:${locator.profileId}:${locator.kind}`;
    case 'web_search':
      return `web_search:${locator.provider}:api_key`;
    case 'network_proxy':
      return 'network_proxy:password';
  }
}

function connectionLocatorForConnection(locator: CredentialLocator, connectionId: string): boolean {
  return (
    (locator.scope === 'connection' || locator.scope === 'connection_profile') &&
    locator.connectionId === connectionId
  );
}

function isConnectionFamilyLocator(
  locator: CredentialLocator,
): locator is Extract<CredentialLocator, { scope: 'connection' | 'connection_profile' }> {
  return locator.scope === 'connection' || locator.scope === 'connection_profile';
}

/**
 * A `connection_profile` (secondary Profile) locator mutation forces the v2
 * schema; pure legacy primary/request-header/web-search/network-proxy
 * mutations preserve the current version for lazy migration.
 */
function documentSchemaVersionForLocator(
  current: CredentialVaultDocument,
  locator: CredentialLocator,
): CredentialVaultSchemaVersion {
  if (locator.scope === 'connection_profile') return CREDENTIAL_VAULT_SCHEMA_VERSION_V2;
  return current.schemaVersion;
}

function matchesExpectation(
  actual: CredentialVaultEntry | undefined,
  expected: SetCredentialInput['expected'],
): boolean {
  if (expected === null) return actual === undefined;
  return (
    actual !== undefined &&
    actual.credentialId === expected.credentialId &&
    actual.revision === expected.revision
  );
}

function credentialStale(
  expected: CredentialVersionBasis | null,
  actual: CredentialVersionBasis | null,
): CredentialMutationResult {
  return deepFreeze({ kind: 'credential_stale', expected, actual });
}

function committed(document: CredentialVaultDocument): CredentialMutationResult {
  return deepFreeze({ kind: 'committed', snapshot: vaultSnapshot(document) });
}
