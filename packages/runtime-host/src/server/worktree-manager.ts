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

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { findProjectByIdentity, type ProjectRecord } from '@maka/core/project';
import type {
  TaskWorktreeSelection,
  WorktreeInfo,
  WorktreeMutation,
  WorktreeMutationResult,
  WorktreeSnapshot,
  WorktreePreparation,
  WorktreeBlocker,
} from '@maka/core/worktree';
import type { WorkspaceTarget } from '../protocol/workspace.js';
import type { ProjectCatalog } from '@maka/storage/project-catalog';
import { isPathInside, realpathAllowMissing } from '@maka/runtime/path-containment';

import { abortable } from '../client/wait-for-ready.js';
import { parseWorktreeName, type WorktreeName } from './worktree-naming.js';

import {
  assertGitWorktree,
  commonDirectory,
  git,
  listGitWorktrees,
  projectDirectoryName,
  runScript,
  validateConfig,
  WORKTREE_LOG_LIMIT,
} from './worktree-git.js';
import {
  interruptWorktree,
  readWorktreeState,
  worktreeInitialization,
  worktreeBlocker,
  type ManagedWorktree,
  type WorktreeState,
} from './worktree-state.js';
interface WorktreeSession {
  id: string;
  cwd: string;
  projectId?: string | null;
}
export interface HostWorktreeManagerOptions {
  stateRoot: string;
  catalog: Pick<ProjectCatalog, 'list' | 'register'>;
  listSessions(): Promise<readonly WorktreeSession[]>;
  isSessionActive(sessionId: string): boolean;
  hasLiveSessionResources(sessionId: string): Promise<boolean>;
  generateName(description: string): Promise<WorktreeName | undefined>;
  withSessions<T>(ids: readonly string[], operation: () => Promise<T>): Promise<T>;
  changed(): void;
  requestDrain?(): void;
}

