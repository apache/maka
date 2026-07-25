import type { StorageRef } from '@maka/core';
import { isPathInside, type ShellPlan } from '@maka/runtime';
import { isAbsolute } from 'node:path';
import type { Config, Task } from './contracts.js';
import type { HeavyTaskEvidenceRecorder } from './heavy-task-evidence.js';
import type { HeavyTaskModeSelection } from './heavy-task-policy.js';
import type { HeavyTaskProgressRecorder } from './heavy-task-progress.js';
import type { HeavyTaskSelfCheckRecorder } from './heavy-task-self-check.js';
import type {
  EnvNetworkSecretPolicy,
  TaskIsolationFacts,
  ToolExecutorIdentity,
} from './task-contracts.js';
import type { HeadlessSessionCapabilities } from './session-capabilities.js';
import type { HeadlessArtifactStore } from './headless-storage.js';

export interface IsolatedCommandInput {
  command: string;
  cwd: string;
  timeoutMs?: number;
  /**
   * Bash-only opt-in. When true the executor keeps just the recoverable TAIL of
   * a large output and never kills the command for output size. Omitted/false
   * (the default) preserves FULL output up to the executor's buffer cap — so the
   * Read/Glob/Grep command fallbacks return complete, head-first content instead
   * of a silently head-dropped tail. Only buildIsolatedBashTool sets this.
   */
  boundedTail?: boolean;
}

export interface IsolatedCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  timedOut?: boolean;
}

export interface IsolatedToolExecutionControl {
  abortSignal?: AbortSignal;
}

export interface IsolatedReadFileInput {
  cwd: string;
  path: string;
  offset?: number;
  limit?: number;
}

export type IsolatedReadFileResult =
  | { content: string }
  | {
      kind: 'image';
      mimeType: string;
      ref: Extract<StorageRef, { kind: 'session_file' }>;
    };

export interface IsolatedWriteFileInput {
  cwd: string;
  path: string;
  content: string;
}

export interface IsolatedWriteFileResult {
  ok: boolean;
  path: string;
  bytes: number;
}

export interface IsolatedEditFileInput {
  cwd: string;
  path: string;
  oldString: string;
  newString: string;
}

export interface IsolatedEditFileResult {
  ok: boolean;
  path: string;
  replacements: number;
  matchedVia?: string;
  startLine?: number;
  endLine?: number;
}

export interface IsolatedGlobInput {
  cwd: string;
  pattern: string;
  searchCwd?: string;
}

export interface IsolatedGlobResult {
  files: string[];
}

export interface IsolatedGrepInput {
  cwd: string;
  pattern: string;
  path?: string;
  glob?: string;
}

export interface IsolatedGrepResult {
  matches: string[];
}

export const ISOLATED_HEADLESS_TOOL_NAMES = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
] as const;

/**
 * Executes agent-visible shell commands outside the host credential process.
 *
 * Implementations can be a Harbor/Terminal-Bench environment, a Docker
 * container, or another executor that gives the model a task workspace without
 * inheriting host env/files. The headless runner does not infer that safety:
 * callers must pass an explicit RealBackendIsolation record before any
 * model-backed backend is allowed.
 */
export interface IsolatedToolExecutor {
  exec(
    input: IsolatedCommandInput,
    control?: IsolatedToolExecutionControl,
  ): Promise<IsolatedCommandResult>;
  /**
   * Shell dialect this executor's Bash commands run in, surfaced so
   * buildIsolatedBashTool can DECLARE it in the tool description. Selection
   * without declaration is the original Windows bug (shell-detect.ts): the local
   * executor runs PowerShell on Windows, and the model must be told. Omitted =
   * POSIX (remote container / Linux host), where the historical description is
   * the contract and no dialect sentence is added.
   */
  shell?: ShellPlan;
  /**
   * Optional native file operations for executors that can address their
   * external workspace without shelling through exec. If omitted,
   * buildIsolatedHeadlessTools falls back to command-backed operations inside
   * the isolated boundary.
   *
   * Read and Edit deliberately have NO native hook. Read must always run through
   * READ_SCRIPT so every result carries the line-number / line+byte-cap / binary-
   * guard contract (#92); a native pass-through would bypass it. Edit's matching
   * logic must stay the single source of truth with the in-process builtin Edit,
   * so buildIsolatedEditTool reads bytes through the executor, computes the edit
   * in the headless process, and writes bytes back through the executor. Both
   * hold regardless of which native ops an executor provides.
   */
  writeFile?(
    input: IsolatedWriteFileInput,
    control?: IsolatedToolExecutionControl,
  ): Promise<IsolatedWriteFileResult>;
  globFiles?(
    input: IsolatedGlobInput,
    control?: IsolatedToolExecutionControl,
  ): Promise<IsolatedGlobResult>;
  grepFiles?(
    input: IsolatedGrepInput,
    control?: IsolatedToolExecutionControl,
  ): Promise<IsolatedGrepResult>;
}

