import { createHash, randomUUID } from 'node:crypto';
import { generalizedErrorMessage } from '@maka/core/redaction';
import { emptyPlanSessionState } from '@maka/core/plan';
import type { PermissionMode } from '@maka/core/permission';
import { isDeepResearchSession } from '@maka/core/session';
import { filterModelVisibleTaskLedgerTasks } from '@maka/core/task-ledger';
import { AgentGraphCoordinator } from '@maka/runtime/stream-graph-coordinator';
import { AgentGraphSupervisorWakeCoordinator } from '@maka/runtime/agent-graph-supervisor-wake';
import {
  BackendRegistry,
  SessionManager,
  type BackendFactory,
} from '@maka/runtime/session-manager';
import { buildToolsForAgentDefinition } from '@maka/runtime/agent-catalog';
import { buildHostCapabilitiesFromBinding } from '@maka/runtime/tool-catalog-derive';
import { createLocalContinuationSafetyInspector } from '@maka/runtime/continuation-safety';
import { createConfiguredSubagentCatalog } from '@maka/runtime/configured-subagent-catalog';
import {
  createBuiltinSandboxManager,
  isBuiltinFilesystemWorkerSandboxAvailable,
} from '@maka/runtime/sandbox';
import {
  createFilesystemWorkerLaunchSpecProvider,
  FilesystemWorkerClient,
} from '@maka/runtime/filesystem-worker';
import { FakeBackend } from '@maka/runtime/fake-backend';
import { isOAuthEnrollmentProviderEnabled } from '@maka/runtime/oauth-provider-contracts';
import {
  loadHistoryCompactCheckpointsFromRunLedger,
  loadLatestHistoryCompactCheckpointFromRunLedger,
} from '@maka/runtime/history-compact-ledger';
import { prepareSkillInvocationMessageFromInventory } from '@maka/runtime/skill-invocation';
import { RuntimeReadModel } from '@maka/runtime/runtime-read-model';
import { routeWebSearchTools } from '@maka/runtime/native-web-search-tool';
import {
  renderAgentSwarmSupervisorWake,
  shouldWakeAgentSwarmSupervisor,
} from '@maka/runtime/agent-swarm-status-tool';
import { SessionActivityRegistry } from '@maka/runtime/goal-turn-lifecycle';
import { ShellRunProcessManager } from '@maka/runtime/shell-run-manager';
import { type MakaTool } from '@maka/runtime/tool-runtime';
import { type RuntimeHostedRootAuthority } from '@maka/runtime/message-authority';
import {
  openInteractiveProjectCatalogForWrite,
  type InteractiveProjectCatalogWriter,
} from '@maka/storage';
import { createAgentGraphControlStore } from '@maka/storage/agent-graph-control-store';
import {
  createArtifactAttachmentResourceReader,
  createReadImageSnapshotter,
  openInteractiveArtifactStoreForWrite,
} from '@maka/storage/artifact-stores';
import { openInteractiveScheduledTaskStoreForWrite } from '@maka/storage/scheduled-task-store';
import { openInteractiveDeepResearchStoreForWrite } from '@maka/storage/deep-research-authority';
import { openInteractiveDailyReviewAuthorityForWrite } from '@maka/storage/daily-review-authority';
import { openInteractiveGoalAuthorityForWrite } from '@maka/storage/goal-authority';
import { openInteractivePlanStoreForWrite } from '@maka/storage/plan-authority';
import {
  isSessionNotFoundError,
  openInteractiveExecutionStoresForWrite,
} from '@maka/storage/execution-stores';
import { createExternalSessionAdapterRegistry } from '@maka/storage/external-sessions';
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
import { HostAgentGraphExecutionCoordinator } from './agent-graph-execution-coordinator.js';
import { HostScheduledTaskCoordinator } from './scheduled-task-coordinator.js';
import { recoverClientCapabilityOutcomes } from './client-capability-recovery.js';
import { HostConnectionEffectCoordinator } from './connection-effect-coordinator.js';
import { HostConfigurationChangeService } from './configuration-change-service.js';
import { HostSessionCatalogChangeService } from './session-catalog-change-service.js';
import { HostScheduledTaskChangeService } from './scheduled-task-change-service.js';
import { HostConfigurationCoordinator } from './configuration-coordinator.js';
import { HostContextCoordinator } from './context-coordinator.js';
import { HostClientCapabilityCoordinator } from './client-capability-coordinator.js';
import { HostDeepResearchCoordinator } from './deep-research-coordinator.js';
import { HostDailyReviewCoordinator } from './daily-review-coordinator.js';
import { createHostAiSdkBackend } from './execution-model-composition.js';
import {
  createInteractiveRunComposer,
  createInteractiveRunComposerFactory,
} from './interactive-run-composer.js';
import {
  createHostGoalEvaluator,
  createHostDailyReviewModel,
  createHostMemoryExtractionModel,
  createHostSessionEffectModel,
} from './execution-model-authority.js';
import { HostExecutionInspectCoordinator } from './execution-inspect-coordinator.js';
import { HostExternalSessionCoordinator } from './external-session-coordinator.js';
import { HostGoalCoordinator } from './goal-coordinator.js';
import { HostGoalExecutionCoordinator } from './goal-execution-coordinator.js';
import { HostHostedExecutionCoordinator } from './hosted-execution-coordinator.js';
import { HostHostedExecutionRunner } from './hosted-execution-runner.js';
import { executeHostedExecutionToSettlement } from './hosted-execution-wait.js';
import type { RuntimeHostComposition, RuntimeHostCompositionContext } from './host-kernel.js';
import {
  beginRuntimeHostDomainModuleDrain,
  closeRuntimeHostDomainModules,
  composeRuntimeHostDomainHandlers,
  createRuntimeHostDomainModule,
  recoverRuntimeHostDomainModules,
  type RuntimeHostDomainModule,
} from './host-composition.js';
import { HostInteractionCoordinator } from './interaction-coordinator.js';
import { HostInteractiveTurnCoordinator } from './interactive-turn-coordinator.js';
import { ensureBootstrapRuntimePolicy } from './bootstrap-runtime-policy.js';
import { hostedExecutionRunProfile } from './hosted-execution-tool-profile.js';
import { HostMemoryCoordinator } from './memory-coordinator.js';
import { HostMemoryExtractionCoordinator } from './memory-extraction-coordinator.js';
import { MemoryExtractionSessionLane } from './memory-extraction-session-lane.js';
import { type HostMessageRootPort, HostMessageCoordinator } from './message-coordinator.js';
import { HostNetworkProxyCoordinator } from './network-proxy-coordinator.js';
import { HostOAuthExecutionAuthority } from './oauth-execution-authority.js';
import { HostOAuthCoordinator, type HostOAuthCoordinatorInput } from './oauth-coordinator.js';
import { HostPlanCoordinator } from './plan-coordinator.js';
import { HostProjectCatalogChangeService } from './project-catalog-change-service.js';
import { HostProjectCatalogCoordinator } from './project-catalog-coordinator.js';
import { HostProjectMembershipGate } from './project-membership-gate.js';
import { RootAdmissionOwner } from './root-admission-owner.js';
import { RootTurnCoordinator } from './root-turn-coordinator.js';
import { RuntimePolicyActivationGate } from './runtime-policy-activation-gate.js';
import { notifySandboxBoundaryGraphWake } from './sandbox-boundary-graph-wake.js';
import { HostRuntimePolicyCoordinator } from './runtime-policy-coordinator.js';
import { HostRuntimeResourceCoordinator } from './runtime-resource-coordinator.js';
import { SessionAdmissionGate } from './session-admission-gate.js';
import { HostSessionCatalogCoordinator } from './session-catalog-coordinator.js';
import { HostWorkspaceResolver } from './workspace-resolver.js';
import { HostSessionRetirementCoordinator } from './session-retirement-coordinator.js';
import { HostSessionRevisionCoordinator } from './session-revision-coordinator.js';
import { HostSessionEffectCoordinator } from './session-effect-coordinator.js';
import { SessionContinuityCoordinator } from './session-continuity-coordinator.js';
import { createSessionTranscriptReader } from './session-transcript-reader.js';
import { HostSkillCatalogCoordinator } from './skill-catalog-coordinator.js';
import { SkillCatalogRepository } from './skill-catalog-repository.js';
import { HostTaskLedgerCoordinator } from './task-ledger-coordinator.js';
import { HostTurnControlCoordinator } from './turn-control-coordinator.js';
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
  readonly bootstrapRuntimePolicy?: boolean;
  readonly skillHomeDirectory?: string;
}

