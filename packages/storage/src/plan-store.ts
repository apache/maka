/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  PLAN_MAX_FILES_PER_STEP,
  PLAN_MAX_RISKS,
  PLAN_MAX_STEPS,
  PLAN_LIFECYCLE_REASON_MAX_BYTES,
  PLAN_PROJECTION_ITEM_MAX_BYTES,
  PLAN_STEP_TITLE_MAX_CHARS,
  PlanConflictError,
  activePlanExecution,
  type AbandonPlanProposalInput,
  emptyPlanSessionState,
  latestPlanProposal,
  type ApprovePlanProposalInput,
  type CancelPlanExecutionInput,
  type PlanEvent,
  type PlanExecution,
  type PlanExecutionStep,
  type PlanMutationResult,
  type PlanProposal,
  type PlanSessionState,
  type PlanStepDefinition,
  type PlanStore,
  type RequestPlanRevisionInput,
  type SubmitPlanProposalInput,
  type UpdatePlanExecutionInput,
  isCanonicalPlanEntityId,
  isPlanProposalLifecycleAdmissible,
  isPlanTextWithinLimit,
  planEncodedByteLength,
  worstCasePlanExecution,
} from '@maka/core/plan';
import { chainWrite } from './write-queue.js';
import {
  acquireOperationalStateDatabase,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';

export interface CreatePlanStoreOptions {
  newId?: () => string;
  now?: () => number;
}

export interface SqlitePlanStore extends PlanStore {
  ready(): Promise<void>;
  purgeSessionState(sessionId: string): Promise<void>;
  close(): void;
}

export type CreateSqlitePlanStoreOptions = CreatePlanStoreOptions;

export function createSqlitePlanStore(
  workspaceRoot: string,
  options: CreateSqlitePlanStoreOptions = {},
): SqlitePlanStore {
  return new SqlitePlanStoreImpl(workspaceRoot, options);
}

class SqlitePlanStoreImpl implements SqlitePlanStore {
  readonly #lease: OperationalStateDatabaseLease;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly newId: () => string;
  private readonly now: () => number;

  constructor(workspaceRoot: string, options: CreatePlanStoreOptions) {
    this.#lease = acquireOperationalStateDatabase(resolve(workspaceRoot));
    this.newId = options.newId ?? randomUUID;
    this.now = options.now ?? Date.now;
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    this.#lease.close();
  }

  async readState(sessionId: string): Promise<PlanSessionState> {
    return (await this.readLedger(sessionId)).state;
  }

  async readOperationReceipt(
    sessionId: string,
    operationId: string,
    operationInput: unknown,
  ): Promise<PlanEvent | undefined> {
    assertSafeId(sessionId);
    assertSafeId(operationId);
    const fingerprint = operationFingerprint(operationInput);
    let receipt: PlanEvent | undefined;
    await chainWrite(this.queues, sessionId, async () => {
      receipt = reconcileOperationReceipt(
        (await this.readLedger(sessionId)).events,
        operationId,
        fingerprint,
      );
    });
    return receipt;
  }

  async submitProposal(input: SubmitPlanProposalInput): Promise<PlanMutationResult> {
    return this.mutate(input.sessionId, input.operationId, input, async (state) => {
      requiredId(input.turnId, 'Plan turn id');
      if (input.sourceExecutionId) {
        requiredId(input.sourceExecutionId, 'Source Plan execution id');
      }
      const title = requiredText(input.title, 'Plan title');
      const steps = normalizeDefinitions(input.steps);
      const overview = optionalText(input.overview, 'Plan overview');
      if (input.risks && input.risks.length > PLAN_MAX_RISKS) {
        throw new PlanConflictError(`A plan may contain at most ${PLAN_MAX_RISKS} risks`);
      }
      const risks =
        input.risks && input.risks.length > 0
          ? input.risks.map((risk) => requiredText(risk, 'Plan risk'))
          : undefined;
      if (!isPlanProposalLifecycleAdmissible({ title, overview, steps, risks })) {
        throw new PlanConflictError(
          'Plan proposal cannot fit the projection item limit across its execution lifecycle',
        );
      }
      const latest = latestPlanProposal(state);
      if (state.activeExecutionId) {
        throw new PlanConflictError('Cannot submit a new proposal while a plan is executing');
      }
      const sourceExecution = input.sourceExecutionId
        ? executionById(state, input.sourceExecutionId)
        : undefined;
      if (sourceExecution && sourceExecution.status !== 'interrupted') {
        throw new PlanConflictError('Only an interrupted execution can be replanned');
      }
      const revisesLatest =
        latest !== undefined &&
        (latest.status !== 'approved' || sourceExecution?.proposalId === latest.proposalId);
      const planId = revisesLatest ? latest.planId : requiredId(this.newId(), 'Plan id');
      const proposalId = requiredId(this.newId(), 'Plan proposal id');
      const submittedAt = this.now();
      const proposal: PlanProposal = {
        planId,
        proposalId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        revision: revisesLatest ? latest.revision + 1 : 1,
        ...(revisesLatest ? { supersedesProposalId: latest.proposalId } : {}),
        ...(sourceExecution ? { sourceExecutionId: sourceExecution.executionId } : {}),
        title,
        ...(overview ? { overview } : {}),
        steps,
        ...(risks ? { risks } : {}),
        status: 'pending_approval',
        submittedAt,
      };
      return {
        type: 'plan_submitted',
        id: input.operationId ?? this.newId(),
        sessionId: input.sessionId,
        ts: submittedAt,
        storeVersion: state.storeVersion + 1,
        proposal,
      };
    });
  }

  async requestRevision(input: RequestPlanRevisionInput): Promise<PlanMutationResult> {
    return this.mutate(input.sessionId, input.operationId, input, async (state) => {
      const proposal = proposalById(state, input.proposalId);
      if (proposal.status === 'stale') {
        throw new PlanConflictError('Plan proposal is already stale');
      }
      if (proposal.status === 'approved') {
        throw new PlanConflictError('An approved plan proposal cannot be revised');
      }
      if (state.latestProposalId !== proposal.proposalId) {
        throw new PlanConflictError('Only the latest plan proposal can be revised');
      }
      return {
        type: 'plan_revision_requested',
        id: input.operationId ?? this.newId(),
        sessionId: input.sessionId,
        ts: this.now(),
        storeVersion: state.storeVersion + 1,
        proposalId: proposal.proposalId,
      };
    });
  }

  async abandonProposal(input: AbandonPlanProposalInput): Promise<PlanMutationResult> {
    return this.mutate(input.sessionId, input.operationId, input, async (state) => {
      const proposal = proposalById(state, input.proposalId);
      if (
        proposal.status !== 'pending_approval' ||
        state.latestProposalId !== proposal.proposalId
      ) {
        throw new PlanConflictError('Only the latest pending plan proposal can be abandoned');
      }
      return {
        type: 'plan_abandoned',
        id: input.operationId ?? this.newId(),
        sessionId: input.sessionId,
        ts: this.now(),
        storeVersion: state.storeVersion + 1,
        proposalId: proposal.proposalId,
        reason: requiredText(input.reason, 'Plan abandonment reason'),
      };
    });
  }

  async approveProposal(input: ApprovePlanProposalInput): Promise<PlanMutationResult> {
    let duplicate: PlanMutationResult | undefined;
    const result = await this.mutateOptional(
      input.sessionId,
      input.operationId,
      input,
      async (state, events) => {
        const proposal = proposalById(state, input.proposalId);
        if (proposal.revision !== input.expectedRevision) {
          throw new PlanConflictError('Plan proposal revision does not match');
        }
        if (proposal.status === 'approved') {
          if (input.operationId) {
            throw new PlanConflictError('Plan proposal was already approved by another operation');
          }
          const prior = [...events]
            .reverse()
            .find(
              (event): event is Extract<PlanEvent, { type: 'plan_approved' }> =>
                event.type === 'plan_approved' && event.proposalId === proposal.proposalId,
            );
          if (!prior) throw new PlanConflictError('Approved plan execution is missing');
          duplicate = { event: prior, state };
          return null;
        }
        if (
          input.expectedStoreVersion !== undefined &&
          state.storeVersion !== input.expectedStoreVersion
        ) {
          throw new PlanConflictError('Plan state changed before approval');
        }
        if (
          proposal.status !== 'pending_approval' ||
          state.latestProposalId !== proposal.proposalId
        ) {
          throw new PlanConflictError('Only the latest pending plan proposal can be approved');
        }
        if (state.activeExecutionId) {
          throw new PlanConflictError('This session already has an active plan execution');
        }
        if (proposal.sourceExecutionId) {
          const sourceExecution = executionById(state, proposal.sourceExecutionId);
          if (sourceExecution.status !== 'interrupted') {
            throw new PlanConflictError('The execution being replanned is no longer interrupted');
          }
        }
        const startedAt = this.now();
        const execution: PlanExecution = {
          executionId: requiredId(this.newId(), 'Plan execution id'),
          planId: proposal.planId,
          proposalId: proposal.proposalId,
          sessionId: input.sessionId,
          status: 'active',
          steps: proposal.steps.map((step) => ({
            ...structuredClone(step),
            status: 'pending',
            updatedAt: startedAt,
          })),
          startedAt,
          updatedAt: startedAt,
        };
        return {
          type: 'plan_approved',
          id: input.operationId ?? this.newId(),
          sessionId: input.sessionId,
          ts: startedAt,
          storeVersion: state.storeVersion + 1,
          proposalId: proposal.proposalId,
          execution,
        };
      },
    );
    if (duplicate) return duplicate;
    if (!result) throw new Error('Plan approval completed without a result');
    return result;
  }

  async updateExecution(input: UpdatePlanExecutionInput): Promise<PlanMutationResult> {
    return this.mutate(input.sessionId, input.operationId, input, async (state) => {
      const execution = requireActiveExecution(state, input.executionId);
      const steps = mergeExecutionSteps(execution, input.steps, this.now());
      const explanation = optionalText(input.explanation, 'Plan progress explanation');
      const completed = steps.every(
        (step) => step.status === 'completed' || step.status === 'skipped',
      );
      return completed
        ? {
            type: 'plan_execution_completed',
            id: input.operationId ?? this.newId(),
            sessionId: input.sessionId,
            ts: this.now(),
            storeVersion: state.storeVersion + 1,
            executionId: execution.executionId,
            steps,
          }
        : {
            type: 'plan_progress_updated',
            id: input.operationId ?? this.newId(),
            sessionId: input.sessionId,
            ts: this.now(),
            storeVersion: state.storeVersion + 1,
            executionId: execution.executionId,
            steps,
            ...(explanation ? { explanation } : {}),
          };
    });
  }

  async cancelExecution(input: CancelPlanExecutionInput): Promise<PlanMutationResult> {
    return this.mutate(input.sessionId, input.operationId, input, async (state) => {
      const execution = requireCancellableExecution(state, input.executionId);
      return {
        type: 'plan_execution_cancelled',
        id: input.operationId ?? this.newId(),
        sessionId: input.sessionId,
        ts: this.now(),
        storeVersion: state.storeVersion + 1,
        executionId: execution.executionId,
        reason: requiredText(
          input.reason,
          'Plan cancellation reason',
          PLAN_LIFECYCLE_REASON_MAX_BYTES,
        ),
      };
    });
  }

  async interruptActiveExecution(
    sessionId: string,
    reason: string,
    operationId?: string,
  ): Promise<PlanMutationResult | null> {
    return this.mutateOptional(sessionId, operationId, { sessionId, reason }, async (fresh) => {
      const execution = activePlanExecution(fresh);
      if (!execution) return null;
      return {
        type: 'plan_execution_interrupted',
        id: operationId ?? this.newId(),
        sessionId,
        ts: this.now(),
        storeVersion: fresh.storeVersion + 1,
        executionId: execution.executionId,
        reason: requiredText(reason, 'Plan interruption reason', PLAN_LIFECYCLE_REASON_MAX_BYTES),
      };
    });
  }

  async resumeExecution(
    sessionId: string,
    executionId: string,
    operationId?: string,
  ): Promise<PlanMutationResult> {
    return this.mutate(sessionId, operationId, { sessionId, executionId }, async (state) => {
      if (state.activeExecutionId) {
        throw new PlanConflictError('This session already has an active plan execution');
      }
      const execution = executionById(state, executionId);
      if (execution.status !== 'interrupted') {
        throw new PlanConflictError('Only an interrupted plan execution can be resumed');
      }
      return {
        type: 'plan_execution_resumed',
        id: operationId ?? this.newId(),
        sessionId,
        ts: this.now(),
        storeVersion: state.storeVersion + 1,
        executionId,
      };
    });
  }

  private async mutate(
    sessionId: string,
    operationId: string | undefined,
    operationInput: unknown,
    build: (state: PlanSessionState, events: readonly PlanEvent[]) => Promise<PlanEvent | null>,
  ): Promise<PlanMutationResult> {
    const result = await this.mutateOptional(sessionId, operationId, operationInput, build);
    if (!result) throw new Error('Plan mutation completed without a result');
    return result;
  }

  private async mutateOptional(
    sessionId: string,
    operationId: string | undefined,
    operationInput: unknown,
    build: (state: PlanSessionState, events: readonly PlanEvent[]) => Promise<PlanEvent | null>,
  ): Promise<PlanMutationResult | null> {
    assertSafeId(sessionId);
    if (operationId !== undefined) assertSafeId(operationId);
    const fingerprint = operationId ? operationFingerprint(operationInput) : undefined;
    let result: PlanMutationResult | null = null;
    await chainWrite(this.queues, sessionId, async () => {
      const ledger = await this.readLedger(sessionId);
      if (operationId) {
        const existing = reconcileOperationReceipt(ledger.events, operationId, fingerprint!);
        if (existing) {
          result = {
            event: existing,
            state: stateThroughEvent(sessionId, ledger.events, existing.id),
          };
          return;
        }
      }
      const event = await build(ledger.state, ledger.events);
      if (!event) return;
      if (fingerprint) event.operationFingerprint = fingerprint;
      const state = applyPlanEvent(ledger.state, event);
      assertPlanProjectionWithinLimit(state);
      await this.appendCanonicalEvent(sessionId, event, state);
      result = { event, state };
    });
    return result;
  }

  async purgeSessionState(sessionId: string): Promise<void> {
    assertSafeId(sessionId);
    await chainWrite(this.queues, sessionId, async () => {
      this.#lease.transaction('write', () => {
        this.#lease.database
          .prepare('DELETE FROM workflow_plan_events WHERE session_id = ?')
          .run(sessionId);
        this.#lease.database
          .prepare('DELETE FROM workflow_plan_projections WHERE session_id = ?')
          .run(sessionId);
      });
    });
  }

  private async readLedger(
    sessionId: string,
  ): Promise<{ events: PlanEvent[]; state: PlanSessionState }> {
    assertSafeId(sessionId);
    return readSqlitePlanLedger(this.#lease.database, sessionId);
  }

  private async appendCanonicalEvent(
    sessionId: string,
    event: PlanEvent,
    state: PlanSessionState,
  ): Promise<void> {
    this.#lease.transaction('write', () => {
      insertPlanEvent(this.#lease.database, event);
      writePlanProjection(this.#lease.database, sessionId, state);
    });
  }
}

