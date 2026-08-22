/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectLocation, ProjectRecord } from '@maka/core/project';
import type { SessionHeader } from '@maka/core/session';
import { hasEnclosingGitEntry } from './git-entry.js';
import {
  acquireOperationalStateDatabase,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';
import { normalizeSessionHeader } from './session-store.js';

export type { ProjectLocation, ProjectRecord } from '@maka/core/project';

const execFileAsync = promisify(execFile);

export class ProjectPathMismatchError extends Error {
  readonly name = 'ProjectPathMismatchError';
  readonly code = 'project_path_mismatch';

  constructor(
    readonly projectId: string,
    readonly path: string,
  ) {
    super(`Path does not belong to project ${projectId}: ${path}`);
  }
}

export class ProjectNotFoundError extends Error {
  readonly name = 'ProjectNotFoundError';
  readonly code = 'project_not_found';

  constructor(readonly projectId: string) {
    super(`No such project: ${projectId}`);
  }
}

export class ProjectArchivedError extends Error {
  readonly name = 'ProjectArchivedError';
  readonly code = 'project_archived';

  constructor(readonly projectId: string) {
    super(`Project is archived: ${projectId}`);
  }
}

export class ProjectUnavailableError extends Error {
  readonly name = 'ProjectUnavailableError';
  readonly code = 'project_unavailable';

  constructor(readonly projectId: string) {
    super(`Project is unavailable: ${projectId}`);
  }
}

export class ProjectPathConflictError extends Error {
  readonly name = 'ProjectPathConflictError';
  readonly code = 'project_path_conflict';

  constructor(readonly conflictingProjectId: string) {
    super(`Project path already belongs to project: ${conflictingProjectId}`);
  }
}

export class ProjectPathBoundaryError extends TypeError {
  readonly name = 'ProjectPathBoundaryError';
  readonly code = 'project_path_outside_boundary';

  constructor(readonly path: string) {
    super(`Project path is outside its registration boundary: ${path}`);
  }
}

export function isProjectPathMismatchError(error: unknown): error is ProjectPathMismatchError {
  return error instanceof ProjectPathMismatchError;
}

export interface ProjectCatalog {
  list(): Promise<ProjectRecord[]>;
  register(path: string, options?: ProjectRegistrationOptions): Promise<ProjectRecord>;
  /**
   * Resolve a path recorded by an existing session rather than chosen by the
   * user. Unlike `register`, the directory may already be gone — a session
   * outlives the folder it ran in — so a missing path still yields a stable
   * folder identity instead of failing.
   */
  resolveHistoricalPath(path: string, usedAt?: number): Promise<ProjectRecord>;
  select(projectId: string): Promise<{ project: ProjectRecord; path: string }>;
  touch(projectId: string, path?: string): Promise<ProjectRecord>;
  relink(projectId: string, path: string): Promise<ProjectRecord>;
  relinkWithSessions(
    projectId: string,
    path: string,
  ): Promise<{ project: ProjectRecord; updatedSessionIds: readonly string[] }>;
  rename(projectId: string, name: string): Promise<ProjectRecord>;
  archive(projectId: string): Promise<ProjectRecord>;
  restore(projectId: string): Promise<ProjectRecord>;
  /** Release this catalog's share of the operational database. */
  close(): void;
}

export interface ProjectRegistrationOptions {
  /**
   * Require the final canonical location persisted by the catalog to remain
   * inside this directory. The check happens after path resolution so a
   * pathname replaced between authorization and registration cannot escape
   * its published boundary.
   */
  readonly withinRoot?: string;
}

interface PersistedProject {
  id: string;
  aliases?: string[];
  name: string;
  identity: string;
  locations: PersistedProjectLocation[];
  lastUsedAt: number;
  archivedAt?: number;
}

interface PersistedProjectLocation extends ProjectLocation {
  lastUsedAt: number;
}

interface ProjectCatalogFile {
  schemaVersion: 1;
  projects: PersistedProject[];
}

export function createProjectCatalog(
  storageRoot: string,
  deps: {
    now?: () => number;
    createId?: () => string;
    relinkFailpoint?: (stage: 'after_session_updates') => void;
  } = {},
): ProjectCatalog {
  return new SqliteProjectCatalog(
    acquireOperationalStateDatabase(storageRoot),
    deps.now ?? Date.now,
    deps.createId ?? randomUUID,
    deps.relinkFailpoint,
  );
}

/**
 * The project catalog is operational state: it decides how every session is
 * organized, and it has to survive backup and restore alongside the sessions
 * it groups. Keeping it in its own JSON file left it outside the operational
 * database — and therefore outside `createOperationalStateBackup`, which only
 * captures `runtime.sqlite` plus the Artifact tree.
 *
 * Only the persistence layer moved. Read-modify-write under a serial queue,
 * the whole-catalog validation on every write, and each method's semantics are
 * unchanged, so the catalog contract tests carry over as-is.
 */
class SqliteProjectCatalog implements ProjectCatalog {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly lease: OperationalStateDatabaseLease,
    private readonly now: () => number,
    private readonly createId: () => string,
    private readonly relinkFailpoint?: (stage: 'after_session_updates') => void,
  ) {}

  close(): void {
    this.lease.close();
  }

  async list(): Promise<ProjectRecord[]> {
    const projects = (await this.read()).projects;
    projects.sort(
      (a, b) =>
        Number(a.archivedAt !== undefined) - Number(b.archivedAt !== undefined) ||
        b.lastUsedAt - a.lastUsedAt ||
        a.id.localeCompare(b.id),
    );
    return Promise.all(projects.map((project) => this.present(project)));
  }

  async register(path: string, options?: ProjectRegistrationOptions): Promise<ProjectRecord> {
    const resolved = await resolveUserSelectedProjectLocation(path);
    if (options?.withinRoot && !isPathWithin(options.withinRoot, resolved.canonicalPath)) {
      throw new ProjectPathBoundaryError(resolved.canonicalPath);
    }
    return this.upsertResolvedProject(resolved, this.now());
  }

  async resolveHistoricalPath(path: string, usedAt: number = this.now()): Promise<ProjectRecord> {
    let resolved: ResolvedProjectLocation;
    try {
      resolved = await resolveProjectLocation({ path });
    } catch (error) {
      if (!isUnreachablePathError(error)) throw error;
      let pathIsMissing = false;
      try {
        await stat(path);
      } catch (pathError) {
        pathIsMissing = isUnreachablePathError(pathError);
      }
      if (!pathIsMissing) throw error;
      const canonicalPath = await canonicalizeMissingPath(path);
      resolved = {
        canonicalPath,
        identity: `folder:${canonicalPath}`,
        kind: 'folder',
      };
    }
    return this.upsertResolvedProject(resolved, usedAt);
  }

  private async upsertResolvedProject(
    resolved: ResolvedProjectLocation,
    timestamp: number,
  ): Promise<ProjectRecord> {
    const registered = await this.mutate((file) => {
      const locationPath =
        resolved.kind === 'git' ? resolved.git!.worktreeRoot : resolved.canonicalPath;
      const existing = file.projects.find((project) => project.identity === resolved.identity);
      if (existing) {
        const location = existing.locations.find((item) => item.path === locationPath);
        if (location) {
          location.lastUsedAt = Math.max(location.lastUsedAt, timestamp);
          location.isWorktree = resolved.git?.isWorktree ?? false;
        } else {
          existing.locations.push({
            path: locationPath,
            isWorktree: resolved.git?.isWorktree ?? false,
            lastUsedAt: timestamp,
          });
        }
        existing.lastUsedAt = Math.max(existing.lastUsedAt, timestamp);
        return existing;
      }
      const project: PersistedProject = {
        id: this.createId(),
        name: defaultProjectName(resolved),
        identity: resolved.identity,
        locations: [
          {
            path: locationPath,
            isWorktree: resolved.git?.isWorktree ?? false,
            lastUsedAt: timestamp,
          },
        ],
        lastUsedAt: timestamp,
      };
      file.projects.push(project);
      return project;
    });
    return this.present(registered);
  }

  async select(projectId: string): Promise<{ project: ProjectRecord; path: string }> {
    let selected: PersistedProject | undefined;
    let selectedPath: string | undefined;
    await this.withQueue(async () => {
      // Probing the filesystem cannot happen inside the write transaction, so
      // availability is decided first and the choice is re-validated under it.
      const existing = findProjectById((await this.read()).projects, projectId);
      if (!existing) throw new ProjectNotFoundError(projectId);
      const availablePaths = new Set(
        (
          await Promise.all(
            existing.locations.map(async (location) =>
              (await isDirectory(location.path)) ? location.path : undefined,
            ),
          )
        ).filter((path): path is string => path !== undefined),
      );
      [selected, selectedPath] = await this.mutate((file) => {
        const project = findProjectById(file.projects, projectId);
        if (!project) throw new ProjectNotFoundError(projectId);
        if (project.archivedAt !== undefined) {
          throw new ProjectArchivedError(projectId);
        }
        const location = project.locations
          .filter((item) => availablePaths.has(item.path))
          .sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.path.localeCompare(b.path))[0];
        if (!location) throw new ProjectUnavailableError(projectId);
        const timestamp = this.now();
        location.lastUsedAt = timestamp;
        project.lastUsedAt = timestamp;
        return [project, location.path] as const;
      });
    });
    if (!selected || !selectedPath) throw new Error(`Failed to select project: ${projectId}`);
    return { project: await this.present(selected), path: selectedPath };
  }

  async touch(projectId: string, path?: string): Promise<ProjectRecord> {
    let canonicalPath: string | undefined;
    if (path) {
      try {
        canonicalPath = normalize(await realpath(resolve(path)));
      } catch {
        throw new ProjectUnavailableError(projectId);
      }
    }
    const touched = await this.mutate((file) => {
      const project = findProjectById(file.projects, projectId);
      if (!project) throw new ProjectNotFoundError(projectId);
      const location = canonicalPath
        ? project.locations.find((item) => item.path === canonicalPath)
        : [...project.locations].sort(
            (a, b) => b.lastUsedAt - a.lastUsedAt || a.path.localeCompare(b.path),
          )[0];
      if (canonicalPath && !location) {
        throw new ProjectPathMismatchError(projectId, canonicalPath);
      }
      const timestamp = this.now();
      if (location) location.lastUsedAt = timestamp;
      project.lastUsedAt = timestamp;
      return project;
    });
    return this.present(touched);
  }

  async relink(projectId: string, path: string): Promise<ProjectRecord> {
    const resolved = await resolveUserSelectedProjectLocation(path);
    const timestamp = this.now();
    const locationPath =
      resolved.kind === 'git' ? resolved.git!.worktreeRoot : resolved.canonicalPath;
    const relinked = await this.mutate((file) => {
      const project = findProjectById(file.projects, projectId);
      if (!project) throw new ProjectNotFoundError(projectId);
      const conflict = file.projects.find(
        (item) => item.id !== project.id && item.identity === resolved.identity,
      );
      if (conflict) throw new ProjectPathConflictError(conflict.id);
      return applyRelink(file, project, undefined, resolved, locationPath, timestamp);
    });
    return this.present(relinked);
  }

  async relinkWithSessions(
    projectId: string,
    path: string,
  ): Promise<{ project: ProjectRecord; updatedSessionIds: readonly string[] }> {
    const resolved = await resolveUserSelectedProjectLocation(path);
    const timestamp = this.now();
    const locationPath =
      resolved.kind === 'git' ? resolved.git!.worktreeRoot : resolved.canonicalPath;
    let committed:
      | { readonly project: PersistedProject; readonly updatedSessionIds: readonly string[] }
      | undefined;
    await this.withQueue(async () => {
      committed = this.lease.transaction('write', () => {
        const file = this.selectCatalog();
        const project = findProjectById(file.projects, projectId);
        if (!project) throw new ProjectNotFoundError(projectId);
        const conflict = file.projects.find(
          (item) => item.id !== project.id && item.identity === resolved.identity,
        );
        const context = relinkContext(project, conflict, locationPath);
        const updatedSessionIds = reassignProjectSessions(this.lease, context, timestamp);
        this.relinkFailpoint?.('after_session_updates');
        const relinked = applyRelink(file, project, conflict, resolved, locationPath, timestamp);
        this.replaceCatalog(normalizeProjectCatalogFile(file));
        return {
          project: relinked,
          updatedSessionIds,
        };
      });
    });
    if (!committed) throw new Error(`Failed to relink project and Sessions: ${projectId}`);
    return {
      project: await this.present(committed.project),
      updatedSessionIds: committed.updatedSessionIds,
    };
  }

  async rename(projectId: string, name: string): Promise<ProjectRecord> {
    const trimmed = name.trim();
    if (!trimmed) throw new TypeError('Project name cannot be empty.');
    return this.present(
      await this.mutate((file) => {
        const project = findProjectById(file.projects, projectId);
        if (!project) throw new ProjectNotFoundError(projectId);
        project.name = trimmed;
        return project;
      }),
    );
  }

  async archive(projectId: string): Promise<ProjectRecord> {
    return this.present(
      await this.mutate((file) => {
        const project = findProjectById(file.projects, projectId);
        if (!project) throw new ProjectNotFoundError(projectId);
        project.archivedAt = this.now();
        return project;
      }),
    );
  }

  async restore(projectId: string): Promise<ProjectRecord> {
    return this.present(
      await this.mutate((file) => {
        const project = findProjectById(file.projects, projectId);
        if (!project) throw new ProjectNotFoundError(projectId);
        delete project.archivedAt;
        return project;
      }),
    );
  }

  private async present(project: PersistedProject): Promise<ProjectRecord> {
    const availableLocations = (
      await Promise.all(
        project.locations.map(async (location) => ({
          location,
          available: await isDirectory(location.path),
        })),
      )
    ).filter((entry) => entry.available);
    availableLocations.sort(
      (a, b) =>
        b.location.lastUsedAt - a.location.lastUsedAt ||
        a.location.path.localeCompare(b.location.path),
    );
    const locations = project.locations.map((location) => ({
      path: location.path,
      isWorktree: location.isWorktree,
    }));
    return {
      id: project.id,
      ...(project.aliases ? { aliases: [...project.aliases] } : {}),
      name: project.name,
      locations,
      ...(project.archivedAt !== undefined ? { archivedAt: project.archivedAt } : {}),
      available: availableLocations.length > 0,
      ...(availableLocations[0] ? { preferredPath: availableLocations[0].location.path } : {}),
    };
  }

  private async read(): Promise<ProjectCatalogFile> {
    return this.selectCatalog();
  }

  /**
   * Read, change and rewrite the catalog inside one `BEGIN IMMEDIATE`.
   *
   * The serial queue only orders callers within a process, so a second Maka
   * window reading the catalog between this one's read and write would rewrite
   * the whole table from its own stale copy and silently discard the change —
   * a rename or archive would simply revert. Holding SQLite's write lock across
   * the whole read-modify-write makes the loser wait rather than clobber.
   *
   * Only mutations that are entirely synchronous can run here; `select` and
   * `relink` await the filesystem mid-change and keep the two-phase form.
   */
  private async mutate<T>(change: (file: ProjectCatalogFile) => T): Promise<T> {
    return this.lease.transaction('write', () => {
      const file = this.selectCatalog();
      const result = change(file);
      this.replaceCatalog(normalizeProjectCatalogFile(file));
      return result;
    });
  }

  private selectCatalog(): ProjectCatalogFile {
    return this.lease.transaction('read', () => {
      const database = this.lease.database;
      const locations = new Map<string, PersistedProjectLocation[]>();
      for (const row of database
        .prepare(
          `SELECT project_id, path, is_worktree, last_used_at
           FROM project_locations
           ORDER BY project_id, path`,
        )
        .all() as Array<Record<string, unknown>>) {
        const bucket = locations.get(row.project_id as string) ?? [];
        bucket.push({
          path: row.path as string,
          isWorktree: row.is_worktree === 1,
          lastUsedAt: row.last_used_at as number,
        });
        locations.set(row.project_id as string, bucket);
      }
      const aliases = new Map<string, string[]>();
      for (const row of database
        .prepare('SELECT alias, project_id FROM project_aliases ORDER BY project_id, alias')
        .all() as Array<Record<string, unknown>>) {
        const bucket = aliases.get(row.project_id as string) ?? [];
        bucket.push(row.alias as string);
        aliases.set(row.project_id as string, bucket);
      }
      const projects = (
        database
          .prepare(
            `SELECT project_id, identity, name, last_used_at, archived_at
             FROM projects
             ORDER BY project_id`,
          )
          .all() as Array<Record<string, unknown>>
      ).map((row): PersistedProject => {
        const id = row.project_id as string;
        const projectAliases = aliases.get(id);
        return {
          id,
          ...(projectAliases && projectAliases.length > 0 ? { aliases: projectAliases } : {}),
          name: row.name as string,
          identity: row.identity as string,
          locations: locations.get(id) ?? [],
          lastUsedAt: row.last_used_at as number,
          ...(row.archived_at === null ? {} : { archivedAt: row.archived_at as number }),
        };
      });
      return { schemaVersion: 1, projects };
    });
  }

  private replaceCatalog(file: ProjectCatalogFile): void {
    this.lease.transaction('write', () => {
      const database = this.lease.database;
      // Catalogs are small and every mutation already rewrote the whole file,
      // so a full replace keeps the previous read-modify-write semantics
      // exactly, now with transactional atomicity instead of temp-file rename.
      database.exec('DELETE FROM project_aliases');
      database.exec('DELETE FROM project_locations');
      database.exec('DELETE FROM projects');
      const insertProject = database.prepare(
        `INSERT INTO projects(project_id, identity, name, last_used_at, archived_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      const insertLocation = database.prepare(
        `INSERT INTO project_locations(project_id, path, is_worktree, last_used_at)
         VALUES (?, ?, ?, ?)`,
      );
      const insertAlias = database.prepare(
        'INSERT INTO project_aliases(alias, project_id) VALUES (?, ?)',
      );
      for (const project of file.projects) {
        insertProject.run(
          project.id,
          project.identity,
          project.name,
          project.lastUsedAt,
          project.archivedAt ?? null,
        );
        for (const location of project.locations) {
          insertLocation.run(
            project.id,
            location.path,
            location.isWorktree ? 1 : 0,
            location.lastUsedAt,
          );
        }
        for (const alias of project.aliases ?? []) insertAlias.run(alias, project.id);
      }
    });
  }

  private withQueue(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }
}

function defaultProjectName(location: ResolvedProjectLocation): string {
  if (location.git) {
    const gitName =
      basename(location.git.commonDir) === '.git'
        ? basename(dirname(location.git.commonDir))
        : basename(location.git.commonDir).replace(/\.git$/i, '');
    if (gitName) return gitName;
  }
  return basename(location.canonicalPath) || location.canonicalPath;
}

function normalizeProjectCatalogFile(value: unknown): ProjectCatalogFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid project catalog.');
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !Array.isArray(record.projects)) {
    throw new TypeError('Invalid project catalog.');
  }
  const projects = record.projects.map(normalizePersistedProject);
  const projectIds = projects.flatMap((project) => [project.id, ...(project.aliases ?? [])]);
  if (
    new Set(projectIds).size !== projectIds.length ||
    new Set(projects.map((project) => project.identity)).size !== projects.length
  ) {
    throw new TypeError('Invalid project catalog.');
  }
  return { schemaVersion: 1, projects };
}

function normalizePersistedProject(value: unknown): PersistedProject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid project catalog.');
  }
  const project = value as Record<string, unknown>;
  const aliases =
    project.aliases === undefined
      ? []
      : Array.isArray(project.aliases) && project.aliases.every(isNonEmptyString)
        ? project.aliases
        : undefined;
  if (
    !isNonEmptyString(project.id) ||
    !isNonEmptyString(project.name) ||
    !isNonEmptyString(project.identity) ||
    !Array.isArray(project.locations) ||
    project.locations.length === 0 ||
    !isTimestamp(project.lastUsedAt) ||
    aliases === undefined ||
    new Set(aliases).size !== aliases.length ||
    aliases.includes(project.id as string) ||
    (project.archivedAt !== undefined && !isTimestamp(project.archivedAt))
  ) {
    throw new TypeError('Invalid project catalog.');
  }
  return {
    id: project.id,
    ...(aliases.length > 0 ? { aliases } : {}),
    name: project.name,
    identity: project.identity,
    locations: project.locations.map(normalizeProjectLocation),
    lastUsedAt: project.lastUsedAt,
    ...(project.archivedAt !== undefined ? { archivedAt: project.archivedAt } : {}),
  };
}

function findProjectById(
  projects: readonly PersistedProject[],
  projectId: string,
): PersistedProject | undefined {
  return projects.find(
    (project) => project.id === projectId || project.aliases?.includes(projectId),
  );
}

interface ProjectSessionReassignment {
  readonly projectId: string;
  readonly projectAliases: readonly string[];
  readonly destinationPath: string;
  readonly previousLocations: readonly ProjectLocation[];
  readonly conflictingProjectId?: string;
  readonly conflictingProjectAliases?: readonly string[];
}

function relinkContext(
  project: PersistedProject,
  conflict: PersistedProject | undefined,
  destinationPath: string,
): ProjectSessionReassignment {
  return {
    projectId: project.id,
    projectAliases: [...(project.aliases ?? [])],
    destinationPath,
    previousLocations: project.locations.map((location) => ({ ...location })),
    ...(conflict
      ? {
          conflictingProjectId: conflict.id,
          conflictingProjectAliases: [...(conflict.aliases ?? [])],
        }
      : {}),
  };
}

function applyRelink(
  file: ProjectCatalogFile,
  project: PersistedProject,
  conflict: PersistedProject | undefined,
  resolved: ResolvedProjectLocation,
  locationPath: string,
  timestamp: number,
): PersistedProject {
  if (conflict) {
    project.aliases = [
      ...new Set([...(project.aliases ?? []), conflict.id, ...(conflict.aliases ?? [])]),
    ];
    file.projects = file.projects.filter((item) => item.id !== conflict.id);
  }
  project.identity = resolved.identity;
  project.locations = [
    {
      path: locationPath,
      isWorktree: resolved.git?.isWorktree ?? false,
      lastUsedAt: timestamp,
    },
    ...(conflict?.locations
      .filter((location) => location.path !== locationPath)
      .map((location) => ({ ...location })) ?? []),
  ];
  project.lastUsedAt = Math.max(timestamp, conflict?.lastUsedAt ?? 0);
  return project;
}

function reassignProjectSessions(
  lease: OperationalStateDatabaseLease,
  context: ProjectSessionReassignment,
  committedAt: number,
): readonly string[] {
  const survivingIds = new Set([context.projectId, ...context.projectAliases]);
  const conflictingIds = new Set([
    ...(context.conflictingProjectId ? [context.conflictingProjectId] : []),
    ...(context.conflictingProjectAliases ?? []),
  ]);
  const rows = lease.database
    .prepare(
      `SELECT session_id, payload_json, metadata_version
       FROM session_metadata
       ORDER BY session_id`,
    )
    .all() as Array<{
    session_id: string;
    payload_json: string;
    metadata_version: number;
  }>;
  const update = lease.database.prepare(
    `UPDATE session_metadata
     SET payload_json = ?, metadata_version = ?, committed_at = ?
     WHERE session_id = ? AND metadata_version = ?`,
  );
  const updatedSessionIds: string[] = [];
  for (const row of rows) {
    const header = normalizeSessionHeader(
      JSON.parse(row.payload_json) as SessionHeader,
      row.session_id,
    );
    let patch: Pick<SessionHeader, 'cwd' | 'projectId'> | undefined;
    if (header.projectId && survivingIds.has(header.projectId)) {
      patch = { cwd: context.destinationPath, projectId: context.projectId };
    } else if (header.projectId && conflictingIds.has(header.projectId)) {
      patch = { cwd: header.cwd, projectId: context.projectId };
    }
    if (!patch) continue;
    const next = normalizeSessionHeader({ ...header, ...patch }, row.session_id);
    const nextVersion = row.metadata_version + 1;
    const result = update.run(
      JSON.stringify(next),
      nextVersion,
      committedAt,
      row.session_id,
      row.metadata_version,
    );
    if (result.changes !== 1) {
      throw new Error(`Session metadata compare-and-set failed: ${row.session_id}`);
    }
    updatedSessionIds.push(row.session_id);
  }
  return updatedSessionIds;
}

function normalizeProjectLocation(value: unknown): PersistedProjectLocation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid project catalog.');
  }
  const location = value as Record<string, unknown>;
  if (
    !isNonEmptyString(location.path) ||
    typeof location.isWorktree !== 'boolean' ||
    !isTimestamp(location.lastUsedAt)
  ) {
    throw new TypeError('Invalid project catalog.');
  }
  return {
    path: location.path,
    isWorktree: location.isWorktree,
    lastUsedAt: location.lastUsedAt,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Canonicalize a path that no longer exists.
 *
 * `realpath` fails outright on a missing path, but its job — resolving symlinks
 * — still matters here: on macOS `/tmp` is a link to `/private/tmp`, so naive
 * normalization gives a deleted directory a different identity than the same
 * directory had while it existed, splitting one project in two. Resolving the
 * nearest surviving ancestor and re-appending the missing segments keeps the
 * identity stable across the moment the directory disappears.
 */
async function canonicalizeMissingPath(path: string): Promise<string> {
  const absolute = normalize(resolve(path));
  const missingSegments: string[] = [];
  let candidate = absolute;
  for (;;) {
    try {
      return normalize(join(await realpath(candidate), ...missingSegments));
    } catch (error) {
      if (!isUnreachablePathError(error)) throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) return absolute;
    missingSegments.unshift(basename(candidate));
    candidate = parent;
  }
}

/**
 * A path that cannot be reached, whether because a segment is gone (`ENOENT`)
 * or because one of its ancestors is now a plain file (`ENOTDIR`). Both mean
 * the same thing to a historical working directory: keep walking up.
 */
function isUnreachablePathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export interface ResolvedProjectLocation {
  canonicalPath: string;
  identity: string;
  kind: 'git' | 'folder';
  git?: {
    commonDir: string;
    worktreeRoot: string;
    isWorktree?: boolean;
  };
}

export async function resolveProjectLocation(input: {
  path: string;
}): Promise<ResolvedProjectLocation> {
  const canonicalPath = normalize(await realpath(resolve(input.path)));
  if (!(await hasEnclosingGitEntry(canonicalPath))) {
    return {
      canonicalPath,
      identity: `folder:${canonicalPath}`,
      kind: 'folder',
    };
  }
  const git = await resolveGitLocation(canonicalPath);
  return {
    canonicalPath,
    identity: `git:${git.commonDir}`,
    kind: 'git',
    git,
  };
}

/**
 * A directory the user picked in the add/relink chooser.
 *
 * `resolveProjectLocation` still walks to the enclosing Git worktree so a
 * historical session cwd inside a repository stays on that repository.
 * The chooser must not do that: selecting `repo/child` would otherwise
 * silently become `repo` and reopen the parent project.
 */
async function resolveUserSelectedProjectLocation(path: string): Promise<ResolvedProjectLocation> {
  const resolved = await resolveProjectLocation({ path });
  if (
    resolved.kind !== 'git' ||
    !resolved.git ||
    resolved.canonicalPath === resolved.git.worktreeRoot
  ) {
    return resolved;
  }
  return {
    canonicalPath: resolved.canonicalPath,
    identity: `folder:${resolved.canonicalPath}`,
    kind: 'folder',
  };
}

function isPathWithin(root: string, candidate: string): boolean {
  const path = relative(normalize(root), normalize(candidate));
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

async function resolveGitLocation(
  canonicalPath: string,
): Promise<NonNullable<ResolvedProjectLocation['git']>> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_COMMON_DIR;
  const { stdout: locationOutput } = await execFileAsync(
    'git',
    [
      '-C',
      canonicalPath,
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--git-dir',
      '--git-common-dir',
    ],
    {
      env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      timeout: 3_000,
      windowsHide: true,
    },
  );
  const [worktreeRootRaw, gitDirRaw, commonDirRaw] = locationOutput.trim().split(/\r?\n/);
  if (!worktreeRootRaw || !gitDirRaw || !commonDirRaw) {
    throw new Error(`Git returned an incomplete project location for: ${canonicalPath}`);
  }
  const worktreeRoot = normalize(await realpath(worktreeRootRaw));
  const gitDir = normalize(await realpath(gitDirRaw));
  const commonDir = normalize(await realpath(commonDirRaw));
  return {
    commonDir,
    worktreeRoot,
    isWorktree: gitDir !== commonDir,
  };
}
