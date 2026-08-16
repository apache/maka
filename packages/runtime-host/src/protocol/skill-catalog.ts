import { isPermissionMode, type PermissionMode } from '@maka/core/permission';
import { requireCount, requireEntityId, requireExactRecord, requireRecord } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineHostPathOperation } from './operation-spec.js';
import {
  decodeWorkspaceProjection,
  decodeWorkspaceTarget,
  type WorkspaceProjection,
  type WorkspaceTarget,
} from './workspace.js';

export const SKILL_CATALOG_PAGE_MAX_ITEMS = 128;
export const SKILL_CATALOG_PAGE_MAX_BYTES = 48 * 1024;
export const SKILL_CATALOG_PREVIEW_RESULT_MAX_BYTES = 48 * 1024;
export const SKILL_CATALOG_REF_MAX_BYTES = 512;
export const SKILL_CATALOG_DISPLAY_ID_MAX_BYTES = 256;

const CURSOR_MAX_BYTES = 1024;
const ID_MAX_BYTES = 81;
export const SKILL_CATALOG_NAME_MAX_BYTES = 256;
export const SKILL_CATALOG_DESCRIPTION_MAX_BYTES = 4096;
export const SKILL_CATALOG_CATEGORY_MAX_BYTES = 128;
export const SKILL_CATALOG_STRING_ARRAY_MAX_ITEMS = 64;
export const SKILL_CATALOG_STRING_ARRAY_ITEM_MAX_BYTES = 256;
const PREVIEW_SNIPPET_MAX_BYTES = 24 * 1024;

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'persistence_failed',
  'internal_failure',
] as const;
const MUTATION_ERRORS = [...QUERY_ERRORS, 'commit_outcome_unknown'] as const;

export type SkillCatalogRevision = `sha256:${string}`;
export type SkillContentSha256 = SkillCatalogRevision;
export type SkillCatalogView = 'governance' | 'bundled' | 'managed_sources';
export type SkillCatalogEntryKind = 'skill' | 'discovery_diagnostic';
export type SkillCatalogSourceType = 'workspace' | 'bundled' | 'managed' | 'unknown';
export type SkillCatalogValidationStatus = 'ok' | 'missing_lock' | 'modified' | 'metadata_error';
export type SkillCatalogManagedUpdateStatus =
  | 'not_managed'
  | 'source_missing'
  | 'up_to_date'
  | 'update_available'
  | 'local_modified'
  | 'metadata_error';
export type SkillCatalogRuntimeStatus = 'enabled' | 'disabled' | 'state_error';
export type SkillCatalogScope = 'project' | 'workspace' | 'user' | 'custom';
export type SkillCatalogDiscoverySource = 'maka' | 'agents' | 'legacy' | 'custom';
export type SkillCatalogContextStatus =
  | 'unknown'
  | 'advertised'
  | 'disabled'
  | 'invalid'
  | 'host_incompatible'
  | 'shadowed'
  | 'budget';
export type SkillCatalogValidationCode =
  | 'missing_lock'
  | 'modified'
  | 'invalid_json'
  | 'id_mismatch'
  | 'unsupported_schema'
  | 'invalid_hash'
  | 'write_failed'
  | 'lock_symlink'
  | 'missing_frontmatter'
  | 'malformed_frontmatter'
  | 'missing_name'
  | 'invalid_name'
  | 'name_too_long'
  | 'missing_description'
  | 'invalid_description'
  | 'description_too_long'
  | 'invalid_allowed_tools'
  | 'invalid_required_tools'
  | 'invalid_required_capabilities'
  | 'invalid_license'
  | 'invalid_compatibility'
  | 'compatibility_too_long'
  | 'invalid_metadata'
  | 'invalid_category'
  | 'unsupported_field'
  | 'body_too_large'
  | 'duplicate_id'
  | 'duplicate_name'
  | 'blocked_path'
  | 'read_failed'
  | 'projection_truncated';

export interface SkillCatalogWorkspaceContext {
  readonly workspace: WorkspaceTarget;
}

export type SkillCatalogInvocableTarget =
  | { readonly kind: 'session'; readonly sessionId: string }
  | {
      readonly kind: 'new_session';
      readonly context: SkillCatalogWorkspaceContext;
      readonly collaborationMode: 'agent' | 'plan';
      readonly permissionMode: PermissionMode;
    };

