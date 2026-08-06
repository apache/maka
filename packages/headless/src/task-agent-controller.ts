import { randomUUID } from 'node:crypto';
import {
  isTerminalRuntimeEvent,
  type RuntimeEvent,
  type RuntimeEventStore,
  type SessionBlockedReason,
  type SessionHeader,
  type SessionStatus,
  type StoredMessage,
} from '@maka/core';
import {
  AgentGraphCoordinator,
  AGENT_TOOL_GROUP_ID,
  AgentRun,
  AiSdkFlow,
  BackendRegistry,
  RuntimeRunner,
  SessionManager,
  buildChildAgentTools,
  type AgentRunActiveSession,
  type InvocationResult,
  type SessionStore,
} from '@maka/runtime';
import { createReadImageSnapshotter } from '@maka/storage';
import { createAgentGraphControlStore } from '@maka/storage/agent-graph-control-store';
import type { Config, ResultRecord, Task } from './contracts.js';
import { registerFakeBackend } from './backends.js';
import {
  countRuntimeSteps,
  summarizeCellTools,
  type HarborCellToolSummary,
} from './cell-output.js';
import {
  createHeavyTaskEvidenceRecorder,
  renderHeavyTaskEvidenceForPrompt,
} from './heavy-task-evidence.js';
import { resolveHeavyTaskMode } from './heavy-task-policy.js';
import { resolveEconomyTaskMode } from './economy-task-policy.js';
import { MAX_NODE_TIMER_MS } from './headless-run-env.js';
import {
  authenticateHeadlessStorageWriter,
  isStorageRootAuthorityError,
  openHeadlessStorageForWrite,
  type HeadlessStorageWriter,
} from './headless-storage.js';
import {
  createHeavyTaskProgressRecorder,
  HEAVY_TASK_PROGRESS_TOOL_NAMES,
  renderHeavyTaskProgressForPrompt,
} from './heavy-task-progress.js';
import {
  createHeavyTaskSelfCheckRecorder,
  HEAVY_TASK_SELF_CHECK_TOOL_NAMES,
  renderHeavyTaskSelfCheckForPrompt,
} from './heavy-task-self-check.js';
import {
  evaluateHeavyTaskSelfCheckGate,
  heavyTaskSelfCheckGateStateFromDecision,
} from './heavy-task-self-check-gate.js';
import { observeHeavyTaskWorkspace } from './heavy-task-workspace-observation.js';
import type { HeadlessBackendContext } from './isolation.js';
import {
  endManagedShellSessions,
  taskIsolationFacts,
  toolExecutorIdentity,
  validateRealBackendIsolation,
} from './isolation.js';
import {
  resolveHeadlessSystemPrompt,
  type ResolvedHeadlessSystemPrompt,
} from './system-prompts.js';
import {
  freezeSubmittedWorkspace,
  prepareScoringWorkspace,
  prepareWorkspace,
  restoreProtectedPaths,
} from './sandbox.js';
import { defaultFinalScorer } from './scorer.js';
import { createHeadlessSessionCapabilityBridge } from './session-capabilities.js';
import { normalizeVerifier, runVerifier, verifierProtectedPaths } from './verifier.js';
import {
  backendNeedsIsolation,
  type RunExperimentDeps,
  validateTaskVerification,
} from './runner.js';
import {
  taxonomyFromResultRecord,
  type AutonomousResultTaxonomy,
  type FeedbackObservation,
  type ScoreResult,
  type TaskAttemptStatus,
  type TaskEvent,
  type TaskInterventionPolicy,
  type TaskRunError,
  type TaskRunResult,
  type VerifierResult,
} from './task-contracts.js';
import type { TaskRunProjection } from './task-run-projection.js';
import type { TaskRunWriter } from './task-run-store.js';
import { taskDefinitionFromTask } from './task-run-adapter.js';
import { taskEvidenceRuntimeProvenanceLinks } from './task-evidence-provenance.js';
import { taskAttemptExecutionEvidence } from './task-execution-lineage.js';
import { bindSelfCheckEvidence } from './task-self-check-evidence.js';
import { buildHeadlessProductToolSurfaceForBackend } from './tools.js';

export interface RunTaskOnceDeps extends RunExperimentDeps {
  taskRunId?: string;
  attemptId?: string;
  createTaskRun?: boolean;
  closeTaskRun?: boolean;
  instructionOverride?: string;
  priorRuntimeContext?: readonly RuntimeEvent[];
  interventionPolicy?: TaskInterventionPolicy;
  /** Absolute wall-clock deadline for settling the active runtime before its outer watchdog. */
  deadlineAtMs?: number;
}

export interface RunTaskOnceResult {
  taskRunId: string;
  attemptId: string;
  resultRecord: ResultRecord;
  projection: TaskRunProjection;
  invocations: readonly InvocationResult[];
  settledByDeadline: boolean;
}

export class TaskAgentController {
  constructor(private readonly deps: RunTaskOnceDeps) {}

  runOnce(config: Config, task: Task): Promise<RunTaskOnceResult> {
    return runTaskOnce(config, task, this.deps);
  }
}

export async function runTaskOnce(
  config: Config,
  task: Task,
  deps: RunTaskOnceDeps,
): Promise<RunTaskOnceResult> {
  const storage = await openHeadlessStorageForWrite(deps.storageRoot);
  return runTaskOnceWithStorage(config, task, deps, storage);
}