function operationFingerprint(input: unknown): string {
  const normalized = omitOperationId(structuredClone(input));
  return `sha256:${createHash('sha256').update(stableJson(normalized)).digest('hex')}`;
}

function reconcileOperationReceipt(
  events: readonly PlanEvent[],
  operationId: string,
  fingerprint: string,
): PlanEvent | undefined {
  const existing = events.find((event) => event.id === operationId);
  if (!existing) return undefined;
  if (existing.operationFingerprint !== fingerprint) {
    throw new PlanConflictError('Plan operation identity was reused with different input');
  }
  return existing;
}

function stateThroughEvent(
  sessionId: string,
  events: readonly PlanEvent[],
  eventId: string,
): PlanSessionState {
  let state = emptyPlanSessionState(sessionId);
  for (const event of events) {
    state = applyPlanEvent(state, event);
    if (event.id === eventId) return state;
  }
  throw new Error('Plan operation receipt is missing from its ledger');
}

function omitOperationId(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const { operationId: _operationId, ...rest } = input as Record<string, unknown>;
  return rest;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function readSqlitePlanLedger(
  database: DatabaseSync,
  sessionId: string,
): { events: PlanEvent[]; state: PlanSessionState } {
  assertSafeId(sessionId);
  const rows = database
    .prepare(`
      SELECT record_json
      FROM workflow_plan_events
      WHERE session_id = ?
      ORDER BY sequence
    `)
    .all(sessionId) as Array<{ record_json?: unknown }>;
  const persistedEvents = rows.map((row, index) => {
    if (typeof row.record_json !== 'string') {
      throw new Error(`Invalid SQLite Plan event at sequence ${index}`);
    }
    return decodePlanEvent(JSON.parse(row.record_json), sessionId);
  });
  let state = emptyPlanSessionState(sessionId);
  for (const persistedEvent of persistedEvents) {
    state = applyPlanEvent(state, persistedEvent);
    assertPlanProjectionWithinLimit(state);
  }
  return { events: persistedEvents, state };
}

function insertPlanEvent(database: DatabaseSync, event: PlanEvent): void {
  const row = database
    .prepare(`
      SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence
      FROM workflow_plan_events
      WHERE session_id = ?
    `)
    .get(event.sessionId) as { sequence?: unknown };
  if (typeof row.sequence !== 'number' || !Number.isSafeInteger(row.sequence)) {
    throw new Error('Invalid next Plan event sequence');
  }
  database
    .prepare(`
      INSERT INTO workflow_plan_events(
        session_id, sequence, event_id, store_version, record_json
      ) VALUES (?, ?, ?, ?, ?)
    `)
    .run(event.sessionId, row.sequence, event.id, event.storeVersion, JSON.stringify(event));
}

function writePlanProjection(
  database: DatabaseSync,
  sessionId: string,
  state: PlanSessionState,
): void {
  database
    .prepare(`
      INSERT INTO workflow_plan_projections(session_id, store_version, record_json)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        store_version = excluded.store_version,
        record_json = excluded.record_json
    `)
    .run(sessionId, state.storeVersion, JSON.stringify(state));
}

export function applyPlanEvent(state: PlanSessionState, event: PlanEvent): PlanSessionState {
  if (event.sessionId !== state.sessionId) throw new Error('Plan event session mismatch');
  if (event.storeVersion !== state.storeVersion + 1) {
    throw new Error('Plan event storeVersion is not contiguous');
  }
  const next = structuredClone(state);
  next.storeVersion = event.storeVersion;
  switch (event.type) {
    case 'plan_submitted': {
      const prior = latestPlanProposal(next);
      if (prior && prior.status === 'pending_approval') prior.status = 'stale';
      next.proposals.push(structuredClone(event.proposal));
      next.latestProposalId = event.proposal.proposalId;
      break;
    }
    case 'plan_revision_requested':
      proposalById(next, event.proposalId).status = 'stale';
      break;
    case 'plan_abandoned':
      proposalById(next, event.proposalId).status = 'stale';
      break;
    case 'plan_approved': {
      const proposal = proposalById(next, event.proposalId);
      proposal.status = 'approved';
      if (proposal.sourceExecutionId) {
        const sourceExecution = executionById(next, proposal.sourceExecutionId);
        sourceExecution.status = 'cancelled';
        sourceExecution.updatedAt = event.ts;
        sourceExecution.cancelledAt = event.ts;
        sourceExecution.cancelReason = `Replanned by proposal ${proposal.proposalId}`;
        delete sourceExecution.interruptedAt;
        delete sourceExecution.interruptionReason;
      }
      next.executions.push(structuredClone(event.execution));
      next.activeExecutionId = event.execution.executionId;
      break;
    }
    case 'plan_progress_updated': {
      const execution = executionById(next, event.executionId);
      execution.steps = structuredClone(event.steps);
      execution.updatedAt = event.ts;
      break;
    }
    case 'plan_execution_completed': {
      const execution = executionById(next, event.executionId);
      execution.steps = structuredClone(event.steps);
      execution.status = 'completed';
      execution.updatedAt = event.ts;
      execution.completedAt = event.ts;
      if (next.activeExecutionId === execution.executionId) delete next.activeExecutionId;
      break;
    }
    case 'plan_execution_cancelled': {
      const execution = executionById(next, event.executionId);
      execution.status = 'cancelled';
      execution.updatedAt = event.ts;
      execution.cancelledAt = event.ts;
      execution.cancelReason = event.reason;
      if (next.activeExecutionId === execution.executionId) delete next.activeExecutionId;
      break;
    }
    case 'plan_execution_interrupted': {
      const execution = executionById(next, event.executionId);
      execution.status = 'interrupted';
      execution.updatedAt = event.ts;
      execution.interruptedAt = event.ts;
      execution.interruptionReason = event.reason;
      if (next.activeExecutionId === execution.executionId) delete next.activeExecutionId;
      break;
    }
    case 'plan_execution_resumed': {
      const execution = executionById(next, event.executionId);
      execution.status = 'active';
      execution.updatedAt = event.ts;
      delete execution.interruptedAt;
      delete execution.interruptionReason;
      next.activeExecutionId = execution.executionId;
      break;
    }
  }
  return next;
}

function mergeExecutionSteps(
  execution: PlanExecution,
  updates: UpdatePlanExecutionInput['steps'],
  now: number,
): PlanExecutionStep[] {
  if (updates.length !== execution.steps.length) {
    throw new PlanConflictError('update_plan must include every execution step');
  }
  const byId = new Map(updates.map((step) => [step.id, step]));
  if (byId.size !== updates.length) throw new PlanConflictError('Plan step ids must be unique');
  const merged = execution.steps.map((step) => {
    const update = byId.get(step.id);
    if (!update) throw new PlanConflictError(`Plan step ${step.id} is missing`);
    if (
      (step.status === 'completed' || step.status === 'skipped') &&
      update.status !== step.status
    ) {
      throw new PlanConflictError(`Terminal plan step ${step.id} cannot be reopened`);
    }
    const note = optionalText(update.note, 'Plan step note');
    return {
      ...structuredClone(step),
      status: update.status,
      ...(note ? { note } : {}),
      updatedAt: now,
    };
  });
  if (merged.filter((step) => step.status === 'in_progress').length > 1) {
    throw new PlanConflictError('Only one plan step may be in progress');
  }
  return merged;
}

function normalizeDefinitions(steps: PlanStepDefinition[]): PlanStepDefinition[] {
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > PLAN_MAX_STEPS) {
    throw new PlanConflictError(`A plan must contain between 1 and ${PLAN_MAX_STEPS} steps`);
  }
  const normalized = steps.map((step, index) => {
    if (step.files && step.files.length > PLAN_MAX_FILES_PER_STEP) {
      throw new PlanConflictError(
        `A Plan step may reference at most ${PLAN_MAX_FILES_PER_STEP} files`,
      );
    }
    return {
      id: requiredId(optionalText(step.id, 'Plan step id') ?? `step-${index + 1}`, 'Plan step id'),
      title: requiredPlainText(step.title, 'Plan step title', PLAN_STEP_TITLE_MAX_CHARS),
      description: requiredPlainText(step.description, 'Plan step description'),
      ...(step.files && step.files.length > 0
        ? { files: step.files.map((file) => requiredText(file, 'Plan step file')) }
        : {}),
      ...(step.complexity ? { complexity: step.complexity } : {}),
    };
  });
  if (new Set(normalized.map((step) => step.id)).size !== normalized.length) {
    throw new PlanConflictError('Plan step ids must be unique');
  }
  return normalized;
}

