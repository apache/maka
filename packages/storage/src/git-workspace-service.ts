import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { withArtifactWriterLock } from './artifact-writer-lock.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 2 * 60 * 1_000;
const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const BINDING_SCHEMA_VERSION = 1;
const REPOSITORY_SCHEMA_VERSION = 1;
const IDENTIFIER_PATTERN = /^(repository|workspace|epoch|instance)_[a-f0-9]{32}$/u;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const OID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const BINDING_KEYS = [
  'schemaVersion',
  'protocol',
  'repositoryId',
  'workspaceId',
  'workspaceEpochId',
  'workspaceInstanceId',
  'sourceRoot',
  'sourceGitCommonDir',
  'sourceHeadCommitOid',
  'sourceTreeOid',
  'repositoryPath',
  'worktreePath',
  'hooksPath',
  'baselineCommitOid',
  'baselineTreeOid',
  'headRef',
  'gitRuntimeSha256',
  'objectFormat',
  'materializationProfileDigest',
  'materializationSemantics',
] as const;
const REPOSITORY_KEYS = [
  'schemaVersion',
  'protocol',
  'repositoryId',
  'sourceRoot',
  'sourceGitCommonDir',
  'sourceHeadCommitOid',
  'sourceTreeOid',
  'repositoryPath',
  'hooksPath',
  'baselineCommitOid',
  'baselineTreeOid',
  'gitRuntimeSha256',
  'objectFormat',
  'materializationProfileDigest',
  'materializationSemantics',
] as const;
const MATERIALIZATION_SEMANTICS = 'git_tree_materialized_with_fixed_config_v1';
const BASELINE_MESSAGE = 'maka managed workspace baseline v1\n';
const BASELINE_DATE = '2000-01-01T00:00:00Z';

export type GitWorkspaceServiceErrorCode =
  | 'git_runtime_unavailable'
  | 'git_runtime_integrity_mismatch'
  | 'git_workspace_operation_failed'
  | 'repository_ineligible'
  | 'managed_workspace_identity_conflict'
  | 'managed_workspace_unavailable'
  | 'managed_workspace_drifted';

export class GitWorkspaceServiceError extends Error {
  constructor(
    readonly code: GitWorkspaceServiceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'GitWorkspaceServiceError';
  }
}

export interface VerifiedGitRuntimeInput {
  readonly executablePath: string;
  readonly expectedSha256: `sha256:${string}`;
}

export interface CreateGitWorkspaceServiceInput {
  readonly storageRoot: string;
  readonly gitRuntime: VerifiedGitRuntimeInput;
  readonly failpoint?: (point: GitWorkspaceServiceFailpoint) => void;
}

export type GitWorkspaceServiceFailpoint =
  | 'after_repository_record'
  | 'after_worktree_materialized';

export interface OpenManagedWorkspaceInput {
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly workspaceEpochId: string;
  readonly workspaceInstanceId: string;
  readonly sourceRoot: string;
}

export interface ManagedWorkspaceBinding {
  readonly schemaVersion: 1;
  readonly protocol: 'git_managed_workspace_v1';
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly workspaceEpochId: string;
  readonly workspaceInstanceId: string;
  readonly sourceRoot: string;
  readonly sourceGitCommonDir: string;
  readonly sourceHeadCommitOid: string;
  readonly sourceTreeOid: string;
  readonly repositoryPath: string;
  readonly worktreePath: string;
  readonly hooksPath: string;
  readonly baselineCommitOid: string;
  readonly baselineTreeOid: string;
  readonly headRef: string;
  readonly gitRuntimeSha256: `sha256:${string}`;
  readonly objectFormat: string;
  readonly materializationProfileDigest: `sha256:${string}`;
  readonly materializationSemantics: typeof MATERIALIZATION_SEMANTICS;
}

export type ManagedWorkspaceInspection =
  | {
      readonly state: 'ready';
      readonly commitOid: string;
      readonly treeOid: string;
    }
  | {
      readonly state: 'drifted';
      readonly commitOid?: string;
      readonly treeOid?: string;
      readonly status: string;
    };

export interface ManagedWorkspaceQuarantine {
  readonly quarantinePath: string;
  readonly reason: string;
}

export interface GitWorkspaceService {
  openManagedWorkspace(input: OpenManagedWorkspaceInput): Promise<ManagedWorkspaceBinding>;
  inspectManagedWorkspace(binding: ManagedWorkspaceBinding): Promise<ManagedWorkspaceInspection>;
  quarantineManagedWorkspace(
    binding: ManagedWorkspaceBinding,
    reason: string,
  ): Promise<ManagedWorkspaceQuarantine>;
}

export function createGitWorkspaceService(
  input: CreateGitWorkspaceServiceInput,
): GitWorkspaceService {
  return new GitWorkspaceServiceImpl(input);
}

interface SourceRepositoryInspection {
  readonly sourceRoot: string;
  readonly gitCommonDir: string;
  readonly headCommitOid: string;
  readonly treeOid: string;
  readonly objectFormat: string;
}

interface GitTreeEntry {
  readonly mode: string;
  readonly path: string;
}

interface ManagedRepositoryRecord {
  readonly schemaVersion: 1;
  readonly protocol: 'maka_managed_git_repository_v1';
  readonly repositoryId: string;
  readonly sourceRoot: string;
  readonly sourceGitCommonDir: string;
  readonly sourceHeadCommitOid: string;
  readonly sourceTreeOid: string;
  readonly repositoryPath: string;
  readonly hooksPath: string;
  readonly baselineCommitOid: string;
  readonly baselineTreeOid: string;
  readonly gitRuntimeSha256: `sha256:${string}`;
  readonly objectFormat: string;
  readonly materializationProfileDigest: `sha256:${string}`;
  readonly materializationSemantics: typeof MATERIALIZATION_SEMANTICS;
}