export async function runTaskOnceWithStorage(
  config: Config,
  task: Task,
  deps: RunTaskOnceDeps,
  storage: HeadlessStorageWriter,
): Promise<RunTaskOnceResult> {
  storage = authenticateHeadlessStorageWriter(storage);
  const isolationRequired = backendNeedsIsolation(config.backend);
  if (isolationRequired) {
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
  const taskRunId = deps.taskRunId ?? newId();
  const attemptId = deps.attemptId ?? `${taskRunId}-attempt-1`;
  const createTaskRun = deps.createTaskRun ?? true;
  const closeTaskRun = deps.closeTaskRun ?? true;
  const taskRunStore = storage.taskRunStore;
  const sessionStore = storage.executionStores.sessionStore;
  const agentRunStore = storage.executionStores.agentRunStore;
  const runtimeEventStore = storage.executionStores.runtimeEventStore;
  const startedAt = now();
  const verifier = normalizeVerifier(task);
  const heavyTaskMode = resolveHeavyTaskMode(config, task);
  const economyTaskMode = resolveEconomyTaskMode(config, task);
  const prompt = resolveHeadlessSystemPrompt(config, { heavyTaskMode, economyTaskMode });
  const effectiveConfig = { ...config, systemPrompt: prompt.systemPrompt };
  const priorProjection = heavyTaskMode.enabled ? await taskRunStore.project(taskRunId) : undefined;
  const priorProgressPrompt = priorProjection
    ? renderHeavyTaskProgressForPrompt(priorProjection)
    : undefined;
  const priorSelfCheckPrompt = priorProjection
    ? renderHeavyTaskSelfCheckForPrompt(priorProjection)
    : undefined;
  const priorEvidencePrompt = priorProjection
    ? renderHeavyTaskEvidenceForPrompt(priorProjection)
    : undefined;
  const instruction = withOptionalStatePrompts(deps.instructionOverride ?? task.instruction, [
    priorProgressPrompt,
    priorSelfCheckPrompt,
    priorEvidencePrompt,
  ]);
  const heavyTaskProgress = heavyTaskMode.enabled
    ? createHeavyTaskProgressRecorder({ taskRunId, attemptId, store: taskRunStore, now, newId })
    : undefined;
  const heavyTaskSelfCheck = heavyTaskMode.enabled
    ? createHeavyTaskSelfCheckRecorder({ taskRunId, attemptId, store: taskRunStore, now, newId })
    : undefined;
  const heavyTaskEvidence = heavyTaskMode.enabled
    ? createHeavyTaskEvidenceRecorder({ taskRunId, attemptId, store: taskRunStore, now, newId })
    : undefined;

  if (createTaskRun) {
    await appendTaskEvent(taskRunStore, taskRunId, {
      type: 'task_run_created',
      id: newId(),
      taskRunId,
      ts: startedAt,
      taskId: task.id,
      configId: config.id,
      taskDefinition: taskDefinitionFromTask(task),
    });
    await appendTaskEvent(taskRunStore, taskRunId, {
      type: 'task_run_queued',
      id: newId(),
      taskRunId,
      ts: now(),
      taskId: task.id,
      configId: config.id,
      taskDefinition: taskDefinitionFromTask(task),
    });
  }
  await appendTaskEvent(taskRunStore, taskRunId, {
    type: 'heavy_task_mode_recorded',
    id: newId(),
    taskRunId,
    ts: now(),
    facts: heavyTaskMode,
  });
  await appendTaskEvent(taskRunStore, taskRunId, {
    type: 'economy_task_mode_recorded',
    id: newId(),
    taskRunId,
    ts: now(),
    facts: economyTaskMode,
  });
  await appendTaskEvent(taskRunStore, taskRunId, {
    type: 'isolation_policy_recorded',
    id: newId(),
    taskRunId,
    ts: now(),
    facts: taskIsolationFacts({
      backendKind: config.backend,
      required: isolationRequired,
      isolation: deps.realBackendIsolation,
      validatedAt: now(),
    }),
  });
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
        ...(heavyTaskEvidence ? { heavyTaskEvidence } : {}),
        snapshotImage: createReadImageSnapshotter(storage.artifactStore),
      },
    );
    await appendTaskEvent(taskRunStore, taskRunId, {
      type: 'workspace_lease_recorded',
      id: newId(),
      taskRunId,
      ts: now(),
      lease: {
        schemaVersion: 1,
        leaseId: newId(),
        taskRunId,
        attemptId,
        sourceWorkspaceDir: task.workspaceDir,
        workspaceDir: workspace.dir,
        leaseKind: 'throwaway_copy',
        writable: true,
        cleanupPolicy: 'cleanup_on_finally',
        createdAt: now(),
      },
    });
    await appendTaskEvent(taskRunStore, taskRunId, {
      type: 'tool_executor_identity_recorded',
      id: newId(),
      taskRunId,
      ts: now(),
      identity: toolExecutorIdentity({
        executorId: newId(),
        taskRunId,
        attemptId,
        isolation: deps.realBackendIsolation,
        ...(productToolSurface
          ? {
              productToolSurface: productToolSurface.identity,
              ...(heavyTaskMode.enabled
                ? {
                    supplementalToolSets: [
                      {
                        label: 'heavy_task_progress',
                        toolNames: [...HEAVY_TASK_PROGRESS_TOOL_NAMES],
                      },
                      {
                        label: 'heavy_task_self_check',
                        toolNames: [...HEAVY_TASK_SELF_CHECK_TOOL_NAMES],
                      },
                    ],
                  }
                : {}),
            }
          : { toolNames: ['registered_backend'] }),
      }),
    });
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
      heavyTaskMode,
      ...(heavyTaskProgress ? { heavyTaskProgress } : {}),
      ...(heavyTaskSelfCheck ? { heavyTaskSelfCheck } : {}),
      ...(heavyTaskEvidence ? { heavyTaskEvidence } : {}),
      ...(backendNeedsIsolation(config.backend)
        ? {
            realBackendIsolation: deps.realBackendIsolation,
            toolExecutor: deps.realBackendIsolation?.toolExecutor,
          }
        : {}),
    });

    let parentActive: ReturnType<typeof createSingleRunActiveSession> | undefined;
    const sessionCapabilityManager = new SessionManager({
      store: sessionStore,
      runStore: agentRunStore,
      runtimeEventStore,
      backends,
      ...(productToolSurface?.boundSurfaceIds.includes(AGENT_TOOL_GROUP_ID)
        ? {
            childTools: buildChildAgentTools(productToolSurface.tools),
          }
        : {}),
      isParentRunActive: (sessionId, runId, turnId) =>
        parentActive?.hasActiveRun(sessionId, runId, turnId) ?? false,
      newId,
      now,
      runtimeSource: 'test',
    });
    const header = await sessionStore.create(
      {
        cwd: agentWorkspaceDir,
        backend: config.backend,
        llmConnectionSlug: effectiveConfig.llmConnectionSlug,
        model: effectiveConfig.model,
        ...(effectiveConfig.thinkingLevel !== undefined
          ? { thinkingLevel: effectiveConfig.thinkingLevel }
          : {}),
        permissionMode: 'ask',
        ...(deps.orchestrationMode ? { orchestrationMode: deps.orchestrationMode } : {}),
        name: `task:${config.id}:${task.id}`,
      },
      { kind: 'external', revision: 0 },
    );
    graphControlStore = createAgentGraphControlStore(deps.storageRoot);
    graphCoordinator = new AgentGraphCoordinator({
      sessionStore,
      runStore: agentRunStore,
      runtimeEventStore,
      controlStore: graphControlStore,
      runtime: sessionCapabilityManager,
      newId,
      rootSessionId: header.id,
    });
    sessionCapabilities.bind(sessionCapabilityManager, graphCoordinator);
    const turnId = newId();
    const active = createSingleRunActiveSession(
      backends,
      sessionStore,
      runtimeEventStore,
      now,
      newId,
    );
    parentActive = active;
    const run = new AgentRun({
      sessionId: header.id,
      header,
      userInput: {
        turnId,
        text: instruction,
        ...(deps.turnOrchestration ? { turnOrchestration: deps.turnOrchestration } : {}),
      },
      store: sessionStore,
      runStore: agentRunStore,
      runtimeEventStore,
      newId,
      now,
      hooks: active.hooks,
    });
    active.bindRun(run);

    await appendTaskEvent(taskRunStore, taskRunId, {
      type: 'task_run_started',
      id: newId(),
      taskRunId,
      ts: now(),
      startedAt,
      sessionId: header.id,
      agentRunId: run.runId,
    });
    await appendTaskEvent(taskRunStore, taskRunId, {
      type: 'task_attempt_started',
      id: newId(),
      taskRunId,
      ts: now(),
      attemptId,
      startedAt,
      sessionId: header.id,
      agentRunId: run.runId,
    });

    let runtimeInvocation: InvocationResult;
    let settledByDeadline = false;
    let deadlineTriggered = false;
    const runtimeAttempt = await runWithTaskSessionCleanup(
      async () => {
        const attempt = await runRuntimeAttempt({
          run,
          header,
          instruction,
          ...(deps.priorRuntimeContext ? { priorRuntimeContext: deps.priorRuntimeContext } : {}),
          requireTerminalRuntimeEventWrite: Boolean(runtimeEventStore),
          now,
          newId,
          settleByDeadline: active.settleByDeadline,
          onDeadlineTriggered: () => {
            deadlineTriggered = true;
          },
          ...(deps.deadlineAtMs !== undefined ? { deadlineAtMs: deps.deadlineAtMs } : {}),
        });
        settledByDeadline = attempt.settledByDeadline;
        return attempt;
      },
      () =>
        disposeTaskRunSession(
          active,
          sessionCapabilities,
          header.id,
          deadlineTriggered ? 'benchmark_deadline' : undefined,
        ),
    );
    runtimeInvocation = runtimeAttempt.invocation;
    await appendTaskAttemptExecutionLink({
      store: taskRunStore,
      runtimeEventStore,
      taskRunId,
      attemptId,
      invocation: runtimeInvocation,
      now,
      newId,
    });
    let invocation = runtimeInvocation;
    const invocations = [invocation];

    let runtimeSummary = summarizeRuntime([invocation], deps.realBackendIsolation);
    await appendRuntimeFeedback(taskRunStore, taskRunId, attemptId, now, newId, runtimeSummary);
    if (heavyTaskMode.enabled && !settledByDeadline) {
      let gateProjection = await taskRunStore.project(taskRunId);
      const workspaceObservation = await appendHeavyTaskWorkspaceObservation({
        taskRunStore,
        taskRunId,
        projection: gateProjection,
        executor: deps.realBackendIsolation?.toolExecutor,
        cwd: agentWorkspaceDir,
        now,
        newId,
      });
      await appendHeavyTaskSelfCheckEvidenceLinks({
        store: taskRunStore,
        runtimeEventStore,
        taskRunId,
        attemptId,
        invocation,
        workspaceObservation,
        now,
        newId,
      });
      gateProjection = await taskRunStore.project(taskRunId);
      const gateDecision = evaluateHeavyTaskSelfCheckGate({
        task,
        heavyTaskMode,
        projection: gateProjection,
        repairAttemptsUsed: 0,
        maxRepairAttempts: 1,
      });
      await appendTaskEvent(taskRunStore, taskRunId, {
        type: 'heavy_task_self_check_gate_recorded',
        id: newId(),
        taskRunId,
        ts: now(),
        gate: heavyTaskSelfCheckGateStateFromDecision({
          decision: gateDecision,
          attempt: gateDecision.action === 'repair_prompt' ? gateDecision.attempt : 0,
          maxAttempts: 1,
        }),
      });

      if (gateDecision.action === 'repair_prompt') {
        const repairActive = createSingleRunActiveSession(
          backends,
          sessionStore,
          runtimeEventStore,
          now,
          newId,
        );
        parentActive = repairActive;
        const repairRun = new AgentRun({
          sessionId: header.id,
          header,
          userInput: { turnId: newId(), text: gateDecision.prompt },
          store: sessionStore,
          runStore: agentRunStore,
          runtimeEventStore,
          newId,
          now,
          hooks: repairActive.hooks,
        });
        repairActive.bindRun(repairRun);
        let repairInvocation: InvocationResult;
        let repairDeadlineTriggered = false;
        const repairRuntimeAttempt = await runWithTaskSessionCleanup(
          async () => {
            const attempt = await runRuntimeAttempt({
              run: repairRun,
              header,
              instruction: gateDecision.prompt,
              ...(deps.priorRuntimeContext
                ? { priorRuntimeContext: deps.priorRuntimeContext }
                : {}),
              requireTerminalRuntimeEventWrite: Boolean(runtimeEventStore),
              now,
              newId,
              settleByDeadline: repairActive.settleByDeadline,
              onDeadlineTriggered: () => {
                repairDeadlineTriggered = true;
              },
              ...(deps.deadlineAtMs !== undefined ? { deadlineAtMs: deps.deadlineAtMs } : {}),
            });
            settledByDeadline ||= attempt.settledByDeadline;
            return attempt;
          },
          () =>
            disposeTaskRunSession(
              repairActive,
              sessionCapabilities,
              header.id,
              repairDeadlineTriggered ? 'benchmark_deadline' : undefined,
            ),
        );
        repairInvocation = repairRuntimeAttempt.invocation;
        await appendTaskAttemptExecutionLink({
          store: taskRunStore,
          runtimeEventStore,
          taskRunId,
          attemptId,
          invocation: repairInvocation,
          now,
          newId,
        });
        invocation = repairInvocation;
        invocations.push(invocation);
        const repairSummary = summarizeRuntime([invocation], deps.realBackendIsolation);
        await appendRuntimeFeedback(taskRunStore, taskRunId, attemptId, now, newId, repairSummary);
        runtimeSummary = summarizeRuntime(invocations, deps.realBackendIsolation);

        if (!settledByDeadline) {
          let boundedProjection = await taskRunStore.project(taskRunId);
          const repairWorkspaceObservation = await appendHeavyTaskWorkspaceObservation({
            taskRunStore,
            taskRunId,
            projection: boundedProjection,
            executor: deps.realBackendIsolation?.toolExecutor,
            cwd: agentWorkspaceDir,
            now,
            newId,
          });
          await appendHeavyTaskSelfCheckEvidenceLinks({
            store: taskRunStore,
            runtimeEventStore,
            taskRunId,
            attemptId,
            invocation,
            workspaceObservation: repairWorkspaceObservation,
            now,
            newId,
          });
          boundedProjection = await taskRunStore.project(taskRunId);
          const boundedDecision = evaluateHeavyTaskSelfCheckGate({
            task,
            heavyTaskMode,
            projection: boundedProjection,
            repairAttemptsUsed: 1,
            maxRepairAttempts: 1,
          });
          await appendTaskEvent(taskRunStore, taskRunId, {
            type: 'heavy_task_self_check_gate_recorded',
            id: newId(),
            taskRunId,
            ts: now(),
            gate: heavyTaskSelfCheckGateStateFromDecision({
              decision: boundedDecision,
              attempt: 1,
              maxAttempts: 1,
            }),
          });
        }
      }
    }

    // Agent phase ends here: nothing still managed may be running while the
    // verifier observes the workspace. The enclosing finally repeats this for
    // the throwing path.
    await endManagedShellSessions(deps.realBackendIsolation);

    await appendTaskEvent(taskRunStore, taskRunId, {
      type: 'task_run_verifying',
      id: newId(),
      taskRunId,
      ts: now(),
      startedAt: now(),
    });
    const runnerCompleted = invocation.status === 'completed';
    const submittedSnapshotRoot = deps.realBackendIsolation?.submittedSnapshotRoot;
    const frozen = await freezeSubmittedWorkspace({
      workspaceDir: submittedSnapshotRoot ? agentWorkspaceDir : workspace.dir,
      ...(submittedSnapshotRoot ? { snapshotRoot: submittedSnapshotRoot } : {}),
      artifactRefs: runtimeSummary.artifactRefs,
      now,
      newId,
    });
    const scoringWorkspace = await prepareScoringWorkspace(frozen.submittedSnapshot);
    let verifierResult: VerifierResult;
    try {
      await restoreProtectedPaths(
        task.workspaceDir,
        scoringWorkspace.dir,
        verifierProtectedPaths(verifier),
      );
      const verifierStartedAt = now();
      verifierResult = await runVerifier({
        verifier,
        taskRunId,
        attemptId,
        ts: verifierStartedAt,
        id: newId(),
        workspaceDir: scoringWorkspace.dir,
        submittedSnapshotId: frozen.submittedSnapshot.id,
        scoringWorkspaceId: scoringWorkspace.dir,
        benchmarkAdapters: deps.benchmarkAdapters,
      });
    } finally {
      await scoringWorkspace.cleanup();
    }
    const finalScore = defaultFinalScorer({
      config,
      task,
      runnerCompleted,
      runnerStatus: invocation.status,
      invocationFailure: invocation.failure,
      submittedSnapshot: frozen.submittedSnapshot,
      verifierResult,
    });
    const finishedAt = now();
    const scoreResultId = newId();
    // The TaskRun ledger is canonical here; AgentRun metadata is optional unless authority fails.
    const runEvidence = await agentRunStore.readRun(header.id, invocation.runId).catch((error) => {
      if (isStorageRootAuthorityError(error)) throw error;
      return undefined;
    });
    const invocationResultRecord = resultRecordFromInvocation({
      config,
      task,
      sessionId: header.id,
      invocation,
      verifierResult,
      finalScore,
      submittedSnapshotId: frozen.submittedSnapshot.id,
      scoreResultId,
      startedAt,
      finishedAt,
      systemPrompt: prompt,
      runtimeSteps: countRuntimeSteps(invocations.flatMap((candidate) => candidate.events)),
      runEvidence,
    });
    const resultRecord: ResultRecord = settledByDeadline
      ? {
          ...invocationResultRecord,
          status: 'failed',
          runnerCompleted: false,
          error: 'benchmark deadline reached during attempt',
          errorClass: 'budget_exhausted',
        }
      : invocationResultRecord;
    const taxonomy: AutonomousResultTaxonomy = settledByDeadline
      ? 'budget_exhausted'
      : finalScore.taxonomy;
    const scoreResult: ScoreResult = {
      id: scoreResultId,
      taskRunId,
      attemptId,
      ts: finishedAt,
      passed: finalScore.passed,
      scored: finalScore.scored,
      eligible: finalScore.eligible,
      ...(finalScore.score !== undefined ? { score: finalScore.score } : {}),
      ...(finalScore.maxScore !== undefined ? { maxScore: finalScore.maxScore } : {}),
      ...(settledByDeadline
        ? { errorClass: 'budget_exhausted' }
        : finalScore.errorClass
          ? { errorClass: finalScore.errorClass }
          : {}),
      ...(finalScore.excludedReason ? { excludedReason: finalScore.excludedReason } : {}),
      taxonomy,
      ...(verifierResult.authority ? { authority: verifierResult.authority } : {}),
      details: {
        steps: resultRecord.steps,
        invocationStatus: invocation.status,
        ...(invocation.failure?.class ? { runtimeFailureClass: invocation.failure.class } : {}),
        verifierExitCode: verifierResult.exitCode ?? null,
        runtimeRefs: runtimeSummary.runtimeRefs,
        artifactRefs: runtimeSummary.artifactRefs,
        submittedSnapshot: frozen.submittedSnapshot,
        scoringWorkspaceContract:
          'v1_copy_snapshot_then_restore_protected_paths_in_disposable_scoring_workspace',
        isolation: runtimeSummary.isolation,
        budget: runtimeSummary.budget,
        tools: runtimeSummary.tools,
        ...(finalScore.details ? { finalScore: finalScore.details } : {}),
      },
    };
    const runResult: TaskRunResult = {
      passed: scoreResult.passed,
      taxonomy,
      verifierResultId: verifierResult.id,
      scoreResultId: scoreResult.id,
    };

    await appendTaskEvent(taskRunStore, taskRunId, {
      type: 'verifier_result_recorded',
      id: newId(),
      taskRunId,
      ts: finishedAt,
      result: verifierResult,
    });
    for (const artifact of verifierResult.artifacts ?? []) {
      await appendTaskEvent(taskRunStore, taskRunId, {
        type: 'task_run_artifact_recorded',
        id: newId(),
        taskRunId,
        ts: artifact.ts,
        artifact,
      });
    }
    await appendTaskEvent(taskRunStore, taskRunId, {
      type: 'score_result_recorded',
      id: newId(),
      taskRunId,
      ts: finishedAt,
      result: scoreResult,
    });
    await appendTaskEvent(taskRunStore, taskRunId, {
      type: 'task_attempt_completed',
      id: newId(),
      taskRunId,
      ts: finishedAt,
      attemptId,
      finishedAt,
      status: attemptStatusFromResult(resultRecord.status, taxonomy),
      ...(resultRecord.status === 'failed'
        ? { error: errorFromResultRecord(resultRecord, taxonomy) }
        : {}),
    });
    if (closeTaskRun) {
      await appendTaskEvent(
        taskRunStore,
        taskRunId,
        terminalEventFromResult(resultRecord, taxonomy, runResult, taskRunId, newId),
      );
    }

    return {
      taskRunId,
      attemptId,
      resultRecord,
      projection: await taskRunStore.project(taskRunId),
      invocations,
      settledByDeadline,
    };
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

