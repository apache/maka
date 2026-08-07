import { createHash, randomUUID } from 'node:crypto';
import { isDeepResearchSession } from '@maka/core/session';
import { filterModelVisibleTaskLedgerTasks } from '@maka/core/task-ledger';
import {
  AgentGraphCoordinator,
  AgentGraphSupervisorWakeCoordinator,
  agentGraphIdForRootSession,
  BackendRegistry,
  buildHostCapabilitiesFromBinding,
  createLocalContinuationSafetyInspector,
  createBuiltinSandboxManager,
  createFilesystemWorkerLaunchSpecProvider,
  FakeBackend,
  FilesystemWorkerClient,
  isOAuthEnrollmentProviderEnabled,
  isBuiltinFilesystemWorkerSandboxAvailable,
  loadLatestHistoryCompactCheckpointFromRunLedger,
  prepareSkillInvocationMessageFromInventory,
  RuntimeReadModel,
  routeWebSearchTools,
  SessionManager,
  SessionActivityRegistry,
  ShellRunProcessManager,
  type MakaTool,
  type RuntimeHostedRootAuthority,
} from '@maka/runtime';
import { createAgentGraphControlStore } from '@maka/storage/agent-graph-control-store';
import {
  createArtifactAttachmentResourceReader,
  createReadImageSnapshotter,
  openInteractiveArtifactStoreForWrite,
} from '@maka/storage/artifact-stores';
import { openInteractiveAutomationAuthorityForWrite } from '@maka/storage/automation-authority';
import { openInteractiveDeepResearchStoreForWrite } from '@maka/storage/deep-research-authority';
import { openInteractiveDailyReviewAuthorityForWrite } from '@maka/storage/daily-review-authority';
import { openInteractivePlanStoreForWrite } from '@maka/storage/plan-authority';
import {
  isSessionNotFoundError,
  openInteractiveExecutionStoresForWrite,
} from '@maka/storage/execution-stores';
import { createGitWorktreeChildExecutor } from '@maka/storage/git-worktree-child-executor';
import {
  type InteractiveLongTermMemoryWriter,
  openInteractiveLongTermMemoryStoreForWrite,
} from '@maka/storage/long-term-memory-store';
import { openInteractiveMemoryBundleStoreForWrite } from '@maka/storage/memory-bundle-store';
import { runWithStorageRootLease } from '@maka/storage/root-authority';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { openInteractiveTaskLedgerStoreForWrite } from '@maka/storage/task-ledger-authority';
import { openInteractiveShellRunStoreForWrite } from '@maka/storage/shell-run-authority';
import { openInteractiveUsageStoresForWrite } from '@maka/storage/usage-stores';
import { resolveWorkspaceIdentity } from '@maka/storage/workspace-identity';
import {
  openManagedWorkspaceOwner,
  type ManagedWorkspaceFilesystemWorker,
  type ManagedWorkspaceOwner,
  type VerifiedGitRuntimeInput,
} from '@maka/storage/managed-workspace-owner';
import { CanonicalSessionProjectionReader } from './canonical-session-projection.js';
import {
  bindHostChildAgentBackend,
  createHostChildAgentToolComposition,
} from './child-agent-composition.js';
import { HostCanonicalPermissionOutcomeReader } from './canonical-permission-outcome-reader.js';
import { HostArtifactCoordinator } from './artifact-coordinator.js';
import { HostAgentGraphCoordinator } from './agent-graph-coordinator.js';
import { HostAutomationCoordinator } from './automation-coordinator.js';
import { recoverClientCapabilityOutcomes } from './client-capability-recovery.js';
import { HostConnectionEffectCoordinator } from './connection-effect-coordinator.js';
import { HostConfigurationCoordinator } from './configuration-coordinator.js';
import { HostClientCapabilityCoordinator } from './client-capability-coordinator.js';
import { HostDeepResearchCoordinator } from './deep-research-coordinator.js';
import { HostDailyReviewCoordinator } from './daily-review-coordinator.js';
import {
  createHostAiSdkBackend,
  createHostExecutionModelComposition,
} from './execution-model-composition.js';
import {
  createHostGoalEvaluator,
  createHostDailyReviewModel,
  createHostMemoryExtractionModel,
  createHostSessionEffectModel,
} from './execution-model-authority.js';
import { HostExecutionInspectCoordinator } from './execution-inspect-coordinator.js';
import { HostGoalCoordinator } from './goal-coordinator.js';
import type { RuntimeHostComposition, RuntimeHostCompositionContext } from './host-kernel.js';
import { HostInteractionCoordinator } from './interaction-coordinator.js';
import { HostMemoryCoordinator } from './memory-coordinator.js';
import { HostMemoryExtractionCoordinator } from './memory-extraction-coordinator.js';
import { MemoryExtractionSessionLane } from './memory-extraction-session-lane.js';
import { type HostMessageRootPort, HostMessageCoordinator } from './message-coordinator.js';
import { HostNetworkProxyCoordinator } from './network-proxy-coordinator.js';
import { HostOAuthExecutionAuthority } from './oauth-execution-authority.js';
import { HostOAuthCoordinator } from './oauth-coordinator.js';
import { HostPlanCoordinator } from './plan-coordinator.js';
import type { DomainOperationHandlerMap } from './operation-dispatcher.js';
import { RootAdmissionOwner } from './root-admission-owner.js';
import { RootTurnCoordinator } from './root-turn-coordinator.js';
import { RuntimePolicyActivationGate } from './runtime-policy-activation-gate.js';
import { notifySandboxBoundaryGraphWake } from './sandbox-boundary-graph-wake.js';
import { HostRuntimePolicyCoordinator } from './runtime-policy-coordinator.js';
import { HostRuntimeResourceCoordinator } from './runtime-resource-coordinator.js';
import { SessionAdmissionGate } from './session-admission-gate.js';
import { HostSessionCatalogCoordinator } from './session-catalog-coordinator.js';
import { HostSessionRetirementCoordinator } from './session-retirement-coordinator.js';
import { HostSessionRevisionCoordinator } from './session-revision-coordinator.js';
import { HostSessionEffectCoordinator } from './session-effect-coordinator.js';
import { SessionContinuityCoordinator } from './session-continuity-coordinator.js';
import { createSessionTranscriptReader } from './session-transcript-reader.js';
import { HostSkillCatalogCoordinator } from './skill-catalog-coordinator.js';
import { SkillCatalogRepository } from './skill-catalog-repository.js';
import { HostTaskLedgerCoordinator } from './task-ledger-coordinator.js';
import { HostUsagePricingCoordinator } from './usage-pricing-coordinator.js';
import { HostWebSearchCoordinator } from './web-search-coordinator.js';
import {
  createHostWebSearchService,
  createHostWebSearchToolFromService,
} from './web-search-tool.js';
import { createHostWebFetchService, createHostWebFetchToolFromService } from './web-fetch-tool.js';
import { createHostExecutionArtifactServices } from './execution-artifacts.js';
import {
  createRuntimeHostWorkspaceExecutionComposition,
  RuntimeHostWorkspaceExecutionError,
  type RuntimeHostWorkspaceExecutionComposition,
} from './workspace-execution-composition.js';

