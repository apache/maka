import {
  CONNECTION_CATALOG_MAX_CONNECTIONS,
  CONNECTION_CATALOG_MAX_ENABLED_MODEL_IDS,
  CONNECTION_CATALOG_MAX_MODELS_PER_CONNECTION,
  decodeCanonicalConnectionBaseUrl,
  decodeCanonicalRuntimePolicy,
  decodeConnectionModel,
  decodeConnectionModelId,
  decodeConnectionName,
  decodeConnectionSlug,
  decodeConnectionTarget,
  decodeConnectionTestSummary,
  decodeConnectionVersionBasis,
  decodeCredentialLocator,
  decodeCredentialStatus,
  decodeCredentialVersionBasis,
  decodeProviderType,
  normalizeCreateCatalogConnectionInput,
  normalizeDeleteCredentialInput,
  normalizeRemoveCatalogConnectionInput,
  normalizeRuntimePolicyMutation,
  normalizeSetCredentialInput,
  normalizeSetDefaultConnectionTargetInput,
  normalizeUpdateCatalogConnectionInput,
  RuntimePolicyDomainDecodeError,
  type ConnectionCatalogEntry,
  type ConnectionModel,
  type ConnectionTarget,
  type ConnectionVersionBasis,
  type CreateCatalogConnectionInput,
  type CredentialLocator,
  type CredentialStatus,
  type CredentialVersionBasis,
  type DeleteCredentialInput,
  type MutateRuntimePolicyInput,
  type RemoveCatalogConnectionInput,
  type RevisionConflict,
  type RuntimePolicySnapshot,
  type SetCredentialInput,
  type SetDefaultConnectionTargetInput,
  type UpdateCatalogConnectionInput,
} from '@maka/core/runtime-policy';
import { requireExactRecord, requireRecord } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const CONNECTION_CATALOG_PAGE_MAX_ITEMS = 128;
export const CONNECTION_CATALOG_PAGE_MAX_BYTES = 48 * 1024;
export const RUNTIME_POLICY_SNAPSHOT_MAX_BYTES = 48 * 1024;
export const CREDENTIAL_SECRET_MAX_BYTES = 10 * 1024;

const CONNECTION_MUTATION_MAX_ENABLED_MODEL_IDS = 64;
const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'internal_failure',
  'persistence_failed',
] as const;
const CATALOG_QUERY_ERRORS = [...QUERY_ERRORS, 'invalid_request'] as const;
const CREDENTIAL_QUERY_ERRORS = [...QUERY_ERRORS, 'invalid_request'] as const;
const MUTATION_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'internal_failure',
  'persistence_failed',
  'commit_outcome_unknown',
] as const;

export type RuntimePolicyQueryInput = Record<string, never>;
export type RuntimePolicyQueryResult = RuntimePolicySnapshot;
export type RuntimePolicyMutateInput = MutateRuntimePolicyInput;
export type RuntimePolicyMutateResult =
  | { readonly kind: 'committed'; readonly revision: number }
  | RevisionConflict;

export type ConnectionCatalogCursor =
  | { readonly connectionIndex: number; readonly part: 'connection' }
  | {
      readonly connectionIndex: number;
      readonly part: 'enabled_model_id' | 'model';
      readonly itemIndex: number;
    };

export type ConnectionCatalogQueryInput =
  | { readonly kind: 'start' }
  | {
      readonly kind: 'continue';
      readonly revision: number;
      readonly cursor: ConnectionCatalogCursor;
    };

export type ConnectionCatalogHeaderItem = Omit<
  ConnectionCatalogEntry,
  'enabledModelIds' | 'models'
> & {
  readonly kind: 'connection';
  readonly connectionIndex: number;
  readonly enabledModelIdCount: number;
  readonly modelCount: number;
};

