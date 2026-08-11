import type {
  ConnectionCatalogEntry,
  ConnectionCatalogSnapshot,
  ConnectionVersionBasis,
  CredentialLocator,
  CredentialProfileMutationResult,
  CredentialStatus,
  MutateRuntimePolicyResult,
  RuntimePolicySnapshot,
} from '@maka/core/runtime-policy';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import {
  authenticateRuntimePolicyStoresWriter,
  RuntimePolicyStoreError,
  type RuntimePolicyStoresWriter,
} from '@maka/storage/runtime-policy-stores';
import {
  CONNECTION_CATALOG_PAGE_MAX_BYTES,
  CONNECTION_CATALOG_PAGE_MAX_ITEMS,
  type ConnectionCatalogCreateInput,
  type ConnectionCatalogCursor,
  type ConnectionCatalogPageItem,
  type ConnectionCatalogQueryInput,
  type ConnectionCatalogQueryResult,
  type ConnectionCatalogRemoveInput,
  type ConnectionCatalogSetDefaultTargetInput,
  type ConnectionCatalogUpdateInput,
  type ConnectionRequestHeadersQueryInput,
  type ConnectionRequestHeadersReplaceInput,
  type CredentialVaultDeleteInput,
  type CredentialVaultQueryInput,
  type CredentialVaultSetInput,
  type CredentialProfileCreateInput,
  type CredentialProfileQueryInput,
  type CredentialProfileRemoveInput,
  type CredentialProfileSetEnabledInput,
  type CredentialProfileSetRoutingModeInput,
  type CredentialProfileUpdateInput,
  type CreateCredentialProfileResult,
  type OperationOutcome,
  type RemoveCredentialProfileResult,
  type RuntimePolicyMutateInput,
  type SetCredentialProfileEnabledResult,
  type SetCredentialRoutingModeResult,
  type UpdateCredentialProfileResult,
} from '../protocol/index.js';
import type { RuntimePolicyOperationHandlerMap } from './operation-dispatcher.js';
import { buildHostAgentSettingsTools } from './agent-settings-tools.js';
import { RuntimePolicyActivationGate } from './runtime-policy-activation-gate.js';

type StoreQueryOutcome<T> =
  | { readonly ok: true; readonly result: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: 'persistence_failed';
        readonly message: string;
      };
    };

type StoreCredentialQueryOutcome<T> =
  | StoreQueryOutcome<T>
  | {
      readonly ok: false;
      readonly error: {
        readonly code: 'invalid_request';
        readonly message: string;
      };
    };

type StoreMutationOutcome<T> =
  | StoreQueryOutcome<T>
  | {
      readonly ok: false;
      readonly error: {
        readonly code: 'commit_outcome_unknown' | 'invalid_request';
        readonly message: string;
      };
    };

/** Runtime Host control-plane projection over the authentic interactive policy stores. */
export class HostRuntimePolicyCoordinator {
  readonly modelTools: readonly MakaTool[];
  readonly handlers: RuntimePolicyOperationHandlerMap = {
    'runtime.policy.query': () => this.#queryPolicy(),
    'runtime.policy.mutate': (input) => this.#mutatePolicy(input),
    'connection.catalog.query': (input) => this.#queryCatalog(input),
    'connection.catalog.create': (input) => this.#createConnection(input),
    'connection.catalog.update': (input) => this.#updateConnection(input),
    'connection.catalog.remove': (input) => this.#removeConnection(input),
    'connection.catalog.set-default-target': (input) => this.#setDefaultTarget(input),
    'credential.vault.query': (input) => this.#queryCredential(input),
    'credential.vault.set': (input) => this.#setCredential(input),
    'credential.vault.delete': (input) => this.#deleteCredential(input),
    'credential.profile.create': (input) => this.#createCredentialProfile(input),
    'credential.profile.update': (input) => this.#updateCredentialProfile(input),
    'credential.profile.set-enabled': (input) => this.#setCredentialProfileEnabled(input),
    'credential.profile.remove': (input) => this.#removeCredentialProfile(input),
    'credential.profile.set-routing-mode': (input) => this.#setCredentialRoutingMode(input),
    'credential.profile.query': (input) => this.#queryCredentialProfileReadiness(input),
    'connection.request-headers.query': (input) => this.#queryConnectionRequestHeaders(input),
    'connection.request-headers.replace': (input) => this.#replaceConnectionRequestHeaders(input),
  };

