import {
  isCanonicalExtensionId,
  isCanonicalExtensionScopeId,
} from '@maka/runtime/extension-lifecycle-kernel';
import {
  requireEncodedByteLimit,
  requireEntityId,
  requireExactRecord,
  requireRecord,
  requireUtf8String,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineHostPathOperation, defineOperation } from './operation-spec.js';

export const EXTENSION_CATALOG_MAX_REVISIONS = 256;
export const EXTENSION_CATALOG_MAX_BINDINGS = 256;
export const EXTENSION_CATALOG_RESULT_MAX_BYTES = 96 * 1024;
export const EXTENSION_REVISION_MAX_BYTES = 128;
export const EXTENSION_ERROR_MAX_BYTES = 4 * 1024;

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'persistence_failed',
  'internal_failure',
] as const;
const MUTATION_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'not_found',
  'operation_conflict',
  'invalid_request',
  'persistence_failed',
  'commit_outcome_unknown',
  'internal_failure',
] as const;

export interface TrustedExtensionRevisionProjection {
  readonly extensionId: string;
  readonly revision: string;
  readonly toolNames: readonly string[];
  readonly uiContributionIds: readonly string[];
}

export type ExtensionBindingStatus = 'disabled' | 'active' | 'waiting' | 'failed';

export interface ExtensionBindingProjection {
  readonly bindingId: string;
  readonly scopeId: string;
  readonly extensionId: string;
  readonly desiredRevision: string;
  readonly lastGoodRevision: string | null;
  readonly enabled: boolean;
  readonly status: ExtensionBindingStatus;
  readonly error: string | null;
}

export interface ExtensionCatalogQueryInput {}

export interface ExtensionCatalogQueryResult {
  readonly revisions: readonly TrustedExtensionRevisionProjection[];
  readonly bindings: readonly ExtensionBindingProjection[];
}

export interface ExtensionUiSnapshotInput {
  readonly scopeId: string;
}

export interface ExtensionUiContributionProjection {
  readonly bindingId: string;
  readonly extensionId: string;
  readonly revision: string;
  readonly id: string;
  readonly surface: 'app.root' | 'app.overlay';
  readonly priority: number;
  readonly document: string;
  readonly documentSha256: string;
  readonly network: boolean;
  readonly hostState?: boolean;
  readonly hostMethods?: readonly string[];
  readonly sessionAccess?: boolean;
}

export interface ExtensionUiSnapshotResult {
  readonly scopeId: string;
  readonly digest: string;
  readonly contributions: readonly ExtensionUiContributionProjection[];
}

export type ExtensionUiStateValue =
  | null
  | boolean
  | number
  | string
  | readonly ExtensionUiStateValue[]
  | { readonly [key: string]: ExtensionUiStateValue };

export interface ExtensionUiStateQueryInput {
  readonly scopeId: string;
  readonly bindingId: string;
  readonly extensionId: string;
  readonly revision: string;
  readonly key: string;
}

export interface ExtensionUiStateQueryResult {
  readonly found: boolean;
  readonly value: ExtensionUiStateValue | null;
}

export type ExtensionUiStateMutateInput = ExtensionUiStateQueryInput &
  ({ readonly kind: 'set'; readonly value: ExtensionUiStateValue } | { readonly kind: 'delete' });

export interface ExtensionUiStateMutateResult {
  readonly changed: boolean;
}

export interface ExtensionUiRpcInvokeInput {
  readonly scopeId: string;
  readonly bindingId: string;
  readonly extensionId: string;
  readonly revision: string;
  readonly method: string;
  readonly args: ExtensionUiStateValue;
}

export interface ExtensionUiRpcInvokeResult {
  readonly value: ExtensionUiStateValue;
}

export type ExtensionCatalogMutateInput =
  | {
      readonly kind: 'enable';
      readonly bindingId: string;
      readonly scopeId: string;
      readonly extensionId: string;
      readonly revision: string;
    }
  | { readonly kind: 'disable'; readonly bindingId: string }
  | { readonly kind: 'update'; readonly bindingId: string; readonly revision: string }
  | { readonly kind: 'remove'; readonly bindingId: string };

export interface ExtensionCatalogMutateResult {
  readonly binding: ExtensionBindingProjection | null;
}