export type ConnectionCatalogPageItem =
  | ConnectionCatalogHeaderItem
  | {
      readonly kind: 'enabled_model_id';
      readonly connectionIndex: number;
      readonly itemIndex: number;
      readonly modelId: string;
    }
  | {
      readonly kind: 'model';
      readonly connectionIndex: number;
      readonly itemIndex: number;
      readonly model: ConnectionModel;
    };

export type ConnectionCatalogQueryResult =
  | {
      readonly kind: 'page';
      readonly revision: number;
      readonly defaultTarget: ConnectionTarget | null;
      readonly connectionCount: number;
      readonly items: readonly ConnectionCatalogPageItem[];
      readonly nextCursor: ConnectionCatalogCursor | null;
    }
  | {
      readonly kind: 'revision_changed';
      readonly expectedRevision: number;
      readonly actualRevision: number;
    };

export type CreateCatalogConnectionResult =
  | CatalogConnectionCommitted
  | RevisionConflict
  | { readonly kind: 'connection_exists'; readonly slug: string };
export type UpdateCatalogConnectionResult =
  | CatalogConnectionCommitted
  | ConnectionStale
  | { readonly kind: 'invalid_default_target'; readonly target: ConnectionTarget };
export type RemoveCatalogConnectionResult = CatalogCommitted | ConnectionStale;
export type SetDefaultConnectionTargetResult =
  | CatalogCommitted
  | RevisionConflict
  | { readonly kind: 'invalid_default_target'; readonly target: ConnectionTarget };
export type ConnectionCatalogCreateInput = CreateCatalogConnectionInput;
export type ConnectionCatalogUpdateInput = UpdateCatalogConnectionInput;
export type ConnectionCatalogRemoveInput = RemoveCatalogConnectionInput;
export type ConnectionCatalogSetDefaultTargetInput = SetDefaultConnectionTargetInput;

interface CatalogCommitted {
  readonly kind: 'committed';
  readonly catalogRevision: number;
}

interface CatalogConnectionCommitted extends CatalogCommitted {
  readonly connection: ConnectionVersionBasis;
}

interface ConnectionStale {
  readonly kind: 'connection_stale';
  readonly expected: ConnectionVersionBasis;
  readonly actual: ConnectionVersionBasis | null;
}

export interface CredentialVaultQueryInput {
  readonly locator: CredentialLocator;
}

export type CredentialVaultQueryResult =
  | { readonly kind: 'status'; readonly status: CredentialStatus }
  | { readonly kind: 'connection_not_found' };

export type SetCredentialResult =
  | CredentialCommitted
  | { readonly kind: 'connection_not_found' }
  | CredentialStale;
export type DeleteCredentialResult =
  | CredentialCommitted
  | { readonly kind: 'connection_not_found' }
  | CredentialStale;
export type CredentialVaultSetInput = SetCredentialInput;
export type CredentialVaultDeleteInput = DeleteCredentialInput;

interface CredentialCommitted {
  readonly kind: 'committed';
  readonly vaultRevision: number;
  readonly status: CredentialStatus;
}

interface CredentialStale {
  readonly kind: 'credential_stale';
  readonly expected: CredentialVersionBasis | null;
  readonly actual: CredentialVersionBasis | null;
}

