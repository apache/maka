import {
  requireCount,
  requireEncodedByteLimit,
  requireEntityId,
  requireExactRecord,
  requireRecord,
  requireUtf8String,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineHostPathOperation } from './operation-spec.js';

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
  readonly locations: readonly ProjectCatalogLocation[];
  readonly archivedAt: number | null;
  readonly available: boolean;
  readonly preferredPath: string | null;
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
      readonly preferredPath: string | null;
    }
  | {
      readonly kind: 'alias';
      readonly projectIndex: number;
      readonly itemIndex: number;
      readonly alias: string;
    }
  | {
      readonly kind: 'location';
      readonly projectIndex: number;
      readonly itemIndex: number;
      readonly location: ProjectCatalogLocation;
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
  | { readonly kind: 'select'; readonly projectId: string }
  | { readonly kind: 'touch'; readonly projectId: string; readonly path: string | null }
  | { readonly kind: 'relink'; readonly projectId: string; readonly path: string }
  | { readonly kind: 'rename'; readonly projectId: string; readonly name: string }
  | { readonly kind: 'archive'; readonly projectId: string }
  | { readonly kind: 'restore'; readonly projectId: string };

export type ProjectCatalogMutateResult =
  | { readonly kind: 'project'; readonly projectId: string }
  | {
      readonly kind: 'selection';
      readonly projectId: string;
      readonly path: string;
    };

export const PROJECT_CATALOG_OPERATION_SPECS = {
  'project.catalog.query': defineHostPathOperation<
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
  'project.catalog.mutate': defineHostPathOperation<
    ProjectCatalogMutateInput,
    ProjectCatalogMutateResult,
    (typeof MUTATE_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATE_ERRORS,
    decodeInput: decodeProjectCatalogMutateInput,
    decodeOutput: decodeProjectCatalogMutateResult,
    assertOutputForInput: (input, output) => {
      if ((input.kind === 'select') !== (output.kind === 'selection')) {
        throw invalidProtocolFrame('Project catalog mutation result kind does not match input');
      }
    },
  }),
} as const;

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
    case 'select':
    case 'archive':
    case 'restore': {
      const input = requireExactRecord(record, `project ${record.kind} input`, [
        'kind',
        'projectId',
      ]);
      return { kind: record.kind, projectId: projectId(input.projectId) };
    }
    case 'touch': {
      const input = requireExactRecord(record, 'project touch input', [
        'kind',
        'projectId',
        'path',
      ]);
      return {
        kind: 'touch',
        projectId: projectId(input.projectId),
        path: input.path === null ? null : absolutePath(input.path, 'project path'),
      };
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
    const result = requireExactRecord(record, 'project mutation result', ['kind', 'projectId']);
    return { kind: 'project', projectId: projectId(result.projectId) };
  }
  if (record.kind === 'selection') {
    const result = requireExactRecord(record, 'project selection result', [
      'kind',
      'projectId',
      'path',
    ]);
    return {
      kind: 'selection',
      projectId: projectId(result.projectId),
      path: absolutePath(result.path, 'selected project path'),
    };
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
      'preferredPath',
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
      preferredPath:
        item.preferredPath === null
          ? null
          : absolutePath(item.preferredPath, 'project preferred path'),
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
  if (record.kind === 'location') {
    const item = requireExactRecord(record, 'project catalog location item', [
      'kind',
      'projectIndex',
      'itemIndex',
      'location',
    ]);
    return {
      kind: 'location',
      projectIndex: requireCount(item.projectIndex, 'project index'),
      itemIndex: requireCount(item.itemIndex, 'project location index'),
      location: decodeProjectLocation(item.location),
    };
  }
  throw invalidProtocolFrame('Invalid project catalog page item kind');
}

export function decodeProjectCatalogProject(value: unknown): ProjectCatalogProject {
  const record = requireExactRecord(value, 'project catalog project', [
    'id',
    'aliases',
    'name',
    'locations',
    'archivedAt',
    'available',
    'preferredPath',
  ]);
  if (!Array.isArray(record.aliases)) throw invalidProtocolFrame('Invalid project aliases');
  if (!Array.isArray(record.locations)) throw invalidProtocolFrame('Invalid project locations');
  const aliases = record.aliases.map(projectId);
  if (new Set(aliases).size !== aliases.length) {
    throw invalidProtocolFrame('Duplicate project aliases');
  }
  const project: ProjectCatalogProject = {
    id: projectId(record.id),
    aliases,
    name: requireUtf8String(record.name, 'project name', PROJECT_CATALOG_NAME_MAX_BYTES),
    locations: record.locations.map(decodeProjectLocation),
    archivedAt:
      record.archivedAt === null ? null : requireCount(record.archivedAt, 'project archivedAt'),
    available: boolean(record.available, 'project available'),
    preferredPath:
      record.preferredPath === null
        ? null
        : absolutePath(record.preferredPath, 'project preferred path'),
  };
  return project;
}

function decodeProjectLocation(value: unknown): ProjectCatalogLocation {
  const item = requireExactRecord(value, 'project location', ['path', 'isWorktree']);
  return {
    path: absolutePath(item.path, 'project location path'),
    isWorktree: boolean(item.isWorktree, 'project location isWorktree'),
  };
}

function projectId(value: unknown): string {
  return requireEntityId(value, 'projectId');
}

function absolutePath(value: unknown, label: string): string {
  const path = requireUtf8String(value, label, PROJECT_CATALOG_PATH_MAX_BYTES);
  const absolute =
    process.platform === 'win32'
      ? /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(path)
      : path.startsWith('/');
  if (!absolute) throw invalidProtocolFrame(`${label} must be absolute`);
  return path;
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
