import { sessionRevisionFamilyId } from '@maka/core/session';
import type {
  SubagentWorkspaceBinding,
  SubagentWorktreeExecutor,
} from '@maka/core/subagent-workspace';
import type { InteractiveArtifactStoreWriter } from '@maka/storage/artifact-stores';
import {
  isSessionNotFoundError,
  SessionMetadataConflictError,
  SessionMetadataVersionConflictError,
  type ExecutionSessionWriter,
  type SessionHeaderSnapshot,
} from '@maka/storage/execution-stores';
import { agentGraphIdForRootSession } from '@maka/runtime/stream-graph-coordinator';
import { type SessionManager } from '@maka/runtime/session-manager';
import type { InteractiveTaskLedgerWriter } from '@maka/storage/task-ledger-authority';
import {
  type OperationOutcome,
  type SessionCatalogItem,
  type SessionLifecycleSetInput,
  type SessionRemoveInput,
  type SessionRemoveResult,
} from '../protocol/index.js';
import {
  HostScheduledTaskSessionBusyError,
  type HostScheduledTaskSessionRetirement,
} from './scheduled-task-coordinator.js';
import type { HostClientCapabilityCoordinator } from './client-capability-coordinator.js';
import type { HostGoalCoordinator, HostGoalSessionRetirement } from './goal-coordinator.js';
import type { HostInteractionCoordinator } from './interaction-coordinator.js';
import type { HostMessageCoordinator } from './message-coordinator.js';
import type { SessionRetirementOperationHandlerMap } from './operation-dispatcher.js';
import { projectSessionCatalogRecord } from './session-catalog-coordinator.js';
import { type SessionAdmissionLease, SessionAdmissionGate } from './session-admission-gate.js';
import type { SessionContinuityCoordinator } from './session-continuity-coordinator.js';
import type { RootTurnCoordinator } from './root-turn-coordinator.js';
import type { HostRuntimeResourceCoordinator } from './runtime-resource-coordinator.js';
import { purgeSessionSidecars } from './session-sidecar-purge.js';
import type { MemoryExtractionSessionLane } from './memory-extraction-session-lane.js';

const FAMILY_STABILIZATION_ATTEMPTS = 4;

type RetirementStores = Pick<
  ExecutionSessionWriter,
  | 'listHeaders'
  | 'probeSessionRemoval'
  | 'readCatalogRecord'
  | 'readHeaderRecordSnapshot'
  | 'reconcileOrphanedAgentGraphRetirements'
  | 'listPendingSessionRetirementCleanupIds'
  | 'completeSessionRetirementCleanup'
  | 'removeSessionsVersioned'
  | 'setSessionsLifecycleVersioned'
>;

type RetirementRoot = Pick<RootTurnCoordinator, 'readRootState'>;
type RetirementMessages = Pick<HostMessageCoordinator, 'hasLiveSessionState' | 'retireSessions'>;
type RetirementInteractions = Pick<HostInteractionCoordinator, 'hasPendingSession'>;
type RetirementGoals = Pick<
  HostGoalCoordinator,
  'beginSessionRetirement' | 'hasLiveGoal' | 'unarchiveSessions'
>;
type RetirementResources = Pick<HostRuntimeResourceCoordinator, 'hasLiveSessionResources'>;
type RetirementSessionEffects = {
  hasLiveSessionState(sessionId: string): boolean;
};
type RetirementGraph = {
  hasLiveSessionState(sessionId: string): Promise<boolean>;
};
type RetirementGraphWake = {
  hasLiveSessionState(sessionId: string): boolean;
  retireSessions(sessionIds: readonly string[]): Promise<number>;
};
type RetirementManager = Pick<
  SessionManager,
  'disposeSessionBackend' | 'finalizeChildWorkspacePatches'
>;
type RetirementCapabilities = Pick<HostClientCapabilityCoordinator, 'retireSessions'>;
type RetirementContinuity = Pick<
  SessionContinuityCoordinator,
  'refreshCanonical' | 'retireSessions'
>;