  readonly #stores: RuntimePolicyStoresWriter;

  constructor(
    stores: RuntimePolicyStoresWriter,
    private readonly activation: RuntimePolicyActivationGate,
    private readonly onCommittedMutation: () => Promise<void> = async () => {},
  ) {
    this.#stores = authenticateRuntimePolicyStoresWriter(stores);
    this.modelTools = buildHostAgentSettingsTools({
      read: async () => requirePolicyQuery(await this.#queryPolicy()),
      mutate: async (input) => requirePolicyMutation(await this.#mutatePolicy(input)),
    });
  }

  async #queryPolicy(): Promise<OperationOutcome<'runtime.policy.query'>> {
    return this.#storeQuery(() => this.#stores.runtimePolicy.getSnapshot());
  }

  async #mutatePolicy(
    input: RuntimePolicyMutateInput,
  ): Promise<OperationOutcome<'runtime.policy.mutate'>> {
    return this.#storeMutation(async () =>
      projectPolicyMutation(await this.#stores.runtimePolicy.mutate(input)),
    );
  }

  async #queryCatalog(
    input: ConnectionCatalogQueryInput,
  ): Promise<OperationOutcome<'connection.catalog.query'>> {
    const stored = await this.#storeQuery(() => this.#stores.connectionCatalog.getSnapshot());
    if (!stored.ok) return stored;
    const snapshot = stored.result;
    if (input.kind === 'continue' && snapshot.revision !== input.revision) {
      return {
        ok: true,
        result: {
          kind: 'revision_changed' as const,
          expectedRevision: input.revision,
          actualRevision: snapshot.revision,
        },
      };
    }

    const items = projectCatalogItems(snapshot);
    const offset = input.kind === 'start' ? 0 : cursorOffset(input.cursor, items);
    if (offset === null) return invalidCatalogRequest();
    return { ok: true, result: catalogPage(snapshot, items, offset) };
  }

  async #createConnection(
    input: ConnectionCatalogCreateInput,
  ): Promise<OperationOutcome<'connection.catalog.create'>> {
    return this.#storeMutation(async () => {
      const result = await this.#stores.connectionCatalog.create(input);
      if (result.kind === 'revision_conflict' || result.kind === 'connection_exists') return result;
      if (result.kind !== 'committed') {
        throw invariantFailure(`Connection create returned ${result.kind}`);
      }
      const created = result.snapshot.connections.find(
        (connection) => connection.slug === input.connection.slug,
      );
      if (!created) throw invariantFailure('Committed connection creation omitted its basis');
      return committedConnection(result.snapshot, created);
    });
  }

  async #updateConnection(
    input: ConnectionCatalogUpdateInput,
  ): Promise<OperationOutcome<'connection.catalog.update'>> {
    return this.#storeMutation(async () => {
      const result = await this.#stores.connectionCatalog.update(input);
      if (result.kind === 'connection_stale' || result.kind === 'invalid_default_target') {
        return result;
      }
      if (result.kind !== 'committed') {
        throw invariantFailure(`Connection update returned ${result.kind}`);
      }
      const updated = result.snapshot.connections.find(
        (connection) => connection.connectionId === input.expected.connectionId,
      );
      if (!updated) throw invariantFailure('Committed connection update omitted its basis');
      return committedConnection(result.snapshot, updated);
    });
  }

  async #removeConnection(
    input: ConnectionCatalogRemoveInput,
  ): Promise<OperationOutcome<'connection.catalog.remove'>> {
    return this.#storeMutation(async () => {
      const result = await this.#stores.connectionCatalog.remove(input);
      if (result.kind === 'connection_stale') return result;
      if (result.kind !== 'committed') {
        throw invariantFailure(`Connection remove returned ${result.kind}`);
      }
      return committedCatalogRevision(result.snapshot);
    });
  }

  async #setDefaultTarget(
    input: ConnectionCatalogSetDefaultTargetInput,
  ): Promise<OperationOutcome<'connection.catalog.set-default-target'>> {
    return this.#storeMutation(async () => {
      const result = await this.#stores.connectionCatalog.setDefaultTarget(input);
      if (result.kind === 'revision_conflict' || result.kind === 'invalid_default_target') {
        return result;
      }
      if (result.kind !== 'committed') {
        throw invariantFailure(`Set default target returned ${result.kind}`);
      }
      return committedCatalogRevision(result.snapshot);
    });
  }

  async #queryCredential(
    input: CredentialVaultQueryInput,
  ): Promise<OperationOutcome<'credential.vault.query'>> {
    return this.#storeCredentialQuery(() => this.#stores.credentialVault.getStatus(input.locator));
  }

  async #setCredential(
    input: CredentialVaultSetInput,
  ): Promise<OperationOutcome<'credential.vault.set'>> {
    return this.#storeMutation(async () => {
      const result = await this.#stores.credentialVault.set(input);
      if (result.kind === 'connection_not_found' || result.kind === 'credential_stale') {
        return result;
      }
      const status = result.snapshot.entries.find((entry) =>
        sameLocator(entry.locator, input.locator),
      );
      if (!status?.configured) {
        throw invariantFailure('Committed credential set omitted its configured status');
      }
      return { kind: 'committed' as const, vaultRevision: result.snapshot.revision, status };
    });
  }

  async #deleteCredential(
    input: CredentialVaultDeleteInput,
  ): Promise<OperationOutcome<'credential.vault.delete'>> {
    return this.#storeMutation(async () => {
      const result = await this.#stores.credentialVault.delete(input);
      if (result.kind === 'connection_not_found' || result.kind === 'credential_stale') {
        return result;
      }
      return {
        kind: 'committed' as const,
        vaultRevision: result.snapshot.revision,
        status: unconfiguredStatus(input.expected.locator),
      };
    });
  }

  async #createCredentialProfile(
    input: CredentialProfileCreateInput,
  ): Promise<OperationOutcome<'credential.profile.create'>> {
    return this.#storeMutation(async () => {
      const result = await this.#stores.operations.createCredentialProfile(input);
      return projectCredentialProfileMutation(
        result,
        input.expected.connectionId,
        'credential profile create',
      ) as CreateCredentialProfileResult;
    });
  }

  async #updateCredentialProfile(
    input: CredentialProfileUpdateInput,
  ): Promise<OperationOutcome<'credential.profile.update'>> {
    return this.#storeMutation(async () => {
      const result = await this.#stores.operations.updateCredentialProfile(input);
      return projectCredentialProfileMutation(
        result,
        input.expected.connectionId,
        'credential profile update',
      ) as UpdateCredentialProfileResult;
    });
  }

  async #setCredentialProfileEnabled(
    input: CredentialProfileSetEnabledInput,
  ): Promise<OperationOutcome<'credential.profile.set-enabled'>> {
    return this.#storeMutation(async () => {
      const result = await this.#stores.operations.setCredentialProfileEnabled(input);
      return projectCredentialProfileMutation(
        result,
        input.expected.connectionId,
        'credential profile set enabled',
      ) as SetCredentialProfileEnabledResult;
    });
  }

  async #removeCredentialProfile(
    input: CredentialProfileRemoveInput,
  ): Promise<OperationOutcome<'credential.profile.remove'>> {
    return this.#storeMutation(async () => {
      const result = await this.#stores.operations.removeCredentialProfile(input);
      return projectCredentialProfileMutation(
        result,
        input.expected.connectionId,
        'credential profile remove',
      ) as RemoveCredentialProfileResult;
    });
  }

  async #setCredentialRoutingMode(
    input: CredentialProfileSetRoutingModeInput,
  ): Promise<OperationOutcome<'credential.profile.set-routing-mode'>> {
    return this.#storeMutation(async () => {
      const result = await this.#stores.operations.setCredentialRoutingMode(input);
      return projectCredentialProfileMutation(
        result,
        input.expected.connectionId,
        'credential profile set routing mode',
      ) as SetCredentialRoutingModeResult;
    });
  }

  async #queryCredentialProfileReadiness(
    input: CredentialProfileQueryInput,
  ): Promise<OperationOutcome<'credential.profile.query'>> {
    return this.#storeCredentialQuery(async () => {
      const result = await this.#stores.operations.readCredentialProfileReadiness(
        input.connectionId,
      );
      return result.kind === 'found'
        ? {
            kind: 'found' as const,
            connectionId: result.connectionId,
            connectionRevision: result.connectionRevision,
            routingMode: result.routingMode,
            readyCandidateCount: result.readyCandidateCount,
            profiles: result.profiles,
          }
        : { kind: 'connection_not_found' as const };
    });
  }

  async #queryConnectionRequestHeaders(
    input: ConnectionRequestHeadersQueryInput,
  ): Promise<OperationOutcome<'connection.request-headers.query'>> {
    return this.#storeCredentialQuery(async () => {
      const result = await this.#stores.operations.getConnectionRequestHeaders(input.connectionId);
      return result === null
        ? { kind: 'connection_not_found' as const }
        : { kind: 'found' as const, names: result.names };
    });
  }

  async #replaceConnectionRequestHeaders(
    input: ConnectionRequestHeadersReplaceInput,
  ): Promise<OperationOutcome<'connection.request-headers.replace'>> {
    return this.#storeMutation(() =>
      this.#stores.operations.replaceConnectionRequestHeaders(input.connectionId, input.headers),
    );
  }

  async #storeQuery<T>(operation: () => Promise<T>): Promise<StoreQueryOutcome<T>> {
    return this.#runStoreOperation(operation, 'query');
  }

  async #storeCredentialQuery<T>(
    operation: () => Promise<T>,
  ): Promise<StoreCredentialQueryOutcome<T>> {
    return this.#runStoreOperation(operation, 'credential_query');
  }

  async #storeMutation<T>(operation: () => Promise<T>): Promise<StoreMutationOutcome<T>> {
    return this.activation.runMutation(async () => {
      const outcome = await this.#runStoreOperation(operation, 'mutation');
      if (
        (!outcome.ok && outcome.error.code === 'commit_outcome_unknown') ||
        (outcome.ok && isCommittedMutationResult(outcome.result))
      ) {
        try {
          await this.onCommittedMutation();
        } catch {
          // The durable outcome is authoritative, but no later Turn may activate
          // against a backend whose invalidation did not complete.
          this.activation.poison();
        }
      }
      return outcome;
    });
  }

  async #runStoreOperation<T>(
    operation: () => Promise<T>,
    mode: 'query',
  ): Promise<StoreQueryOutcome<T>>;
  async #runStoreOperation<T>(
    operation: () => Promise<T>,
    mode: 'credential_query',
  ): Promise<StoreCredentialQueryOutcome<T>>;
  async #runStoreOperation<T>(
    operation: () => Promise<T>,
    mode: 'mutation',
  ): Promise<StoreMutationOutcome<T>>;
  async #runStoreOperation<T>(
    operation: () => Promise<T>,
    mode: 'query' | 'credential_query' | 'mutation',
  ): Promise<StoreMutationOutcome<T>> {
    try {
      return { ok: true, result: await operation() };
    } catch (error) {
      if (!(error instanceof RuntimePolicyStoreError)) throw error;
      switch (error.code) {
        case 'commit_outcome_unknown':
          if (mode !== 'mutation') {
            throw invariantFailure('A read operation reported an unknown commit outcome');
          }
          return {
            ok: false,
            error: {
              code: 'commit_outcome_unknown',
              message: 'Runtime policy commit outcome is unknown',
            },
          };
        case 'io_failed':
        case 'invalid_document':
          return {
            ok: false,
            error: {
              code: 'persistence_failed',
              message: 'Runtime policy persistence failed',
            },
          };
        case 'invalid_policy_input':
        case 'invalid_connection_input':
          if (mode !== 'mutation') {
            throw invariantFailure('A read operation admitted invalid runtime policy input');
          }
          return {
            ok: false,
            error: {
              code: 'invalid_request',
              message: 'Runtime policy mutation is invalid for the current state',
            },
          };
        case 'invalid_credential_input':
          if (mode === 'query') {
            throw invariantFailure('A read operation admitted invalid runtime policy input');
          }
          return {
            ok: false,
            error: {
              code: 'invalid_request',
              message:
                mode === 'mutation'
                  ? 'Runtime policy mutation is invalid for the current state'
                  : 'Credential query is invalid for the current connection',
            },
          };
      }
    }
  }
}

