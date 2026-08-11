import {
  CONNECTION_CATALOG_MAX_CONNECTIONS,
  CONNECTION_CATALOG_MAX_ENABLED_MODEL_IDS,
  CONNECTION_CATALOG_MAX_MODELS_PER_CONNECTION,
  CONNECTION_CREDENTIAL_PROFILE_LABEL_MAX_LENGTH,
  CONNECTION_CREDENTIAL_PROFILE_MAX,
  CONNECTION_CREDENTIAL_PROFILE_WEIGHT_MAX,
  CONNECTION_CREDENTIAL_PROFILE_WEIGHT_MIN,
  decodeCanonicalConnectionBaseUrl,
  decodeCanonicalRuntimePolicy,
  decodeConnectionModel,
  decodeConnectionModelId,
  decodeConnectionName,
  decodeConnectionSlug,
  decodeConnectionTarget,
  decodeConnectionTestSummary,
  decodeConnectionVersionBasis,
  decodeRuntimePolicyEntityId,
  decodeCredentialLocator,
  decodeCredentialProfileVersionBasis,
  decodeCredentialStatus,
  decodeCredentialVersionBasis,
  decodeProviderType,
  normalizeCreateCatalogConnectionInput,
  normalizeCreateCredentialProfileInput,
  normalizeDeleteCredentialInput,
  normalizeRemoveCatalogConnectionInput,
  normalizeRemoveCredentialProfileInput,
  normalizeOptionalRequestBodyOverlay,
  normalizeRequestHeaderUpdates,
  normalizeRuntimePolicyMutation,
  normalizeSetCredentialInput,
  normalizeSetCredentialProfileEnabledInput,
  normalizeSetCredentialRoutingModeInput,
  normalizeSetDefaultConnectionTargetInput,
  normalizeUpdateCatalogConnectionInput,
  normalizeUpdateCredentialProfileInput,
  REQUEST_HEADERS_MAX_BYTES,
  RequestCustomizationValidationError,
  RuntimePolicyDomainDecodeError,
  type ConnectionCatalogEntry,
  type ConnectionModel,
  type ConnectionTarget,
  type ConnectionTestErrorClass,
  type ConnectionTestSummary,
  type ConnectionVersionBasis,
  type CreateCatalogConnectionInput,
  type CreateCredentialProfileInput,
  type CredentialLocator,
  type CredentialProfileVersionBasis,
  type CredentialStatus,
  type CredentialVersionBasis,
  type DeleteCredentialInput,
  type MutateRuntimePolicyInput,
  type RemoveCatalogConnectionInput,
  type RemoveCredentialProfileInput,
  type RequestHeaderUpdate,
  type RevisionConflict,
  type RuntimePolicySnapshot,
  type SetCredentialInput,
  type SetCredentialProfileEnabledInput,
  type SetCredentialRoutingModeInput,
  type SetDefaultConnectionTargetInput,
  type UpdateCatalogConnectionInput,
  type UpdateCredentialProfileInput,
} from '@maka/core/runtime-policy';
import { normalizeRelayModelProfiles, type RelayModelProfile } from '@maka/core/model-thinking';
// The client subgraph cannot import core subpaths directly (dependency
// boundary); the wire types it needs are re-exported through this file.
export type { RelayModelProfile, RelayModelProfiles } from '@maka/core/model-thinking';
import {
  requireCount,
  requireEntityId,
  requireExactRecord,
  requireShapedRecord,
  requireRecord,
} from './codec.js';
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
  'enabledModelIds' | 'models' | 'relayModelProfiles' | 'credentialRouting'
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
      /**
       * The model's relay profile, when the connection declares one.
       * Profiles travel per item instead of in one header table so the
       * paginator can always split a catalog — a header item is atomic.
       */
      readonly relayProfile?: RelayModelProfile;
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

