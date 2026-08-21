import {
  PROVIDER_DEFAULTS,
  type ProviderType,
} from '@maka/core/llm-connections';
import type {
  ConnectionCatalogEntry,
  ConnectionCatalogSnapshot,
  CredentialLocator,
} from '@maka/core/runtime-policy';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';

export type RuntimeHostAccountConnectionClient = Pick<
  DesktopRuntimeHostClient,
  | 'createConnection'
  | 'deleteCredential'
  | 'fetchConnectionModels'
  | 'loadConnectionCatalog'
  | 'queryCredential'
  | 'setDefaultConnectionTarget'
  | 'updateConnection'
>;

export interface RuntimeHostAccountConnectionIdentity {
  readonly providerType: ProviderType;
  readonly slug: string;
}

export async function ensureRuntimeHostAccountConnection(
  client: RuntimeHostAccountConnectionClient,
  identity: RuntimeHostAccountConnectionIdentity,
  enabledModelIds?: readonly string[],
): Promise<ConnectionCatalogEntry> {
  let catalog = await client.loadConnectionCatalog();
  const existing = findRuntimeHostAccountConnection(catalog, identity.providerType);
  const desiredModels =
    enabledModelIds && enabledModelIds.length > 0
      ? enabledModelIds
      : existing?.enabledModelIds.length
        ? existing.enabledModelIds
        : PROVIDER_DEFAULTS[identity.providerType].fallbackModels;
  if (!existing) {
    const slugOwner = catalog.connections.find(({ slug }) => slug === identity.slug);
    if (slugOwner) {
      throw new Error(`Connection slug belongs to ${slugOwner.providerType}`);
    }
    const defaults = PROVIDER_DEFAULTS[identity.providerType];
    const created = await client.createConnection(catalog.revision, {
      slug: identity.slug,
      name: defaults.label,
      providerType: identity.providerType,
      ...(defaults.baseUrl ? { baseUrl: defaults.baseUrl } : {}),
      enabled: true,
      enabledModelIds: [...desiredModels],
    });
    if (created.kind !== 'committed') {
      throw new Error(`Unable to create account Connection: ${created.kind}`);
    }
    catalog = await client.loadConnectionCatalog();
    const connection = findRuntimeHostAccountConnection(catalog, identity.providerType);
    if (!connection) throw new Error('Account Connection was not committed');
    return connection;
  }
  if (
    existing.enabled &&
    sameStrings(existing.enabledModelIds, desiredModels)
  ) {
    return existing;
  }
  const updated = await client.updateConnection(
    { connectionId: existing.connectionId, revision: existing.revision },
    accountConnectionChanges(existing, true, desiredModels),
  );
  if (updated.kind !== 'committed') {
    throw new Error(`Unable to prepare account Connection: ${updated.kind}`);
  }
  const prepared = findRuntimeHostAccountConnection(
    await client.loadConnectionCatalog(),
    identity.providerType,
  );
  if (!prepared) throw new Error('Account Connection disappeared after preparation');
  return prepared;
}

export async function synchronizeRuntimeHostAccountConnection(
  client: RuntimeHostAccountConnectionClient,
  providerType: ProviderType,
): Promise<void> {
  const connection = findRuntimeHostAccountConnection(
    await client.loadConnectionCatalog(),
    providerType,
  );
  if (!connection) throw new Error('Account Connection is missing');
  // Discovery is best effort. Selecting a default must not depend on it: a
  // connection whose inventory came from the curated fallback still has usable
  // models, and leaving `defaultTarget` empty makes every later operation that
  // needs a default — new Session, send, external Session import — fail with a
  // reason the user cannot see from the error it produces.
  await client.fetchConnectionModels(connection.connectionId).catch(() => undefined);
  await adoptDiscoveredAccountModels(client, providerType);
  const catalog = await client.loadConnectionCatalog();
  if (catalog.defaultTarget !== null) return;
  const updated = findRuntimeHostAccountConnection(catalog, providerType);
  const modelId = updated?.enabledModelIds[0];
  if (!updated || !modelId) return;
  const selected = await client.setDefaultConnectionTarget(catalog.revision, {
    connectionId: updated.connectionId,
    modelId,
  });
  if (selected.kind !== 'committed') {
    throw new Error(`Unable to select account default: ${selected.kind}`);
  }
}