async function appendHeavyTaskWorkspaceObservation(input: {
  taskRunStore: TaskRunWriter;
  taskRunId: string;
  projection: TaskRunProjection;
  executor?: NonNullable<RunTaskOnceDeps['realBackendIsolation']>['toolExecutor'];
  cwd: string;
  now: () => number;
  newId: () => string;
}): Promise<Extract<TaskEvent, { type: 'heavy_task_workspace_observation_recorded' }> | undefined> {
  const event = await observeHeavyTaskWorkspace({
    taskRunId: input.taskRunId,
    projection: input.projection,
    executor: input.executor,
    cwd: input.cwd,
    now: input.now,
    newId: input.newId,
  });
  if (event) await appendTaskEvent(input.taskRunStore, input.taskRunId, event);
  return event;
}

async function appendHeavyTaskSelfCheckEvidenceLinks(input: {
  store: TaskRunWriter;
  runtimeEventStore: RuntimeEventStore;
  taskRunId: string;
  attemptId: string;
  invocation: InvocationResult;
  workspaceObservation?: Extract<TaskEvent, { type: 'heavy_task_workspace_observation_recorded' }>;
  now: () => number;
  newId: () => string;
}): Promise<void> {
  if (!input.workspaceObservation || !input.runtimeEventStore.readImmutableRuntimeEvents) return;
  const [runtimeEvents, records] = await Promise.all([
    input.runtimeEventStore.readImmutableRuntimeEvents(
      input.invocation.sessionId,
      input.invocation.runId,
    ),
    input.store.readEventRecords(input.taskRunId),
  ]);
  const linkedSelfChecks = new Set(
    records.flatMap(({ event }) =>
      event.type === 'heavy_task_self_check_evidence_linked' ? [event.selfCheckId] : [],
    ),
  );
  const candidates = records.filter(
    (
      record,
    ): record is typeof record & {
      event: Extract<TaskEvent, { type: 'heavy_task_self_check_recorded' }>;
    } =>
      record.event.type === 'heavy_task_self_check_recorded' &&
      record.event.selfCheck.attemptId === input.attemptId &&
      !linkedSelfChecks.has(record.event.selfCheck.selfCheckId) &&
      (!record.event.selfCheck.source.sessionId ||
        record.event.selfCheck.source.sessionId === input.invocation.sessionId) &&
      (!record.event.selfCheck.source.agentRunId ||
        record.event.selfCheck.source.agentRunId === input.invocation.runId) &&
      (!record.event.selfCheck.source.turnId ||
        record.event.selfCheck.source.turnId === input.invocation.turnId),
  );
  for (const selfCheckRecord of candidates) {
    const binding = bindSelfCheckEvidence({
      taskRunId: input.taskRunId,
      attemptId: input.attemptId,
      sessionId: input.invocation.sessionId,
      invocationId: input.invocation.invocationId,
      agentRunId: input.invocation.runId,
      turnId: input.invocation.turnId,
      runtimeEvents,
      selfCheckRecord,
      workspaceObservation: input.workspaceObservation,
    });
    if (!binding.ok) continue;
    await appendTaskEvent(input.store, input.taskRunId, {
      ...binding.link,
      id: input.newId(),
      ts: input.now(),
    });
  }
}