function proposalById(state: PlanSessionState, proposalId: string): PlanProposal {
  const proposal = state.proposals.find((candidate) => candidate.proposalId === proposalId);
  if (!proposal) throw new PlanConflictError(`Unknown plan proposal: ${proposalId}`);
  return proposal;
}

function executionById(state: PlanSessionState, executionId: string): PlanExecution {
  const execution = state.executions.find((candidate) => candidate.executionId === executionId);
  if (!execution) throw new PlanConflictError(`Unknown plan execution: ${executionId}`);
  return execution;
}

function requireActiveExecution(state: PlanSessionState, executionId: string): PlanExecution {
  if (state.activeExecutionId !== executionId) {
    throw new PlanConflictError('The plan tool is bound to a stale execution');
  }
  const execution = executionById(state, executionId);
  if (execution.status !== 'active') {
    throw new PlanConflictError('Plan execution is not active');
  }
  return execution;
}

function requireCancellableExecution(state: PlanSessionState, executionId: string): PlanExecution {
  const execution = executionById(state, executionId);
  if (execution.status !== 'active' && execution.status !== 'interrupted') {
    throw new PlanConflictError('Plan execution cannot be cancelled');
  }
  if (execution.status === 'active' && state.activeExecutionId !== executionId) {
    throw new PlanConflictError('The plan tool is bound to a stale execution');
  }
  return execution;
}