function isCommittedMutationResult(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'committed'
  );
}

function projectPolicyMutation(result: MutateRuntimePolicyResult) {
  return result.kind === 'committed'
    ? { kind: 'committed' as const, revision: result.snapshot.revision }
    : result;
}

function requirePolicyQuery(
  outcome: OperationOutcome<'runtime.policy.query'>,
): RuntimePolicySnapshot {
  if (outcome.ok) return outcome.result;
  throw new Error(`Runtime Policy query failed: ${outcome.error.message}`);
}

function requirePolicyMutation(
  outcome: OperationOutcome<'runtime.policy.mutate'>,
): Extract<OperationOutcome<'runtime.policy.mutate'>, { readonly ok: true }>['result'] {
  if (outcome.ok) return outcome.result;
  throw new Error(`Runtime Policy mutation failed: ${outcome.error.message}`);
}

function committedCatalogRevision(snapshot: ConnectionCatalogSnapshot) {
  return { kind: 'committed' as const, catalogRevision: snapshot.revision };
}

function committedConnection(
  snapshot: ConnectionCatalogSnapshot,
  connection: ConnectionCatalogEntry,
) {
  return {
    kind: 'committed' as const,
    catalogRevision: snapshot.revision,
    connection: connectionBasis(connection),
  };
}

