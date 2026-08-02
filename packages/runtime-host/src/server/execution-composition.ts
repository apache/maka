import { createHash, randomUUID } from 'node:crypto';
import { filterModelVisibleTaskLedgerTasks } from '@maka/core/task-ledger';
import {
  AgentGraphCoordinator,
  BackendRegistry,
  createBuiltinSandboxManager,
  createFilesystemWorkerLaunchSpecProvider,
  FakeBackend,
  FilesystemWorkerClient,
  isOAuthEnrollmentProviderEnabled,
  isBuiltinFilesystemWorkerSandboxAvailable,
  SessionManager,
  ShellRunProcessManager,
  type RuntimeHostedRootAuthority,
} from '@maka/runtime';
import { createAgentGraphControlStore } from '@maka/storage/agent-graph-control-store';
import {
  createReadImageSnapshotter,
  openInteractiveArtifactStoreForWrite,
} from '@maka/storage/artifact-stores';
import { openInteractiveAutomationAuthorityForWrite } from '@maka/storage/automation-authority';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
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
import { CanonicalSessionProjectionReader } from './canonical-session-projection.js';
import {
  bindHostChildAgentBackend,
  createHostChildAgentToolComposition,
} from './child-agent-composition.js';
import { HostCanonicalPermissionOutcomeReader } from './canonical-permission-outcome-reader.js';
import { HostArtifactCoordinator } from './artifact-coordinator.js';
import { HostAutomationCoordinator } from './automation-coordinator.js';
import { recoverClientCapabilityOutcomes } from './client-capability-recovery.js';
import { HostConnectionEffectCoordinator } from './connection-effect-coordinator.js';
import { HostClientCapabilityCoordinator } from './client-capability-coordinator.js';
import { createHostAiSdkBackend, createHostGoalEvaluator } from './execution-model-composition.js';
import { HostExecutionInspectCoordinator } from './execution-inspect-coordinator.js';
import { HostGoalCoordinator } from './goal-coordinator.js';
import type { RuntimeHostComposition, RuntimeHostCompositionContext } from './host-kernel.js';
import { HostInteractionCoordinator } from './interaction-coordinator.js';
import { HostMemoryCoordinator } from './memory-coordinator.js';
import { type HostMessageRootPort, HostMessageCoordinator } from './message-coordinator.js';
import { HostOAuthExecutionAuthority } from './oauth-execution-authority.js';
import { HostOAuthCoordinator } from './oauth-coordinator.js';
import type { DomainOperationHandlerMap } from './operation-dispatcher.js';
import { RootAdmissionOwner } from './root-admission-owner.js';
import { RootTurnCoordinator } from './root-turn-coordinator.js';
import { RuntimePolicyActivationGate } from './runtime-policy-activation-gate.js';
import { HostRuntimePolicyCoordinator } from './runtime-policy-coordinator.js';
import { HostRuntimeResourceCoordinator } from './runtime-resource-coordinator.js';
import { SessionAdmissionGate } from './session-admission-gate.js';
import { HostSessionCatalogCoordinator } from './session-catalog-coordinator.js';
import { HostSessionRetirementCoordinator } from './session-retirement-coordinator.js';
import { HostSessionRevisionCoordinator } from './session-revision-coordinator.js';
import { SessionContinuityCoordinator } from './session-continuity-coordinator.js';
import { HostSkillCatalogCoordinator } from './skill-catalog-coordinator.js';
import { SkillCatalogRepository } from './skill-catalog-repository.js';
import { HostTaskLedgerCoordinator } from './task-ledger-coordinator.js';
import { HostUsagePricingCoordinator } from './usage-pricing-coordinator.js';

