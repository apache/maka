import {
  requireCount,
  requireEncodedByteLimit,
  requireEntityId,
  requireExactRecord,
  requireRecord,
  requireUtf8String,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineHostPathOperation, defineOperation } from './operation-spec.js';
import { decodeHostPath } from './workspace.js';

export const PROJECT_CATALOG_PAGE_MAX_ITEMS = 64;
export const PROJECT_CATALOG_PAGE_MAX_BYTES = 48 * 1024;
export const PROJECT_CATALOG_CURSOR_MAX_BYTES = 128;
export const PROJECT_CATALOG_NAME_MAX_BYTES = 16 * 1024;
export const PROJECT_CATALOG_PATH_MAX_BYTES = 4 * 1024;

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'persistence_failed',
  'internal_failure',
] as const;
const LOCATION_QUERY_ERRORS = [...QUERY_ERRORS, 'not_found', 'operation_conflict'] as const;

const MUTATE_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'not_found',
  'operation_conflict',
  'persistence_failed',
  'commit_outcome_unknown',
  'internal_failure',
] as const;

export type ProjectCatalogRevision = `sha256:${string}`;

export interface ProjectCatalogLocation {
  readonly path: string;
  readonly isWorktree: boolean;
}

export interface ProjectCatalogProject {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly name: string;
  readonly locationCount: number;
  readonly archivedAt: number | null;
  readonly available: boolean;
}

export type ProjectCatalogPageItem =
  | {
      readonly kind: 'project';
      readonly projectIndex: number;
      readonly id: string;
      readonly name: string;
      readonly aliasCount: number;
      readonly locationCount: number;
      readonly archivedAt: number | null;
      readonly available: boolean;
    }
  | {
      readonly kind: 'alias';
      readonly projectIndex: number;
      readonly itemIndex: number;
      readonly alias: string;
    };

export type ProjectCatalogQueryInput =
  | { readonly kind: 'list_start' }
  | {
      readonly kind: 'list_continue';
      readonly revision: ProjectCatalogRevision;
      readonly cursor: string;
    };

export type ProjectCatalogQueryResult =
  | {
      readonly kind: 'page';
      readonly revision: ProjectCatalogRevision;
      readonly projectCount: number;
      readonly items: readonly ProjectCatalogPageItem[];
      readonly nextCursor: string | null;
    }
  | {
      readonly kind: 'revision_changed';
      readonly expected: ProjectCatalogRevision;
      readonly actual: ProjectCatalogRevision;
    };

export type ProjectCatalogMutateInput =
  | { readonly kind: 'register'; readonly path: string }
  | { readonly kind: 'relink'; readonly projectId: string; readonly path: string }
  | { readonly kind: 'rename'; readonly projectId: string; readonly name: string }
  | { readonly kind: 'archive'; readonly projectId: string }
  | { readonly kind: 'restore'; readonly projectId: string };

export type ProjectCatalogMutateResult = {
  readonly kind: 'project';
  readonly project: ProjectCatalogProject;
};

export interface ProjectCatalogLocationQueryInput {
  readonly projectId: string;
}

export interface ProjectCatalogLocationQueryResult {
  readonly projectId: string;
  readonly locations: readonly ProjectCatalogLocation[];
  readonly preferredPath: string;
}

export const PROJECT_CATALOG_OPERATION_SPECS = {
  'project.catalog.query': defineOperation<
    ProjectCatalogQueryInput,
    ProjectCatalogQueryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeProjectCatalogQueryInput,
    decodeOutput: decodeProjectCatalogQueryResult,
  }),
  'project.catalog.location.query': defineHostPathOperation<
    ProjectCatalogLocationQueryInput,
    ProjectCatalogLocationQueryResult,
    (typeof LOCATION_QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: LOCATION_QUERY_ERRORS,
    decodeInput: decodeProjectCatalogLocationQueryInput,
    decodeOutput: decodeProjectCatalogLocationQueryResult,
  }),
  'project.catalog.mutate': defineHostPathOperation<
    ProjectCatalogMutateInput,
    ProjectCatalogMutateResult,
    (typeof MUTATE_ERRORS)[number]
  >(
    {
      mode: 'command',
      availability: 'ready',
      errors: MUTATE_ERRORS,
      decodeInput: decodeProjectCatalogMutateInput,
      decodeOutput: decodeProjectCatalogMutateResult,
    },
    (input) => input.kind === 'register' || input.kind === 'relink',
  ),
} as const;