function withOptionalStatePrompts(
  instruction: string,
  prompts: readonly (string | undefined)[],
): string {
  let next = instruction;
  for (const prompt of prompts) {
    if (!prompt) continue;
    const firstLine = prompt.split('\n', 1)[0];
    if (firstLine && next.includes(firstLine)) continue;
    next = `${next}\n\n${prompt}`;
  }
  return next;
}

async function appendTaskAttemptExecutionLink(input: {
  store: TaskRunWriter;
  runtimeEventStore: RuntimeEventStore;
  taskRunId: string;
  attemptId: string;
  invocation: InvocationResult;
  now: () => number;
  newId: () => string;
}): Promise<void> {
  const runtimeEvents = input.runtimeEventStore.readImmutableRuntimeEvents
    ? await input.runtimeEventStore.readImmutableRuntimeEvents(
        input.invocation.sessionId,
        input.invocation.runId,
      )
    : [];
  await appendTaskEvent(input.store, input.taskRunId, {
    type: 'task_attempt_execution_linked',
    id: input.newId(),
    taskRunId: input.taskRunId,
    attemptId: input.attemptId,
    ts: input.now(),
    evidence: taskAttemptExecutionEvidence({
      taskRunId: input.taskRunId,
      attemptId: input.attemptId,
      sessionId: input.invocation.sessionId,
      invocationId: input.invocation.invocationId,
      agentRunId: input.invocation.runId,
      turnId: input.invocation.turnId,
      runtimeEvents,
    }),
  });
  if (runtimeEvents.length === 0) return;

  const projection = await input.store.project(input.taskRunId);
  const projectedEvidence = new Map(
    projection.heavyTaskEvidence.map((item) => [item.evidenceId, item]),
  );
  const durableEvidence = projection.events.flatMap((event) =>
    event.type === 'heavy_task_evidence_recorded'
      ? [projectedEvidence.get(event.evidence.evidenceId) ?? event.evidence]
      : [],
  );
  const provenanceLinks = taskEvidenceRuntimeProvenanceLinks({
    taskRunId: input.taskRunId,
    attemptId: input.attemptId,
    sessionId: input.invocation.sessionId,
    invocationId: input.invocation.invocationId,
    agentRunId: input.invocation.runId,
    turnId: input.invocation.turnId,
    runtimeEvents,
    evidence: durableEvidence,
  });
  for (const link of provenanceLinks) {
    await appendTaskEvent(input.store, input.taskRunId, {
      type: 'heavy_task_evidence_provenance_linked',
      id: input.newId(),
      taskRunId: input.taskRunId,
      attemptId: link.attemptId,
      ts: input.now(),
      evidenceId: link.evidenceId,
      provenance: link.provenance,
    });
  }
}