export interface SkillCatalogInvocableItem {
  readonly ref: string;
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export interface SkillCatalogGovernanceItem {
  readonly kind: SkillCatalogEntryKind;
  readonly ref: string;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly declaredTools: readonly string[];
  readonly metadataTruncated: boolean;
  readonly sourceType: SkillCatalogSourceType;
  readonly userModified: boolean;
  readonly validationStatus: SkillCatalogValidationStatus;
  readonly validationCodes: readonly SkillCatalogValidationCode[];
  readonly managedUpdateStatus: SkillCatalogManagedUpdateStatus | null;
  readonly enabled: boolean;
  readonly pinned: boolean;
  readonly runtimeStatus: SkillCatalogRuntimeStatus;
  readonly scope: SkillCatalogScope;
  readonly source: SkillCatalogDiscoverySource;
  readonly contextStatus: SkillCatalogContextStatus;
  readonly contextRank: number | null;
  readonly shadowedBy: string | null;
  readonly needsReview: boolean;
  readonly manageable: boolean;
}

export interface SkillCatalogBundledItem {
  readonly kind: 'bundled';
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly declaredTools: readonly string[];
  readonly metadataTruncated: boolean;
  readonly installed: boolean;
}

export interface SkillCatalogManagedSourceItem {
  readonly kind: 'managed_source';
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly sourceType: 'local';
  readonly metadataTruncated: boolean;
  readonly installed: boolean;
}

export type SkillCatalogPageItem =
  | SkillCatalogGovernanceItem
  | SkillCatalogBundledItem
  | SkillCatalogManagedSourceItem;

export type SkillCatalogQueryInput =
  | {
      readonly kind: 'start';
      readonly context: SkillCatalogWorkspaceContext;
      readonly view: SkillCatalogView;
    }
  | {
      readonly kind: 'continue';
      readonly context: SkillCatalogWorkspaceContext;
      readonly view: SkillCatalogView;
      readonly revision: SkillCatalogRevision;
      readonly cursor: string;
    };

export type SkillCatalogQueryProjection =
  | {
      readonly kind: 'page';
      readonly view: SkillCatalogView;
      readonly revision: SkillCatalogRevision;
      readonly items: readonly SkillCatalogPageItem[];
      readonly nextCursor: string | null;
    }
  | SkillCatalogRevisionChanged;

export type SkillCatalogQueryResult = SkillCatalogQueryProjection & {
  readonly resolvedWorkspace: WorkspaceProjection;
};

export type SkillCatalogInvocableQueryInput =
  | {
      readonly kind: 'start';
      readonly target: SkillCatalogInvocableTarget;
    }
  | {
      readonly kind: 'continue';
      readonly target: SkillCatalogInvocableTarget;
      readonly revision: SkillCatalogRevision;
      readonly cursor: string;
    };

export type SkillCatalogInvocableQueryResult =
  | {
      readonly kind: 'page';
      readonly revision: SkillCatalogRevision;
      readonly items: readonly SkillCatalogInvocableItem[];
      readonly nextCursor: string | null;
    }
  | {
      readonly kind: 'revision_changed';
      readonly expectedRevision: SkillCatalogRevision;
      readonly actualRevision: SkillCatalogRevision;
    };

export type SkillCatalogMutation =
  | { readonly kind: 'create_starter' }
  | {
      readonly kind: 'install';
      readonly sourceType: 'bundled' | 'managed';
      readonly sourceId: string;
    }
  | SkillCatalogManagedUpdateMutation
  | { readonly kind: 'delete'; readonly ref: string }
  | { readonly kind: 'set_enabled'; readonly ref: string; readonly enabled: boolean }
  | { readonly kind: 'set_pinned'; readonly ref: string; readonly pinned: boolean };

export type SkillCatalogManagedUpdateMutation =
  | {
      readonly kind: 'update_managed';
      readonly ref: string;
      readonly force: false;
      readonly expectedCurrentSha256: null;
      readonly expectedSourceSha256: null;
    }
  | {
      readonly kind: 'update_managed';
      readonly ref: string;
      readonly force: true;
      readonly expectedCurrentSha256: SkillContentSha256;
      readonly expectedSourceSha256: SkillContentSha256;
    };

export interface SkillCatalogMutateInput {
  readonly context: SkillCatalogWorkspaceContext;
  readonly expectedRevision: SkillCatalogRevision;
  readonly mutation: SkillCatalogMutation;
}

export type SkillCatalogMutationRejectedReason =
  | 'not_found'
  | 'already_exists'
  | 'blocked_scope'
  | 'not_managed'
  | 'source_missing'
  | 'source_changed'
  | 'source_invalid'
  | 'local_modified'
  | 'metadata_error'
  | 'needs_review'
  | 'blocked_path'
  | 'state_error';

export type SkillCatalogMutationOutcome =
  | {
      readonly kind: 'committed' | 'unchanged';
      readonly revision: SkillCatalogRevision;
      readonly entry: SkillCatalogGovernanceItem | null;
    }
  | SkillCatalogRevisionConflict
  | { readonly kind: 'rejected'; readonly reason: SkillCatalogMutationRejectedReason };

export type SkillCatalogMutateResult = SkillCatalogMutationOutcome & {
  readonly resolvedWorkspace: WorkspaceProjection;
};

export interface SkillCatalogPreviewUpdateInput {
  readonly context: SkillCatalogWorkspaceContext;
  readonly expectedRevision: SkillCatalogRevision;
  readonly ref: string;
}

export interface SkillCatalogPreviewLineSummary {
  readonly currentLineCount: number;
  readonly sourceLineCount: number;
  readonly changedLineCount: number;
}

export type SkillCatalogPreviewRejectedReason =
  | 'not_found'
  | 'not_managed'
  | 'source_missing'
  | 'source_invalid'
  | 'metadata_error';

export type SkillCatalogPreviewUpdateOutcome =
  | {
      readonly kind: 'preview';
      readonly revision: SkillCatalogRevision;
      readonly currentSnippet: string;
      readonly sourceSnippet: string;
      readonly currentTruncated: boolean;
      readonly sourceTruncated: boolean;
      readonly hasManagedBaseline: boolean;
      readonly summary: SkillCatalogPreviewLineSummary;
      readonly expectedCurrentSha256: SkillContentSha256;
      readonly expectedSourceSha256: SkillContentSha256;
    }
  | SkillCatalogRevisionConflict
  | { readonly kind: 'rejected'; readonly reason: SkillCatalogPreviewRejectedReason };

export type SkillCatalogPreviewUpdateResult = SkillCatalogPreviewUpdateOutcome & {
  readonly resolvedWorkspace: WorkspaceProjection;
};

export interface SkillCatalogRevisionChanged {
  readonly kind: 'revision_changed';
  readonly expectedRevision: SkillCatalogRevision;
  readonly actualRevision: SkillCatalogRevision;
}

export interface SkillCatalogRevisionConflict {
  readonly kind: 'revision_conflict';
  readonly expectedRevision: SkillCatalogRevision;
  readonly actualRevision: SkillCatalogRevision;
}

export const SKILL_CATALOG_OPERATION_SPECS = {
  'skill.catalog.query': defineHostPathOperation<
    SkillCatalogQueryInput,
    SkillCatalogQueryResult,
    (typeof QUERY_ERRORS)[number]
  >(
    {
      mode: 'query',
      availability: 'ready',
      errors: QUERY_ERRORS,
      decodeInput: decodeQueryInput,
      decodeOutput: decodeQueryResult,
    },
    usesWorkspaceHostPath,
  ),
  'skill.catalog.invocable.query': defineHostPathOperation<
    SkillCatalogInvocableQueryInput,
    SkillCatalogInvocableQueryResult,
    (typeof QUERY_ERRORS)[number]
  >(
    {
      mode: 'query',
      availability: 'ready',
      errors: QUERY_ERRORS,
      decodeInput: decodeInvocableQueryInput,
      decodeOutput: decodeInvocableQueryResult,
    },
    (input) =>
      input.target.kind === 'new_session' && input.target.context.workspace.kind === 'host_path',
  ),
  'skill.catalog.mutate': defineHostPathOperation<
    SkillCatalogMutateInput,
    SkillCatalogMutateResult,
    (typeof MUTATION_ERRORS)[number]
  >(
    {
      mode: 'command',
      availability: 'ready',
      errors: MUTATION_ERRORS,
      decodeInput: decodeMutateInput,
      decodeOutput: decodeMutateResult,
    },
    usesWorkspaceHostPath,
  ),
  'skill.catalog.preview-update': defineHostPathOperation<
    SkillCatalogPreviewUpdateInput,
    SkillCatalogPreviewUpdateResult,
    (typeof QUERY_ERRORS)[number]
  >(
    {
      mode: 'query',
      availability: 'ready',
      errors: QUERY_ERRORS,
      decodeInput: decodePreviewInput,
      decodeOutput: decodePreviewResult,
    },
    usesWorkspaceHostPath,
  ),
} as const;

function usesWorkspaceHostPath(input: { readonly context: SkillCatalogWorkspaceContext }): boolean {
  return input.context.workspace.kind === 'host_path';
}

function decodeInvocableQueryInput(value: unknown): SkillCatalogInvocableQueryInput {
  const record = requireRecord(value, 'invocable skill catalog query input');
  if (record.kind === 'start') {
    const start = requireExactRecord(record, 'invocable skill catalog start query', [
      'kind',
      'target',
    ]);
    return { kind: 'start', target: invocableTarget(start.target) };
  }
  if (record.kind === 'continue') {
    const continuation = requireExactRecord(record, 'invocable skill catalog continuation query', [
      'kind',
      'target',
      'revision',
      'cursor',
    ]);
    return {
      kind: 'continue',
      target: invocableTarget(continuation.target),
      revision: sha256(continuation.revision, 'invocable skill catalog revision'),
      cursor: utf8String(continuation.cursor, 'invocable skill catalog cursor', CURSOR_MAX_BYTES),
    };
  }
  throw invalidProtocolFrame('Invalid invocable skill catalog query kind');
}

function decodeInvocableQueryResult(value: unknown): SkillCatalogInvocableQueryResult {
  const record = requireRecord(value, 'invocable skill catalog query result');
  if (record.kind === 'revision_changed') return revisionChanged(record);
  const page = requireExactRecord(record, 'invocable skill catalog page result', [
    'kind',
    'revision',
    'items',
    'nextCursor',
  ]);
  if (page.kind !== 'page' || !Array.isArray(page.items)) {
    throw invalidProtocolFrame('Invalid invocable skill catalog page result');
  }
  if (page.items.length > SKILL_CATALOG_PAGE_MAX_ITEMS) {
    throw invalidProtocolFrame('Invocable skill catalog page exceeds item limit');
  }
  const decoded: SkillCatalogInvocableQueryResult = {
    kind: 'page',
    revision: sha256(page.revision, 'invocable skill catalog revision'),
    items: page.items.map(invocableItem),
    nextCursor:
      page.nextCursor === null
        ? null
        : utf8String(page.nextCursor, 'invocable skill catalog next cursor', CURSOR_MAX_BYTES),
  };
  assertJsonByteLimit(decoded, SKILL_CATALOG_PAGE_MAX_BYTES, 'Invocable skill catalog page');
  return decoded;
}

function decodeQueryInput(value: unknown): SkillCatalogQueryInput {
  const record = requireRecord(value, 'skill catalog query input');
  if (record.kind === 'start') {
    const start = requireExactRecord(record, 'skill catalog start query', [
      'kind',
      'context',
      'view',
    ]);
    return {
      kind: 'start',
      context: localContext(start.context),
      view: catalogView(start.view),
    };
  }
  if (record.kind === 'continue') {
    const continuation = requireExactRecord(record, 'skill catalog continuation query', [
      'kind',
      'context',
      'view',
      'revision',
      'cursor',
    ]);
    return {
      kind: 'continue',
      context: localContext(continuation.context),
      view: catalogView(continuation.view),
      revision: sha256(continuation.revision, 'skill catalog revision'),
      cursor: utf8String(continuation.cursor, 'skill catalog cursor', CURSOR_MAX_BYTES),
    };
  }
  throw invalidProtocolFrame('Invalid skill catalog query kind');
}

function decodeQueryResult(value: unknown): SkillCatalogQueryResult {
  const record = requireRecord(value, 'skill catalog query result');
  if (record.kind === 'revision_changed') {
    const changed = requireExactRecord(record, 'skill catalog revision changed result', [
      'kind',
      'expectedRevision',
      'actualRevision',
      'resolvedWorkspace',
    ]);
    return {
      ...revisionChanged({
        kind: changed.kind,
        expectedRevision: changed.expectedRevision,
        actualRevision: changed.actualRevision,
      }),
      resolvedWorkspace: decodeWorkspaceProjection(changed.resolvedWorkspace),
    };
  }
  const page = requireExactRecord(record, 'skill catalog page result', [
    'kind',
    'view',
    'revision',
    'items',
    'nextCursor',
    'resolvedWorkspace',
  ]);
  if (page.kind !== 'page' || !Array.isArray(page.items)) {
    throw invalidProtocolFrame('Invalid skill catalog page result');
  }
  if (page.items.length > SKILL_CATALOG_PAGE_MAX_ITEMS) {
    throw invalidProtocolFrame('Skill catalog page exceeds item limit');
  }
  const view = catalogView(page.view);
  const decoded: SkillCatalogQueryResult = {
    kind: 'page',
    view,
    revision: sha256(page.revision, 'skill catalog revision'),
    items: page.items.map((item) => pageItem(item, view)),
    nextCursor:
      page.nextCursor === null
        ? null
        : utf8String(page.nextCursor, 'skill catalog next cursor', CURSOR_MAX_BYTES),
    resolvedWorkspace: decodeWorkspaceProjection(page.resolvedWorkspace),
  };
  assertJsonByteLimit(
    decoded,
    SKILL_CATALOG_PAGE_MAX_BYTES + resolvedWorkspaceByteOverhead(decoded.resolvedWorkspace),
    'Skill catalog page',
  );
  return decoded;
}

function pageItem(value: unknown, view: SkillCatalogView): SkillCatalogPageItem {
  if (view === 'governance') return governanceItem(value);
  if (view === 'bundled') return bundledItem(value);
  return managedSourceItem(value);
}

function governanceItem(value: unknown): SkillCatalogGovernanceItem {
  const record = requireExactRecord(value, 'skill catalog governance item', [
    'kind',
    'ref',
    'id',
    'name',
    'description',
    'declaredTools',
    'metadataTruncated',
    'sourceType',
    'userModified',
    'validationStatus',
    'validationCodes',
    'managedUpdateStatus',
    'enabled',
    'pinned',
    'runtimeStatus',
    'scope',
    'source',
    'contextStatus',
    'contextRank',
    'shadowedBy',
    'needsReview',
    'manageable',
  ]);
  return {
    kind: entryKind(record.kind),
    ref: ref(record.ref),
    id: displayId(record.id),
    name: utf8String(record.name, 'skill name', SKILL_CATALOG_NAME_MAX_BYTES, true),
    description: utf8String(
      record.description,
      'skill description',
      SKILL_CATALOG_DESCRIPTION_MAX_BYTES,
      true,
    ),
    declaredTools: stringArray(record.declaredTools, 'declared tools'),
    metadataTruncated: bool(record.metadataTruncated, 'skill metadata truncated'),
    sourceType: sourceType(record.sourceType),
    userModified: bool(record.userModified, 'skill user modified'),
    validationStatus: validationStatus(record.validationStatus),
    validationCodes: validationCodes(record.validationCodes),
    managedUpdateStatus:
      record.managedUpdateStatus === null ? null : managedUpdateStatus(record.managedUpdateStatus),
    enabled: bool(record.enabled, 'skill enabled'),
    pinned: bool(record.pinned, 'skill pinned'),
    runtimeStatus: runtimeStatus(record.runtimeStatus),
    scope: scope(record.scope),
    source: discoverySource(record.source),
    contextStatus: contextStatus(record.contextStatus),
    contextRank:
      record.contextRank === null ? null : positiveCount(record.contextRank, 'skill context rank'),
    shadowedBy: record.shadowedBy === null ? null : ref(record.shadowedBy),
    needsReview: bool(record.needsReview, 'skill needs review'),
    manageable: bool(record.manageable, 'skill manageable'),
  };
}

function bundledItem(value: unknown): SkillCatalogBundledItem {
  const record = requireExactRecord(value, 'skill catalog bundled item', [
    'kind',
    'id',
    'name',
    'description',
    'category',
    'declaredTools',
    'metadataTruncated',
    'installed',
  ]);
  if (record.kind !== 'bundled') throw invalidProtocolFrame('Invalid bundled skill kind');
  return {
    kind: 'bundled',
    id: id(record.id, 'bundled skill id'),
    name: utf8String(record.name, 'bundled skill name', SKILL_CATALOG_NAME_MAX_BYTES),
    description: utf8String(
      record.description,
      'bundled skill description',
      SKILL_CATALOG_DESCRIPTION_MAX_BYTES,
      true,
    ),
    category: utf8String(
      record.category,
      'bundled skill category',
      SKILL_CATALOG_CATEGORY_MAX_BYTES,
    ),
    declaredTools: stringArray(record.declaredTools, 'bundled skill declared tools'),
    metadataTruncated: bool(record.metadataTruncated, 'bundled skill metadata truncated'),
    installed: bool(record.installed, 'bundled skill installed'),
  };
}

function managedSourceItem(value: unknown): SkillCatalogManagedSourceItem {
  const record = requireExactRecord(value, 'skill catalog managed source item', [
    'kind',
    'id',
    'name',
    'description',
    'category',
    'sourceType',
    'metadataTruncated',
    'installed',
  ]);
  if (record.kind !== 'managed_source' || record.sourceType !== 'local') {
    throw invalidProtocolFrame('Invalid managed skill source item');
  }
  return {
    kind: 'managed_source',
    id: id(record.id, 'managed skill source id'),
    name: utf8String(record.name, 'managed skill source name', SKILL_CATALOG_NAME_MAX_BYTES),
    description: utf8String(
      record.description,
      'managed skill source description',
      SKILL_CATALOG_DESCRIPTION_MAX_BYTES,
      true,
    ),
    category: utf8String(
      record.category,
      'managed skill source category',
      SKILL_CATALOG_CATEGORY_MAX_BYTES,
    ),
    sourceType: 'local',
    metadataTruncated: bool(record.metadataTruncated, 'managed skill source metadata truncated'),
    installed: bool(record.installed, 'managed skill source installed'),
  };
}

function decodeMutateInput(value: unknown): SkillCatalogMutateInput {
  const record = requireExactRecord(value, 'skill catalog mutate input', [
    'context',
    'expectedRevision',
    'mutation',
  ]);
  return {
    context: localContext(record.context),
    expectedRevision: sha256(record.expectedRevision, 'expected skill catalog revision'),
    mutation: mutation(record.mutation),
  };
}

function mutation(value: unknown): SkillCatalogMutation {
  const record = requireRecord(value, 'skill catalog mutation');
  if (record.kind === 'create_starter') {
    requireExactRecord(record, 'create starter skill mutation', ['kind']);
    return { kind: 'create_starter' };
  }
  if (record.kind === 'install') {
    const item = requireExactRecord(record, 'install skill mutation', [
      'kind',
      'sourceType',
      'sourceId',
    ]);
    return {
      kind: 'install',
      sourceType: mutableSourceType(item.sourceType),
      sourceId: id(item.sourceId, 'skill source id'),
    };
  }
  if (record.kind === 'update_managed') {
    const item = requireExactRecord(record, 'update managed skill mutation', [
      'kind',
      'ref',
      'force',
      'expectedCurrentSha256',
      'expectedSourceSha256',
    ]);
    const force = bool(item.force, 'force managed skill update');
    const expectedCurrentSha256 = nullableSha256(
      item.expectedCurrentSha256,
      'expected current sha256',
    );
    const expectedSourceSha256 = nullableSha256(
      item.expectedSourceSha256,
      'expected source sha256',
    );
    if (force) {
      if (expectedCurrentSha256 === null || expectedSourceSha256 === null) {
        throw invalidProtocolFrame('Invalid managed skill update preview confirmation');
      }
      return {
        kind: 'update_managed',
        ref: ref(item.ref),
        force: true,
        expectedCurrentSha256,
        expectedSourceSha256,
      };
    }
    if (expectedCurrentSha256 !== null || expectedSourceSha256 !== null) {
      throw invalidProtocolFrame('Invalid managed skill update preview confirmation');
    }
    return {
      kind: 'update_managed',
      ref: ref(item.ref),
      force: false,
      expectedCurrentSha256: null,
      expectedSourceSha256: null,
    };
  }
  if (record.kind === 'delete') {
    const item = requireExactRecord(record, 'delete skill mutation', ['kind', 'ref']);
    return { kind: 'delete', ref: ref(item.ref) };
  }
  if (record.kind === 'set_enabled') {
    const item = requireExactRecord(record, 'set skill enabled mutation', [
      'kind',
      'ref',
      'enabled',
    ]);
    return {
      kind: 'set_enabled',
      ref: ref(item.ref),
      enabled: bool(item.enabled, 'skill enabled'),
    };
  }
  if (record.kind === 'set_pinned') {
    const item = requireExactRecord(record, 'set skill pinned mutation', ['kind', 'ref', 'pinned']);
    return {
      kind: 'set_pinned',
      ref: ref(item.ref),
      pinned: bool(item.pinned, 'skill pinned'),
    };
  }
  throw invalidProtocolFrame('Invalid skill catalog mutation kind');
}

function decodeMutateResult(value: unknown): SkillCatalogMutateResult {
  const record = requireRecord(value, 'skill catalog mutate result');
  if (record.kind === 'revision_conflict') {
    const conflict = requireExactRecord(record, 'skill catalog revision conflict', [
      'kind',
      'expectedRevision',
      'actualRevision',
      'resolvedWorkspace',
    ]);
    return {
      ...revisionConflict({
        kind: conflict.kind,
        expectedRevision: conflict.expectedRevision,
        actualRevision: conflict.actualRevision,
      }),
      resolvedWorkspace: decodeWorkspaceProjection(conflict.resolvedWorkspace),
    };
  }
  if (record.kind === 'rejected') {
    const rejected = requireExactRecord(record, 'skill catalog mutation rejected result', [
      'kind',
      'reason',
      'resolvedWorkspace',
    ]);
    return {
      kind: 'rejected',
      reason: mutationRejectedReason(rejected.reason),
      resolvedWorkspace: decodeWorkspaceProjection(rejected.resolvedWorkspace),
    };
  }
  const result = requireExactRecord(record, 'skill catalog mutation result', [
    'kind',
    'revision',
    'entry',
    'resolvedWorkspace',
  ]);
  if (result.kind !== 'committed' && result.kind !== 'unchanged') {
    throw invalidProtocolFrame('Invalid skill catalog mutation result kind');
  }
  return {
    kind: result.kind,
    revision: sha256(result.revision, 'skill catalog revision'),
    entry: result.entry === null ? null : governanceItem(result.entry),
    resolvedWorkspace: decodeWorkspaceProjection(result.resolvedWorkspace),
  };
}

function decodePreviewInput(value: unknown): SkillCatalogPreviewUpdateInput {
  const record = requireExactRecord(value, 'skill catalog preview input', [
    'context',
    'expectedRevision',
    'ref',
  ]);
  return {
    context: localContext(record.context),
    expectedRevision: sha256(record.expectedRevision, 'expected skill catalog revision'),
    ref: ref(record.ref),
  };
}

function decodePreviewResult(value: unknown): SkillCatalogPreviewUpdateResult {
  const record = requireRecord(value, 'skill catalog preview result');
  if (record.kind === 'revision_conflict') {
    const conflict = requireExactRecord(record, 'skill catalog revision conflict', [
      'kind',
      'expectedRevision',
      'actualRevision',
      'resolvedWorkspace',
    ]);
    return {
      ...revisionConflict({
        kind: conflict.kind,
        expectedRevision: conflict.expectedRevision,
        actualRevision: conflict.actualRevision,
      }),
      resolvedWorkspace: decodeWorkspaceProjection(conflict.resolvedWorkspace),
    };
  }
  if (record.kind === 'rejected') {
    const rejected = requireExactRecord(record, 'skill catalog preview rejected result', [
      'kind',
      'reason',
      'resolvedWorkspace',
    ]);
    return {
      kind: 'rejected',
      reason: previewRejectedReason(rejected.reason),
      resolvedWorkspace: decodeWorkspaceProjection(rejected.resolvedWorkspace),
    };
  }
  const preview = requireExactRecord(record, 'skill catalog preview result', [
    'kind',
    'revision',
    'currentSnippet',
    'sourceSnippet',
    'currentTruncated',
    'sourceTruncated',
    'hasManagedBaseline',
    'summary',
    'expectedCurrentSha256',
    'expectedSourceSha256',
    'resolvedWorkspace',
  ]);
  if (preview.kind !== 'preview') throw invalidProtocolFrame('Invalid skill catalog preview kind');
  const decoded: SkillCatalogPreviewUpdateResult = {
    kind: 'preview',
    revision: sha256(preview.revision, 'skill catalog revision'),
    currentSnippet: utf8String(
      preview.currentSnippet,
      'current skill snippet',
      PREVIEW_SNIPPET_MAX_BYTES,
      true,
    ),
    sourceSnippet: utf8String(
      preview.sourceSnippet,
      'source skill snippet',
      PREVIEW_SNIPPET_MAX_BYTES,
      true,
    ),
    currentTruncated: bool(preview.currentTruncated, 'current skill snippet truncated'),
    sourceTruncated: bool(preview.sourceTruncated, 'source skill snippet truncated'),
    hasManagedBaseline: bool(preview.hasManagedBaseline, 'managed skill baseline availability'),
    summary: lineSummary(preview.summary),
    expectedCurrentSha256: sha256(preview.expectedCurrentSha256, 'expected current sha256'),
    expectedSourceSha256: sha256(preview.expectedSourceSha256, 'expected source sha256'),
    resolvedWorkspace: decodeWorkspaceProjection(preview.resolvedWorkspace),
  };
  assertJsonByteLimit(
    decoded,
    SKILL_CATALOG_PREVIEW_RESULT_MAX_BYTES +
      resolvedWorkspaceByteOverhead(decoded.resolvedWorkspace),
    'Skill catalog preview result',
  );
  return decoded;
}

function localContext(value: unknown): SkillCatalogWorkspaceContext {
  const record = requireExactRecord(value, 'skill catalog workspace context', ['workspace']);
  return { workspace: decodeWorkspaceTarget(record.workspace) };
}

function invocableTarget(value: unknown): SkillCatalogInvocableTarget {
  const record = requireRecord(value, 'invocable skill catalog target');
  if (record.kind === 'session') {
    const session = requireExactRecord(record, 'invocable Session target', ['kind', 'sessionId']);
    return {
      kind: 'session',
      sessionId: requireEntityId(session.sessionId, 'invocable Skill Session id'),
    };
  }
  if (record.kind === 'new_session') {
    const fresh = requireExactRecord(record, 'invocable new Session target', [
      'kind',
      'context',
      'collaborationMode',
      'permissionMode',
    ]);
    if (fresh.collaborationMode !== 'agent' && fresh.collaborationMode !== 'plan') {
      throw invalidProtocolFrame('Invalid invocable Skill collaboration mode');
    }
    if (!isPermissionMode(fresh.permissionMode)) {
      throw invalidProtocolFrame('Invalid invocable Skill permission mode');
    }
    return {
      kind: 'new_session',
      context: localContext(fresh.context),
      collaborationMode: fresh.collaborationMode,
      permissionMode: fresh.permissionMode,
    };
  }
  throw invalidProtocolFrame('Invalid invocable skill catalog target');
}

function invocableItem(value: unknown): SkillCatalogInvocableItem {
  const record = requireExactRecord(value, 'invocable skill catalog item', [
    'ref',
    'id',
    'name',
    'description',
  ]);
  return {
    ref: utf8String(record.ref, 'invocable skill ref', SKILL_CATALOG_REF_MAX_BYTES),
    id: utf8String(record.id, 'invocable skill id', SKILL_CATALOG_DISPLAY_ID_MAX_BYTES),
    name: utf8String(record.name, 'invocable skill name', SKILL_CATALOG_NAME_MAX_BYTES),
    description: utf8String(
      record.description,
      'invocable skill description',
      SKILL_CATALOG_DESCRIPTION_MAX_BYTES,
    ),
  };
}

export function isSkillCatalogProjectRootLexicallyAbsolute(
  value: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return value.startsWith('/');
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(value);
}

function revisionChanged(value: unknown): SkillCatalogRevisionChanged {
  const record = requireExactRecord(value, 'skill catalog revision changed result', [
    'kind',
    'expectedRevision',
    'actualRevision',
  ]);
  return {
    kind: 'revision_changed',
    expectedRevision: sha256(record.expectedRevision, 'expected skill catalog revision'),
    actualRevision: sha256(record.actualRevision, 'actual skill catalog revision'),
  };
}

function revisionConflict(value: unknown): SkillCatalogRevisionConflict {
  const record = requireExactRecord(value, 'skill catalog revision conflict', [
    'kind',
    'expectedRevision',
    'actualRevision',
  ]);
  return {
    kind: 'revision_conflict',
    expectedRevision: sha256(record.expectedRevision, 'expected skill catalog revision'),
    actualRevision: sha256(record.actualRevision, 'actual skill catalog revision'),
  };
}

function lineSummary(value: unknown): SkillCatalogPreviewLineSummary {
  const record = requireExactRecord(value, 'skill catalog preview line summary', [
    'currentLineCount',
    'sourceLineCount',
    'changedLineCount',
  ]);
  return {
    currentLineCount: requireCount(record.currentLineCount, 'current skill line count'),
    sourceLineCount: requireCount(record.sourceLineCount, 'source skill line count'),
    changedLineCount: requireCount(record.changedLineCount, 'changed skill line count'),
  };
}

function utf8String(value: unknown, label: string, maxBytes: number, allowEmpty = false): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

function id(value: unknown, label: string): string {
  const decoded = utf8String(value, label, ID_MAX_BYTES);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(decoded)) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return decoded;
}

