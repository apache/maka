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
export const EXTENSION_UI_OFFICIAL_SLOTS = Object.freeze([
  'sidebar.footer',
  'conversation.header',
  'settings.content',
] as const);

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
  readonly hookContributionIds: readonly string[];
  readonly eventContributionIds: readonly string[];
  readonly serviceContributionIds?: readonly string[];
  readonly timerContributionIds?: readonly string[];
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

export type ExtensionConfigurationScalar = string | number | boolean;

export interface ExtensionContractDependency {
  readonly id: string;
  readonly version: string;
}

export interface ExtensionContractConfigurationProperty {
  readonly type: 'string' | 'number' | 'boolean';
  readonly title?: string;
  readonly description?: string;
  readonly default?: ExtensionConfigurationScalar;
  readonly enum?: readonly ExtensionConfigurationScalar[];
  readonly secret: boolean;
}

export interface ExtensionContractContribution {
  readonly kind: 'tool' | 'ui' | 'hook' | 'event' | 'listener' | 'service' | 'timer';
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly surface?: 'app.root' | 'app.overlay' | 'app.slot';
  readonly slot?: string;
  readonly slots?: readonly string[];
  readonly event?: string;
  readonly mode?: 'emit' | 'parallel' | 'serial' | 'bail' | 'observe' | 'gate' | 'transform';
}

export interface ExtensionPackageContractProjection {
  readonly extensionId: string;
  readonly revision: string;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
  readonly dependencies: readonly ExtensionContractDependency[];
  readonly configuration: {
    readonly properties: Readonly<Record<string, ExtensionContractConfigurationProperty>>;
    readonly required: readonly string[];
  };
  readonly contributions: readonly ExtensionContractContribution[];
}

export interface ExtensionContractQueryInput {}

export interface ExtensionContractQueryResult {
  readonly packages: readonly ExtensionPackageContractProjection[];
}

export interface ExtensionConfigurationQueryInput {
  readonly bindingId: string;
}

export interface ExtensionConfigurationQueryResult {
  readonly configuration: Readonly<Record<string, ExtensionConfigurationScalar>>;
}

export interface ExtensionConfigurationMutateInput extends ExtensionConfigurationQueryInput {
  readonly configuration: Readonly<Record<string, ExtensionConfigurationScalar>>;
}

export type ExtensionConfigurationMutateResult = ExtensionConfigurationQueryResult;

export interface ExtensionUiSnapshotInput {
  readonly scopeId: string;
}

export interface ExtensionUiContributionProjection {
  readonly bindingId: string;
  readonly extensionId: string;
  readonly revision: string;
  readonly id: string;
  readonly surface: 'app.root' | 'app.overlay' | 'app.slot';
  readonly slot?: string;
  readonly slots?: readonly string[];
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

export interface ExtensionPackageExportInput {
  readonly extensionId: string;
  readonly revision: string;
  readonly targetPath: string;
}

export interface ExtensionPackageExportResult {
  readonly targetPath: string;
}

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
  'extension.contract.query': defineOperation<
    ExtensionContractQueryInput,
    ExtensionContractQueryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeExtensionContractQueryInput,
    decodeOutput: decodeExtensionContractQueryResult,
  }),
  'extension.configuration.query': defineOperation<
    ExtensionConfigurationQueryInput,
    ExtensionConfigurationQueryResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeExtensionConfigurationQueryInput,
    decodeOutput: decodeExtensionConfigurationQueryResult,
  }),
  'extension.configuration.mutate': defineOperation<
    ExtensionConfigurationMutateInput,
    ExtensionConfigurationMutateResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeExtensionConfigurationMutateInput,
    decodeOutput: decodeExtensionConfigurationQueryResult,
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
  'extension.package.export': defineHostPathOperation<
    ExtensionPackageExportInput,
    ExtensionPackageExportResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeExtensionPackageExportInput,
    decodeOutput: decodeExtensionPackageExportResult,
  }),
} as const;