export const RUNTIME_POLICY_OPERATION_SPECS = {
  'runtime.policy.query': defineOperation<
    RuntimePolicyQueryInput,
    RuntimePolicyQueryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeEmptyInput,
    decodeOutput: decodeRuntimePolicySnapshot,
  }),
  'runtime.policy.mutate': defineOperation<
    RuntimePolicyMutateInput,
    RuntimePolicyMutateResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeRuntimePolicyMutation,
    decodeOutput: decodeRuntimePolicyMutationResult,
  }),
  'connection.catalog.query': defineOperation<
    ConnectionCatalogQueryInput,
    ConnectionCatalogQueryResult,
    (typeof CATALOG_QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: CATALOG_QUERY_ERRORS,
    decodeInput: decodeCatalogQueryInput,
    decodeOutput: decodeCatalogQueryResult,
  }),
  'connection.catalog.create': defineOperation<
    ConnectionCatalogCreateInput,
    CreateCatalogConnectionResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeCreateConnectionInput,
    decodeOutput: decodeCreateConnectionResult,
  }),
  'connection.catalog.update': defineOperation<
    ConnectionCatalogUpdateInput,
    UpdateCatalogConnectionResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeUpdateConnectionInput,
    decodeOutput: decodeUpdateConnectionResult,
  }),
  'connection.catalog.remove': defineOperation<
    ConnectionCatalogRemoveInput,
    RemoveCatalogConnectionResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeRemoveConnectionInput,
    decodeOutput: decodeRemoveConnectionResult,
  }),
  'connection.catalog.set-default-target': defineOperation<
    ConnectionCatalogSetDefaultTargetInput,
    SetDefaultConnectionTargetResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeSetDefaultTargetInput,
    decodeOutput: decodeSetDefaultTargetResult,
  }),
  'credential.vault.query': defineOperation<
    CredentialVaultQueryInput,
    CredentialVaultQueryResult,
    (typeof CREDENTIAL_QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: CREDENTIAL_QUERY_ERRORS,
    decodeInput: decodeCredentialQueryInput,
    decodeOutput: decodeCredentialQueryResult,
  }),
  'credential.vault.set': defineOperation<
    CredentialVaultSetInput,
    SetCredentialResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeSetCredentialInput,
    decodeOutput: decodeSetCredentialResult,
  }),
  'credential.vault.delete': defineOperation<
    CredentialVaultDeleteInput,
    DeleteCredentialResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeDeleteCredentialInput,
    decodeOutput: decodeDeleteCredentialResult,
  }),
} as const;

function decodeEmptyInput(value: unknown): RuntimePolicyQueryInput {
  requireExactRecord(value, 'runtime policy query input', []);
  return {};
}

function decodeRuntimePolicySnapshot(value: unknown): RuntimePolicySnapshot {
  const item = requireExactRecord(value, 'runtime policy snapshot', ['revision', 'policy']);
  const snapshot = {
    revision: revision(item.revision, 'runtime policy revision'),
    policy: decodeDomain(() => decodeCanonicalRuntimePolicy(item.policy)),
  };
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > RUNTIME_POLICY_SNAPSHOT_MAX_BYTES) {
    throw invalidProtocolFrame('Runtime policy snapshot exceeds byte limit');
  }
  return snapshot;
}

function decodeRuntimePolicyMutation(value: unknown): MutateRuntimePolicyInput {
  return decodeDomain(() => normalizeRuntimePolicyMutation(value));
}

function decodeRuntimePolicyMutationResult(value: unknown): RuntimePolicyMutateResult {
  const item = requireRecord(value, 'runtime policy mutation result');
  if (item.kind === 'committed') {
    const committed = requireExactRecord(item, 'runtime policy committed result', [
      'kind',
      'revision',
    ]);
    return { kind: 'committed', revision: revision(committed.revision, 'runtime policy revision') };
  }
  return revisionConflict(item, 'runtime policy mutation result');
}

function decodeCatalogQueryInput(value: unknown): ConnectionCatalogQueryInput {
  const item = requireRecord(value, 'connection catalog query input');
  if (item.kind === 'start') {
    requireExactRecord(item, 'connection catalog start query', ['kind']);
    return { kind: 'start' };
  }
  if (item.kind === 'continue') {
    const continuation = requireExactRecord(item, 'connection catalog continuation query', [
      'kind',
      'revision',
      'cursor',
    ]);
    return {
      kind: 'continue',
      revision: revision(continuation.revision, 'catalog revision'),
      cursor: catalogCursor(continuation.cursor),
    };
  }
  throw invalidProtocolFrame('Invalid connection catalog query kind');
}

