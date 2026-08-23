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
import { copyFile, mkdir, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  SUBAGENT_WORKSPACE_BINDING_SCHEMA_VERSION,
  isSubagentWorkspaceBinding,
  type ProvisionSubagentWorktreeInput,
  type SubagentWorkspaceBinding,
  type SubagentWorktreeExecutor,
} from '@maka/core/subagent-workspace';
import { resolveProjectLocation } from './project-catalog.js';

const execFileAsync = promisify(execFile);
const LEASE_PATTERN = /^subagent_worktree_([a-f0-9]{32})$/;
const WORKTREE_DIRECTORY_PATTERN = /^[a-f0-9]{32}$/;
const GIT_TIMEOUT_MS = 2 * 60 * 1_000;

export interface CreateGitWorktreeChildExecutorInput {
  storageRoot: string;
}

/**
 * Host-owned Git worktree allocator for linked child Sessions.
 *
 * Lease identity, lease branch, and path are deterministic. A retry therefore
 * adopts the same worktree instead of creating a second filesystem side
 * effect. The child may check out its own task branch without changing the
 * host-owned lease identity. Worktrees intentionally survive terminal child
 * runs so Session resume/follow-up keeps the exact workspace.
 */
export function createGitWorktreeChildExecutor(
  input: CreateGitWorktreeChildExecutorInput,
): SubagentWorktreeExecutor {
  return new GitWorktreeChildExecutor(join(input.storageRoot, 'subagent-worktrees'));
}

class GitWorktreeChildExecutor implements SubagentWorktreeExecutor {
  private readonly inFlight = new Map<string, Promise<SubagentWorkspaceBinding>>();
  private readonly repositoryTails = new Map<string, Promise<void>>();

  constructor(private readonly worktreeRoot: string) {}

  async isAvailable(
    input: Pick<ProvisionSubagentWorktreeInput, 'sourceCwd' | 'sourceProjectId'>,
  ): Promise<boolean> {
    try {
      const source = await resolveProjectLocation({ path: input.sourceCwd });
      return source.kind === 'git' && source.git !== undefined;
    } catch {
      return false;
    }
  }

  async provision(input: ProvisionSubagentWorktreeInput): Promise<SubagentWorkspaceBinding> {
    const suffix = leaseSuffix(input.leaseId);
    const existing = this.inFlight.get(input.leaseId);
    if (existing) return existing;
    const task = this.provisionOnce(input, suffix).finally(() => {
      if (this.inFlight.get(input.leaseId) === task) this.inFlight.delete(input.leaseId);
    });
    this.inFlight.set(input.leaseId, task);
    return task;
  }

  async ensure(binding: SubagentWorkspaceBinding): Promise<void> {
    if (!isSubagentWorkspaceBinding(binding)) {
      throw new Error('Invalid subagent worktree binding');
    }
    await this.assertOwnedBindingLocation(binding);
    const inspected = await this.inspectOwnedWorktree(binding.worktreePath);
    if (!inspected) {
      throw new Error(`Subagent worktree is unavailable: ${binding.worktreePath}`);
    }
    if (inspected.gitCommonDir !== normalize(binding.gitCommonDir)) {
      throw new Error(`Subagent worktree binding changed: ${binding.worktreePath}`);
    }
    const [lease, baseCommit] = await Promise.all([
      gitConfigGet(inspected.worktreePath, branchLeaseConfigKey(binding.branch)),
      gitConfigGet(inspected.worktreePath, branchBaseConfigKey(binding.branch)),
    ]);
    if (lease !== binding.leaseId || baseCommit !== binding.baseCommit) {
      throw new Error(`Subagent worktree lease changed: ${binding.worktreePath}`);
    }
  }

