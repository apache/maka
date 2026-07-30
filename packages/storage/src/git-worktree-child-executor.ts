import { execFile } from 'node:child_process';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { promisify } from 'node:util';
import {
  SUBAGENT_WORKSPACE_BINDING_SCHEMA_VERSION,
  isSubagentWorkspaceBinding,
  type ProvisionSubagentWorktreeInput,
  type SubagentWorkspaceBinding,
  type SubagentWorktreeExecutor,
} from '@maka/core';
import { resolveProjectLocation } from './project-catalog.js';

const execFileAsync = promisify(execFile);
const LEASE_PATTERN = /^subagent_worktree_([a-f0-9]{32})$/;
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
        '-b',
        branch,
        worktreePath,
        baseCommit,
      ]);
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
      throw new Error(`Subagent workspace is not a linked Git worktree: ${path}`);
    }
    return {
      worktreePath: normalize(await realpath(location.git.worktreeRoot)),
      gitCommonDir: normalize(location.git.commonDir),
    };
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

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_COMMON_DIR;
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  return stdout;
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
