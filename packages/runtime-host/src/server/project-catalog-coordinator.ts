import { createHash } from 'node:crypto';
import type { ProjectRecord } from '@maka/core/project';
import {
  ProjectArchivedError,
  type ProjectCatalog,
  ProjectNotFoundError,
  ProjectPathConflictError,
  ProjectPathMismatchError,
  ProjectUnavailableError,
} from '@maka/storage';
import {
  decodeProjectCatalogProject,
  PROJECT_CATALOG_PAGE_MAX_BYTES,
  PROJECT_CATALOG_PAGE_MAX_ITEMS,
  type OperationOutcome,
  type ProjectCatalogMutateInput,
  type ProjectCatalogMutateResult,
  type ProjectCatalogPageItem,
  type ProjectCatalogProject,
  type ProjectCatalogQueryInput,
  type ProjectCatalogQueryResult,
  type ProjectCatalogRevision,
  type ProjectCatalogView,
} from '../protocol/index.js';
import type { ProjectCatalogOperationHandlerMap } from './operation-dispatcher.js';
import type { HostProjectCatalogChangeService } from './project-catalog-change-service.js';
import type { HostProjectMembershipGate } from './project-membership-gate.js';
import type { HostSessionCatalogChangeService } from './session-catalog-change-service.js';

export class HostProjectCatalogCoordinator {
  readonly handlers: ProjectCatalogOperationHandlerMap = {
    'project.catalog.query': (input) => this.#query(input),
    'project.catalog.mutate': (input) => this.#mutate(input),
  };

  constructor(
    private readonly catalog: ProjectCatalog,
    private readonly projectChanges: HostProjectCatalogChangeService,
    private readonly sessionChanges: HostSessionCatalogChangeService,
    private readonly membership: HostProjectMembershipGate,
    private readonly requestDrain: () => void,
  ) {}

  async #query(
    input: ProjectCatalogQueryInput,
  ): Promise<OperationOutcome<'project.catalog.query'>> {
    try {
      const records = await this.catalog.list();
      const items = projectCatalogItems(records, input.view);
      const revision = catalogRevision(items);
      if (input.kind === 'list_continue' && input.revision !== revision) {
        return successQuery({
          kind: 'revision_changed',
          view: input.view,
          expected: input.revision,
          actual: revision,
        });
      }
      const offset = input.kind === 'list_start' ? 0 : decodeCursor(input.cursor);
      if (
        offset === undefined ||
        offset > items.length ||
        (input.kind === 'list_continue' && offset === items.length)
      ) {
        return queryFailure('invalid_request', 'Project catalog cursor is invalid');
      }
      return successQuery(createPage(input.view, revision, records.length, items, offset));
    } catch {
      return queryFailure('persistence_failed', 'Project catalog is unavailable');
    }
  }

  async #mutate(
    input: ProjectCatalogMutateInput,
  ): Promise<OperationOutcome<'project.catalog.mutate'>> {
    try {
      const result = await this.membership.run(() => this.#applyMutation(input));
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
        error instanceof ProjectPathMismatchError
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
      case 'relink': {
        const result = await this.catalog.relinkWithSessions(input.projectId, input.path);
        for (const sessionId of result.updatedSessionIds) this.sessionChanges.publish(sessionId);
        return projectResult(result.project);
      }
      case 'rename':
        return projectResult(await this.catalog.rename(input.projectId, input.name));
      case 'archive':
        return projectResult(await this.catalog.archive(input.projectId));
      case 'restore':
        return projectResult(await this.catalog.restore(input.projectId));
    }
  }
}

function projectResult(project: ProjectRecord): ProjectCatalogMutateResult {
  return { kind: 'project', project: projectProject(project) };
}

function projectProject(project: ProjectRecord): ProjectCatalogProject {
  return decodeProjectCatalogProject({
    id: project.id,
    aliases: [...(project.aliases ?? [])],
    name: project.name,
    locationCount: project.locations.length,
    archivedAt: project.archivedAt ?? null,
    available: project.available,
  });
}

function projectCatalogItems(
  records: readonly ProjectRecord[],
  view: ProjectCatalogView,
): ProjectCatalogPageItem[] {
  return records.flatMap((record, projectIndex): ProjectCatalogPageItem[] => {
    const project = projectProject(record);
    const preferredLocationIndex = record.preferredPath
      ? record.locations.findIndex((location) => location.path === record.preferredPath)
      : -1;
    if (record.preferredPath && preferredLocationIndex < 0) {
      throw new Error('Project preferred location is missing from its catalog record');
    }
    return [
      {
        kind: 'project',
        projectIndex,
        id: project.id,
        name: project.name,
        aliasCount: project.aliases.length,
        locationCount: project.locationCount,
        preferredLocationIndex: preferredLocationIndex < 0 ? null : preferredLocationIndex,
        archivedAt: project.archivedAt,
        available: project.available,
      },
      ...project.aliases.map((alias, itemIndex) => ({
        kind: 'alias' as const,
        projectIndex,
        itemIndex,
        alias,
      })),
      ...(view === 'summary'
        ? []
        : record.locations.map((location, itemIndex) => ({
            kind: 'location' as const,
            projectIndex,
            itemIndex,
            location: { path: location.path, isWorktree: location.isWorktree },
          }))),
    ];
  });
}

function catalogRevision(items: readonly ProjectCatalogPageItem[]): ProjectCatalogRevision {
  return `sha256:${createHash('sha256').update(JSON.stringify(items)).digest('hex')}`;
}

function createPage(
  view: ProjectCatalogView,
  revision: ProjectCatalogRevision,
  projectCount: number,
  items: readonly ProjectCatalogPageItem[],
  offset: number,
): ProjectCatalogQueryResult {
  const pageItems: ProjectCatalogPageItem[] = [];
  for (let index = offset; index < items.length; index += 1) {
    if (pageItems.length >= PROJECT_CATALOG_PAGE_MAX_ITEMS) break;
    const item = items[index];
    if (!item) throw new Error('Project catalog projection index was out of bounds');
    const nextOffset = index + 1;
    const candidate: ProjectCatalogQueryResult = {
      kind: 'page',
      view,
      revision,
      projectCount,
      items: [...pageItems, item],
      nextCursor: nextOffset < items.length ? encodeCursor(nextOffset) : null,
    };
    if (encodedBytes(candidate) > PROJECT_CATALOG_PAGE_MAX_BYTES) break;
    pageItems.push(item);
  }
  if (pageItems.length === 0 && offset < items.length) {
    throw new Error('A Project catalog item exceeds the page byte limit');
  }
  const nextOffset = offset + pageItems.length;
  return {
    kind: 'page',
    view,
    revision,
    projectCount,
    items: pageItems,
    nextCursor: nextOffset < items.length ? encodeCursor(nextOffset) : null,
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