function decodeCatalogQueryResult(value: unknown): ConnectionCatalogQueryResult {
  const item = requireRecord(value, 'connection catalog query result');
  if (item.kind === 'revision_changed') {
    const changed = requireExactRecord(item, 'catalog revision changed result', [
      'kind',
      'expectedRevision',
      'actualRevision',
    ]);
    return {
      kind: 'revision_changed',
      expectedRevision: revision(changed.expectedRevision, 'expected catalog revision'),
      actualRevision: revision(changed.actualRevision, 'actual catalog revision'),
    };
  }
  if (item.kind !== 'page')
    throw invalidProtocolFrame('Invalid connection catalog query result kind');
  const page = requireExactRecord(item, 'connection catalog page', [
    'kind',
    'revision',
    'defaultTarget',
    'connectionCount',
    'items',
    'nextCursor',
  ]);
  if (!Array.isArray(page.items) || page.items.length > CONNECTION_CATALOG_PAGE_MAX_ITEMS) {
    throw invalidProtocolFrame('Invalid connection catalog page items');
  }
  const decoded: ConnectionCatalogQueryResult = {
    kind: 'page',
    revision: revision(page.revision, 'catalog revision'),
    defaultTarget:
      page.defaultTarget === null
        ? null
        : decodeDomain(() => decodeConnectionTarget(page.defaultTarget)),
    connectionCount: integer(
      page.connectionCount,
      'connection count',
      0,
      CONNECTION_CATALOG_MAX_CONNECTIONS,
    ),
    items: page.items.map(catalogPageItem),
    nextCursor: page.nextCursor === null ? null : catalogCursor(page.nextCursor),
  };
  if (Buffer.byteLength(JSON.stringify(decoded), 'utf8') > CONNECTION_CATALOG_PAGE_MAX_BYTES) {
    throw invalidProtocolFrame('Connection catalog page exceeds byte limit');
  }
  validateCatalogPageStructure(decoded);
  return decoded;
}

function catalogCursor(value: unknown): ConnectionCatalogCursor {
  const item = requireRecord(value, 'connection catalog cursor');
  if (item.part === 'connection') {
    const cursor = requireExactRecord(item, 'connection catalog cursor', [
      'connectionIndex',
      'part',
    ]);
    return {
      connectionIndex: integer(
        cursor.connectionIndex,
        'connection index',
        0,
        CONNECTION_CATALOG_MAX_CONNECTIONS - 1,
      ),
      part: 'connection',
    };
  }
  if (item.part === 'enabled_model_id' || item.part === 'model') {
    const cursor = requireExactRecord(item, 'connection catalog cursor', [
      'connectionIndex',
      'part',
      'itemIndex',
    ]);
    const maxItems =
      item.part === 'enabled_model_id'
        ? CONNECTION_CATALOG_MAX_ENABLED_MODEL_IDS
        : CONNECTION_CATALOG_MAX_MODELS_PER_CONNECTION;
    return {
      connectionIndex: integer(
        cursor.connectionIndex,
        'connection index',
        0,
        CONNECTION_CATALOG_MAX_CONNECTIONS - 1,
      ),
      part: item.part,
      itemIndex: integer(cursor.itemIndex, 'item index', 0, maxItems - 1),
    };
  }
  throw invalidProtocolFrame('Invalid connection catalog cursor part');
}