function displayId(value: unknown): string {
  return wireIdentity(value, 'skill id', SKILL_CATALOG_DISPLAY_ID_MAX_BYTES);
}

function ref(value: unknown): string {
  return wireIdentity(value, 'skill ref', SKILL_CATALOG_REF_MAX_BYTES);
}

function wireIdentity(value: unknown, label: string, maxBytes: number): string {
  const decoded = utf8String(value, label, maxBytes);
  if (/[\u0000-\u001F\u007F]/.test(decoded)) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return decoded;
}

function sha256(value: unknown, label: string): SkillCatalogRevision {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value as SkillCatalogRevision;
}

function nullableSha256(value: unknown, label: string): SkillContentSha256 | null {
  return value === null ? null : sha256(value, label);
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > SKILL_CATALOG_STRING_ARRAY_MAX_ITEMS) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value.map((item) => utf8String(item, label, SKILL_CATALOG_STRING_ARRAY_ITEM_MAX_BYTES));
}

function validationCodes(value: unknown): readonly SkillCatalogValidationCode[] {
  return stringArray(value, 'skill validation codes').map(validationCode);
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalidProtocolFrame(`Invalid ${label}`);
  return value;
}

function positiveCount(value: unknown, label: string): number {
  const decoded = requireCount(value, label);
  if (decoded === 0) throw invalidProtocolFrame(`Invalid ${label}`);
  return decoded;
}