export interface HostSessionRetirementCoordinatorOptions {
  readonly stores: RetirementStores;
  readonly admission: SessionAdmissionGate;
  readonly root: RetirementRoot;
  readonly messages: RetirementMessages;
  readonly interactions: RetirementInteractions;
  readonly goals: RetirementGoals;
  readonly scheduledTasks: {
    beginSessionRetirement(
      sessionIds: readonly string[],
    ): Promise<HostScheduledTaskSessionRetirement>;
  };
  readonly resources: RetirementResources;
  readonly sessionEffects: RetirementSessionEffects;
  readonly graph: RetirementGraph;
  readonly graphWake: RetirementGraphWake;
  readonly manager: RetirementManager;
  readonly capabilities: RetirementCapabilities;
  readonly continuity: RetirementContinuity;
  readonly artifacts: Pick<InteractiveArtifactStoreWriter, 'purgeSessionArtifacts'>;
  readonly taskLedger: Pick<InteractiveTaskLedgerWriter, 'purgeConversationTaskLedger'>;
  readonly purgeOperationalState: (sessionId: string) => Promise<void>;
  readonly purgeAgentGraphState: (sessionId: string) => Promise<void>;
  readonly worktrees?: Pick<SubagentWorktreeExecutor, 'retire'>;
  readonly requestDrain: () => void;
  readonly memoryExtractionLane: MemoryExtractionSessionLane;
}

interface StableFamily {
  readonly sessionIds: readonly string[];
  readonly records: ReadonlyMap<string, SessionHeaderSnapshot>;
  readonly admission: SessionAdmissionLease;
}

interface RetirementHandles {
  readonly goal: HostGoalSessionRetirement;
  readonly scheduledTasks: HostScheduledTaskSessionRetirement;
}

class RetryFamilyResolution extends Error {
  readonly name = 'RetryFamilyResolution';

  constructor(readonly sessionIds: readonly string[]) {
    super('Session revision family changed before retirement admission');
  }
}

class SessionRetirementBusyError extends Error {
  readonly name = 'SessionRetirementBusyError';
}

/** Host-owned archive, unarchive, remove, and revision-family commit authority. */
export class HostSessionRetirementCoordinator {
  readonly handlers: SessionRetirementOperationHandlerMap = {
    'session.lifecycle.set': (input) => this.#setLifecycle(input),
    'session.remove': (input) => this.#remove(input),
  };

  readonly #stores: RetirementStores;
  readonly #admission: SessionAdmissionGate;
  readonly #root: RetirementRoot;
  readonly #messages: RetirementMessages;
  readonly #interactions: RetirementInteractions;
  readonly #goals: RetirementGoals;
  readonly #scheduledTasks: HostSessionRetirementCoordinatorOptions['scheduledTasks'];
  readonly #resources: RetirementResources;
  readonly #sessionEffects: RetirementSessionEffects;
  readonly #graph: RetirementGraph;
  readonly #graphWake: RetirementGraphWake;
  readonly #manager: RetirementManager;
  readonly #capabilities: RetirementCapabilities;
  readonly #continuity: RetirementContinuity;
  readonly #artifacts: HostSessionRetirementCoordinatorOptions['artifacts'];
  readonly #taskLedger: HostSessionRetirementCoordinatorOptions['taskLedger'];
  readonly #purgeOperationalState: HostSessionRetirementCoordinatorOptions['purgeOperationalState'];
  readonly #purgeAgentGraphState: HostSessionRetirementCoordinatorOptions['purgeAgentGraphState'];
  readonly #worktrees: HostSessionRetirementCoordinatorOptions['worktrees'];
  readonly #requestDrain: () => void;
  readonly #memoryExtractionLane: MemoryExtractionSessionLane;
  readonly #cleanupQueue = new Set<string>();
  readonly #retiredWorktrees = new Map<string, SubagentWorkspaceBinding>();
  #cleanupWorker: Promise<void> | null = null;
  #closing = false;

  constructor(options: HostSessionRetirementCoordinatorOptions) {
    this.#stores = options.stores;
    this.#admission = options.admission;
    this.#root = options.root;
    this.#messages = options.messages;
    this.#interactions = options.interactions;
    this.#goals = options.goals;
    this.#scheduledTasks = options.scheduledTasks;
    this.#resources = options.resources;
    this.#sessionEffects = options.sessionEffects;
    this.#graph = options.graph;
    this.#graphWake = options.graphWake;
    this.#manager = options.manager;
    this.#capabilities = options.capabilities;
    this.#continuity = options.continuity;
    this.#artifacts = options.artifacts;
    this.#taskLedger = options.taskLedger;
    this.#purgeOperationalState = options.purgeOperationalState;
    this.#purgeAgentGraphState = options.purgeAgentGraphState;
    this.#worktrees = options.worktrees;
    this.#requestDrain = options.requestDrain;
    this.#memoryExtractionLane = options.memoryExtractionLane;
  }