interface WorkspaceLayout {
  readonly managedRoot: string;
  readonly repositoryRoot: string;
  readonly repositoryPath: string;
  readonly repositoryRecordPath: string;
  readonly hooksPath: string;
  readonly homePath: string;
  readonly instanceRoot: string;
  readonly bindingPath: string;
  readonly worktreePath: string;
  readonly quarantineRoot: string;
}

class GitWorkspaceServiceImpl implements GitWorkspaceService {
  private readonly runtime: VerifiedGitRuntime;

  constructor(private readonly input: CreateGitWorkspaceServiceInput) {
    if (!isAbsolute(input.storageRoot)) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Managed workspace storage root must be absolute',
      );
    }
    this.runtime = new VerifiedGitRuntime(input.gitRuntime);
  }

  async openManagedWorkspace(input: OpenManagedWorkspaceInput): Promise<ManagedWorkspaceBinding> {
    assertOpenIdentity(input);
    const runtime = await this.runtime.verify();
    const sourceRoot = await canonicalDirectory(input.sourceRoot, 'repository_ineligible');
    const source = await this.inspectSourceRepository(sourceRoot);

    return withArtifactWriterLock(this.input.storageRoot, async (canonicalStorageRoot) => {
      const layout = workspaceLayout(canonicalStorageRoot, input);
      await ensureOwnedDirectory(layout.managedRoot, canonicalStorageRoot);
      await ensureOwnedDirectory(layout.quarantineRoot, layout.managedRoot);
      await ensureOwnedDirectory(layout.homePath, layout.managedRoot);

      const existingBinding = await readBinding(layout.bindingPath);
      if (existingBinding) {
        assertBindingMatches(existingBinding, input, source, layout, runtime.digest);
        const repository = await this.requireRepository(input, source, layout, runtime.digest);
        assertBindingRepository(existingBinding, repository);
        const inspection = await this.inspectBinding(existingBinding, layout);
        if (inspection.state !== 'ready') {
          throw new GitWorkspaceServiceError(
            'managed_workspace_drifted',
            `Managed workspace contains unaccepted changes: ${existingBinding.worktreePath}`,
          );
        }
        return existingBinding;
      }

      const repository = await this.openRepository(input, source, layout, runtime.digest);
      await this.clearIncompleteInstance(layout);
      await ensureOwnedDirectory(layout.instanceRoot, layout.managedRoot);
      await this.runtime.run(
        [
          '--git-dir',
          repository.repositoryPath,
          'worktree',
          'add',
          '--quiet',
          '--detach',
          layout.worktreePath,
          repository.baselineCommitOid,
        ],
        layout.homePath,
      );
      this.input.failpoint?.('after_worktree_materialized');

      const headRef = managedHeadRef(input.workspaceId, input.workspaceEpochId);
      await this.runtime.run(
        [
          '--git-dir',
          repository.repositoryPath,
          'update-ref',
          headRef,
          repository.baselineCommitOid,
        ],
        layout.homePath,
      );

      const binding: ManagedWorkspaceBinding = {
        schemaVersion: BINDING_SCHEMA_VERSION,
        protocol: 'git_managed_workspace_v1',
        repositoryId: input.repositoryId,
        workspaceId: input.workspaceId,
        workspaceEpochId: input.workspaceEpochId,
        workspaceInstanceId: input.workspaceInstanceId,
        sourceRoot: source.sourceRoot,
        sourceGitCommonDir: source.gitCommonDir,
        sourceHeadCommitOid: source.headCommitOid,
        sourceTreeOid: source.treeOid,
        repositoryPath: repository.repositoryPath,
        worktreePath: normalize(layout.worktreePath),
        hooksPath: repository.hooksPath,
        baselineCommitOid: repository.baselineCommitOid,
        baselineTreeOid: repository.baselineTreeOid,
        headRef,
        gitRuntimeSha256: runtime.digest,
        objectFormat: repository.objectFormat,
        materializationProfileDigest: repository.materializationProfileDigest,
        materializationSemantics: MATERIALIZATION_SEMANTICS,
      };
      const inspection = await this.inspectBinding(binding, layout);
      if (inspection.state !== 'ready') {
        await this.quarantineWorktreeLocked(binding, layout, 'initial_materialization_drift');
        throw new GitWorkspaceServiceError(
          'managed_workspace_drifted',
          'Git materialization did not produce a clean managed workspace',
        );
      }
      await atomicWriteJson(layout.bindingPath, binding);
      return binding;
    });
  }

  async inspectManagedWorkspace(
    binding: ManagedWorkspaceBinding,
  ): Promise<ManagedWorkspaceInspection> {
    await this.runtime.verify();
    assertBindingShape(binding);
    assertOpenIdentity(binding);
    return withArtifactWriterLock(this.input.storageRoot, async (canonicalStorageRoot) => {
      const layout = workspaceLayout(canonicalStorageRoot, binding);
      assertBindingPaths(binding, layout);
      const stored = await readBinding(layout.bindingPath);
      if (!stored || !sameBinding(stored, binding)) {
        throw new GitWorkspaceServiceError(
          'managed_workspace_unavailable',
          `Managed workspace binding is unavailable: ${binding.workspaceInstanceId}`,
        );
      }
      const repository = await readRepositoryRecord(layout.repositoryRecordPath);
      if (!repository) {
        throw new GitWorkspaceServiceError(
          'managed_workspace_unavailable',
          `Managed Git repository record is unavailable: ${binding.repositoryId}`,
        );
      }
      assertBindingRepository(binding, repository);
      await this.assertRepositoryArtifact(repository);
      return this.inspectBinding(binding, layout);
    });
  }

  async quarantineManagedWorkspace(
    binding: ManagedWorkspaceBinding,
    reason: string,
  ): Promise<ManagedWorkspaceQuarantine> {
    await this.runtime.verify();
    assertBindingShape(binding);
    assertOpenIdentity(binding);
    if (!reason.trim()) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Managed workspace quarantine reason is required',
      );
    }
    return withArtifactWriterLock(this.input.storageRoot, async (canonicalStorageRoot) => {
      const layout = workspaceLayout(canonicalStorageRoot, binding);
      assertBindingPaths(binding, layout);
      const stored = await readBinding(layout.bindingPath);
      if (!stored || !sameBinding(stored, binding)) {
        throw new GitWorkspaceServiceError(
          'managed_workspace_unavailable',
          `Managed workspace binding is unavailable: ${binding.workspaceInstanceId}`,
        );
      }
      const repository = await readRepositoryRecord(layout.repositoryRecordPath);
      if (!repository) {
        throw new GitWorkspaceServiceError(
          'managed_workspace_unavailable',
          `Managed Git repository record is unavailable: ${binding.repositoryId}`,
        );
      }
      assertBindingRepository(binding, repository);
      await this.assertRepositoryArtifact(repository);
      return this.quarantineWorktreeLocked(binding, layout, reason);
    });
  }

  private async inspectSourceRepository(sourceRoot: string): Promise<SourceRepositoryInspection> {
    try {
      const topLevelRaw = await this.runtime.run([
        '-C',
        sourceRoot,
        'rev-parse',
        '--show-toplevel',
      ]);
      const topLevel = await realpath(topLevelRaw.trim());
      if (!samePath(topLevel, sourceRoot)) {
        throw new GitWorkspaceServiceError(
          'repository_ineligible',
          'Managed workspace source must be the Git worktree root',
        );
      }
      const status = await this.runtime.run([
        '-C',
        sourceRoot,
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
        '--ignore-submodules=none',
      ]);
      if (status.trim()) {
        throw new GitWorkspaceServiceError(
          'repository_ineligible',
          'Managed workspace source must have no tracked or untracked changes',
        );
      }
      const sparse = await this.runtime.runOptional(
        ['-C', sourceRoot, 'config', '--bool', '--get', 'core.sparseCheckout'],
        1,
      );
      if (sparse?.trim() === 'true') {
        throw new GitWorkspaceServiceError(
          'repository_ineligible',
          'Sparse Git worktrees are not supported by managed workspace v1',
        );
      }
      const entries = parseTreeEntries(
        await this.runtime.run(['-C', sourceRoot, 'ls-tree', '-r', '-z', 'HEAD']),
      );
      assertSupportedTree(entries);

      const gitCommonDirRaw = (
        await this.runtime.run(['-C', sourceRoot, 'rev-parse', '--git-common-dir'])
      ).trim();
      const gitCommonDir = await realpath(resolveGitPath(sourceRoot, gitCommonDirRaw));
      const [headCommitOid, treeOid, objectFormat] = await Promise.all([
        this.runtime.run(['-C', sourceRoot, 'rev-parse', '--verify', 'HEAD']),
        this.runtime.run(['-C', sourceRoot, 'rev-parse', '--verify', 'HEAD^{tree}']),
        this.runtime.run(['-C', sourceRoot, 'rev-parse', '--show-object-format']),
      ]);
      return {
        sourceRoot: normalize(sourceRoot),
        gitCommonDir: normalize(gitCommonDir),
        headCommitOid: headCommitOid.trim(),
        treeOid: treeOid.trim(),
        objectFormat: objectFormat.trim(),
      };
    } catch (error) {
      if (error instanceof GitWorkspaceServiceError) throw error;
      throw new GitWorkspaceServiceError(
        'repository_ineligible',
        `Unable to inspect managed workspace source: ${sourceRoot}`,
        { cause: error },
      );
    }
  }

  private async openRepository(
    input: OpenManagedWorkspaceInput,
    source: SourceRepositoryInspection,
    layout: WorkspaceLayout,
    runtimeDigest: `sha256:${string}`,
  ): Promise<ManagedRepositoryRecord> {
    const existing = await readRepositoryRecord(layout.repositoryRecordPath);
    if (existing) {
      assertRepositoryMatches(existing, input, source, layout, runtimeDigest);
      await this.assertRepositoryArtifact(existing);
      return existing;
    }

    if (await pathExists(layout.repositoryRoot)) {
      await moveToQuarantine(
        layout.repositoryRoot,
        layout.quarantineRoot,
        `${input.repositoryId}-incomplete-repository`,
      );
    }
    await ensureOwnedDirectory(layout.repositoryRoot, layout.managedRoot);
    await ensureOwnedDirectory(layout.hooksPath, layout.repositoryRoot);
    const stagingRepository = join(
      layout.repositoryRoot,
      `r.tmp-${randomBytes(6).toString('hex')}`,
    );
    try {
      const templatePath = join(layout.repositoryRoot, 'empty-template');
      await mkdir(templatePath, { recursive: true });
      await this.runtime.run(
        [
          'init',
          '--quiet',
          '--bare',
          `--object-format=${source.objectFormat}`,
          `--template=${templatePath}`,
          stagingRepository,
        ],
        layout.homePath,
      );
      await this.configureManagedRepository(stagingRepository, layout.hooksPath);
      await this.runtime.importTree(
        source.sourceRoot,
        source.treeOid,
        stagingRepository,
        layout.homePath,
      );
      const importedTree = (
        await this.runtime.run(
          ['--git-dir', stagingRepository, 'rev-parse', `${source.treeOid}^{tree}`],
          layout.homePath,
        )
      ).trim();
      if (importedTree !== source.treeOid) {
        throw new GitWorkspaceServiceError(
          'git_workspace_operation_failed',
          'Imported baseline tree does not match the source HEAD tree',
        );
      }
      const baselineCommitOid = (
        await this.runtime.run(
          [
            '--git-dir',
            stagingRepository,
            'commit-tree',
            importedTree,
            '-m',
            BASELINE_MESSAGE.trim(),
          ],
          layout.homePath,
          baselineCommitEnvironment(),
        )
      ).trim();
      const baselineRef = `refs/maka/baselines/${input.workspaceEpochId}`;
      await this.runtime.run(
        ['--git-dir', stagingRepository, 'update-ref', baselineRef, baselineCommitOid],
        layout.homePath,
      );
      await rename(stagingRepository, layout.repositoryPath);

      const record: ManagedRepositoryRecord = {
        schemaVersion: REPOSITORY_SCHEMA_VERSION,
        protocol: 'maka_managed_git_repository_v1',
        repositoryId: input.repositoryId,
        sourceRoot: source.sourceRoot,
        sourceGitCommonDir: source.gitCommonDir,
        sourceHeadCommitOid: source.headCommitOid,
        sourceTreeOid: source.treeOid,
        repositoryPath: normalize(layout.repositoryPath),
        hooksPath: normalize(layout.hooksPath),
        baselineCommitOid,
        baselineTreeOid: importedTree,
        gitRuntimeSha256: runtimeDigest,
        objectFormat: source.objectFormat,
        materializationProfileDigest: materializationProfileDigest(
          runtimeDigest,
          source.objectFormat,
        ),
        materializationSemantics: MATERIALIZATION_SEMANTICS,
      };
      await this.assertRepositoryArtifact(record);
      await atomicWriteJson(layout.repositoryRecordPath, record);
      this.input.failpoint?.('after_repository_record');
      return record;
    } catch (error) {
      await rm(stagingRepository, { recursive: true, force: true });
      if (error instanceof GitWorkspaceServiceError) throw error;
      throw new GitWorkspaceServiceError(
        'git_workspace_operation_failed',
        'Unable to create the Maka-owned Git repository',
        { cause: error },
      );
    }
  }

  private async requireRepository(
    input: OpenManagedWorkspaceInput,
    source: SourceRepositoryInspection,
    layout: WorkspaceLayout,
    runtimeDigest: `sha256:${string}`,
  ): Promise<ManagedRepositoryRecord> {
    const repository = await readRepositoryRecord(layout.repositoryRecordPath);
    if (!repository) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_unavailable',
        `Managed Git repository record is unavailable: ${input.repositoryId}`,
      );
    }
    assertRepositoryMatches(repository, input, source, layout, runtimeDigest);
    await this.assertRepositoryArtifact(repository);
    return repository;
  }

  private async configureManagedRepository(
    repositoryPath: string,
    hooksPath: string,
  ): Promise<void> {
    const entries: readonly [string, string][] = [
      ['core.autocrlf', 'false'],
      ['core.safecrlf', 'true'],
      ['core.hooksPath', normalize(hooksPath)],
      ['credential.helper', ''],
      ['credential.interactive', 'never'],
      ['gc.auto', '0'],
    ];
    for (const [key, value] of entries) {
      await this.runtime.run(
        ['--git-dir', repositoryPath, 'config', '--local', key, value],
        dirname(repositoryPath),
      );
    }
  }

  private async assertRepositoryArtifact(record: ManagedRepositoryRecord): Promise<void> {
    if (!(await isNonSymlinkDirectory(record.repositoryPath))) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_unavailable',
        `Managed Git repository is unavailable: ${record.repositoryPath}`,
      );
    }
    if (!(await isNonSymlinkDirectory(record.hooksPath))) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        `Managed Git hooks fence is unavailable: ${record.hooksPath}`,
      );
    }
    const [commit, tree, ancestry] = await Promise.all([
      this.runtime.run([
        '--git-dir',
        record.repositoryPath,
        'rev-parse',
        '--verify',
        record.baselineCommitOid,
      ]),
      this.runtime.run([
        '--git-dir',
        record.repositoryPath,
        'rev-parse',
        '--verify',
        `${record.baselineCommitOid}^{tree}`,
      ]),
      this.runtime.run([
        '--git-dir',
        record.repositoryPath,
        'rev-list',
        '--parents',
        '-n',
        '1',
        record.baselineCommitOid,
      ]),
    ]);
    if (
      commit.trim() !== record.baselineCommitOid ||
      tree.trim() !== record.baselineTreeOid ||
      ancestry.trim() !== record.baselineCommitOid
    ) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Managed Git repository baseline identity changed',
      );
    }
    if (await pathExists(join(record.repositoryPath, 'objects', 'info', 'alternates'))) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Managed Git repository must not use object alternates',
      );
    }
  }

  private async inspectBinding(
    binding: ManagedWorkspaceBinding,
    layout: WorkspaceLayout,
  ): Promise<ManagedWorkspaceInspection> {
    assertBindingPaths(binding, layout);
    if (
      !(await isNonSymlinkDirectory(binding.worktreePath)) ||
      !(await isNonSymlinkDirectory(binding.repositoryPath))
    ) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_unavailable',
        `Managed workspace is unavailable: ${binding.worktreePath}`,
      );
    }
    try {
      const commonDirRaw = (
        await this.runtime.run(
          ['-C', binding.worktreePath, 'rev-parse', '--git-common-dir'],
          layout.homePath,
        )
      ).trim();
      const commonDir = await realpath(resolveGitPath(binding.worktreePath, commonDirRaw));
      if (!samePath(commonDir, binding.repositoryPath)) {
        throw new GitWorkspaceServiceError(
          'managed_workspace_identity_conflict',
          'Managed worktree is attached to a different Git repository',
        );
      }
      const [commitRaw, treeRaw, statusRaw, headRefRaw] = await Promise.all([
        this.runtime.run(
          ['-C', binding.worktreePath, 'rev-parse', '--verify', 'HEAD'],
          layout.homePath,
        ),
        this.runtime.run(
          ['-C', binding.worktreePath, 'rev-parse', '--verify', 'HEAD^{tree}'],
          layout.homePath,
        ),
        this.runtime.run(
          [
            '-C',
            binding.worktreePath,
            'status',
            '--porcelain=v1',
            '--untracked-files=all',
            '--ignored=matching',
          ],
          layout.homePath,
        ),
        this.runtime.run(
          ['--git-dir', binding.repositoryPath, 'rev-parse', '--verify', binding.headRef],
          layout.homePath,
        ),
      ]);
      const commitOid = commitRaw.trim();
      const treeOid = treeRaw.trim();
      const status = statusRaw.trim();
      const headRef = headRefRaw.trim();
      if (
        commitOid !== binding.baselineCommitOid ||
        treeOid !== binding.baselineTreeOid ||
        headRef !== binding.baselineCommitOid ||
        status
      ) {
        return { state: 'drifted', commitOid, treeOid, status };
      }
      return { state: 'ready', commitOid, treeOid };
    } catch (error) {
      if (error instanceof GitWorkspaceServiceError) throw error;
      throw new GitWorkspaceServiceError(
        'managed_workspace_unavailable',
        `Unable to inspect managed workspace: ${binding.worktreePath}`,
        { cause: error },
      );
    }
  }

  private async clearIncompleteInstance(layout: WorkspaceLayout): Promise<void> {
    if (!(await pathExists(layout.instanceRoot))) return;
    await moveToQuarantine(
      layout.instanceRoot,
      layout.quarantineRoot,
      `incomplete-${randomUUID()}`,
    );
    await this.runtime.run(
      ['--git-dir', layout.repositoryPath, 'worktree', 'prune', '--expire=now'],
      layout.homePath,
    );
  }

  private async quarantineWorktreeLocked(
    binding: ManagedWorkspaceBinding,
    layout: WorkspaceLayout,
    reason: string,
  ): Promise<ManagedWorkspaceQuarantine> {
    const quarantinePath = await moveToQuarantine(
      binding.worktreePath,
      layout.quarantineRoot,
      `${binding.workspaceInstanceId}-${sanitizeReason(reason)}`,
    );
    await rm(layout.bindingPath, { force: true });
    await this.runtime.run(
      ['--git-dir', binding.repositoryPath, 'worktree', 'prune', '--expire=now'],
      layout.homePath,
    );
    await atomicWriteJson(`${quarantinePath}.json`, {
      protocol: 'maka_managed_workspace_quarantine_v1',
      reason,
      binding,
    });
    return { quarantinePath, reason };
  }
}