export interface ToolPackageInstallInput {
  readonly sourcePath: string;
}

export type ToolPackageInstallResult = TrustedExtensionRevisionProjection;

export interface ToolPackageUninstallInput {
  readonly extensionId: string;
  readonly revision: string;
}

export interface ToolPackageUninstallResult {}

export const EXTENSION_OPERATION_SPECS = {
  'extension.catalog.query': defineOperation<
    ExtensionCatalogQueryInput,
    ExtensionCatalogQueryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeExtensionCatalogQueryInput,
    decodeOutput: decodeExtensionCatalogQueryResult,
  }),
  'extension.catalog.mutate': defineOperation<
    ExtensionCatalogMutateInput,
    ExtensionCatalogMutateResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeExtensionCatalogMutateInput,
    decodeOutput: decodeExtensionCatalogMutateResult,
  }),
  'extension.ui.snapshot': defineOperation<
    ExtensionUiSnapshotInput,
    ExtensionUiSnapshotResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeExtensionUiSnapshotInput,
    decodeOutput: decodeExtensionUiSnapshotResult,
  }),
  'extension.ui.state.query': defineOperation<
    ExtensionUiStateQueryInput,
    ExtensionUiStateQueryResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeExtensionUiStateQueryInput,
    decodeOutput: decodeExtensionUiStateQueryResult,
  }),
  'extension.ui.state.mutate': defineOperation<
    ExtensionUiStateMutateInput,
    ExtensionUiStateMutateResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeExtensionUiStateMutateInput,
    decodeOutput: decodeExtensionUiStateMutateResult,
  }),
  'extension.ui.rpc.invoke': defineOperation<
    ExtensionUiRpcInvokeInput,
    ExtensionUiRpcInvokeResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeExtensionUiRpcInvokeInput,
    decodeOutput: decodeExtensionUiRpcInvokeResult,
  }),
  'extension.package.install': defineHostPathOperation<
    ToolPackageInstallInput,
    ToolPackageInstallResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeToolPackageInstallInput,
    decodeOutput: decodeToolPackageInstallResult,
  }),
  'extension.package.uninstall': defineOperation<
    ToolPackageUninstallInput,
    ToolPackageUninstallResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeToolPackageUninstallInput,
    decodeOutput: decodeToolPackageUninstallResult,
  }),
} as const;

export function decodeExtensionCatalogQueryInput(value: unknown): ExtensionCatalogQueryInput {
  requireExactRecord(value, 'extension catalog query input', []);
  return {};
}

export function decodeExtensionUiSnapshotInput(value: unknown): ExtensionUiSnapshotInput {
  const input = requireExactRecord(value, 'extension UI snapshot input', ['scopeId']);
  return { scopeId: decodeExtensionScopeId(input.scopeId, 'extension UI scopeId') };
}

export function decodeExtensionUiSnapshotResult(value: unknown): ExtensionUiSnapshotResult {
  const result = requireExactRecord(value, 'extension UI snapshot result', [
    'scopeId',
    'digest',
    'contributions',
  ]);
  if (!Array.isArray(result.contributions) || result.contributions.length > 64) {
    throw invalidProtocolFrame('Invalid extension UI contributions');
  }
  const decoded = {
    scopeId: decodeExtensionScopeId(result.scopeId, 'extension UI scopeId'),
    digest: requireUtf8String(result.digest, 'extension UI digest', 128),
    contributions: result.contributions.map(decodeUiContributionProjection),
  };
  requireEncodedByteLimit(decoded, 'extension UI snapshot result', 2 * 1024 * 1024);
  return decoded;
}

export function decodeExtensionUiStateQueryInput(value: unknown): ExtensionUiStateQueryInput {
  const input = requireExactRecord(value, 'extension UI state query input', [
    'scopeId',
    'bindingId',
    'extensionId',
    'revision',
    'key',
  ]);
  return decodeUiStateIdentity(input);
}

export function decodeExtensionUiStateQueryResult(value: unknown): ExtensionUiStateQueryResult {
  const result = requireExactRecord(value, 'extension UI state query result', ['found', 'value']);
  const decoded = {
    found: decodeBoolean(result.found, 'extension UI state found'),
    value: decodeUiStateValue(result.value),
  };
  requireEncodedByteLimit(decoded, 'extension UI state query result', 72 * 1024);
  return decoded;
}