function catalogPageItem(value: unknown): ConnectionCatalogPageItem {
  const item = requireRecord(value, 'connection catalog page item');
  if (item.kind === 'enabled_model_id') {
    const enabled = requireExactRecord(item, 'enabled model id item', [
      'kind',
      'connectionIndex',
      'itemIndex',
      'modelId',
    ]);
    return {
      kind: 'enabled_model_id',
      connectionIndex: integer(
        enabled.connectionIndex,
        'connection index',
        0,
        CONNECTION_CATALOG_MAX_CONNECTIONS - 1,
      ),
      itemIndex: integer(
        enabled.itemIndex,
        'item index',
        0,
        CONNECTION_CATALOG_MAX_ENABLED_MODEL_IDS - 1,
      ),
      modelId: decodeDomain(() => decodeConnectionModelId(enabled.modelId)),
    };
  }
  if (item.kind === 'model') {
    const modelItem = requireExactRecord(item, 'connection model item', [
      'kind',
      'connectionIndex',
      'itemIndex',
      'model',
    ]);
    return {
      kind: 'model',
      connectionIndex: integer(
        modelItem.connectionIndex,
        'connection index',
        0,
        CONNECTION_CATALOG_MAX_CONNECTIONS - 1,
      ),
      itemIndex: integer(
        modelItem.itemIndex,
        'item index',
        0,
        CONNECTION_CATALOG_MAX_MODELS_PER_CONNECTION - 1,
      ),
      model: decodeDomain(() => decodeConnectionModel(modelItem.model)),
    };
  }
  if (item.kind !== 'connection')
    throw invalidProtocolFrame('Invalid connection catalog page item kind');
  const header = optionalRecord(
    item,
    'connection header',
    [
      'kind',
      'connectionIndex',
      'connectionId',
      'revision',
      'slug',
      'name',
      'providerType',
      'baseUrl',
      'enabled',
      'modelSource',
      'modelsFetchedAt',
      'lastTest',
      'enabledModelIdCount',
      'modelCount',
    ],
    [
      'kind',
      'connectionIndex',
      'connectionId',
      'revision',
      'slug',
      'name',
      'providerType',
      'enabled',
      'enabledModelIdCount',
      'modelCount',
    ],
  );
  if ((header.modelSource === undefined) !== (header.modelsFetchedAt === undefined)) {
    throw invalidProtocolFrame('Invalid connection header model discovery fields');
  }
  const provider = decodeDomain(() => decodeProviderType(header.providerType));
  const baseUrl =
    header.baseUrl === undefined
      ? undefined
      : decodeDomain(() => decodeCanonicalConnectionBaseUrl(header.baseUrl, provider));
  const modelCount = integer(
    header.modelCount,
    'model count',
    0,
    CONNECTION_CATALOG_MAX_MODELS_PER_CONNECTION,
  );
  if (header.modelSource === undefined && modelCount !== 0) {
    throw invalidProtocolFrame('Invalid connection header model count');
  }
  const basis = decodeDomain(() =>
    decodeConnectionVersionBasis({
      connectionId: header.connectionId,
      revision: header.revision,
    }),
  );
  return {
    kind: 'connection',
    connectionIndex: integer(
      header.connectionIndex,
      'connection index',
      0,
      CONNECTION_CATALOG_MAX_CONNECTIONS - 1,
    ),
    connectionId: basis.connectionId,
    revision: basis.revision,
    slug: decodeDomain(() => decodeConnectionSlug(header.slug)),
    name: decodeDomain(() => decodeConnectionName(header.name)),
    providerType: provider,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    enabled: boolean(header.enabled, 'connection enabled'),
    ...(header.modelSource === undefined ? {} : { modelSource: modelSource(header.modelSource) }),
    ...(header.modelsFetchedAt === undefined
      ? {}
      : {
          modelsFetchedAt: integer(
            header.modelsFetchedAt,
            'models fetched at',
            0,
            Number.MAX_SAFE_INTEGER,
          ),
        }),
    ...(header.lastTest === undefined
      ? {}
      : { lastTest: decodeDomain(() => decodeConnectionTestSummary(header.lastTest)) }),
    enabledModelIdCount: integer(
      header.enabledModelIdCount,
      'enabled model id count',
      0,
      CONNECTION_CATALOG_MAX_ENABLED_MODEL_IDS,
    ),
    modelCount,
  };
}

