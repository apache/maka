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
import { decodeHostPath } from './workspace.js';

export const PROJECT_CATALOG_PAGE_MAX_ITEMS = 64;
export const PROJECT_CATALOG_PAGE_MAX_BYTES = 48 * 1024;
export const PROJECT_CATALOG_CURSOR_MAX_BYTES = 128;
export const PROJECT_CATALOG_NAME_MAX_BYTES = 16 * 1024;
export const PROJECT_CATALOG_PATH_MAX_BYTES = 4 * 1024;
export const PROJECT_DIRECTORY_PAGE_MAX_ITEMS = 128;
export const PROJECT_DIRECTORY_PAGE_MAX_BYTES = 32 * 1024;
export const PROJECT_DIRECTORY_MAX_ENTRIES = 4_096;
export const PROJECT_DIRECTORY_MAX_ROOTS = 8;
export const PROJECT_DIRECTORY_MAX_SEGMENTS = 64;
export const PROJECT_DIRECTORY_ROOT_LABEL_MAX_BYTES = 128;
export const PROJECT_DIRECTORY_SEGMENT_MAX_BYTES = 255;

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

export type ProjectCatalogView = 'summary' | 'locations';

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

export interface ProjectCatalogProjectDetails extends ProjectCatalogProject {
  readonly locations: readonly ProjectCatalogLocation[];
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
      readonly preferredLocationIndex: number | null;
      readonly archivedAt: number | null;
      readonly available: boolean;
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

type ProjectCatalogListQueryInput =
  | { readonly kind: 'list_start'; readonly view: ProjectCatalogView }
  | {
      readonly kind: 'list_continue';
      readonly view: ProjectCatalogView;
      readonly revision: ProjectCatalogRevision;
      readonly cursor: string;
    };

type ProjectCatalogListQueryResult =
  | {
      readonly kind: 'page';
      readonly view: ProjectCatalogView;
      readonly revision: ProjectCatalogRevision;
      readonly projectCount: number;
      readonly items: readonly ProjectCatalogPageItem[];
      readonly nextCursor: string | null;
    }
  | {
      readonly kind: 'revision_changed';
      readonly view: ProjectCatalogView;
      readonly expected: ProjectCatalogRevision;
      readonly actual: ProjectCatalogRevision;
    };

export type ProjectCatalogMutateInput =
  | { readonly kind: 'register'; readonly path: string }
  | ({ readonly kind: 'register_directory' } & ProjectDirectoryRegisterInput)
  | { readonly kind: 'relink'; readonly projectId: string; readonly path: string }
  | { readonly kind: 'rename'; readonly projectId: string; readonly name: string }
  | { readonly kind: 'archive'; readonly projectId: string }
  | { readonly kind: 'restore'; readonly projectId: string };

export type ProjectCatalogMutateResult = {
  readonly kind: 'project';
  readonly project: ProjectCatalogProject;
};

export interface ProjectDirectoryRoot {
  readonly id: string;
  readonly label: string;
}

export interface ProjectDirectoryEntry {
  readonly name: string;
}

export type ProjectDirectoryQueryInput =
  | { readonly kind: 'directory_roots' }
  | {
      readonly kind: 'directory_list_start';
      readonly rootId: string;
      readonly segments: readonly string[];
    }
  | {
      readonly kind: 'directory_list_continue';
      readonly rootId: string;
      readonly segments: readonly string[];
      readonly cursor: string;
    };

export type ProjectDirectoryQueryResult =
  | { readonly kind: 'directory_roots'; readonly roots: readonly ProjectDirectoryRoot[] }
  | {
      readonly kind: 'directory_page';
      readonly rootId: string;
      readonly segments: readonly string[];
      readonly entries: readonly ProjectDirectoryEntry[];
      readonly nextCursor: string | null;
    };

export interface ProjectDirectoryRegisterInput {
  readonly rootId: string;
  readonly segments: readonly string[];
}

export type ProjectCatalogQueryInput = ProjectCatalogListQueryInput | ProjectDirectoryQueryInput;
export type ProjectCatalogQueryResult = ProjectCatalogListQueryResult | ProjectDirectoryQueryResult;

export const PROJECT_CATALOG_OPERATION_SPECS = {
  'project.catalog.query': defineHostPathOperation<
    ProjectCatalogQueryInput,
    ProjectCatalogQueryResult,
    (typeof QUERY_ERRORS)[number]
  >(
    {
      mode: 'query',
      availability: 'ready',
      errors: QUERY_ERRORS,
      decodeInput: decodeProjectCatalogQueryInput,
      decodeOutput: decodeProjectCatalogQueryResult,
      assertOutputForInput: (input, output) => {
        if ('view' in input && (!('view' in output) || input.view !== output.view)) {
          throw invalidProtocolFrame('Project catalog view changed');
        }
        if ('rootId' in input && (!('rootId' in output) || input.rootId !== output.rootId)) {
          throw invalidProtocolFrame('Project directory root changed');
        }
      },
    },
    (input) => 'view' in input && input.view === 'locations',
  ),
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

export function decodeProjectDirectoryQueryInput(value: unknown): ProjectDirectoryQueryInput {
  const record = requireRecord(value, 'project directory query input');
  if (record.kind === 'directory_roots') {
    requireExactRecord(record, 'project directory roots input', ['kind']);
    return { kind: 'directory_roots' };
  }
  if (record.kind === 'directory_list_start') {
    const input = requireExactRecord(record, 'project directory list input', [
      'kind',
      'rootId',
      'segments',
    ]);
    return {
      kind: 'directory_list_start',
      rootId: projectDirectoryRootId(input.rootId),
      segments: projectDirectorySegments(input.segments),
    };
  }
  if (record.kind === 'directory_list_continue') {
    const input = requireExactRecord(record, 'project directory continuation input', [
      'kind',
      'rootId',
      'segments',
      'cursor',
    ]);
    return {
      kind: 'directory_list_continue',
      rootId: projectDirectoryRootId(input.rootId),
      segments: projectDirectorySegments(input.segments),
      cursor: projectDirectorySegment(input.cursor, 'project directory cursor'),
    };
  }
  throw invalidProtocolFrame('Invalid project directory query kind');
}

export function decodeProjectDirectoryQueryResult(value: unknown): ProjectDirectoryQueryResult {
  const record = requireRecord(value, 'project directory query result');
  if (record.kind === 'directory_roots') {
    const result = requireExactRecord(record, 'project directory roots result', ['kind', 'roots']);
    if (!Array.isArray(result.roots) || result.roots.length > PROJECT_DIRECTORY_MAX_ROOTS) {
      throw invalidProtocolFrame('Invalid project directory roots');
    }
    return {
      kind: 'directory_roots',
      roots: result.roots.map((value) => {
        const root = requireExactRecord(value, 'project directory root', ['id', 'label']);
        return {
          id: projectDirectoryRootId(root.id),
          label: projectDirectoryRootLabel(root.label),
        };
      }),
    };
  }
  if (record.kind !== 'directory_page') {
    throw invalidProtocolFrame('Invalid project directory result kind');
  }
  const result = requireExactRecord(record, 'project directory page', [
    'kind',
    'rootId',
    'segments',
    'entries',
    'nextCursor',
  ]);
  if (!Array.isArray(result.entries) || result.entries.length > PROJECT_DIRECTORY_PAGE_MAX_ITEMS) {
    throw invalidProtocolFrame('Invalid project directory entries');
  }
  const decoded: ProjectDirectoryQueryResult = {
    kind: 'directory_page',
    rootId: projectDirectoryRootId(result.rootId),
    segments: projectDirectorySegments(result.segments),
    entries: result.entries.map((value) => {
      const entry = requireExactRecord(value, 'project directory entry', ['name']);
      return { name: projectDirectorySegment(entry.name, 'project directory entry name') };
    }),
    nextCursor:
      result.nextCursor === null
        ? null
        : projectDirectorySegment(result.nextCursor, 'project directory cursor'),
  };
  requireEncodedByteLimit(decoded, 'project directory page', PROJECT_DIRECTORY_PAGE_MAX_BYTES);
  return decoded;
}

function projectDirectoryRootLabel(value: unknown): string {
  const label = requireUtf8String(
    value,
    'project directory root label',
    PROJECT_DIRECTORY_ROOT_LABEL_MAX_BYTES,
  );
  if (label !== label.trim() || /[\u0000-\u001f\u007f]/u.test(label)) {
    throw invalidProtocolFrame('Invalid project directory root label');
  }
  return label;
}

export function decodeProjectDirectoryRegisterInput(value: unknown): ProjectDirectoryRegisterInput {
  const input = requireExactRecord(value, 'project directory register input', [
    'kind',
    'rootId',
    'segments',
  ]);
  if (input.kind !== 'register_directory') {
    throw invalidProtocolFrame('Invalid project directory register kind');
  }
  return {
    rootId: projectDirectoryRootId(input.rootId),
    segments: projectDirectorySegments(input.segments),
  };
}

export function decodeProjectCatalogQueryInput(value: unknown): ProjectCatalogQueryInput {
  const record = requireRecord(value, 'project catalog query input');
  if (typeof record.kind === 'string' && record.kind.startsWith('directory_')) {
    return decodeProjectDirectoryQueryInput(record);
  }
  if (record.kind === 'list_start') {
    const input = requireExactRecord(record, 'project catalog list start input', ['kind', 'view']);
    return { kind: 'list_start', view: projectCatalogView(input.view) };
  }
  if (record.kind === 'list_continue') {
    const input = requireExactRecord(record, 'project catalog list continuation input', [
      'kind',
      'view',
      'revision',
      'cursor',
    ]);
    return {
      kind: 'list_continue',
      view: projectCatalogView(input.view),
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
  if (typeof record.kind === 'string' && record.kind.startsWith('directory_')) {
    return decodeProjectDirectoryQueryResult(record);
  }
  if (record.kind === 'revision_changed') {
    const result = requireExactRecord(record, 'project catalog revision changed result', [
      'kind',
      'view',
      'expected',
      'actual',
    ]);
    return {
      kind: 'revision_changed',
      view: projectCatalogView(result.view),
      expected: revision(result.expected, 'expected project catalog revision'),
      actual: revision(result.actual, 'actual project catalog revision'),
    };
  }
  if (record.kind !== 'page') throw invalidProtocolFrame('Invalid project catalog query result');
  const page = requireExactRecord(record, 'project catalog page result', [
    'kind',
    'view',
    'revision',
    'projectCount',
    'items',
    'nextCursor',
  ]);
  if (!Array.isArray(page.items) || page.items.length > PROJECT_CATALOG_PAGE_MAX_ITEMS) {
    throw invalidProtocolFrame('Invalid project catalog page items');
  }
  const view = projectCatalogView(page.view);
  const decoded: ProjectCatalogQueryResult = {
    kind: 'page',
    view,
    revision: revision(page.revision, 'project catalog revision'),
    projectCount: requireCount(page.projectCount, 'project catalog projectCount'),
    items: page.items.map((item) => decodeProjectCatalogPageItem(item, view)),
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
    case 'register_directory': {
      return {
        kind: 'register_directory',
        ...decodeProjectDirectoryRegisterInput(record),
      };
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

function decodeProjectCatalogPageItem(
  value: unknown,
  view: ProjectCatalogView,
): ProjectCatalogPageItem {
  const record = requireRecord(value, 'project catalog page item');
  if (record.kind === 'project') {
    const item = requireExactRecord(record, 'project catalog header item', [
      'kind',
      'projectIndex',
      'id',
      'name',
      'aliasCount',
      'locationCount',
      'preferredLocationIndex',
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
      preferredLocationIndex:
        item.preferredLocationIndex === null
          ? null
          : requireCount(item.preferredLocationIndex, 'project preferred location index'),
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
  if (record.kind === 'location') {
    if (view !== 'locations') {
      throw invalidProtocolFrame('Project summary contains a Host location');
    }
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

export function decodeProjectCatalogProjectDetails(value: unknown): ProjectCatalogProjectDetails {
  const record = requireExactRecord(value, 'project catalog project details', [
    'id',
    'aliases',
    'name',
    'locationCount',
    'archivedAt',
    'available',
    'locations',
    'preferredPath',
  ]);
  const project = decodeProjectCatalogProject({
    id: record.id,
    aliases: record.aliases,
    name: record.name,
    locationCount: record.locationCount,
    archivedAt: record.archivedAt,
    available: record.available,
  });
  if (!Array.isArray(record.locations) || record.locations.length !== project.locationCount) {
    throw invalidProtocolFrame('Invalid project locations');
  }
  const locations = record.locations.map(decodeProjectLocation);
  if (new Set(locations.map((location) => location.path)).size !== locations.length) {
    throw invalidProtocolFrame('Invalid project locations');
  }
  const preferredPath =
    record.preferredPath === null
      ? null
      : absolutePath(record.preferredPath, 'project preferred path');
  if (
    project.available !== (preferredPath !== null) ||
    (preferredPath !== null && !locations.some((location) => location.path === preferredPath))
  ) {
    throw invalidProtocolFrame('Invalid project preferred location');
  }
  return { ...project, locations, preferredPath };
}

function projectId(value: unknown): string {
  return requireEntityId(value, 'projectId');
}

function projectDirectoryRootId(value: unknown): string {
  return requireEntityId(value, 'project directory root id');
}

function projectDirectorySegments(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > PROJECT_DIRECTORY_MAX_SEGMENTS) {
    throw invalidProtocolFrame('Invalid project directory segments');
  }
  return value.map((segment) => projectDirectorySegment(segment, 'project directory segment'));
}

function projectDirectorySegment(value: unknown, label: string): string {
  const segment = requireUtf8String(value, label, PROJECT_DIRECTORY_SEGMENT_MAX_BYTES);
  if (segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\')) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return segment;
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

function projectCatalogView(value: unknown): ProjectCatalogView {
  if (value !== 'summary' && value !== 'locations') {
    throw invalidProtocolFrame('Invalid project catalog view');
  }
  return value;
}