export function decodeExtensionUiStateMutateInput(value: unknown): ExtensionUiStateMutateInput {
  const record = requireRecord(value, 'extension UI state mutation input');
  if (record.kind === 'set') {
    const input = requireExactRecord(record, 'extension UI state set input', [
      'scopeId',
      'bindingId',
      'extensionId',
      'revision',
      'key',
      'kind',
      'value',
    ]);
    const decoded = {
      ...decodeUiStateIdentity(input),
      kind: 'set' as const,
      value: decodeUiStateValue(input.value),
    };
    requireEncodedByteLimit(decoded, 'extension UI state mutation input', 72 * 1024);
    return decoded;
  }
  if (record.kind === 'delete') {
    const input = requireExactRecord(record, 'extension UI state delete input', [
      'scopeId',
      'bindingId',
      'extensionId',
      'revision',
      'key',
      'kind',
    ]);
    return { ...decodeUiStateIdentity(input), kind: 'delete' };
  }
  throw invalidProtocolFrame('Invalid extension UI state mutation kind');
}

export function decodeExtensionUiStateMutateResult(value: unknown): ExtensionUiStateMutateResult {
  const result = requireExactRecord(value, 'extension UI state mutation result', ['changed']);
  return { changed: decodeBoolean(result.changed, 'extension UI state changed') };
}

export function decodeExtensionUiRpcInvokeInput(value: unknown): ExtensionUiRpcInvokeInput {
  const input = requireExactRecord(value, 'extension UI RPC invoke input', [
    'scopeId',
    'bindingId',
    'extensionId',
    'revision',
    'method',
    'args',
  ]);
  const decoded = {
    scopeId: decodeExtensionScopeId(input.scopeId, 'extension UI scopeId'),
    bindingId: requireEntityId(input.bindingId, 'extension bindingId'),
    extensionId: decodeExtensionId(input.extensionId),
    revision: decodeRevision(input.revision),
    method: requireUtf8String(input.method, 'extension UI RPC method', 128),
    args: decodeUiStateValue(input.args),
  };
  requireEncodedByteLimit(decoded, 'extension UI RPC invoke input', 512 * 1024);
  return decoded;
}

export function decodeExtensionUiRpcInvokeResult(value: unknown): ExtensionUiRpcInvokeResult {
  const result = requireExactRecord(value, 'extension UI RPC invoke result', ['value']);
  const decoded = { value: decodeUiStateValue(result.value) };
  requireEncodedByteLimit(decoded, 'extension UI RPC invoke result', 1024 * 1024);
  return decoded;
}

export function decodeExtensionCatalogQueryResult(value: unknown): ExtensionCatalogQueryResult {
  const result = requireExactRecord(value, 'extension catalog query result', [
    'revisions',
    'bindings',
  ]);
  if (
    !Array.isArray(result.revisions) ||
    result.revisions.length > EXTENSION_CATALOG_MAX_REVISIONS ||
    !Array.isArray(result.bindings) ||
    result.bindings.length > EXTENSION_CATALOG_MAX_BINDINGS
  ) {
    throw invalidProtocolFrame('Invalid extension catalog result');
  }
  const decoded = {
    revisions: result.revisions.map(decodeRevisionProjection),
    bindings: result.bindings.map(decodeBindingProjection),
  };
  requireEncodedByteLimit(decoded, 'extension catalog result', EXTENSION_CATALOG_RESULT_MAX_BYTES);
  return decoded;
}

