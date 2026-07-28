import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, normalize, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectLocation, ProjectRecord } from '@maka/core';
import { hasEnclosingGitEntry } from './git-entry.js';

export type { ProjectLocation, ProjectRecord } from '@maka/core';

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

export function isProjectPathMismatchError(error: unknown): error is ProjectPathMismatchError {
  return error instanceof ProjectPathMismatchError;
}

export interface ProjectRelinkContext {
  projectId: string;
  projectAliases: string[];
  destinationPath: string;
  previousLocations: ProjectLocation[];
  conflictingProjectId?: string;
  conflictingProjectAliases?: string[];
}

export interface ProjectCatalog {
  list(): Promise<ProjectRecord[]>;
  register(path: string): Promise<ProjectRecord>;
  importLegacyPath(path: string, usedAt?: number): Promise<ProjectRecord>;
  select(projectId: string): Promise<{ project: ProjectRecord; path: string }>;
  touch(projectId: string, path?: string): Promise<ProjectRecord>;
  relink(
    projectId: string,
    path: string,
    beforeCommit?: (context: ProjectRelinkContext) => Promise<void>,
  ): Promise<ProjectRecord>;
  rename(projectId: string, name: string): Promise<ProjectRecord>;
  archive(projectId: string): Promise<ProjectRecord>;
  restore(projectId: string): Promise<ProjectRecord>;
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
  } = {},
): ProjectCatalog {
  return new FileProjectCatalog(
    join(storageRoot, 'projects.json'),
    deps.now ?? Date.now,
    deps.createId ?? randomUUID,
  );
}