function requiredText(value: string, label: string, maxBytes?: number): string {
  const normalized = value.trim();
  if (!normalized) throw new PlanConflictError(`${label} cannot be empty`);
  if (!isPlanTextWithinLimit(normalized, maxBytes)) {
    throw new PlanConflictError(`${label} exceeds the Plan text limit`);
  }
  return normalized;
}

function requiredPlainText(value: string, label: string, maxLength?: number): string {
  const normalized = requiredText(value, label);
  if (maxLength !== undefined && normalized.length > maxLength) {
    throw new PlanConflictError(`${label} must be ${maxLength} characters or fewer`);
  }
  if (
    /(^|\n)\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|~~~)|!?(?:\[[^\]\n]+\]\([^)\n]+\))|(?:\*\*|__|`)/.test(
      normalized,
    )
  ) {
    throw new PlanConflictError(`${label} must be plain text without Markdown formatting`);
  }
  return normalized;
}

function optionalText(value: string | undefined, label: string): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (!isPlanTextWithinLimit(normalized)) {
    throw new PlanConflictError(`${label} exceeds the Plan text limit`);
  }
  return normalized;
}

function assertSafeId(value: string): void {
  if (!isCanonicalPlanEntityId(value)) throw new Error('Invalid session id');
}

function requiredId(value: string, label: string): string {
  if (!isCanonicalPlanEntityId(value)) {
    throw new PlanConflictError(`${label} must be a canonical entity id`);
  }
  return value;
}

function assertPlanProjectionWithinLimit(state: PlanSessionState): void {
  for (const proposal of state.proposals) {
    if (planEncodedByteLength({ kind: 'proposal', proposal }) > PLAN_PROJECTION_ITEM_MAX_BYTES) {
      throw new PlanConflictError('Plan proposal exceeds the projection item limit');
    }
  }
  for (const execution of state.executions) {
    if (planEncodedByteLength({ kind: 'execution', execution }) > PLAN_PROJECTION_ITEM_MAX_BYTES) {
      throw new PlanConflictError('Plan execution exceeds the projection item limit');
    }
    const worst = worstCasePlanExecution(execution, execution.executionId, Number.MAX_SAFE_INTEGER);
    if (
      (execution.status === 'active' || execution.status === 'interrupted') &&
      planEncodedByteLength({ kind: 'execution', execution: worst }) >
        PLAN_PROJECTION_ITEM_MAX_BYTES
    ) {
      throw new PlanConflictError('Plan execution cannot fit its terminal lifecycle projection');
    }
  }
}

function decodePlanEvent(value: unknown, sessionId: string): PlanEvent {
  if (!value || typeof value !== 'object') throw new Error('Plan event must be an object');
  const event = value as Partial<PlanEvent>;
  if (
    typeof event.id !== 'string' ||
    (event.operationFingerprint !== undefined &&
      (typeof event.operationFingerprint !== 'string' ||
        !/^sha256:[a-f0-9]{64}$/.test(event.operationFingerprint))) ||
    event.sessionId !== sessionId ||
    typeof event.ts !== 'number' ||
    !Number.isFinite(event.ts) ||
    typeof event.storeVersion !== 'number' ||
    !Number.isSafeInteger(event.storeVersion) ||
    event.storeVersion < 1 ||
    ![
      'plan_submitted',
      'plan_revision_requested',
      'plan_abandoned',
      'plan_approved',
      'plan_progress_updated',
      'plan_execution_completed',
      'plan_execution_cancelled',
      'plan_execution_interrupted',
      'plan_execution_resumed',
    ].includes(String(event.type))
  ) {
    throw new Error('Invalid Plan event envelope');
  }
  return value as PlanEvent;
}
