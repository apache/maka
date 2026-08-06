import { randomUUID } from 'node:crypto';
import type { BackendKind, OrchestrationMode, TurnOrchestration } from '@maka/core';
import {
  AgentGraphCoordinator,
  AGENT_TOOL_GROUP_ID,
  BackendRegistry,
  SessionManager,
  buildChildAgentTools,
  type InvocationResult,
} from '@maka/runtime';
import { createReadImageSnapshotter } from '@maka/storage';
import { createAgentGraphControlStore } from '@maka/storage/agent-graph-control-store';
import type { Config, ResultRecord, Task } from './contracts.js';
import { registerFakeBackend } from './backends.js';
import {
  authenticateHeadlessStorageWriter,
  openHeadlessStorageForWrite,
  type HeadlessStorageWriter,
} from './headless-storage.js';
import type { HeadlessBackendContext, RealBackendIsolation } from './isolation.js';
import { endManagedShellSessions, validateRealBackendIsolation } from './isolation.js';
import {
  freezeSubmittedWorkspace,
  prepareScoringWorkspace,
  prepareWorkspace,
  restoreProtectedPaths,
} from './sandbox.js';
import { defaultFinalScorer } from './scorer.js';
import { buildHeadlessProductToolSurfaceForBackend } from './tools.js';
import { normalizeVerifier, runVerifier, verifierProtectedPaths } from './verifier.js';
import type { BenchmarkAdapterRegistry } from './benchmark-adapters.js';
import { createHeadlessSessionCapabilityBridge } from './session-capabilities.js';
import { resolveHeadlessSystemPrompt } from './system-prompts.js';

export interface RunExperimentDeps {
  /**
   * Where the lab writes session / run / trajectory JSONL. This is the
   * STORAGE root, distinct from the agent's cwd (the throwaway fixture
   * copy) — the agent never sees the lab's own bookkeeping.
   */
  storageRoot: string;
  /**
   * Override the backend wiring — a test seam. Defaults to the inert
   * FakeBackend, the only backend this build runs; real backends rejoin with
   * the isolated executor. Minimal usage is just `{ storageRoot }`.
   */
  registerBackends?: (
    registry: BackendRegistry,
    context: HeadlessBackendContext,
  ) => void | Promise<void>;
  /**
   * Required for every model-backed backend. This is deliberately explicit:
   * a throwaway workspace is not a security boundary, so a real backend may run
   * only when the caller provides an external isolation boundary such as a
   * Harbor/Terminal-Bench environment or Docker workspace executor.
   */
  realBackendIsolation?: RealBackendIsolation;
  benchmarkAdapters?: BenchmarkAdapterRegistry;
  now?: () => number;
  newId?: () => string;
  /** Persistent orchestration default for the created headless session. */
  orchestrationMode?: OrchestrationMode;
  /** Trusted override for this experiment's single user turn. */
  turnOrchestration?: TurnOrchestration;
}

/**
 * A backend is "inert" when it executes no real tools on the host — only the
 * stub FakeBackend qualifies. Every model-backed backend (`ai-sdk`,
 * `pi-agent`) can drive Bash/network, and the throwaway workspace is a copy,
 * not a jail, so running one in-process would hand the host (files, env incl.
 * API keys, network) to the config under test. Those run ONLY after the caller
 * supplies an explicit external isolation boundary; otherwise the preflight in
 * runExperiment fails closed.
 */
export function backendNeedsIsolation(backend: BackendKind): boolean {
  return backend !== 'fake';
}

/**
 * Validate a Task's grading boundary at the ENGINE boundary — so a public
 * `runExperiment` / `runMatrix` caller that omits or mis-declares
 * `protectedPaths` fails fast, before any workspace / session / backend is
 * created, instead of running the agent and only then tripping over a bad
 * field. The CLI reuses this; there is no second, divergent check.
 */
export function validateTaskVerification(task: Task): void {
  normalizeVerifier(task);
}

/**
 * Run one `Config × Task` end-to-end: copy the fixture into a throwaway
 * workspace, drive a single headless agent turn through SessionManager,
 * capture the trajectory, score it with the Task's verification command,
 * and return a ResultRecord. The workspace copy is always cleaned up.
 */