type CredentialProfileProtocolResult =
  | CreateCredentialProfileResult
  | UpdateCredentialProfileResult
  | SetCredentialProfileEnabledResult
  | RemoveCredentialProfileResult
  | SetCredentialRoutingModeResult;

/**
 * Project a storage-level CredentialProfileMutationResult to the wire-safe
 * protocol projection: committed carries only the catalog revision and
 * connection basis (never the full snapshot), and `profile_not_found` drops
 * the internal expected basis.
 */
function projectCredentialProfileMutation(
  result: CredentialProfileMutationResult,
  connectionId: string,
  label: string,
): CredentialProfileProtocolResult {
  switch (result.kind) {
    case 'committed': {
      const connection = result.snapshot.connections.find(
        (candidate) => candidate.connectionId === connectionId,
      );
      if (!connection) {
        throw invariantFailure(`Committed ${label} omitted its connection basis`);
      }
      return {
        kind: 'committed',
        catalogRevision: result.snapshot.revision,
        connection: connectionBasis(connection),
      };
    }
    case 'connection_not_found':
      return { kind: 'connection_not_found' };
    case 'connection_stale':
      return {
        kind: 'connection_stale',
        expected: result.expected,
        actual: result.actual,
      };
    case 'profile_not_found':
      return { kind: 'profile_not_found' };
    case 'profile_stale':
      return {
        kind: 'profile_stale',
        expected: result.expected,
        actual: result.actual,
      };
    case 'profile_label_conflict':
      return { kind: 'profile_label_conflict', label: result.label };
    case 'capacity_limit':
      return { kind: 'capacity_limit', max: result.max };
    case 'primary_not_removable':
      return { kind: 'primary_not_removable' };
    case 'auth_not_supported':
      return { kind: 'auth_not_supported', providerType: result.providerType };
    case 'balanced_activation_rejected':
      return { kind: 'balanced_activation_rejected', reason: result.reason };
    default:
      throw invariantFailure(`Unknown ${label} result kind`);
  }
}