/** The Host owns the journal, Git operations and script lifecycle together. */
export class HostWorktreeManager {
  private state?: WorktreeState;
  private readonly shutdown = new AbortController();
  private readonly preparations = new Map<
    string,
    {
      projectId: string;
      controller: AbortController;
      resolving: boolean;
      settled: Promise<void>;
      settle(): void;
    }
  >();
  beginDrain(): void {
    this.shutdown.abort();
  }
  async close(): Promise<void> {
    this.beginDrain();
    await Promise.all(this.lanes.values());
  }
  private loading?: Promise<WorktreeState>;
  // Checkout operations exclude only work on that checkout. Repository creation
  // reserves names independently; journal writes never wait for Git or scripts.
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly cleanupConfirmations = new Map<
    string,
    { path: string; head: string; expiresAt: number }
  >();
  private readonly file: string;
  constructor(private readonly options: HostWorktreeManagerOptions) {
    this.file = join(options.stateRoot, 'worktrees.json');
  }
  private async read(): Promise<WorktreeState> {
    if (this.state) return this.state;
    this.loading ??= (async () => {
      try {
        const state = readWorktreeState(await readFile(this.file, 'utf8'));
        // Git may have finished before the checked_out journal write. Reconcile
        // once on load so Settings can recover even if the original caller never
        // replays its create request. Partial checkouts remain fenced off.
        for (const item of state.worktrees) {
          if (item.phase !== 'reserved') continue;
          try {
            await assertGitWorktree(item.path, item.commonDir);
            const entry = (await listGitWorktrees(item.path)).find((w) => w.path === item.path);
            if (entry && (await this.checkoutComplete(item, entry))) {
              item.phase = 'checked_out';
              interruptWorktree(item);
            }
          } catch {
            // Missing or unverifiable checkouts require creation to be retried.
          }
        }
        return state;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return {
          version: 2,
          config: { rootDirectory: join(homedir(), '.maka', 'worktrees'), projects: {} },
          projectDirectories: {},
          worktrees: [],
          bindings: Object.create(null),
          preparationDecisions: Object.create(null),
        } satisfies WorktreeState;
      }
    })();
    this.state = await this.loading;
    return this.state;
  }
  private save(): Promise<void> {
    return this.queue('journal', async () => {
      const state = await this.read();
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600, flush: true });
        await rename(temporary, this.file);
      } catch (error) {
        this.beginDrain();
        this.options.requestDrain?.();
        throw error;
      }
      this.options.changed();
    });
  }
  private queue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const task = (this.lanes.get(key) ?? Promise.resolve()).then(operation);
    const tail = task.then(
      () => {},
      () => {},
    );
    this.lanes.set(key, tail);
    void tail.then(() => {
      if (this.lanes.get(key) === tail) this.lanes.delete(key);
    });
    return task;
  }
  private run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    return this.queue(key, () => {
      if (this.shutdown.signal.aborted) throw new Error('Worktree manager is shutting down');
      return operation();
    });
  }
  private async project(id: string): Promise<ProjectRecord> {
    const project = findProjectByIdentity(await this.options.catalog.list(), id);
    if (
      !project ||
      project.archivedAt !== undefined ||
      !project.available ||
      !project.preferredPath
    )
      throw new Error('Project is unavailable');
    return project;
  }
  async snapshot(projectId?: string): Promise<WorktreeSnapshot> {
    const state = await this.read();
    const projects = (await this.options.catalog.list()).filter(
      (p) =>
        p.archivedAt === undefined &&
        (!projectId || p.id === projectId || p.aliases?.includes(projectId)),
    );
    const sessionCounts = new Map<string, number>();
    for (const session of await this.options.listSessions()) {
      sessionCounts.set(session.cwd, (sessionCounts.get(session.cwd) ?? 0) + 1);
    }
    const result: WorktreeSnapshot['projects'] = [];
    for (const project of projects) {
      if (!project.available || !project.preferredPath) continue;
      try {
        const entries = await this.projectWorktrees(project);
        // A repository without its first commit cannot create worktrees.
        await git(project.preferredPath, ['rev-parse', '--verify', 'HEAD']);
        const known = new Map<string, ManagedWorktree>();
        for (const item of state.worktrees) {
          if (
            item.phase !== 'removed' &&
            findProjectByIdentity([project], item.projectId) &&
            !known.has(item.path)
          )
            known.set(item.path, item);
        }
        // Preserve Git's order, then append missing checkouts in journal order.
        const listedPaths = new Set(entries.map((entry) => entry.path));
        for (const item of known.values()) {
          if (!listedPaths.has(item.path))
            entries.push({
              path: item.path,
              head: item.baseCommit,
              isMain: false,
              locked: false,
              branch: item.branch,
            });
        }
        const worktrees: WorktreeInfo[] = [];
        for (const entry of entries) {
          const managed = known.get(entry.path);
          if (!managed) continue;
          let available = false;
          try {
            await assertGitWorktree(entry.path, managed.commonDir);
            available =
              (await stat(entry.path)).isDirectory() &&
              (await commonDirectory(entry.path)) ===
                (await commonDirectory(project.preferredPath));
          } catch {
            /* Missing checkouts remain visible. */
          }
          worktrees.push({
            ...entry,
            operationId: managed.operationId,
            projectId: project.id,
            name: basename(entry.path),
            managed: true,
            available,
            sessionCount: sessionCounts.get(entry.path) ?? 0,
            initialization: worktreeInitialization(managed),
            log: managed.log,
          });
        }
        result.push({
          id: project.id,
          name: project.name,
          mainPath: entries.find((w) => w.isMain)?.path ?? project.preferredPath,
          config: { ...projectValue(project, state.config.projects) },
          worktrees,
        });
      } catch {
        /* Ordinary directories and unborn repositories have no worktree controls. */
      }
    }
    return { config: structuredClone(state.config), projects: result };
  }
  async mainPath(projectId: string): Promise<string> {
    const project = await this.project(projectId);
    let path = project.preferredPath!;
    try {
      path = (await this.projectWorktrees(project))[0]?.path ?? path;
    } catch {
      return path;
    }
    if (!project.locations.some((location) => location.path === path))
      await this.options.catalog.register(path, { prefer: false });
    return path;
  }
  private async projectWorktrees(project: ProjectRecord) {
    const path = await realpath(project.preferredPath!);
    const entries = await listGitWorktrees(path);
    // Selected subdirectories are independent folder projects, even when Git
    // can discover an enclosing repository from inside them.
    if (!entries.some((entry) => entry.path === path))
      throw new Error('Project directory is not a Git worktree root');
    return entries;
  }
  /** Shared source validation for capability queries and actual creation. */
  private async sourcePath(project: ProjectRecord, path: string): Promise<string> {
    const canonical = await realpath(path);
    const listed = await this.projectWorktrees(project);
    if (
      !listed.some((item) => item.path === canonical && !item.locked) ||
      (await commonDirectory(canonical)) !== (await commonDirectory(project.preferredPath!))
    )
      throw new Error('Worktree does not belong to this project or is locked');
    await git(canonical, ['rev-parse', '--verify', 'HEAD']);
    return canonical;
  }
  async canCreateFrom(projectId: string | null | undefined, path: string): Promise<boolean> {
    if (!projectId) return false;
    try {
      await this.sourcePath(await this.project(projectId), path);
      return true;
    } catch {
      return false;
    }
  }
  async validatePath(projectId: string, path: string): Promise<string> {
    const project = await this.project(projectId);
    // A Session pins its working directory even for non-Git projects and
    // unborn repositories. Only additional checkouts require Git membership.
    const requested = await realpath(path);
    if (requested === (await realpath(await this.mainPath(projectId)))) {
      if (!(await stat(requested)).isDirectory())
        throw new Error('Project directory is unavailable');
      return requested;
    }
    const canonical = await this.sourcePath(project, path);
    if (!project.locations.some((location) => location.path === canonical))
      await this.options.catalog.register(canonical, { prefer: false });
    return canonical;
  }
  async bind(sessionId: string, path: string): Promise<void> {
    await this.withWorkspaceCheckouts(path, async () => {
      const state = await this.read();
      if (!(await stat(path)).isDirectory()) throw new Error('Session worktree is unavailable');
      for (const managed of state.worktrees.filter((item) => isPathInside(item.path, path))) {
        if (managed.phase === 'removed') throw new Error('Session worktree has been removed');
        await assertGitWorktree(managed.path, managed.commonDir);
      }
      let commonDir: string | undefined;
      try {
        commonDir = await commonDirectory(path);
      } catch {
        /* Non-Git project directories are also fixed. */
      }
      // Keep the enclosing Git root even for folder projects. Repository discovery
      // must never silently move up to a parent checkout after metadata is lost.
      const gitRoot = commonDir
        ? await realpath((await git(path, ['rev-parse', '--show-toplevel'])).trim())
        : undefined;
      // Check after filesystem awaits: competing bindings must never overwrite
      // the first path, even when they acquired different checkout lanes.
      const previous = state.bindings[sessionId];
      if (previous && previous.path !== path)
        throw new Error('Session worktree bindings cannot be changed');
      if (!previous) {
        state.bindings[sessionId] = {
          path,
          ...(commonDir ? { commonDir, gitRoot } : {}),
        };
        await this.save();
      }
    });
  }
  async isBound(sessionId: string): Promise<boolean> {
    return Boolean((await this.read()).bindings[sessionId]);
  }
  async assertReady(sessionId: string, cwd: string): Promise<void> {
    // Absolute-path Sessions can arrive after cleanup collected its Session
    // gates. Serialize admission with checkout mutations so those new Sessions
    // revalidate the directory after cleanup instead of running inside it.
    return this.withWorkspaceCheckouts(cwd, () => this.assertCheckoutReady(sessionId, cwd));
  }
  private async withWorkspaceCheckouts<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
    const state = await this.read();
    // Folder projects and absolute-path Sessions can use any subdirectory.
    // Acquire ancestors first, including nested managed checkouts, so deletion
    // of either checkout cannot race admission into the contained workspace.
    const paths = [
      ...new Set([
        cwd,
        ...state.worktrees.filter((item) => isPathInside(item.path, cwd)).map((item) => item.path),
      ]),
    ].sort();
    const acquire = (index: number): Promise<T> =>
      index === paths.length
        ? operation()
        : this.run(`checkout:${paths[index]}`, () => acquire(index + 1));
    return acquire(0);
  }
  private async assertCheckoutReady(sessionId: string, cwd: string): Promise<void> {
    const state = await this.read();
    const binding = state.bindings[sessionId];
    const path = binding?.path;
    if (path && path !== cwd) throw new Error('Session worktree binding has changed');
    if (!(await stat(cwd)).isDirectory()) throw new Error('Session worktree is unavailable');
    const items = state.worktrees.filter((item) => isPathInside(item.path, cwd));
    for (const item of items) {
      if (item.phase === 'removed') throw new Error('Session worktree has been removed');
      if (worktreeBlocker(item))
        throw new Error(
          'Worktree initialization has not completed. Retry or continue without initialization in Worktree settings.',
        );
    }
    if (binding?.commonDir && (await commonDirectory(cwd)) !== binding.commonDir)
      throw new Error('Session worktree identity has changed');
    if (
      binding?.gitRoot &&
      (await realpath((await git(cwd, ['rev-parse', '--show-toplevel'])).trim())) !==
        binding.gitRoot
    )
      throw new Error('Session worktree identity has changed');
    for (const item of items) await assertGitWorktree(item.path, item.commonDir);
  }
  async workspaceBlocker(path: string): Promise<WorktreeBlocker | undefined> {
    return worktreeBlocker((await this.read()).worktrees.find((item) => item.path === path));
  }
  async preparation(operationId: string): Promise<WorktreePreparation> {
    const item = (await this.read()).worktrees.find((item) => item.operationId === operationId);
    if (!item)
      return {
        phase:
          this.preparations.has(operationId) || this.lanes.has(`creation:${operationId}`)
            ? 'preparing'
            : 'inactive',
      };
    switch (item.phase) {
      case 'removed':
        return { phase: 'inactive' };
      case 'reserved':
      case 'checked_out':
        return { phase: 'checkout', path: item.path };
      case 'initializing':
        return { phase: 'initializing', path: item.path };
      case 'failed':
        return { phase: 'blocked', path: item.path };
      case 'ready':
      case 'skipped':
        return { phase: 'finalizing', path: item.path };
    }
  }
  async defaultMode(projectId: string): Promise<'main' | 'new'> {
    return (
      projectValue(await this.project(projectId), (await this.read()).config.projects)
        ?.defaultMode ?? 'main'
    );
  }
  async mutate(input: WorktreeMutation): Promise<WorktreeMutationResult> {
    if (input.kind === 'remove') {
      // Acquire session gates before the checkout lane. Bindings are journaled
      // before session creation, so they also fence sessions not yet catalogued.
      // A binding admitted during gate acquisition requires a fresh gate set.
      const boundSessions = async () =>
        new Set([
          ...(await this.options.listSessions())
            .filter((s) => isPathInside(input.path, s.cwd))
            .map((s) => s.id),
          ...Object.entries((await this.read()).bindings)
            .filter(([, binding]) => isPathInside(input.path, binding.path))
            .map(([id]) => id),
        ]);
      for (;;) {
        const ids = await boundSessions();
        const operation = () =>
          this.run(`checkout:${input.path}`, async () => {
            if ([...(await boundSessions())].some((id) => !ids.has(id))) return undefined;
            return this.remove(input);
          });
        const result = ids.size
          ? await this.options.withSessions([...ids], operation)
          : await operation();
        if (result) return result;
      }
    }
    switch (input.kind) {
      case 'resolve_preparation': {
        const project = await this.project(input.projectId);
        const pending = this.preparations.get(input.operationId);
        const state = await this.read();
        const previous = state.preparationDecisions[input.operationId];
        if (
          previous &&
          findProjectByIdentity([project], previous.projectId) &&
          previous.decision === input.decision
        ) {
          if (pending?.resolving) await pending.settled;
          this.shutdown.signal.throwIfAborted();
          return { kind: 'preparation_resolved' };
        }
        if (
          !pending ||
          this.preparations.get(input.operationId) !== pending ||
          !findProjectByIdentity([project], pending.projectId) ||
          pending.resolving
        )
          throw new Error('Worktree preparation has already finished');
        pending.resolving = true;
        try {
          state.preparationDecisions[input.operationId] = {
            projectId: project.id,
            decision: input.decision,
          };
          await this.save();
          pending.controller.abort();
          return { kind: 'preparation_resolved' };
        } finally {
          pending.settle();
        }
      }
      case 'configure':
        return this.run('configuration', async () => {
          const state = await this.read();
          const config = validateConfig(input.config);
          if (input.projectId) {
            const project = await this.project(input.projectId);
            state.config.projects[project.id] = config;
          } else {
            if (!config.rootDirectory) throw new Error('Host worktree root is required');
            state.config.rootDirectory = config.rootDirectory;
          }
          await this.save();
          return { kind: 'configured' };
        });
      case 'create':
        return { kind: 'worktree', worktree: await this.createWorktree(input) };
      case 'initialize':
        return this.withWorkspaceCheckouts(input.path, async () => {
          await this.assertManagedAncestors(input.path, false);
          const item = await this.managed(input.projectId, input.path);
          await this.initialize(item, input.skip);
          return { kind: 'worktree', worktree: await this.info(item) };
        });
    }
  }
  async prepareTask(
    projectId: string,
    selection: TaskWorktreeSelection | undefined,
    operationId: string,
    description: string,
  ): Promise<WorkspaceTarget> {
    const project = await this.project(projectId);
    const choice = selection ?? { kind: await this.defaultMode(project.id) };
    const target = { kind: 'project' as const, projectId: project.id };
    switch (choice.kind) {
      case 'main':
        return target;
      case 'existing':
        return { ...target, worktreePath: choice.path };
      case 'new': {
        const state = await this.read();
        const resolveDecision = async (): Promise<WorkspaceTarget | undefined> => {
          const choice = state.preparationDecisions[operationId];
          if (!choice) return undefined;
          const current = await this.project(project.id);
          if (!findProjectByIdentity([current], choice.projectId))
            throw new Error('Preparation belongs to another project');
          if (choice.decision === 'cancel') throw new Error('Worktree preparation was cancelled');
          return { ...target, projectId: current.id };
        };
        const resolved = await resolveDecision();
        if (resolved) return resolved;
        if (this.preparations.has(operationId))
          throw new Error('Worktree preparation is already running');
        let settle!: () => void;
        const pending = {
          projectId: project.id,
          controller: new AbortController(),
          resolving: false,
          settled: new Promise<void>((resolve) => {
            settle = resolve;
          }),
          settle: () => settle(),
        };
        this.preparations.set(operationId, pending);
        const signal = AbortSignal.any([pending.controller.signal, this.shutdown.signal]);
        try {
          const checkout = await abortable(
            () =>
              this.createWorktree(
                {
                  kind: 'create',
                  projectId: project.id,
                  operationId,
                  description,
                },
                signal,
              ),
            signal,
          ).catch((error: unknown) => {
            if (!pending.controller.signal.aborted) throw error;
            return undefined;
          });
          // A decision wins even when checkout finishes while its journal write is pending.
          if (pending.resolving) await pending.settled;
          this.shutdown.signal.throwIfAborted();
          const resolved = await resolveDecision();
          if (resolved) return resolved;
          if (!checkout) throw new Error('Worktree preparation was interrupted');
          return { ...target, worktreePath: checkout.path };
        } finally {
          this.preparations.delete(operationId);
        }
      }
    }
  }
  createWorktree(
    input: Extract<WorktreeMutation, { kind: 'create' }>,
    signal?: AbortSignal,
  ): Promise<WorktreeInfo> {
    return this.run(`creation:${input.operationId}`, async () => {
      const combined = signal
        ? AbortSignal.any([signal, this.shutdown.signal])
        : this.shutdown.signal;
      const item = await this.reserve(input, combined);
      return this.withCheckout(item, async () => {
        // Repository mutation ends before registration or user setup scripts.
        await this.run(`repository:${item.commonDir}`, () => this.checkout(item, combined));
        await this.options.catalog.register(item.path, { prefer: false });
        combined.throwIfAborted();
        if (item.phase === 'checked_out') await this.initialize(item, false, combined);
        return this.info(item);
      });
    });
  }
  private withCheckout<T>(item: ManagedWorktree, operation: () => Promise<T>): Promise<T> {
    return this.withWorkspaceCheckouts(item.path, async () => {
      try {
        await this.assertManagedAncestors(item.path, false);
        return await operation();
      } catch (error) {
        if (interruptWorktree(item)) await this.save();
        throw error;
      }
    });
  }
  private async reserve(
    input: Extract<WorktreeMutation, { kind: 'create' }>,
    signal?: AbortSignal,
  ): Promise<ManagedWorktree> {
    signal?.throwIfAborted();
    const state = await this.read();
    const project = await this.project(input.projectId);
    let item = state.worktrees.find((w) => w.operationId === input.operationId);
    if (item && (!findProjectByIdentity([project], item.projectId) || item.phase === 'removed'))
      throw new Error('Worktree operation identity is already in use');
    if (!item) {
      const source = await this.sourcePath(
        project,
        input.sourcePath ?? (await this.mainPath(project.id)),
      );
      const baseCommit = (await git(source, ['rev-parse', '--verify', 'HEAD'])).trim();
      const commonDir = await commonDirectory(source);
      let name: WorktreeName | undefined;
      try {
        const generated = await abortable(
          () => this.options.generateName(input.description),
          signal ?? this.shutdown.signal,
        );
        if (generated) name = parseWorktreeName(`${generated.type}/${generated.slug}`);
      } catch {
        /* Naming failure deliberately creates a detached checkout. */
      }
      signal?.throwIfAborted();
      const config = projectValue(project, state.config.projects);
      const root = await realpathAllowMissing(config?.rootDirectory || state.config.rootDirectory);
      const parent = await this.withWorkspaceCheckouts(root, async () => {
        await this.assertManagedAncestors(root, true);
        return this.run('directories', () => this.projectDirectory(project, root));
      });
      item = await this.run(`repository:${commonDir}`, async () => {
        signal?.throwIfAborted();
        const target = await this.worktreeTarget(source, commonDir, parent, name);
        const reserved: ManagedWorktree = {
          operationId: input.operationId,
          projectId: project.id,
          ...target,
          commonDir,
          sourcePath: source,
          baseCommit,
          phase: 'reserved',
          log: '',
        };
        state.worktrees.push(reserved);
        await this.save();
        return reserved;
      });
    }
    return item;
  }
  private async checkout(item: ManagedWorktree, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const source = await this.mainPath(item.projectId);
    if ((await commonDirectory(source)) !== item.commonDir)
      throw new Error('Project repository identity has changed');
    if (item.phase === 'reserved') {
      const worktrees = await listGitWorktrees(source);
      const existing = worktrees.find((w) => w.path === item.path);
      if (existing) {
        if (!(await this.checkoutComplete(item, existing)))
          throw new Error(
            'Interrupted worktree creation conflicts with an incomplete or changed checkout',
          );
        // The checkout predates this attempt: a Host exit lost the checked_out
        // journal write. Preserve it for explicit recovery, never auto-run setup.
        item.phase = 'checked_out';
        interruptWorktree(item);
        await this.save();
        return;
      } else {
        try {
          await stat(item.path);
          throw new Error('Worktree destination already exists');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await mkdir(dirname(item.path), { recursive: true });
        // Git can create the branch before checkout fails (for example in a
        // smudge filter). Reuse that reservation without resetting any ref.
        let branchExists = false;
        if (item.branch) {
          const head = await git(source, [
            'rev-parse',
            '--verify',
            '--quiet',
            `refs/heads/${item.branch}`,
          ]).catch((error: unknown) => {
            if ((error as { code?: unknown }).code === 1) return '';
            throw error;
          });
          branchExists = head.trim().length > 0;
          if (
            branchExists &&
            (head.trim() !== item.baseCommit || worktrees.some((w) => w.branch === item.branch))
          )
            throw new Error('Reserved branch has changed or is already checked out');
        }
        try {
          await git(
            source,
            [
              'worktree',
              'add',
              ...(item.branch ? (branchExists ? [] : ['-b', item.branch]) : ['--detach']),
              item.path,
              branchExists ? item.branch! : item.baseCommit,
            ],
            { timeoutMs: 0, abortSignal: signal ?? this.shutdown.signal },
          );
        } catch (error) {
          // A post-checkout hook can fail after Git has populated the checkout.
          // Keep it recoverable, without admitting a genuinely partial checkout.
          const created = (await listGitWorktrees(source).catch(() => [])).find(
            (entry) => entry.path === item.path,
          );
          if (created && (await this.checkoutComplete(item, created))) {
            item.phase = 'failed';
            item.log = (error instanceof Error ? error.message : String(error)).slice(
              -WORKTREE_LOG_LIMIT,
            );
            await this.save();
          }
          throw error;
        }
      }
      item.phase = 'checked_out';
      await this.save();
    }
  }
  private async checkoutComplete(
    item: ManagedWorktree,
    entry: Pick<WorktreeInfo, 'head' | 'branch'>,
  ): Promise<boolean> {
    if (entry.head !== item.baseCommit || entry.branch !== item.branch) return false;
    try {
      if ((await commonDirectory(item.path)) !== item.commonDir) return false;
      const index = (
        await git(item.path, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])
      ).trim();
      if (!(await stat(index)).isFile()) return false;
      // Fresh checkouts publish their index after populating the files. Hooks
      // may then edit or stage files, so a valid but dirty index is also safe.
      await git(item.path, ['diff', '--cached', '--quiet', item.baseCommit, '--']).catch(
        (error: unknown) => {
          if ((error as { code?: unknown }).code !== 1) throw error;
        },
      );
      return true;
    } catch {
      return false;
    }
  }
  private async worktreeTarget(
    source: string,
    commonDir: string,
    parent: string,
    name: WorktreeName | undefined,
  ): Promise<{ path: string; branch?: string }> {
    if (!name) return { path: join(parent, randomBytes(4).toString('hex')) };
    const state = await this.read();
    // Generated refs have exactly two segments. A deeper ref occupies the
    // same type/slug, so index that prefix once instead of scanning every retry.
    const branches = new Set(
      [
        ...(await git(source, ['for-each-ref', '--format=%(refname:strip=2)', 'refs/heads']))
          .trim()
          .split('\n')
          .filter(Boolean),
        ...state.worktrees
          .filter(
            (item) => item.commonDir === commonDir && item.phase === 'reserved' && item.branch,
          )
          .map((item) => item.branch!),
      ].map((branch) => branch.split('/', 2).join('/').toLowerCase()),
    );
    const occupied = new Set([
      ...(await readdir(parent)).map((entry) => entry.toLowerCase()),
      // Removed paths remain bound to old Sessions and must never be reused.
      ...state.worktrees
        .filter((item) => dirname(item.path) === parent)
        .map((item) => basename(item.path).toLowerCase()),
    ]);
    let directory = name.slug;
    for (let index = 2; occupied.has(directory); index++) directory = `${name.slug}-${index}`;
    const path = join(parent, directory);
    // Git cannot hold both "feat" and "feat/foo". Keep the AI directory and
    // fall back to detached HEAD rather than changing an existing branch.
    if (branches.has(name.type)) return { path };
    for (let index = 1; ; index++) {
      const slug = index === 1 ? name.slug : `${name.slug}-${index}`;
      const branch = `${name.type}/${slug}`;
      if (branches.has(branch)) continue;
      return { branch, path };
    }
  }
  private async projectDirectory(project: ProjectRecord, root: string): Promise<string> {
    const state = await this.read();
    const allocated = projectValue(project, state.projectDirectories);
    if (allocated) {
      await mkdir(join(root, allocated), { recursive: true });
      return realpath(join(root, allocated));
    }
    await mkdir(root, { recursive: true });
    // Reserve names across projects and roots, and leave pre-existing files,
    // directories and symlinks alone. Case folding also works on APFS/Windows.
    const occupied = new Set(
      [...Object.values(state.projectDirectories), ...(await readdir(root))].map((name) =>
        name.normalize('NFC').toLowerCase(),
      ),
    );
    const name = projectDirectoryName(project.name);
    const suffix = createHash('sha256').update(project.id).digest('hex').slice(0, 8);
    for (let attempt = 0; ; attempt++) {
      const folder = attempt === 0 ? name : `${name}-${suffix}${attempt > 1 ? `-${attempt}` : ''}`;
      if (occupied.has(folder.toLowerCase())) continue;
      const path = join(root, folder);
      try {
        // Claim the directory exclusively, including against another Host
        // sharing this root. Never adopt an unowned directory on collision.
        await mkdir(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
      state.projectDirectories[project.id] = folder;
      await this.save();
      return realpath(path);
    }
  }
  private async managed(projectId: string, path: string): Promise<ManagedWorktree> {
    const project = await this.project(projectId);
    const item = (await this.read()).worktrees.find(
      (w) =>
        findProjectByIdentity([project], w.projectId) &&
        w.path === path &&
        w.phase !== 'reserved' &&
        w.phase !== 'removed',
    );
    if (!item) throw new Error('Only worktrees created by Maka can be managed');
    await this.validatePath(projectId, path);
    if ((await commonDirectory(path)) !== item.commonDir)
      throw new Error('Worktree repository identity has changed');
    return item;
  }
  private async scriptEnvironment(item: ManagedWorktree): Promise<NodeJS.ProcessEnv> {
    return {
      ...process.env,
      MAKA_PROJECT_PATH: await this.mainPath(item.projectId),
      MAKA_WORKTREE_PATH: item.path,
      MAKA_SOURCE_WORKTREE_PATH: item.sourcePath,
      MAKA_WORKTREE_BRANCH: item.branch ?? '',
      MAKA_WORKTREE_BASE_COMMIT: item.baseCommit,
    };
  }
  private async initialize(
    item: ManagedWorktree,
    skip = false,
    signal?: AbortSignal,
  ): Promise<void> {
    const script = projectValue(
      await this.project(item.projectId),
      (await this.read()).config.projects,
    )?.setupScript;
    if (skip) {
      item.phase = 'skipped';
      await this.save();
      return;
    }
    if (item.phase === 'ready' || item.phase === 'skipped') return;
    if (!script?.trim()) {
      item.phase = 'ready';
      item.log = '';
      await this.save();
      return;
    }
    item.phase = 'initializing';
    item.log = '';
    await this.save();
    try {
      const result = await runScript(
        script,
        item.path,
        signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal,
        await this.scriptEnvironment(item),
      );
      item.phase = result.ok ? 'ready' : 'failed';
      item.log = result.log;
      await this.save();
    } catch (error) {
      if (interruptWorktree(item)) await this.save();
      throw error;
    }
  }
  private async info(item: ManagedWorktree): Promise<WorktreeInfo> {
    const snapshot = await this.snapshot(item.projectId);
    const info = snapshot.projects.flatMap((p) => p.worktrees).find((w) => w.path === item.path);
    if (!info) throw new Error('Created worktree is unavailable');
    return info;
  }
  private async remove(
    input: Extract<WorktreeMutation, { kind: 'remove' }>,
  ): Promise<WorktreeMutationResult> {
    const item = await this.managed(input.projectId, input.path);
    const sessions = (await this.options.listSessions()).filter((s) =>
      isPathInside(item.path, s.cwd),
    );
    const check = async () => {
      for (const session of sessions) {
        if (
          this.options.isSessionActive(session.id) ||
          (await this.options.hasLiveSessionResources(session.id))
        ) {
          throw new Error('A session in this worktree is still running');
        }
      }
      await this.validatePath(item.projectId, item.path);
      await this.assertNoNestedRepositories(item.path);
      if ((await git(item.path, ['status', '--porcelain', '--untracked-files=all'])).trim())
        throw new Error('Commit or remove uncommitted files before cleaning this worktree');
      const currentBranch = (await git(item.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      const refs = (
        await git(item.path, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'])
      )
        .trim()
        .split('\n')
        .filter((ref) => ref && ref !== `refs/heads/${currentBranch}`);
      if ((await git(item.path, ['rev-list', '--max-count=1', 'HEAD', '--not', ...refs])).trim())
        throw new Error(
          'This worktree has commits not retained by another branch. Merge them or create a retained branch before cleaning.',
        );
      return (await git(item.path, ['rev-parse', 'HEAD'])).trim();
    };
    const head = await check();
    if (input.confirmation) {
      const confirmation = this.cleanupConfirmations.get(input.confirmation);
      this.cleanupConfirmations.delete(input.confirmation);
      if (
        !confirmation ||
        confirmation.path !== item.path ||
        confirmation.head !== head ||
        confirmation.expiresAt < Date.now()
      )
        throw new Error('Cleanup confirmation has expired; retry cleanup');
    } else {
      const script = projectValue(
        await this.project(item.projectId),
        (await this.read()).config.projects,
      )?.cleanupScript;
      if (script?.trim()) {
        const result = await runScript(
          script,
          item.path,
          this.shutdown.signal,
          await this.scriptEnvironment(item),
        );
        if (!result.ok) {
          const confirmation = randomUUID();
          this.cleanupConfirmations.set(confirmation, {
            path: item.path,
            head,
            expiresAt: Date.now() + 5 * 60_000,
          });
          item.log = result.log;
          await this.save();
          return { kind: 'cleanup_failed', path: item.path, log: result.log, confirmation };
        }
      }
    }
    await check();
    const main = await this.mainPath(item.projectId);
    await git(main, ['worktree', 'remove', '--force', item.path]);
    item.phase = 'removed';
    await this.save();
    return { kind: 'removed', path: item.path };
  }

  private async assertNoNestedRepositories(root: string): Promise<void> {
    // Git status omits ignored directories, and worktree remove --force deletes
    // their repositories too. Inspect real directories, including other repos
    // that neither this journal nor the parent's Git worktree list knows about.
    const pending = [root];
    while (pending.length) {
      this.shutdown.signal.throwIfAborted();
      const path = pending.pop()!;
      const entries = await readdir(path, { withFileTypes: true });
      if (path !== root) {
        const names = new Set(entries.map((entry) => entry.name));
        const bare =
          names.has('HEAD') &&
          names.has('objects') &&
          names.has('refs') &&
          (await git(path, ['rev-parse', '--is-bare-repository'])).trim() === 'true';
        if (names.has('.git') || bare)
          throw new Error('Remove nested repositories or worktrees before cleaning this worktree');
      }
      for (const entry of entries)
        if (entry.name !== '.git' && entry.isDirectory()) pending.push(join(path, entry.name));
    }
  }

  private async assertManagedAncestors(path: string, includeSelf: boolean): Promise<void> {
    for (const ancestor of (await this.read()).worktrees) {
      if ((!includeSelf && ancestor.path === path) || !isPathInside(ancestor.path, path)) continue;
      if (ancestor.phase === 'removed') throw new Error('Parent worktree has been removed');
      await assertGitWorktree(ancestor.path, ancestor.commonDir);
    }
  }
}

/** A surviving project's own value takes precedence over its absorbed identities. */
function projectValue<T>(project: ProjectRecord, values: Record<string, T>): T | undefined {
  for (const id of [project.id, ...(project.aliases ?? [])]) {
    if (Object.hasOwn(values, id)) return values[id];
  }
  return undefined;
}
