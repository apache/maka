import { randomUUID } from 'node:crypto';
import {
  AgentGraphCoordinator,
  BackendRegistry,
  FakeBackend,
  SessionManager,
  type RuntimeHostedRootAuthority,
} from '@maka/runtime';
import { createAgentGraphControlStore } from '@maka/storage/agent-graph-control-store';
import { openInteractiveArtifactStoreForWrite } from '@maka/storage/artifact-stores';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { openInteractiveMemoryBundleStoreForWrite } from '@maka/storage/memory-bundle-store';
import { runWithStorageRootLease } from '@maka/storage/root-authority';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { openInteractiveTaskLedgerStoreForWrite } from '@maka/storage/task-ledger-authority';
import { openInteractiveUsageStoresForWrite } from '@maka/storage/usage-stores';
import { CanonicalSessionProjectionReader } from './canonical-session-projection.js';
import { HostCanonicalPermissionOutcomeReader } from './canonical-permission-outcome-reader.js';
import { HostArtifactCoordinator } from './artifact-coordinator.js';
import { HostConnectionEffectCoordinator } from './connection-effect-coordinator.js';
import type { RuntimeHostComposition, RuntimeHostCompositionContext } from './host-kernel.js';
import { HostInteractionCoordinator } from './interaction-coordinator.js';
import { HostMemoryCoordinator } from './memory-coordinator.js';
import { type HostMessageRootPort, HostMessageCoordinator } from './message-coordinator.js';
import type { DomainOperationHandlerMap } from './operation-dispatcher.js';
import { RootAdmissionOwner } from './root-admission-owner.js';
import { RootTurnCoordinator } from './root-turn-coordinator.js';
import { RuntimePolicyActivationGate } from './runtime-policy-activation-gate.js';
import { HostRuntimePolicyCoordinator } from './runtime-policy-coordinator.js';
import { SessionAdmissionGate } from './session-admission-gate.js';
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
  let usageStores: Awaited<ReturnType<typeof openInteractiveUsageStoresForWrite>> | undefined;
  try {
    const runtimePolicyStores = await openInteractiveRuntimePolicyStoresForWrite(
      context.owner.lease,
    );
    const memoryStore = await openInteractiveMemoryBundleStoreForWrite(context.owner.lease);
    const taskLedgerStore = await openInteractiveTaskLedgerStoreForWrite(context.owner.lease);
    const openedArtifactStore = await openInteractiveArtifactStoreForWrite(context.owner.lease);
    const openedUsageStores = await openInteractiveUsageStoresForWrite(context.owner.lease);
    usageStores = openedUsageStores;
    await stores.messageReceiptStore.beginHostEpoch(context.hostEpoch);
    const backends = new BackendRegistry();
    backends.register('fake', (backendContext) => new FakeBackend(backendContext));
    const runtimePolicyActivation = new RuntimePolicyActivationGate();
    const sessionAdmission = new SessionAdmissionGate();
    const taskLedger = new HostTaskLedgerCoordinator(taskLedgerStore, sessionAdmission);
    const usagePricing = new HostUsagePricingCoordinator(openedUsageStores, context.requestDrain);
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
    let closeTask: Promise<void> | undefined;
    let usageDrain: Promise<void> | undefined;
    const beginDrain = () => {
      if (draining) return;
      draining = true;
      messages.beginDrain();
      interactions.beginDrain();
      connectionEffects.beginDrain();
      skills.beginDrain();
      memory?.beginDrain();
      usageDrain ??= openedUsageStores.beginDrain();
      usageDrain.then(
        () => undefined,
        () => undefined,
      );
    };
    const interactions = new HostInteractionCoordinator({
      store: stores.interactionStore,
      sessionAdmission,
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
    const runtimeAuthority: RuntimeHostedRootAuthority = {
      bindRun: (identity) => messages.bindRun(identity),
      executeRoot: (input) => requireRootCoordinator(rootCoordinator).executeRoot(input),
      stopRoot: (identity, input) =>
        requireRootCoordinator(rootCoordinator).stopRoot(identity, input),
      stopSession: (sessionId, input) =>
        requireRootCoordinator(rootCoordinator).stopSession(sessionId, input),
    };
    const manager = new SessionManager({
      store: stores.sessionStore,
      runStore: stores.agentRunStore,
      runtimeEventStore: stores.runtimeEventStore,
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
    });
    const graphCoordinator = new AgentGraphCoordinator({
      sessionStore: stores.sessionStore,
      runStore: stores.agentRunStore,
      runtimeEventStore: stores.runtimeEventStore,
      controlStore: openedGraphControlStore,
      runtime: manager,
      newId: randomUUID,
    });
    memory = new HostMemoryCoordinator({
      store: memoryStore,
      runtimePolicyStores,
      activation: runtimePolicyActivation,
      requestDrain: context.requestDrain,
    });
    const runPostCommitInvalidation = async (invalidate: () => Promise<void>) => {
      try {
        await invalidate();
      } catch (error) {
        context.requestDrain();
        throw error;
      }
    };
    const invalidateRuntimePolicy = () =>
      runPostCommitInvalidation(() => manager.refreshIdleBackends());
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
    );
    const coordinator = rootCoordinator;
    const runtimePolicy = new HostRuntimePolicyCoordinator(
      runtimePolicyStores,
      runtimePolicyActivation,
      () =>
        runPostCommitInvalidation(async () => {
          await requireMemory(memory).refreshAfterPolicyMutation();
          await manager.refreshIdleBackends();
        }),
    );
    const connectionEffects = new HostConnectionEffectCoordinator({
      stores: runtimePolicyStores,
      activation: runtimePolicyActivation,
      onCommittedMutation: invalidateRuntimePolicy,
    });
    const artifacts = new HostArtifactCoordinator(openedArtifactStore, context.requestDrain);
    const handlers = {
      ...coordinator.handlers,
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
    } satisfies DomainOperationHandlerMap;
    const recover = () => {
      recoveryTask ??= (async () => {
        await requireMemory(memory).recover();
        await skills.recover();
        const sessions = await stores.sessionStore.listForRecovery();
        for (const session of sessions) {
          await stores.runtimeEventStore.repairImmutableSteeringMessageProofsForRecovery(
            session.id,
          );
        }
        await coordinator.prepareRecovery();
        await openedArtifactStore.recover();
        await interactions.recoverPendingAfterHostRestart();
        await manager.recoverInterruptedSessionsStrict(stores);
        await graphCoordinator.recover();
        await coordinator.recover();
      })();
      return recoveryTask;
    };
    const close = () => {
      closeTask ??= (async () => {
        beginDrain();
        const errors: unknown[] = [];
        let recovered = false;
        try {
          await recover();
          recovered = true;
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
        if (recovered && !poisonFailure) {
          try {
            rootCloseTask ??= coordinator.close();
            await rootCloseTask;
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
          await openedUsageStores.close();
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
      releaseConnection: (connectionId: string) =>
        requireMemory(memory).releaseConnection(connectionId),
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