class FileProjectCatalog implements ProjectCatalog {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly now: () => number,
    private readonly createId: () => string,
  ) {}

  async list(): Promise<ProjectRecord[]> {
    let projects: PersistedProject[] = [];
    await this.withQueue(async () => {
      projects = (await this.read()).projects;
    });
    projects.sort(
      (a, b) =>
        Number(a.archivedAt !== undefined) - Number(b.archivedAt !== undefined) ||
        b.lastUsedAt - a.lastUsedAt ||
        a.id.localeCompare(b.id),
    );
    return Promise.all(projects.map((project) => this.present(project)));
  }

  async register(path: string): Promise<ProjectRecord> {
    const resolved = await resolveProjectLocation({ path });
    return this.upsertResolvedProject(resolved, this.now());
  }

  async importLegacyPath(path: string, usedAt: number = this.now()): Promise<ProjectRecord> {
    let resolved: ResolvedProjectLocation;
    try {
      resolved = await resolveProjectLocation({ path });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      let pathIsMissing = false;
      try {
        await stat(path);
      } catch (pathError) {
        pathIsMissing = (pathError as NodeJS.ErrnoException).code === 'ENOENT';
      }
      if (!pathIsMissing) throw error;
      const canonicalPath = normalize(resolve(path));
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
    let registered: PersistedProject | undefined;
    await this.withQueue(async () => {
      const file = await this.read();
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
        registered = existing;
      } else {
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
        registered = project;
      }
      await this.write(file);
    });
    if (!registered) {
      throw new Error(`Failed to register project: ${resolved.canonicalPath}`);
    }
    return this.present(registered);
  }

  async select(projectId: string): Promise<{ project: ProjectRecord; path: string }> {
    let selected: PersistedProject | undefined;
    let selectedPath: string | undefined;
    await this.withQueue(async () => {
      const file = await this.read();
      const project = findProjectById(file.projects, projectId);
      if (!project) throw new Error(`No such project: ${projectId}`);
      if (project.archivedAt !== undefined) {
        throw new Error(`Project is archived: ${projectId}`);
      }
      const availableLocations = (
        await Promise.all(
          project.locations.map(async (location) => ({
            location,
            available: await isDirectory(location.path),
          })),
        )
      )
        .filter((entry) => entry.available)
        .sort(
          (a, b) =>
            b.location.lastUsedAt - a.location.lastUsedAt ||
            a.location.path.localeCompare(b.location.path),
        );
      const location = availableLocations[0]?.location;
      if (!location) throw new Error(`Project is unavailable: ${projectId}`);
      const timestamp = this.now();
      location.lastUsedAt = timestamp;
      project.lastUsedAt = timestamp;
      selected = project;
      selectedPath = location.path;
      await this.write(file);
    });
    if (!selected || !selectedPath) throw new Error(`Failed to select project: ${projectId}`);
    return { project: await this.present(selected), path: selectedPath };
  }

  async touch(projectId: string, path?: string): Promise<ProjectRecord> {
    const resolved = path ? await resolveProjectLocation({ path }) : undefined;
    const resolvedPath = resolved
      ? resolved.kind === 'git'
        ? resolved.git!.worktreeRoot
        : resolved.canonicalPath
      : undefined;
    let touched: PersistedProject | undefined;
    await this.withQueue(async () => {
      const file = await this.read();
      const project = findProjectById(file.projects, projectId);
      if (!project) throw new Error(`No such project: ${projectId}`);
      const location = resolvedPath
        ? project.locations.find((item) => item.path === resolvedPath)
        : [...project.locations].sort(
            (a, b) => b.lastUsedAt - a.lastUsedAt || a.path.localeCompare(b.path),
          )[0];
      if (resolvedPath && !location) {
        throw new ProjectPathMismatchError(projectId, resolvedPath);
      }
      const timestamp = this.now();
      if (location) location.lastUsedAt = timestamp;
      project.lastUsedAt = timestamp;
      touched = project;
      await this.write(file);
    });
    if (!touched) throw new Error(`Failed to touch project: ${projectId}`);
    return this.present(touched);
  }

  async relink(
    projectId: string,
    path: string,
    beforeCommit?: (context: ProjectRelinkContext) => Promise<void>,
  ): Promise<ProjectRecord> {
    const resolved = await resolveProjectLocation({ path });
    const timestamp = this.now();
    let relinked: PersistedProject | undefined;
    await this.withQueue(async () => {
      const file = await this.read();
      const project = findProjectById(file.projects, projectId);
      if (!project) throw new Error(`No such project: ${projectId}`);
      const conflict = file.projects.find(
        (item) => item.id !== project.id && item.identity === resolved.identity,
      );
      if (conflict && !beforeCommit) {
        throw new Error(`Project path already belongs to project: ${conflict.id}`);
      }
      const locationPath =
        resolved.kind === 'git' ? resolved.git!.worktreeRoot : resolved.canonicalPath;
      await beforeCommit?.({
        projectId: project.id,
        projectAliases: [...(project.aliases ?? [])],
        destinationPath: locationPath,
        previousLocations: project.locations.map((location) => ({ ...location })),
        ...(conflict
          ? {
              conflictingProjectId: conflict.id,
              conflictingProjectAliases: [...(conflict.aliases ?? [])],
            }
          : {}),
      });
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
      relinked = project;
      await this.write(file);
    });
    if (!relinked) throw new Error(`Failed to relink project: ${projectId}`);
    return this.present(relinked);
  }

  async rename(projectId: string, name: string): Promise<ProjectRecord> {
    const trimmed = name.trim();
    if (!trimmed) throw new TypeError('Project name cannot be empty.');
    let renamed: PersistedProject | undefined;
    await this.withQueue(async () => {
      const file = await this.read();
      const project = findProjectById(file.projects, projectId);
      if (!project) throw new Error(`No such project: ${projectId}`);
      project.name = trimmed;
      renamed = project;
      await this.write(file);
    });
    if (!renamed) throw new Error(`Failed to rename project: ${projectId}`);
    return this.present(renamed);
  }

  async archive(projectId: string): Promise<ProjectRecord> {
    let archived: PersistedProject | undefined;
    await this.withQueue(async () => {
      const file = await this.read();
      const project = findProjectById(file.projects, projectId);
      if (!project) throw new Error(`No such project: ${projectId}`);
      const timestamp = this.now();
      project.archivedAt = timestamp;
      archived = project;
      await this.write(file);
    });
    if (!archived) throw new Error(`Failed to archive project: ${projectId}`);
    return this.present(archived);
  }

  async restore(projectId: string): Promise<ProjectRecord> {
    let restored: PersistedProject | undefined;
    await this.withQueue(async () => {
      const file = await this.read();
      const project = findProjectById(file.projects, projectId);
      if (!project) throw new Error(`No such project: ${projectId}`);
      delete project.archivedAt;
      restored = project;
      await this.write(file);
    });
    if (!restored) throw new Error(`Failed to restore project: ${projectId}`);
    return this.present(restored);
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
    try {
      return normalizeProjectCatalogFile(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: 1, projects: [] };
      }
      throw error;
    }
  }

  private async write(file: ProjectCatalogFile): Promise<void> {
    const normalized = normalizeProjectCatalogFile(file);
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    await rename(tempPath, this.path);
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