export interface ExecutionRuntimeHostComposition extends RuntimeHostComposition {
  readonly workspaceExecution: RuntimeHostWorkspaceExecutionComposition;
}

export interface CreateExecutionRuntimeHostCompositionOptions {
  readonly managedWorkspaceGitRuntime?: VerifiedGitRuntimeInput;
}

export function runtimeHostFilesystemWorkerRuntime(versions: {
  readonly electron?: string;
}): 'electron' | 'node' {
  return versions.electron ? 'electron' : 'node';
}

export async function createExecutionRuntimeHostComposition(
  context: RuntimeHostCompositionContext,
  options: CreateExecutionRuntimeHostCompositionOptions = {},
): Promise<ExecutionRuntimeHostComposition> {
  const stores = await openInteractiveExecutionStoresForWrite(context.owner.lease);
  let graphControlStore: ReturnType<typeof createAgentGraphControlStore> | undefined;
  let taskLedgerStore:
    | Awaited<ReturnType<typeof openInteractiveTaskLedgerStoreForWrite>>
    | undefined;
  let usageStores: Awaited<ReturnType<typeof openInteractiveUsageStoresForWrite>> | undefined;
  let artifactStore: Awaited<ReturnType<typeof openInteractiveArtifactStoreForWrite>> | undefined;
  let shellRunStore: Awaited<ReturnType<typeof openInteractiveShellRunStoreForWrite>> | undefined;
  let longTermMemoryStore: InteractiveLongTermMemoryWriter | undefined;
  let automationStore:
    | Awaited<ReturnType<typeof openInteractiveAutomationAuthorityForWrite>>
    | undefined;
  let planStore: Awaited<ReturnType<typeof openInteractivePlanStoreForWrite>> | undefined;
  let deepResearchStore:
    | Awaited<ReturnType<typeof openInteractiveDeepResearchStoreForWrite>>
    | undefined;
  let dailyReviewStore:
    | Awaited<ReturnType<typeof openInteractiveDailyReviewAuthorityForWrite>>
    | undefined;
  let graphClient: HostAgentGraphCoordinator | undefined;
  let sessionEffects: HostSessionEffectCoordinator | undefined;
  let memoryExtraction: HostMemoryExtractionCoordinator | undefined;
  let unsubscribeTaskLedger: (() => void) | undefined;
  let managedWorkspaceOwner: ManagedWorkspaceOwner | undefined;
  let workspaceExecution: RuntimeHostWorkspaceExecutionComposition | undefined;
  try {
    const runtimePolicyStores = await openInteractiveRuntimePolicyStoresForWrite(
      context.owner.lease,
    );
    const oauthCredentials = new HostOAuthExecutionAuthority(runtimePolicyStores);
    const openedAutomationStore = await openInteractiveAutomationAuthorityForWrite(
      context.owner.lease,
    );
    automationStore = openedAutomationStore;
    const openedPlanStore = await openInteractivePlanStoreForWrite(context.owner.lease);
    planStore = openedPlanStore;
    const openedDeepResearchStore = await openInteractiveDeepResearchStoreForWrite(
      context.owner.lease,
    );
    deepResearchStore = openedDeepResearchStore;
    const openedDailyReviewStore = await openInteractiveDailyReviewAuthorityForWrite(
      context.owner.lease,
    );
    dailyReviewStore = openedDailyReviewStore;
    const memoryStore = await openInteractiveMemoryBundleStoreForWrite(context.owner.lease);
    longTermMemoryStore = await openInteractiveLongTermMemoryStoreForWrite(context.owner.lease);
    taskLedgerStore = await openInteractiveTaskLedgerStoreForWrite(context.owner.lease);
    const openedArtifactStore = await openInteractiveArtifactStoreForWrite(context.owner.lease);
    artifactStore = openedArtifactStore;
    const openedUsageStores = await openInteractiveUsageStoresForWrite(context.owner.lease);
    usageStores = openedUsageStores;
    const openedShellRunStore = await openInteractiveShellRunStoreForWrite(context.owner.lease);
    shellRunStore = openedShellRunStore;
    const worktreeChildExecutor = createGitWorktreeChildExecutor({
      storageRoot: context.owner.capability.canonicalPath,
    });
    await stores.messageReceiptStore.beginHostEpoch(context.hostEpoch);
    const backends = new BackendRegistry();
    backends.register('fake', (backendContext) => new FakeBackend(backendContext));
    const runtimePolicyActivation = new RuntimePolicyActivationGate();
    const sessionAdmission = new SessionAdmissionGate();
    const memoryExtractionLane = new MemoryExtractionSessionLane();
    let runtimeResources: HostRuntimeResourceCoordinator | undefined;
    let manager: SessionManager | undefined;
    let graphCoordinator: AgentGraphCoordinator | undefined;
    let graphSupervisorWake: AgentGraphSupervisorWakeCoordinator | undefined;
    const graphWakeActivities = new SessionActivityRegistry();
    const shellRuns = new ShellRunProcessManager({
      store: openedShellRunStore,
      newId: randomUUID,
      now: Date.now,
      onShellRunUpdate: (update) => runtimeResources?.observeShellRunUpdate(update),
    });
    const sandboxManager = createBuiltinSandboxManager();
    const filesystemWorkerLaunchSpecProvider =
      sandboxManager && isBuiltinFilesystemWorkerSandboxAvailable()
        ? createFilesystemWorkerLaunchSpecProvider({
            runtime: runtimeHostFilesystemWorkerRuntime({
              electron: process.versions.electron,
            }),
            platform: process.platform,
            resourceLocation: { kind: 'runtime' },
          })
        : undefined;
    const filesystemWorker =
      sandboxManager && filesystemWorkerLaunchSpecProvider
        ? new FilesystemWorkerClient({
            sandboxManager,
            getLaunchSpec: filesystemWorkerLaunchSpecProvider,
          })
        : undefined;
    const managedFilesystemWorker = filesystemWorker
      ? adaptManagedWorkspaceFilesystemWorker(filesystemWorker)
      : undefined;
    if (options.managedWorkspaceGitRuntime) {
      if (!managedFilesystemWorker) {
        throw new RuntimeHostWorkspaceExecutionError(
          'filesystem_worker_unavailable',
          'Managed workspace execution requires the sandboxed filesystem worker',
        );
      }
      managedWorkspaceOwner = await openManagedWorkspaceOwner({
        rootOwner: context.owner,
        gitRuntime: options.managedWorkspaceGitRuntime,
        filesystemWorker: managedFilesystemWorker,
      });
    }
    workspaceExecution = createRuntimeHostWorkspaceExecutionComposition({
      ...(managedFilesystemWorker ? { filesystemWorker: managedFilesystemWorker } : {}),
      ...(managedWorkspaceOwner ? { managedOwner: managedWorkspaceOwner } : {}),
    });
    const taskLedger = new HostTaskLedgerCoordinator(
      taskLedgerStore,
      sessionAdmission,
      stores.sessionStore,
    );
    runtimeResources = new HostRuntimeResourceCoordinator({
      manager: shellRuns,
      sessions: {
        listShellRunUpdates: (sessionId) =>
          requireSessionManager(manager).listShellRunUpdates(sessionId),
        getShellRunUpdate: (sessionId, ref) =>
          requireSessionManager(manager).getShellRunUpdate(sessionId, ref),
      },
      sessionHeaders: stores.sessionStore,
      sessionAdmission,
      acquireResidency: context.acquireResidency,
      requestDrain: context.requestDrain,
      onProjectionChanged: (update) =>
        requireContinuity(continuity).enqueueRuntimeResourceChanged(update),
    });
    const executionArtifacts = createHostExecutionArtifactServices({
      artifacts: openedArtifactStore,
      requestDrain: context.requestDrain,
    });
    const builtinTools = {
      shellRuns: runtimeResources,
      runtimeResources,
      attachmentResources: createArtifactAttachmentResourceReader({
        artifactStore: openedArtifactStore,
      }),
      backgroundTasks: runtimeResources,
      ptyControls: runtimeResources,
      snapshotImage: createReadImageSnapshotter(openedArtifactStore),
      ...(sandboxManager ? { sandboxManager } : {}),
      ...(filesystemWorker ? { filesystemWorker } : {}),
    };
    const webSearchService = createHostWebSearchService({
      policy: runtimePolicyStores.operations,
    });
    const webFetchService = createHostWebFetchService({
      policy: runtimePolicyStores.operations,
    });
    const hostTools = [
      createHostWebSearchToolFromService(webSearchService),
      createHostWebFetchToolFromService(webFetchService),
    ];
    const childAgentTools = createHostChildAgentToolComposition({
      taskLedger,
      builtinTools,
      hostTools,
      worktreePatchWriteBackAvailable: true,
    });
    const openedGraphControlStore = createAgentGraphControlStore(
      context.owner.capability.canonicalPath,
    );
    graphControlStore = openedGraphControlStore;
    const skills = new HostSkillCatalogCoordinator(
      new SkillCatalogRepository({
        runWithRoot: (operation) =>
          runWithStorageRootLease(context.owner.lease, 'interactive', 'write', operation),
      }),
    );
    let rootCoordinator: RootTurnCoordinator | undefined;
    let continuity: SessionContinuityCoordinator | undefined;
    let canonicalProjection: CanonicalSessionProjectionReader | undefined;
    let memory: HostMemoryCoordinator | undefined;
    let clientCapabilities: HostClientCapabilityCoordinator | undefined;
    let oauth: HostOAuthCoordinator | undefined;
    let automations: HostAutomationCoordinator | undefined;
    let goal: HostGoalCoordinator | undefined;
    let deepResearch: HostDeepResearchCoordinator | undefined;
    let dailyReview: HostDailyReviewCoordinator | undefined;
    const rootPort: HostMessageRootPort = {
      readSessionHeader: (sessionId) =>
        requireRootCoordinator(rootCoordinator).readSessionHeader(sessionId),
      readRootState: (sessionId) =>
        requireRootCoordinator(rootCoordinator).readRootState(sessionId),
      claimStopFence: (input, commitQueueFence, admission) =>
        requireRootCoordinator(rootCoordinator).claimStopFence(input, commitQueueFence, admission),
      startFromMessage: (input, admission) =>
        requireRootCoordinator(rootCoordinator).startFromMessage(input, admission),
      prepareMessage: (input) => requireRootCoordinator(rootCoordinator).prepareMessage(input),
      claimStop: (input, commitQueueFence, admission) =>
        requireRootCoordinator(rootCoordinator).claimStop(input, commitQueueFence, admission),
    };
    const messages = new HostMessageCoordinator({
      hostEpoch: context.hostEpoch,
      root: rootPort,
      durableProof: {
        readRootTurnSourceMessageReceipt: (sessionId, messageId) =>
          stores.agentRunStore.readRootTurnSourceMessageReceipt(sessionId, messageId),
        readImmutableSteeringMessageProof: (sessionId, messageId) =>
          stores.runtimeEventStore.readImmutableSteeringMessageProof(sessionId, messageId),
      },
      receipts: stores.messageReceiptStore,
      sessionAdmission,
      acquireResidency: context.acquireResidency,
      requestDrain: context.requestDrain,
      preflightSessionSnapshot: (sessionId, candidate) =>
        requireCanonicalProjection(canonicalProjection).fitsCandidate(sessionId, candidate),
      onProjectionChanged: (sessionId) =>
        requireContinuity(continuity).enqueueCanonicalRefresh(sessionId),
    });
    const rootAdmissionOwner = new RootAdmissionOwner(stores.agentRunStore);
    const canonicalProjectionReader = new CanonicalSessionProjectionReader({
      stores,
      rootAdmissions: rootAdmissionOwner,
      messages,
      readGoal: (sessionId) => requireGoal(goal).readProjection(sessionId),
    });
    canonicalProjection = canonicalProjectionReader;
    const canonicalPermissionOutcomes = new HostCanonicalPermissionOutcomeReader({
      store: stores.interactionStore,
    });
    continuity = new SessionContinuityCoordinator(
      context.hostEpoch,
      (sessionId) => canonicalProjectionReader.read(sessionId),
      sessionAdmission,
      context.requestDrain,
      createSessionTranscriptReader({ stores, canonicalPermissionOutcomes }),
    );
    const continuityCoordinator = continuity;
    unsubscribeTaskLedger = taskLedger.subscribe(({ sessionId }) =>
      continuityCoordinator.enqueueSessionDomainChanged(sessionId, 'task'),
    );
    deepResearch = new HostDeepResearchCoordinator({
      store: openedDeepResearchStore,
      artifacts: openedArtifactStore,
      sessions: stores.sessionStore,
      sessionAdmission,
      onProjectionChanged: (sessionId) =>
        continuityCoordinator.enqueueSessionDomainChanged(sessionId, 'deep_research'),
    });
    dailyReview = new HostDailyReviewCoordinator({
      store: openedDailyReviewStore,
      usage: openedUsageStores,
      sessions: stores.sessionStore,
      readRunEvents: (sessionId, runId) => stores.agentRunStore.readEvents(sessionId, runId),
      model: createHostDailyReviewModel({
        runtimePolicy: runtimePolicyStores,
        oauthCredentials,
        claudeDeviceId: context.owner.capability.rootId,
        usage: openedUsageStores,
        requestDrain: context.requestDrain,
      }),
      acquireResidency: context.acquireResidency,
      requestDrain: context.requestDrain,
    });
    let poisonFailure: Error | undefined;
    let draining = false;
    let recoveryTask: Promise<void> | undefined;
    let rootCloseTask: Promise<void> | undefined;
    let rootRecoveryCompleted = false;
    let closeTask: Promise<void> | undefined;
    let backendInvalidationPoisoned = false;
    const beginDrain = () => {
      if (draining) return;
      draining = true;
      workspaceExecution?.beginDrain();
      goal?.beginDrain();
      rootCoordinator?.beginDrain();
      runtimeResources?.beginDrain();
      automations?.beginDrain();
      dailyReview?.beginDrain();
      messages.beginDrain();
      interactions.beginDrain();
      connectionEffects.beginDrain();
      sessionEffects?.beginDrain();
      skills.beginDrain();
      memory?.beginDrain();
      memoryExtraction?.beginDrain();
      oauth?.beginDrain();
      clientCapabilities?.beginDrain();
    };
    const interactions = new HostInteractionCoordinator({
      store: stores.interactionStore,
      sandboxBoundaries: stores.sessionStore,
      sessionAdmission,
      sessions: stores.sessionStore,
      preflightSessionSnapshot: (sessionId, interactionProjection) =>
        canonicalProjectionReader.fitsCandidate(sessionId, {
          interactions: interactionProjection,
        }),
      refreshCanonicalContinuity: (sessionId, admission) =>
        continuityCoordinator.refreshCanonical(sessionId, admission),
      onPoison: (error) => {
        if (poisonFailure) return;
        poisonFailure = error;
        context.retainUntilProcessExit();
        beginDrain();
        context.requestDrain();
      },
      onSandboxBoundarySettled: (sessionId) =>
        notifySandboxBoundaryGraphWake(sessionId, stores.sessionStore, (rootSessionId) =>
          requireGraphSupervisorWake(graphSupervisorWake).notifyPermissionResponse(rootSessionId),
        ),
    });
    memory = new HostMemoryCoordinator({
      store: memoryStore,
      runtimePolicyStores,
      activation: runtimePolicyActivation,
      requestDrain: context.requestDrain,
    });
    memoryExtraction = new HostMemoryExtractionCoordinator({
      store: longTermMemoryStore,
      policy: runtimePolicyStores.runtimePolicy,
      sessions: {
        readHeader: (sessionId) => stores.sessionStore.readHeaderSnapshot(sessionId),
      },
      runtimeEvents: {
        readSessionRuntimeEventEntries: (sessionId) =>
          stores.runtimeEventStore.readSessionRuntimeEventEntries(sessionId),
      },
      historyCompaction: {
        readLatestCheckpoint: (sessionId) =>
          loadLatestHistoryCompactCheckpointFromRunLedger(stores.agentRunStore, sessionId),
      },
      model: createHostMemoryExtractionModel({
        runtimePolicy: runtimePolicyStores,
        oauthCredentials,
        claudeDeviceId: context.owner.capability.rootId,
        usage: openedUsageStores,
        requestDrain: context.requestDrain,
      }),
      lane: memoryExtractionLane,
      acquireResidency: context.acquireResidency,
    });
    backends.register('ai-sdk', (backendContext) =>
      createHostAiSdkBackend({
        context: backendContext,
        runtimePolicy: runtimePolicyStores,
        oauthCredentials,
        claudeDeviceId: context.owner.capability.rootId,
        skills,
        memory: requireMemory(memory),
        memoryExtraction,
        taskLedger,
        artifacts: openedArtifactStore,
        executionArtifacts,
        usage: openedUsageStores,
        clientCapabilities: requireClientCapabilities(clientCapabilities),
        automationTool: requireAutomationCoordinator(automations).modelTool,
        planStore: openedPlanStore,
        deepResearchTools: requireDeepResearch(deepResearch).toolsForSession(
          backendContext.sessionId,
        ),
        goalTools: requireGoal(goal).tools,
        builtinTools,
        hostTools,
        resolveRootTools: (sessionId) =>
          requireGraphCoordinator(graphCoordinator).toolsForSession(sessionId),
        parentAgentTools: childAgentTools.parentTools,
        childTools: childAgentTools.childTools,
        worktreePatchWriteBackAvailable: true,
        childAgents: bindHostChildAgentBackend(
          requireSessionManager(manager),
          backendContext.sessionId,
        ),
        runtimeCommitSink: stores.runtimeEventStore,
        requestDrain: context.requestDrain,
      }),
    );
    const runtimeAuthority: RuntimeHostedRootAuthority = {
      bindRun: (identity) => messages.bindRun(identity),
      executeRoot: (input) => requireRootCoordinator(rootCoordinator).executeRoot(input),
      stopRoot: (identity, input) =>
        requireRootCoordinator(rootCoordinator).stopRoot(identity, input),
      stopSession: (sessionId, input) =>
        requireRootCoordinator(rootCoordinator).stopSession(sessionId, input),
    };
    const resolveAvailableToolNames = async (sessionId: string): Promise<string[]> => {
      const capabilitySnapshot =
        requireClientCapabilities(clientCapabilities).snapshotForSession(sessionId);
      try {
        const graphTools =
          await requireGraphCoordinator(graphCoordinator).toolsForSession(sessionId);
        const [header, planState] = await Promise.all([
          stores.sessionStore.readHeaderSnapshot(sessionId),
          openedPlanStore.readState(sessionId),
        ]);
        return createHostExecutionModelComposition({
          policy: runtimePolicyStores.runtimePolicy,
          skills,
          memory: requireMemory(memory),
          taskLedger,
          ...(capabilitySnapshot ? { clientCapabilities: capabilitySnapshot } : {}),
          builtinTools,
          hostTools: [...hostTools, ...graphTools],
          automationTool: requireAutomationCoordinator(automations).modelTool,
          goalTools: requireGoal(goal).tools,
          parentAgentTools: childAgentTools.parentTools,
          plan: {
            store: openedPlanStore,
            state: planState,
            mode: header.collaborationMode ?? 'agent',
          },
          ...(isDeepResearchSession(header.labels)
            ? {
                deepResearch: {
                  tools: requireDeepResearch(deepResearch).toolsForSession(sessionId),
                },
              }
            : {}),
        }).tools.map((tool) => tool.name);
      } finally {
        capabilitySnapshot?.release();
      }
    };
    const sessionEffectCoordinator = new HostSessionEffectCoordinator({
      model: createHostSessionEffectModel({
        runtimePolicy: runtimePolicyStores,
        oauthCredentials,
        claudeDeviceId: context.owner.capability.rootId,
        usage: openedUsageStores,
        requestDrain: context.requestDrain,
      }),
      readModel: new RuntimeReadModel({
        runStore: stores.agentRunStore,
        runtimeEventStore: stores.runtimeEventStore,
        projectionCache: stores.sessionStore,
        canonicalPermissionOutcomes,
      }),
      artifacts: openedArtifactStore,
      sessions: stores.sessionStore,
      readSessionHeader: (sessionId) => stores.sessionStore.readHeaderSnapshot(sessionId),
      sessionAdmission,
      acquireResidency: context.acquireResidency,
      requestDrain: context.requestDrain,
    });
    sessionEffects = sessionEffectCoordinator;
    const resolveChildTools = async (sessionId: string): Promise<readonly MakaTool[]> => {
      const header = await stores.sessionStore.readHeader(sessionId);
      const [resolved, snapshot] = await Promise.all([
        runtimePolicyStores.operations.resolveExecutionConnection(header.llmConnectionSlug),
        runtimePolicyStores.runtimePolicy.getSnapshot(),
      ]);
      if (resolved.kind !== 'ready') {
        return childAgentTools.childTools.filter((tool) => tool.name !== 'WebSearch');
      }
      const { models, ...connection } = resolved.connection;
      return routeWebSearchTools({
        tools: childAgentTools.childTools,
        settings: snapshot.policy.webSearch,
        connection: {
          ...connection,
          defaultModel: header.model,
          ...(models ? { models: [...models] } : {}),
        },
        model: header.model,
        privacy: snapshot.policy.privacy,
      });
    };
    manager = new SessionManager({
      store: stores.sessionStore,
      runStore: stores.agentRunStore,
      runtimeEventStore: stores.runtimeEventStore,
      toolBoundaryProtocol: stores.runtimeEventStore.toolBoundaryProtocol,
      backends,
      newId: randomUUID,
      now: Date.now,
      safeBoundaryResumeEnabled: process.env.MAKA_RUNTIME_SAFE_BOUNDARY_RESUME === '1',
      generateSessionTitle: (input) => sessionEffectCoordinator.generateTitle(input),
      onSessionTitleChanged: (sessionId) =>
        continuityCoordinator.enqueueCanonicalRefresh(sessionId),
      inspectContinuationSafety: createLocalContinuationSafetyInspector({
        readSessionCwd: async (sessionId) =>
          (await stores.sessionStore.readHeaderSnapshot(sessionId)).cwd,
        resolveWorkspaceIdentity: async (cwd) => resolveWorkspaceIdentity({ path: cwd }),
        listAvailableToolNames: resolveAvailableToolNames,
        hasPendingBackgroundOperations: async (sessionId) => {
          const graph = requireGraphCoordinator(graphCoordinator);
          const graphWake = requireGraphSupervisorWake(graphSupervisorWake);
          const [resourcesLive, graphLive, descendantLive] = await Promise.all([
            runtimeResources!.hasLiveSessionResources(sessionId),
            graph.hasLiveSessionState(sessionId),
            hasLiveLinkedDescendantState(
              requireSessionManager(manager),
              stores.agentRunStore,
              sessionId,
              async (descendantSessionId) =>
                (await runtimeResources!.hasLiveSessionResources(descendantSessionId)) ||
                graph.hasLiveSessionState(descendantSessionId) ||
                graphWake.hasLiveSessionState(descendantSessionId),
            ),
          ]);
          return (
            resourcesLive || graphLive || graphWake.hasLiveSessionState(sessionId) || descendantLive
          );
        },
      }),
      runBackendActivation: (operation) => runtimePolicyActivation.runBackendActivation(operation),
      messageAuthority: runtimeAuthority,
      hostedAgentGraphExecution: {
        readAgentGraphIntentClaim: (graphId, intentId) =>
          openedGraphControlStore.readAgentGraphIntentClaim(graphId, intentId),
        readRootTurnAdmissionIdentity: async (sessionId, turnId) => {
          const admission = await stores.agentRunStore.readRootTurnAdmission(sessionId, turnId);
          return admission
            ? { runId: admission.runId, userMessageId: admission.userMessageId }
            : undefined;
        },
      },
      interactionAuthority: interactions,
      canonicalPermissionOutcomes,
      shellRuns,
      planStore: openedPlanStore,
      childTools: childAgentTools.childTools,
      resolveChildTools,
      worktreeChildExecutor,
      listArtifactsForTurn: (sessionId, turnId) =>
        openedArtifactStore.listTurnArtifacts(sessionId, turnId),
      publishChildWorkspacePatch: ({ sessionId, turnId, binding, patch }) =>
        openedArtifactStore.create({
          id: subagentWritebackArtifactId(sessionId, turnId),
          sessionId,
          turnId,
          name: 'workspace.patch',
          kind: 'diff',
          content: patch,
          mimeType: 'text/x-diff; charset=utf-8',
          source: 'subagent_writeback',
          summary: `Workspace changes relative to ${binding.baseCommit}.`,
        }),
      assertChildWorkspaceQuiescent: async (sessionId) => {
        if (await runtimeResources!.hasLiveSessionResources(sessionId)) {
          throw new Error(
            `Child Session ${sessionId} still owns live Runtime Resources; patch publication requires a quiescent workspace`,
          );
        }
      },
    });
    graphCoordinator = new AgentGraphCoordinator({
      sessionStore: stores.sessionStore,
      runStore: stores.agentRunStore,
      runtimeEventStore: stores.runtimeEventStore,
      controlStore: openedGraphControlStore,
      runtime: manager,
      newId: randomUUID,
      acquireResidency: () => context.acquireResidency(),
      onReconciliation: (rootSessionId, result) => {
        void requireGraphSupervisorWake(graphSupervisorWake).notify(rootSessionId, result);
      },
    });
    graphClient = new HostAgentGraphCoordinator({
      authority: graphCoordinator,
      continuity: continuityCoordinator,
    });
    const observeBackendInvalidation = (completion: Promise<void>) => {
      void completion.catch(() => {
        backendInvalidationPoisoned = true;
        runtimePolicyActivation.poison();
        context.requestDrain();
      });
    };
    const registerBackendInvalidation = (): void => {
      observeBackendInvalidation(manager.refreshIdleBackends());
    };
    clientCapabilities = new HostClientCapabilityCoordinator({
      activation: runtimePolicyActivation,
      onModelToolsChanged: registerBackendInvalidation,
    });
    oauth = new HostOAuthCoordinator({
      runtimePolicy: runtimePolicyStores,
      oauthCredentials,
      activation: runtimePolicyActivation,
      clientCapabilities,
      isProviderEnabled: isOAuthEnrollmentProviderEnabled,
      acquireResidency: context.acquireResidency,
      invalidateBackends: () => manager.refreshIdleBackends(),
      onFatal: (error) => {
        if (poisonFailure) return;
        poisonFailure = error;
        runtimePolicyActivation.poison();
        context.retainUntilProcessExit();
        beginDrain();
        context.requestDrain();
      },
    });
    const usagePricing = new HostUsagePricingCoordinator(
      openedUsageStores,
      context.requestDrain,
      runtimePolicyActivation,
      registerBackendInvalidation,
      // The authority read behind Usage read-model repair (#1679).
      (sessionId, runId) => stores.agentRunStore.readEvents(sessionId, runId),
    );
    const webSearch = new HostWebSearchCoordinator(webSearchService);
    const networkProxy = new HostNetworkProxyCoordinator(runtimePolicyStores.operations);
    const configuration = new HostConfigurationCoordinator(runtimePolicyStores.operations);
    const artifacts = new HostArtifactCoordinator(
      openedArtifactStore,
      context.requestDrain,
      sessionAdmission,
      stores.sessionStore,
    );
    rootCoordinator = new RootTurnCoordinator(
      manager,
      stores,
      sessionAdmission,
      rootAdmissionOwner,
      interactions,
      messages,
      continuityCoordinator,
      context.acquireResidency,
      context.requestDrain,
      clientCapabilities,
      () => requireGoal(goal),
      (admission) => requireAutomationCoordinator(automations).assertRecoveryAdmission(admission),
      artifacts,
      async ({ sessionId, text, skillIds }) => {
        const header = await stores.sessionStore.readHeaderSnapshot(sessionId);
        const [inventory, toolNames] = await Promise.all([
          skills.readCanonicalModelInventory({ projectRoot: header.cwd }),
          resolveAvailableToolNames(sessionId),
        ]);
        return prepareSkillInvocationMessageFromInventory({
          text,
          skillIds,
          inventory: inventory.inventory,
          host: buildHostCapabilitiesFromBinding(toolNames),
        });
      },
    );
    const coordinator = rootCoordinator;
    graphSupervisorWake = new AgentGraphSupervisorWakeCoordinator({
      activityRegistry: graphWakeActivities,
      wakeStore: openedGraphControlStore,
      readSnapshot: (rootSessionId) =>
        requireGraphCoordinator(graphCoordinator).getSnapshot(rootSessionId),
      startTurn: (sessionId, input, _activity, abortSignal, isCurrent) =>
        coordinator.runAgentGraphSupervisorTurn(sessionId, input, abortSignal, isCurrent),
      inspectAttempt: async (rootSessionId, attemptId, turnId) => {
        const runs = (await stores.agentRunStore.listSessionRuns(rootSessionId)).filter(
          (run) => run.agentGraphWakeAttemptId === attemptId && run.turnId === turnId,
        );
        if (runs.length > 1) {
          throw new Error(
            `Agent graph supervisor wake attempt ${attemptId} has multiple AgentRuns`,
          );
        }
        return runs[0]?.status ?? 'missing';
      },
      recoverContextOverflow: (rootSessionId, { abortSignal }) =>
        coordinator.recoverAgentGraphSupervisorContextOverflow(
          rootSessionId,
          randomUUID(),
          abortSignal,
        ),
      newId: randomUUID,
      isSessionDeliverable: async (sessionId) => {
        try {
          const header = await stores.sessionStore.readHeaderSnapshot(sessionId);
          return !header.isArchived && header.status !== 'archived';
        } catch (error) {
          if (isSessionNotFoundError(error)) return false;
          throw error;
        }
      },
      acquireResidency: () => context.acquireResidency(),
      onError: () => context.requestDrain(),
    });
    automations = new HostAutomationCoordinator({
      store: openedAutomationStore,
      sessions: stores.sessionStore,
      runs: stores.agentRunStore,
      runtime: manager,
      root: { executeRoot: (input) => coordinator.executeRoot(input) },
      runtimePolicy: runtimePolicyStores,
      isSessionActive: (sessionId) => coordinator.readRootState(sessionId).kind !== 'idle',
      sessionAdmission,
      acquireResidency: context.acquireResidency,
      requestDrain: context.requestDrain,
    });
    goal = new HostGoalCoordinator({
      stores,
      sessionAdmission,
      evaluator: createHostGoalEvaluator({
        runtimePolicy: runtimePolicyStores,
        oauthCredentials,
        claudeDeviceId: context.owner.capability.rootId,
        usage: openedUsageStores,
        requestDrain: context.requestDrain,
        readSessionHeader: (sessionId) => stores.sessionStore.readHeaderSnapshot(sessionId),
      }),
      admitTurn: (sessionId, text, checkpoint, controlLease) =>
        coordinator.admitGoalTurn(sessionId, checkpoint, controlLease, text),
      listActionableTaskKeys: async (sessionId) => {
        const tasks = await taskLedger.list(sessionId, {
          includeTerminal: false,
          includeArchived: false,
          classifyResumeTrust: true,
        });
        return filterModelVisibleTaskLedgerTasks(tasks)
          .filter((task) => task.status === 'pending' || task.status === 'in_progress')
          .map((task) => task.key);
      },
      acquireResidency: context.acquireResidency,
      onProjectionChanged: (sessionId) => continuityCoordinator.enqueueCanonicalRefresh(sessionId),
    });
    const runtimePolicy = new HostRuntimePolicyCoordinator(
      runtimePolicyStores,
      runtimePolicyActivation,
      async () => {
        try {
          await requireMemory(memory).refreshAfterPolicyMutation();
        } catch (error) {
          context.requestDrain();
          throw error;
        }
        registerBackendInvalidation();
      },
    );
    const connectionEffects = new HostConnectionEffectCoordinator({
      stores: runtimePolicyStores,
      activation: runtimePolicyActivation,
      oauthCredentials,
      onCommittedMutation: registerBackendInvalidation,
    });
    const sessionCatalog = new HostSessionCatalogCoordinator({
      stores: stores.sessionStore,
      runtimePolicy: runtimePolicyStores,
      manager,
      admission: sessionAdmission,
      continuity: continuityCoordinator,
      requestDrain: context.requestDrain,
    });
    const plans = new HostPlanCoordinator({
      store: openedPlanStore,
      sessions: stores.sessionStore,
      runtime: manager,
      sessionAdmission,
      isSessionActive: (sessionId) => coordinator.readRootState(sessionId).kind !== 'idle',
      refreshContinuity: (sessionId, lease) =>
        continuityCoordinator.refreshCanonical(sessionId, lease),
      onProjectionChanged: (sessionId) =>
        continuityCoordinator.enqueueSessionDomainChanged(sessionId, 'plan'),
      requestDrain: context.requestDrain,
      root: coordinator,
    });
    const executionInspect = new HostExecutionInspectCoordinator(stores);
    const sessionRevisions = new HostSessionRevisionCoordinator({
      stores,
      artifacts: openedArtifactStore,
      taskLedger: taskLedgerStore,
      manager,
      admission: sessionAdmission,
      continuity: continuityCoordinator,
      graph: requireGraphCoordinator(graphCoordinator),
      isSessionActive: (sessionId) => coordinator.readRootState(sessionId).kind !== 'idle',
      requestDrain: context.requestDrain,
    });
    const sessionRetirement = new HostSessionRetirementCoordinator({
      stores: stores.sessionStore,
      admission: sessionAdmission,
      root: coordinator,
      messages,
      interactions,
      goals: requireGoal(goal),
      automation: automations,
      resources: runtimeResources,
      sessionEffects: sessionEffectCoordinator,
      graph: requireGraphCoordinator(graphCoordinator),
      graphWake: requireGraphSupervisorWake(graphSupervisorWake),
      manager,
      capabilities: clientCapabilities,
      continuity: continuityCoordinator,
      artifacts: openedArtifactStore,
      taskLedger: taskLedgerStore,
      purgeOperationalState: async (sessionId) => {
        await stores.purgeConversationOperationalState(sessionId);
        await openedPlanStore.purgeSessionState(sessionId);
        await openedDeepResearchStore.purgeSessionState(sessionId);
      },
      purgeAgentGraphState: async (sessionId) => {
        await openedGraphControlStore.purgeAgentGraphControlState(
          agentGraphIdForRootSession(sessionId),
        );
      },
      worktrees: worktreeChildExecutor,
      requestDrain: context.requestDrain,
      memoryExtractionLane,
    });
    const handlers = {
      ...coordinator.handlers,
      ...requireGoal(goal).handlers,
      ...sessionCatalog.handlers,
      ...executionInspect.handlers,
      ...graphClient.handlers,
      ...sessionRevisions.handlers,
      ...sessionRetirement.handlers,
      ...messages.handlers,
      ...interactions.handlers,
      ...runtimePolicy.handlers,
      ...connectionEffects.handlers,
      ...sessionEffectCoordinator.handlers,
      ...continuityCoordinator.handlers,
      ...taskLedger.handlers,
      ...artifacts.handlers,
      ...skills.handlers,
      ...usagePricing.handlers,
      ...requireMemory(memory).handlers,
      ...oauth.handlers,
      ...clientCapabilities.handlers,
      ...runtimeResources.handlers,
      ...automations.handlers,
      ...plans.handlers,
      ...requireDeepResearch(deepResearch).handlers,
      ...requireDailyReview(dailyReview).handlers,
      ...webSearch.handlers,
      ...networkProxy.handlers,
      ...configuration.handlers,
    } satisfies DomainOperationHandlerMap;
    const recover = () => {
      recoveryTask ??= (async () => {
        await requireMemory(memory).recover();
        await skills.recover();
        await openedArtifactStore.recover();
        await sessionRetirement.recover();
        const sessions = await stores.sessionStore.listForRecovery();
        await worktreeChildExecutor.recover(
          sessions.flatMap((session) =>
            session.subagentWorkspace ? [session.subagentWorkspace] : [],
          ),
        );
        await sessionRevisions.recover();
        for (const session of sessions) {
          await stores.runtimeEventStore.repairImmutableSteeringMessageProofsForRecovery(
            session.id,
          );
        }
        await recoverClientCapabilityOutcomes(
          stores.runtimeEventStore,
          sessions.map((session) => session.id),
        );
        await requireAutomationCoordinator(automations).prepareRecovery();
        await coordinator.prepareRecovery();
        await interactions.recoverPendingAfterHostRestart();
        await manager.recoverInterruptedSessionsStrict(stores);
        await manager.recoverChildWorkspacePatches(
          sessions.flatMap((session) => (session.subagentWorkspace ? [session.id] : [])),
        );
        await coordinator.recover();
        rootRecoveryCompleted = true;
        await requireGraphSupervisorWake(graphSupervisorWake).recover();
        await requireGraphCoordinator(graphCoordinator).recover();
        await requireAutomationCoordinator(automations).recover();
        await requireDailyReview(dailyReview).recover();
        requireAutomationCoordinator(automations).start();
      })();
      return recoveryTask;
    };
    const close = () => {
      closeTask ??= (async () => {
        beginDrain();
        const errors: unknown[] = [];
        try {
          await recover();
        } catch (error) {
          errors.push(error);
        }
        try {
          await goal?.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await connectionEffects.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await graphSupervisorWake?.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          graphClient?.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await graphCoordinator?.close();
        } catch (error) {
          errors.push(error);
        }
        if (rootRecoveryCompleted && !poisonFailure) {
          try {
            rootCloseTask ??= coordinator.close();
            await rootCloseTask;
          } catch (error) {
            errors.push(error);
          }
        }
        try {
          await automations?.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await dailyReview?.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await runtimeResources?.close();
        } catch (error) {
          errors.push(error);
        }
        // Host operations have already drained before composition.close().
        // Close the workspace execution owner before the kernel releases the
        // root owner, preserving tool operations -> managed owner -> root owner.
        try {
          await workspaceExecution?.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await sessionEffects?.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          deepResearch?.close();
        } catch (error) {
          errors.push(error);
        }
        if (!backendInvalidationPoisoned) {
          try {
            await manager.refreshIdleBackends();
          } catch (error) {
            errors.push(error);
          }
        }
        try {
          await messages.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await interactions.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          continuityCoordinator.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await skills.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await memoryExtraction?.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await memory?.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await oauth?.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          longTermMemoryStore?.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await clientCapabilities?.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await openedUsageStores.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await sessionRetirement.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          openedGraphControlStore.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          openedArtifactStore.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          unsubscribeTaskLedger?.();
          taskLedgerStore?.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          shellRunStore?.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          openedAutomationStore.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          openedPlanStore.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          openedDeepResearchStore.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await stores.sessionStore.close?.();
        } catch (error) {
          errors.push(error);
        }
        if (poisonFailure && !errors.includes(poisonFailure)) errors.push(poisonFailure);
        if (errors.length > 0) {
          throw new AggregateError(errors, 'Unable to close Runtime Host execution composition');
        }
      })();
      return closeTask;
    };
    return {
      handlers,
      workspaceExecution: requireWorkspaceExecution(workspaceExecution),
      continuity: continuityCoordinator,
      clientCapabilities,
      releaseConnection: (connectionId: string) => {
        artifacts.releaseConnection(connectionId);
        requireMemory(memory).releaseConnection(connectionId);
        clientCapabilities?.releaseConnection(connectionId);
        runtimeResources?.releaseConnection(connectionId);
      },
      beginDrain,
      recover,
      close,
    };
  } catch (error) {
    const errors: unknown[] = [error];
    try {
      await workspaceExecution?.close();
      if (!workspaceExecution) await managedWorkspaceOwner?.close();
    } catch (closeError) {
      errors.push(closeError);
    }
    try {
      await sessionEffects?.close();
    } catch (closeError) {
      errors.push(closeError);
    }
    try {
      dailyReviewStore?.close();
    } catch (closeError) {
      errors.push(closeError);
    }
    try {
      deepResearchStore?.close();
    } catch (closeError) {
      errors.push(closeError);
    }
    try {
      graphClient?.close();
    } catch (closeError) {
      errors.push(closeError);
    }
    try {
      graphControlStore?.close();
    } catch (closeError) {
      errors.push(closeError);
    }
    try {
      await usageStores?.close();
    } catch (closeError) {
      errors.push(closeError);
    }
    try {
      artifactStore?.close();
    } catch (closeError) {
      errors.push(closeError);
    }
    try {
      unsubscribeTaskLedger?.();
      taskLedgerStore?.close();
    } catch (closeError) {
      errors.push(closeError);
    }
    try {
      shellRunStore?.close();
    } catch (closeError) {
      errors.push(closeError);
    }
    try {
      await memoryExtraction?.close();
    } catch (closeError) {
      errors.push(closeError);
    }
    try {
      longTermMemoryStore?.close();
    } catch (closeError) {
      errors.push(closeError);
    }
    try {
      automationStore?.close();
    } catch (closeError) {
      errors.push(closeError);
    }
    try {
      planStore?.close();
    } catch (closeError) {
      errors.push(closeError);
    }
    try {
      await stores.sessionStore.close?.();
    } catch (closeError) {
      errors.push(closeError);
    }
    if (errors.length === 1) throw error;
    throw new AggregateError(errors, 'Unable to clean up Runtime Host execution composition');
  }
}