interface RunRuntimeAttemptInput {
  run: AgentRun;
  header: SessionHeader;
  instruction: string;
  priorRuntimeContext?: readonly RuntimeEvent[];
  requireTerminalRuntimeEventWrite: boolean;
  now: () => number;
  newId: () => string;
  deadlineAtMs?: number;
  settleByDeadline(): Promise<boolean>;
  onDeadlineTriggered(): void;
}

async function runRuntimeAttempt(input: RunRuntimeAttemptInput): Promise<{
  invocation: InvocationResult;
  settledByDeadline: boolean;
}> {
  let begin;
  try {
    begin = await input.run.begin();
  } catch (error) {
    await input.run.recordFailure(error);
    await input.run.finalize();
    throw error;
  }

  const flow = new AiSdkFlow({
    backend: begin.backend,
    drainAfterTerminal: true,
    onSessionEvent: async (sessionEvent, runtimeEvent) => {
      await input.run.acceptMappedEvent(sessionEvent, runtimeEvent, {
        requireTerminalWrite: input.requireTerminalRuntimeEventWrite,
      });
    },
    onError: async (error) => {
      await input.run.recordFailure(error);
    },
    onFinally: async () => {
      await input.run.finalize();
    },
  });
  const runner = new RuntimeRunner({
    flow,
    providers: { newId: input.newId, now: input.now },
    stopOnTerminal: false,
  });
  const runtimeContext = [
    ...(input.priorRuntimeContext ?? []),
    ...(begin.backendInput.runtimeContext ?? []),
  ];

  let settledByDeadline = false;
  let settlementError: unknown;
  let settlementAttempt: Promise<void> | undefined;
  const settle = () => {
    input.onDeadlineTriggered();
    settlementAttempt = input
      .settleByDeadline()
      .then((settled) => {
        settledByDeadline = settled;
      })
      .catch((error) => {
        settlementError = error;
      });
  };
  const remainingMs =
    input.deadlineAtMs === undefined ? undefined : Math.max(0, input.deadlineAtMs - input.now());
  if (remainingMs !== undefined && remainingMs > MAX_NODE_TIMER_MS) {
    throw new Error(`deadlineAtMs exceeds the Node timer limit of ${MAX_NODE_TIMER_MS}ms`);
  }
  const dispatchAbortController = remainingMs === 0 ? new AbortController() : undefined;
  let settlementTimer: ReturnType<typeof setTimeout> | undefined;
  if (dispatchAbortController) {
    dispatchAbortController.abort();
    settle();
  } else if (remainingMs !== undefined) settlementTimer = setTimeout(settle, remainingMs);
  let invocation: InvocationResult;
  try {
    invocation = await runner.run({
      sessionId: input.header.id,
      invocationId: begin.initialRuntimeEvent.invocationId,
      runId: input.run.runId,
      turnId: input.run.turnId,
      text: input.instruction,
      context: begin.backendInput.context,
      ...(runtimeContext.length > 0 ? { runtimeContext } : {}),
      ...(begin.backendInput.attachments ? { attachments: begin.backendInput.attachments } : {}),
      initialRuntimeEvent: begin.initialRuntimeEvent,
      source: 'test',
      lineage: input.run.lineage,
      ...(dispatchAbortController ? { abortSignal: dispatchAbortController.signal } : {}),
    });
  } finally {
    if (settlementTimer) clearTimeout(settlementTimer);
  }
  await settlementAttempt;
  if (settlementError) throw settlementError;
  if (dispatchAbortController && invocation.events.length === 0) {
    invocation = { ...invocation, events: [begin.initialRuntimeEvent] };
  }
  await input.run.finalize();
  return { invocation, settledByDeadline };
}