function connectionBasis(connection: ConnectionCatalogEntry): ConnectionVersionBasis {
  return { connectionId: connection.connectionId, revision: connection.revision };
}

function projectCatalogItems(snapshot: ConnectionCatalogSnapshot): ConnectionCatalogPageItem[] {
  const items: ConnectionCatalogPageItem[] = [];
  for (const [connectionIndex, connection] of snapshot.connections.entries()) {
    // Profiles ride on their enabled_model_id item, never in one header
    // table: a header item is atomic to the paginator, so a long declaration
    // list would make the whole connection unreadable. Credential routing
    // declarations travel exclusively through the readiness query.
    const { enabledModelIds, models, relayModelProfiles, credentialRouting, ...header } =
      connection;
    items.push({
      kind: 'connection',
      connectionIndex,
      ...header,
      enabledModelIdCount: enabledModelIds.length,
      modelCount: models.length,
    });
    for (const [itemIndex, modelId] of enabledModelIds.entries()) {
      const relayProfile = relayModelProfiles?.[modelId];
      items.push({
        kind: 'enabled_model_id',
        connectionIndex,
        itemIndex,
        modelId,
        ...(relayProfile === undefined ? {} : { relayProfile }),
      });
    }
    for (const [itemIndex, model] of models.entries()) {
      items.push({ kind: 'model', connectionIndex, itemIndex, model });
    }
  }
  return items;
}