export function decodeExtensionCatalogQueryInput(value: unknown): ExtensionCatalogQueryInput {
  requireExactRecord(value, 'extension catalog query input', []);
  return {};
}

export function decodeExtensionContractQueryInput(value: unknown): ExtensionContractQueryInput {
  requireExactRecord(value, 'extension contract query input', []);
  return {};
}

export function decodeExtensionContractQueryResult(value: unknown): ExtensionContractQueryResult {
  const result = requireExactRecord(value, 'extension contract query result', ['packages']);
  if (!Array.isArray(result.packages) || result.packages.length > EXTENSION_CATALOG_MAX_REVISIONS) {
    throw invalidProtocolFrame('Invalid extension contract packages');
  }
  const decoded = { packages: result.packages.map(decodePackageContract) };
  requireEncodedByteLimit(decoded, 'extension contract query result', 512 * 1024);
  return decoded;
}

export function decodeExtensionConfigurationQueryInput(
  value: unknown,
): ExtensionConfigurationQueryInput {
  const input = requireExactRecord(value, 'extension configuration query input', ['bindingId']);
  return { bindingId: requireEntityId(input.bindingId, 'extension bindingId') };
}

export function decodeExtensionConfigurationQueryResult(
  value: unknown,
): ExtensionConfigurationQueryResult {
  const result = requireExactRecord(value, 'extension configuration query result', [
    'configuration',
  ]);
  return { configuration: decodeConfigurationValues(result.configuration) };
}

