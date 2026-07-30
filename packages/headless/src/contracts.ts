/**
 * @maka/headless contracts — the walking-skeleton surface (issue #31).
 *
 * The lab treats an agent configuration as something testable: run a
 * `Config` against a `Task`, record what happened, score it. Keeping
 * `Config` and `Task` separable is the whole point — an experiment is
 * `Config × Task`.
 *
 * MVP scope only. Deliberately deferred as pure additions: a matrix /
 * compare layer, LLM/rule evaluators (MVP = command/test only), Docker
 * execution, network allowlist, toolset overrides on Config, and
 * promoting these contracts into @maka/core once a second consumer exists.
 */

import type {
  AgentSwarmAuthorizationSource,
  BackendKind,
  EffectiveOrchestrationSource,
  OrchestrationMode,
  ThinkingLevel,
} from '@maka/core';

/**
 * A unit of work the lab runs a Config against. Field names lean toward
 * the SWE-bench instance shape so a real benchmark instance maps in
 * later without reshaping.
 */
export interface Task {
  id: string;
  /** The prompt handed to the agent as the user turn. */
  instruction: string;
  /**
   * Absolute path to the initial workspace fixture. Copied per run and
   * never mutated — the agent only ever touches the throwaway copy.
   */
  workspaceDir: string;
  /**
   * Legacy command verifier. Still accepted as an alias for
   * `verifier: { kind: "command", ...verification }`.
   */
  verification?: TaskVerification;
  /** How the run is officially verified. Lives on the Task, never the Config. */
  verifier?: VerifierSpec;
  benchmark?: BenchmarkContract;
}

export interface TaskVerification {
  /**
   * Shell command run in the throwaway workspace AFTER the agent
   * finishes. Exit code 0 = pass. (FAIL_TO_PASS / PASS_TO_PASS
   * semantics are a later addition.)
   */
  command: string;
  /** Hard timeout for the verification command. Defaults applied by the runner. */
  timeoutMs?: number;
  /**
   * Files/dirs (relative to the workspace) restored from the pristine
   * fixture AFTER the agent finishes and BEFORE the command runs — so a
   * config under test cannot rewrite its own grading to pass. List the
   * test / grading assets here; anything not listed is the agent's to edit.
   *
   * REQUIRED, not optional: the grading boundary must be a conscious choice,
   * never a silent omission. Declare `[]` only when the verification reads
   * nothing the agent can forge (e.g. a pure `test -f` against a fixture file).
   */
  protectedPaths: string[];
}

export type VerifierSpec = CommandVerifierSpec | TerminalBenchVerifierSpec | SweBenchVerifierSpec;