class VerifiedGitRuntime {
  private verified?: Promise<{ executablePath: string; digest: `sha256:${string}` }>;

  constructor(private readonly input: VerifiedGitRuntimeInput) {
    if (!isAbsolute(input.executablePath) || !SHA256_PATTERN.test(input.expectedSha256)) {
      throw new GitWorkspaceServiceError(
        'git_runtime_unavailable',
        'Managed workspace requires an absolute Git executable and SHA-256 digest',
      );
    }
  }

  verify(): Promise<{ executablePath: string; digest: `sha256:${string}` }> {
    this.verified ??= this.verifyOnce();
    return this.verified;
  }

  async run(
    args: readonly string[],
    homePath?: string,
    extraEnv?: NodeJS.ProcessEnv,
    acceptedExitCodes: readonly number[] = [],
  ): Promise<string> {
    const runtime = await this.verify();
    const hooksPath = homePath ? join(homePath, 'empty-hooks') : dirname(runtime.executablePath);
    if (homePath) {
      await mkdir(homePath, { recursive: true });
      await mkdir(hooksPath, { recursive: true });
    }
    const env = isolatedGitEnvironment(
      runtime.executablePath,
      homePath ?? dirname(runtime.executablePath),
    );
    try {
      const { stdout } = await execFileAsync(
        runtime.executablePath,
        [...fixedGitArguments(hooksPath), ...args],
        {
          cwd: homePath ?? dirname(runtime.executablePath),
          env: { ...env, ...extraEnv },
          encoding: 'utf8',
          maxBuffer: GIT_MAX_BUFFER_BYTES,
          timeout: GIT_TIMEOUT_MS,
          windowsHide: true,
        },
      );
      return stdout;
    } catch (error) {
      if (acceptedExitCodes.includes(exitCode(error) ?? -1)) return '';
      throw error;
    }
  }