export function decodeExtensionConfigurationMutateInput(
  value: unknown,
): ExtensionConfigurationMutateInput {
  const input = requireExactRecord(value, 'extension configuration mutation input', [
    'bindingId',
    'configuration',
  ]);
  return {
    bindingId: requireEntityId(input.bindingId, 'extension bindingId'),
    configuration: decodeConfigurationValues(input.configuration),
  };
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

export function decodeExtensionPackageExportInput(value: unknown): ExtensionPackageExportInput {
  const input = requireExactRecord(value, 'Extension package export input', [
    'extensionId',
    'revision',
    'targetPath',
  ]);
  return {
    extensionId: decodeExtensionId(input.extensionId),
    revision: decodeRevision(input.revision),
    targetPath: requireUtf8String(input.targetPath, 'Extension package targetPath', 16 * 1024),
  };
}

export function decodeExtensionPackageExportResult(value: unknown): ExtensionPackageExportResult {
  const result = requireExactRecord(value, 'Extension package export result', ['targetPath']);
  return {
    targetPath: requireUtf8String(result.targetPath, 'Extension package targetPath', 16 * 1024),
  };
}

function decodeRevisionProjection(value: unknown): TrustedExtensionRevisionProjection {
  const source = requireRecord(value, 'trusted extension revision');
  const revision = requireExactRecord(value, 'trusted extension revision', [
    'extensionId',
    'revision',
    'toolNames',
    'uiContributionIds',
    ...(Object.hasOwn(source, 'hookContributionIds') ? ['hookContributionIds'] : []),
    ...(Object.hasOwn(source, 'eventContributionIds') ? ['eventContributionIds'] : []),
    ...(Object.hasOwn(source, 'serviceContributionIds') ? ['serviceContributionIds'] : []),
    ...(Object.hasOwn(source, 'timerContributionIds') ? ['timerContributionIds'] : []),
  ]);
  const hookContributionIds = revision.hookContributionIds ?? [];
  const eventContributionIds = revision.eventContributionIds ?? [];
  const serviceContributionIds = revision.serviceContributionIds ?? [];
  const timerContributionIds = revision.timerContributionIds ?? [];
  if (
    !Array.isArray(revision.toolNames) ||
    revision.toolNames.length > 128 ||
    !Array.isArray(revision.uiContributionIds) ||
    revision.uiContributionIds.length > 64 ||
    !Array.isArray(hookContributionIds) ||
    hookContributionIds.length > 64 ||
    !Array.isArray(eventContributionIds) ||
    eventContributionIds.length > 128 ||
    !Array.isArray(serviceContributionIds) ||
    serviceContributionIds.length > 64 ||
    !Array.isArray(timerContributionIds) ||
    timerContributionIds.length > 64
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
    hookContributionIds: hookContributionIds.map((id) =>
      requireUtf8String(id, 'extension Hook contribution id', 256),
    ),
    eventContributionIds: eventContributionIds.map((id) =>
      requireUtf8String(id, 'extension Event contribution id', 512),
    ),
    ...(Object.hasOwn(source, 'serviceContributionIds')
      ? {
          serviceContributionIds: serviceContributionIds.map((id) =>
            requireUtf8String(id, 'extension Service contribution id', 192),
          ),
        }
      : {}),
    ...(Object.hasOwn(source, 'timerContributionIds')
      ? {
          timerContributionIds: timerContributionIds.map((id) =>
            requireUtf8String(id, 'extension Timer contribution id', 128),
          ),
        }
      : {}),
  };
}

function decodePackageContract(value: unknown): ExtensionPackageContractProjection {
  const contract = requireExactRecord(value, 'Extension package contract', [
    'extensionId',
    'revision',
    'version',
    'displayName',
    'description',
    'dependencies',
    'configuration',
    'contributions',
  ]);
  if (
    !Array.isArray(contract.dependencies) ||
    contract.dependencies.length > 64 ||
    !Array.isArray(contract.contributions) ||
    contract.contributions.length > 320
  )
    throw invalidProtocolFrame('Invalid Extension package contract collections');
  const configuration = requireExactRecord(
    contract.configuration,
    'Extension configuration contract',
    ['properties', 'required'],
  );
  const properties = requireRecord(configuration.properties, 'Extension configuration properties');
  if (Object.keys(properties).length > 128 || !Array.isArray(configuration.required)) {
    throw invalidProtocolFrame('Invalid Extension configuration contract');
  }
  const decodedProperties: Record<string, ExtensionContractConfigurationProperty> =
    Object.fromEntries(
      Object.entries(properties).map(([key, value]) => {
        const propertySource = requireRecord(value, 'Extension configuration property');
        const fields = [
          'type',
          'secret',
          ...(Object.hasOwn(propertySource, 'title') ? ['title'] : []),
          ...(Object.hasOwn(propertySource, 'description') ? ['description'] : []),
          ...(Object.hasOwn(propertySource, 'default') ? ['default'] : []),
          ...(Object.hasOwn(propertySource, 'enum') ? ['enum'] : []),
        ];
        const property = requireExactRecord(
          propertySource,
          'Extension configuration property',
          fields,
        );
        if (
          property.type !== 'string' &&
          property.type !== 'number' &&
          property.type !== 'boolean'
        ) {
          throw invalidProtocolFrame('Invalid Extension configuration property type');
        }
        const scalar = (candidate: unknown): ExtensionConfigurationScalar => {
          if (
            typeof candidate !== property.type ||
            (typeof candidate === 'number' && !Number.isFinite(candidate))
          )
            throw invalidProtocolFrame('Invalid Extension configuration property value');
          return candidate as ExtensionConfigurationScalar;
        };
        return [
          requireUtf8String(key, 'Extension configuration property key', 128),
          {
            type: property.type,
            ...(property.title === undefined
              ? {}
              : { title: requireUtf8String(property.title, 'Extension configuration title', 128) }),
            ...(property.description === undefined
              ? {}
              : {
                  description: requireUtf8String(
                    property.description,
                    'Extension configuration description',
                    1024,
                  ),
                }),
            ...(property.default === undefined ? {} : { default: scalar(property.default) }),
            ...(property.enum === undefined
              ? {}
              : {
                  enum:
                    Array.isArray(property.enum) && property.enum.length <= 64
                      ? property.enum.map(scalar)
                      : (() => {
                          throw invalidProtocolFrame('Invalid Extension configuration enum');
                        })(),
                }),
            secret: decodeBoolean(property.secret, 'Extension configuration secret'),
          } satisfies ExtensionContractConfigurationProperty,
        ];
      }),
    );
  const required = configuration.required.map((key) =>
    requireUtf8String(key, 'Extension required configuration key', 128),
  );
  return {
    extensionId: decodeExtensionId(contract.extensionId),
    revision: decodeRevision(contract.revision),
    version: requireUtf8String(contract.version, 'Extension package version', 128),
    displayName: requireUtf8String(contract.displayName, 'Extension package displayName', 128),
    description:
      typeof contract.description === 'string' &&
      Buffer.byteLength(contract.description, 'utf8') <= 4096
        ? contract.description
        : (() => {
            throw invalidProtocolFrame('Invalid Extension package description');
          })(),
    dependencies: contract.dependencies.map((value) => {
      const dependency = requireExactRecord(value, 'Extension dependency', ['id', 'version']);
      return {
        id: decodeExtensionId(dependency.id),
        version: requireUtf8String(dependency.version, 'Extension dependency version', 128),
      };
    }),
    configuration: { properties: decodedProperties, required },
    contributions: contract.contributions.map(decodeContractContribution),
  };
}

function decodeContractContribution(value: unknown): ExtensionContractContribution {
  const source = requireRecord(value, 'Extension contract contribution');
  const fields = [
    'kind',
    'id',
    ...(Object.hasOwn(source, 'name') ? ['name'] : []),
    ...(Object.hasOwn(source, 'description') ? ['description'] : []),
    ...(Object.hasOwn(source, 'surface') ? ['surface'] : []),
    ...(Object.hasOwn(source, 'slot') ? ['slot'] : []),
    ...(Object.hasOwn(source, 'slots') ? ['slots'] : []),
    ...(Object.hasOwn(source, 'event') ? ['event'] : []),
    ...(Object.hasOwn(source, 'mode') ? ['mode'] : []),
  ];
  const contribution = requireExactRecord(source, 'Extension contract contribution', fields);
  if (
    contribution.kind !== 'tool' &&
    contribution.kind !== 'ui' &&
    contribution.kind !== 'hook' &&
    contribution.kind !== 'event' &&
    contribution.kind !== 'listener' &&
    contribution.kind !== 'service' &&
    contribution.kind !== 'timer'
  ) {
    throw invalidProtocolFrame('Invalid Extension contract contribution kind');
  }
  const isHookEvent =
    contribution.event === 'UserPromptSubmit' ||
    contribution.event === 'RunStart' ||
    contribution.event === 'PreToolUse' ||
    contribution.event === 'PostToolUse' ||
    contribution.event === 'RunEnd';
  const isPluginEvent =
    typeof contribution.event === 'string' &&
    /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/u.test(contribution.event) &&
    Buffer.byteLength(contribution.event, 'utf8') <= 192;
  const hookMode =
    contribution.mode === 'observe' ||
    contribution.mode === 'gate' ||
    contribution.mode === 'transform';
  const eventMode =
    contribution.mode === 'emit' ||
    contribution.mode === 'parallel' ||
    contribution.mode === 'serial' ||
    contribution.mode === 'bail' ||
    hookMode;
  if (contribution.mode !== undefined && !eventMode)
    throw invalidProtocolFrame('Invalid Extension contract dispatch mode');
  if (
    (contribution.kind === 'hook' && (!isHookEvent || !hookMode)) ||
    (contribution.kind === 'event' &&
      (!isPluginEvent || (contribution.mode !== undefined && !eventMode))) ||
    (contribution.kind === 'listener' && (!isPluginEvent || contribution.mode !== undefined)) ||
    (contribution.kind !== 'hook' &&
      contribution.kind !== 'event' &&
      contribution.kind !== 'listener' &&
      (contribution.event !== undefined || contribution.mode !== undefined))
  ) {
    throw invalidProtocolFrame('Invalid Extension contract Hook fields');
  }
  if (
    contribution.surface !== undefined &&
    contribution.surface !== 'app.root' &&
    contribution.surface !== 'app.overlay' &&
    contribution.surface !== 'app.slot'
  )
    throw invalidProtocolFrame('Invalid Extension contract UI surface');
  if (
    contribution.slots !== undefined &&
    (!Array.isArray(contribution.slots) || contribution.slots.length > 32)
  ) {
    throw invalidProtocolFrame('Invalid Extension contract child slots');
  }
  return {
    kind: contribution.kind,
    id: requireUtf8String(contribution.id, 'Extension contribution id', 128),
    ...(contribution.name === undefined
      ? {}
      : { name: requireUtf8String(contribution.name, 'Extension Tool name', 128) }),
    ...(contribution.description === undefined
      ? {}
      : {
          description: requireUtf8String(
            contribution.description,
            'Extension Tool description',
            4096,
          ),
        }),
    ...(contribution.surface === undefined ? {} : { surface: contribution.surface }),
    ...(contribution.slot === undefined
      ? {}
      : { slot: requireUtf8String(contribution.slot, 'Extension UI slot', 128) }),
    ...(contribution.slots === undefined
      ? {}
      : {
          slots: contribution.slots.map((slot) =>
            requireUtf8String(slot, 'Extension UI child slot', 128),
          ),
        }),
    ...(contribution.event === undefined ? {} : { event: contribution.event as string }),
    ...(contribution.mode === undefined
      ? {}
      : { mode: contribution.mode as ExtensionContractContribution['mode'] }),
  };
}

function decodeConfigurationValues(
  value: unknown,
): Readonly<Record<string, ExtensionConfigurationScalar>> {
  const source = requireRecord(value, 'Extension configuration values');
  if (Object.keys(source).length > 128)
    throw invalidProtocolFrame('Too many Extension configuration values');
  const result: Record<string, ExtensionConfigurationScalar> = {};
  for (const [key, configured] of Object.entries(source)) {
    if (
      !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(key) ||
      (typeof configured !== 'string' &&
        typeof configured !== 'boolean' &&
        !(typeof configured === 'number' && Number.isFinite(configured)))
    )
      throw invalidProtocolFrame('Invalid Extension configuration value');
    result[key] = configured;
  }
  requireEncodedByteLimit(result, 'Extension configuration values', 64 * 1024);
  return result;
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
    ...(candidate && Object.hasOwn(candidate, 'slot') ? ['slot'] : []),
    ...(candidate && Object.hasOwn(candidate, 'slots') ? ['slots'] : []),
  ];
  const item = requireExactRecord(value, 'extension UI contribution', fields);
  if (
    item.surface !== 'app.root' &&
    item.surface !== 'app.overlay' &&
    item.surface !== 'app.slot'
  ) {
    throw invalidProtocolFrame('Invalid extension UI surface');
  }
  if (
    (item.surface === 'app.slot' &&
      (typeof item.slot !== 'string' ||
        !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(item.slot) ||
        Buffer.byteLength(item.slot, 'utf8') > 128)) ||
    (item.surface !== 'app.slot' && item.slot !== undefined)
  ) {
    throw invalidProtocolFrame('Invalid extension UI slot');
  }
  if (
    item.slots !== undefined &&
    (!Array.isArray(item.slots) ||
      item.slots.length > 32 ||
      item.slots.some(
        (slot) =>
          typeof slot !== 'string' ||
          !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(slot) ||
          Buffer.byteLength(slot, 'utf8') > 128,
      ) ||
      new Set(item.slots).size !== item.slots.length)
  ) {
    throw invalidProtocolFrame('Invalid extension UI child slots');
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
    ...(item.slot === undefined ? {} : { slot: item.slot as string }),
    ...(item.slots === undefined ? {} : { slots: item.slots as string[] }),
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
