import type { StorageRef } from '@maka/core';
import {
  isPathInside,
  type BackgroundTaskStopper,
  type EffectiveProductToolSurface,
  type ProductToolSurfaceIdentity,
  type PtyControlWriter,
  type RuntimeResourceReader,
  type ShellPlan,
  type ShellRunLauncher,
} from '@maka/runtime';
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
  SupplementalToolSetIdentity,
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
 * Managed shell sessions an executor can own, when its processes are LOCAL to
 * the headless process.
 *
 * `IsolatedToolExecutor.exec` is deliberately stateless: one command in, one
 * completed result out. That is the whole contract a remote bridge can honour,
 * and it is why a model that needs an interactive or long-lived process today
 * has to detach it with `nohup … &` and lose every handle on it.
 *
 * ShellRunProcessManager already owns the missing half — background runs, PTY
 * screens, stdin writes, ref reads, termination — but it spawns inside the
 * calling process, so only an executor whose workspace IS that process can
 * expose it. The in-container Harbor cell is exactly that case; the Harbor HTTP
 * bridge is not, and leaves this undefined.
 */
export interface IsolatedShellSessions
  extends ShellRunLauncher,
    RuntimeResourceReader,
    BackgroundTaskStopper,
    PtyControlWriter {
  /**
   * Environment for managed shell processes. REQUIRED, not optional: a launch
   * that carries no env makes ShellRunProcessManager fall back to the headless
   * process's own `process.env`, which in a Harbor cell holds the provider
   * credentials the cell uses to call the model. `exec` strips those through
   * childProcessEnv; managed launches must be handed the same stripped env.
   */
  readonly commandEnv: NodeJS.ProcessEnv;
  /**
   * The executor's own default command timeout, so a managed foreground command
   * is not killed earlier than the same operator's `exec` commands were.
   */
  readonly defaultCommandTimeoutMs?: number;
  /**
   * Terminates every still-live managed session. Called once when the agent
   * phase ends so no managed process survives into grading, and so PTY children
   * are not orphaned by the cell process exiting.
   */
  terminateAll(): Promise<void>;
}

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
   * Present only when this executor's processes run in the headless process, so
   * the runtime's managed shell can own them. See IsolatedShellSessions.
   */
  shellSessions?: IsolatedShellSessions;
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
  /** One policy-filtered product-tool surface for this root Session / TaskRun. */
  productToolSurface?: EffectiveProductToolSurface;
  /** Heavy-task selection resolved for this task run. */
  heavyTaskMode?: HeavyTaskModeSelection;
  /** Present only when heavy-task mode is enabled for task-run backed tooling. */
  heavyTaskProgress?: HeavyTaskProgressRecorder;
  /** Present only when heavy-task mode is enabled for advisory public self-check tooling. */
  heavyTaskSelfCheck?: HeavyTaskSelfCheckRecorder;
  /** Present only when heavy-task mode is enabled for compact public evidence capture. */
  heavyTaskEvidence?: HeavyTaskEvidenceRecorder;
}

/**
 * Ends the agent phase's managed processes.
 *
 * Every headless orchestrator has to enforce the same rule — nothing the model
 * left managed may still be running when the workspace is graded, and no PTY
 * child may outlive the process that spawned it — so the rule is written once
 * here and triggered from each orchestrator rather than remembered three times.
 *
 * Call it at the agent-to-verification handoff AND from the enclosing finally:
 * the handoff covers the normal path, the finally covers the thrown one, and
 * terminateAll is idempotent. Processes the model deliberately detached are not
 * managed and are untouched — some tasks are graded against a service the agent
 * was asked to leave running.
 */
export async function endManagedShellSessions(
  isolation: RealBackendIsolation | undefined,
): Promise<void> {
  try {
    await isolation?.toolExecutor?.shellSessions?.terminateAll();
  } catch {
    // Best-effort: reaping is cleanup, and failing it must not mask the run's
    // own outcome or replace a real error on the throwing path.
  }
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
  productToolSurface?: ProductToolSurfaceIdentity;
  supplementalToolSets?: SupplementalToolSetIdentity[];
}): ToolExecutorIdentity {
  const isolationMode = input.isolation ? 'external' : 'inert_fake_backend';
  const supplementalToolSets = input.supplementalToolSets?.map((entry) => ({
    label: entry.label,
    toolNames: [...entry.toolNames],
  }));
  const toolNames = input.productToolSurface
    ? [
        ...input.productToolSurface.productToolNames,
        ...(supplementalToolSets?.flatMap((entry) => entry.toolNames) ?? []),
      ]
    : (input.toolNames ?? ['headless_runtime']);
  return {
    schemaVersion: 1,
    executorId: input.executorId,
    taskRunId: input.taskRunId,
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    toolNames,
    ...(input.productToolSurface ? { productToolSurface: input.productToolSurface } : {}),
    ...(supplementalToolSets && supplementalToolSets.length > 0 ? { supplementalToolSets } : {}),
    isolationMode,
    label: input.isolation?.label ?? 'fake backend inert tool boundary',
    commandPolicy: defaultEnvNetworkSecretPolicy(input.isolation),
  };
}