function requireRootCoordinator(coordinator: RootTurnCoordinator | undefined): RootTurnCoordinator {
  if (!coordinator) throw new Error('Runtime Host root coordinator is not composed');
  return coordinator;
}

function requireWorkspaceExecution(
  composition: RuntimeHostWorkspaceExecutionComposition | undefined,
): RuntimeHostWorkspaceExecutionComposition {
  if (!composition) throw new Error('Runtime Host workspace execution is not composed');
  return composition;
}

function adaptManagedWorkspaceFilesystemWorker(
  worker: Pick<FilesystemWorkerClient, 'execute'>,
): ManagedWorkspaceFilesystemWorker {
  return {
    async execute(input) {
      const result = await worker.execute(input);
      switch (result.kind) {
        case 'read':
        case 'read_image':
        case 'glob':
        case 'grep':
          return result;
        default:
          throw new RuntimeHostWorkspaceExecutionError(
            'workspace_operation_denied',
            `Read-only filesystem worker returned mutating result ${result.kind}`,
          );
      }
    },
  };
}

function subagentWritebackArtifactId(sessionId: string, turnId: string): string {
  const digest = createHash('sha256')
    .update('maka-subagent-writeback-v1\0')
    .update(sessionId)
    .update('\0')
    .update(turnId)
    .digest('hex')
    .slice(0, 32);
  return `subagent_writeback_${digest}`;
}