  async runOptional(
    args: readonly string[],
    acceptedMissingExitCode: number,
  ): Promise<string | undefined> {
    try {
      return await this.run(args);
    } catch (error) {
      if (exitCode(error) === acceptedMissingExitCode) return undefined;
      throw error;
    }
  }

  async importTree(
    sourceRoot: string,
    treeOid: string,
    repositoryPath: string,
    homePath: string,
  ): Promise<void> {
    const runtime = await this.verify();
    const hooksPath = join(homePath, 'empty-hooks');
    await mkdir(hooksPath, { recursive: true });
    const env = isolatedGitEnvironment(runtime.executablePath, homePath);
    const fixed = fixedGitArguments(hooksPath);
    const pack = spawn(
      runtime.executablePath,
      [...fixed, '-C', sourceRoot, 'pack-objects', '--stdout', '--revs'],
      { cwd: homePath, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    const index = spawn(
      runtime.executablePath,
      [...fixed, '--git-dir', repositoryPath, 'index-pack', '--stdin', '--fix-thin'],
      { cwd: homePath, env, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true },
    );
    if (!pack.stdin || !pack.stdout || !index.stdin) {
      pack.kill('SIGKILL');
      index.kill('SIGKILL');
      throw new Error('Git tree import did not create the required process pipes');
    }
    const packStderr = collectBoundedStderr(pack.stderr);
    const indexStderr = collectBoundedStderr(index.stderr);
    index.stdin.on('error', () => {
      // The index process exit status/stderr is the authoritative pipeline failure.
    });
    pack.stdout.pipe(index.stdin);
    pack.stdin.end(`${treeOid}\n`);
    const timeout = setTimeout(() => {
      pack.kill('SIGKILL');
      index.kill('SIGKILL');
    }, GIT_TIMEOUT_MS);
    try {
      const [packCode, indexCode] = await Promise.all([
        waitForChildExit(pack),
        waitForChildExit(index),
      ]);
      if (packCode !== 0 || indexCode !== 0) {
        throw new Error(
          `Git tree import failed: pack=${packCode} index=${indexCode} ` +
            `${await packStderr} ${await indexStderr}`,
        );
      }
    } catch (error) {
      pack.kill('SIGKILL');
      index.kill('SIGKILL');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async verifyOnce(): Promise<{ executablePath: string; digest: `sha256:${string}` }> {
    try {
      const executablePath = normalize(await realpath(this.input.executablePath));
      const info = await stat(executablePath);
      if (!info.isFile()) throw new Error('not a regular file');
      const digest = await sha256File(executablePath);
      if (digest !== this.input.expectedSha256) {
        throw new GitWorkspaceServiceError(
          'git_runtime_integrity_mismatch',
          `Git runtime digest mismatch: ${executablePath}`,
        );
      }
      return { executablePath, digest };
    } catch (error) {
      if (error instanceof GitWorkspaceServiceError) throw error;
      throw new GitWorkspaceServiceError(
        'git_runtime_unavailable',
        `Git runtime is unavailable: ${this.input.executablePath}`,
        { cause: error },
      );
    }
  }
}

function workspaceLayout(
  canonicalStorageRoot: string,
  identity: Pick<
    OpenManagedWorkspaceInput,
    'repositoryId' | 'workspaceId' | 'workspaceEpochId' | 'workspaceInstanceId'
  >,
): WorkspaceLayout {
  const managedRoot = join(canonicalStorageRoot, 'managed-workspaces');
  const repositoryRoot = join(managedRoot, 'r', compactIdentity(identity.repositoryId));
  const instanceRoot = join(
    managedRoot,
    'w',
    compactIdentity(identity.workspaceId),
    'e',
    compactIdentity(identity.workspaceEpochId),
    'i',
    compactIdentity(identity.workspaceInstanceId),
  );
  return {
    managedRoot,
    repositoryRoot,
    repositoryPath: join(repositoryRoot, 'repository.git'),
    repositoryRecordPath: join(repositoryRoot, 'repository.json'),
    hooksPath: join(repositoryRoot, 'hooks'),
    homePath: join(managedRoot, 'git-home'),
    instanceRoot,
    bindingPath: join(instanceRoot, 'binding.json'),
    worktreePath: join(instanceRoot, 'worktree'),
    quarantineRoot: join(managedRoot, 'quarantine'),
  };
}

function assertOpenIdentity(input: OpenManagedWorkspaceInput): void {
  for (const [name, value] of Object.entries({
    repositoryId: input.repositoryId,
    workspaceId: input.workspaceId,
    workspaceEpochId: input.workspaceEpochId,
    workspaceInstanceId: input.workspaceInstanceId,
  })) {
    if (!IDENTIFIER_PATTERN.test(value)) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        `Invalid ${name}: ${value}`,
      );
    }
  }
}

function assertBindingShape(value: unknown): asserts value is ManagedWorkspaceBinding {
  if (!isBinding(value)) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Invalid managed workspace binding',
    );
  }
}

