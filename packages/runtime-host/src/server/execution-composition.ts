import { randomUUID } from 'node:crypto';
import {
  BackendRegistry,
  FakeBackend,
  SessionManager,
  type RuntimeHostedRootAuthority,
} from '@maka/runtime';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { CanonicalSessionProjectionReader } from './canonical-session-projection.js';
import type { RuntimeHostComposition, RuntimeHostCompositionContext } from './host-kernel.js';
import { type HostMessageRootPort, HostMessageCoordinator } from './message-coordinator.js';
import type { DomainOperationHandlerMap } from './operation-dispatcher.js';
import { RootAdmissionOwner } from './root-admission-owner.js';
import { RootTurnCoordinator } from './root-turn-coordinator.js';
import { RuntimePolicyActivationGate } from './runtime-policy-activation-gate.js';
import { HostRuntimePolicyCoordinator } from './runtime-policy-coordinator.js';
import { SessionAdmissionGate } from './session-admission-gate.js';
import { SessionContinuityCoordinator } from './session-continuity-coordinator.js';

export async function createExecutionRuntimeHostComposition(
  context: RuntimeHostCompositionContext,
): Promise<RuntimeHostComposition> {
  const stores = await openInteractiveExecutionStoresForWrite(context.owner.lease);
  try {
    const runtimePolicyStores = await openInteractiveRuntimePolicyStoresForWrite(
      context.owner.lease,
    );
    await stores.messageReceiptStore.beginHostEpoch(context.hostEpoch);
    const backends = new BackendRegistry();
    backends.register('fake', (backendContext) => new FakeBackend(backendContext));
    const runtimePolicyActivation = new RuntimePolicyActivationGate();
    const sessionAdmission = new SessionAdmissionGate();
    let rootCoordinator: RootTurnCoordinator | undefined;
    let continuity: SessionContinuityCoordinator | undefined;
    const rootPort: HostMessageRootPort = {
      readSessionHeader: (sessionId) =>
        requireRootCoordinator(rootCoordinator).readSessionHeader(sessionId),
      readRootState: (sessionId) =>
        requireRootCoordinator(rootCoordinator).readRootState(sessionId),
      startFromMessage: (input, admission) =>
        requireRootCoordinator(rootCoordinator).startFromMessage(input, admission),
      claimStop: (input, commitQueueFence) =>
        requireRootCoordinator(rootCoordinator).claimStop(input, commitQueueFence),
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
      onProjectionChanged: (sessionId) =>
        requireContinuity(continuity).enqueueCanonicalRefresh(sessionId),
    });
    const rootAdmissionOwner = new RootAdmissionOwner(stores.agentRunStore);
    const canonicalProjection = new CanonicalSessionProjectionReader({
      stores,
      rootAdmissions: rootAdmissionOwner,
      messages,
    });
    continuity = new SessionContinuityCoordinator(
      context.hostEpoch,
      (sessionId) => canonicalProjection.read(sessionId),
      sessionAdmission,
      context.requestDrain,
    );
    const continuityCoordinator = continuity;
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
    });
    rootCoordinator = new RootTurnCoordinator(
      manager,
      stores,
      sessionAdmission,
      rootAdmissionOwner,
      messages,
      continuityCoordinator,
      context.acquireResidency,
      context.requestDrain,
    );
    const coordinator = rootCoordinator;
    const runtimePolicy = new HostRuntimePolicyCoordinator(
      runtimePolicyStores,
      runtimePolicyActivation,
      async () => {
        try {
          await manager.refreshIdleBackends();
        } catch (error) {
          context.requestDrain();
          throw error;
        }
      },
    );
    const handlers = {
      ...coordinator.handlers,
      ...messages.handlers,
      ...runtimePolicy.handlers,
      ...continuityCoordinator.handlers,
    } satisfies DomainOperationHandlerMap;
    return {
      handlers,
      continuity: continuityCoordinator,
      recover: async () => {
        const sessions = await stores.sessionStore.listForRecovery();
        for (const session of sessions) {
          await stores.runtimeEventStore.repairImmutableSteeringMessageProofsForRecovery(
            session.id,
          );
        }
        await coordinator.prepareRecovery();
        await manager.recoverInterruptedSessionsStrict(stores);
        await coordinator.recover();
      },
      close: async () => {
        messages.beginDrain();
        const errors: unknown[] = [];
        try {
          await coordinator.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await messages.close();
        } catch (error) {
          errors.push(error);
        }
        continuityCoordinator.close();
        try {
          await stores.sessionStore.close?.();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, 'Unable to close Runtime Host execution composition');
        }
      },
    };
  } catch (error) {
    await stores.sessionStore.close?.();
    throw error;
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