  async capturePatch(binding: SubagentWorkspaceBinding): Promise<Uint8Array> {
    await this.ensure(binding);
    return this.withRepositoryAllocation(binding.gitCommonDir, async () => {
      const temporary = await mkdtemp(join(tmpdir(), 'maka-subagent-patch-'));
      const indexPath = join(temporary, 'index');
      try {
        const currentIndex = (
          await runGit(binding.worktreePath, ['rev-parse', '--git-path', 'index'])
        ).trim();
        // Preserve staged and committed ignored paths, then overlay all working-tree changes.
        await copyFile(
          isAbsolute(currentIndex) ? currentIndex : resolve(binding.worktreePath, currentIndex),
          indexPath,
        );
        const env = { GIT_INDEX_FILE: indexPath };
        await runGit(binding.worktreePath, ['add', '--all', '--'], env);
        return await runGitBytes(
          binding.worktreePath,
          [
            'diff',
            '--cached',
            '--binary',
            '--full-index',
            '--no-ext-diff',
            '--no-textconv',
            '--no-color',
            binding.baseCommit,
            '--',
          ],
          env,
        );
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    });
  }

  async recover(liveBindings: readonly SubagentWorkspaceBinding[]): Promise<void> {
    const liveByPath = new Map<string, SubagentWorkspaceBinding>();
    for (const binding of liveBindings) {
      if (!isSubagentWorkspaceBinding(binding)) {
        throw new Error('Invalid live subagent worktree binding');
      }
      await this.assertOwnedBindingLocation(binding);
      const key = normalize(binding.worktreePath);
      if (liveByPath.has(key)) {
        throw new Error(`Duplicate live subagent worktree binding: ${binding.worktreePath}`);
      }
      liveByPath.set(key, binding);
    }

    if (!(await isDirectory(this.worktreeRoot))) {
      if (liveBindings.length > 0) {
        throw new Error('Live subagent worktree bindings exist without a worktree root');
      }
      return;
    }
    const root = normalize(await realpath(this.worktreeRoot));
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !WORKTREE_DIRECTORY_PATTERN.test(entry.name)) {
        throw new Error(`Unexpected entry in subagent worktree root: ${entry.name}`);
      }
      const path = join(root, entry.name);
      const live = liveByPath.get(path);
      if (live) {
        await this.ensure(live);
        liveByPath.delete(path);
        continue;
      }
      await this.retireOrphan(path, entry.name);
    }
    if (liveByPath.size > 0) {
      throw new Error(`Live subagent worktree is unavailable: ${liveByPath.keys().next().value}`);
    }
  }

  async retire(binding: SubagentWorkspaceBinding): Promise<void> {
    if (!isSubagentWorkspaceBinding(binding)) {
      throw new Error('Invalid subagent worktree binding');
    }
    await this.assertOwnedBindingLocation(binding);
    if (!(await isDirectory(binding.worktreePath))) return;
    await this.ensure(binding);
    await this.withRepositoryAllocation(binding.gitCommonDir, () =>
      this.removeOwnedWorktree(binding.worktreePath, binding.branch, binding.gitCommonDir),
    );
  }

  private async provisionOnce(
    input: ProvisionSubagentWorktreeInput,
    suffix: string,
  ): Promise<SubagentWorkspaceBinding> {
    if (!input.sourceSessionId) throw new Error('Subagent worktree source Session is required');
    const source = await resolveProjectLocation({ path: input.sourceCwd });
    if (source.kind !== 'git' || !source.git) {
      throw new Error('Worktree child execution requires a Git project');
    }
    const root = await ensureDirectory(this.worktreeRoot);
    const worktreePath = join(root, suffix);
    const branch = `maka/subagent/${suffix}`;
    const gitCommonDir = normalize(source.git.commonDir);
    return this.withRepositoryAllocation(gitCommonDir, () =>
      this.provisionResolved(input.leaseId, source.git!.worktreeRoot, {
        worktreePath,
        branch,
        gitCommonDir,
      }),
    );
  }

  private async provisionResolved(
    leaseId: string,
    sourceWorktreeRoot: string,
    target: {
      worktreePath: string;
      branch: string;
      gitCommonDir: string;
    },
  ): Promise<SubagentWorkspaceBinding> {
    const { worktreePath, branch, gitCommonDir } = target;
    const adopted = await this.inspectOwnedWorktree(worktreePath);
    if (adopted) {
      if (adopted.gitCommonDir !== gitCommonDir) {
        throw new Error(`Subagent worktree belongs to another Git repository: ${worktreePath}`);
      }
      return this.finalizeBinding(leaseId, branch, adopted);
    }

    const branchCommit = await gitRevParseOptional(sourceWorktreeRoot, branch);
    const storedLease = await gitConfigGet(sourceWorktreeRoot, branchLeaseConfigKey(branch));
    if (branchCommit && storedLease !== leaseId) {
      throw new Error(`Subagent worktree branch is already owned: ${branch}`);
    }

    let baseCommit: string;
    if (branchCommit) {
      baseCommit =
        (await gitConfigGet(sourceWorktreeRoot, branchBaseConfigKey(branch))) ?? branchCommit;
      await runGit(sourceWorktreeRoot, ['worktree', 'add', '--quiet', worktreePath, branch]);
    } else {
      await assertCleanGitWorktree(sourceWorktreeRoot);
      baseCommit = await gitRevParse(sourceWorktreeRoot, 'HEAD');
      await runGit(sourceWorktreeRoot, [
        'worktree',
        'add',
        '--quiet',
        '--detach',
        worktreePath,
        baseCommit,
      ]);
      await runGit(worktreePath, ['switch', '--quiet', '-c', branch]);
    }

    const inspected = await this.inspectOwnedWorktree(worktreePath);
    if (!inspected || inspected.gitCommonDir !== gitCommonDir) {
      throw new Error(`Git did not create the expected subagent worktree: ${worktreePath}`);
    }
    const checkedOutBranch = await gitCurrentBranch(inspected.worktreePath);
    if (checkedOutBranch !== branch) {
      throw new Error(`Git did not check out the expected subagent branch: ${worktreePath}`);
    }
    await setBranchLease(worktreePath, branch, leaseId, baseCommit);
    return {
      schemaVersion: SUBAGENT_WORKSPACE_BINDING_SCHEMA_VERSION,
      kind: 'git_worktree',
      leaseId,
      gitCommonDir,
      worktreePath: inspected.worktreePath,
      branch,
      baseCommit,
    };
  }

  private async withRepositoryAllocation<T>(
    gitCommonDir: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.repositoryTails.get(gitCommonDir) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.repositoryTails.set(gitCommonDir, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.repositoryTails.get(gitCommonDir) === tail) {
        this.repositoryTails.delete(gitCommonDir);
      }
    }
  }

  private async finalizeBinding(
    leaseId: string,
    leaseBranch: string,
    inspected: InspectedWorktree,
  ): Promise<SubagentWorkspaceBinding> {
    const lease = await gitConfigGet(inspected.worktreePath, branchLeaseConfigKey(leaseBranch));
    if (lease && lease !== leaseId) {
      throw new Error(`Subagent worktree lease changed: ${inspected.worktreePath}`);
    }
    if (!lease && (await gitCurrentBranch(inspected.worktreePath)) !== leaseBranch) {
      throw new Error(`Subagent worktree lease is unavailable: ${inspected.worktreePath}`);
    }
    const baseCommit =
      (await gitConfigGet(inspected.worktreePath, branchBaseConfigKey(leaseBranch))) ??
      (await gitRevParse(inspected.worktreePath, leaseBranch));
    await setBranchLease(inspected.worktreePath, leaseBranch, leaseId, baseCommit);
    return {
      schemaVersion: SUBAGENT_WORKSPACE_BINDING_SCHEMA_VERSION,
      kind: 'git_worktree',
      leaseId,
      gitCommonDir: inspected.gitCommonDir,
      worktreePath: inspected.worktreePath,
      branch: leaseBranch,
      baseCommit,
    };
  }

  private async inspectOwnedWorktree(path: string): Promise<InspectedWorktree | undefined> {
    if (!(await isDirectory(path))) return undefined;
    const location = await resolveProjectLocation({ path });
    if (location.kind !== 'git' || !location.git?.isWorktree) {
      throw new UnlinkedWorktreeError(path);
    }
    const worktreePath = normalize(await realpath(location.git.worktreeRoot));
    if (worktreePath !== normalize(path)) {
      throw new Error(`Subagent workspace resolves outside its Host-owned path: ${path}`);
    }
    return {
      worktreePath,
      gitCommonDir: normalize(location.git.commonDir),
    };
  }

  private async assertOwnedBindingLocation(binding: SubagentWorkspaceBinding): Promise<void> {
    const suffix = leaseSuffix(binding.leaseId);
    const root = normalize(await realpath(this.worktreeRoot));
    if (
      normalize(binding.worktreePath) !== join(root, suffix) ||
      binding.branch !== `maka/subagent/${suffix}`
    ) {
      throw new Error(
        `Subagent worktree binding is outside the Host-owned root: ${binding.worktreePath}`,
      );
    }
  }

  private async retireOrphan(path: string, suffix: string): Promise<void> {
    let inspected: InspectedWorktree | undefined;
    try {
      inspected = await this.inspectOwnedWorktree(path);
    } catch (error) {
      if (!(error instanceof UnlinkedWorktreeError)) throw error;
      await rm(path, { recursive: true, force: true });
      return;
    }
    if (!inspected) return;
    const branch = `maka/subagent/${suffix}`;
    const leaseId = `subagent_worktree_${suffix}`;
    const branchCommit = await gitRevParseOptional(path, branch);
    const storedLease = await gitConfigGet(path, branchLeaseConfigKey(branch));
    if (storedLease !== undefined && storedLease !== leaseId) {
      throw new Error(`Orphan subagent worktree lease changed: ${path}`);
    }
    const currentBranch = await gitCurrentBranch(path);
    if (!branchCommit && currentBranch !== undefined) {
      throw new Error(`Orphan subagent worktree is attached to an unmanaged branch: ${path}`);
    }
    if (branchCommit && storedLease === undefined && currentBranch !== branch) {
      throw new Error(`Orphan subagent worktree ownership is unavailable: ${path}`);
    }
    await this.withRepositoryAllocation(inspected.gitCommonDir, () =>
      this.removeOwnedWorktree(path, branch, inspected.gitCommonDir),
    );
  }

  private async removeOwnedWorktree(
    path: string,
    leaseBranch: string,
    gitCommonDir: string,
  ): Promise<void> {
    await runGit(path, ['clean', '-ffdx']);
    await runGit(path, ['checkout', '--detach', '--force', 'HEAD']);
    await runGit(path, ['clean', '-ffdx']);
    if (await gitRevParseOptional(path, leaseBranch)) {
      await runGit(path, ['branch', '-D', leaseBranch]);
    }
    // Windows cannot remove a process's current directory, so run the final removal elsewhere.
    await runGit(gitCommonDir, ['worktree', 'remove', '--force', path]);
  }
}