function catalogPage(
  snapshot: ConnectionCatalogSnapshot,
  allItems: readonly ConnectionCatalogPageItem[],
  offset: number,
): ConnectionCatalogQueryResult {
  const items: ConnectionCatalogPageItem[] = [];
  const limit = Math.min(allItems.length, offset + CONNECTION_CATALOG_PAGE_MAX_ITEMS);
  for (let index = offset; index < limit; index += 1) {
    const item = allItems[index];
    if (!item) throw invariantFailure('Catalog projection index was out of bounds');
    const candidate = [...items, item];
    const nextOffset = offset + candidate.length;
    const result = {
      kind: 'page' as const,
      revision: snapshot.revision,
      defaultTarget: snapshot.defaultTarget,
      connectionCount: snapshot.connections.length,
      items: candidate,
      nextCursor: nextOffset < allItems.length ? cursorForItem(allItems[nextOffset]) : null,
    };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > CONNECTION_CATALOG_PAGE_MAX_BYTES) {
      break;
    }
    items.push(item);
  }
  if (items.length === 0 && offset < allItems.length) {
    throw invariantFailure('A legal catalog item exceeded the page result byte limit');
  }
  const nextOffset = offset + items.length;
  return {
    kind: 'page' as const,
    revision: snapshot.revision,
    defaultTarget: snapshot.defaultTarget,
    connectionCount: snapshot.connections.length,
    items,
    nextCursor: nextOffset < allItems.length ? cursorForItem(allItems[nextOffset]) : null,
  };
}

function cursorForItem(item: ConnectionCatalogPageItem | undefined): ConnectionCatalogCursor {
  if (!item) throw invariantFailure('Catalog next cursor had no corresponding item');
  return item.kind === 'connection'
    ? { connectionIndex: item.connectionIndex, part: 'connection' }
    : {
        connectionIndex: item.connectionIndex,
        part: item.kind,
        itemIndex: item.itemIndex,
      };
}

function cursorOffset(
  cursor: ConnectionCatalogCursor,
  items: readonly ConnectionCatalogPageItem[],
): number | null {
  const offset = items.findIndex((item) => sameCursor(item, cursor));
  return offset >= 0 ? offset : null;
}

function sameCursor(item: ConnectionCatalogPageItem, cursor: ConnectionCatalogCursor): boolean {
  if (item.connectionIndex !== cursor.connectionIndex || item.kind !== cursor.part) return false;
  if (item.kind === 'connection') return cursor.part === 'connection';
  if (cursor.part === 'connection') return false;
  return item.itemIndex === cursor.itemIndex;
}

function invalidCatalogRequest() {
  return {
    ok: false as const,
    error: { code: 'invalid_request' as const, message: 'Invalid connection catalog cursor' },
  };
}

function unconfiguredStatus(locator: CredentialLocator): CredentialStatus {
  return {
    locator,
    configured: false,
    credentialId: null,
    revision: null,
    updatedAt: null,
  };
}

function sameLocator(left: CredentialLocator, right: CredentialLocator): boolean {
  if (left.scope !== right.scope || left.kind !== right.kind) return false;
  switch (left.scope) {
    case 'connection':
      return right.scope === 'connection' && left.connectionId === right.connectionId;
    case 'connection_profile':
      return (
        right.scope === 'connection_profile' &&
        left.connectionId === right.connectionId &&
        left.profileId === right.profileId
      );
    case 'web_search':
      return right.scope === 'web_search' && left.provider === right.provider;
    case 'network_proxy':
      return right.scope === 'network_proxy';
  }
}

function invariantFailure(message: string): Error {
  return new Error(`Runtime policy coordinator invariant failed: ${message}`);
}