export function decodeExtensionCatalogMutateInput(value: unknown): ExtensionCatalogMutateInput {
  const record = requireRecord(value, 'extension catalog mutation input');
  switch (record.kind) {
    case 'enable': {
      const input = requireExactRecord(record, 'extension enable input', [
        'kind',
        'bindingId',
        'scopeId',
        'extensionId',
        'revision',
      ]);
      return {
        kind: 'enable',
        bindingId: requireEntityId(input.bindingId, 'extension bindingId'),
        scopeId: decodeExtensionScopeId(input.scopeId, 'extension scopeId'),
        extensionId: decodeExtensionId(input.extensionId),
        revision: decodeRevision(input.revision),
      };
    }
    case 'disable':
    case 'remove': {
      const input = requireExactRecord(record, `extension ${record.kind} input`, [
        'kind',
        'bindingId',
      ]);
      return {
        kind: record.kind,
        bindingId: requireEntityId(input.bindingId, 'extension bindingId'),
      };
    }
    case 'update': {
      const input = requireExactRecord(record, 'extension update input', [
        'kind',
        'bindingId',
        'revision',
      ]);
      return {
        kind: 'update',
        bindingId: requireEntityId(input.bindingId, 'extension bindingId'),
        revision: decodeRevision(input.revision),
      };
    }
    default:
      throw invalidProtocolFrame('Invalid extension catalog mutation kind');
  }
}

export function decodeExtensionCatalogMutateResult(value: unknown): ExtensionCatalogMutateResult {
  const result = requireExactRecord(value, 'extension catalog mutation result', ['binding']);
  return {
    binding: result.binding === null ? null : decodeBindingProjection(result.binding),
  };
}

export function decodeToolPackageInstallInput(value: unknown): ToolPackageInstallInput {
  const input = requireExactRecord(value, 'Tool package install input', ['sourcePath']);
  return { sourcePath: requireUtf8String(input.sourcePath, 'Tool package sourcePath', 16 * 1024) };
}

export function decodeToolPackageInstallResult(value: unknown): ToolPackageInstallResult {
  return decodeRevisionProjection(value);
}

export function decodeToolPackageUninstallInput(value: unknown): ToolPackageUninstallInput {
  const input = requireExactRecord(value, 'Tool package uninstall input', [
    'extensionId',
    'revision',
  ]);
  return {
    extensionId: decodeExtensionId(input.extensionId),
    revision: decodeRevision(input.revision),
  };
}

export function decodeToolPackageUninstallResult(value: unknown): ToolPackageUninstallResult {
  requireExactRecord(value, 'Tool package uninstall result', []);
  return {};
}

function decodeRevisionProjection(value: unknown): TrustedExtensionRevisionProjection {
  const revision = requireExactRecord(value, 'trusted extension revision', [
    'extensionId',
    'revision',
    'toolNames',
    'uiContributionIds',
  ]);
  if (
    !Array.isArray(revision.toolNames) ||
    revision.toolNames.length > 128 ||
    !Array.isArray(revision.uiContributionIds) ||
    revision.uiContributionIds.length > 64
  ) {
    throw invalidProtocolFrame('Invalid trusted extension contribution names');
  }
  return {
    extensionId: decodeExtensionId(revision.extensionId),
    revision: decodeRevision(revision.revision),
    toolNames: revision.toolNames.map((name) =>
      requireUtf8String(name, 'extension tool name', 128),
    ),
    uiContributionIds: revision.uiContributionIds.map((id) =>
      requireUtf8String(id, 'extension UI contribution id', 128),
    ),
  };
}

function decodeUiContributionProjection(value: unknown): ExtensionUiContributionProjection {
  const candidate = value as Record<string, unknown> | null;
  const fields = [
    'bindingId',
    'extensionId',
    'revision',
    'id',
    'surface',
    'priority',
    'document',
    'documentSha256',
    'network',
    ...(candidate && Object.hasOwn(candidate, 'hostState') ? ['hostState'] : []),
    ...(candidate && Object.hasOwn(candidate, 'hostMethods') ? ['hostMethods'] : []),
    ...(candidate && Object.hasOwn(candidate, 'sessionAccess') ? ['sessionAccess'] : []),
  ];
  const item = requireExactRecord(value, 'extension UI contribution', fields);
  if (item.surface !== 'app.root' && item.surface !== 'app.overlay') {
    throw invalidProtocolFrame('Invalid extension UI surface');
  }
  if (!Number.isSafeInteger(item.priority) || Math.abs(item.priority as number) > 10_000) {
    throw invalidProtocolFrame('Invalid extension UI priority');
  }
  if (
    item.hostMethods !== undefined &&
    (!Array.isArray(item.hostMethods) || item.hostMethods.length > 64)
  ) {
    throw invalidProtocolFrame('Invalid extension UI Host methods');
  }
  return {
    bindingId: requireEntityId(item.bindingId, 'extension bindingId'),
    extensionId: decodeExtensionId(item.extensionId),
    revision: decodeRevision(item.revision),
    id: requireUtf8String(item.id, 'extension UI contribution id', 128),
    surface: item.surface,
    priority: item.priority as number,
    document: requireUtf8String(item.document, 'extension UI document', 1024 * 1024),
    documentSha256: requireUtf8String(item.documentSha256, 'extension UI document digest', 128),
    network: decodeBoolean(item.network, 'extension UI network capability'),
    ...(item.hostState === undefined
      ? {}
      : { hostState: decodeBoolean(item.hostState, 'extension UI Host state capability') }),
    ...(item.hostMethods === undefined
      ? {}
      : {
          hostMethods: (item.hostMethods as unknown[]).map((method) =>
            requireUtf8String(method, 'extension UI Host method', 128),
          ),
        }),
    ...(item.sessionAccess === undefined
      ? {}
      : {
          sessionAccess: decodeBoolean(
            item.sessionAccess,
            'extension UI Session access capability',
          ),
        }),
  };
}

