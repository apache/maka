import type {
  ConnectionCatalogEntry,
  ConnectionCatalogSnapshot,
  ConnectionVersionBasis,
  CredentialLocator,
  CredentialStatus,
  MutateRuntimePolicyResult,
} from '@maka/core/runtime-policy';
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
  type CredentialVaultDeleteInput,
  type CredentialVaultQueryInput,
  type CredentialVaultSetInput,
  type OperationOutcome,
  type RuntimePolicyMutateInput,
} from '../protocol/index.js';
import type { RuntimePolicyOperationHandlerMap } from './operation-dispatcher.js';
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
  };

  readonly #stores: RuntimePolicyStoresWriter;

  constructor(
    stores: RuntimePolicyStoresWriter,
    private readonly activation: RuntimePolicyActivationGate,
    private readonly onCommittedMutation: () => Promise<void> = async () => {},
  ) {
    this.#stores = authenticateRuntimePolicyStoresWriter(stores);
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

function connectionBasis(connection: ConnectionCatalogEntry): ConnectionVersionBasis {
  return { connectionId: connection.connectionId, revision: connection.revision };
}

function projectCatalogItems(snapshot: ConnectionCatalogSnapshot): ConnectionCatalogPageItem[] {
  const items: ConnectionCatalogPageItem[] = [];
  for (const [connectionIndex, connection] of snapshot.connections.entries()) {
    const { enabledModelIds, models, ...header } = connection;
    items.push({
      kind: 'connection',
      connectionIndex,
      ...header,
      enabledModelIdCount: enabledModelIds.length,
      modelCount: models.length,
    });
    for (const [itemIndex, modelId] of enabledModelIds.entries()) {
      items.push({ kind: 'enabled_model_id', connectionIndex, itemIndex, modelId });
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
    case 'web_search':
      return right.scope === 'web_search' && left.provider === right.provider;
    case 'network_proxy':
      return right.scope === 'network_proxy';
  }
}

function invariantFailure(message: string): Error {
  return new Error(`Runtime policy coordinator invariant failed: ${message}`);
}