function decodeCreateConnectionInput(value: unknown): CreateCatalogConnectionInput {
  const input = decodeDomain(() => normalizeCreateCatalogConnectionInput(value));
  assertMutationEnabledModelIds(input.connection.enabledModelIds);
  return input;
}

function decodeUpdateConnectionInput(value: unknown): UpdateCatalogConnectionInput {
  const input = decodeDomain(() => normalizeUpdateCatalogConnectionInput(value));
  assertMutationEnabledModelIds(input.changes.enabledModelIds);
  return input;
}

function decodeRemoveConnectionInput(value: unknown): RemoveCatalogConnectionInput {
  return decodeDomain(() => normalizeRemoveCatalogConnectionInput(value));
}

function decodeSetDefaultTargetInput(value: unknown): SetDefaultConnectionTargetInput {
  return decodeDomain(() => normalizeSetDefaultConnectionTargetInput(value));
}

function decodeCreateConnectionResult(value: unknown): CreateCatalogConnectionResult {
  const item = requireRecord(value, 'create connection result');
  if (item.kind === 'committed') return catalogConnectionCommitted(item);
  if (item.kind === 'connection_exists') {
    const conflict = requireExactRecord(item, 'connection exists conflict', ['kind', 'slug']);
    return {
      kind: 'connection_exists',
      slug: decodeDomain(() => decodeConnectionSlug(conflict.slug)),
    };
  }
  return revisionConflict(item, 'create connection result');
}

function decodeUpdateConnectionResult(value: unknown): UpdateCatalogConnectionResult {
  const item = requireRecord(value, 'update connection result');
  if (item.kind === 'committed') return catalogConnectionCommitted(item);
  if (item.kind === 'connection_stale') return connectionStale(item);
  return invalidDefaultTarget(item, 'update connection result');
}

function decodeRemoveConnectionResult(value: unknown): RemoveCatalogConnectionResult {
  const item = requireRecord(value, 'remove connection result');
  return item.kind === 'committed' ? catalogCommitted(item) : connectionStale(item);
}

function decodeSetDefaultTargetResult(value: unknown): SetDefaultConnectionTargetResult {
  const item = requireRecord(value, 'set default target result');
  if (item.kind === 'committed') return catalogCommitted(item);
  if (item.kind === 'revision_conflict') return revisionConflict(item, 'set default target result');
  return invalidDefaultTarget(item, 'set default target result');
}

function catalogCommitted(value: unknown): CatalogCommitted {
  const item = requireExactRecord(value, 'catalog committed result', ['kind', 'catalogRevision']);
  if (item.kind !== 'committed') throw invalidProtocolFrame('Invalid catalog committed result');
  return { kind: 'committed', catalogRevision: revision(item.catalogRevision, 'catalog revision') };
}

function catalogConnectionCommitted(value: unknown): CatalogConnectionCommitted {
  const item = requireExactRecord(value, 'catalog connection committed result', [
    'kind',
    'catalogRevision',
    'connection',
  ]);
  if (item.kind !== 'committed') throw invalidProtocolFrame('Invalid catalog committed result');
  return {
    kind: 'committed',
    catalogRevision: revision(item.catalogRevision, 'catalog revision'),
    connection: decodeDomain(() => decodeConnectionVersionBasis(item.connection)),
  };
}

function connectionStale(value: unknown): ConnectionStale {
  const item = requireExactRecord(value, 'connection stale conflict', [
    'kind',
    'expected',
    'actual',
  ]);
  if (item.kind !== 'connection_stale') throw invalidProtocolFrame('Invalid connection conflict');
  return {
    kind: 'connection_stale',
    expected: decodeDomain(() => decodeConnectionVersionBasis(item.expected)),
    actual:
      item.actual === null ? null : decodeDomain(() => decodeConnectionVersionBasis(item.actual)),
  };
}