function catalogView(value: unknown): SkillCatalogView {
  if (value === 'governance' || value === 'bundled' || value === 'managed_sources') return value;
  throw invalidProtocolFrame('Invalid skill catalog view');
}

function entryKind(value: unknown): SkillCatalogEntryKind {
  if (value === 'skill' || value === 'discovery_diagnostic') return value;
  throw invalidProtocolFrame('Invalid skill catalog governance item kind');
}

function mutableSourceType(value: unknown): 'bundled' | 'managed' {
  if (value === 'bundled' || value === 'managed') return value;
  throw invalidProtocolFrame('Invalid mutable skill source type');
}

function sourceType(value: unknown): SkillCatalogSourceType {
  if (value === 'workspace' || value === 'bundled' || value === 'managed' || value === 'unknown') {
    return value;
  }
  throw invalidProtocolFrame('Invalid skill source type');
}

function validationStatus(value: unknown): SkillCatalogValidationStatus {
  if (
    value === 'ok' ||
    value === 'missing_lock' ||
    value === 'modified' ||
    value === 'metadata_error'
  ) {
    return value;
  }
  throw invalidProtocolFrame('Invalid skill validation status');
}

function validationCode(value: string): SkillCatalogValidationCode {
  const codes: readonly SkillCatalogValidationCode[] = [
    'missing_lock',
    'modified',
    'invalid_json',
    'id_mismatch',
    'unsupported_schema',
    'invalid_hash',
    'write_failed',
    'lock_symlink',
    'missing_frontmatter',
    'malformed_frontmatter',
    'missing_name',
    'invalid_name',
    'name_too_long',
    'missing_description',
    'invalid_description',
    'description_too_long',
    'invalid_allowed_tools',
    'invalid_required_tools',
    'invalid_required_capabilities',
    'invalid_license',
    'invalid_compatibility',
    'compatibility_too_long',
    'invalid_metadata',
    'invalid_category',
    'unsupported_field',
    'body_too_large',
    'duplicate_id',
    'duplicate_name',
    'blocked_path',
    'read_failed',
    'projection_truncated',
  ];
  if (!codes.includes(value as SkillCatalogValidationCode)) {
    throw invalidProtocolFrame('Invalid skill validation code');
  }
  return value as SkillCatalogValidationCode;
}