function decodeUiStateIdentity(input: Record<string, unknown>): ExtensionUiStateQueryInput {
  return {
    scopeId: decodeExtensionScopeId(input.scopeId, 'extension UI scopeId'),
    bindingId: requireEntityId(input.bindingId, 'extension bindingId'),
    extensionId: decodeExtensionId(input.extensionId),
    revision: decodeRevision(input.revision),
    key: requireUtf8String(input.key, 'extension UI state key', 128),
  };
}

function decodeUiStateValue(value: unknown, depth = 0): ExtensionUiStateValue {
  if (depth > 16) throw invalidProtocolFrame('Extension UI state value is too deeply nested');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => decodeUiStateValue(item, depth + 1));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length > 256)
      throw invalidProtocolFrame('Extension UI state object is too large');
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [
        requireUtf8String(key, 'extension UI state object key', 128),
        decodeUiStateValue(item, depth + 1),
      ]),
    );
  }
  throw invalidProtocolFrame('Invalid extension UI state value');
}

function decodeBindingProjection(value: unknown): ExtensionBindingProjection {
  const binding = requireExactRecord(value, 'extension binding', [
    'bindingId',
    'scopeId',
    'extensionId',
    'desiredRevision',
    'lastGoodRevision',
    'enabled',
    'status',
    'error',
  ]);
  return {
    bindingId: requireEntityId(binding.bindingId, 'extension bindingId'),
    scopeId: decodeExtensionScopeId(binding.scopeId, 'extension scopeId'),
    extensionId: decodeExtensionId(binding.extensionId),
    desiredRevision: decodeRevision(binding.desiredRevision),
    lastGoodRevision:
      binding.lastGoodRevision === null ? null : decodeRevision(binding.lastGoodRevision),
    enabled: decodeBoolean(binding.enabled, 'extension enabled'),
    status: decodeBindingStatus(binding.status),
    error:
      binding.error === null
        ? null
        : requireUtf8String(binding.error, 'extension error', EXTENSION_ERROR_MAX_BYTES),
  };
}

function decodeRevision(value: unknown): string {
  const revision = requireUtf8String(value, 'extension revision', EXTENSION_REVISION_MAX_BYTES);
  if (/[\r\n]/u.test(revision)) throw invalidProtocolFrame('Invalid extension revision');
  return revision;
}

function decodeExtensionId(value: unknown): string {
  if (!isCanonicalExtensionId(value)) {
    throw invalidProtocolFrame('Invalid extension extensionId');
  }
  return value;
}

function decodeExtensionScopeId(value: unknown, label: string): string {
  if (!isCanonicalExtensionScopeId(value)) throw invalidProtocolFrame(`Invalid ${label}`);
  return value;
}

function decodeBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalidProtocolFrame(`Invalid ${label}`);
  return value;
}

function decodeBindingStatus(value: unknown): ExtensionBindingStatus {
  if (value !== 'disabled' && value !== 'active' && value !== 'waiting' && value !== 'failed') {
    throw invalidProtocolFrame('Invalid extension binding status');
  }
  return value;
}