function assertBindingMatches(
  binding: ManagedWorkspaceBinding,
  input: OpenManagedWorkspaceInput,
  source: SourceRepositoryInspection,
  layout: WorkspaceLayout,
  runtimeDigest: `sha256:${string}`,
): void {
  assertBindingShape(binding);
  assertBindingPaths(binding, layout);
  if (
    binding.repositoryId !== input.repositoryId ||
    binding.workspaceId !== input.workspaceId ||
    binding.workspaceEpochId !== input.workspaceEpochId ||
    binding.workspaceInstanceId !== input.workspaceInstanceId ||
    !samePath(binding.sourceRoot, source.sourceRoot) ||
    !samePath(binding.sourceGitCommonDir, source.gitCommonDir) ||
    binding.sourceHeadCommitOid !== source.headCommitOid ||
    binding.sourceTreeOid !== source.treeOid ||
    binding.baselineTreeOid !== source.treeOid ||
    binding.gitRuntimeSha256 !== runtimeDigest ||
    binding.objectFormat !== source.objectFormat ||
    binding.materializationProfileDigest !==
      materializationProfileDigest(runtimeDigest, source.objectFormat) ||
    binding.headRef !== managedHeadRef(input.workspaceId, input.workspaceEpochId)
  ) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Managed workspace binding does not match the requested source boundary',
    );
  }
}