type AgentRunHooks = ConstructorParameters<typeof AgentRun>[0]['hooks'];

function createSingleRunActiveSession(
  backends: BackendRegistry,
  store: SessionStore,
  runtimeEventStore: RuntimeEventStore | undefined,
  now: () => number,
  newId: () => string,
): {
  hooks: AgentRunHooks;
  bindRun(run: AgentRun): void;
  hasActiveRun(sessionId: string, runId: string, turnId: string): boolean;
  settleByDeadline(): Promise<boolean>;
  dispose(): Promise<void>;
} {
  let boundRun: AgentRun | undefined;
  let active: AgentRunActiveSession | undefined;
  const bindRun = (run: AgentRun) => {
    boundRun = run;
  };
  return {
    bindRun,
    hasActiveRun: (sessionId, runId, turnId) =>
      active?.sessionId === sessionId &&
      active.activeRuns.get(runId)?.turnId === turnId &&
      active.turnToRunId.get(turnId) === runId,
    settleByDeadline: async () => {
      if (!active) return false;
      const stoppedRuns = [...active.activeRuns.values()].filter((run) =>
        run.stop('benchmark_deadline'),
      );
      if (stoppedRuns.length === 0) return false;
      try {
        await active.backend.stop('user_stop', 'immediate');
      } finally {
        for (const run of stoppedRuns) run.completeStop();
      }
      return true;
    },
    hooks: {
      reserveRun: async (sessionId, header, run) => {
        let targetActive = active;
        if (targetActive) {
          targetActive.cachedHeader = header;
        } else {
          const backend = await backends.build(header.backend, {
            sessionId,
            workspaceRoot: header.workspaceRoot,
            header,
            store,
            recordRunTrace: (event) => boundRun?.recordRunTrace(event),
            recordProviderRequestCapture: (capture) => {
              if (!boundRun) {
                return Promise.reject(new Error('No active AgentRun for provider request capture'));
              }
              return boundRun.recordProviderRequestCapture(capture);
            },
            recordProviderRequestAttempt: (attempt) =>
              boundRun?.recordProviderRequestAttempt(attempt),
            recordModelCallAttempt: (attempt) =>
              boundRun?.recordModelCallAttempt(attempt) ?? Promise.resolve(),
            ...(runtimeEventStore
              ? {
                  loadTurnRuntimeEvents: (turnId: string) => {
                    if (!boundRun || boundRun.turnId !== turnId) {
                      return Promise.reject(
                        new Error('No active AgentRun for turn runtime events'),
                      );
                    }
                    return boundRun.loadTurnRuntimeEvents();
                  },
                }
              : {}),
            allowMidTurnHistoryCompaction: Boolean(runtimeEventStore),
            recordActiveFullCompactBlock: (block) => boundRun?.recordActiveFullCompactBlock(block),
            recordSemanticCompactBlock: (block) => boundRun?.recordSemanticCompactBlock(block),
          });
          targetActive = {
            sessionId,
            backend,
            cachedHeader: header,
            activeRuns: new Map(),
            turnToRunId: new Map(),
          };
          active = targetActive;
        }
        targetActive.activeRuns.set(run.runId, run);
        targetActive.turnToRunId.set(run.turnId, run.runId);
        return targetActive;
      },
      unregisterRun: (targetActive, run) => {
        targetActive.activeRuns.delete(run.runId);
        if (targetActive.turnToRunId.get(run.turnId) === run.runId) {
          targetActive.turnToRunId.delete(run.turnId);
        }
      },
      updateHeader: async (sessionId, patch) => store.updateHeader(sessionId, patch),
      updateStatus: async (sessionId, status, blockedReason, ts = now()) => {
        await store.updateHeader(sessionId, statusPatch(status, ts, blockedReason));
      },
      appendTurnState: async (sessionId, turnId, status, lineage, options = {}) => {
        const ts = options.ts ?? now();
        const runLineage = lineage ?? {};
        await store.appendMessage(sessionId, {
          type: 'turn_state',
          id: newId(),
          turnId,
          ts,
          status,
          ...(runLineage.parentTurnId ? { parentTurnId: runLineage.parentTurnId } : {}),
          ...(runLineage.retriedFromTurnId
            ? { retriedFromTurnId: runLineage.retriedFromTurnId }
            : {}),
          ...(runLineage.regeneratedFromTurnId
            ? { regeneratedFromTurnId: runLineage.regeneratedFromTurnId }
            : {}),
          ...(runLineage.branchOfTurnId ? { branchOfTurnId: runLineage.branchOfTurnId } : {}),
          ...(runLineage.parentSessionId ? { parentSessionId: runLineage.parentSessionId } : {}),
          ...(status === 'aborted' ? { abortedAt: ts } : {}),
          ...(status === 'aborted' && options.abortSource
            ? { abortSource: options.abortSource }
            : {}),
          ...(status === 'failed' ? { errorClass: options.errorClass ?? 'unknown' } : {}),
          partialOutputRetained: await turnHasRetainedOutput(store, sessionId, turnId),
        });
      },
    },
    dispose: async () => {
      const backend = active?.backend;
      active = undefined;
      if (backend) await backend.dispose().catch(() => {});
    },
  };
}

