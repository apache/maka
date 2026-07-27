import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, normalize, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectLocation, ProjectRecord } from '@maka/core';

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

export interface ProjectCatalog {
  list(): Promise<ProjectRecord[]>;
  register(path: string): Promise<ProjectRecord>;
  importLegacyPath(path: string, usedAt?: number): Promise<ProjectRecord>;
  select(projectId: string): Promise<{ project: ProjectRecord; path: string }>;
  touch(projectId: string, path?: string): Promise<ProjectRecord>;
  relink(projectId: string, path: string): Promise<ProjectRecord>;
  rename(projectId: string, name: string): Promise<ProjectRecord>;
  archive(projectId: string): Promise<ProjectRecord>;
  restore(projectId: string): Promise<ProjectRecord>;
}

interface PersistedProject extends Omit<ProjectRecord, 'available' | 'preferredPath'> {
  identity: string;
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
    return this.registerAt(path, this.now());
  }

  private async registerAt(path: string, timestamp: number): Promise<ProjectRecord> {
    const resolved = await resolveProjectLocation({ path });
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
          location.branch = resolved.git?.branch;
          location.isWorktree = resolved.git?.isWorktree ?? false;
        } else {
          existing.locations.push({
            path: locationPath,
            ...(resolved.git?.branch ? { branch: resolved.git.branch } : {}),
            isWorktree: resolved.git?.isWorktree ?? false,
            addedAt: timestamp,
            lastUsedAt: timestamp,
          });
        }
        existing.lastUsedAt = Math.max(existing.lastUsedAt, timestamp);
        existing.updatedAt = Math.max(existing.updatedAt, timestamp);
        registered = existing;
      } else {
        const project: PersistedProject = {
          id: this.createId(),
          name: defaultProjectName(resolved),
          identity: resolved.identity,
          kind: resolved.kind,
          locations: [
            {
              path: locationPath,
              ...(resolved.git?.branch ? { branch: resolved.git.branch } : {}),
              isWorktree: resolved.git?.isWorktree ?? false,
              addedAt: timestamp,
              lastUsedAt: timestamp,
            },
          ],
          createdAt: timestamp,
          updatedAt: timestamp,
          lastUsedAt: timestamp,
        };
        file.projects.push(project);
        registered = project;
      }
      await this.write(file);
    });
    if (!registered) throw new Error(`Failed to register project: ${path}`);
    return this.present(registered);
  }

  async importLegacyPath(path: string, usedAt: number = this.now()): Promise<ProjectRecord> {
    try {
      return await this.registerAt(path, usedAt);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const canonicalPath = normalize(resolve(path));
    const identity = `folder:${canonicalPath}`;
    const timestamp = usedAt;
    let imported: PersistedProject | undefined;
    await this.withQueue(async () => {
      const file = await this.read();
      const existing = file.projects.find((project) => project.identity === identity);
      if (existing) {
        const location = existing.locations.find((item) => item.path === canonicalPath);
        if (location) {
          location.lastUsedAt = Math.max(location.lastUsedAt, timestamp);
        } else {
          existing.locations.push({
            path: canonicalPath,
            isWorktree: false,
            addedAt: timestamp,
            lastUsedAt: timestamp,
          });
        }
        existing.lastUsedAt = Math.max(existing.lastUsedAt, timestamp);
        existing.updatedAt = Math.max(existing.updatedAt, timestamp);
        imported = existing;
      } else {
        const project: PersistedProject = {
          id: this.createId(),
          name: basename(canonicalPath) || canonicalPath,
          identity,
          kind: 'folder',
          locations: [
            {
              path: canonicalPath,
              isWorktree: false,
              addedAt: timestamp,
              lastUsedAt: timestamp,
            },
          ],
          createdAt: timestamp,
          updatedAt: timestamp,
          lastUsedAt: timestamp,
        };
        file.projects.push(project);
        imported = project;
      }
      await this.write(file);
    });
    if (!imported) throw new Error(`Failed to import legacy project: ${path}`);
    return this.present(imported);
  }

  async select(projectId: string): Promise<{ project: ProjectRecord; path: string }> {
    let selected: PersistedProject | undefined;
    let selectedPath: string | undefined;
    await this.withQueue(async () => {
      const file = await this.read();
      const project = file.projects.find((item) => item.id === projectId);
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
      project.updatedAt = timestamp;
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
      const project = file.projects.find((item) => item.id === projectId);
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
      project.updatedAt = timestamp;
      touched = project;
      await this.write(file);
    });
    if (!touched) throw new Error(`Failed to touch project: ${projectId}`);
    return this.present(touched);
  }

  async relink(projectId: string, path: string): Promise<ProjectRecord> {
    const resolved = await resolveProjectLocation({ path });
    const timestamp = this.now();
    let relinked: PersistedProject | undefined;
    await this.withQueue(async () => {
      const file = await this.read();
      const project = file.projects.find((item) => item.id === projectId);
      if (!project) throw new Error(`No such project: ${projectId}`);
      const conflict = file.projects.find(
        (item) => item.id !== projectId && item.identity === resolved.identity,
      );
      if (conflict) throw new Error(`Project path already belongs to project: ${conflict.id}`);
      const locationPath =
        resolved.kind === 'git' ? resolved.git!.worktreeRoot : resolved.canonicalPath;
      project.identity = resolved.identity;
      project.kind = resolved.kind;
      project.locations = [
        {
          path: locationPath,
          ...(resolved.git?.branch ? { branch: resolved.git.branch } : {}),
          isWorktree: resolved.git?.isWorktree ?? false,
          addedAt: timestamp,
          lastUsedAt: timestamp,
        },
      ];
      project.lastUsedAt = timestamp;
      project.updatedAt = timestamp;
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
      const project = file.projects.find((item) => item.id === projectId);
      if (!project) throw new Error(`No such project: ${projectId}`);
      project.name = trimmed;
      project.updatedAt = this.now();
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
      const project = file.projects.find((item) => item.id === projectId);
      if (!project) throw new Error(`No such project: ${projectId}`);
      const timestamp = this.now();
      project.archivedAt = timestamp;
      project.updatedAt = timestamp;
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
      const project = file.projects.find((item) => item.id === projectId);
      if (!project) throw new Error(`No such project: ${projectId}`);
      const timestamp = this.now();
      delete project.archivedAt;
      project.updatedAt = timestamp;
      restored = project;
      await this.write(file);
    });
    if (!restored) throw new Error(`Failed to restore project: ${projectId}`);
    return this.present(restored);
  }

  private async present(project: PersistedProject): Promise<ProjectRecord> {
    const locations = project.locations.map((location) => ({ ...location }));
    const availableLocations = (
      await Promise.all(
        locations.map(async (location) => ({
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
    const { identity: _identity, ...record } = project;
    return {
      ...record,
      locations,
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
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
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
  return basename(location.canonicalPath);
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
  if (
    new Set(projects.map((project) => project.id)).size !== projects.length ||
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
  if (
    !isNonEmptyString(project.id) ||
    !isNonEmptyString(project.name) ||
    !isNonEmptyString(project.identity) ||
    (project.kind !== 'git' && project.kind !== 'folder') ||
    !Array.isArray(project.locations) ||
    project.locations.length === 0 ||
    !isTimestamp(project.createdAt) ||
    !isTimestamp(project.updatedAt) ||
    !isTimestamp(project.lastUsedAt) ||
    (project.archivedAt !== undefined && !isTimestamp(project.archivedAt))
  ) {
    throw new TypeError('Invalid project catalog.');
  }
  return {
    id: project.id,
    name: project.name,
    identity: project.identity,
    kind: project.kind,
    locations: project.locations.map(normalizeProjectLocation),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    lastUsedAt: project.lastUsedAt,
    ...(project.archivedAt !== undefined ? { archivedAt: project.archivedAt } : {}),
  };
}

function normalizeProjectLocation(value: unknown): ProjectLocation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid project catalog.');
  }
  const location = value as Record<string, unknown>;
  if (
    !isNonEmptyString(location.path) ||
    typeof location.isWorktree !== 'boolean' ||
    !isTimestamp(location.addedAt) ||
    !isTimestamp(location.lastUsedAt) ||
    ((location.branch !== undefined || Object.hasOwn(location, 'branch')) &&
      typeof location.branch !== 'string')
  ) {
    throw new TypeError('Invalid project catalog.');
  }
  return {
    path: location.path,
    ...(typeof location.branch === 'string' && location.branch ? { branch: location.branch } : {}),
    isWorktree: location.isWorktree,
    addedAt: location.addedAt,
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
    branch?: string;
    isWorktree?: boolean;
  };
}

export async function resolveProjectLocation(input: {
  path: string;
}): Promise<ResolvedProjectLocation> {
  const canonicalPath = normalize(await realpath(resolve(input.path)));
  const git = await resolveGitLocation(canonicalPath);
  if (git) {
    return {
      canonicalPath,
      identity: `git:${git.commonDir}`,
      kind: 'git',
      git,
    };
  }
  return {
    canonicalPath,
    identity: `folder:${canonicalPath}`,
    kind: 'folder',
  };
}

async function resolveGitLocation(
  canonicalPath: string,
): Promise<NonNullable<ResolvedProjectLocation['git']> | undefined> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_COMMON_DIR;
  try {
    const [{ stdout: locationOutput }, { stdout: branchOutput }] = await Promise.all([
      execFileAsync(
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
      ),
      execFileAsync('git', ['-C', canonicalPath, 'branch', '--show-current'], {
        env,
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
        timeout: 3_000,
        windowsHide: true,
      }),
    ]);
    const [worktreeRootRaw, gitDirRaw, commonDirRaw] = locationOutput.trim().split(/\r?\n/);
    if (!worktreeRootRaw || !gitDirRaw || !commonDirRaw) return undefined;
    const worktreeRoot = normalize(await realpath(worktreeRootRaw));
    const gitDir = normalize(await realpath(gitDirRaw));
    const commonDir = normalize(await realpath(commonDirRaw));
    const branch = branchOutput.trim();
    return {
      commonDir,
      worktreeRoot,
      isWorktree: gitDir !== commonDir,
      ...(branch ? { branch } : {}),
    };
  } catch {
    return undefined;
  }
}