  async recover(): Promise<void> {
    await this.#stores.reconcileOrphanedAgentGraphRetirements();
    this.#scheduleCleanup(await this.#stores.listPendingSessionRetirementCleanupIds());
  }

  async close(): Promise<void> {
    this.#closing = true;
    await this.#cleanupWorker;
  }

  async #setLifecycle(
    input: SessionLifecycleSetInput,
  ): Promise<OperationOutcome<'session.lifecycle.set'>> {
    try {
      return await this.#withStableFamily(input.sessionId, async (family) => {
        const target = requireFamilyRecord(family, input.sessionId);
        const archived = input.state === 'archived';
        if (
          [...family.records.values()].every(
            ({ header }) =>
              header.isArchived === archived && (header.status === 'archived') === archived,
          )
        ) {
          return lifecycleSuccess(
            projectSessionCatalogRecord(await this.#stores.readCatalogRecord(input.sessionId)),
          );
        }

        if (!archived) {
          let committed = false;
          try {
            await this.#stores.setSessionsLifecycleVersioned(versionedFamily(family), 'active');
            committed = true;
            this.#goals.unarchiveSessions(family.sessionIds);
            await this.#refreshFamily(family);
            return lifecycleSuccess(
              projectSessionCatalogRecord(await this.#stores.readCatalogRecord(input.sessionId)),
            );
          } catch (error) {
            if (committed) return this.#uncertainLifecycle('unarchive');
            throw error;
          }
        }

        let handles: RetirementHandles | undefined;
        let committed = false;
        try {
          handles = await this.#prepareRetirement(family, 'archive');
          await this.#finalizeWorkspacePatches(family.sessionIds);
          await this.#disposeBackends(family.sessionIds);
          const committable = await this.#refreshFamilyRecords(family);
          await this.#stores.setSessionsLifecycleVersioned(
            versionedFamily(committable),
            'archived',
          );
          committed = true;
          handles.goal.commit();
          handles.scheduledTasks.commit();
          await this.#graphWake.retireSessions(family.sessionIds);
          this.#capabilities.retireSessions(family.sessionIds);
          this.#messages.retireSessions(family.sessionIds);
          await this.#refreshFamily(family);
          return lifecycleSuccess(
            projectSessionCatalogRecord(await this.#stores.readCatalogRecord(target.header.id)),
          );
        } catch (error) {
          if (committed) return this.#uncertainLifecycle('archive');
          handles?.goal.rollback();
          handles?.scheduledTasks.rollback();
          throw error;
        }
      });
    } catch (error) {
      return this.#lifecycleFailure(error);
    }
  }

  async #remove(input: SessionRemoveInput): Promise<OperationOutcome<'session.remove'>> {
    let probe;
    try {
      probe = await this.#stores.probeSessionRemoval(input.sessionId);
    } catch {
      return removeFailure('persistence_failed', 'Session removal state is unavailable');
    }
    if (probe.kind === 'removed') {
      try {
        this.#scheduleCleanup(
          await this.#stores.listPendingSessionRetirementCleanupIds(input.sessionId),
        );
      } catch {
        this.#requestDrain();
      }
      return removeSuccess(input.sessionId);
    }
    if (probe.kind === 'absent') return removeFailure('not_found', 'Session does not exist');

    try {
      return await this.#withStableFamily(input.sessionId, async (family) => {
        const target = requireFamilyRecord(family, input.sessionId);
        if (target.revision !== input.expectedRevision) {
          return removeOutcome({
            kind: 'revision_conflict',
            expectedRevision: input.expectedRevision,
            actualRevision: target.revision,
          });
        }

        let handles: RetirementHandles | undefined;
        let committed = false;
        try {
          handles = await this.#prepareRetirement(family, 'remove');
          await this.#finalizeWorkspacePatches(family.sessionIds);
          await this.#disposeBackends(family.sessionIds);
          const committable = await this.#refreshFamilyRecords(family);
          const removedSessionIds = await this.#stores.removeSessionsVersioned(
            versionedFamily(committable),
          );
          committed = true;
          handles.goal.commit();
          handles.scheduledTasks.commit();
          await this.#graphWake.retireSessions(family.sessionIds);
          this.#rememberRetiredWorktrees(committable, removedSessionIds);
          this.#scheduleCleanup(removedSessionIds);
          this.#capabilities.retireSessions(family.sessionIds);
          this.#messages.retireSessions(family.sessionIds);
          await this.#continuity.retireSessions(family.sessionIds, family.admission);
          return removeSuccess(input.sessionId);
        } catch (error) {
          if (committed) return this.#uncertainRemove();
          handles?.goal.rollback();
          handles?.scheduledTasks.rollback();
          throw error;
        }
      });
    } catch (error) {
      return this.#removeFailure(error, input);
    }
  }

  async #withStableFamily<T>(
    sessionId: string,
    operation: (family: StableFamily) => Promise<T>,
  ): Promise<T> {
    let sessionIds = await this.#readFamilySessionIds(sessionId);
    for (let attempt = 0; attempt < FAMILY_STABILIZATION_ATTEMPTS; attempt += 1) {
      try {
        return await this.#memoryExtractionLane.runMany(sessionIds, () =>
          this.#admission.runMany(sessionIds, async (admission) => {
            const stableIds = await this.#readFamilySessionIds(sessionId);
            if (!sameIds(sessionIds, stableIds)) throw new RetryFamilyResolution(stableIds);
            const snapshots = await Promise.all(
              stableIds.map((id) => this.#stores.readHeaderRecordSnapshot(id)),
            );
            return operation({
              sessionIds: stableIds,
              records: new Map(stableIds.map((id, index) => [id, snapshots[index]!])),
              admission,
            });
          }),
        );
      } catch (error) {
        if (!(error instanceof RetryFamilyResolution)) throw error;
        sessionIds = [...error.sessionIds];
      }
    }
    throw new SessionMetadataConflictError(
      'Session revision family kept changing during retirement admission',
    );
  }

  async #readFamilySessionIds(sessionId: string): Promise<string[]> {
    const target = await this.#stores.probeSessionRemoval(sessionId);
    if (target.kind !== 'present') {
      throw new SessionRetirementMissingSessionError(target.kind);
    }
    if (target.record.header.subagentParent?.graph) {
      throw new SessionMetadataConflictError(
        'Agent Graph operator Sessions retire with their root Session',
      );
    }
    const familyId = sessionRevisionFamilyId(target.record.header);
    const headers = await this.#stores.listHeaders();
    const roots = headers.filter(
      (header) =>
        header.conversationCopy?.state !== 'preparing' &&
        !header.subagentParent &&
        sessionRevisionFamilyId(header) === familyId,
    );
    const graphRoots = new Map(
      roots.map((header) => [header.id, agentGraphIdForRootSession(header.id)]),
    );
    const members = headers
      .filter((header) => {
        if (header.conversationCopy?.state === 'preparing') return false;
        if (sessionRevisionFamilyId(header) === familyId) return true;
        const parent = header.subagentParent;
        return (
          parent?.graph !== undefined &&
          parent.graph.graphId === graphRoots.get(parent.parentSessionId)
        );
      })
      .map((header) => header.id);
    if (!members.includes(sessionId)) members.push(sessionId);
    return [...new Set(members)].sort();
  }

  async #prepareRetirement(
    family: StableFamily,
    kind: 'archive' | 'remove',
  ): Promise<RetirementHandles> {
    for (const sessionId of family.sessionIds) {
      if (this.#root.readRootState(sessionId).kind !== 'idle') {
        throw new SessionRetirementBusyError('Session has an active or reserved root Turn');
      }
      if (this.#messages.hasLiveSessionState(sessionId)) {
        throw new SessionRetirementBusyError('Session has queued or in-flight Messages');
      }
      if (await this.#interactions.hasPendingSession(sessionId)) {
        throw new SessionRetirementBusyError('Session has a pending Interaction');
      }
      if (this.#goals.hasLiveGoal(sessionId)) {
        throw new SessionRetirementBusyError('Session has a live Goal');
      }
      if (await this.#resources.hasLiveSessionResources(sessionId)) {
        throw new SessionRetirementBusyError('Session has a live Runtime Resource');
      }
      if (this.#sessionEffects.hasLiveSessionState(sessionId)) {
        throw new SessionRetirementBusyError('Session has a live derived effect');
      }
      const header = requireFamilyRecord(family, sessionId).header;
      if (!header.subagentParent && (await this.#graph.hasLiveSessionState(sessionId))) {
        throw new SessionRetirementBusyError('Session has a live Agent Graph');
      }
      if (!header.subagentParent && this.#graphWake.hasLiveSessionState(sessionId)) {
        throw new SessionRetirementBusyError('Session has an active Agent Graph supervisor wake');
      }
    }

    const scheduledTasks = await this.#scheduledTasks.beginSessionRetirement(family.sessionIds);
    try {
      const goal = await this.#goals.beginSessionRetirement(family.sessionIds, kind);
      return { goal, scheduledTasks };
    } catch (error) {
      scheduledTasks.rollback();
      throw error;
    }
  }

  async #disposeBackends(sessionIds: readonly string[]): Promise<void> {
    const outcomes = await Promise.allSettled(
      sessionIds.map((sessionId) => this.#manager.disposeSessionBackend(sessionId)),
    );
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason] : [],
    );
    if (failures.length === 0) return;
    this.#requestDrain();
    throw new AggregateError(failures, 'Session backend disposal failed during retirement');
  }

  async #finalizeWorkspacePatches(sessionIds: readonly string[]): Promise<void> {
    for (const sessionId of sessionIds) {
      await this.#manager.finalizeChildWorkspacePatches(sessionId);
    }
  }

  #scheduleCleanup(sessionIds: readonly string[]): void {
    if (this.#closing) return;
    for (const sessionId of sessionIds) this.#cleanupQueue.add(sessionId);
    if (this.#cleanupWorker || this.#cleanupQueue.size === 0) return;
    const worker = this.#drainCleanup();
    this.#cleanupWorker = worker;
    void worker.then(
      () => this.#finishCleanup(worker),
      () => this.#finishCleanup(worker),
    );
  }

  async #drainCleanup(): Promise<void> {
    while (this.#cleanupQueue.size > 0) {
      const batch = [...this.#cleanupQueue];
      this.#cleanupQueue.clear();
      await Promise.allSettled(batch.map((sessionId) => this.#cleanupRetiredSession(sessionId)));
    }
  }

  async #cleanupRetiredSession(sessionId: string): Promise<void> {
    const worktree = this.#retiredWorktrees.get(sessionId);
    const outcomes = await Promise.allSettled([
      purgeSessionSidecars(
        {
          artifacts: this.#artifacts,
          taskLedger: this.#taskLedger,
          purgeOperationalState: this.#purgeOperationalState,
        },
        sessionId,
      ),
      this.#purgeAgentGraphState(sessionId),
      ...(worktree && this.#worktrees ? [this.#worktrees.retire(worktree)] : []),
    ]);
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, `Session ${sessionId} retirement cleanup failed`);
    }
    await this.#stores.completeSessionRetirementCleanup(sessionId);
    this.#retiredWorktrees.delete(sessionId);
  }

  #rememberRetiredWorktrees(family: StableFamily, removedSessionIds: readonly string[]): void {
    for (const sessionId of removedSessionIds) {
      const binding = family.records.get(sessionId)?.header.subagentWorkspace;
      if (binding) this.#retiredWorktrees.set(sessionId, binding);
    }
  }

  #finishCleanup(worker: Promise<void>): void {
    if (this.#cleanupWorker !== worker) return;
    this.#cleanupWorker = null;
    if (!this.#closing && this.#cleanupQueue.size > 0) this.#scheduleCleanup([]);
  }

  async #refreshFamilyRecords(family: StableFamily): Promise<StableFamily> {
    const snapshots = await Promise.all(
      family.sessionIds.map((sessionId) => this.#stores.readHeaderRecordSnapshot(sessionId)),
    );
    return {
      ...family,
      records: new Map(family.sessionIds.map((sessionId, index) => [sessionId, snapshots[index]!])),
    };
  }

  async #refreshFamily(family: StableFamily): Promise<void> {
    for (const sessionId of family.sessionIds) {
      await this.#continuity.refreshCanonical(sessionId, family.admission);
    }
  }

  #uncertainLifecycle(kind: 'archive' | 'unarchive') {
    this.#requestDrain();
    return lifecycleFailure(
      'commit_outcome_unknown',
      `Session ${kind} committed but publication is uncertain`,
    );
  }

  #lifecycleFailure(error: unknown): OperationOutcome<'session.lifecycle.set'> {
    if (error instanceof SessionRetirementMissingSessionError || isSessionNotFoundError(error)) {
      return lifecycleFailure('not_found', 'Session does not exist');
    }
    if (
      error instanceof SessionRetirementBusyError ||
      error instanceof HostScheduledTaskSessionBusyError
    ) {
      return lifecycleFailure('session_busy', error.message);
    }
    if (error instanceof SessionMetadataConflictError) {
      return lifecycleFailure('operation_conflict', error.message);
    }
    return lifecycleFailure('persistence_failed', 'Session lifecycle could not be committed');
  }

  #uncertainRemove(): OperationOutcome<'session.remove'> {
    this.#requestDrain();
    return removeFailure(
      'commit_outcome_unknown',
      'Session remove committed but publication is uncertain',
    );
  }

  #removeFailure(error: unknown, input: SessionRemoveInput): OperationOutcome<'session.remove'> {
    if (error instanceof SessionRetirementMissingSessionError) {
      return error.state === 'removed'
        ? removeSuccess(input.sessionId)
        : removeFailure('not_found', 'Session does not exist');
    }
    if (isSessionNotFoundError(error)) {
      return removeFailure('not_found', 'Session does not exist');
    }
    if (
      error instanceof SessionRetirementBusyError ||
      error instanceof HostScheduledTaskSessionBusyError
    ) {
      return removeFailure('session_busy', error.message);
    }
    if (error instanceof SessionMetadataVersionConflictError) {
      if (error.sessionId !== input.sessionId || error.expectedVersion !== input.expectedRevision) {
        return removeFailure(
          'operation_conflict',
          'Session revision family changed during removal',
        );
      }
      return removeOutcome({
        kind: 'revision_conflict',
        expectedRevision: error.expectedVersion,
        actualRevision: error.actualVersion,
      });
    }
    if (error instanceof SessionMetadataConflictError) {
      return removeFailure('operation_conflict', error.message);
    }
    return removeFailure('persistence_failed', 'Session remove could not be committed');
  }
}

