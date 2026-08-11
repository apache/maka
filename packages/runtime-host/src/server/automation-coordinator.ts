import { randomUUID } from 'node:crypto';
import type { AgentRunHeader } from '@maka/core/agent-run';
import { messageContentsEqual } from '@maka/core/events';
import type { SessionHeader } from '@maka/core/session';
import type { AutomationDefinition, AutomationPendingFire } from '@maka/core/automation';
import {
  AutomationManager,
  buildAutomationAuthorityTool,
  settleAutomationAttempt,
  type AutomationToolAuthority,
  type MakaTool,
  type SessionManager,
} from '@maka/runtime';
import {
  authenticateInteractiveAutomationAuthorityWriter,
  type InteractiveAutomationAuthorityWriter,
} from '@maka/storage/automation-authority';
import {
  isSessionNotFoundError,
  type ExecutionAgentRunWriter,
  type ExecutionSessionWriter,
  type RootTurnAdmission,
} from '@maka/storage/execution-stores';
import type { RuntimePolicyStoresWriter } from '@maka/storage/runtime-policy-stores';
import {
  AUTOMATION_PAGE_MAX_ITEMS,
  AUTOMATION_RESULT_MAX_BYTES,
  type AutomationMutateInput,
  type AutomationMutateResult,
  type AutomationProjection,
  type AutomationQueryInput,
  type AutomationQueryResult,
  type OperationOutcome,
} from '../protocol/index.js';
import type { RuntimeHostResidency } from './host-kernel.js';
import type { AutomationOperationHandlerMap } from './operation-dispatcher.js';
import type { AutomationClientCapabilityAuthority } from './client-capability-service.js';
import { AutomationAuthorityInvariantError } from './automation-errors.js';
import {
  assertFireRunIdentity,
  fireContent,
  HostAutomationFireCoordinator,
} from './automation-fire-coordinator.js';
import { runtimeHostAutomationSessionUnavailableReason } from './host-session-availability.js';
import type { HostedExecutionAuthority } from './hosted-execution-authority.js';
import { SessionAdmissionGate } from './session-admission-gate.js';

type AutomationSessions = Pick<ExecutionSessionWriter, 'readHeaderSnapshot'>;
type AutomationRuns = Pick<ExecutionAgentRunWriter, 'readRun'>;
type AutomationRuntime = Pick<SessionManager, 'sendMessage'>;
type AutomationRoot = Pick<HostedExecutionAuthority, 'admit' | 'reconcile' | 'subscribe'>;

export interface HostAutomationCoordinatorInput {
  readonly store: InteractiveAutomationAuthorityWriter;
  readonly sessions: AutomationSessions;
  readonly runs: AutomationRuns;
  readonly runtime: AutomationRuntime;
  readonly root: AutomationRoot;
  readonly runtimePolicy: RuntimePolicyStoresWriter;
  readonly clientCapabilities: AutomationClientCapabilityAuthority;
  readonly isSessionActive: (sessionId: string) => boolean;
  readonly sessionAdmission: SessionAdmissionGate;
  readonly acquireResidency: () => RuntimeHostResidency;
  readonly requestDrain: () => void;
  readonly newId?: () => string;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (timer: unknown) => void;
}

export class HostAutomationSessionBusyError extends Error {
  readonly name = 'HostAutomationSessionBusyError';
}

export interface HostAutomationSessionRetirement {
  commit(): void;
  rollback(): void;
}

interface CommittedAutomation {
  readonly automation: AutomationDefinition;
  readonly revision: number;
  readonly firePending: boolean;
}

interface AutomationStateSnapshot {
  readonly revision: number;
  readonly automations: readonly AutomationDefinition[];
  readonly pendingFires: readonly AutomationPendingFire[];
}

class AutomationMutationFailure extends Error {
  readonly name = 'AutomationMutationFailure';

  constructor(
    readonly kind:
      | 'not_found'
      | 'not_owned'
      | 'not_active'
      | 'not_paused'
      | 'fire_pending'
      | 'fire_budget_exhausted'
      | 'limit_reached'
      | 'invalid_schedule'
      | 'session_archived'
      | 'session_busy'
      | 'session_unavailable'
      | 'capability_unavailable'
      | 'host_not_ready'
      | 'host_draining',
    message: string,
  ) {
    super(message);
  }
}