function managedUpdateStatus(value: unknown): SkillCatalogManagedUpdateStatus {
  if (
    value === 'not_managed' ||
    value === 'source_missing' ||
    value === 'up_to_date' ||
    value === 'update_available' ||
    value === 'local_modified' ||
    value === 'metadata_error'
  ) {
    return value;
  }
  throw invalidProtocolFrame('Invalid managed skill update status');
}

function runtimeStatus(value: unknown): SkillCatalogRuntimeStatus {
  if (value === 'enabled' || value === 'disabled' || value === 'state_error') return value;
  throw invalidProtocolFrame('Invalid skill runtime status');
}

function scope(value: unknown): SkillCatalogScope {
  if (value === 'project' || value === 'workspace' || value === 'user' || value === 'custom') {
    return value;
  }
  throw invalidProtocolFrame('Invalid skill scope');
}

function discoverySource(value: unknown): SkillCatalogDiscoverySource {
  if (value === 'maka' || value === 'agents' || value === 'legacy' || value === 'custom') {
    return value;
  }
  throw invalidProtocolFrame('Invalid skill discovery source');
}

function contextStatus(value: unknown): SkillCatalogContextStatus {
  if (
    value === 'unknown' ||
    value === 'advertised' ||
    value === 'disabled' ||
    value === 'invalid' ||
    value === 'host_incompatible' ||
    value === 'shadowed' ||
    value === 'budget'
  ) {
    return value;
  }
  throw invalidProtocolFrame('Invalid skill context status');
}

