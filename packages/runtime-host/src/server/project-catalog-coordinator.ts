import { createHash } from 'node:crypto';
import type { ProjectRecord } from '@maka/core';
import {
  ProjectArchivedError,
  type ProjectCatalog,
  ProjectNotFoundError,
  ProjectPathConflictError,
  ProjectPathMismatchError,
  ProjectRelinkContentionError,
  ProjectUnavailableError,
} from '@maka/storage';
import {
  decodeProjectCatalogProject,
  PROJECT_CATALOG_ALIAS_MAX_ITEMS,
  PROJECT_CATALOG_LOCATION_MAX_ITEMS,
  PROJECT_CATALOG_NAME_MAX_BYTES,
  PROJECT_CATALOG_PAGE_MAX_BYTES,
  PROJECT_CATALOG_PAGE_MAX_ITEMS,
  PROJECT_CATALOG_PROJECT_MAX_BYTES,
  type OperationOutcome,
  type ProjectCatalogMutateInput,
  type ProjectCatalogMutateResult,
  type ProjectCatalogProject,
  type ProjectCatalogQueryInput,
  type ProjectCatalogQueryResult,
  type ProjectCatalogRevision,
} from '../protocol/index.js';
import type { ProjectCatalogOperationHandlerMap } from './operation-dispatcher.js';
import type { HostProjectCatalogChangeService } from './project-catalog-change-service.js';
import type { HostSessionCatalogChangeService } from './session-catalog-change-service.js';

interface ProjectSessionCatalog {
  listHeaders(): Promise<
    Array<{ readonly id: string; readonly cwd: string; readonly projectId?: string | null }>
  >;
  updateHeader(
    sessionId: string,
    patch: { readonly cwd?: string; readonly projectId?: string | null },
  ): Promise<unknown>;
}

export class HostProjectCatalogCoordinator {
  readonly handlers: ProjectCatalogOperationHandlerMap = {
    'project.catalog.query': (input) => this.#query(input),
    'project.catalog.mutate': (input) => this.#mutate(input),
  };

  constructor(
    private readonly catalog: ProjectCatalog,
    private readonly sessions: ProjectSessionCatalog,
    private readonly projectChanges: HostProjectCatalogChangeService,
    private readonly sessionChanges: HostSessionCatalogChangeService,
    private readonly requestDrain: () => void,
  ) {}

  async #query(
    input: ProjectCatalogQueryInput,
  ): Promise<OperationOutcome<'project.catalog.query'>> {
    try {
      const projects = (await this.catalog.list()).map(projectProject);
      const revision = catalogRevision(projects);
      if (input.kind === 'list_continue' && input.revision !== revision) {
        return successQuery({
          kind: 'revision_changed',
          expected: input.revision,
          actual: revision,
        });
      }
      const offset = input.kind === 'list_start' ? 0 : decodeCursor(input.cursor);
      if (
        offset === undefined ||
        offset > projects.length ||
        (input.kind === 'list_continue' && offset === projects.length)
      ) {
        return queryFailure('invalid_request', 'Project catalog cursor is invalid');
      }
      return successQuery(createPage(revision, projects, offset));
    } catch {
      return queryFailure('persistence_failed', 'Project catalog is unavailable');
    }
  }

  async #mutate(
    input: ProjectCatalogMutateInput,
  ): Promise<OperationOutcome<'project.catalog.mutate'>> {
    try {
      const result = await this.#applyMutation(input);
      this.projectChanges.publish();
      return { ok: true, result };
    } catch (error) {
      if (error instanceof ProjectNotFoundError) {
        return mutationFailure('not_found', error.message);
      }
      if (
        error instanceof ProjectArchivedError ||
        error instanceof ProjectUnavailableError ||
        error instanceof ProjectPathConflictError ||
        error instanceof ProjectPathMismatchError ||
        error instanceof ProjectRelinkContentionError
      ) {
        return mutationFailure('operation_conflict', error.message);
      }
      if (error instanceof TypeError || isInvalidPathError(error)) {
        return mutationFailure('invalid_request', 'Project catalog input is invalid');
      }
      this.requestDrain();
      return mutationFailure(
        'commit_outcome_unknown',
        'Project catalog mutation outcome is unknown',
      );
    }
  }

  async #applyMutation(input: ProjectCatalogMutateInput): Promise<ProjectCatalogMutateResult> {
    switch (input.kind) {
      case 'register':
        return projectResult(await this.catalog.register(input.path));
      case 'select': {
        const selected = await this.catalog.select(input.projectId);
        return {
          kind: 'selection',
          project: projectProject(selected.project),
          path: selected.path,
        };
      }
      case 'touch':
        return projectResult(
          await this.catalog.touch(input.projectId, input.path === null ? undefined : input.path),
        );
      case 'relink':
        return projectResult(
          await this.catalog.relink(input.projectId, input.path, (context) =>
            this.#reassignRelinkedSessions(context),
          ),
        );
      case 'rename':
        return projectResult(await this.catalog.rename(input.projectId, input.name));
      case 'archive':
        return projectResult(await this.catalog.archive(input.projectId));
      case 'restore':
        return projectResult(await this.catalog.restore(input.projectId));
    }
  }

  async #reassignRelinkedSessions(context: {
    readonly projectId: string;
    readonly projectAliases: readonly string[];
    readonly destinationPath: string;
    readonly conflictingProjectId?: string;
    readonly conflictingProjectAliases?: readonly string[];
  }): Promise<void> {
    const survivingIds = new Set([context.projectId, ...context.projectAliases]);
    const conflictingIds = new Set([
      ...(context.conflictingProjectId ? [context.conflictingProjectId] : []),
      ...(context.conflictingProjectAliases ?? []),
    ]);
    for (const header of await this.sessions.listHeaders()) {
      let patch: { cwd?: string; projectId?: string | null } | undefined;
      if (header.projectId && survivingIds.has(header.projectId)) {
        patch = {
          cwd: context.destinationPath,
          ...(header.projectId === context.projectId ? {} : { projectId: context.projectId }),
        };
      } else if (header.projectId && conflictingIds.has(header.projectId)) {
        patch = { projectId: context.projectId };
      }
      if (!patch) continue;
      await this.sessions.updateHeader(header.id, patch);
      this.sessionChanges.publish(header.id);
    }
  }
}