/** Host-owned Automation Store, scheduler, fire admission, and tool authority. */
export class HostAutomationCoordinator implements AutomationToolAuthority {
  readonly handlers: AutomationOperationHandlerMap = {
    'automation.query': (input) =>
      this.#sessionAdmission.run(input.sessionId, () => this.#query(input)),
    'automation.mutate': (input) =>
      this.#sessionAdmission.run(input.sessionId, () => this.#mutate(input)),
  };

  readonly modelTool: MakaTool;

  readonly #store: InteractiveAutomationAuthorityWriter;
  readonly #sessions: AutomationSessions;
  readonly #requestDrain: () => void;
  readonly #sessionAdmission: SessionAdmissionGate;
  readonly #clientCapabilities: HostAutomationCoordinatorInput['clientCapabilities'];
  readonly #newId: () => string;
  readonly #now: () => number;
  readonly #manager: AutomationManager;
  readonly #fireCoordinator: HostAutomationFireCoordinator;
  readonly #pendingFires = new Map<string, AutomationPendingFire>();
  readonly #retiringSessions = new Set<string>();

  #revision = 0;
  #lane: Promise<void> = Promise.resolve();
  #prepared = false;
  #closed = false;

  constructor(input: HostAutomationCoordinatorInput) {
    this.#store = authenticateInteractiveAutomationAuthorityWriter(input.store);
    this.#sessions = input.sessions;
    this.#requestDrain = input.requestDrain;
    this.#sessionAdmission = input.sessionAdmission;
    this.#clientCapabilities = input.clientCapabilities;
    this.#newId = input.newId ?? randomUUID;
    this.#now = input.now ?? Date.now;
    this.#manager = new AutomationManager({
      generateId: this.#newId,
      now: this.#now,
      ...(input.random ? { random: input.random } : {}),
    });
    this.#fireCoordinator = new HostAutomationFireCoordinator({
      state: {
        listPendingFires: () =>
          this.#exclusive(() => [...this.#pendingFires.values()].map(cloneFire)),
        listDueAutomations: (now) => this.#listDueAutomations(now),
        recordDeferredFire: (automationId, expectedSchedule, skip) =>
          this.#recordDeferredFire(automationId, expectedSchedule, skip),
        recordPrerequisiteWaiting: (automationId, expectedSchedule, waiting) =>
          this.#recordPrerequisiteWaiting(automationId, expectedSchedule, waiting),
        admitFire: (automationId, expectedSchedule) =>
          this.#admitFire(automationId, expectedSchedule),
        assertPendingFire: (fire) => this.#assertPendingFire(fire),
        recordFireDeferred: (fire, transientDeferredSince) =>
          this.#recordFireDeferred(fire, transientDeferredSince),
        recordFirePrerequisiteWaiting: (fire, waiting) =>
          this.#recordFirePrerequisiteWaiting(fire, waiting),
        failFire: (fire, error) => this.#failFire(fire, error),
        markFireRunning: (fire) => this.#markFireRunning(fire),
        settleFire: (fire, run) => this.#settleFire(fire, run),
        residencyState: () => ({
          pending: this.#pendingFires.size > 0,
          scheduled: this.#manager
            .listActive()
            .some((automation) => automation.nextFireAt !== null),
        }),
      },
      sessions: input.sessions,
      runs: input.runs,
      runtime: input.runtime,
      root: input.root,
      runtimePolicy: input.runtimePolicy,
      clientCapabilities: input.clientCapabilities,
      isSessionActive: input.isSessionActive,
      acquireResidency: input.acquireResidency,
      requestDrain: input.requestDrain,
      now: this.#now,
      setTimeout: input.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs)),
      clearTimeout: input.clearTimeout ?? ((timer) => clearTimeout(timer as NodeJS.Timeout)),
    });
    this.modelTool = buildAutomationAuthorityTool({ authority: this });
  }

  async prepareRecovery(): Promise<void> {
    await this.#exclusive(async () => {
      if (this.#prepared) return;
      const snapshot = await this.#store.read();
      this.#restore(snapshot);
      this.#prepared = true;
      this.#fireCoordinator.refreshResidency();
    });
  }

  assertRecoveryAdmission(admission: RootTurnAdmission): void {
    if (!this.#prepared) {
      throw new AutomationAuthorityInvariantError(
        'Automation recovery admission was inspected before Store recovery',
      );
    }
    if (admission.execution.kind !== 'automation') return;
    const fire = this.#pendingFires.get(admission.execution.automationId);
    if (
      !fire ||
      fire.targetSessionId !== admission.sessionId ||
      fire.turnId !== admission.turnId ||
      fire.runId !== admission.runId ||
      fire.userMessageId !== admission.userMessageId ||
      admission.normalizedInput === null ||
      !messageContentsEqual(fireContent(fire), admission.normalizedInput)
    ) {
      throw new AutomationAuthorityInvariantError(
        `Automation admission ${admission.turnId} has no matching pending fire`,
      );
    }
  }

  async recover(): Promise<void> {
    if (!this.#prepared) throw new Error('Automation recovery was not prepared');
    await this.#fireCoordinator.recover();
  }

  start(): void {
    this.#fireCoordinator.start();
  }

  beginDrain(): void {
    this.#fireCoordinator.beginDrain();
  }

  beginSessionRetirement(sessionIds: readonly string[]): Promise<HostAutomationSessionRetirement> {
    const unique = [...new Set(sessionIds)];
    return this.#exclusive(() => {
      const blocked = unique.some(
        (sessionId) =>
          this.#manager.listForSession(sessionId).length > 0 ||
          [...this.#pendingFires.values()].some((fire) => fire.targetSessionId === sessionId),
      );
      if (blocked) {
        throw new HostAutomationSessionBusyError(
          'Session retirement requires session-bound Automations to be removed first',
        );
      }
      for (const sessionId of unique) this.#retiringSessions.add(sessionId);
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        for (const sessionId of unique) this.#retiringSessions.delete(sessionId);
      };
      return Object.freeze({ commit: finish, rollback: finish });
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.#fireCoordinator.close();
    await this.#lane;
    this.#closed = true;
    this.#manager.dispose();
  }

  async create(input: {
    name: string;
    prompt: string;
    sessionId: string;
    schedule: AutomationDefinition['schedule'];
    maxFires?: number;
    requiredCapabilityGroups?: readonly string[];
  }): Promise<AutomationDefinition | { error: string }> {
    try {
      return (await this.#create(input)).automation;
    } catch (error) {
      return { error: modelMutationError(this.#classifyMutationError(error)) };
    }
  }

  async delete(id: string, sessionId: string): Promise<boolean> {
    try {
      await this.#delete(id, sessionId);
      return true;
    } catch (error) {
      const failure = this.#classifyMutationError(error);
      if (failure && isModelMutationRejection(failure)) return false;
      throw error;
    }
  }

  async pause(id: string, sessionId: string): Promise<AutomationDefinition | undefined> {
    try {
      return (await this.#pause(id, sessionId)).automation;
    } catch (error) {
      const failure = this.#classifyMutationError(error);
      if (failure && isModelMutationRejection(failure)) return undefined;
      throw error;
    }
  }

  async resume(id: string, sessionId: string): Promise<AutomationDefinition | undefined> {
    try {
      return (await this.#resume(id, sessionId)).automation;
    } catch (error) {
      const failure = this.#classifyMutationError(error);
      if (failure && isModelMutationRejection(failure)) return undefined;
      throw error;
    }
  }

  get(id: string, sessionId: string): Promise<AutomationDefinition | undefined> {
    return this.#exclusive(() => {
      const automation = this.#manager.get(id);
      return automation && automation.sessionId === sessionId
        ? cloneDefinition(automation)
        : undefined;
    });
  }

  listForSession(sessionId: string): Promise<readonly AutomationDefinition[]> {
    return this.#exclusive(() =>
      this.#manager.listForSession(sessionId).sort(compareAutomations).map(cloneDefinition),
    );
  }

  async #query(input: AutomationQueryInput): Promise<OperationOutcome<'automation.query'>> {
    try {
      await this.#sessions.readHeaderSnapshot(input.sessionId);
    } catch (error) {
      if (isSessionNotFoundError(error) || isMissingRecord(error)) {
        return queryFailure('not_found', 'Session was not found');
      }
      this.#requestDrain();
      return queryFailure('internal_failure', 'Session state is unavailable');
    }
    return this.#exclusive(() => {
      if (!this.#prepared)
        return queryFailure('host_not_ready', 'Automation authority is not ready');
      const visible = this.#manager
        .listForSession(input.sessionId)
        .sort(compareAutomations)
        .map((automation) => projectAutomation(automation, this.#pendingFires.has(automation.id)));
      if (input.kind === 'get') {
        return querySuccess({
          kind: 'automation',
          sessionId: input.sessionId,
          revision: this.#revision,
          automation: visible.find((automation) => automation.id === input.automationId) ?? null,
        });
      }
      if (input.kind === 'list_continue' && input.revision !== this.#revision) {
        return querySuccess({
          kind: 'revision_changed',
          expected: input.revision,
          actual: this.#revision,
        });
      }
      const offset = input.kind === 'list_start' ? 0 : decodeCursor(input.cursor);
      if (
        offset === undefined ||
        offset > visible.length ||
        (input.kind === 'list_continue' && offset === visible.length)
      ) {
        return queryFailure('invalid_request', 'Automation cursor is invalid');
      }
      return querySuccess(createAutomationPage(input.sessionId, this.#revision, visible, offset));
    });
  }

  async #mutate(input: AutomationMutateInput): Promise<OperationOutcome<'automation.mutate'>> {
    if (!this.#prepared) {
      return mutationFailure('host_not_ready', 'Automation authority is not ready');
    }
    if (this.#fireCoordinator.isDraining) {
      return mutationFailure('host_draining', 'Automation authority is draining');
    }
    try {
      let revision: number;
      let automation: AutomationProjection | null;
      switch (input.kind) {
        case 'create': {
          const committed = await this.#create({
            name: input.name,
            prompt: input.prompt,
            sessionId: input.sessionId,
            schedule: input.schedule,
            ...(input.maxFires === undefined ? {} : { maxFires: input.maxFires }),
            ...(input.requiredCapabilityGroups === undefined
              ? {}
              : { requiredCapabilityGroups: input.requiredCapabilityGroups }),
          });
          revision = committed.revision;
          automation = projectAutomation(committed.automation, committed.firePending);
          break;
        }
        case 'delete': {
          revision = await this.#delete(input.automationId, input.sessionId);
          automation = null;
          break;
        }
        case 'pause': {
          const committed = await this.#pause(input.automationId, input.sessionId);
          revision = committed.revision;
          automation = projectAutomation(committed.automation, committed.firePending);
          break;
        }
        case 'resume': {
          const committed = await this.#resume(input.automationId, input.sessionId);
          revision = committed.revision;
          automation = projectAutomation(committed.automation, committed.firePending);
          break;
        }
      }
      return mutationSuccess({
        kind: 'committed',
        revision,
        automation,
      });
    } catch (error) {
      const failure = this.#classifyMutationError(error);
      if (failure) {
        if (failure.kind === 'host_not_ready') {
          return mutationFailure('host_not_ready', failure.message);
        }
        if (failure.kind === 'host_draining') {
          return mutationFailure('host_draining', failure.message);
        }
        if (failure.kind === 'not_found') return mutationFailure('not_found', failure.message);
        if (failure.kind === 'session_archived') {
          return mutationFailure('session_archived', failure.message);
        }
        if (failure.kind === 'session_busy') {
          return mutationFailure('session_busy', failure.message);
        }
        if (failure.kind === 'session_unavailable' || failure.kind === 'capability_unavailable') {
          return mutationFailure('operation_unavailable', failure.message);
        }
        return mutationSuccess({ kind: 'rejected', reason: failure.kind });
      }
      return mutationFailure('persistence_failed', 'Automation mutation could not be committed');
    }
  }

  async #create(input: {
    name: string;
    prompt: string;
    sessionId: string;
    schedule: AutomationDefinition['schedule'];
    maxFires?: number;
    requiredCapabilityGroups?: readonly string[];
  }): Promise<CommittedAutomation> {
    return this.#exclusive(async () => {
      this.#assertWritable();
      const header = await this.#readMutableSession(input.sessionId);
      const unavailableReason = runtimeHostAutomationSessionUnavailableReason(header);
      if (unavailableReason) {
        throw new AutomationMutationFailure('session_unavailable', unavailableReason);
      }
      const resolvedRequirements = await this.#clientCapabilities.requirementsForAutomation(
        input.sessionId,
        input.requiredCapabilityGroups ?? [],
      );
      if (!resolvedRequirements.ok) {
        throw new AutomationMutationFailure('capability_unavailable', resolvedRequirements.message);
      }
      const capabilityRequirements = resolvedRequirements.requirements;
      const before = this.#snapshot();
      const result = this.#manager.create({
        name: input.name,
        prompt: input.prompt,
        sessionId: input.sessionId,
        schedule: input.schedule,
        ...(input.maxFires === undefined ? {} : { maxFires: input.maxFires }),
        ...(capabilityRequirements.length > 0 ? { capabilityRequirements } : {}),
      });
      if ('error' in result) {
        const kind = result.error.includes('Invalid cron') ? 'invalid_schedule' : 'limit_reached';
        throw new AutomationMutationFailure(kind, result.error);
      }
      await this.#commitOrRestore(before);
      return this.#committedAutomation(result.id);
    });
  }

  async #delete(id: string, sessionId: string): Promise<number> {
    return this.#exclusive(async () => {
      this.#assertWritable();
      await this.#readMutableSession(sessionId);
      const automation = this.#requireManagedAutomation(id, sessionId);
      if (this.#pendingFires.has(automation.id)) {
        throw new AutomationMutationFailure(
          'fire_pending',
          'Automation cannot be deleted while a fire is pending',
        );
      }
      const before = this.#snapshot();
      if (!this.#manager.delete(automation.id, sessionId)) {
        throw new AutomationAuthorityInvariantError('Automation delete lost its admitted state');
      }
      await this.#commitOrRestore(before);
      return this.#revision;
    });
  }

  async #pause(id: string, sessionId: string): Promise<CommittedAutomation> {
    return this.#exclusive(async () => {
      this.#assertWritable();
      await this.#readMutableSession(sessionId);
      const automation = this.#requireManagedAutomation(id, sessionId);
      if (automation.status !== 'active') {
        throw new AutomationMutationFailure('not_active', 'Automation is not active');
      }
      const before = this.#snapshot();
      const result = this.#manager.pause(id, sessionId);
      if (!result) throw new AutomationAuthorityInvariantError('Automation pause lost its state');
      await this.#commitOrRestore(before);
      return this.#committedAutomation(id);
    });
  }

  async #resume(id: string, sessionId: string): Promise<CommittedAutomation> {
    return this.#exclusive(async () => {
      this.#assertWritable();
      await this.#readMutableSession(sessionId);
      const automation = this.#requireManagedAutomation(id, sessionId);
      if (automation.status !== 'paused') {
        throw new AutomationMutationFailure('not_paused', 'Automation is not paused');
      }
      if (
        (automation.maxFires !== null && automation.fireCount >= automation.maxFires) ||
        (automation.schedule.type === 'once' && automation.fireCount > 0)
      ) {
        throw new AutomationMutationFailure(
          'fire_budget_exhausted',
          'Automation fire budget is exhausted',
        );
      }
      const before = this.#snapshot();
      const result = this.#manager.resume(id, sessionId);
      if (!result) throw new AutomationAuthorityInvariantError('Automation resume lost its state');
      await this.#commitOrRestore(before);
      return this.#committedAutomation(id);
    });
  }

  #committedAutomation(id: string): CommittedAutomation {
    const automation = this.#manager.get(id);
    if (!automation) {
      throw new AutomationAuthorityInvariantError('Committed Automation is unavailable');
    }
    return {
      automation: cloneDefinition(automation),
      revision: this.#revision,
      firePending: this.#pendingFires.has(id),
    };
  }

  #requireManagedAutomation(id: string, sessionId: string): AutomationDefinition {
    const automation = this.#manager.get(id);
    if (!automation) throw new AutomationMutationFailure('not_found', 'Automation was not found');
    if (automation.sessionId !== sessionId) {
      throw new AutomationMutationFailure('not_owned', 'Automation is not owned by this Session');
    }
    return automation;
  }

  async #readMutableSession(sessionId: string): Promise<SessionHeader> {
    if (this.#retiringSessions.has(sessionId)) {
      throw new AutomationMutationFailure('session_busy', 'Session lifecycle is changing');
    }
    let header: SessionHeader;
    try {
      header = await this.#sessions.readHeaderSnapshot(sessionId);
    } catch (error) {
      if (isSessionNotFoundError(error) || isMissingRecord(error)) {
        throw new AutomationMutationFailure('not_found', 'Session was not found');
      }
      throw error;
    }
    if (header.isArchived || header.status === 'archived') {
      throw new AutomationMutationFailure(
        'session_archived',
        'Archived Sessions cannot mutate Automations',
      );
    }
    return header;
  }

  #assertWritable(): void {
    if (!this.#prepared) {
      throw new AutomationMutationFailure('host_not_ready', 'Automation authority is not ready');
    }
    if (this.#fireCoordinator.isDraining || this.#closed) {
      throw new AutomationMutationFailure('host_draining', 'Automation authority is draining');
    }
  }

  #classifyMutationError(error: unknown): AutomationMutationFailure | undefined {
    if (error instanceof AutomationMutationFailure) return error;
    this.#requestDrain();
    return undefined;
  }

  #listDueAutomations(now: number): Promise<readonly AutomationDefinition[]> {
    return this.#exclusive(async () => {
      const before = this.#snapshot();
      let changed = false;
      for (const automation of this.#manager.listActive()) {
        if (this.#pendingFires.has(automation.id)) continue;
        if (automation.expiresAt !== null && now >= automation.expiresAt) {
          changed = this.#manager.sweepExpired(automation.id) || changed;
        }
      }
      if (changed) {
        await this.#commitOrRestore(before);
      }
      return this.#manager
        .listActive()
        .filter(
          (automation) =>
            !this.#pendingFires.has(automation.id) &&
            automation.nextFireAt !== null &&
            automation.nextFireAt <= now,
        )
        .map(cloneDefinition);
    });
  }

  #recordDeferredFire(
    automationId: string,
    expectedSchedule: number | null,
    skip: boolean,
  ): Promise<boolean> {
    return this.#exclusive(async () => {
      const automation = this.#manager.get(automationId);
      if (
        !automation ||
        automation.status !== 'active' ||
        automation.nextFireAt !== expectedSchedule ||
        this.#pendingFires.has(automationId)
      ) {
        return false;
      }
      const before = this.#snapshot();
      this.#manager.recordDeferredFire(automationId);
      if (skip) this.#manager.skipFire(automationId);
      await this.#commitOrRestore(before);
      return true;
    });
  }

  #recordPrerequisiteWaiting(
    automationId: string,
    expectedSchedule: number | null,
    waiting: NonNullable<AutomationDefinition['waiting']>,
  ): Promise<boolean> {
    return this.#exclusive(async () => {
      const automation = this.#manager.get(automationId);
      if (
        !automation ||
        automation.status !== 'active' ||
        automation.nextFireAt !== expectedSchedule ||
        this.#pendingFires.has(automationId)
      ) {
        return false;
      }
      const before = this.#snapshot();
      if (this.#manager.recordPrerequisiteWaiting(automationId, waiting)) {
        await this.#commitOrRestore(before);
      }
      return true;
    });
  }

  async #admitFire(
    automationId: string,
    expectedSchedule: number | null,
  ): Promise<AutomationPendingFire | undefined> {
    const sessionId = await this.#exclusive(() => this.#manager.get(automationId)?.sessionId);
    if (!sessionId) return undefined;
    return this.#sessionAdmission.run(sessionId, () =>
      this.#admitFireAdmitted(automationId, expectedSchedule),
    );
  }

  #admitFireAdmitted(
    automationId: string,
    expectedSchedule: number | null,
  ): Promise<AutomationPendingFire | undefined> {
    return this.#exclusive(async () => {
      if (this.#fireCoordinator.isDraining || this.#closed || expectedSchedule === null) {
        return undefined;
      }
      const automation = this.#manager.get(automationId);
      if (
        !automation ||
        this.#retiringSessions.has(automation.sessionId) ||
        automation.status !== 'active' ||
        automation.nextFireAt !== expectedSchedule ||
        automation.nextFireAt > this.#now() ||
        this.#pendingFires.has(automationId)
      ) {
        return undefined;
      }
      const before = this.#snapshot();
      const started = this.#manager.attemptStarted(automationId);
      if (!started) {
        await this.#commitOrRestore(before);
        return undefined;
      }
      const fireId = this.#newId();
      const admittedAt = this.#now();
      const fire: AutomationPendingFire = {
        id: fireId,
        automationId,
        automationName: started.name,
        prompt: started.prompt,
        scheduledFor: expectedSchedule,
        targetSessionId: started.sessionId,
        turnId: this.#newId(),
        runId: this.#newId(),
        userMessageId: this.#newId(),
        status: 'admitted',
        admittedAt,
        updatedAt: admittedAt,
        ...(started.capabilityRequirements && started.capabilityRequirements.length > 0
          ? { capabilityRequirements: structuredClone(started.capabilityRequirements) }
          : {}),
      };
      this.#pendingFires.set(automationId, fire);
      await this.#commitOrRestore(before);
      return cloneFire(this.#pendingFires.get(automationId) ?? fire);
    });
  }

  #assertPendingFire(fire: AutomationPendingFire): Promise<void> {
    return this.#exclusive(() => {
      const current = this.#pendingFires.get(fire.automationId);
      if (!current || current.id !== fire.id) {
        throw new AutomationAuthorityInvariantError('Pending Automation fire disappeared');
      }
    });
  }

  async #recordFireDeferred(
    fire: AutomationPendingFire,
    transientDeferredSince: number,
  ): Promise<void> {
    await this.#exclusive(async () => {
      const current = this.#pendingFires.get(fire.automationId);
      if (!current || current.id !== fire.id) return;
      const before = this.#snapshot();
      this.#manager.recordAdmittedFireDeferred(fire.automationId);
      this.#pendingFires.set(fire.automationId, {
        ...current,
        transientDeferredSince: current.transientDeferredSince ?? transientDeferredSince,
        updatedAt: Math.max(current.updatedAt, this.#now()),
      });
      await this.#commitOrRestore(before);
    });
  }

  async #recordFirePrerequisiteWaiting(
    fire: AutomationPendingFire,
    waiting: NonNullable<AutomationDefinition['waiting']>,
  ): Promise<void> {
    await this.#exclusive(async () => {
      const current = this.#pendingFires.get(fire.automationId);
      if (!current || current.id !== fire.id) return;
      const before = this.#snapshot();
      const waitingChanged = this.#manager.recordPrerequisiteWaiting(fire.automationId, waiting);
      if (!waitingChanged && current.transientDeferredSince === undefined) return;
      this.#pendingFires.set(fire.automationId, {
        ...current,
        transientDeferredSince: undefined,
        updatedAt: Math.max(current.updatedAt, this.#now()),
      });
      await this.#commitOrRestore(before);
    });
  }

  async #failFire(fire: AutomationPendingFire, error: string): Promise<void> {
    await this.#exclusive(async () => {
      const current = this.#pendingFires.get(fire.automationId);
      if (!current || current.id !== fire.id) return;
      const before = this.#snapshot();
      const automation = this.#manager.get(fire.automationId);
      if (!automation) {
        throw new AutomationAuthorityInvariantError(
          'Pending Automation fire has no canonical definition',
        );
      }
      settleAutomationAttempt(automation, { status: 'failed', error }, this.#now());
      this.#pendingFires.delete(fire.automationId);
      await this.#commitOrRestore(before);
    });
  }

  async #markFireRunning(fire: AutomationPendingFire): Promise<void> {
    await this.#exclusive(async () => {
      const current = this.#pendingFires.get(fire.automationId);
      if (!current || current.id !== fire.id) {
        throw new AutomationAuthorityInvariantError('Pending Automation fire changed before start');
      }
      if (current.status === 'running') return;
      const before = this.#snapshot();
      const now = this.#now();
      this.#manager.clearWaiting(fire.automationId);
      this.#pendingFires.set(fire.automationId, {
        ...current,
        transientDeferredSince: undefined,
        status: 'running',
        startedAt: now,
        updatedAt: now,
      });
      await this.#commitOrRestore(before);
    });
  }

  async #settleFire(fire: AutomationPendingFire, run: AgentRunHeader): Promise<void> {
    await this.#exclusive(async () => {
      const current = this.#pendingFires.get(fire.automationId);
      if (!current) return;
      if (current.id !== fire.id) {
        throw new AutomationAuthorityInvariantError('Automation settlement changed fire identity');
      }
      assertFireRunIdentity(current, run);
      const before = this.#snapshot();
      const automation = this.#manager.get(fire.automationId);
      if (!automation) {
        throw new AutomationAuthorityInvariantError(
          'Pending Automation fire has no canonical definition',
        );
      }
      if (run.status === 'completed') {
        settleAutomationAttempt(automation, { status: 'completed', runId: run.runId }, this.#now());
      } else if (run.status === 'failed' || run.status === 'cancelled') {
        settleAutomationAttempt(
          automation,
          { status: run.status, runId: run.runId, error: runFailureMessage(run) },
          this.#now(),
        );
      } else {
        throw new AutomationAuthorityInvariantError('Automation settled from a non-terminal Run');
      }
      this.#pendingFires.delete(fire.automationId);
      await this.#commitOrRestore(before);
    });
  }

  async #commitCurrent(): Promise<void> {
    const result = await this.#store.commit({
      expectedRevision: this.#revision,
      automations: this.#manager.listAll(),
      pendingFires: [...this.#pendingFires.values()],
    });
    if (result.kind === 'revision_conflict') {
      throw new AutomationAuthorityInvariantError(
        `Automation revision changed from ${this.#revision} to ${result.actualRevision}`,
      );
    }
    this.#restore(result.snapshot);
    this.#fireCoordinator.refreshResidency();
  }

  async #commitOrRestore(before: AutomationStateSnapshot): Promise<void> {
    try {
      await this.#commitCurrent();
    } catch (error) {
      this.#restore(before);
      throw error;
    }
  }

  #snapshot(): AutomationStateSnapshot {
    return {
      revision: this.#revision,
      automations: this.#manager.listAll().map(cloneDefinition),
      pendingFires: [...this.#pendingFires.values()].map(cloneFire),
    };
  }

  #restore(snapshot: AutomationStateSnapshot): void {
    this.#revision = snapshot.revision;
    this.#manager.hydrate(snapshot.automations);
    this.#pendingFires.clear();
    for (const fire of snapshot.pendingFires)
      this.#pendingFires.set(fire.automationId, cloneFire(fire));
  }

  #exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#lane.then(operation);
    this.#lane = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function runFailureMessage(run: AgentRunHeader): string {
  if (run.status === 'cancelled') {
    return run.abortSource
      ? `Automation run cancelled: ${run.abortSource}`
      : 'Automation run cancelled';
  }
  return run.failureMessage ?? run.failureClass ?? 'Automation run failed';
}