function requireContinuity(
  continuity: SessionContinuityCoordinator | undefined,
): SessionContinuityCoordinator {
  if (!continuity) throw new Error('Runtime Host continuity coordinator is not composed');
  return continuity;
}

function requireCanonicalProjection(
  projection: CanonicalSessionProjectionReader | undefined,
): CanonicalSessionProjectionReader {
  if (!projection) throw new Error('Runtime Host canonical projection is not composed');
  return projection;
}

function requireMemory(memory: HostMemoryCoordinator | undefined): HostMemoryCoordinator {
  if (!memory) throw new Error('Runtime Host Memory coordinator is not composed');
  return memory;
}

function requireClientCapabilities(
  coordinator: HostClientCapabilityCoordinator | undefined,
): HostClientCapabilityCoordinator {
  if (!coordinator) throw new Error('Runtime Host Client Capability coordinator is not composed');
  return coordinator;
}

function requireAutomationCoordinator(
  coordinator: HostAutomationCoordinator | undefined,
): HostAutomationCoordinator {
  if (!coordinator) throw new Error('Runtime Host Automation coordinator is not composed');
  return coordinator;
}

function requireDeepResearch(
  coordinator: HostDeepResearchCoordinator | undefined,
): HostDeepResearchCoordinator {
  if (!coordinator) throw new Error('Runtime Host Deep Research coordinator is not composed');
  return coordinator;
}