function mutationRejectedReason(value: unknown): SkillCatalogMutationRejectedReason {
  if (
    value === 'not_found' ||
    value === 'already_exists' ||
    value === 'blocked_scope' ||
    value === 'not_managed' ||
    value === 'source_missing' ||
    value === 'source_changed' ||
    value === 'source_invalid' ||
    value === 'local_modified' ||
    value === 'metadata_error' ||
    value === 'needs_review' ||
    value === 'blocked_path' ||
    value === 'state_error'
  ) {
    return value;
  }
  throw invalidProtocolFrame('Invalid skill catalog mutation rejection reason');
}

function previewRejectedReason(value: unknown): SkillCatalogPreviewRejectedReason {
  if (
    value === 'not_found' ||
    value === 'not_managed' ||
    value === 'source_missing' ||
    value === 'source_invalid' ||
    value === 'metadata_error'
  ) {
    return value;
  }
  throw invalidProtocolFrame('Invalid skill catalog preview rejection reason');
}

function resolvedWorkspaceByteOverhead(workspace: WorkspaceProjection): number {
  return Buffer.byteLength(`,"resolvedWorkspace":${JSON.stringify(workspace)}`, 'utf8');
}

function assertJsonByteLimit(value: unknown, maxBytes: number, label: string): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxBytes) {
    throw invalidProtocolFrame(`${label} exceeds byte limit`);
  }
}