function invalidDefaultTarget(
  value: unknown,
  label: string,
): { kind: 'invalid_default_target'; target: ConnectionTarget } {
  const item = requireExactRecord(value, label, ['kind', 'target']);
  if (item.kind !== 'invalid_default_target') throw invalidProtocolFrame(`Invalid ${label}`);
  return {
    kind: 'invalid_default_target',
    target: decodeDomain(() => decodeConnectionTarget(item.target)),
  };
}

function decodeCredentialQueryInput(value: unknown): CredentialVaultQueryInput {
  const item = requireExactRecord(value, 'credential query input', ['locator']);
  return { locator: decodeDomain(() => decodeCredentialLocator(item.locator)) };
}

function decodeCredentialQueryResult(value: unknown): CredentialVaultQueryResult {
  const item = requireRecord(value, 'credential query result');
  if (item.kind === 'connection_not_found') {
    requireExactRecord(item, 'credential connection not found result', ['kind']);
    return { kind: 'connection_not_found' };
  }
  const status = requireExactRecord(item, 'credential status result', ['kind', 'status']);
  if (status.kind !== 'status') throw invalidProtocolFrame('Invalid credential query result');
  return { kind: 'status', status: decodeDomain(() => decodeCredentialStatus(status.status)) };
}

function decodeSetCredentialInput(value: unknown): SetCredentialInput {
  const input = decodeDomain(() => normalizeSetCredentialInput(value));
  if (Buffer.byteLength(input.secret, 'utf8') > CREDENTIAL_SECRET_MAX_BYTES) {
    throw invalidProtocolFrame('Invalid credential secret');
  }
  return input;
}

function decodeDeleteCredentialInput(value: unknown): DeleteCredentialInput {
  return decodeDomain(() => normalizeDeleteCredentialInput(value));
}

function decodeSetCredentialResult(value: unknown): SetCredentialResult {
  const item = requireRecord(value, 'set credential result');
  if (item.kind === 'committed') return credentialCommitted(item);
  if (item.kind === 'connection_not_found') {
    requireExactRecord(item, 'credential connection not found result', ['kind']);
    return { kind: 'connection_not_found' };
  }
  return credentialStale(item);
}

function decodeDeleteCredentialResult(value: unknown): DeleteCredentialResult {
  const item = requireRecord(value, 'delete credential result');
  if (item.kind === 'committed') return credentialCommitted(item);
  if (item.kind === 'connection_not_found') {
    requireExactRecord(item, 'credential connection not found result', ['kind']);
    return { kind: 'connection_not_found' };
  }
  return credentialStale(item);
}

function validateCatalogPageStructure(
  page: Extract<ConnectionCatalogQueryResult, { readonly kind: 'page' }>,
): void {
  if (page.items.length === 0) {
    if (page.connectionCount !== 0 || page.defaultTarget !== null || page.nextCursor !== null) {
      throw invalidProtocolFrame('Invalid empty connection catalog page');
    }
    return;
  }
  let previous: ConnectionCatalogCursor | undefined;
  for (const item of page.items) {
    if (item.connectionIndex >= page.connectionCount) {
      throw invalidProtocolFrame('Connection catalog item exceeds connection count');
    }
    const position = cursorForPageItem(item);
    if (previous && compareCatalogCursor(previous, position) >= 0) {
      throw invalidProtocolFrame('Connection catalog page does not make forward progress');
    }
    previous = position;
  }
  if (page.nextCursor) {
    if (
      page.nextCursor.connectionIndex >= page.connectionCount ||
      !previous ||
      compareCatalogCursor(previous, page.nextCursor) >= 0
    ) {
      throw invalidProtocolFrame('Invalid connection catalog next cursor');
    }
  }
}

function cursorForPageItem(item: ConnectionCatalogPageItem): ConnectionCatalogCursor {
  return item.kind === 'connection'
    ? { connectionIndex: item.connectionIndex, part: 'connection' }
    : {
        connectionIndex: item.connectionIndex,
        part: item.kind,
        itemIndex: item.itemIndex,
      };
}