/**
 * An account Connection is created before anyone can ask the account what it
 * has: the OAuth login path has no credential yet at that point, so the
 * enabled ids start as the provider's curated fallback list. Once discovery
 * answers, the account's own catalog is the authority — an id it does not list
 * cannot be selected, tested, or sent to, and leaving it enabled only produces
 * failures naming a model the user never chose.
 *
 * A deliberate narrower selection survives: ids are dropped, never added, and
 * the discovered list is adopted whole only when nothing the user kept remains.
 */
async function adoptDiscoveredAccountModels(
  client: RuntimeHostAccountConnectionClient,
  providerType: ProviderType,
): Promise<void> {
  const connection = findRuntimeHostAccountConnection(
    await client.loadConnectionCatalog(),
    providerType,
  );
  // Only a fetched inventory is authoritative. A fallback one is the same guess
  // the enabled ids already are, so it can prove nothing about them.
  if (!connection || connection.modelSource !== 'fetched') return;
  const discovered = (connection.models ?? [])
    .map(({ id }) => id.trim())
    .filter((id) => id.length > 0);
  if (discovered.length === 0) return;
  const available = new Set(discovered);
  const retained = connection.enabledModelIds.filter((id) => available.has(id));
  const next = retained.length > 0 ? retained : discovered;
  if (sameStrings(connection.enabledModelIds, next)) return;
  const updated = await client.updateConnection(
    { connectionId: connection.connectionId, revision: connection.revision },
    accountConnectionChanges(connection, connection.enabled, next),
  );
  if (updated.kind !== 'committed') {
    throw new Error(`Unable to adopt discovered account models: ${updated.kind}`);
  }
}

export async function setRuntimeHostAccountCredential(
  client: RuntimeHostAccountConnectionClient &
    Pick<DesktopRuntimeHostClient, 'setCredential'>,
  connection: ConnectionCatalogEntry,
  secret: string,
): Promise<void> {
  const locator = runtimeHostAccountCredential(connection);
  const current = await client.queryCredential(locator);
  const result = await client.setCredential({
    locator,
    expected: current?.configured
      ? { credentialId: current.credentialId, revision: current.revision }
      : null,
    secret,
  });
  if (result.kind !== 'committed') {
    throw new Error(`Unable to save account credential: ${result.kind}`);
  }
}

export async function disableRuntimeHostAccountConnection(
  client: RuntimeHostAccountConnectionClient,
  providerType: ProviderType,
): Promise<void> {
  const connection = findRuntimeHostAccountConnection(
    await client.loadConnectionCatalog(),
    providerType,
  );
  if (!connection) return;
  const credential = await client.queryCredential(runtimeHostAccountCredential(connection));
  if (credential?.configured) {
    const removed = await client.deleteCredential({
      expected: {
        credentialId: credential.credentialId,
        locator: credential.locator,
        revision: credential.revision,
      },
    });
    if (removed.kind !== 'committed') {
      throw new Error(`Unable to remove account credential: ${removed.kind}`);
    }
  }
  const latest = findRuntimeHostAccountConnection(
    await client.loadConnectionCatalog(),
    providerType,
  );
  if (!latest?.enabled) return;
  const disabled = await client.updateConnection(
    { connectionId: latest.connectionId, revision: latest.revision },
    accountConnectionChanges(latest, false, latest.enabledModelIds),
  );
  if (disabled.kind !== 'committed') {
    throw new Error(`Unable to disable account Connection: ${disabled.kind}`);
  }
}

export function findRuntimeHostAccountConnection(
  catalog: ConnectionCatalogSnapshot,
  providerType: ProviderType,
): ConnectionCatalogEntry | undefined {
  return catalog.connections.find((connection) => connection.providerType === providerType);
}

export function runtimeHostAccountCredential(
  connection: ConnectionCatalogEntry,
): CredentialLocator {
  if (PROVIDER_DEFAULTS[connection.providerType].authKind !== 'oauth_token') {
    throw new Error('Account Connection does not use an OAuth credential');
  }
  return {
    scope: 'connection',
    connectionId: connection.connectionId,
    kind: 'oauth_token',
  };
}

function accountConnectionChanges(
  connection: ConnectionCatalogEntry,
  enabled: boolean,
  enabledModelIds: readonly string[],
) {
  return {
    name: connection.name,
    ...(connection.baseUrl === undefined ? {} : { baseUrl: connection.baseUrl }),
    enabled,
    enabledModelIds: [...enabledModelIds],
    // Account (OAuth) connections never declare relay capabilities, and the
    // omission is the point: with tri-state update semantics an absent key
    // leaves the stored table untouched, so this path can never clobber
    // declarations another writer made.
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