function requireDailyReview(
  coordinator: HostDailyReviewCoordinator | undefined,
): HostDailyReviewCoordinator {
  if (!coordinator) throw new Error('Runtime Host Daily Review coordinator is not composed');
  return coordinator;
}

function requireSessionManager(manager: SessionManager | undefined): SessionManager {
  if (!manager) throw new Error('Runtime Host SessionManager is not composed');
  return manager;
}

function requireGraphCoordinator(
  coordinator: AgentGraphCoordinator | undefined,
): AgentGraphCoordinator {
  if (!coordinator) throw new Error('Runtime Host Agent Graph coordinator is not composed');
  return coordinator;
}

function requireGraphSupervisorWake(
  coordinator: AgentGraphSupervisorWakeCoordinator | undefined,
): AgentGraphSupervisorWakeCoordinator {
  if (!coordinator) {
    throw new Error('Runtime Host Agent Graph supervisor wake coordinator is not composed');
  }
  return coordinator;
}

function requireGoal(coordinator: HostGoalCoordinator | undefined): HostGoalCoordinator {
  if (!coordinator) throw new Error('Runtime Host Goal coordinator is not composed');
  return coordinator;
}

async function hasLiveLinkedDescendantState(
  manager: SessionManager,
  runStore: {
    listSessionRuns(sessionId: string): Promise<readonly { status: string }[]>;
  },
  rootSessionId: string,
  hasLiveSessionState: (sessionId: string) => Promise<boolean>,
): Promise<boolean> {
  const pending = [rootSessionId];
  const seen = new Set(pending);
  while (pending.length > 0) {
    const parentSessionId = pending.shift()!;
    const children = await manager.listChildSessions(parentSessionId);
    for (const child of children) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      pending.push(child.id);
      const [runs, liveState] = await Promise.all([
        runStore.listSessionRuns(child.id),
        hasLiveSessionState(child.id),
      ]);
      if (liveState) return true;
      if (
        runs.some(
          (run) =>
            run.status === 'created' ||
            run.status === 'running' ||
            run.status === 'waiting_for_user',
        )
      ) {
        return true;
      }
    }
  }
  return false;
}