export interface ExecutionRuntimeHostCompositionDependencies {
  readonly primaryBackendFactory?: BackendFactory;
  readonly oauthAuthorization?: Pick<
    HostOAuthCoordinatorInput,
    'startCodexAuthorization' | 'pollCodexAuthorization' | 'exchangeCodexCode'
  >;
}

export function runtimeHostFilesystemWorkerRuntime(versions: {
  readonly electron?: string;
}): 'electron' | 'node' {
  return versions.electron ? 'electron' : 'node';
}

export async function createExecutionRuntimeHostComposition(
  context: RuntimeHostCompositionContext,
  options: CreateExecutionRuntimeHostCompositionOptions = {},
  dependencies: ExecutionRuntimeHostCompositionDependencies = {},
): Promise<ExecutionRuntimeHostComposition> {
  const stores = await openInteractiveExecutionStoresForWrite(context.owner.lease);
  await stores.sessionStore.ready();
  let graphControlStore: ReturnType<typeof createAgentGraphControlStore> | undefined;
  let taskLedgerStore:
    | Awaited<ReturnType<typeof openInteractiveTaskLedgerStoreForWrite>>
    | undefined;
  let usageStores: Awaited<ReturnType<typeof openInteractiveUsageStoresForWrite>> | undefined;
  let artifactStore: Awaited<ReturnType<typeof openInteractiveArtifactStoreForWrite>> | undefined;
  let shellRunStore: Awaited<ReturnType<typeof openInteractiveShellRunStoreForWrite>> | undefined;
  let longTermMemoryStore: InteractiveLongTermMemoryWriter | undefined;
  let scheduledTaskStore:
    | Awaited<ReturnType<typeof openInteractiveScheduledTaskStoreForWrite>>
    | undefined;
  let planStore: Awaited<ReturnType<typeof openInteractivePlanStoreForWrite>> | undefined;
  let deepResearchStore:
    | Awaited<ReturnType<typeof openInteractiveDeepResearchStoreForWrite>>
    | undefined;
  let dailyReviewStore:
    | Awaited<ReturnType<typeof openInteractiveDailyReviewAuthorityForWrite>>
    | undefined;
  let goalStore: Awaited<ReturnType<typeof openInteractiveGoalAuthorityForWrite>> | undefined;
  let graphClient: HostAgentGraphCoordinator | undefined;
  let sessionEffects: HostSessionEffectCoordinator | undefined;
  let memoryExtraction: HostMemoryExtractionCoordinator | undefined;
  let unsubscribeTaskLedger: (() => void) | undefined;
  let unsubscribeTranscriptChanges: (() => void) | undefined;
  let managedWorkspaceOwner: ManagedWorkspaceOwner | undefined;
  let workspaceExecution: RuntimeHostWorkspaceExecutionComposition | undefined;
  let projectCatalog: InteractiveProjectCatalogWriter | undefined;
  let goalExecutions: HostGoalExecutionCoordinator | undefined;
  try {
    const openedProjectCatalog = await openInteractiveProjectCatalogForWrite(context.owner.lease);
    projectCatalog = openedProjectCatalog;
    const runtimePolicyStores = await openInteractiveRuntimePolicyStoresForWrite(
      context.owner.lease,
    );
    if (options.bootstrapRuntimePolicy !== false) {
      await ensureBootstrapRuntimePolicy({
        workspaceRoot: context.owner.capability.canonicalPath,
        stores: runtimePolicyStores,
        onDeferredError: (error) =>
          console.error(
            `[runtime-host] optional bootstrap target could not be configured: ${generalizedErrorMessage(error)}`,
          ),
      });
    }
    const oauthCredentials = new HostOAuthExecutionAuthority(runtimePolicyStores);
    const openedScheduledTaskStore = await openInteractiveScheduledTaskStoreForWrite(
      context.owner.lease,
    );
    scheduledTaskStore = openedScheduledTaskStore;
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
    const openedGoalStore = await openInteractiveGoalAuthorityForWrite(context.owner.lease);
    goalStore = openedGoalStore;
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
    const runtimePolicy = new HostRuntimePolicyCoordinator(
      runtimePolicyStores,
      runtimePolicyActivation,
      applyRuntimePolicyMutationEffects,
    );
    const sessionAdmission = new SessionAdmissionGate();
    const memoryExtractionLane = new MemoryExtractionSessionLane();
    let runtimeResources: HostRuntimeResourceCoordinator | undefined;
    let continuity: SessionContinuityCoordinator | undefined;
    let manager: SessionManager | undefined;
    let graphCoordinator: AgentGraphCoordinator | undefined;
    let graphSupervisorWake: AgentGraphSupervisorWakeCoordinator | undefined;
    const graphWakeActivities = new SessionActivityRegistry();
    const shellRuns = new ShellRunProcessManager({
      store: openedShellRunStore,
      newId: randomUUID,
      now: Date.now,
      onShellRunUpdate: (update) => runtimeResources?.observeShellRunUpdate(update),
      onPtyData: (event) => {
        void continuity?.enqueueRuntimeResourcePtyData(event);
      },
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
      acquireResidency: () => context.acquireResidency('runtime-resource'),
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
      ...runtimePolicy.modelTools,
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
    let resolveAvailableToolNames: ((sessionId: string) => Promise<string[]>) | undefined;
    let resolveNewSessionToolNames:
      | ((
          previewSessionId: string,
          collaborationMode: 'agent' | 'plan',
          permissionMode: PermissionMode,
          initiatingConnectionId: string,
        ) => Promise<string[]>)
      | undefined;
    const configurationChanges = new HostConfigurationChangeService();
    const sessionCatalogChanges = new HostSessionCatalogChangeService();
    const scheduledTaskChanges = new HostScheduledTaskChangeService();
    const projectCatalogChanges = new HostProjectCatalogChangeService();
    const projectMembership = new HostProjectMembershipGate();
    const workspaceResolver = new HostWorkspaceResolver(
      openedProjectCatalog,
      projectMembership,
      () => projectCatalogChanges.publish(),
    );
    const skills = new HostSkillCatalogCoordinator(
      new SkillCatalogRepository({
        runWithRoot: (operation) =>
          runWithStorageRootLease(context.owner.lease, 'interactive', 'write', operation),
        ...(options.skillHomeDirectory ? { homeDirectory: options.skillHomeDirectory } : {}),
      }),
      workspaceResolver,
      async (input, connection) => {
        if (input.target.kind === 'session') {
          const sessionId = input.target.sessionId;
          const header = await stores.sessionStore.readHeaderSnapshot(sessionId);
          const preview = await requireClientCapabilities(
            clientCapabilities,
          ).runWithSessionBindingPreview(sessionId, connection.connectionId, () =>
            requireToolNameResolver(resolveAvailableToolNames)(sessionId),
          );
          if (!preview.ok) throw new Error(preview.message);
          return {
            projectRoot: header.cwd,
            host: buildHostCapabilitiesFromBinding(preview.value),
          };
        }
        const previewSessionId = `skill-catalog-preview:${connection.connectionId}`;
        return {
          projectRoot: (await workspaceResolver.resolve(input.target.context.workspace)).cwd,
          host: buildHostCapabilitiesFromBinding(
            await requireNewSessionToolNameResolver(resolveNewSessionToolNames)(
              previewSessionId,
              input.target.collaborationMode,
              input.target.permissionMode,
              connection.connectionId,
            ),
          ),
        };
      },
    );
    const projects = new HostProjectCatalogCoordinator(
      openedProjectCatalog,
      projectCatalogChanges,
      sessionCatalogChanges,
      projectMembership,
      context.requestDrain,
    );
    let rootCoordinator: RootTurnCoordinator | undefined;
    let canonicalProjection: CanonicalSessionProjectionReader | undefined;
    let memory: HostMemoryCoordinator | undefined;
    let clientCapabilities: HostClientCapabilityCoordinator | undefined;
    let oauth: HostOAuthCoordinator | undefined;
    let scheduledTasks: HostScheduledTaskCoordinator | undefined;
    let scheduledTaskTool: MakaTool | undefined;
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
      acquireResidency: () => context.acquireResidency('message-queue'),
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
      (sessionId) => sessionCatalogChanges.publish(sessionId),
    );
    const continuityCoordinator = continuity;
    unsubscribeTranscriptChanges = stores.sessionStore.subscribeTranscriptChanges((sessionId) =>
      continuityCoordinator.enqueueCanonicalRefresh(sessionId),
    );
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
      acquireResidency: () => context.acquireResidency('daily-review'),
      requestDrain: context.requestDrain,
    });
    let poisonFailure: Error | undefined;
    let draining = false;
    let recoveryTask: Promise<void> | undefined;
    let rootCloseTask: Promise<void> | undefined;
    let rootRecoveryCompleted = false;
    let closeTask: Promise<void> | undefined;
    let backendInvalidationPoisoned = false;
    let domainModules: readonly RuntimeHostDomainModule[] | undefined;
    let domainModuleDrainBegun = false;
    const beginDrain = () => {
      draining = true;
      if (!domainModules || domainModuleDrainBegun) return;
      domainModuleDrainBegun = true;
      beginRuntimeHostDomainModuleDrain(domainModules);
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
        notifySandboxBoundaryGraphWake(
          sessionId,
          stores.sessionStore,
          {
            listGraphIds: (rootSessionId) =>
              requireGraphCoordinator(graphCoordinator).listGraphIds(rootSessionId),
          },
          (rootSessionId) =>
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
        readCheckpoints: (sessionId) =>
          loadHistoryCompactCheckpointsFromRunLedger(stores.agentRunStore, sessionId),
      },
      model: createHostMemoryExtractionModel({
        runtimePolicy: runtimePolicyStores,
        oauthCredentials,
        claudeDeviceId: context.owner.capability.rootId,
        usage: openedUsageStores,
        requestDrain: context.requestDrain,
      }),
      lane: memoryExtractionLane,
      acquireResidency: () => context.acquireResidency('memory-extraction'),
    });
    backends.register(
      'ai-sdk',
      dependencies.primaryBackendFactory ??
        ((backendContext) =>
          createHostAiSdkBackend({
            context: backendContext,
            runtimePolicy: runtimePolicyStores,
            oauthCredentials,
            claudeDeviceId: context.owner.capability.rootId,
            createRunComposer: createInteractiveRunComposerFactory({
              skills,
              memory: requireMemory(memory),
              taskLedger,
              clientCapabilities: requireClientCapabilities(clientCapabilities),
              ...(scheduledTaskTool ? { scheduledTaskTool } : {}),
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
            }),
            ...(hostedExecutionRunProfile(backendContext.header.toolProfile)?.memoryExtraction ===
            false
              ? {}
              : { memoryExtraction }),
            artifacts: openedArtifactStore,
            executionArtifacts,
            usage: openedUsageStores,
            childAgents: bindHostChildAgentBackend(
              requireSessionManager(manager),
              backendContext.sessionId,
            ),
            runtimeCommitSink: stores.runtimeEventStore,
            requestDrain: context.requestDrain,
          })),
    );
    const runtimeAuthority: RuntimeHostedRootAuthority = {
      bindRun: (identity) => messages.bindRun(identity),
      executeRoot: (input) =>
        executeHostedExecutionToSettlement(requireRootCoordinator(rootCoordinator), input),
      stopRoot: (identity, input) =>
        requireRootCoordinator(rootCoordinator).stopRoot(identity, input),
      stopSession: (sessionId, input) =>
        requireRootCoordinator(rootCoordinator).stopSession(sessionId, input),
    };
    resolveAvailableToolNames = async (sessionId: string): Promise<string[]> => {
      const header = await stores.sessionStore.readHeaderSnapshot(sessionId);
      if (header.subagentRuntime) {
        if (!header.subagentParent) {
          throw new Error('Subagent runtime snapshot requires a linked child session');
        }
        const tools = buildToolsForAgentDefinition(childAgentTools.childTools, {
          id: header.subagentRuntime.agentId,
          permissionMode: header.permissionMode,
          tools: header.subagentRuntime.toolNames,
        });
        if (tools.length !== header.subagentRuntime.toolNames.length) {
          throw new Error('Subagent runtime tool snapshot is unavailable');
        }
        return tools.map((tool) => tool.name);
      }
      if (header.subagentParent) {
        throw new Error('Linked child session is missing its durable runtime snapshot');
      }
      const capabilitySnapshot =
        requireClientCapabilities(clientCapabilities).snapshotForSession(sessionId);
      try {
        const [graphTools, planState, runtimePolicySnapshot] = await Promise.all([
          requireGraphCoordinator(graphCoordinator).toolsForSession(sessionId),
          openedPlanStore.readState(sessionId),
          runtimePolicyStores.runtimePolicy.getSnapshot(),
        ]);
        const runProfile = hostedExecutionRunProfile(header.toolProfile);
        return createInteractiveRunComposer({
          runtimePolicy: runtimePolicySnapshot,
          skills,
          memory: requireMemory(memory),
          taskLedger,
          ...(runProfile
            ? {
                boundToolNames: runProfile.toolNames,
                toolProfile: header.toolProfile,
              }
            : {}),
          ...(capabilitySnapshot ? { clientCapabilities: capabilitySnapshot } : {}),
          builtinTools,
          hostTools: [...hostTools, ...graphTools],
          ...(scheduledTaskTool ? { scheduledTaskTool } : {}),
          goalTools: requireGoal(goal).tools,
          parentAgentTools: childAgentTools.parentTools,
          plan: {
            store: openedPlanStore,
            state: planState,
            mode: header.collaborationMode ?? 'agent',
            permissionMode: header.permissionMode,
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
    resolveNewSessionToolNames = async (
      previewSessionId,
      collaborationMode,
      permissionMode,
      initiatingConnectionId,
    ) => {
      const preview = await requireClientCapabilities(
        clientCapabilities,
      ).runWithSessionBindingPreview(previewSessionId, initiatingConnectionId, async () => {
        const capabilitySnapshot =
          requireClientCapabilities(clientCapabilities).snapshotForSession(previewSessionId);
        try {
          const runtimePolicySnapshot = await runtimePolicyStores.runtimePolicy.getSnapshot();
          return createInteractiveRunComposer({
            runtimePolicy: runtimePolicySnapshot,
            skills,
            memory: requireMemory(memory),
            taskLedger,
            ...(capabilitySnapshot ? { clientCapabilities: capabilitySnapshot } : {}),
            builtinTools,
            hostTools,
            ...(scheduledTaskTool ? { scheduledTaskTool } : {}),
            goalTools: requireGoal(goal).tools,
            parentAgentTools: childAgentTools.parentTools,
            plan: {
              store: openedPlanStore,
              state: emptyPlanSessionState(previewSessionId),
              mode: collaborationMode,
              permissionMode,
            },
          }).tools.map((tool) => tool.name);
        } finally {
          capabilitySnapshot?.release();
        }
      });
      if (!preview.ok) throw new Error(preview.message);
      return preview.value;
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
      acquireResidency: () => context.acquireResidency('session-effect'),
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
    const subagentCatalog = createConfiguredSubagentCatalog({
      getPresets: async () =>
        (await runtimePolicyStores.runtimePolicy.getSnapshot()).policy.subagents.presets,
      getConnection: async (slug) =>
        (await runtimePolicyStores.connectionCatalog.getSnapshot()).connections.find(
          (connection) => connection.slug === slug,
        ) ?? null,
    });
    manager = new SessionManager({
      store: stores.sessionStore,
      runStore: stores.agentRunStore,
      runtimeEventStore: stores.runtimeEventStore,
      toolBoundaryProtocol: stores.runtimeEventStore.toolBoundaryProtocol,
      backends,
      subagentCatalog,
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
      epochStore: openedGraphControlStore,
      runtime: manager,
      newId: randomUUID,
      acquireResidency: () => context.acquireResidency('agent-graph'),
      onReconciliation: (rootSessionId, result) => {
        void requireGraphSupervisorWake(graphSupervisorWake).notify(rootSessionId, result);
      },
      onCheckpoint: (rootSessionId) => {
        void requireGraphSupervisorWake(graphSupervisorWake).notify(rootSessionId);
      },
    });
    graphClient = new HostAgentGraphCoordinator({
      authority: graphCoordinator,
      continuity: continuityCoordinator,
      stopExecution: (rootSessionId) =>
        requireGraphCoordinator(graphCoordinator).stopExecution(rootSessionId, {
          stopSupervisor: () =>
            requireRootCoordinator(rootCoordinator).stopAgentGraphSupervisor(rootSessionId, {
              source: 'stop_button',
            }),
          withSupervisorWakesSuppressed: (operation) =>
            requireGraphSupervisorWake(graphSupervisorWake).runWithSessionWakesSuppressed(
              rootSessionId,
              operation,
            ),
        }),
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
    const registerConfigurationMutation = (): void => {
      configurationChanges.publish();
      registerBackendInvalidation();
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
      acquireResidency: () => context.acquireResidency('oauth'),
      invalidateBackends: () => {
        configurationChanges.publish();
        return manager.refreshIdleBackends();
      },
      onFatal: (error) => {
        if (poisonFailure) return;
        poisonFailure = error;
        runtimePolicyActivation.poison();
        context.retainUntilProcessExit();
        beginDrain();
        context.requestDrain();
      },
      ...dependencies.oauthAuthorization,
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
      () => context.acquireResidency('hosted-execution'),
      context.requestDrain,
      clientCapabilities,
      () => requireGoal(goal),
      (admission) => requireScheduledTasks(scheduledTasks).assertRecoveryAdmission(admission),
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
      {
        currentGraphId: (rootSessionId) =>
          requireGraphCoordinator(graphCoordinator).currentGraphId(rootSessionId),
        beginNextGraphEpoch: async (rootSessionId) =>
          (
            await requireGraphCoordinator(graphCoordinator).beginNextGraphEpoch(
              rootSessionId,
              (operation) =>
                requireGraphSupervisorWake(graphSupervisorWake).runWithSessionWakesSuppressed(
                  rootSessionId,
                  operation,
                  'agent_graph_epoch_advanced',
                ),
            )
          ).graphId,
      },
    );
    const coordinator = rootCoordinator;
    const contextOperations = new HostContextCoordinator({
      runtime: manager,
      executions: coordinator,
      sessions: stores.sessionStore,
      requestDrain: context.requestDrain,
    });
    const turnControl = new HostTurnControlCoordinator({
      executions: coordinator,
      sessionAdmission,
    });
    const interactiveTurns = new HostInteractiveTurnCoordinator({
      executions: coordinator,
      turns: stores.agentRunStore,
      runtime: manager,
    });
    const graphExecutions = new HostAgentGraphExecutionCoordinator({
      executions: coordinator,
      runtime: manager,
      currentGraphId: (rootSessionId) =>
        requireGraphCoordinator(graphCoordinator).currentGraphId(rootSessionId),
    });
    graphSupervisorWake = new AgentGraphSupervisorWakeCoordinator({
      activityRegistry: graphWakeActivities,
      wakeStore: openedGraphControlStore,
      readSnapshot: (rootSessionId) =>
        requireGraphCoordinator(graphCoordinator).getSnapshot(rootSessionId),
      startTurn: (sessionId, input, _activity, abortSignal, isCurrent) =>
        graphExecutions.run(sessionId, input, abortSignal, isCurrent),
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
        graphExecutions.recoverContextOverflow(rootSessionId, randomUUID(), abortSignal),
      shouldWake: shouldWakeAgentSwarmSupervisor,
      renderWake: renderAgentSwarmSupervisorWake,
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
      acquireResidency: () => context.acquireResidency('agent-graph-supervisor'),
      onError: () => context.requestDrain(),
    });
    const goalExecutionCoordinator = new HostGoalExecutionCoordinator({
      executions: coordinator,
      runtime: manager,
      matchesActive: (sessionId, checkpoint, controlLease) =>
        requireGoal(goal).matchesActive(sessionId, checkpoint, controlLease),
    });
    goalExecutions = goalExecutionCoordinator;
    goal = new HostGoalCoordinator({
      store: openedGoalStore,
      stores,
      executions: coordinator,
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
        goalExecutionCoordinator.admitTurn(sessionId, text, checkpoint, controlLease),
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
      acquireResidency: () => context.acquireResidency('goal'),
      onProjectionChanged: (sessionId) => continuityCoordinator.enqueueCanonicalRefresh(sessionId),
      requestDrain: context.requestDrain,
    });
    async function applyRuntimePolicyMutationEffects(): Promise<void> {
      try {
        await requireMemory(memory).refreshAfterPolicyMutation();
      } catch (error) {
        context.requestDrain();
        throw error;
      }
      registerConfigurationMutation();
    }
    const connectionEffects = new HostConnectionEffectCoordinator({
      stores: runtimePolicyStores,
      activation: runtimePolicyActivation,
      oauthCredentials,
      onCommittedMutation: registerConfigurationMutation,
    });
    const sessionCatalog = new HostSessionCatalogCoordinator({
      stores: stores.sessionStore,
      runtimePolicy: runtimePolicyStores,
      manager,
      admission: sessionAdmission,
      continuity: continuityCoordinator,
      workspaceResolver,
      requestDrain: context.requestDrain,
    });
    scheduledTasks = new HostScheduledTaskCoordinator({
      store: openedScheduledTaskStore,
      sessions: stores.sessionStore,
      runtime: manager,
      root: coordinator,
      runtimePolicy: runtimePolicyStores,
      nativeEffects: clientCapabilities,
      createSession: (input) => sessionCatalog.createForHost(input),
      changes: scheduledTaskChanges,
      acquireResidency: () => context.acquireResidency('scheduled-task'),
      requestDrain: context.requestDrain,
    });
    scheduledTaskTool = scheduledTasks.modelTool;
    const externalSessions = new HostExternalSessionCoordinator({
      adapters: createExternalSessionAdapterRegistry(),
      admission: sessionAdmission,
      sessions: stores.sessionStore,
      workspaceResolver,
      resolveTarget: () => sessionCatalog.resolveExternalSessionImportTarget(),
      prepareImportedSessionHistory: (sessionId) =>
        requireSessionManager(manager).prepareImportedSessionHistory(sessionId),
      discardImportedSession: async (sessionId) => {
        const outcomes = await Promise.allSettled([
          stores.purgeConversationOperationalState(sessionId),
          stores.sessionStore.remove(sessionId),
        ]);
        for (const outcome of outcomes) {
          if (outcome.status === 'rejected') throw outcome.reason;
        }
      },
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
      scheduledTasks,
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
        for (const graphId of await requireGraphCoordinator(graphCoordinator).listGraphIds(
          sessionId,
        )) {
          await openedGraphControlStore.purgeAgentGraphControlState(graphId);
        }
        await openedGraphControlStore.purgeAgentGraphEpochs(sessionId);
      },
      worktrees: worktreeChildExecutor,
      requestDrain: context.requestDrain,
      memoryExtractionLane,
    });
    const hostedExecutionRunner = new HostHostedExecutionRunner({
      handlers: {
        'session.create': sessionCatalog.handlers['session.create'],
        'turn.start': interactiveTurns.handlers['turn.start'],
        'turn.query': turnControl.handlers['turn.query'],
        'turn.stop': turnControl.handlers['turn.stop'],
        'usage.query': usagePricing.handlers['usage.query'],
      },
      context: {
        hostEpoch: context.hostEpoch,
        connectionId: 'hosted-execution',
        surface: 'run',
        principal: 'runtime_host',
        acquireResidency: () => context.acquireResidency('hosted-execution'),
      },
      requestDrain: context.requestDrain,
      waitForExecutionResidencies: () => {
        if (!context.waitForResidenciesExcept) {
          throw new Error('Runtime Host execution settlement barrier is unavailable');
        }
        return context.waitForResidenciesExcept('runtime-resource');
      },
      waitForAllResidencies: () => {
        if (!context.waitForResidencies) {
          throw new Error('Runtime Host complete settlement barrier is unavailable');
        }
        return context.waitForResidencies();
      },
    });
    const hostedExecutions = new HostHostedExecutionCoordinator(
      (input, signal) => hostedExecutionRunner.run(input, signal),
      context.requestDrain,
    );
    let recoverySessions: Awaited<ReturnType<typeof stores.sessionStore.listForRecovery>> = [];
    domainModules = [
      createRuntimeHostDomainModule({
        id: 'memory',
        handlers: [requireMemory(memory).handlers],
        recovery: {
          state: () => requireMemory(memory).recover(),
        },
        drain: [() => memoryExtraction?.beginDrain(), () => memory?.beginDrain()],
        close: [
          () => memoryExtraction?.close(),
          () => memory?.close(),
          () => longTermMemoryStore?.close(),
        ],
        releaseConnection: [
          (connectionId) => requireMemory(memory).releaseConnection(connectionId),
        ],
      }),
      createRuntimeHostDomainModule({
        id: 'plan',
        handlers: [plans.handlers],
        close: [() => openedPlanStore.close()],
      }),
      createRuntimeHostDomainModule({
        id: 'project-catalog',
        handlers: [projects.handlers],
        close: [() => openedProjectCatalog.close()],
      }),
      createRuntimeHostDomainModule({
        id: 'session',
        handlers: [sessionCatalog.handlers, externalSessions.handlers, sessionRevisions.handlers],
        recovery: {
          state: () => externalSessions.recover(),
          resources: async () => {
            recoverySessions = await stores.sessionStore.listForRecovery();
            await worktreeChildExecutor.recover(
              recoverySessions.flatMap((session) =>
                session.subagentWorkspace ? [session.subagentWorkspace] : [],
              ),
            );
            await sessionRevisions.recover();
            for (const session of recoverySessions) {
              await stores.runtimeEventStore.repairImmutableSteeringMessageProofsForRecovery(
                session.id,
              );
            }
          },
        },
        close: [() => stores.sessionStore.close?.()],
      }),
      createRuntimeHostDomainModule({
        id: 'configuration',
        handlers: [
          runtimePolicy.handlers,
          connectionEffects.handlers,
          taskLedger.handlers,
          artifacts.handlers,
          skills.handlers,
          usagePricing.handlers,
          oauth.handlers,
          webSearch.handlers,
          networkProxy.handlers,
          configuration.handlers,
        ],
        recovery: {
          state: async () => {
            await skills.recover();
            await openedArtifactStore.recover();
          },
        },
        drain: [
          () => connectionEffects.beginDrain(),
          () => skills.beginDrain(),
          () => oauth?.beginDrain(),
        ],
        close: [
          () => connectionEffects.close(),
          () => (backendInvalidationPoisoned ? undefined : manager.refreshIdleBackends()),
          () => skills.close(),
          () => oauth?.close(),
          () => openedUsageStores.close(),
          () => openedArtifactStore.close(),
          () => {
            unsubscribeTranscriptChanges?.();
            unsubscribeTaskLedger?.();
            taskLedgerStore?.close();
          },
          () => shellRunStore?.close(),
        ],
        releaseConnection: [(connectionId) => artifacts.releaseConnection(connectionId)],
      }),
      createRuntimeHostDomainModule({
        id: 'client-capability',
        handlers: [clientCapabilities.handlers],
        recovery: {
          resources: async () => {
            await recoverClientCapabilityOutcomes(
              stores.runtimeEventStore,
              recoverySessions.map((session) => session.id),
            );
          },
        },
        drain: [() => clientCapabilities.beginDrain()],
        close: [() => clientCapabilities.close()],
      }),
      createRuntimeHostDomainModule({
        id: 'deep-research',
        handlers: [requireDeepResearch(deepResearch).handlers],
        close: [() => deepResearch?.close(), () => openedDeepResearchStore.close()],
      }),
      createRuntimeHostDomainModule({
        id: 'daily-review',
        handlers: [requireDailyReview(dailyReview).handlers],
        recovery: {
          domains: () => requireDailyReview(dailyReview).prepareRecovery(),
          schedulers: () => requireDailyReview(dailyReview).start(),
        },
        drain: [() => dailyReview?.beginDrain()],
        close: [() => requireDailyReview(dailyReview).close()],
      }),
      createRuntimeHostDomainModule({
        id: 'scheduled-task',
        handlers: [requireScheduledTasks(scheduledTasks).handlers],
        recovery: {
          executions: () => requireScheduledTasks(scheduledTasks).prepareRecovery(),
          domains: () => requireScheduledTasks(scheduledTasks).recover(),
          schedulers: () => requireScheduledTasks(scheduledTasks).start(),
        },
        drain: [() => scheduledTasks?.beginDrain()],
        close: [() => scheduledTasks?.close()],
      }),
      createRuntimeHostDomainModule({
        id: 'execution',
        handlers: [
          executionInspect.handlers,
          messages.handlers,
          interactions.handlers,
          sessionEffectCoordinator.handlers,
          continuityCoordinator.handlers,
          runtimeResources.handlers,
          contextOperations.handlers,
          coordinator.handlers,
          turnControl.handlers,
          interactiveTurns.handlers,
        ],
        recovery: {
          executions: async () => {
            await coordinator.prepareRecovery();
            await interactions.recoverPendingAfterHostRestart();
            await manager.recoverInterruptedSessionsStrict(stores);
            await manager.recoverChildWorkspacePatches(
              recoverySessions.flatMap((session) =>
                session.subagentWorkspace ? [session.id] : [],
              ),
            );
            await coordinator.recover();
            rootRecoveryCompleted = true;
          },
        },
        drain: [
          () => rootCoordinator?.beginDrain(),
          () => workspaceExecution?.beginDrain(),
          () => runtimeResources?.beginDrain(),
          () => messages.beginDrain(),
          () => interactions.beginDrain(),
          () => sessionEffects?.beginDrain(),
        ],
        close: [
          async () => {
            if (!rootRecoveryCompleted || poisonFailure) return;
            rootCloseTask ??= coordinator.close();
            await rootCloseTask;
          },
          () => runtimeResources?.close(),
          () => workspaceExecution?.close(),
          () => sessionEffects?.close(),
          () => messages.close(),
          () => interactions.close(),
          () => continuityCoordinator.close(),
        ],
        releaseConnection: [(connectionId) => runtimeResources?.releaseConnection(connectionId)],
      }),
      createRuntimeHostDomainModule({
        id: 'agent-graph',
        handlers: [requireGraphClient(graphClient).handlers],
        recovery: {
          domains: async () => {
            await requireGraphSupervisorWake(graphSupervisorWake).recover();
            await requireGraphCoordinator(graphCoordinator).recover();
          },
        },
        drain: [() => graphSupervisorWake?.beginDrain(), () => graphCoordinator?.beginDrain()],
        close: [
          () => graphSupervisorWake?.close(),
          () => graphClient?.close(),
          () => graphCoordinator?.close(),
          () => openedGraphControlStore.close(),
        ],
      }),
      createRuntimeHostDomainModule({
        id: 'goal',
        handlers: [requireGoal(goal).handlers],
        recovery: {
          state: () => requireGoal(goal).prepareRecovery(),
          domains: () => requireGoal(goal).recover(),
        },
        drain: [() => goalExecutions?.beginDrain(), () => goal?.beginDrain()],
        close: [() => requireGoal(goal).close(), () => openedGoalStore.close()],
      }),
      createRuntimeHostDomainModule({
        id: 'session-retirement',
        handlers: [sessionRetirement.handlers],
        recovery: {
          state: () => sessionRetirement.recover(),
        },
        close: [() => sessionRetirement.close()],
      }),
      createRuntimeHostDomainModule({
        id: 'hosted-execution',
        handlers: [hostedExecutions.handlers],
        drain: [() => hostedExecutions.beginDrain()],
        close: [() => hostedExecutions.close()],
      }),
    ];
    if (draining) beginDrain();
    const handlers = composeRuntimeHostDomainHandlers(domainModules);
    const recover = () => {
      recoveryTask ??= recoverRuntimeHostDomainModules(domainModules);
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
          await closeRuntimeHostDomainModules(domainModules);
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
      moduleIds: Object.freeze(domainModules.map(({ id }) => id)),
      workspaceExecution: requireWorkspaceExecution(workspaceExecution),
      continuity: continuityCoordinator,
      clientCapabilities,
      configurationChanges,
      projectCatalogChanges,
      sessionCatalogChanges,
      scheduledTaskChanges,
      releaseConnection: (connectionId: string) => {
        for (const module of domainModules) module.releaseConnection?.(connectionId);
      },
      beginDrain,
      recover,
      close,
    };
  } catch (error) {
    const errors: unknown[] = [error];
    goalExecutions?.beginDrain();
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
      unsubscribeTranscriptChanges?.();
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
      scheduledTaskStore?.close();
    } catch (closeError) {
      errors.push(closeError);
    }
    try {
      await goalStore?.close();
    } catch (closeError) {
      errors.push(closeError);
    }
    try {
      planStore?.close();
    } catch (closeError) {
      errors.push(closeError);
    }
    try {
      projectCatalog?.close();
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

function requireToolNameResolver(
  resolver: ((sessionId: string) => Promise<string[]>) | undefined,
): (sessionId: string) => Promise<string[]> {
  if (!resolver) throw new Error('Runtime Host Session tool resolver is not composed');
  return resolver;
}

function requireNewSessionToolNameResolver(
  resolver:
    | ((
        previewSessionId: string,
        collaborationMode: 'agent' | 'plan',
        permissionMode: PermissionMode,
        initiatingConnectionId: string,
      ) => Promise<string[]>)
    | undefined,
): (
  previewSessionId: string,
  collaborationMode: 'agent' | 'plan',
  permissionMode: PermissionMode,
  initiatingConnectionId: string,
) => Promise<string[]> {
  if (!resolver) throw new Error('Runtime Host new Session tool resolver is not composed');
  return resolver;
}

function requireScheduledTasks(
  coordinator: HostScheduledTaskCoordinator | undefined,
): HostScheduledTaskCoordinator {
  if (!coordinator) throw new Error('Runtime Host ScheduledTask coordinator is not composed');
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

function requireGraphClient(
  coordinator: HostAgentGraphCoordinator | undefined,
): HostAgentGraphCoordinator {
  if (!coordinator) throw new Error('Runtime Host Agent Graph client is not composed');
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