export interface ExternalRealBackendIsolation {
  kind: 'external';
  /**
   * Human-readable evidence for audit logs/errors, e.g. "Harbor task
   * container" or "Docker workspace executor". It must be non-empty so a real
   * backend cannot be enabled by an accidental truthy object.
   */
  label: string;
  /**
   * Agent-visible workspace path when the external boundary owns the real
   * filesystem. For Harbor HTTP this is the container cwd (for example `/app`),
   * while the task-run control plane may still keep a local empty source
   * workspace for ledger snapshots.
   */
  workspaceDir?: string;
  /**
   * Persistent directory for freezing the agent-visible workspace after the
   * run. Set only when the controller can read workspaceDir directly; remote
   * executors such as Harbor HTTP must leave it unset.
   */
  submittedSnapshotRoot?: string;
  /**
   * Optional command executor for callers that want to reuse the built-in
   * headless Bash tool. A caller may omit this when its registered backend is
   * already isolated internally.
   */
  toolExecutor?: IsolatedToolExecutor;
}

export type RealBackendIsolation = ExternalRealBackendIsolation;

export interface HeadlessBackendContext extends Partial<HeadlessSessionCapabilities> {
  config: Config;
  task: Task;
  /** Authoritative persistence root for this run. */
  storageRoot: string;
  /** Absolute throwaway workspace path for this run. */
  workspaceDir: string;
  /** Lease-bound storage for Headless-owned artifacts. */
  artifactStore: HeadlessArtifactStore;
  /**
   * Present only for model-backed backends and only after the caller has
   * explicitly asserted an isolation boundary.
   */
  realBackendIsolation?: RealBackendIsolation;
  /** Convenience alias for realBackendIsolation.toolExecutor. */
  toolExecutor?: IsolatedToolExecutor;
  /** Heavy-task selection resolved for this task run. */
  heavyTaskMode?: HeavyTaskModeSelection;
  /** Present only when heavy-task mode is enabled for task-run backed tooling. */
  heavyTaskProgress?: HeavyTaskProgressRecorder;
  /** Present only when heavy-task mode is enabled for advisory public self-check tooling. */
  heavyTaskSelfCheck?: HeavyTaskSelfCheckRecorder;
  /** Present only when heavy-task mode is enabled for compact public evidence capture. */
  heavyTaskEvidence?: HeavyTaskEvidenceRecorder;
}

export function validateRealBackendIsolation(isolation: RealBackendIsolation | undefined): void {
  if (!isolation) {
    throw new Error(
      'model-backed backend requires an isolated executor; pass realBackendIsolation with an explicit external isolation label',
    );
  }
  if (isolation.kind !== 'external') {
    throw new Error(
      `unsupported real backend isolation kind: ${(isolation as { kind?: unknown }).kind}`,
    );
  }
  if (typeof isolation.label !== 'string' || isolation.label.trim().length === 0) {
    throw new Error('realBackendIsolation.label is required');
  }
  if (isolation.submittedSnapshotRoot !== undefined) {
    if (!isolation.workspaceDir || !isAbsolute(isolation.workspaceDir)) {
      throw new Error(
        'realBackendIsolation.submittedSnapshotRoot requires an absolute workspaceDir',
      );
    }
    if (!isAbsolute(isolation.submittedSnapshotRoot)) {
      throw new Error('realBackendIsolation.submittedSnapshotRoot must be absolute');
    }
    if (isPathInside(isolation.workspaceDir, isolation.submittedSnapshotRoot)) {
      throw new Error('realBackendIsolation.submittedSnapshotRoot must stay outside workspaceDir');
    }
  }
}

export function defaultEnvNetworkSecretPolicy(
  isolation: RealBackendIsolation | undefined,
): EnvNetworkSecretPolicy {
  if (isolation) {
    return {
      schemaVersion: 1,
      env: 'inherit_none',
      network: 'unrestricted_external_boundary',
      secrets: 'brokered_by_executor',
    };
  }
  return {
    schemaVersion: 1,
    env: 'inherit_none',
    network: 'disabled',
    secrets: 'none',
  };
}

export function taskIsolationFacts(input: {
  backendKind: string;
  required: boolean;
  isolation?: RealBackendIsolation;
  assertionSource?: TaskIsolationFacts['assertionSource'];
  validatedAt: number;
}): TaskIsolationFacts {
  return {
    schemaVersion: 1,
    backendKind: input.backendKind,
    required: input.required,
    mode: input.isolation ? 'external' : 'inert_fake_backend',
    ...(input.isolation ? { label: input.isolation.label } : {}),
    assertionSource: input.assertionSource ?? 'headless_deps',
    validatedAt: input.validatedAt,
  };
}

export function toolExecutorIdentity(input: {
  executorId: string;
  taskRunId: string;
  attemptId?: string;
  isolation?: RealBackendIsolation;
  toolNames?: string[];
}): ToolExecutorIdentity {
  const isolationMode = input.isolation ? 'external' : 'inert_fake_backend';
  return {
    schemaVersion: 1,
    executorId: input.executorId,
    taskRunId: input.taskRunId,
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    toolNames: input.toolNames ?? ['headless_runtime'],
    isolationMode,
    label: input.isolation?.label ?? 'fake backend inert tool boundary',
    commandPolicy: defaultEnvNetworkSecretPolicy(input.isolation),
  };
}