function assertBindingRepository(
  binding: ManagedWorkspaceBinding,
  repository: ManagedRepositoryRecord,
): void {
  if (
    binding.repositoryId !== repository.repositoryId ||
    !samePath(binding.repositoryPath, repository.repositoryPath) ||
    !samePath(binding.hooksPath, repository.hooksPath) ||
    binding.sourceHeadCommitOid !== repository.sourceHeadCommitOid ||
    binding.sourceTreeOid !== repository.sourceTreeOid ||
    binding.baselineCommitOid !== repository.baselineCommitOid ||
    binding.baselineTreeOid !== repository.baselineTreeOid ||
    binding.gitRuntimeSha256 !== repository.gitRuntimeSha256 ||
    binding.objectFormat !== repository.objectFormat ||
    binding.materializationProfileDigest !== repository.materializationProfileDigest
  ) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Managed workspace binding does not match its Git repository record',
    );
  }
}

function assertBindingPaths(binding: ManagedWorkspaceBinding, layout: WorkspaceLayout): void {
  if (
    !samePath(binding.repositoryPath, layout.repositoryPath) ||
    !samePath(binding.worktreePath, layout.worktreePath) ||
    !samePath(binding.hooksPath, layout.hooksPath)
  ) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Managed workspace binding escapes its owned storage namespace',
    );
  }
}