export async function runExperiment(
  config: Config,
  task: Task,
  deps: RunExperimentDeps,
): Promise<ResultRecord> {
  const storage = await openHeadlessStorageForWrite(deps.storageRoot);
  return runExperimentWithStorage(config, task, deps, storage);
}

export async function runExperimentWithStorage(
  config: Config,
  task: Task,
  deps: RunExperimentDeps,
  storage: HeadlessStorageWriter,
): Promise<ResultRecord> {
  storage = authenticateHeadlessStorageWriter(storage);
  if (backendNeedsIsolation(config.backend)) {
    validateRealBackendIsolation(deps.realBackendIsolation);
    if (!deps.registerBackends) {
      throw new Error(
        `@maka/headless: backend "${config.backend}" requires registerBackends to wire an isolated backend factory`,
      );
    }
  }
  validateTaskVerification(task);
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  const startedAt = now();
  const prompt = resolveHeadlessSystemPrompt(config);
  const effectiveConfig = { ...config, systemPrompt: prompt.systemPrompt };

  const workspace = await prepareWorkspace(task.workspaceDir);
  let graphCoordinator: AgentGraphCoordinator | undefined;
  let graphControlStore: ReturnType<typeof createAgentGraphControlStore> | undefined;
  try {
    const agentWorkspaceDir = deps.realBackendIsolation?.workspaceDir ?? workspace.dir;
    const productToolSurface = buildHeadlessProductToolSurfaceForBackend(
      effectiveConfig.backend,
      deps.realBackendIsolation?.toolExecutor,
      {
        agentTools: effectiveConfig.agentTools,
        snapshotImage: createReadImageSnapshotter(storage.artifactStore),
      },
    );
    const verifier = normalizeVerifier(task);
    const backends = new BackendRegistry();
    const sessionCapabilities = createHeadlessSessionCapabilityBridge();
    const registerBackends: NonNullable<RunExperimentDeps['registerBackends']> =
      deps.registerBackends ?? ((registry) => registerFakeBackend(registry));
    await registerBackends(backends, {
      config: effectiveConfig,
      task,
      storageRoot: deps.storageRoot,
      workspaceDir: agentWorkspaceDir,
      ...sessionCapabilities.capabilities,
      artifactStore: storage.artifactStore,
      ...(productToolSurface ? { productToolSurface } : {}),
      ...(backendNeedsIsolation(config.backend)
        ? {
            realBackendIsolation: deps.realBackendIsolation,
            toolExecutor: deps.realBackendIsolation?.toolExecutor,
          }
        : {}),
    });

    let invocation: InvocationResult | undefined;
    const runStore = storage.executionStores.agentRunStore;
    const manager = new SessionManager({
      store: storage.executionStores.sessionStore,
      runStore,
      runtimeEventStore: storage.executionStores.runtimeEventStore,
      backends,
      ...(productToolSurface?.boundSurfaceIds.includes(AGENT_TOOL_GROUP_ID)
        ? {
            childTools: buildChildAgentTools(productToolSurface.tools),
          }
        : {}),
      newId,
      now,
      runtimeSource: 'test',
      runtimeInvocationObserver: (result) => {
        invocation = result;
      },
    });
    const session = await manager.createSession(
      {
        cwd: agentWorkspaceDir,
        backend: config.backend,
        llmConnectionSlug: config.llmConnectionSlug,
        model: config.model,
        permissionMode: 'ask',
        ...(deps.orchestrationMode ? { orchestrationMode: deps.orchestrationMode } : {}),
        name: `lab:${config.id}:${task.id}`,
      },
      { initialBoundary: { kind: 'external', revision: 0 } },
    );
    graphControlStore = createAgentGraphControlStore(deps.storageRoot);
    graphCoordinator = new AgentGraphCoordinator({
      sessionStore: storage.executionStores.sessionStore,
      runStore,
      runtimeEventStore: storage.executionStores.runtimeEventStore,
      controlStore: graphControlStore,
      runtime: manager,
      newId,
      rootSessionId: session.id,
    });
    sessionCapabilities.bind(manager, graphCoordinator);

    const turnId = newId();
    // Drain the turn to completion. The trajectory + status come from the
    // captured InvocationResult, not the streamed SessionEvents. Headless
    // execution is already enclosed by its explicit external isolation boundary.
    for await (const _event of manager.sendMessage(session.id, {
      turnId,
      text: task.instruction,
      ...(deps.turnOrchestration ? { turnOrchestration: deps.turnOrchestration } : {}),
    })) {
      // Event consumption drives the runtime to its terminal invocation.
    }
    await sessionCapabilities.settle(session.id);
    // Agent phase ends here: nothing still managed may be running while the
    // verifier observes the workspace. The enclosing finally repeats this for
    // the throwing path.
    await endManagedShellSessions(deps.realBackendIsolation);

    const status = invocation?.status ?? 'failed';
    const runnerCompleted = status === 'completed';
    const frozen = await freezeSubmittedWorkspace({ workspaceDir: workspace.dir, now, newId });
    const scoringWorkspace = await prepareScoringWorkspace(frozen.submittedSnapshot);
    try {
      await restoreProtectedPaths(
        task.workspaceDir,
        scoringWorkspace.dir,
        verifierProtectedPaths(verifier),
      );
      const verifierStartedAt = now();
      const verifierResult = await runVerifier({
        verifier,
        taskRunId: invocation?.runId ?? turnId,
        ts: verifierStartedAt,
        id: newId(),
        workspaceDir: scoringWorkspace.dir,
        submittedSnapshotId: frozen.submittedSnapshot.id,
        scoringWorkspaceId: scoringWorkspace.dir,
        benchmarkAdapters: deps.benchmarkAdapters,
      });
      const finalScore = defaultFinalScorer({
        config,
        task,
        runnerCompleted,
        runnerStatus: status,
        invocationFailure: invocation?.failure,
        submittedSnapshot: frozen.submittedSnapshot,
        verifierResult,
      });
      const finishedAt = now();
      const runEvidence = invocation
        ? await runStore.readRun(session.id, invocation.runId)
        : undefined;

      return {
        taskId: task.id,
        configId: config.id,
        sessionId: session.id,
        runId: invocation?.runId ?? turnId,
        systemPromptMode: prompt.mode,
        systemPromptHash: prompt.systemPromptHash,
        ...(runEvidence?.orchestrationMode
          ? { orchestrationMode: runEvidence.orchestrationMode }
          : {}),
        ...(runEvidence?.orchestrationSource
          ? { orchestrationSource: runEvidence.orchestrationSource }
          : {}),
        ...(runEvidence?.agentSwarmAuthorization
          ? { agentSwarmAuthorization: runEvidence.agentSwarmAuthorization }
          : {}),
        status,
        runnerCompleted,
        passed: finalScore.passed,
        scored: finalScore.scored,
        eligible: finalScore.eligible,
        ...(finalScore.excludedReason ? { excludedReason: finalScore.excludedReason } : {}),
        verifierKind: verifierResult.kind,
        verifierResultId: verifierResult.id,
        scoreResultId: newId(),
        submittedSnapshotId: frozen.submittedSnapshot.id,
        exitCode: verifierResult.exitCode ?? null,
        steps: invocation?.events.length ?? 0,
        durationMs: finishedAt - startedAt,
        startedAt,
        finishedAt,
        ...(!finalScore.scored && finalScore.errorClass
          ? {
              error:
                finalScore.excludedReason ?? invocation?.failure?.message ?? finalScore.errorClass,
            }
          : status === 'failed'
            ? {
                error:
                  invocation?.failure?.message ??
                  invocation?.failure?.class ??
                  'run did not complete',
              }
            : {}),
        ...(finalScore.errorClass
          ? { errorClass: finalScore.errorClass }
          : invocation?.failure?.class
            ? { errorClass: invocation.failure.class }
            : {}),
      };
    } finally {
      await scoringWorkspace.cleanup();
    }
  } finally {
    try {
      await endManagedShellSessions(deps.realBackendIsolation);
    } finally {
      try {
        await graphCoordinator?.close();
      } finally {
        try {
          graphControlStore?.close();
        } finally {
          await workspace.cleanup();
        }
      }
    }
  }
}