class UnlinkedWorktreeError extends Error {
  readonly name = 'UnlinkedWorktreeError';

  constructor(path: string) {
    super(`Subagent workspace is not a linked Git worktree: ${path}`);
  }
}

interface InspectedWorktree {
  worktreePath: string;
  gitCommonDir: string;
}

async function assertCleanGitWorktree(path: string): Promise<void> {
  const status = await runGit(path, [
    'status',
    '--porcelain=v1',
    '--untracked-files=normal',
    '--ignore-submodules=none',
  ]);
  if (status.trim()) {
    throw new Error(
      'Worktree child execution requires the source Git worktree to have no uncommitted changes',
    );
  }
}

async function setBranchLease(
  cwd: string,
  branch: string,
  leaseId: string,
  baseCommit: string,
): Promise<void> {
  await runGit(cwd, ['config', '--local', branchLeaseConfigKey(branch), leaseId]);
  await runGit(cwd, ['config', '--local', branchBaseConfigKey(branch), baseCommit]);
}

function branchLeaseConfigKey(branch: string): string {
  return `branch.${branch}.maka-worktree-lease`;
}

function branchBaseConfigKey(branch: string): string {
  return `branch.${branch}.maka-worktree-base`;
}

async function gitConfigGet(cwd: string, key: string): Promise<string | undefined> {
  try {
    const output = await runGit(cwd, ['config', '--local', '--get', key]);
    return output.trim() || undefined;
  } catch (error) {
    if (gitExitCode(error) === 1) return undefined;
    throw error;
  }
}