function projectResult(project: ProjectRecord): ProjectCatalogMutateResult {
  return { kind: 'project', project: projectProject(project) };
}

function projectProject(project: ProjectRecord): ProjectCatalogProject {
  const aliases = [...(project.aliases ?? [])].slice(0, PROJECT_CATALOG_ALIAS_MAX_ITEMS);
  const locations = preferredFirst(project).slice(0, PROJECT_CATALOG_LOCATION_MAX_ITEMS);
  const projection: Mutable<ProjectCatalogProject> = {
    id: project.id,
    aliases,
    aliasesTruncated: aliases.length < (project.aliases?.length ?? 0),
    name: truncateUtf8(project.name, PROJECT_CATALOG_NAME_MAX_BYTES),
    locations,
    locationsTruncated: locations.length < project.locations.length,
    archivedAt: project.archivedAt ?? null,
    available: project.available,
    preferredPath: project.preferredPath ?? null,
  };
  while (encodedBytes(projection) > PROJECT_CATALOG_PROJECT_MAX_BYTES) {
    if (projection.locations.length > 1) {
      projection.locations = projection.locations.slice(0, -1);
      projection.locationsTruncated = true;
      continue;
    }
    if (projection.aliases.length > 0) {
      projection.aliases = projection.aliases.slice(0, -1);
      projection.aliasesTruncated = true;
      continue;
    }
    throw new Error(`Project catalog projection is too large: ${project.id}`);
  }
  return decodeProjectCatalogProject(projection);
}

function preferredFirst(project: ProjectRecord): ProjectRecord['locations'] {
  if (!project.preferredPath) return [...project.locations];
  const preferred = project.locations.find((location) => location.path === project.preferredPath);
  return preferred
    ? [preferred, ...project.locations.filter((location) => location !== preferred)]
    : [...project.locations];
}

function catalogRevision(projects: readonly ProjectCatalogProject[]): ProjectCatalogRevision {
  return `sha256:${createHash('sha256').update(JSON.stringify(projects)).digest('hex')}`;
}

function createPage(
  revision: ProjectCatalogRevision,
  projects: readonly ProjectCatalogProject[],
  offset: number,
): ProjectCatalogQueryResult {
  const pageProjects: ProjectCatalogProject[] = [];
  for (let index = offset; index < projects.length; index += 1) {
    if (pageProjects.length >= PROJECT_CATALOG_PAGE_MAX_ITEMS) break;
    const project = projects[index];
    if (!project) throw new Error('Project catalog projection index was out of bounds');
    const nextOffset = index + 1;
    const candidate: ProjectCatalogQueryResult = {
      kind: 'page',
      revision,
      projects: [...pageProjects, project],
      nextCursor: nextOffset < projects.length ? encodeCursor(nextOffset) : null,
    };
    if (encodedBytes(candidate) > PROJECT_CATALOG_PAGE_MAX_BYTES) break;
    pageProjects.push(project);
  }
  if (pageProjects.length === 0 && offset < projects.length) {
    throw new Error('A Project catalog projection exceeds the page byte limit');
  }
  const nextOffset = offset + pageProjects.length;
  return {
    kind: 'page',
    revision,
    projects: pageProjects,
    nextCursor: nextOffset < projects.length ? encodeCursor(nextOffset) : null,
  };
}

function encodeCursor(offset: number): string {
  return String(offset);
}

function decodeCursor(cursor: string): number | undefined {
  if (!/^(?:0|[1-9]\d*)$/.test(cursor)) return undefined;
  const offset = Number(cursor);
  return Number.isSafeInteger(offset) ? offset : undefined;
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let bytes = 0;
  let result = '';
  for (const character of value) {
    const width = Buffer.byteLength(character, 'utf8');
    if (bytes + width > maxBytes) break;
    result += character;
    bytes += width;
  }
  return result;
}

function isInvalidPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return (
    code === 'EACCES' ||
    code === 'ENOENT' ||
    code === 'ENOTDIR' ||
    code === 'EINVAL' ||
    code === 'EPERM'
  );
}

function successQuery(
  result: ProjectCatalogQueryResult,
): OperationOutcome<'project.catalog.query'> {
  return { ok: true, result };
}

function queryFailure(
  code: 'invalid_request' | 'persistence_failed',
  message: string,
): OperationOutcome<'project.catalog.query'> {
  return { ok: false, error: { code, message } };
}

function mutationFailure(
  code: 'invalid_request' | 'not_found' | 'operation_conflict' | 'commit_outcome_unknown',
  message: string,
): OperationOutcome<'project.catalog.mutate'> {
  return { ok: false, error: { code, message } };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