function assertRepositoryMatches(
  record: ManagedRepositoryRecord,
  input: OpenManagedWorkspaceInput,
  source: SourceRepositoryInspection,
  layout: WorkspaceLayout,
  runtimeDigest: `sha256:${string}`,
): void {
  if (
    record.repositoryId !== input.repositoryId ||
    !samePath(record.sourceRoot, source.sourceRoot) ||
    !samePath(record.sourceGitCommonDir, source.gitCommonDir) ||
    record.sourceHeadCommitOid !== source.headCommitOid ||
    record.sourceTreeOid !== source.treeOid ||
    record.baselineTreeOid !== source.treeOid ||
    record.gitRuntimeSha256 !== runtimeDigest ||
    record.objectFormat !== source.objectFormat ||
    record.materializationProfileDigest !==
      materializationProfileDigest(runtimeDigest, source.objectFormat) ||
    !samePath(record.repositoryPath, layout.repositoryPath) ||
    !samePath(record.hooksPath, layout.hooksPath)
  ) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Managed Git repository does not match the requested source boundary',
    );
  }
}

async function readBinding(path: string): Promise<ManagedWorkspaceBinding | undefined> {
  const value = await readJson(path);
  if (value === undefined) return undefined;
  assertBindingShape(value);
  return value;
}

async function readRepositoryRecord(path: string): Promise<ManagedRepositoryRecord | undefined> {
  const value = await readJson(path);
  if (value === undefined) return undefined;
  if (!isRepositoryRecord(value)) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      `Invalid managed Git repository record: ${path}`,
    );
  }
  return value;
}

function isBinding(value: unknown): value is ManagedWorkspaceBinding {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, BINDING_KEYS) &&
    value.schemaVersion === BINDING_SCHEMA_VERSION &&
    value.protocol === 'git_managed_workspace_v1' &&
    typeof value.repositoryId === 'string' &&
    IDENTIFIER_PATTERN.test(value.repositoryId) &&
    typeof value.workspaceId === 'string' &&
    IDENTIFIER_PATTERN.test(value.workspaceId) &&
    typeof value.workspaceEpochId === 'string' &&
    IDENTIFIER_PATTERN.test(value.workspaceEpochId) &&
    typeof value.workspaceInstanceId === 'string' &&
    IDENTIFIER_PATTERN.test(value.workspaceInstanceId) &&
    typeof value.sourceRoot === 'string' &&
    isAbsolute(value.sourceRoot) &&
    typeof value.sourceGitCommonDir === 'string' &&
    isAbsolute(value.sourceGitCommonDir) &&
    typeof value.sourceHeadCommitOid === 'string' &&
    OID_PATTERN.test(value.sourceHeadCommitOid) &&
    typeof value.sourceTreeOid === 'string' &&
    OID_PATTERN.test(value.sourceTreeOid) &&
    typeof value.repositoryPath === 'string' &&
    isAbsolute(value.repositoryPath) &&
    typeof value.worktreePath === 'string' &&
    isAbsolute(value.worktreePath) &&
    typeof value.hooksPath === 'string' &&
    isAbsolute(value.hooksPath) &&
    typeof value.baselineCommitOid === 'string' &&
    OID_PATTERN.test(value.baselineCommitOid) &&
    typeof value.baselineTreeOid === 'string' &&
    OID_PATTERN.test(value.baselineTreeOid) &&
    typeof value.headRef === 'string' &&
    value.headRef === managedHeadRef(value.workspaceId, value.workspaceEpochId) &&
    typeof value.gitRuntimeSha256 === 'string' &&
    SHA256_PATTERN.test(value.gitRuntimeSha256) &&
    (value.objectFormat === 'sha1' || value.objectFormat === 'sha256') &&
    typeof value.materializationProfileDigest === 'string' &&
    SHA256_PATTERN.test(value.materializationProfileDigest) &&
    value.materializationSemantics === MATERIALIZATION_SEMANTICS
  );
}

function isRepositoryRecord(value: unknown): value is ManagedRepositoryRecord {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, REPOSITORY_KEYS) &&
    value.schemaVersion === REPOSITORY_SCHEMA_VERSION &&
    value.protocol === 'maka_managed_git_repository_v1' &&
    typeof value.repositoryId === 'string' &&
    IDENTIFIER_PATTERN.test(value.repositoryId) &&
    typeof value.sourceRoot === 'string' &&
    isAbsolute(value.sourceRoot) &&
    typeof value.sourceGitCommonDir === 'string' &&
    isAbsolute(value.sourceGitCommonDir) &&
    typeof value.sourceHeadCommitOid === 'string' &&
    OID_PATTERN.test(value.sourceHeadCommitOid) &&
    typeof value.sourceTreeOid === 'string' &&
    OID_PATTERN.test(value.sourceTreeOid) &&
    typeof value.repositoryPath === 'string' &&
    isAbsolute(value.repositoryPath) &&
    typeof value.hooksPath === 'string' &&
    isAbsolute(value.hooksPath) &&
    typeof value.baselineCommitOid === 'string' &&
    OID_PATTERN.test(value.baselineCommitOid) &&
    typeof value.baselineTreeOid === 'string' &&
    OID_PATTERN.test(value.baselineTreeOid) &&
    typeof value.gitRuntimeSha256 === 'string' &&
    SHA256_PATTERN.test(value.gitRuntimeSha256) &&
    (value.objectFormat === 'sha1' || value.objectFormat === 'sha256') &&
    typeof value.materializationProfileDigest === 'string' &&
    SHA256_PATTERN.test(value.materializationProfileDigest) &&
    value.materializationSemantics === MATERIALIZATION_SEMANTICS
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length && actual.every((key, index) => key === canonical[index])
  );
}

function sameBinding(left: ManagedWorkspaceBinding, right: ManagedWorkspaceBinding): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('control record is not one regular non-symlink file');
    }
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      `Invalid managed workspace control record: ${path}`,
      { cause: error },
    );
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function moveToQuarantine(
  source: string,
  quarantineRoot: string,
  label: string,
): Promise<string> {
  await mkdir(quarantineRoot, { recursive: true });
  const target = join(quarantineRoot, `${sanitizeReason(label)}-${Date.now()}-${randomUUID()}`);
  await rename(source, target);
  return target;
}