function compareAutomations(left: AutomationDefinition, right: AutomationDefinition): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

function projectAutomation(
  automation: AutomationDefinition,
  firePending: boolean,
): AutomationProjection {
  return {
    id: automation.id,
    name: automation.name,
    status: automation.status,
    prompt: automation.prompt,
    sessionId: automation.sessionId,
    schedule: structuredClone(automation.schedule),
    createdAt: automation.createdAt,
    updatedAt: automation.updatedAt,
    nextFireAt: automation.nextFireAt,
    lastFireAt: automation.lastFireAt,
    lastRunId: automation.lastRunId,
    fireCount: automation.fireCount,
    maxFires: automation.maxFires,
    expiresAt: automation.expiresAt,
    lastError: automation.lastError,
    consecutiveFailures: automation.consecutiveFailures,
    deferredFireCount: automation.deferredFireCount ?? 0,
    firePending,
    waiting: automation.waiting ? structuredClone(automation.waiting) : null,
  };
}

function cloneDefinition(automation: AutomationDefinition): AutomationDefinition {
  return structuredClone(automation);
}

function cloneFire(fire: AutomationPendingFire): AutomationPendingFire {
  return structuredClone(fire);
}

function createAutomationPage(
  sessionId: string,
  revision: number,
  automations: readonly AutomationProjection[],
  offset: number,
): AutomationQueryResult {
  const page: AutomationProjection[] = [];
  for (let index = offset; index < automations.length; index += 1) {
    if (page.length >= AUTOMATION_PAGE_MAX_ITEMS) break;
    const automation = automations[index];
    if (!automation)
      throw new AutomationAuthorityInvariantError('Automation page index is invalid');
    const candidate = [...page, automation];
    const nextOffset = offset + candidate.length;
    const result = {
      kind: 'page' as const,
      sessionId,
      revision,
      automations: candidate,
      nextCursor: nextOffset < automations.length ? encodeCursor(nextOffset) : null,
    };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > AUTOMATION_RESULT_MAX_BYTES) break;
    page.push(automation);
  }
  if (page.length === 0 && offset < automations.length) {
    throw new AutomationAuthorityInvariantError('Automation exceeds the query byte limit');
  }
  const nextOffset = offset + page.length;
  return {
    kind: 'page',
    sessionId,
    revision,
    automations: page,
    nextCursor: nextOffset < automations.length ? encodeCursor(nextOffset) : null,
  };
}

