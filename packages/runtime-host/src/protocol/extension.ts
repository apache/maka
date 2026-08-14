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
        scopeId: requireEntityId(input.scopeId, 'extension scopeId'),
        extensionId: requireEntityId(input.extensionId, 'extension extensionId'),
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
    extensionId: requireEntityId(input.extensionId, 'extension extensionId'),
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
  ]);
  if (!Array.isArray(revision.toolNames) || revision.toolNames.length > 128) {
    throw invalidProtocolFrame('Invalid trusted extension tool names');
  }
  return {
    extensionId: requireEntityId(revision.extensionId, 'extension extensionId'),
    revision: decodeRevision(revision.revision),
    toolNames: revision.toolNames.map((name) =>
      requireUtf8String(name, 'extension tool name', 128),
    ),
  };
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
    scopeId: requireEntityId(binding.scopeId, 'extension scopeId'),
    extensionId: requireEntityId(binding.extensionId, 'extension extensionId'),
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