export function decodeProjectCatalogLocationQueryInput(
  value: unknown,
): ProjectCatalogLocationQueryInput {
  const input = requireExactRecord(value, 'project catalog location query input', ['projectId']);
  return { projectId: projectId(input.projectId) };
}

export function decodeProjectCatalogLocationQueryResult(
  value: unknown,
): ProjectCatalogLocationQueryResult {
  const result = requireExactRecord(value, 'project catalog location query result', [
    'projectId',
    'locations',
    'preferredPath',
  ]);
  if (
    !Array.isArray(result.locations) ||
    result.locations.length > PROJECT_CATALOG_PAGE_MAX_ITEMS
  ) {
    throw invalidProtocolFrame('Invalid project locations');
  }
  const locations = result.locations.map(decodeProjectLocation);
  const preferredPath = absolutePath(result.preferredPath, 'project preferred path');
  if (
    new Set(locations.map((location) => location.path)).size !== locations.length ||
    !locations.some((location) => location.path === preferredPath)
  ) {
    throw invalidProtocolFrame('Invalid project locations');
  }
  const decoded: ProjectCatalogLocationQueryResult = {
    projectId: projectId(result.projectId),
    locations,
    preferredPath,
  };
  requireEncodedByteLimit(
    decoded,
    'project catalog location query result',
    PROJECT_CATALOG_PAGE_MAX_BYTES,
  );
  return decoded;
}

export function decodeProjectCatalogQueryInput(value: unknown): ProjectCatalogQueryInput {
  const record = requireRecord(value, 'project catalog query input');
  if (record.kind === 'list_start') {
    requireExactRecord(record, 'project catalog list start input', ['kind']);
    return { kind: 'list_start' };
  }
  if (record.kind === 'list_continue') {
    const input = requireExactRecord(record, 'project catalog list continuation input', [
      'kind',
      'revision',
      'cursor',
    ]);
    return {
      kind: 'list_continue',
      revision: revision(input.revision, 'project catalog revision'),
      cursor: requireUtf8String(
        input.cursor,
        'project catalog cursor',
        PROJECT_CATALOG_CURSOR_MAX_BYTES,
      ),
    };
  }
  throw invalidProtocolFrame('Invalid project catalog query kind');
}

export function decodeProjectCatalogQueryResult(value: unknown): ProjectCatalogQueryResult {
  const record = requireRecord(value, 'project catalog query result');
  if (record.kind === 'revision_changed') {
    const result = requireExactRecord(record, 'project catalog revision changed result', [
      'kind',
      'expected',
      'actual',
    ]);
    return {
      kind: 'revision_changed',
      expected: revision(result.expected, 'expected project catalog revision'),
      actual: revision(result.actual, 'actual project catalog revision'),
    };
  }
  if (record.kind !== 'page') throw invalidProtocolFrame('Invalid project catalog query result');
  const page = requireExactRecord(record, 'project catalog page result', [
    'kind',
    'revision',
    'projectCount',
    'items',
    'nextCursor',
  ]);
  if (!Array.isArray(page.items) || page.items.length > PROJECT_CATALOG_PAGE_MAX_ITEMS) {
    throw invalidProtocolFrame('Invalid project catalog page items');
  }
  const decoded: ProjectCatalogQueryResult = {
    kind: 'page',
    revision: revision(page.revision, 'project catalog revision'),
    projectCount: requireCount(page.projectCount, 'project catalog projectCount'),
    items: page.items.map(decodeProjectCatalogPageItem),
    nextCursor:
      page.nextCursor === null
        ? null
        : requireUtf8String(
            page.nextCursor,
            'project catalog next cursor',
            PROJECT_CATALOG_CURSOR_MAX_BYTES,
          ),
  };
  requireEncodedByteLimit(decoded, 'project catalog page result', PROJECT_CATALOG_PAGE_MAX_BYTES);
  return decoded;
}