function encodeCursor(offset: number): string {
  return String(offset);
}

function decodeCursor(cursor: string): number | undefined {
  if (!/^(?:0|[1-9]\d*)$/.test(cursor)) return undefined;
  const offset = Number(cursor);
  return Number.isSafeInteger(offset) ? offset : undefined;
}

function querySuccess(result: AutomationQueryResult): OperationOutcome<'automation.query'> {
  return { ok: true, result };
}

function queryFailure(
  code: Extract<OperationOutcome<'automation.query'>, { ok: false }>['error']['code'],
  message: string,
): OperationOutcome<'automation.query'> {
  return { ok: false, error: { code, message } };
}

function mutationSuccess(result: AutomationMutateResult): OperationOutcome<'automation.mutate'> {
  return { ok: true, result };
}

function mutationFailure(
  code: Extract<OperationOutcome<'automation.mutate'>, { ok: false }>['error']['code'],
  message: string,
): OperationOutcome<'automation.mutate'> {
  return { ok: false, error: { code, message } };
}

function isModelMutationRejection(error: AutomationMutationFailure): boolean {
  return error.kind !== 'host_not_ready' && error.kind !== 'host_draining';
}

function modelMutationError(error: AutomationMutationFailure | undefined): string {
  if (error && isModelMutationRejection(error)) return error.message;
  return 'Automation authority is unavailable.';
}

function isMissingRecord(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