async function canonicalDirectory(
  path: string,
  code: GitWorkspaceServiceErrorCode,
): Promise<string> {
  try {
    const canonical = normalize(await realpath(path));
    if (!(await stat(canonical)).isDirectory()) throw new Error('not a directory');
    return canonical;
  } catch (error) {
    throw new GitWorkspaceServiceError(code, `Directory is unavailable: ${path}`, { cause: error });
  }
}

async function ensureOwnedDirectory(path: string, ownerRoot: string): Promise<void> {
  const requested = normalize(resolve(path));
  const canonicalOwner = normalize(await realpath(ownerRoot));
  const relation = relative(normalize(resolve(ownerRoot)), requested);
  if (relation.startsWith('..') || isAbsolute(relation)) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      `Managed workspace control path escapes its owner root: ${path}`,
    );
  }
  let current = normalize(resolve(ownerRoot));
  for (const segment of relation.split(/[\\/]/u).filter(Boolean)) {
    current = join(current, segment);
    try {
      await mkdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const info = await lstat(current);
    const canonical = normalize(await realpath(current));
    if (!info.isDirectory() || info.isSymbolicLink() || !isPathWithin(canonical, canonicalOwner)) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        `Managed workspace control path is not one owned directory: ${current}`,
      );
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function isNonSymlinkDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function resolveGitPath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = normalize(resolve(left));
  const normalizedRight = normalize(resolve(right));
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isPathWithin(path: string, root: string): boolean {
  const candidate = normalize(resolve(path));
  const owner = normalize(resolve(root));
  const comparisonCandidate = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  const comparisonOwner = process.platform === 'win32' ? owner.toLowerCase() : owner;
  const relation = relative(comparisonOwner, comparisonCandidate);
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
}

function sanitizeReason(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 64) || 'unknown'
  );
}

function compactIdentity(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function managedHeadRef(workspaceId: string, workspaceEpochId: string): string {
  return `refs/maka/workspaces/${workspaceId}/epochs/${workspaceEpochId}/head`;
}

function materializationProfileDigest(
  gitRuntimeSha256: `sha256:${string}`,
  objectFormat: string,
): `sha256:${string}` {
  const profile = JSON.stringify({
    protocol: 'git_materialization_profile_v1',
    gitRuntimeSha256,
    objectFormat,
    platform: process.platform,
    autocrlf: false,
    safecrlf: true,
    attributes: 'reject_v1',
    symlinks: 'reject_v1',
    submodules: 'reject_v1',
    caseCollisions: 'reject_v1',
    ignoredInputs: 'exclude_v1',
  });
  return `sha256:${createHash('sha256').update(profile).digest('hex')}`;
}

function parseTreeEntries(output: string): GitTreeEntry[] {
  return output
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf('\t');
      const metadata = tab >= 0 ? record.slice(0, tab) : '';
      const path = tab >= 0 ? record.slice(tab + 1) : '';
      const mode = metadata.split(' ', 1)[0] ?? '';
      if (!mode || !path) {
        throw new GitWorkspaceServiceError(
          'repository_ineligible',
          'Git source tree contains an unreadable entry',
        );
      }
      return { mode, path };
    });
}

function assertSupportedTree(entries: readonly GitTreeEntry[]): void {
  const caseFolded = new Set<string>();
  for (const entry of entries) {
    if (entry.mode !== '100644' && entry.mode !== '100755') {
      throw new GitWorkspaceServiceError(
        'repository_ineligible',
        'Symlinks, submodules, and special Git modes are not supported by managed workspace v1',
      );
    }
    if (entry.path === '.gitattributes' || entry.path.endsWith('/.gitattributes')) {
      throw new GitWorkspaceServiceError(
        'repository_ineligible',
        'Tracked .gitattributes require a materialization profile not supported by v1',
      );
    }
    const folded = entry.path.normalize('NFC').toLocaleLowerCase('en-US');
    if (caseFolded.has(folded)) {
      throw new GitWorkspaceServiceError(
        'repository_ineligible',
        'Case-colliding Git paths are not supported by managed workspace v1',
      );
    }
    caseFolded.add(folded);
  }
}

function baselineCommitEnvironment(): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: 'Maka Workspace Service',
    GIT_AUTHOR_EMAIL: 'workspace@maka.invalid',
    GIT_AUTHOR_DATE: BASELINE_DATE,
    GIT_COMMITTER_NAME: 'Maka Workspace Service',
    GIT_COMMITTER_EMAIL: 'workspace@maka.invalid',
    GIT_COMMITTER_DATE: BASELINE_DATE,
    GIT_WORKSPACE_BASELINE_MESSAGE: BASELINE_MESSAGE,
  };
}

function isolatedGitEnvironment(executablePath: string, homePath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: homePath,
    XDG_CONFIG_HOME: join(homePath, 'xdg'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_OPTIONAL_LOCKS: '0',
    LANG: 'C',
    LC_ALL: 'C',
    PATH: dirname(executablePath),
  };
  for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'TMP', 'TEMP', 'TMPDIR']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

function fixedGitArguments(hooksPath: string): string[] {
  return [
    '--no-pager',
    '-c',
    'core.autocrlf=false',
    '-c',
    'core.safecrlf=true',
    '-c',
    `core.hooksPath=${hooksPath}`,
    '-c',
    'credential.helper=',
    '-c',
    'credential.interactive=never',
    '-c',
    'protocol.file.allow=always',
  ];
}

function waitForChildExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
}

function collectBoundedStderr(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return Promise.resolve('');
  return new Promise((resolve) => {
    let output = '';
    stream.on('data', (chunk) => {
      if (output.length < 64 * 1024) output += String(chunk);
    });
    stream.on('end', () => resolve(output.slice(0, 64 * 1024).trim()));
  });
}

async function sha256File(path: string): Promise<`sha256:${string}`> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

function exitCode(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === 'number' ? error.code : undefined;
}