async function runWithTaskSessionCleanup<T>(
  run: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  let result: T;
  try {
    result = await run();
  } catch (primaryError) {
    try {
      await cleanup();
    } catch (cleanupError) {
      attachTaskCleanupCause(primaryError, cleanupError);
    }
    throw primaryError;
  }
  await cleanup();
  return result;
}

function attachTaskCleanupCause(primaryError: unknown, cleanupError: unknown): void {
  if (!(primaryError instanceof Error)) return;
  const existingCause = primaryError.cause;
  const cause =
    existingCause === undefined
      ? cleanupError
      : new AggregateError(
          [existingCause, cleanupError],
          'task session cleanup failed after the primary error',
        );
  try {
    Object.defineProperty(primaryError, 'cause', {
      value: cause,
      configurable: true,
      enumerable: false,
      writable: true,
    });
  } catch {
    // A frozen caller-owned error must remain the primary thrown value.
  }
}

async function disposeTaskRunSession(
  active: { dispose(): Promise<void> },
  sessionCapabilities: {
    settle(
      sessionId: string,
      input?: { source: 'benchmark_deadline' | 'stop_button' },
    ): Promise<void>;
  },
  sessionId: string,
  source: 'benchmark_deadline' | undefined,
): Promise<void> {
  try {
    await sessionCapabilities.settle(sessionId, source ? { source } : undefined);
  } finally {
    await active.dispose();
  }
}

function statusPatch(
  status: SessionStatus,
  ts: number,
  blockedReason?: SessionBlockedReason,
): Pick<SessionHeader, 'status' | 'blockedReason' | 'statusUpdatedAt'> {
  return {
    status,
    blockedReason: status === 'blocked' ? (blockedReason ?? 'unknown') : undefined,
    statusUpdatedAt: ts,
  };
}

async function turnHasRetainedOutput(
  store: SessionStore,
  sessionId: string,
  turnId: string,
): Promise<boolean> {
  const messages = await store.readMessages(sessionId).catch((error): StoredMessage[] => {
    if (isStorageRootAuthorityError(error)) throw error;
    return [];
  });
  return messages.some(
    (message) =>
      (message.type === 'assistant' &&
        message.turnId === turnId &&
        message.text.trim().length > 0) ||
      (message.type === 'tool_result' && message.turnId === turnId),
  );
}

function resultRecordFromInvocation(input: {
  config: Config;
  task: Task;
  sessionId: string;
  invocation: InvocationResult;
  verifierResult: VerifierResult;
  finalScore: ReturnType<typeof defaultFinalScorer>;
  submittedSnapshotId: string;
  scoreResultId: string;
  startedAt: number;
  finishedAt: number;
  runtimeSteps: number;
  systemPrompt: Pick<ResolvedHeadlessSystemPrompt, 'mode' | 'systemPromptHash'>;
  runEvidence?: Pick<
    import('@maka/core').AgentRunHeader,
    'orchestrationMode' | 'orchestrationSource' | 'agentSwarmAuthorization'
  >;
}): ResultRecord {
  const status = input.invocation.status;
  return {
    taskId: input.task.id,
    configId: input.config.id,
    sessionId: input.sessionId,
    runId: input.invocation.runId,
    systemPromptMode: input.systemPrompt.mode,
    systemPromptHash: input.systemPrompt.systemPromptHash,
    ...(input.runEvidence?.orchestrationMode
      ? { orchestrationMode: input.runEvidence.orchestrationMode }
      : {}),
    ...(input.runEvidence?.orchestrationSource
      ? { orchestrationSource: input.runEvidence.orchestrationSource }
      : {}),
    ...(input.runEvidence?.agentSwarmAuthorization
      ? { agentSwarmAuthorization: input.runEvidence.agentSwarmAuthorization }
      : {}),
    status,
    runnerCompleted: status === 'completed',
    passed: input.finalScore.passed,
    scored: input.finalScore.scored,
    eligible: input.finalScore.eligible,
    ...(input.finalScore.excludedReason ? { excludedReason: input.finalScore.excludedReason } : {}),
    verifierKind: input.verifierResult.kind,
    verifierResultId: input.verifierResult.id,
    scoreResultId: input.scoreResultId,
    submittedSnapshotId: input.submittedSnapshotId,
    exitCode: input.verifierResult.exitCode ?? null,
    steps: input.runtimeSteps,
    durationMs: input.finishedAt - input.startedAt,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    ...(input.finalScore.errorClass ? { errorClass: input.finalScore.errorClass } : {}),
    ...(!input.finalScore.scored && input.finalScore.errorClass
      ? {
          error:
            input.finalScore.excludedReason ??
            input.invocation.failure?.message ??
            input.finalScore.errorClass,
        }
      : status === 'failed'
        ? {
            error:
              input.invocation.failure?.message ??
              input.invocation.failure?.class ??
              'run did not complete',
          }
        : {}),
  };
}

interface RuntimeSummary {
  runtimeRefs: {
    invocationId: string;
    sessionId: string;
    runId: string;
    turnId: string;
    runtimeEventIds: string[];
    previousTurns?: Array<{
      invocationId: string;
      runId: string;
      turnId: string;
      runtimeEventIds: string[];
    }>;
  };
  artifactRefs: Array<Record<string, unknown>>;
  isolation: Record<string, unknown>;
  budget: Record<string, unknown>;
  tools: HarborCellToolSummary;
}

function summarizeRuntime(
  invocations: readonly InvocationResult[],
  isolation: RunExperimentDeps['realBackendIsolation'],
): RuntimeSummary {
  const invocation = invocations.at(-1);
  if (!invocation) throw new Error('runtime summary requires at least one invocation');
  const events = invocations.flatMap((candidate) => candidate.events);
  const previousTurns = invocations.slice(0, -1).map((candidate) => ({
    invocationId: candidate.invocationId,
    runId: candidate.runId,
    turnId: candidate.turnId,
    runtimeEventIds: candidate.events.map((event) => event.id),
  }));
  return {
    runtimeRefs: {
      invocationId: invocation.invocationId,
      sessionId: invocation.sessionId,
      runId: invocation.runId,
      turnId: invocation.turnId,
      runtimeEventIds: events.map((event) => event.id),
      ...(previousTurns.length > 0 ? { previousTurns } : {}),
    },
    artifactRefs: collectArtifactRefs(events),
    isolation: isolation
      ? { kind: isolation.kind, label: isolation.label }
      : { kind: 'inert_fake_backend' },
    budget: summarizeBudget(invocations),
    tools: summarizeCellTools(events),
  };
}