class SessionRetirementMissingSessionError extends Error {
  readonly name = 'SessionRetirementMissingSession';

  constructor(readonly state: 'removed' | 'absent') {
    super(`Session is ${state}`);
  }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function requireFamilyRecord(family: StableFamily, sessionId: string): SessionHeaderSnapshot {
  const record = family.records.get(sessionId);
  if (!record) throw new SessionMetadataConflictError('Session left its revision family');
  return record;
}

function versionedFamily(family: StableFamily) {
  return family.sessionIds.map((sessionId) => ({
    sessionId,
    expectedVersion: requireFamilyRecord(family, sessionId).revision,
  }));
}

function lifecycleSuccess(result: SessionCatalogItem): OperationOutcome<'session.lifecycle.set'> {
  return { ok: true, result };
}

function lifecycleFailure(
  code: Extract<OperationOutcome<'session.lifecycle.set'>, { ok: false }>['error']['code'],
  message: string,
): Extract<OperationOutcome<'session.lifecycle.set'>, { ok: false }> {
  return { ok: false, error: { code, message } };
}

function removeSuccess(sessionId: string): OperationOutcome<'session.remove'> {
  return removeOutcome({ kind: 'removed', sessionId });
}

function removeOutcome(result: SessionRemoveResult): OperationOutcome<'session.remove'> {
  return { ok: true, result };
}

function removeFailure(
  code: Extract<OperationOutcome<'session.remove'>, { ok: false }>['error']['code'],
  message: string,
): Extract<OperationOutcome<'session.remove'>, { ok: false }> {
  return { ok: false, error: { code, message } };
}