interface CredentialProfileCommitted {
  readonly kind: 'committed';
  readonly catalogRevision: number;
  readonly connection: ConnectionVersionBasis;
}

interface ProfileStale {
  readonly kind: 'profile_stale';
  readonly expected: CredentialProfileVersionBasis;
  readonly actual: CredentialProfileVersionBasis | null;
}

export type CreateCredentialProfileResult =
  | CredentialProfileCommitted
  | { readonly kind: 'connection_not_found' }
  | ConnectionStale
  | { readonly kind: 'profile_label_conflict'; readonly label: string }
  | { readonly kind: 'capacity_limit'; readonly max: number }
  | { readonly kind: 'auth_not_supported'; readonly providerType: string };
export type UpdateCredentialProfileResult =
  | CredentialProfileCommitted
  | ConnectionStale
  | { readonly kind: 'profile_not_found' }
  | ProfileStale
  | { readonly kind: 'profile_label_conflict'; readonly label: string };
export type SetCredentialProfileEnabledResult =
  | CredentialProfileCommitted
  | ConnectionStale
  | { readonly kind: 'profile_not_found' }
  | ProfileStale;
export type RemoveCredentialProfileResult =
  | CredentialProfileCommitted
  | ConnectionStale
  | { readonly kind: 'profile_not_found' }
  | ProfileStale
  | { readonly kind: 'primary_not_removable' };
export type SetCredentialRoutingModeResult =
  | CredentialProfileCommitted
  | ConnectionStale
  | { readonly kind: 'auth_not_supported'; readonly providerType: string }
  | { readonly kind: 'balanced_activation_rejected'; readonly reason: string };

export type CredentialProfileRoutingMode = 'legacy_primary' | 'balanced';

export interface CredentialProfileReadinessItem {
  readonly profileId: string;
  readonly revision: number;
  readonly label: string;
  readonly enabled: boolean;
  readonly weight: number;
  readonly primary: boolean;
  readonly credentialConfigured: boolean;
  readonly lastTest:
    | {
        readonly status: ConnectionTestSummary['status'];
        readonly checkedAt: string;
        readonly errorClass?: ConnectionTestErrorClass;
      }
    | null;
  readonly supportedModels: readonly string[];
  readonly circuit:
    | {
        readonly state: 'closed' | 'open' | 'half_open' | 'invalid';
        readonly blockedUntil: number | null;
        readonly nextProbeAt: number | null;
      }
    | null;
}

export interface CredentialProfileQueryInput {
  readonly connectionId: string;
}

export type CredentialProfileQueryResult =
  | {
      readonly kind: 'found';
      readonly connectionId: string;
      readonly connectionRevision: number;
      readonly routingMode: CredentialProfileRoutingMode;
      readonly readyCandidateCount: number;
      readonly profiles: readonly CredentialProfileReadinessItem[];
    }
  | { readonly kind: 'connection_not_found' };

export type CredentialProfileCreateInput = CreateCredentialProfileInput;
export type CredentialProfileUpdateInput = UpdateCredentialProfileInput;
export type CredentialProfileSetEnabledInput = SetCredentialProfileEnabledInput;
export type CredentialProfileRemoveInput = RemoveCredentialProfileInput;
export type CredentialProfileSetRoutingModeInput = SetCredentialRoutingModeInput;

export interface ConnectionRequestHeadersQueryInput {
  readonly connectionId: string;
}

export type ConnectionRequestHeadersQueryResult =
  | { readonly kind: 'found'; readonly names: readonly string[] }
  | { readonly kind: 'connection_not_found' };

export interface ConnectionRequestHeadersReplaceInput {
  readonly connectionId: string;
  readonly headers: readonly RequestHeaderUpdate[];
}