export function decodeProjectCatalogMutateInput(value: unknown): ProjectCatalogMutateInput {
  const record = requireRecord(value, 'project catalog mutation input');
  switch (record.kind) {
    case 'register': {
      const input = requireExactRecord(record, 'project register input', ['kind', 'path']);
      return { kind: 'register', path: absolutePath(input.path, 'project path') };
    }
    case 'archive':
    case 'restore': {
      const input = requireExactRecord(record, `project ${record.kind} input`, [
        'kind',
        'projectId',
      ]);
      return { kind: record.kind, projectId: projectId(input.projectId) };
    }
    case 'relink': {
      const input = requireExactRecord(record, 'project relink input', [
        'kind',
        'projectId',
        'path',
      ]);
      return {
        kind: 'relink',
        projectId: projectId(input.projectId),
        path: absolutePath(input.path, 'project path'),
      };
    }
    case 'rename': {
      const input = requireExactRecord(record, 'project rename input', [
        'kind',
        'projectId',
        'name',
      ]);
      return {
        kind: 'rename',
        projectId: projectId(input.projectId),
        name: requireUtf8String(input.name, 'project name', PROJECT_CATALOG_NAME_MAX_BYTES),
      };
    }
    default:
      throw invalidProtocolFrame('Invalid project catalog mutation kind');
  }
}

export function decodeProjectCatalogMutateResult(value: unknown): ProjectCatalogMutateResult {
  const record = requireRecord(value, 'project catalog mutation result');
  if (record.kind === 'project') {
    const result = requireExactRecord(record, 'project mutation result', ['kind', 'project']);
    return { kind: 'project', project: decodeProjectCatalogProject(result.project) };
  }
  throw invalidProtocolFrame('Invalid project catalog mutation result kind');
}

function decodeProjectCatalogPageItem(value: unknown): ProjectCatalogPageItem {
  const record = requireRecord(value, 'project catalog page item');
  if (record.kind === 'project') {
    const item = requireExactRecord(record, 'project catalog header item', [
      'kind',
      'projectIndex',
      'id',
      'name',
      'aliasCount',
      'locationCount',
      'archivedAt',
      'available',
    ]);
    return {
      kind: 'project',
      projectIndex: requireCount(item.projectIndex, 'project index'),
      id: projectId(item.id),
      name: requireUtf8String(item.name, 'project name', PROJECT_CATALOG_NAME_MAX_BYTES),
      aliasCount: requireCount(item.aliasCount, 'project alias count'),
      locationCount: requireCount(item.locationCount, 'project location count'),
      archivedAt:
        item.archivedAt === null ? null : requireCount(item.archivedAt, 'project archivedAt'),
      available: boolean(item.available, 'project available'),
    };
  }
  if (record.kind === 'alias') {
    const item = requireExactRecord(record, 'project catalog alias item', [
      'kind',
      'projectIndex',
      'itemIndex',
      'alias',
    ]);
    return {
      kind: 'alias',
      projectIndex: requireCount(item.projectIndex, 'project index'),
      itemIndex: requireCount(item.itemIndex, 'project alias index'),
      alias: projectId(item.alias),
    };
  }
  throw invalidProtocolFrame('Invalid project catalog page item kind');
}

export function decodeProjectCatalogProject(value: unknown): ProjectCatalogProject {
  const record = requireExactRecord(value, 'project catalog project', [
    'id',
    'aliases',
    'name',
    'locationCount',
    'archivedAt',
    'available',
  ]);
  if (!Array.isArray(record.aliases)) throw invalidProtocolFrame('Invalid project aliases');
  const aliases = record.aliases.map(projectId);
  if (new Set(aliases).size !== aliases.length) {
    throw invalidProtocolFrame('Duplicate project aliases');
  }
  const project: ProjectCatalogProject = {
    id: projectId(record.id),
    aliases,
    name: requireUtf8String(record.name, 'project name', PROJECT_CATALOG_NAME_MAX_BYTES),
    locationCount: requireCount(record.locationCount, 'project location count'),
    archivedAt:
      record.archivedAt === null ? null : requireCount(record.archivedAt, 'project archivedAt'),
    available: boolean(record.available, 'project available'),
  };
  return project;
}

function projectId(value: unknown): string {
  return requireEntityId(value, 'projectId');
}

function absolutePath(value: unknown, label: string): string {
  return decodeHostPath(value, label, PROJECT_CATALOG_PATH_MAX_BYTES);
}

function decodeProjectLocation(value: unknown): ProjectCatalogLocation {
  const location = requireExactRecord(value, 'project location', ['path', 'isWorktree']);
  return {
    path: absolutePath(location.path, 'project location path'),
    isWorktree: boolean(location.isWorktree, 'project worktree state'),
  };
}

function revision(value: unknown, label: string): ProjectCatalogRevision {
  const candidate = requireUtf8String(value, label, 71);
  if (!/^sha256:[a-f0-9]{64}$/.test(candidate)) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return candidate as ProjectCatalogRevision;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalidProtocolFrame(`Invalid ${label}`);
  return value;
}