export async function createExecutionRuntimeHostComposition(
  context: RuntimeHostCompositionContext,
): Promise<RuntimeHostComposition> {
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
  try {
    const runtimePolicyStores = await openInteractiveRuntimePolicyStoresForWrite(
      context.owner.lease,
    );
    const oauthCredentials = new HostOAuthExecutionAuthority(runtimePolicyStores);
    const openedAutomationStore = await openInteractiveAutomationAuthorityForWrite(
      context.owner.lease,
    );
    automationStore = openedAutomationStore;
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
    let runtimeResources: HostRuntimeResourceCoordinator | undefined;
    let manager: SessionManager | undefined;
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
            runtime: 'node',
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
      },
      sessionHeaders: stores.sessionStore,
      sessionAdmission,
      acquireResidency: context.acquireResidency,
      requestDrain: context.requestDrain,
    });
    const builtinTools = {
      shellRuns: runtimeResources,
      runtimeResources,
      backgroundTasks: runtimeResources,
      ptyControls: runtimeResources,
      snapshotImage: createReadImageSnapshotter(openedArtifactStore),
      ...(sandboxManager ? { sandboxManager } : {}),
      ...(filesystemWorker ? { filesystemWorker } : {}),
    };
    const childAgentTools = createHostChildAgentToolComposition({
      taskLedger,
      builtinTools,
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
    const rootPort: HostMessageRootPort = {
      readSessionHeader: (sessionId) =>
        requireRootCoordinator(rootCoordinator).readSessionHeader(sessionId),
      readRootState: (sessionId) =>
        requireRootCoordinator(rootCoordinator).readRootState(sessionId),
      claimStopFence: (input, commitQueueFence, admission) =>
        requireRootCoordinator(rootCoordinator).claimStopFence(input, commitQueueFence, admission),
      startFromMessage: (input, admission) =>
        requireRootCoordinator(rootCoordinator).startFromMessage(input, admission),
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
    continuity = new SessionContinuityCoordinator(
      context.hostEpoch,
      (sessionId) => canonicalProjectionReader.read(sessionId),
      sessionAdmission,
      context.requestDrain,
    );
    const continuityCoordinator = continuity;
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
      goal?.beginDrain();
      rootCoordinator?.beginDrain();
      runtimeResources?.beginDrain();
      automations?.beginDrain();
      messages.beginDrain();
      interactions.beginDrain();
      connectionEffects.beginDrain();
      skills.beginDrain();
      memory?.beginDrain();
      oauth?.beginDrain();
      clientCapabilities?.beginDrain();
    };
    const interactions = new HostInteractionCoordinator({
      store: stores.interactionStore,
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
    });
    const canonicalPermissionOutcomes = new HostCanonicalPermissionOutcomeReader({
      store: stores.interactionStore,
    });
    memory = new HostMemoryCoordinator({
      store: memoryStore,
      runtimePolicyStores,
      activation: runtimePolicyActivation,
      requestDrain: context.requestDrain,
    });
    backends.register('ai-sdk', (backendContext) =>
      createHostAiSdkBackend({
        context: backendContext,
        runtimePolicy: runtimePolicyStores,
        oauthCredentials,
        claudeDeviceId: context.owner.capability.rootId,
        skills,
        memory: requireMemory(memory),
        taskLedger,
        artifacts: openedArtifactStore,
        usage: openedUsageStores,
        clientCapabilities: requireClientCapabilities(clientCapabilities),
        automationTool: requireAutomationCoordinator(automations).modelTool,
        goalTools: requireGoal(goal).tools,
        builtinTools,
        parentAgentTools: childAgentTools.parentTools,
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
    manager = new SessionManager({
      store: stores.sessionStore,
      runStore: stores.agentRunStore,
      runtimeEventStore: stores.runtimeEventStore,
      toolBoundaryProtocol: stores.runtimeEventStore.toolBoundaryProtocol,
      backends,
      newId: randomUUID,
      now: Date.now,
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
      childTools: childAgentTools.childTools,
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
    const graphCoordinator = new AgentGraphCoordinator({
      sessionStore: stores.sessionStore,
      runStore: stores.agentRunStore,
      runtimeEventStore: stores.runtimeEventStore,
      controlStore: openedGraphControlStore,
      runtime: manager,
      newId: randomUUID,
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
    );
    const coordinator = rootCoordinator;
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
    const executionInspect = new HostExecutionInspectCoordinator(stores);
    const sessionRevisions = new HostSessionRevisionCoordinator({
      stores,
      artifacts: openedArtifactStore,
      taskLedger: taskLedgerStore,
      manager,
      admission: sessionAdmission,
      continuity: continuityCoordinator,
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
      manager,
      capabilities: clientCapabilities,
      continuity: continuityCoordinator,
      artifacts: openedArtifactStore,
      taskLedger: taskLedgerStore,
      purgeOperationalState: (sessionId) => stores.purgeConversationOperationalState(sessionId),
      worktrees: worktreeChildExecutor,
      requestDrain: context.requestDrain,
    });
    const artifacts = new HostArtifactCoordinator(
      openedArtifactStore,
      context.requestDrain,
      sessionAdmission,
      stores.sessionStore,
    );
    const handlers = {
      ...coordinator.handlers,
      ...requireGoal(goal).handlers,
      ...sessionCatalog.handlers,
      ...executionInspect.handlers,
      ...sessionRevisions.handlers,
      ...sessionRetirement.handlers,
      ...messages.handlers,
      ...interactions.handlers,
      ...runtimePolicy.handlers,
      ...connectionEffects.handlers,
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
    } satisfies DomainOperationHandlerMap;
    const recover = () => {
      recoveryTask ??= (async () => {
        await requireMemory(memory).recover();
        await skills.recover();
        await openedArtifactStore.recover();
        const sessions = await stores.sessionStore.listForRecovery();
        await worktreeChildExecutor.recover(
          sessions.flatMap((session) =>
            session.subagentWorkspace ? [session.subagentWorkspace] : [],
          ),
        );
        await sessionRetirement.recover();
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
        await graphCoordinator.recover();
        await coordinator.recover();
        rootRecoveryCompleted = true;
        await requireAutomationCoordinator(automations).recover();
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
          await graphCoordinator.close();
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
          await runtimeResources?.close();
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
          openedGraphControlStore.close();
        } catch (error) {
          errors.push(error);
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
          clientCapabilities?.close();
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
          openedArtifactStore.close();
        } catch (error) {
          errors.push(error);
        }
        try {
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
      continuity: continuityCoordinator,
      clientCapabilities,
      releaseConnection: (connectionId: string) => {
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

function requireSessionManager(manager: SessionManager | undefined): SessionManager {
  if (!manager) throw new Error('Runtime Host SessionManager is not composed');
  return manager;
}

function requireGoal(coordinator: HostGoalCoordinator | undefined): HostGoalCoordinator {
  if (!coordinator) throw new Error('Runtime Host Goal coordinator is not composed');
  return coordinator;
}