async function gitRevParse(cwd: string, ref: string): Promise<string> {
  return (await runGit(cwd, ['rev-parse', '--verify', ref])).trim();
}

async function gitRevParseOptional(cwd: string, ref: string): Promise<string | undefined> {
  try {
    return await gitRevParse(cwd, ref);
  } catch (error) {
    if (gitExitCode(error) === 128) return undefined;
    throw error;
  }
}

async function gitCurrentBranch(cwd: string): Promise<string | undefined> {
  try {
    const branch = await runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return branch.trim() || undefined;
  } catch (error) {
    if (gitExitCode(error) === 1) return undefined;
    throw error;
  }
}

async function runGit(
  cwd: string,
  args: readonly string[],
  overrides: Readonly<Record<string, string>> = {},
): Promise<string> {
  const env = gitEnvironment(overrides);
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  return stdout;
}

async function runGitBytes(
  cwd: string,
  args: readonly string[],
  overrides: Readonly<Record<string, string>> = {},
): Promise<Uint8Array> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    env: gitEnvironment(overrides),
    encoding: 'buffer',
    maxBuffer: Number.MAX_SAFE_INTEGER,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  return new Uint8Array(stdout);
}

function gitEnvironment(overrides: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...overrides };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  if (overrides.GIT_INDEX_FILE === undefined) delete env.GIT_INDEX_FILE;
  return env;
}

function gitExitCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'number' ? error.code : undefined;
}

function leaseSuffix(leaseId: string): string {
  const match = LEASE_PATTERN.exec(leaseId);
  if (!match?.[1]) throw new Error(`Invalid subagent worktree lease id: ${leaseId}`);
  return match[1];
}

async function ensureDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  const canonical = normalize(await realpath(path));
  if (!isAbsolute(canonical) || !(await stat(canonical)).isDirectory()) {
    throw new Error(`Invalid subagent worktree root: ${path}`);
  }
  return canonical;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