export interface CommandVerifierSpec {
  kind: 'command';
  command: string;
  timeoutMs?: number;
  protectedPaths: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface TerminalBenchVerifierSpec {
  kind: 'terminal_bench';
  adapter: 'terminal-bench';
  instanceId: string;
  dataset?: string;
  datasetPath?: string;
  taskDir?: string;
  taskDescriptionKey?: string;
  testCommand?: string;
  maxAgentTimeoutSec?: number;
  maxTestTimeoutSec?: number;
  protectedPaths?: string[];
  adapterOptions?: Record<string, unknown>;
}

export interface SweBenchVerifierSpec {
  kind: 'swe_bench';
  adapter: 'swe-bench';
  instanceId: string;
  protectedPaths?: string[];
  adapterOptions?: Record<string, unknown>;
}

export interface BenchmarkContract {
  source?: 'local' | 'terminal_bench' | 'swe_bench';
  instanceId?: string;
  official?: boolean;
  denominator?: 'scored_only' | 'eligible';
  /**
   * Benchmark-side metadata. P0 heavy-task mode recognizes explicit
   * `heavyTask: true` or `heavyTaskMode: { enabled: true, reason?: string }`.
   */
  metadata?: Record<string, unknown>;
}

export interface SubmittedSnapshot {
  id: string;
  workspaceRoot: string;
  snapshotPath: string;
  artifactRefs: Array<Record<string, unknown>>;
  createdAt: number;
  manifestHash?: string;
}

export interface ArtifactFreezeResult {
  submittedSnapshot: SubmittedSnapshot;
  warnings?: string[];
}

/**
 * The variable under test. References Maka's existing model/connection
 * selection — it does NOT invent a model format. The toolset is a
 * capability set, not an interactive permission policy.
 */
export interface Config {
  id: string;
  backend: BackendKind;
  llmConnectionSlug: string;
  /** Falls back to the connection's default model when omitted. */
  model?: string;
  /** Provider-native reasoning depth for a fixed benchmark configuration. */
  thinkingLevel?: ThinkingLevel;
  /**
   * Complete Layer 1 system prompt for the config under test. Headless uses
   * its non-empty default when omitted, preserves a non-empty custom string
   * byte-for-byte, and rejects empty or whitespace-only strings before
   * execution. Task-run and Harbor paths retain their existing enabled policy
   * overlays; the legacy direct runner resolves Layer 1 only. This benchmark
   * variable is passed directly to the backend constructor; it is not persisted
   * session state or the child-agent instruction channel.
   */
  systemPrompt?: string;
  /**
   * Explicit opt-in/out for heavy-task benchmark behavior. When enabled,
   * headless appends the centralized heavy-task policy to the model-visible
   * system prompt and records the selection reason in task-run telemetry.
   */
  heavyTaskMode?: boolean | HeavyTaskModeConfig;
  /**
   * Explicit opt-in/out for economy-task benchmark behavior. When enabled,
   * headless appends the centralized economy-task policy to the model-visible
   * system prompt for simple data-transform tasks.
   */
  economyTaskMode?: boolean | EconomyTaskModeConfig;
  /**
   * Explicit opt-in for Maka's parent-facing Agent tool group. Omitted and
   * false both leave the group unbound; true binds it behind the catalog's
   * deferred `load_tools` activation.
   */
  agentTools?: boolean;
}

export interface HeavyTaskModeConfig {
  enabled?: boolean;
  reason?: string;
  policyVersion?: string;
}

export interface EconomyTaskModeConfig {
  enabled?: boolean;
  reason?: string;
  policyVersion?: string;
}

export type HeadlessSystemPromptMode = 'default' | 'custom';

/** One row of canonical truth per run: did it run, did it pass, and how much it cost. */
export interface ResultRecord {
  taskId: string;
  configId: string;
  sessionId: string;
  runId: string;
  /** Layer 1 source used by new headless runs; absent on legacy records. */
  systemPromptMode?: HeadlessSystemPromptMode;
  /** SHA-256 of the final model-visible system prompt, including policy overlays. */
  systemPromptHash?: string;
  /** Effective orchestration evidence copied from the authoritative AgentRun header. */
  orchestrationMode?: OrchestrationMode;
  orchestrationSource?: EffectiveOrchestrationSource;
  agentSwarmAuthorization?: AgentSwarmAuthorizationSource;
  /** Did the agent invocation finish (vs. error out mid-run)? */
  status: 'completed' | 'failed';
  /** Explicit runner status; legacy `status` is preserved for JSONL readers. */
  runnerCompleted?: boolean;
  /** Did the Task's verification command pass? */
  passed: boolean;
  /** Whether the final scorer produced an official pass/fail for this cell. */
  scored?: boolean;
  /** Whether this cell belongs in the official benchmark denominator. */
  eligible?: boolean;
  /** Why a cell was excluded from the official denominator. */
  excludedReason?: string;
  verifierKind?: VerifierSpec['kind'];
  scoreResultId?: string;
  verifierResultId?: string;
  submittedSnapshotId?: string;
  /** Verification command exit code (null if it never ran / errored to spawn). */
  exitCode: number | null;
  /** Trajectory length proxy: number of RuntimeEvents emitted. */
  steps: number;
  durationMs: number;
  startedAt: number;
  finishedAt: number;
  /** Present when the run threw before producing a result (matrix-level failure). */
  error?: string;
  /** Stable failure class from the runtime invocation when status is failed. */
  errorClass?: string;
}