async function appendRuntimeFeedback(
  store: TaskRunWriter,
  taskRunId: string,
  attemptId: string,
  now: () => number,
  newId: () => string,
  summary: RuntimeSummary,
): Promise<void> {
  const ts = now();
  const observation: FeedbackObservation = {
    id: newId(),
    taskRunId,
    attemptId,
    ts,
    source: 'runtime',
    summary: 'runtime invocation completed',
    details: { ...summary },
  };
  await appendTaskEvent(store, taskRunId, {
    type: 'feedback_observed',
    id: newId(),
    taskRunId,
    ts,
    observation,
  });
}

function collectArtifactRefs(events: readonly RuntimeEvent[]): Array<Record<string, unknown>> {
  const refs: Array<Record<string, unknown>> = [];
  for (const event of events) {
    if (event.refs?.artifactId) {
      refs.push({ runtimeEventId: event.id, artifactId: event.refs.artifactId });
    }
    if (event.actions?.artifactDelta) {
      refs.push({ runtimeEventId: event.id, artifactDelta: event.actions.artifactDelta });
    }
    const result = event.content?.kind === 'function_response' ? event.content.result : undefined;
    if (isRecord(result) && typeof result.artifactId === 'string') {
      refs.push({
        runtimeEventId: event.id,
        artifactId: result.artifactId,
        toolCallId: event.refs?.toolCallId,
      });
    }
  }
  return refs;
}

function summarizeBudget(invocations: readonly InvocationResult[]): Record<string, unknown> {
  const totals = {
    input: 0,
    output: 0,
    reasoning: 0,
    total: 0,
    costUsd: 0,
  };
  const contextBudget: unknown[] = [];
  const rawFinishReasons: string[] = [];
  const latestFailureClass = invocations.at(-1)?.failure?.class;
  for (const event of invocations.flatMap((invocation) => invocation.events)) {
    const usage = event.actions?.tokenUsage;
    if (!usage) continue;
    totals.input += usage.input ?? 0;
    totals.output += usage.output ?? 0;
    totals.reasoning += usage.reasoning ?? 0;
    totals.total += usage.total ?? 0;
    totals.costUsd += usage.costUsd ?? 0;
    if (usage.contextBudget) contextBudget.push(usage.contextBudget);
    if (usage.rawFinishReason) rawFinishReasons.push(usage.rawFinishReason);
  }
  return {
    totals,
    ...(contextBudget.length > 0 ? { contextBudget } : {}),
    ...(rawFinishReasons.length > 0 ? { rawFinishReasons } : {}),
    ...(latestFailureClass ? { failureClass: latestFailureClass } : {}),
  };
}

function attemptStatusFromResult(
  status: ResultRecord['status'],
  taxonomy: AutonomousResultTaxonomy,
): Exclude<TaskAttemptStatus, 'running'> {
  if (status === 'completed') return 'completed';
  switch (taxonomy) {
    case 'agent_incomplete':
      return 'incomplete';
    case 'blocked':
      return 'blocked';
    case 'policy_denied':
      return 'policy_denied';
    case 'budget_exhausted':
      return 'budget_exhausted';
    case 'aborted':
      return 'aborted';
    case 'cancelled':
      return 'cancelled';
    case 'passed':
    case 'verification_failed':
    case 'verification_error':
    case 'agent_failed':
    case 'invalid_setup':
    case 'unsupported_adapter':
    case 'isolation_required':
    case 'setup_failed':
    case 'infra_failed':
      return 'failed';
  }
}

function terminalEventFromResult(
  record: ResultRecord,
  taxonomy: AutonomousResultTaxonomy,
  result: TaskRunResult,
  taskRunId: string,
  eventId: () => string,
): TaskEvent {
  const base = { id: eventId(), taskRunId, ts: record.finishedAt, finishedAt: record.finishedAt };
  if (record.status === 'completed') {
    return { type: 'task_run_completed', ...base, result };
  }

  const error = errorFromResultRecord(record, taxonomy);
  switch (taxonomy) {
    case 'agent_incomplete':
      return { type: 'task_run_incomplete', ...base, error };
    case 'blocked':
      return { type: 'task_run_blocked', ...base, error };
    case 'policy_denied':
      return { type: 'task_run_policy_denied', ...base, error };
    case 'budget_exhausted':
      return { type: 'task_run_budget_exhausted', ...base, error };
    case 'aborted':
      return { type: 'task_run_aborted', ...base, error };
    case 'cancelled':
      return { type: 'task_run_cancelled', ...base, error };
    case 'passed':
    case 'verification_failed':
    case 'verification_error':
    case 'agent_failed':
    case 'invalid_setup':
    case 'unsupported_adapter':
    case 'isolation_required':
    case 'setup_failed':
    case 'infra_failed':
      return { type: 'task_run_failed', ...base, error };
  }
}

function errorFromResultRecord(
  record: ResultRecord,
  taxonomy: AutonomousResultTaxonomy,
): TaskRunError {
  return {
    message: record.error ?? errorMessageFromTaxonomy(taxonomy),
    ...(record.errorClass ? { class: record.errorClass } : {}),
  };
}

function errorMessageFromTaxonomy(taxonomy: AutonomousResultTaxonomy): string {
  switch (taxonomy) {
    case 'agent_failed':
      return 'agent run failed';
    case 'agent_incomplete':
      return 'agent run incomplete';
    case 'invalid_setup':
      return 'invalid setup';
    case 'unsupported_adapter':
      return 'unsupported verifier adapter';
    case 'isolation_required':
      return 'isolated executor required';
    case 'setup_failed':
      return 'task setup failed';
    case 'infra_failed':
      return 'infrastructure failed';
    case 'verification_error':
      return 'verification errored';
    case 'policy_denied':
      return 'task run denied by policy';
    case 'budget_exhausted':
      return 'task run budget exhausted';
    case 'aborted':
      return 'task run aborted';
    case 'blocked':
      return 'task run blocked';
    case 'cancelled':
      return 'task run cancelled';
    case 'verification_failed':
      return 'verification failed';
    case 'passed':
      return 'task run failed';
  }
}

function appendTaskEvent(store: TaskRunWriter, taskRunId: string, event: TaskEvent): Promise<void> {
  return store.appendEvent(taskRunId, event);
}

function isNonTerminalErrorRuntimeEvent(event: RuntimeEvent): boolean {
  return event.content?.kind === 'error' && !isTerminalRuntimeEvent(event);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