export type ConnectionRequestHeadersReplaceResult =
  | { readonly kind: 'committed' | 'unchanged'; readonly names: readonly string[] }
  | { readonly kind: 'connection_not_found' };

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
  'connection.request-headers.query': defineOperation<
    ConnectionRequestHeadersQueryInput,
    ConnectionRequestHeadersQueryResult,
    (typeof CREDENTIAL_QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: CREDENTIAL_QUERY_ERRORS,
    decodeInput: decodeConnectionRequestHeadersQueryInput,
    decodeOutput: decodeConnectionRequestHeadersQueryResult,
  }),
  'connection.request-headers.replace': defineOperation<
    ConnectionRequestHeadersReplaceInput,
    ConnectionRequestHeadersReplaceResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeConnectionRequestHeadersReplaceInput,
    decodeOutput: decodeConnectionRequestHeadersReplaceResult,
  }),
  'credential.profile.create': defineOperation<
    CredentialProfileCreateInput,
    CreateCredentialProfileResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeCredentialProfileCreateInput,
    decodeOutput: decodeCredentialProfileCreateResult,
  }),
  'credential.profile.update': defineOperation<
    CredentialProfileUpdateInput,
    UpdateCredentialProfileResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeCredentialProfileUpdateInput,
    decodeOutput: decodeCredentialProfileUpdateResult,
  }),
  'credential.profile.set-enabled': defineOperation<
    CredentialProfileSetEnabledInput,
    SetCredentialProfileEnabledResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeCredentialProfileSetEnabledInput,
    decodeOutput: decodeCredentialProfileSetEnabledResult,
  }),
  'credential.profile.remove': defineOperation<
    CredentialProfileRemoveInput,
    RemoveCredentialProfileResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeCredentialProfileRemoveInput,
    decodeOutput: decodeCredentialProfileRemoveResult,
  }),
  'credential.profile.set-routing-mode': defineOperation<
    CredentialProfileSetRoutingModeInput,
    SetCredentialRoutingModeResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeCredentialProfileSetRoutingModeInput,
    decodeOutput: decodeCredentialProfileSetRoutingModeResult,
  }),
  'credential.profile.query': defineOperation<
    CredentialProfileQueryInput,
    CredentialProfileQueryResult,
    (typeof CREDENTIAL_QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: CREDENTIAL_QUERY_ERRORS,
    decodeInput: decodeCredentialProfileQueryInput,
    decodeOutput: decodeCredentialProfileQueryResult,
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

// A single profile on an enabled_model_id item. The host emits values the
// canonical store already validated, so this sanitizes (drops the unusable)
// rather than re-running the strict table decoder — which would demand an
// enabledModelIds argument the item does not carry.
function decodeRelayProfile(value: unknown): RelayModelProfile {
  const sanitized = normalizeRelayModelProfiles({ m: value })?.m;
  if (sanitized === undefined) {
    throw invalidProtocolFrame('Invalid enabled model id relay profile');
  }
  return sanitized;
}

function catalogPageItem(value: unknown): ConnectionCatalogPageItem {
  const item = requireRecord(value, 'connection catalog page item');
  if (item.kind === 'enabled_model_id') {
    // Exact-on-the-required-four, relayProfile optional: most models declare
    // nothing, and requireExactRecord would make the key mandatory.
    const enabled = requireShapedRecord(
      item,
      'enabled model id item',
      ['kind', 'connectionIndex', 'itemIndex', 'modelId'],
      ['relayProfile'],
    );
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
      ...(enabled.relayProfile === undefined
        ? {}
        : { relayProfile: decodeDomain(() => decodeRelayProfile(enabled.relayProfile)) }),
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
      'requestBodyOverlay',
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
  const requestBodyOverlay =
    header.requestBodyOverlay === undefined
      ? undefined
      : decodeDomain(() => normalizeOptionalRequestBodyOverlay(header.requestBodyOverlay));
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
    ...(requestBodyOverlay === undefined ? {} : { requestBodyOverlay }),
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
  const maxBytes =
    input.locator.scope === 'connection' && input.locator.kind === 'request_headers'
      ? REQUEST_HEADERS_MAX_BYTES
      : CREDENTIAL_SECRET_MAX_BYTES;
  if (Buffer.byteLength(input.secret, 'utf8') > maxBytes) {
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

function decodeConnectionRequestHeadersQueryInput(
  value: unknown,
): ConnectionRequestHeadersQueryInput {
  const input = requireExactRecord(value, 'connection request headers query input', [
    'connectionId',
  ]);
  return {
    connectionId: decodeDomain(() => decodeRuntimePolicyEntityId(input.connectionId)),
  };
}

function decodeConnectionRequestHeadersQueryResult(
  value: unknown,
): ConnectionRequestHeadersQueryResult {
  const result = requireRecord(value, 'connection request headers query result');
  if (result.kind === 'connection_not_found') {
    requireExactRecord(result, 'connection request headers connection not found result', ['kind']);
    return { kind: 'connection_not_found' };
  }
  const found = requireExactRecord(result, 'connection request headers found result', [
    'kind',
    'names',
  ]);
  if (found.kind !== 'found') {
    throw invalidProtocolFrame('Invalid connection request headers query result');
  }
  return { kind: 'found', names: decodeRequestHeaderNames(found.names) };
}

function decodeConnectionRequestHeadersReplaceInput(
  value: unknown,
): ConnectionRequestHeadersReplaceInput {
  const input = requireExactRecord(value, 'connection request headers replace input', [
    'connectionId',
    'headers',
  ]);
  return {
    connectionId: decodeDomain(() => decodeRuntimePolicyEntityId(input.connectionId)),
    headers: decodeRequestHeaderUpdates(input.headers),
  };
}

function decodeConnectionRequestHeadersReplaceResult(
  value: unknown,
): ConnectionRequestHeadersReplaceResult {
  const result = requireRecord(value, 'connection request headers replace result');
  if (result.kind === 'connection_not_found') {
    requireExactRecord(result, 'connection request headers connection not found result', ['kind']);
    return { kind: 'connection_not_found' };
  }
  const saved = requireExactRecord(result, 'connection request headers saved result', [
    'kind',
    'names',
  ]);
  if (saved.kind !== 'committed' && saved.kind !== 'unchanged') {
    throw invalidProtocolFrame('Invalid connection request headers replace result');
  }
  return { kind: saved.kind, names: decodeRequestHeaderNames(saved.names) };
}

function decodeRequestHeaderNames(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw invalidProtocolFrame('Invalid request header names');
  return decodeRequestHeaderUpdates(value.map((name) => ({ name }))).map(({ name }) => name);
}

function decodeRequestHeaderUpdates(value: unknown): readonly RequestHeaderUpdate[] {
  try {
    return normalizeRequestHeaderUpdates(value);
  } catch (error) {
    if (error instanceof RequestCustomizationValidationError) {
      throw invalidProtocolFrame(error.message);
    }
    throw error;
  }
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

function decodeCredentialProfileCreateInput(value: unknown): CreateCredentialProfileInput {
  return decodeDomain(() => normalizeCreateCredentialProfileInput(value));
}

function decodeCredentialProfileUpdateInput(value: unknown): UpdateCredentialProfileInput {
  return decodeDomain(() => normalizeUpdateCredentialProfileInput(value));
}

function decodeCredentialProfileSetEnabledInput(value: unknown): SetCredentialProfileEnabledInput {
  return decodeDomain(() => normalizeSetCredentialProfileEnabledInput(value));
}

function decodeCredentialProfileRemoveInput(value: unknown): RemoveCredentialProfileInput {
  return decodeDomain(() => normalizeRemoveCredentialProfileInput(value));
}

function decodeCredentialProfileSetRoutingModeInput(value: unknown): SetCredentialRoutingModeInput {
  return decodeDomain(() => normalizeSetCredentialRoutingModeInput(value));
}

function decodeCredentialProfileCreateResult(value: unknown): CreateCredentialProfileResult {
  const item = requireRecord(value, 'credential profile create result');
  if (item.kind === 'committed') return credentialProfileCommitted(item);
  if (item.kind === 'connection_not_found') {
    requireExactRecord(item, 'credential profile connection not found result', ['kind']);
    return { kind: 'connection_not_found' };
  }
  if (item.kind === 'connection_stale') return connectionStale(item);
  if (item.kind === 'profile_label_conflict') {
    const conflict = requireExactRecord(item, 'credential profile label conflict', [
      'kind',
      'label',
    ]);
    if (conflict.kind !== 'profile_label_conflict') {
      throw invalidProtocolFrame('Invalid credential profile label conflict');
    }
    return { kind: 'profile_label_conflict', label: stringValue(conflict.label, 'profile label') };
  }
  if (item.kind === 'capacity_limit') {
    const conflict = requireExactRecord(item, 'credential profile capacity limit', ['kind', 'max']);
    if (conflict.kind !== 'capacity_limit') {
      throw invalidProtocolFrame('Invalid credential profile capacity limit');
    }
    return { kind: 'capacity_limit', max: integer(conflict.max, 'capacity max', 0, 4096) };
  }
  if (item.kind === 'auth_not_supported') {
    const conflict = requireExactRecord(item, 'credential profile auth not supported', [
      'kind',
      'providerType',
    ]);
    if (conflict.kind !== 'auth_not_supported') {
      throw invalidProtocolFrame('Invalid credential profile auth not supported');
    }
    return {
      kind: 'auth_not_supported',
      providerType: stringValue(conflict.providerType, 'provider type'),
    };
  }
  throw invalidProtocolFrame('Invalid credential profile create result');
}

function decodeCredentialProfileUpdateResult(value: unknown): UpdateCredentialProfileResult {
  const item = requireRecord(value, 'credential profile update result');
  if (item.kind === 'committed') return credentialProfileCommitted(item);
  if (item.kind === 'connection_stale') return connectionStale(item);
  if (item.kind === 'profile_not_found') return profileNotFound(item);
  if (item.kind === 'profile_stale') return profileStale(item);
  if (item.kind === 'profile_label_conflict') {
    const conflict = requireExactRecord(item, 'credential profile label conflict', [
      'kind',
      'label',
    ]);
    if (conflict.kind !== 'profile_label_conflict') {
      throw invalidProtocolFrame('Invalid credential profile label conflict');
    }
    return { kind: 'profile_label_conflict', label: stringValue(conflict.label, 'profile label') };
  }
  throw invalidProtocolFrame('Invalid credential profile update result');
}

function decodeCredentialProfileSetEnabledResult(
  value: unknown,
): SetCredentialProfileEnabledResult {
  const item = requireRecord(value, 'credential profile set enabled result');
  if (item.kind === 'committed') return credentialProfileCommitted(item);
  if (item.kind === 'connection_stale') return connectionStale(item);
  if (item.kind === 'profile_not_found') return profileNotFound(item);
  if (item.kind === 'profile_stale') return profileStale(item);
  throw invalidProtocolFrame('Invalid credential profile set enabled result');
}

function decodeCredentialProfileRemoveResult(value: unknown): RemoveCredentialProfileResult {
  const item = requireRecord(value, 'credential profile remove result');
  if (item.kind === 'committed') return credentialProfileCommitted(item);
  if (item.kind === 'connection_stale') return connectionStale(item);
  if (item.kind === 'profile_not_found') return profileNotFound(item);
  if (item.kind === 'profile_stale') return profileStale(item);
  if (item.kind === 'primary_not_removable') {
    requireExactRecord(item, 'credential profile primary not removable result', ['kind']);
    return { kind: 'primary_not_removable' };
  }
  throw invalidProtocolFrame('Invalid credential profile remove result');
}

function decodeCredentialProfileSetRoutingModeResult(
  value: unknown,
): SetCredentialRoutingModeResult {
  const item = requireRecord(value, 'credential profile set routing mode result');
  if (item.kind === 'committed') return credentialProfileCommitted(item);
  if (item.kind === 'connection_stale') return connectionStale(item);
  if (item.kind === 'auth_not_supported') {
    const conflict = requireExactRecord(item, 'credential profile auth not supported', [
      'kind',
      'providerType',
    ]);
    if (conflict.kind !== 'auth_not_supported') {
      throw invalidProtocolFrame('Invalid credential profile auth not supported');
    }
    return {
      kind: 'auth_not_supported',
      providerType: stringValue(conflict.providerType, 'provider type'),
    };
  }
  if (item.kind === 'balanced_activation_rejected') {
    const conflict = requireExactRecord(item, 'credential profile balanced activation rejected', [
      'kind',
      'reason',
    ]);
    if (conflict.kind !== 'balanced_activation_rejected') {
      throw invalidProtocolFrame('Invalid credential profile balanced activation rejected');
    }
    return {
      kind: 'balanced_activation_rejected',
      reason: stringValue(conflict.reason, 'activation rejection reason'),
    };
  }
  throw invalidProtocolFrame('Invalid credential profile set routing mode result');
}

function decodeCredentialProfileQueryInput(value: unknown): CredentialProfileQueryInput {
  const item = requireExactRecord(value, 'credential profile query input', ['connectionId']);
  return { connectionId: requireEntityId(item.connectionId, 'connectionId') };
}

function decodeCredentialProfileQueryResult(value: unknown): CredentialProfileQueryResult {
  const item = requireRecord(value, 'credential profile query result');
  if (item.kind === 'connection_not_found') {
    requireExactRecord(item, 'credential profile connection not found result', ['kind']);
    return { kind: 'connection_not_found' };
  }
  if (item.kind !== 'found') {
    throw invalidProtocolFrame('Invalid credential profile query result kind');
  }
  const found = requireExactRecord(item, 'credential profile found result', [
    'kind',
    'connectionId',
    'connectionRevision',
    'routingMode',
    'readyCandidateCount',
    'profiles',
  ]);
  if (found.kind !== 'found') throw invalidProtocolFrame('Invalid credential profile found result');
  if (
    found.routingMode !== 'legacy_primary' &&
    found.routingMode !== 'balanced'
  ) {
    throw invalidProtocolFrame('Invalid credential profile routing mode');
  }
  if (
    !Array.isArray(found.profiles) ||
    found.profiles.length > CONNECTION_CREDENTIAL_PROFILE_MAX
  ) {
    throw invalidProtocolFrame('Invalid credential profile readiness profiles');
  }
  return {
    kind: 'found',
    connectionId: requireEntityId(found.connectionId, 'connectionId'),
    connectionRevision: revision(found.connectionRevision, 'connection revision'),
    routingMode: found.routingMode,
    readyCandidateCount: integer(
      found.readyCandidateCount,
      'ready candidate count',
      0,
      CONNECTION_CATALOG_MAX_ENABLED_MODEL_IDS,
    ),
    profiles: found.profiles.map(decodeCredentialProfileReadinessItem),
  };
}

function decodeCredentialProfileReadinessItem(value: unknown): CredentialProfileReadinessItem {
  const item = requireExactRecord(value, 'credential profile readiness item', [
    'profileId',
    'revision',
    'label',
    'enabled',
    'weight',
    'primary',
    'credentialConfigured',
    'lastTest',
    'supportedModels',
    'circuit',
  ]);
  if (
    typeof item.enabled !== 'boolean' ||
    typeof item.primary !== 'boolean' ||
    typeof item.credentialConfigured !== 'boolean'
  ) {
    throw invalidProtocolFrame('Invalid credential profile readiness flags');
  }
  const label = stringValue(item.label, 'profile label');
  if (label.length > CONNECTION_CREDENTIAL_PROFILE_LABEL_MAX_LENGTH) {
    throw invalidProtocolFrame('Invalid credential profile readiness label length');
  }
  const weight = integer(
    item.weight,
    'profile weight',
    CONNECTION_CREDENTIAL_PROFILE_WEIGHT_MIN,
    CONNECTION_CREDENTIAL_PROFILE_WEIGHT_MAX,
  );
  if (!Array.isArray(item.supportedModels)) {
    throw invalidProtocolFrame('Invalid credential profile supported models');
  }
  if (item.supportedModels.length > CONNECTION_CATALOG_MAX_ENABLED_MODEL_IDS) {
    throw invalidProtocolFrame('Invalid credential profile supported model count');
  }
  const supportedModels = item.supportedModels.map((modelId) =>
    decodeDomain(() => decodeConnectionModelId(modelId)),
  );
  if (new Set(supportedModels).size !== supportedModels.length) {
    throw invalidProtocolFrame('Duplicate credential profile supported model');
  }
  return {
    profileId: requireEntityId(item.profileId, 'profileId'),
    revision: revision(item.revision, 'profile revision'),
    label,
    enabled: item.enabled,
    weight,
    primary: item.primary,
    credentialConfigured: item.credentialConfigured,
    lastTest: item.lastTest === null ? null : decodeCredentialProfileLastTest(item.lastTest),
    supportedModels,
    circuit: item.circuit === null ? null : decodeCredentialProfileCircuit(item.circuit),
  };
}

function decodeCredentialProfileLastTest(
  value: unknown,
): NonNullable<CredentialProfileReadinessItem['lastTest']> {
  return decodeDomain(() => decodeConnectionTestSummary(value));
}

function decodeCredentialProfileCircuit(
  value: unknown,
): NonNullable<CredentialProfileReadinessItem['circuit']> {
  const item = requireExactRecord(value, 'credential profile circuit', [
    'state',
    'blockedUntil',
    'nextProbeAt',
  ]);
  if (
    item.state !== 'closed' &&
    item.state !== 'open' &&
    item.state !== 'half_open' &&
    item.state !== 'invalid'
  ) {
    throw invalidProtocolFrame('Invalid credential profile circuit state');
  }
  return {
    state: item.state,
    blockedUntil: item.blockedUntil === null ? null : requireCount(item.blockedUntil, 'blocked until'),
    nextProbeAt: item.nextProbeAt === null ? null : requireCount(item.nextProbeAt, 'next probe at'),
  };
}

function credentialProfileCommitted(value: unknown): CredentialProfileCommitted {
  const item = requireExactRecord(value, 'credential profile committed result', [
    'kind',
    'catalogRevision',
    'connection',
  ]);
  if (item.kind !== 'committed') {
    throw invalidProtocolFrame('Invalid credential profile committed result');
  }
  return {
    kind: 'committed',
    catalogRevision: revision(item.catalogRevision, 'catalog revision'),
    connection: decodeDomain(() => decodeConnectionVersionBasis(item.connection)),
  };
}

function profileNotFound(value: unknown): { readonly kind: 'profile_not_found' } {
  requireExactRecord(value, 'profile not found result', ['kind']);
  return { kind: 'profile_not_found' };
}

function profileStale(value: unknown): ProfileStale {
  const item = requireExactRecord(value, 'profile stale conflict', ['kind', 'expected', 'actual']);
  if (item.kind !== 'profile_stale') throw invalidProtocolFrame('Invalid profile conflict');
  return {
    kind: 'profile_stale',
    expected: decodeDomain(() => decodeCredentialProfileVersionBasis(item.expected)),
    actual:
      item.actual === null
        ? null
        : decodeDomain(() => decodeCredentialProfileVersionBasis(item.actual)),
  };
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}