function compareCatalogCursor(
  left: ConnectionCatalogCursor,
  right: ConnectionCatalogCursor,
): number {
  if (left.connectionIndex !== right.connectionIndex) {
    return left.connectionIndex - right.connectionIndex;
  }
  const leftPart = catalogCursorPartOrder(left.part);
  const rightPart = catalogCursorPartOrder(right.part);
  if (leftPart !== rightPart) return leftPart - rightPart;
  return (
    ('itemIndex' in left ? left.itemIndex : -1) - ('itemIndex' in right ? right.itemIndex : -1)
  );
}

function catalogCursorPartOrder(part: ConnectionCatalogCursor['part']): number {
  switch (part) {
    case 'connection':
      return 0;
    case 'enabled_model_id':
      return 1;
    case 'model':
      return 2;
  }
}

function credentialCommitted(value: unknown): CredentialCommitted {
  const item = requireExactRecord(value, 'credential committed result', [
    'kind',
    'vaultRevision',
    'status',
  ]);
  if (item.kind !== 'committed') throw invalidProtocolFrame('Invalid credential committed result');
  return {
    kind: 'committed',
    vaultRevision: revision(item.vaultRevision, 'vault revision'),
    status: decodeDomain(() => decodeCredentialStatus(item.status)),
  };
}

function credentialStale(value: unknown): CredentialStale {
  const item = requireExactRecord(value, 'credential stale conflict', [
    'kind',
    'expected',
    'actual',
  ]);
  if (item.kind !== 'credential_stale') throw invalidProtocolFrame('Invalid credential conflict');
  return {
    kind: 'credential_stale',
    expected:
      item.expected === null
        ? null
        : decodeDomain(() => decodeCredentialVersionBasis(item.expected)),
    actual:
      item.actual === null ? null : decodeDomain(() => decodeCredentialVersionBasis(item.actual)),
  };
}

function revisionConflict(value: unknown, label: string): RevisionConflict {
  const item = requireExactRecord(value, label, ['kind', 'expectedRevision', 'actualRevision']);
  if (item.kind !== 'revision_conflict') throw invalidProtocolFrame(`Invalid ${label}`);
  return {
    kind: 'revision_conflict',
    expectedRevision: revision(item.expectedRevision, 'expected revision'),
    actualRevision: revision(item.actualRevision, 'actual revision'),
  };
}

function optionalRecord(
  value: unknown,
  label: string,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  const item = requireRecord(value, label);
  assertAllowedKeys(item, label, allowed);
  if (required.some((key) => !Object.hasOwn(item, key)))
    throw invalidProtocolFrame(`Invalid ${label} fields`);
  return item;
}

function assertAllowedKeys(
  record: Record<string, unknown>,
  label: string,
  keys: readonly string[],
): void {
  const allowed = new Set(keys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw invalidProtocolFrame(`Unknown ${label} field`);
  }
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalidProtocolFrame(`Invalid ${label}`);
  return value;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    throw invalidProtocolFrame(`Invalid ${label}`);
  return value as number;
}

function revision(value: unknown, label: string): number {
  return integer(value, label, 0, Number.MAX_SAFE_INTEGER);
}
function modelSource(value: unknown): 'fetched' | 'fallback' {
  if (value !== 'fetched' && value !== 'fallback')
    throw invalidProtocolFrame('Invalid model source');
  return value;
}

function assertMutationEnabledModelIds(values: readonly string[]): void {
  if (values.length > CONNECTION_MUTATION_MAX_ENABLED_MODEL_IDS) {
    throw invalidProtocolFrame('Invalid enabled model ids');
  }
}

function decodeDomain<T>(decode: () => T): T {
  try {
    return decode();
  } catch (error) {
    if (error instanceof RuntimePolicyDomainDecodeError) {
      throw invalidProtocolFrame(error.message);
    }
    throw error;
  }
}
